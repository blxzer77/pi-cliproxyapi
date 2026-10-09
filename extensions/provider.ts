/**
 * Catalog controller and provider registration.
 *
 * Registration uses pi's legacy `ProviderConfig` form with `api: "openai-responses"`
 * and no `streamSimple`, so pi-ai's built-in Responses implementation performs the
 * request. CLIProxyAPI exposes a Codex-compatible `/backend-api/codex/responses`
 * endpoint that accepts a standard Responses body, which is why this provider needs
 * neither a patched stream module nor a protocol reimplementation.
 *
 * The catalog is refreshed through pi's `refreshModels` hook, which is generation
 * checked and can be re-run from `/cpa-refresh`.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { loadCatalogCache, saveCatalogCache } from "./cache.ts";
import {
	type CatalogModel,
	type ChatModelConfig,
	type CpaModel,
	fetchCatalog,
	isUnauthorizedCatalogError,
	mapCatalog,
	reconcileCatalog,
} from "./catalog.ts";
import {
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	firstNonEmpty,
	hasStoredLogin,
	isConfiguredDefaultModel,
	loadConfigSafe,
	loadConfiguredDefault,
	overridesPath,
	resolveCatalogMinRefreshMs,
	resolveConnection,
	resolveEndpoints,
	resolveIdentity,
	saveConfig,
} from "./config.ts";
import { errorMessage, isStaleContextError, log } from "./log.ts";
import { type CompiledOverrides, loadOverrides } from "./overrides.ts";
import {
	buildCostCatalog,
	type CostCatalog,
	emptyCostCatalog,
	fetchModelsDevCatalog,
	isModelsDevCacheFresh,
	readModelsDevCache,
} from "./pricing.ts";

/** The baseUrl is recovered from the OAuth refresh payload after a restart. */
export function encodeCredentialMeta(baseUrl: string): string {
	return JSON.stringify({ baseUrl });
}

export function decodeCredentialMeta(refresh: string | undefined): string | undefined {
	if (!refresh?.trim()) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(refresh) as { baseUrl?: unknown };
		return typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : undefined;
	} catch {
		return undefined;
	}
}

export interface CatalogSnapshot {
	models: CatalogModel[];
	fetchedAt?: number;
	fromCache: boolean;
	error?: string;
}

/** How eagerly a refresh resolves the models.dev pricing document. */
export type PricingMode = "await" | "background";

export interface CatalogControllerOptions {
	/**
	 * Called after a background pricing fetch repriced the in-memory catalog, so the
	 * owner can re-register the provider with the updated costs.
	 */
	onCatalogUpdated?: () => void;
}

export class CatalogController {
	private models: CatalogModel[] = [];
	private fetchedAt: number | undefined;
	private lastError: string | undefined;
	private lastSource: "remote" | "cache" | "none" = "none";
	private costCatalog: CostCatalog = emptyCostCatalog();
	private costCatalogLoadedAt = 0;
	private costCatalogFetch: Promise<void> | undefined;
	private notices: string[] = [];
	private inFlight: Promise<void> | undefined;
	private overrides: CompiledOverrides | undefined;
	/** The raw entries of the last successful fetch, for repricing without a refetch. */
	private lastEntries: CpaModel[] | undefined;
	private lastModelsUrl: string | undefined;

	constructor(
		private readonly agentDir: string,
		private readonly providerId: string,
		private readonly options: CatalogControllerOptions = {},
	) {}

	getSnapshot(): CatalogSnapshot {
		return {
			models: this.models,
			fetchedAt: this.fetchedAt,
			fromCache: this.lastSource === "cache",
			error: this.lastError,
		};
	}

	getModels(): CatalogModel[] {
		return this.models;
	}

	getModelsById(): Map<string, CatalogModel> {
		return new Map(this.models.map((model) => [model.meta.id, model]));
	}

	getLastError(): string | undefined {
		return this.lastError;
	}

	getLastSource(): "remote" | "cache" | "none" {
		return this.lastSource;
	}

	getFetchedAt(): number | undefined {
		return this.fetchedAt;
	}

	getOverrides(): CompiledOverrides {
		return this.overrides ?? loadOverrides(this.agentDir);
	}

	getCostCatalog(): CostCatalog {
		return this.costCatalog;
	}

	/** Model ids the catalog advertises a priority service tier for. */
	fastModelIds(): string[] {
		return this.models.filter((model) => model.meta.fast).map((model) => model.meta.id);
	}

	/** Notices produced by the last refresh; drained so each is shown once. */
	takeNotices(): string[] {
		const pending = this.notices;
		this.notices = [];
		return pending;
	}

	findModel(id: string): CatalogModel | undefined {
		const normalized = id.trim().toLowerCase();
		return this.models.find((model) => model.meta.id.toLowerCase() === normalized);
	}

	configs(): ChatModelConfig[] {
		return this.models.filter((model) => model.meta.listing !== "hidden").map((model) => model.config);
	}

	/**
	 * Resolve the models.dev pricing document.
	 *
	 * A fresh on-disk cache is applied synchronously, so a warm start never waits on
	 * the network. `background` leaves only the fetch off the critical path: the
	 * models are registered with the cached (or no) rates and repriced when the
	 * document lands. `await` blocks, for user-initiated refreshes where the listing
	 * should show real prices immediately.
	 */
	private async ensureCostCatalog(pricingEnabled: boolean, mode: PricingMode, signal?: AbortSignal): Promise<void> {
		if (!pricingEnabled) {
			this.costCatalog = emptyCostCatalog();
			this.costCatalogLoadedAt = Date.now();
			return;
		}
		if (this.isCostCatalogLoaded()) {
			return;
		}
		const cached = readModelsDevCache(this.agentDir);
		if (cached) {
			this.applyCostCatalog(cached.providers);
			if (isModelsDevCacheFresh(cached.timestamp)) {
				return;
			}
		}
		if (mode === "background") {
			void this.refreshCostCatalogInBackground(signal);
			return;
		}
		try {
			const snapshot = await fetchModelsDevCatalog(this.agentDir, signal ? { signal } : {});
			if (snapshot) {
				this.applyCostCatalog(snapshot.providers);
			}
		} catch (error) {
			log.debug("cost catalog unavailable", errorMessage(error));
		}
	}

	/** models.dev is a large document; re-read it at most once per process per 5 minutes. */
	private isCostCatalogLoaded(): boolean {
		return Date.now() - this.costCatalogLoadedAt < 5 * 60 * 1000 && this.costCatalog.exact.size > 0;
	}

	private applyCostCatalog(providers: Record<string, unknown>): void {
		this.costCatalog = buildCostCatalog(providers);
		this.costCatalogLoadedAt = Date.now();
	}

	/**
	 * Fetch pricing off the critical path, then reprice the catalog already fetched.
	 * Deduplicated: concurrent refreshes share one fetch.
	 */
	private async refreshCostCatalogInBackground(signal?: AbortSignal): Promise<void> {
		if (this.costCatalogFetch) {
			await this.costCatalogFetch;
			return;
		}
		this.costCatalogFetch = (async () => {
			try {
				const snapshot = await fetchModelsDevCatalog(this.agentDir, signal ? { signal } : {});
				if (!snapshot) {
					return;
				}
				this.applyCostCatalog(snapshot.providers);
				this.reapplyEntries();
				log.debug("pricing refreshed in the background");
				this.options.onCatalogUpdated?.();
			} catch (error) {
				log.debug("background cost catalog refresh failed", errorMessage(error));
			} finally {
				this.costCatalogFetch = undefined;
			}
		})();
		await this.costCatalogFetch;
	}

	/** Recompute the in-memory catalog from the last fetch with the current pricing. */
	private reapplyEntries(): void {
		if (!this.lastEntries || !this.lastModelsUrl) {
			return;
		}
		const overrides = this.overrides ?? loadOverrides(this.agentDir);
		const now = Date.now();
		const fresh = mapCatalog(this.lastEntries, { overrides, costCatalog: this.costCatalog, now });
		const final = reconcileCatalog(fresh, this.models, overrides, now, this.fetchedAt ?? now);
		this.applyCatalog(final.models, "remote", now);
		saveCatalogCache(this.agentDir, this.lastModelsUrl, final.models);
	}

	private applyCatalog(models: CatalogModel[], source: "remote" | "cache", fetchedAt: number): void {
		this.models = models;
		this.fetchedAt = fetchedAt;
		this.lastSource = source;
	}

	/**
	 * The models known before this fetch: in-memory state when present, otherwise the
	 * on-disk cache. Seeding from the cache is what makes a pin survive a restart,
	 * since a model missing from the first fetch of a process has no other source.
	 */
	private knownModels(modelsUrl: string): KnownModels {
		if (this.models.length > 0) {
			return {
				models: this.models,
				fetchedAt: this.fetchedAt,
				source: this.lastSource === "none" ? "remote" : this.lastSource,
			};
		}
		const cached = loadCatalogCache(this.agentDir, modelsUrl);
		if (cached) {
			return { models: cached.models, fetchedAt: cached.fetchedAt, source: "cache" };
		}
		return { models: [], source: "none" };
	}

	private reportDroppedModels(dropped: string[], retained: CatalogModel[]): void {
		const unlistedInUse = retained.filter((model) => model.meta.listing === "unlisted").map((model) => model.meta.id);
		if (unlistedInUse.length > 0) {
			log.info(
				`${unlistedInUse.length} model(s) missing from the latest catalog, retained for the grace period`,
				unlistedInUse.slice(0, 8).join(", "),
			);
		}
		if (dropped.length === 0) {
			return;
		}

		// Only warn when a dropped model is actively in use; a quiet catalog change
		// should not produce a notification on every startup.
		const configured = loadConfiguredDefault(this.agentDir);
		const inUse = dropped.filter((id) => isConfiguredDefaultModel(configured, id, this.providerId));
		if (inUse.length === 0) {
			log.info(`dropped ${dropped.length} model(s) no longer in the catalog`, dropped.slice(0, 8).join(", "));
			return;
		}
		const list = inUse.slice(0, 3).join(", ");
		this.notices.push(
			`Model ${list} was removed from the CLIProxyAPI catalog. Pin it in ${overridesPath(this.agentDir, loadConfigSafe(this.agentDir).config)} to keep it.`,
		);
	}

	/**
	 * A model that appeared in the catalog is worth one notice: the operator may have
	 * just enabled a route the user wants. The first fetch of a process is not a delta,
	 * so only changes against a known catalog are reported.
	 */
	private reportAddedModels(previous: CatalogModel[], models: CatalogModel[]): void {
		if (previous.length === 0) {
			return;
		}
		const knownIds = new Set(previous.map((model) => model.meta.id));
		const added = models.filter((model) => !knownIds.has(model.meta.id)).map((model) => model.meta.id);
		if (added.length === 0) {
			return;
		}
		const shown = added.slice(0, 8);
		log.info(`${added.length} new model(s) in the catalog`, shown.join(", "));
		this.notices.push(
			`${added.length} new model(s) available from CLIProxyAPI: ${shown.join(", ")}${added.length > shown.length ? ", ..." : ""}`,
		);
	}

	/**
	 * Fetch the catalog and update in-memory state.
	 *
	 * Never rejects: a failed fetch keeps the previously known models so the picker
	 * does not empty out because the proxy hiccuped.
	 */
	async refresh(options: {
		allowNetwork: boolean;
		force?: boolean;
		signal?: AbortSignal;
		pricing?: PricingMode;
	}): Promise<CatalogSnapshot> {
		if (this.inFlight) {
			await this.inFlight;
			return this.getSnapshot();
		}
		const task = this.runRefresh(options).finally(() => {
			this.inFlight = undefined;
		});
		this.inFlight = task;
		await task;
		return this.getSnapshot();
	}

	private async runRefresh(options: {
		allowNetwork: boolean;
		force?: boolean;
		signal?: AbortSignal;
		pricing?: PricingMode;
	}): Promise<void> {
		const overrides = loadOverrides(this.agentDir);
		this.overrides = overrides;

		const identity = resolveIdentity(this.agentDir);
		const connection = resolveConnectionForRefresh(this.agentDir, identity.providerId);
		if (!connection) {
			this.lastError = "no CLIProxyAPI credential configured";
			log.debug("refresh skipped: not configured");
			return;
		}
		this.lastModelsUrl = connection.modelsUrl;

		await this.ensureCostCatalog(overrides.defaults.pricing, options.pricing ?? "await", options.signal);

		const known = this.knownModels(connection.modelsUrl);

		if (!options.allowNetwork) {
			if (known.models.length > 0) {
				this.applyCatalog(known.models, known.source === "cache" ? "cache" : "remote", known.fetchedAt ?? 0);
			}
			return;
		}

		const now = Date.now();
		// Extension load, pi's own model refresh and session_start can all fire within
		// seconds of each other; an explicit force always goes to the network.
		if (!this.shouldFetch(now, options.force)) {
			log.debug("catalog refresh skipped: a successful fetch happened moments ago");
			return;
		}

		try {
			const entries = await fetchCatalog(connection.modelsUrl, connection.apiKey, {
				...(options.signal ? { signal: options.signal } : {}),
			});
			this.applyFetchedEntries(entries, known, now);
		} catch (error) {
			if (options.signal?.aborted) {
				return;
			}
			this.lastError = errorMessage(error);
			if (isUnauthorizedCatalogError(error)) {
				this.notices.push(
					`CLIProxyAPI rejected the credential (HTTP 401). Re-run /login ${identity.providerName} to reconfigure.`,
				);
			}
			log.warn(`catalog refresh failed: ${this.lastError}`);

			// Keep the known list so a proxy hiccup does not empty the picker.
			if (known.models.length > 0) {
				this.applyCatalog(known.models, known.source === "cache" ? "cache" : "remote", known.fetchedAt ?? 0);
			}
		}
	}

	/** Whether a network fetch is worth it right now. */
	private shouldFetch(now: number, force?: boolean): boolean {
		if (force || this.lastSource !== "remote" || this.fetchedAt === undefined) {
			return true;
		}
		return now - this.fetchedAt >= resolveCatalogMinRefreshMs();
	}

	/** Map, reconcile, report and cache one successful fetch. */
	private applyFetchedEntries(entries: CpaModel[], known: KnownModels, now: number): void {
		const overrides = this.overrides ?? loadOverrides(this.agentDir);
		this.lastEntries = entries;
		const fresh = mapCatalog(entries, { overrides, costCatalog: this.costCatalog, now });
		// Reconcile against the known state, measuring any grace period from the fetch
		// that last listed the model rather than from this one.
		const baselineFetchedAt = known.fetchedAt ?? now;
		const final = reconcileCatalog(fresh, known.models, overrides, now, baselineFetchedAt);
		this.reportDroppedModels(final.dropped, final.retained);
		this.reportAddedModels(known.models, final.models);
		this.applyCatalog(final.models, "remote", now);
		this.lastError = undefined;
		if (this.lastModelsUrl) {
			saveCatalogCache(this.agentDir, this.lastModelsUrl, final.models);
		}
	}
}

/** The catalog state a refresh reconciles against. */
interface KnownModels {
	models: CatalogModel[];
	fetchedAt?: number;
	source: "remote" | "cache" | "none";
}

/** Resolve the connection a refresh needs. */
function resolveConnectionForRefresh(
	agentDir: string,
	providerId: string,
): { modelsUrl: string; apiKey: string; baseUrlInput: string } | null {
	const connection = resolveConnection(agentDir, providerId);
	return connection
		? { modelsUrl: connection.modelsUrl, apiKey: connection.apiKey, baseUrlInput: connection.baseUrlInput }
		: null;
}

export interface ProviderRegistrationOptions {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	baseUrlInput: string;
	apiKey?: string;
	catalog: CatalogController;
	onConfigured?: (baseUrlInput: string, apiKey: string) => Promise<void>;
}

/** Build the `/login` handler set and the provider config. */
export function buildProviderRegistration(options: ProviderRegistrationOptions): ProviderConfig {
	const { agentDir, providerId, providerName, baseUrlInput, apiKey, catalog } = options;
	const endpoints = resolveEndpoints(baseUrlInput);
	const defaultBaseUrl = firstNonEmpty(baseUrlInput, DEFAULT_BASE_URL)!;

	return {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		api: "openai-responses",
		// Passing apiKey as well as oauth would make `/login <provider>` ask the user
		// to choose between the API-key and account paths. Ambient auth is only needed
		// when no `/login` credential exists.
		...(apiKey ? { apiKey } : {}),
		models: catalog.configs(),
		refreshModels: async (ctx: RefreshModelsContext) => {
			await catalog.refresh({
				allowNetwork: ctx.allowNetwork,
				force: ctx.force === true,
				signal: ctx.signal,
			});
			return catalog.configs();
		},
		oauth: {
			name: providerName,
			async login(callbacks) {
				let promptDefaultBaseUrl = defaultBaseUrl;
				// Validate by fetching the catalog; HTTP 200 (even with an empty catalog)
				// means the base URL and key are usable, so re-prompt only on failure.
				for (;;) {
					callbacks.onProgress?.(
						`Configure ${providerName}. Preferred base URL form: host:port (for example http://127.0.0.1:8317).`,
					);
					const baseUrlRaw = await callbacks.onPrompt({
						message: `${providerName} base URL [${promptDefaultBaseUrl}]:`,
						placeholder: promptDefaultBaseUrl,
						allowEmpty: true,
					});
					const enteredBaseUrl = firstNonEmpty(baseUrlRaw, promptDefaultBaseUrl)!;
					try {
						resolveEndpoints(enteredBaseUrl);
					} catch (error) {
						callbacks.onProgress?.(`Invalid base URL: ${errorMessage(error)}`);
						promptDefaultBaseUrl = enteredBaseUrl;
						continue;
					}

					const enteredApiKey = (
						await callbacks.onPrompt({
							message: `${providerName} API key:`,
							placeholder: "sk-...",
							allowEmpty: false,
						})
					).trim();
					if (!enteredApiKey) {
						callbacks.onProgress?.("API key cannot be empty.");
						promptDefaultBaseUrl = enteredBaseUrl;
						continue;
					}

					callbacks.onProgress?.("Validating credentials via the models endpoint...");
					try {
						const endpoints = resolveEndpoints(enteredBaseUrl);
						const entries = await fetchCatalog(endpoints.modelsUrl, enteredApiKey, {
							...(callbacks.signal ? { signal: callbacks.signal } : {}),
						});
						saveConfig(agentDir, {
							baseUrl: enteredBaseUrl,
							apiKey: enteredApiKey,
							providerId,
							providerName,
						});
						// Validation only needs HTTP 200; the catalog itself is fetched by the
						// refresh that `onConfigured` runs, and that path writes the cache.
						await options.onConfigured?.(enteredBaseUrl, enteredApiKey);
						callbacks.onProgress?.(`Registered ${entries.length} model(s) from ${endpoints.modelsUrl}.`);
						return {
							refresh: encodeCredentialMeta(enteredBaseUrl),
							access: enteredApiKey,
							expires: Date.now() + CREDENTIAL_TTL_MS,
						};
					} catch (error) {
						callbacks.onProgress?.(
							`Login validation failed: ${errorMessage(error)}\nPlease re-enter the base URL and API key.`,
						);
						promptDefaultBaseUrl = enteredBaseUrl;
					}
				}
			},
			async refreshToken(credentials) {
				// API keys do not expire; keep the stored payload and extend its window.
				return { ...credentials, expires: Date.now() + CREDENTIAL_TTL_MS };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},
	};
}

/** Register or replace the provider with the current catalog. */
export function registerProvider(options: ProviderRegistrationOptions): void {
	const { pi, providerId, catalog } = options;
	const hasLogin = hasStoredLogin(options.agentDir, providerId);
	const apiKey = hasLogin ? undefined : options.apiKey;
	// Replace the previous registration so an older ambient key cannot linger.
	pi.unregisterProvider(providerId);
	pi.registerProvider(providerId, buildProviderRegistration({ ...options, apiKey }));
	log.debug(`registered provider ${providerId} with ${catalog.configs().length} model(s)`);
}

/** Flush pending catalog notices to the UI, if a context is available. */
export function flushNotices(catalog: CatalogController, ctx: ExtensionContext | undefined): void {
	if (!ctx?.hasUI) {
		catalog.takeNotices();
		return;
	}
	for (const notice of catalog.takeNotices()) {
		try {
			ctx.ui.notify(notice, "warning");
		} catch (error) {
			if (!isStaleContextError(error)) {
				log.debug("failed to show notice", errorMessage(error));
			}
		}
	}
}
