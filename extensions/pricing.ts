/**
 * Cost lookup.
 *
 * CLIProxyAPI reports exact token counts per response but no price, so rates come
 * from a catalog. Precedence is: explicit override > models.dev > zero.
 *
 * models.dev rates are USD per million tokens, which is exactly what pi's model
 * `cost` fields expect.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./log.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODELS_DEV_FETCH_TIMEOUT_MS = 8_000;

export const ZERO_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface CostTier {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Apply this tier when total input-side usage exceeds this threshold. */
	inputTokensAbove: number;
}

export interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: CostTier[];
}

export interface CostEntry {
	providerId: string;
	modelId: string;
	standard: Cost;
	fast?: Cost;
}

export interface CostCatalog {
	/** Lowercased id (and namespace-stripped id) -> entries. */
	exact: Map<string, CostEntry[]>;
	/** Alphanumeric-only id -> entries. Used as a last-resort match. */
	normalized: Map<string, CostEntry[]>;
}

export function emptyCostCatalog(): CostCatalog {
	return { exact: new Map(), normalized: new Map() };
}

/** Whether a cost carries any non-zero rate. */
export function costHasRates(cost: Cost): boolean {
	if (cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0) {
		return true;
	}
	return (cost.tiers ?? []).some(
		(tier) => tier.input > 0 || tier.output > 0 || tier.cacheRead > 0 || tier.cacheWrite > 0,
	);
}

interface ModelsDevCostPayload {
	input?: unknown;
	output?: unknown;
	cache_read?: unknown;
	cache_write?: unknown;
	tiers?: unknown;
	context_over_200k?: unknown;
}

interface ModelsDevModelPayload {
	cost?: ModelsDevCostPayload;
	experimental?: { modes?: Record<string, { cost?: ModelsDevCostPayload } | undefined> };
}

const NAMESPACE_PREFIX =
	/^(openai|anthropic|google(?:-vertex)?|xai|deepseek|mistral|cohere|zhipuai|moonshotai|minimax|meta|alibaba|qwen|xiaomi|stepfun|tencent|baidu|bytedance|z-ai|zai|amazon|meta-llama)[/:.]/i;

/**
 * Vendor preference per model family. Used to disambiguate when several providers
 * publish the same model id at different prices.
 */
const FAMILY_PREFERENCES: Array<{ pattern: RegExp; providers: string[] }> = [
	{ pattern: /^(?:gpt-|o[134](?:-|$)|chatgpt-|codex-)/, providers: ["openai", "openai-codex", "opencode"] },
	{ pattern: /^claude-/, providers: ["anthropic"] },
	{ pattern: /^(?:gemini-|gemma-)/, providers: ["google", "google-vertex"] },
	{ pattern: /^grok-/, providers: ["xai"] },
	{ pattern: /^deepseek-/, providers: ["deepseek"] },
	{ pattern: /^glm-/, providers: ["zhipuai", "z-ai"] },
	{ pattern: /^(?:kimi-|moonshot-)/, providers: ["moonshotai"] },
	{ pattern: /^minimax-/, providers: ["minimax"] },
	{ pattern: /^step-/, providers: ["stepfun"] },
	{ pattern: /^qwen-/, providers: ["alibaba", "qwen"] },
	{ pattern: /^mistral-/, providers: ["mistral"] },
	{ pattern: /^llama-/, providers: ["meta"] },
];

/** Known proxy-only ids whose billable base model differs from the id. */
export const PRICE_ALIASES: Record<string, string[]> = {
	"gemini-pro-agent": ["gemini-3.1-pro-preview"],
	"gemini-3.1-pro-low": ["gemini-3.1-pro-preview"],
	"gemini-3.6-flash-high": ["gemini-3.6-flash"],
	"gemini-3-flash-agent": ["gemini-3.5-flash"],
	"grok-composer-2.5-fast": ["grok-4.3"],
	"grok-3-mini": ["xai/grok-3-mini"],
};

/** Cost overrides belong to the overrides file; aliases are the shared fallback. */
export function registerPriceAlias(modelId: string, targets: string[]): void {
	PRICE_ALIASES[modelId.trim().toLowerCase()] = targets;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRate(source: Record<string, unknown>, key: keyof Cost, fallback: number): number {
	const rawKey = key === "cacheRead" ? "cache_read" : key === "cacheWrite" ? "cache_write" : key;
	return finiteNumber(source[key] ?? source[rawKey]) ?? fallback;
}

export function parseModelsDevCost(raw: ModelsDevCostPayload | undefined): Cost | undefined {
	const source = asRecord(raw);
	if (!source) {
		return undefined;
	}
	const input = finiteNumber(source.input);
	const output = finiteNumber(source.output);
	if (input === undefined && output === undefined) {
		return undefined;
	}

	const cost: Cost = {
		input: input ?? 0,
		output: output ?? 0,
		cacheRead: readRate(source, "cacheRead", 0),
		cacheWrite: readRate(source, "cacheWrite", 0),
	};

	const tiers = new Map<number, CostTier>();
	const addTier = (rawTier: unknown, fallbackThreshold?: number): void => {
		const tierSource = asRecord(rawTier);
		if (!tierSource) {
			return;
		}
		const descriptor = asRecord(tierSource.tier);
		if (descriptor?.type !== undefined && descriptor.type !== "context") {
			return;
		}
		const threshold =
			finiteNumber(tierSource.inputTokensAbove) ?? finiteNumber(descriptor?.size) ?? fallbackThreshold;
		if (threshold === undefined || threshold <= 0) {
			return;
		}
		tiers.set(threshold, {
			input: readRate(tierSource, "input", cost.input),
			output: readRate(tierSource, "output", cost.output),
			cacheRead: readRate(tierSource, "cacheRead", cost.cacheRead),
			cacheWrite: readRate(tierSource, "cacheWrite", cost.cacheWrite),
			inputTokensAbove: threshold,
		});
	};

	if (Array.isArray(source.tiers)) {
		for (const tier of source.tiers) {
			addTier(tier);
		}
	}
	if (tiers.size === 0) {
		// Older models.dev records expose only this compatibility shortcut.
		addTier(source.context_over_200k, 200_000);
	}
	if (tiers.size > 0) {
		cost.tiers = Array.from(tiers.values()).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	}
	return cost;
}

function stripNamespace(modelId: string): string {
	return modelId.trim().toLowerCase().replace(NAMESPACE_PREFIX, "");
}

function normalizeKey(modelId: string): string {
	return stripNamespace(modelId).replace(/[^a-z0-9]/g, "");
}

function addEntry(catalog: CostCatalog, key: string, entry: CostEntry): void {
	if (!key) {
		return;
	}
	const entries = catalog.exact.get(key) ?? [];
	if (!entries.some((c) => c.providerId === entry.providerId && c.modelId === entry.modelId)) {
		entries.push(entry);
		catalog.exact.set(key, entries);
	}
}

function addModel(catalog: CostCatalog, entry: CostEntry): void {
	const rawId = entry.modelId.trim().toLowerCase();
	const strippedId = stripNamespace(rawId);
	for (const key of new Set([rawId, strippedId])) {
		addEntry(catalog, key, entry);
	}
	const normalized = normalizeKey(rawId);
	if (normalized) {
		const entries = catalog.normalized.get(normalized) ?? [];
		if (!entries.some((c) => c.providerId === entry.providerId && c.modelId === entry.modelId)) {
			entries.push(entry);
			catalog.normalized.set(normalized, entries);
		}
	}
}

export function buildCostCatalog(providers: Record<string, unknown>): CostCatalog {
	const catalog = emptyCostCatalog();
	for (const [providerId, providerValue] of Object.entries(providers)) {
		const models = asRecord(asRecord(providerValue)?.models);
		if (!models) {
			continue;
		}
		for (const [modelId, modelValue] of Object.entries(models)) {
			const model = asRecord(modelValue) as ModelsDevModelPayload | undefined;
			const standard = parseModelsDevCost(model?.cost);
			if (!standard) {
				continue;
			}
			const fast = parseModelsDevCost(model?.experimental?.modes?.fast?.cost);
			addModel(catalog, { providerId, modelId, standard, ...(fast ? { fast } : {}) });
		}
	}
	return catalog;
}

export function isUsableProviderMap(value: Record<string, unknown>): boolean {
	return Object.values(value).some((providerValue) => asRecord(asRecord(providerValue)?.models) !== undefined);
}

export function modelsDevCachePath(agentDir: string): string {
	return join(agentDir, "tmp", "models-dev-cache.json");
}

interface ModelsDevCacheFile {
	timestamp: number;
	providers: Record<string, unknown>;
}

function readCache(path: string): ModelsDevCacheFile | undefined {
	try {
		const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed || typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) {
			return undefined;
		}
		const providers = asRecord(parsed.providers);
		if (!providers || !isUsableProviderMap(providers)) {
			return undefined;
		}
		return { timestamp: parsed.timestamp, providers };
	} catch {
		return undefined;
	}
}

function writeCache(path: string, providers: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ timestamp: Date.now(), providers } satisfies ModelsDevCacheFile), "utf8");
	} catch {
		// A read-only filesystem must not break model registration.
	}
}

/**
 * Load the models.dev cost catalog, preferring a fresh on-disk cache.
 *
 * A stale cache is still used when the refresh fails, so pricing degrades to
 * slightly old rates rather than disappearing.
 */
export async function loadCostCatalog(
	agentDir: string,
	options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
): Promise<CostCatalog> {
	const path = modelsDevCachePath(agentDir);
	const cached = readCache(path);

	if (!options.forceRefresh && cached && Date.now() - cached.timestamp < MODELS_DEV_CACHE_TTL_MS) {
		return buildCostCatalog(cached.providers);
	}

	const timeout = AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		const response = await fetch(MODELS_DEV_URL, { signal });
		if (response.ok) {
			const providers = asRecord(await response.json());
			if (providers && isUsableProviderMap(providers)) {
				writeCache(path, providers);
				return buildCostCatalog(providers);
			}
		}
	} catch (error) {
		log.debug("models.dev refresh failed", error instanceof Error ? error.message : String(error));
	}

	return cached ? buildCostCatalog(cached.providers) : emptyCostCatalog();
}

function cloneCost(cost: Cost): Cost {
	return {
		...cost,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

function preferredProviders(modelId: string): string[] {
	const raw = modelId.trim().toLowerCase();
	const namespace = raw.match(NAMESPACE_PREFIX)?.[1]?.toLowerCase();
	const stripped = stripNamespace(raw);
	const family = FAMILY_PREFERENCES.find(({ pattern }) => pattern.test(stripped))?.providers ?? [];
	return Array.from(new Set([...(namespace ? [namespace] : []), ...family]));
}

function sameVariants(entries: CostEntry[]): boolean {
	const fingerprints = new Set(entries.map((e) => JSON.stringify({ standard: e.standard, fast: e.fast })));
	return fingerprints.size === 1;
}

/** Pick a single entry, or `undefined` when several resellers disagree. */
function selectEntry(entries: CostEntry[], modelId: string): CostEntry | undefined {
	if (entries.length === 0) {
		return undefined;
	}
	for (const providerId of preferredProviders(modelId)) {
		const match = entries.find((entry) => entry.providerId === providerId);
		if (match) {
			return match;
		}
	}
	if (entries.length === 1 || sameVariants(entries)) {
		return [...entries].sort((a, b) => a.providerId.localeCompare(b.providerId))[0];
	}
	// Refuse to guess when the source is ambiguous; zero cost is more honest.
	return undefined;
}

function findEntry(modelId: string, catalog: CostCatalog): CostEntry | undefined {
	const rawId = modelId.trim().toLowerCase();
	for (const key of new Set([rawId, stripNamespace(rawId)])) {
		const match = selectEntry(catalog.exact.get(key) ?? [], modelId);
		if (match) {
			return match;
		}
	}
	const normalized = normalizeKey(rawId);
	return normalized ? selectEntry(catalog.normalized.get(normalized) ?? [], modelId) : undefined;
}

export interface MatchCostOptions {
	/** Use the provider's fast service-tier rates when models.dev publishes them. */
	fast?: boolean;
	/** An explicit override always wins over the catalog. */
	override?: Cost;
}

export function matchCost(modelId: string, catalog: CostCatalog, options: MatchCostOptions = {}): Cost {
	if (options.override) {
		return cloneCost(options.override);
	}

	const rawId = modelId.trim().toLowerCase();
	const lookupIds = [rawId, ...(PRICE_ALIASES[rawId] ?? []).map((id) => id.toLowerCase())];
	for (const lookupId of lookupIds) {
		const entry = findEntry(lookupId, catalog);
		if (entry) {
			return cloneCost(options.fast && entry.fast ? entry.fast : entry.standard);
		}
	}
	return { ...ZERO_COST };
}

/** Format USD for a `Cost` given the token counts of one request. */
export function computeCost(
	cost: Cost,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
	// Clamp every bucket: a provider or a replayed transcript can report a negative
	// delta, and a negative cost is never meaningful.
	const input = Math.max(0, usage.input);
	const output = Math.max(0, usage.output);
	const cacheRead = Math.max(0, usage.cacheRead);
	const cacheWrite = Math.max(0, usage.cacheWrite);

	const inputTokens = input + cacheRead + cacheWrite;
	const tiers = cost.tiers ?? [];
	let rates: Cost = cost;
	if (tiers.length > 0) {
		const applicable = tiers
			.filter((tier) => inputTokens > tier.inputTokensAbove)
			.sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
		if (applicable) {
			rates = applicable;
		}
	}
	return (
		(input * rates.input + output * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) /
		1_000_000
	);
}
