/**
 * CLIProxyAPI provider for pi.
 *
 * Design notes:
 *
 * - Transport is pi-ai's built-in `openai-responses` against
 *   `{root}/backend-api/codex/responses`. CLIProxyAPI accepts a standard Responses
 *   body there, so the provider registers no `streamSimple` and needs no patched
 *   stream module. It also avoids the Codex WebSocket path, so nothing is cached
 *   server-side and a reused connection cannot inflate `cacheRead` after compaction.
 * - The catalog comes from `/v1/models?client_version=pi` through pi's
 *   `refreshModels` hook, and is corrected by a declarative overrides file rather
 *   than by editing this extension.
 * - `service_tier: "priority"` (Fast) is injected through `before_provider_request`.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import {
	configPath,
	defaultBaseUrlInput,
	loadConfigSafe,
	overridesPath,
	resolveConnection,
	resolveFastDefault,
	resolveIdentity,
	resolvePauseDefault,
} from "./config.ts";
import { FastModeController, withPriorityServiceTier } from "./fast.ts";
import { errorMessage, isStaleContextError, log, setQuiet } from "./log.ts";
import { loadOverrides } from "./overrides.ts";
import { PauseController, waitForPauseToEnd } from "./pause.ts";
import { CatalogController, flushNotices, registerProvider } from "./provider.ts";
import { registerTransientErrorNormalizer } from "./retry.ts";
import { UsageReporter } from "./usage.ts";

export { reconcileCatalog, toCatalogModel } from "./catalog.ts";
export { resolveEndpoints } from "./config.ts";
export { FastModeController, persistFastPreference, withPriorityServiceTier } from "./fast.ts";
export { buildThinkingLevelMap, compileOverrides, resolveOverride } from "./overrides.ts";
export { PauseController } from "./pause.ts";
export { buildCostCatalog, computeCost, matchCost } from "./pricing.ts";
export { normalizeTransientError } from "./retry.ts";
export { formatElapsed, formatTokens, UsageReporter } from "./usage.ts";

const FAST_STATUS_KEY = "cpa-fast";

/**
 * What the footer should say, derived from what the pause gate and Fast actually do.
 *
 * The pause gate only applies to this provider's requests (`before_provider_request`
 * returns early for every other provider), so a `paused` label on another provider's
 * model would claim a gate that does not exist.
 */
export function buildStatusLabels(
	model: { provider: string; id: string } | undefined,
	fastMode: FastModeController,
	pauseMode: PauseController,
	providerId: string,
): { fast?: "on" | "off"; paused: boolean } {
	if (!model || model.provider !== providerId) {
		return { paused: false };
	}
	const fast = fastMode.stateFor(model.id);
	return { ...(fast ? { fast } : {}), paused: pauseMode.isEnabled() };
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	if (process.env.CLIPROXYAPI_QUIET === "1" || process.env.CLIPROXYAPI_QUIET === "true") {
		setQuiet(true);
	}

	const identity = resolveIdentity(agentDir);
	// The connection the provider is currently registered with, so a background pricing
	// refresh can re-register with the same one.
	let activeConnection: { baseUrlInput: string; apiKey: string } | undefined;
	const catalog = new CatalogController(agentDir, identity.providerId, {
		onCatalogUpdated: () => {
			fastMode.setSupportedModelIds(catalog.fastModelIds());
			if (!activeConnection) {
				return;
			}
			registerProvider({
				pi,
				agentDir,
				providerId: identity.providerId,
				providerName: identity.providerName,
				baseUrlInput: activeConnection.baseUrlInput,
				apiKey: activeConnection.apiKey,
				catalog,
			});
		},
	});

	let fastEnabled = false;
	try {
		fastEnabled = resolveFastDefault(agentDir);
	} catch (error) {
		log.warn(`invalid Fast configuration, using off: ${errorMessage(error)}`);
	}
	const fastMode = new FastModeController(fastEnabled);

	let pauseEnabled = false;
	try {
		pauseEnabled = resolvePauseDefault(agentDir);
	} catch (error) {
		log.warn(`invalid pause configuration, using off: ${errorMessage(error)}`);
	}
	const pauseMode = new PauseController(pauseEnabled);

	const usage = new UsageReporter({
		providerId: identity.providerId,
		pauseMode,
		isFastEffective: (model) => model.provider === identity.providerId && fastMode.isEffectiveFor(model.id),
	});
	usage.register(pi);
	registerTransientErrorNormalizer(pi, identity.providerId);

	/**
	 * Gate every provider request behind the pause setting, and inject the priority
	 * service tier when Fast applies. `before_provider_request` hands back a
	 * replacement payload, so this needs no stream handler.
	 */
	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== identity.providerId) {
			return;
		}
		await waitForPauseToEnd(agentDir, pauseMode);

		const model = ctx.model;
		if (!model || !fastMode.isEffectiveFor(model.id)) {
			return undefined;
		}
		const next = withPriorityServiceTier(event.payload);
		log.debug(`fast enabled for ${model.id}`);
		return next;
	});

	// Status labels for Fast and Pause. These use the built-in status row instead of
	// patching the footer component, so a pi update cannot break them.
	const refreshStatus = (ctx: ExtensionContext | undefined): void => {
		if (!ctx?.hasUI) {
			return;
		}
		try {
			const model = ctx.model;
			const labels = buildStatusLabels(model, fastMode, pauseMode, identity.providerId);
			const parts: string[] = [];
			// A Fast-capable model always says which way the switch is set, so "off" is
			// distinguishable from "this model has no Fast tier" (which shows nothing).
			if (labels.fast === "on") {
				parts.push(ctx.ui.theme.fg("warning", "fast on"));
			} else if (labels.fast === "off") {
				parts.push(ctx.ui.theme.fg("dim", "fast off"));
			}
			if (labels.paused) {
				parts.push(ctx.ui.theme.fg("warning", "paused"));
			}
			ctx.ui.setStatus(FAST_STATUS_KEY, parts.length > 0 ? parts.join(" ") : undefined);
		} catch (error) {
			if (!isStaleContextError(error)) {
				log.debug("failed to update status", errorMessage(error));
			}
		}
	};

	// Commands redraw the labels themselves after they flip a switch; otherwise the
	// footer would stay stale until the next model change.
	registerCommands({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		catalog,
		fastMode,
		pauseMode,
		usage,
		defaultBaseUrl: defaultBaseUrlInput(agentDir, identity.providerId),
		refreshStatus,
	});

	pi.on("model_select", (_event, ctx) => refreshStatus(ctx));
	pi.on("session_start", async (_event, ctx) => {
		refreshStatus(ctx);
		flushNotices(catalog, ctx);

		// Refresh the catalog in the background so startup is not blocked by a slow
		// proxy, then re-register with the latest list. Pricing is fetched in the
		// background too: a cold models.dev cache must not delay the first render.
		const connection = resolveConnection(agentDir, identity.providerId);
		if (!connection) {
			return;
		}
		try {
			await catalog.refresh({ allowNetwork: true, pricing: "background" });
			fastMode.setSupportedModelIds(catalog.fastModelIds());
			activeConnection = { baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey };
			registerProvider({
				pi,
				agentDir,
				providerId: identity.providerId,
				providerName: identity.providerName,
				baseUrlInput: connection.baseUrlInput,
				apiKey: connection.apiKey,
				catalog,
			});
			flushNotices(catalog, ctx);
			refreshStatus(ctx);
		} catch (error) {
			log.warn(`catalog refresh on session start failed: ${errorMessage(error)}`);
		}
	});
	pi.on("session_shutdown", () => {
		refreshStatus(undefined);
	});

	const registerConfigured = async (baseUrlInput: string, apiKey: string): Promise<void> => {
		await catalog.refresh({ allowNetwork: true, force: true, pricing: "background" });
		fastMode.setSupportedModelIds(catalog.fastModelIds());
		activeConnection = { baseUrlInput, apiKey };
		registerProvider({
			pi,
			agentDir,
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput,
			apiKey,
			catalog,
			onConfigured: registerConfigured,
		});
	};

	const connection = resolveConnection(agentDir, identity.providerId);
	const overrides = loadOverrides(agentDir);

	if (!connection) {
		log.info(
			`not configured. Run /login ${identity.providerName} or /login ${identity.providerId}, ` +
				`or set ${configPath(agentDir)} / CLIPROXYAPI_API_KEY.`,
		);
		// Register anyway so the provider appears in /login and can be configured.
		registerProvider({
			pi,
			agentDir,
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput: defaultBaseUrlInput(agentDir, identity.providerId),
			catalog,
			onConfigured: registerConfigured,
		});
		return;
	}

	// Populate the catalog before the first registration so the model picker is
	// correct on the very first render. Pricing is fetched in the background: a cold
	// models.dev cache must not delay startup.
	try {
		await catalog.refresh({ allowNetwork: true, pricing: "background" });
	} catch (error) {
		log.warn(`initial catalog load failed: ${errorMessage(error)}`);
	}
	fastMode.setSupportedModelIds(catalog.fastModelIds());
	activeConnection = { baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey };

	registerProvider({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: connection.baseUrlInput,
		apiKey: connection.apiKey,
		catalog,
		onConfigured: registerConfigured,
	});

	if (!overrides.found) {
		log.debug(
			`no overrides file at ${overridesPath(agentDir, loadConfigSafe(agentDir).config)}; using catalog values`,
		);
	}
	for (const problem of overrides.problems) {
		log.warn(`override problem: ${problem}`);
	}

	const snapshot = catalog.getSnapshot();
	log.info(
		`ready: ${snapshot.models.length} model(s) from ${catalog.getLastSource()}` +
			`${snapshot.error ? ` (last refresh failed: ${snapshot.error})` : ""}`,
	);
	if (snapshot.models.length === 0) {
		log.warn("the catalog returned no usable models. Run /cpa-refresh once the proxy lists models.");
	}
}
