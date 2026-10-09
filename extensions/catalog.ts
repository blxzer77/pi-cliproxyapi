/**
 * CLIProxyAPI catalog: fetch, map to pi models, and reconcile with the previously
 * published catalog.
 *
 * `GET {root}/v1/models?client_version=pi` returns the operator's upstream client
 * metadata verbatim, so it is rich but not uniform: a Codex route carries ~180
 * fields while a relayed third-party model may carry eight. Everything usable is
 * mapped; everything else is preserved in `meta.extras` so `/cpa-models` can show
 * what the catalog actually said.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, MODELS_REQUEST_TIMEOUT_MS } from "./config.ts";
import {
	buildThinkingLevelMap,
	type CompiledOverrides,
	type ModelOverride,
	resolveOverride,
	type ThinkingLevelMap,
} from "./overrides.ts";
import { type Cost, type CostCatalog, costHasRates, emptyCostCatalog, matchCost, ZERO_COST } from "./pricing.ts";

/** pi's chat-model registration shape, derived because the concrete type is not re-exported. */
export type ChatModelConfig = Extract<ProviderModelConfig, { maxTokens: number }>;

export interface CpaReasoningLevel {
	effort?: string;
	description?: string;
}

export interface CpaServiceTier {
	id?: string;
	name?: string;
	description?: string;
}

/** A catalog entry. Only documented fields are typed; the rest is passthrough. */
export interface CpaModel {
	slug?: string;
	id?: string;
	display_name?: string;
	name?: string;
	description?: string;
	context_window?: number;
	max_context_window?: number;
	max_tokens?: number;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	auto_compact_token_limit?: number | null;
	default_reasoning_level?: string | null;
	default_verbosity?: string | null;
	input_modalities?: string[];
	supported_reasoning_levels?: Array<CpaReasoningLevel | string>;
	default_service_tier?: string | null;
	service_tiers?: Array<CpaServiceTier | string>;
	additional_speed_tiers?: string[];
	visibility?: string;
	tool_mode?: string | null;
	supports_parallel_tool_calls?: boolean;
	prefer_websockets?: boolean;
	truncation_policy?: unknown;
	available_in_plans?: string[];
	[key: string]: unknown;
}

export interface CpaModelsResponse {
	models?: CpaModel[];
	data?: CpaModel[];
}

/** How a model's presence in the picker was decided. */
export type ModelListing = "listed" | "pinned" | "unlisted" | "hidden";

export interface CatalogModelMeta {
	id: string;
	name: string;
	listing: ModelListing;
	/** Whether the remote catalog listed this model in the latest fetch. */
	listed: boolean;
	pinned: boolean;
	/** When the model first went missing from the catalog, if it has. */
	unlistedSince?: number;
	fast: boolean;
	costSource: "override" | "models.dev" | "none";
	/** Raw catalog values, kept so overrides can be written against reality. */
	catalog: {
		contextWindow?: number;
		maxContextWindow?: number;
		maxTokens?: number;
		reasoningLevels: string[];
		visibility?: string;
	};
	/** Fields the catalog exposes that pi has no concept for. */
	extras: Record<string, unknown>;
}

export interface CatalogModel {
	config: ChatModelConfig;
	meta: CatalogModelMeta;
}

export class CatalogHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, body: string) {
		super(`models request failed: ${status} ${statusText}${body ? ` body=${body.slice(0, 200)}` : ""}`);
		this.name = "CatalogHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

export function isUnauthorizedCatalogError(error: unknown): boolean {
	return error instanceof CatalogHttpError && error.status === 401;
}

/** Fields worth surfacing in `/cpa-models` even though pi cannot act on them. */
const EXTRA_FIELDS = [
	"auto_compact_token_limit",
	"default_reasoning_level",
	"default_verbosity",
	"tool_mode",
	"supports_parallel_tool_calls",
	"prefer_websockets",
	"truncation_policy",
	"additional_speed_tiers",
	"available_in_plans",
	"default_service_tier",
	"description",
] as const;

export function fetchCatalog(
	modelsUrl: string,
	apiKey: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CpaModel[]> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? MODELS_REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	return fetch(modelsUrl, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal,
	}).then(async (response) => {
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new CatalogHttpError(response.status, response.statusText, body);
		}
		// A 200 is success even with an empty or non-JSON body.
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return [];
		}
		if (Array.isArray(payload)) {
			return payload as CpaModel[];
		}
		if (payload && typeof payload === "object") {
			const object = payload as CpaModelsResponse;
			if (Array.isArray(object.models)) {
				return object.models;
			}
			if (Array.isArray(object.data)) {
				return object.data;
			}
		}
		return [];
	});
}

export function catalogModelId(model: CpaModel): string {
	return String(model.slug ?? model.id ?? "").trim();
}

export function extractReasoningLevels(model: CpaModel): string[] {
	const raw = model.supported_reasoning_levels ?? [];
	const levels: string[] = [];
	for (const entry of raw) {
		const effort = typeof entry === "string" ? entry : typeof entry?.effort === "string" ? entry.effort : "";
		const normalized = effort.trim().toLowerCase();
		if (normalized && !levels.includes(normalized)) {
			levels.push(normalized);
		}
	}
	return levels;
}

export function supportsFastTier(model: CpaModel): boolean {
	return Array.isArray(model.service_tiers) && model.service_tiers.some((tier) => Boolean(tier));
}

function positiveNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return undefined;
}

function buildInputModalities(model: CpaModel, override: ModelOverride | undefined): Array<"text" | "image"> {
	if (override?.input && override.input.length > 0) {
		return [...new Set(override.input)];
	}
	const input: Array<"text" | "image"> = [];
	for (const modality of model.input_modalities ?? []) {
		const value = String(modality).trim().toLowerCase();
		if ((value === "text" || value === "image") && !input.includes(value)) {
			input.push(value);
		}
	}
	if (!input.includes("text")) {
		input.unshift("text");
	}
	return input;
}

function resolveThinkingLevelMap(levels: string[], override: ModelOverride | undefined): ThinkingLevelMap | undefined {
	if (override?.thinkingLevelMap) {
		return { ...buildThinkingLevelMap(levels), ...override.thinkingLevelMap };
	}
	if (override?.thinkingLevels) {
		return buildThinkingLevelMap(override.thinkingLevels);
	}
	return buildThinkingLevelMap(levels);
}

export interface MapOptions {
	overrides: CompiledOverrides;
	costCatalog: CostCatalog;
	/** Previous catalog, used to carry `unlistedSince` forward. */
	previous?: Map<string, CatalogModelMeta>;
	/** When this fetch happened; injected so tests are deterministic. */
	now?: number;
}

/**
 * Map one catalog entry to a pi model.
 *
 * Returns `null` when the entry is unusable (no id, or hidden by the catalog
 * without an override asking for it).
 */
export function toCatalogModel(model: CpaModel, options: MapOptions): CatalogModel | null {
	const id = catalogModelId(model);
	if (!id) {
		return null;
	}

	const override = resolveOverride(options.overrides, id);
	const visibility = typeof model.visibility === "string" ? model.visibility.trim().toLowerCase() : undefined;
	if (
		options.overrides.defaults.respectVisibility &&
		visibility === "hide" &&
		override?.show !== true &&
		override?.hidden !== true
	) {
		return null;
	}

	const catalogContextWindow =
		options.overrides.defaults.contextWindowSource === "max_context_window"
			? positiveNumber(model.max_context_window, model.context_window)
			: positiveNumber(model.context_window, model.max_context_window);
	const catalogMaxTokens = positiveNumber(model.max_tokens, model.max_output_tokens, model.max_completion_tokens);
	const contextWindow =
		override?.contextWindow ??
		catalogContextWindow ??
		options.overrides.defaults.contextWindow ??
		DEFAULT_CONTEXT_WINDOW;
	const maxTokens =
		override?.maxTokens ?? catalogMaxTokens ?? options.overrides.defaults.maxTokens ?? DEFAULT_MAX_TOKENS;

	const levels = extractReasoningLevels(model);
	const thinkingLevelMap = resolveThinkingLevelMap(levels, override);
	const reasoning = override?.reasoning ?? levels.some((level) => level !== "none");

	const configuredCost = override?.cost;
	const overrideCost: Cost | undefined =
		configuredCost && Object.keys(configuredCost).length > 0 ? { ...ZERO_COST, ...configuredCost } : undefined;
	const pricingEnabled = options.overrides.defaults.pricing;
	const fast = override?.fast ?? supportsFastTier(model);
	const costCatalog = pricingEnabled ? options.costCatalog : emptyCostCatalog();
	const matched = matchCost(override?.pricingModelId ?? id, costCatalog, { override: overrideCost, fast: false });
	const cost = matched;

	const previous = options.previous?.get(id);
	const listing: ModelListing = override?.hidden
		? "hidden"
		: override?.pin
			? "pinned"
			: previous?.listing === "unlisted"
				? "unlisted"
				: "listed";

	const extras: Record<string, unknown> = {};
	for (const field of EXTRA_FIELDS) {
		if (model[field] !== undefined && model[field] !== null) {
			extras[field] = model[field];
		}
	}

	const name = override?.name ?? (String(model.display_name ?? model.name ?? id).trim() || id);

	const config: ChatModelConfig = {
		id,
		name,
		api: "openai-responses",
		input: buildInputModalities(model, override),
		cost,
		contextWindow,
		maxTokens,
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(override?.headers ? { headers: override.headers } : {}),
		...(override?.samplingParams ? { samplingParams: override.samplingParams } : {}),
	};

	const costSource: CatalogModelMeta["costSource"] = overrideCost
		? "override"
		: costHasRates(cost)
			? "models.dev"
			: "none";

	return {
		config,
		meta: {
			id,
			name,
			listing,
			listed: true,
			pinned: override?.pin === true,
			fast,
			costSource,
			catalog: {
				contextWindow: catalogContextWindow,
				maxContextWindow: positiveNumber(model.max_context_window),
				maxTokens: catalogMaxTokens,
				reasoningLevels: levels,
				visibility,
			},
			extras,
		},
	};
}

export function mapCatalog(models: CpaModel[], options: MapOptions): CatalogModel[] {
	const mapped: CatalogModel[] = [];
	for (const model of models) {
		const result = toCatalogModel(model, options);
		if (result) {
			mapped.push(result);
		}
	}
	return mapped;
}

export interface ReconcileResult {
	models: CatalogModel[];
	/** Models kept because they are pinned or still inside the grace period. */
	retained: CatalogModel[];
	/** Models dropped from the picker by this reconcile. */
	dropped: string[];
}

/**
 * Reconcile a fresh catalog with the previously published one.
 *
 * A model missing from a healthy 200 response is either a real catalog change or a
 * transient upstream blip, and the two are indistinguishable from one sample. This
 * keeps it for a bounded grace period behind an explicit `unlisted` state instead of
 * hiding models for days and warning on every refresh. Pinned models are never
 * dropped and never warned about.
 */
export function reconcileCatalog(
	fresh: CatalogModel[],
	previous: CatalogModel[],
	overrides: CompiledOverrides,
	now = Date.now(),
	previousFetchedAt = now,
): ReconcileResult {
	const freshIds = new Set(fresh.map((model) => model.meta.id));
	const retained: CatalogModel[] = [];
	const dropped: string[] = [];

	for (const prior of previous) {
		if (freshIds.has(prior.meta.id)) {
			continue;
		}
		const override = resolveOverride(overrides, prior.meta.id);
		if (override?.hidden) {
			continue;
		}
		if (override?.pin) {
			retained.push({
				config: prior.config,
				meta: { ...prior.meta, listed: false, listing: "pinned", pinned: true },
			});
			continue;
		}

		// The grace period starts at the last fetch that still listed the model, not at
		// the fetch where the absence was first noticed, so a model that disappears
		// without an intervening refresh does not get a fresh grace period.
		const unlistedSince = prior.meta.unlistedSince ?? previousFetchedAt;
		if (overrides.defaults.unlistedPolicy === "retain" || now - unlistedSince < overrides.defaults.unlistedGraceMs) {
			retained.push({
				config: prior.config,
				meta: { ...prior.meta, listed: false, listing: "unlisted", unlistedSince },
			});
			continue;
		}
		dropped.push(prior.meta.id);
	}

	return { models: [...fresh, ...retained], retained, dropped };
}

/** Catalog ids whose current or default status deserves a single notification. */
export function droppedModelsInUse(
	dropped: string[],
	currentModelId: string | undefined,
	defaultModelId: string | undefined,
): string[] {
	return dropped.filter((id) => id === currentModelId || id === defaultModelId);
}
