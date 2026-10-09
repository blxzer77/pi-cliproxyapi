/**
 * Declarative model overrides.
 *
 * CLIProxyAPI's catalog is derived from whatever upstream client metadata the
 * operator configured, so a single field can be missing, generic, or simply
 * wrong for the route behind it. Editing the extension source or hand-patching
 * the cached catalog is not maintainable, and the cache is rewritten on every
 * refresh anyway.
 *
 * This module reads `~/.pi/agent/cliproxyapi-overrides.json` and applies it on
 * top of the freshly fetched catalog, so a correction survives every refresh.
 *
 * Precedence: `models[id]` > last matching entry of `patterns` > catalog value.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, overridesPath, writeJsonAtomic } from "./config.ts";
import { log } from "./log.ts";
import type { Cost, CostTier } from "./pricing.ts";

/** pi thinking levels, in the order the UI cycles through them. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

/** How to pick a context window from a catalog entry with both fields. */
export type ContextWindowSource = "context_window" | "max_context_window";

/** Where unlisted models come from once their grace period ends. */
export type UnlistedPolicy = "drop" | "retain";

export interface OverrideDefaults {
	/** Which catalog field feeds pi's `contextWindow`. Default `context_window`. */
	contextWindowSource?: ContextWindowSource;
	/** Applied when the catalog has no usable context window. */
	contextWindow?: number;
	/** Applied when the catalog has no usable output limit. */
	maxTokens?: number;
	/** Hide models with `visibility: "hide"` in the catalog. Default true. */
	respectVisibility?: boolean;
	/**
	 * Keep a model that vanished from the catalog for this long before dropping it.
	 * Guards against a transient upstream catalog blip. Default 24h; `0` drops immediately.
	 */
	unlistedGraceMs?: number;
	/** What happens after the grace period. Default `drop`. */
	unlistedPolicy?: UnlistedPolicy;
	/** Fetch models.dev rates. Default true. */
	pricing?: boolean;
}

export interface ModelOverride {
	name?: string;
	/** Absolute context window in tokens. */
	contextWindow?: number;
	/** Maximum output tokens. */
	maxTokens?: number;
	reasoning?: boolean;
	/** pi thinking levels this model actually supports. Others are marked unsupported. */
	thinkingLevels?: string[];
	/** Raw escape hatch: maps pi thinking levels to provider values (null = unsupported). */
	thinkingLevelMap?: ThinkingLevelMap;
	input?: Array<"text" | "image">;
	/** USD per million tokens. */
	cost?: Partial<Cost>;
	/** Override the models.dev lookup id. */
	pricingModelId?: string;
	/** Whether CLIProxyAPI advertises a priority service tier for this model. */
	fast?: boolean;
	/** Never drop this model when it leaves the catalog, and never warn about it. */
	pin?: boolean;
	/** Hide this model from the picker. */
	hidden?: boolean;
	/** Show a model the catalog marks `visibility: "hide"`. */
	show?: boolean;
	headers?: Record<string, string>;
	samplingParams?: Record<string, unknown>;
}

export interface OverridePattern extends ModelOverride {
	/** Regular expression tested against the model id. */
	match: string;
}

export interface OverridesFile {
	defaults?: OverrideDefaults;
	/** Keyed by exact model id (case-insensitive). */
	models?: Record<string, ModelOverride>;
	/** Applied in order; a later matching pattern overrides an earlier one. */
	patterns?: OverridePattern[];
}

export interface CompiledOverrides {
	defaults: Required<
		Pick<
			OverrideDefaults,
			"contextWindowSource" | "respectVisibility" | "unlistedGraceMs" | "unlistedPolicy" | "pricing"
		>
	> &
		OverrideDefaults;
	models: Map<string, ModelOverride>;
	patterns: Array<{ source: OverridePattern; regex: RegExp }>;
	/** Non-fatal problems worth surfacing through `/cpa-doctor`. */
	problems: string[];
	path: string;
	found: boolean;
}

export const DEFAULT_UNLISTED_GRACE_MS = 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function optionalNumber(value: unknown, field: string, problems: string[]): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		problems.push(`${field} must be a positive number`);
		return undefined;
	}
	return value;
}

function optionalBoolean(value: unknown, field: string, problems: string[]): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		problems.push(`${field} must be a boolean`);
		return undefined;
	}
	return value;
}

function optionalString(value: unknown, field: string, problems: string[]): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !value.trim()) {
		problems.push(`${field} must be a non-empty string`);
		return undefined;
	}
	return value.trim();
}

function optionalStringArray(value: unknown, field: string, problems: string[]): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		problems.push(`${field} must be an array of strings`);
		return undefined;
	}
	return value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

function parseCost(value: unknown, field: string, problems: string[]): Partial<Cost> | undefined {
	const source = asRecord(value);
	if (!source) {
		if (value !== undefined) {
			problems.push(`${field} must be an object`);
		}
		return undefined;
	}
	const cost: Partial<Cost> = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const raw =
			source[key] ?? source[key === "cacheRead" ? "cache_read" : key === "cacheWrite" ? "cache_write" : key];
		if (raw === undefined) {
			continue;
		}
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
			problems.push(`${field}.${key} must be a non-negative number`);
			continue;
		}
		cost[key] = raw;
	}
	if (Array.isArray(source.tiers)) {
		const tiers: CostTier[] = [];
		for (const [index, rawTier] of source.tiers.entries()) {
			const tierSource = asRecord(rawTier);
			const threshold =
				tierSource &&
				optionalNumber(tierSource.inputTokensAbove, `${field}.tiers[${index}].inputTokensAbove`, problems);
			if (!tierSource || threshold === undefined) {
				continue;
			}
			tiers.push({
				input: typeof tierSource.input === "number" ? tierSource.input : (cost.input ?? 0),
				output: typeof tierSource.output === "number" ? tierSource.output : (cost.output ?? 0),
				cacheRead: typeof tierSource.cacheRead === "number" ? tierSource.cacheRead : (cost.cacheRead ?? 0),
				cacheWrite: typeof tierSource.cacheWrite === "number" ? tierSource.cacheWrite : (cost.cacheWrite ?? 0),
				inputTokensAbove: threshold,
			});
		}
		if (tiers.length > 0) {
			cost.tiers = tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
		}
	}
	return Object.keys(cost).length > 0 ? cost : undefined;
}

function parseThinkingLevelMap(value: unknown, field: string, problems: string[]): ThinkingLevelMap | undefined {
	const source = asRecord(value);
	if (!source) {
		if (value !== undefined) {
			problems.push(`${field} must be an object`);
		}
		return undefined;
	}
	const map: ThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) {
		const raw = source[level];
		if (raw === undefined) {
			continue;
		}
		if (raw === null) {
			map[level] = null;
		} else if (typeof raw === "string" && raw.trim()) {
			map[level] = raw.trim();
		} else {
			problems.push(`${field}.${level} must be a string or null`);
		}
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

function parseHeaderMap(value: unknown, field: string, problems: string[]): Record<string, string> | undefined {
	const source = asRecord(value);
	if (!source) {
		if (value !== undefined) {
			problems.push(`${field} must be an object`);
		}
		return undefined;
	}
	const headers: Record<string, string> = {};
	for (const [key, raw] of Object.entries(source)) {
		if (typeof raw !== "string" || !raw.trim()) {
			problems.push(`${field}.${key} must be a non-empty string`);
			continue;
		}
		headers[key] = raw;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseModelOverride(raw: unknown, prefix: string, problems: string[]): ModelOverride | undefined {
	const source = asRecord(raw);
	if (!source) {
		problems.push(`${prefix} must be an object`);
		return undefined;
	}
	const override: ModelOverride = {
		name: optionalString(source.name, `${prefix}.name`, problems),
		contextWindow: optionalNumber(source.contextWindow, `${prefix}.contextWindow`, problems),
		maxTokens: optionalNumber(source.maxTokens, `${prefix}.maxTokens`, problems),
		reasoning: optionalBoolean(source.reasoning, `${prefix}.reasoning`, problems),
		thinkingLevels: optionalStringArray(source.thinkingLevels, `${prefix}.thinkingLevels`, problems),
		thinkingLevelMap: parseThinkingLevelMap(source.thinkingLevelMap, `${prefix}.thinkingLevelMap`, problems),
		cost: parseCost(source.cost, `${prefix}.cost`, problems),
		pricingModelId: optionalString(source.pricingModelId, `${prefix}.pricingModelId`, problems),
		fast: optionalBoolean(source.fast, `${prefix}.fast`, problems),
		pin: optionalBoolean(source.pin, `${prefix}.pin`, problems),
		hidden: optionalBoolean(source.hidden, `${prefix}.hidden`, problems),
		show: optionalBoolean(source.show, `${prefix}.show`, problems),
		headers: parseHeaderMap(source.headers, `${prefix}.headers`, problems),
		samplingParams: asRecord(source.samplingParams),
	};
	if (source.input !== undefined) {
		const input = optionalStringArray(source.input, `${prefix}.input`, problems)?.filter(
			(entry): entry is "text" | "image" => entry === "text" || entry === "image",
		);
		if (input && input.length > 0) {
			override.input = input;
		}
	}
	for (const key of Object.keys(override) as Array<keyof ModelOverride>) {
		if (override[key] === undefined) {
			delete override[key];
		}
	}
	return override;
}

function parseDefaults(raw: unknown, problems: string[]): OverrideDefaults {
	const source = asRecord(raw);
	if (!source) {
		return {};
	}
	if (
		source.unlistedGraceMs !== undefined &&
		(typeof source.unlistedGraceMs !== "number" ||
			!Number.isFinite(source.unlistedGraceMs) ||
			source.unlistedGraceMs < 0)
	) {
		problems.push("defaults.unlistedGraceMs must be a non-negative number");
	}
	const unlistedGraceMs =
		typeof source.unlistedGraceMs === "number" &&
		Number.isFinite(source.unlistedGraceMs) &&
		source.unlistedGraceMs >= 0
			? source.unlistedGraceMs
			: undefined;
	const defaults: OverrideDefaults = {
		contextWindowSource:
			source.contextWindowSource === "context_window" || source.contextWindowSource === "max_context_window"
				? source.contextWindowSource
				: undefined,
		contextWindow: optionalNumber(source.contextWindow, "defaults.contextWindow", problems),
		maxTokens: optionalNumber(source.maxTokens, "defaults.maxTokens", problems),
		respectVisibility: optionalBoolean(source.respectVisibility, "defaults.respectVisibility", problems),
		unlistedGraceMs,
		unlistedPolicy:
			source.unlistedPolicy === "drop" || source.unlistedPolicy === "retain" ? source.unlistedPolicy : undefined,
		pricing: optionalBoolean(source.pricing, "defaults.pricing", problems),
	};
	if (source.contextWindowSource !== undefined && defaults.contextWindowSource === undefined) {
		problems.push('defaults.contextWindowSource must be "context_window" or "max_context_window"');
	}
	if (source.unlistedPolicy !== undefined && defaults.unlistedPolicy === undefined) {
		problems.push('defaults.unlistedPolicy must be "drop" or "retain"');
	}
	return defaults;
}

export function compileOverrides(raw: unknown, path: string): CompiledOverrides {
	const problems: string[] = [];
	const source = asRecord(raw);
	if (!source) {
		if (raw !== undefined) {
			problems.push("root must be a JSON object");
		}
		return {
			defaults: {
				contextWindowSource: "context_window",
				respectVisibility: true,
				unlistedGraceMs: DEFAULT_UNLISTED_GRACE_MS,
				unlistedPolicy: "drop",
				pricing: true,
			},
			models: new Map(),
			patterns: [],
			problems,
			path,
			found: raw !== undefined,
		};
	}

	const defaults = parseDefaults(source.defaults, problems);
	const models = new Map<string, ModelOverride>();
	for (const [id, value] of Object.entries(asRecord(source.models) ?? {})) {
		const override = parseModelOverride(value, `models["${id}"]`, problems);
		if (override) {
			models.set(id.trim().toLowerCase(), override);
		}
	}

	const patterns: Array<{ source: OverridePattern; regex: RegExp }> = [];
	if (source.patterns !== undefined) {
		if (!Array.isArray(source.patterns)) {
			problems.push("patterns must be an array");
		} else {
			for (const [index, entry] of source.patterns.entries()) {
				const match = optionalString(asRecord(entry)?.match, `patterns[${index}].match`, problems);
				if (!match) {
					continue;
				}
				const override = parseModelOverride(entry, `patterns[${index}]`, problems);
				if (!override) {
					continue;
				}
				try {
					patterns.push({ source: { ...override, match }, regex: new RegExp(match, "i") });
				} catch (error) {
					problems.push(`patterns[${index}].match is not a valid regular expression: ${String(error)}`);
				}
			}
		}
	}

	return {
		defaults: {
			contextWindowSource: defaults.contextWindowSource ?? "context_window",
			respectVisibility: defaults.respectVisibility ?? true,
			unlistedGraceMs: defaults.unlistedGraceMs ?? DEFAULT_UNLISTED_GRACE_MS,
			unlistedPolicy: defaults.unlistedPolicy ?? "drop",
			pricing: defaults.pricing ?? true,
			...defaults,
		},
		models,
		patterns,
		problems,
		path,
		found: raw !== undefined,
	};
}

export function emptyOverrides(path: string): CompiledOverrides {
	return compileOverrides(undefined, path);
}

/** Read and compile the overrides file. Never throws. */
export function loadOverrides(agentDir: string): CompiledOverrides {
	let path: string;
	try {
		path = overridesPath(agentDir, loadConfig(agentDir));
	} catch {
		path = join(agentDir, "cliproxyapi-overrides.json");
	}

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyOverrides(path);
		}
		log.warn(`cannot read overrides file ${path}: ${String(error)}`);
		return emptyOverrides(path);
	}

	try {
		const compiled = compileOverrides(JSON.parse(raw), path);
		for (const problem of compiled.problems) {
			log.warn(`override problem: ${problem}`);
		}
		return compiled;
	} catch (error) {
		log.warn(`overrides file ${path} is not valid JSON: ${String(error)}`);
		return emptyOverrides(path);
	}
}

/**
 * Merge override layers. `next` wins on conflict; `base` fills gaps and supplies
 * per-field fallbacks for `cost`, `headers` and `samplingParams`.
 */
function mergeOverride(base: ModelOverride, next: ModelOverride): ModelOverride {
	const merged: ModelOverride = { ...base };
	for (const key of Object.keys(next) as Array<keyof ModelOverride>) {
		const value = next[key];
		if (value === undefined) {
			continue;
		}
		if (key === "cost" && base.cost) {
			merged.cost = { ...base.cost, ...(value as Partial<Cost>) };
			if (base.cost.tiers && !(value as Partial<Cost>).tiers) {
				merged.cost.tiers = base.cost.tiers;
			}
			continue;
		}
		if (key === "headers" && base.headers) {
			merged.headers = { ...base.headers, ...(value as Record<string, string>) };
			continue;
		}
		if (key === "samplingParams" && base.samplingParams) {
			merged.samplingParams = { ...base.samplingParams, ...(value as Record<string, unknown>) };
			continue;
		}
		(merged as Record<string, unknown>)[key] = value;
	}
	return merged;
}

/**
 * Resolve the effective override for one model id.
 *
 * Precedence: an exact `models[id]` entry beats every pattern. Among patterns a
 * later match wins, so a general rule can be written first and refined after.
 */
export function resolveOverride(overrides: CompiledOverrides, modelId: string): ModelOverride | undefined {
	const id = modelId.trim().toLowerCase();

	let fromPatterns: ModelOverride | undefined;
	for (const { source, regex } of overrides.patterns) {
		if (!regex.test(id)) {
			continue;
		}
		fromPatterns = fromPatterns ? mergeOverride(fromPatterns, source) : source;
	}

	const exact = overrides.models.get(id);
	if (!exact) {
		return fromPatterns;
	}
	return fromPatterns ? mergeOverride(fromPatterns, exact) : exact;
}

/**
 * Turn a supported-levels list into pi's `thinkingLevelMap`.
 *
 * `off` maps to the provider's own "none" level when the catalog advertises one;
 * every level the model does not support is `null` so the picker hides it.
 */
export function buildThinkingLevelMap(levels: string[]): ThinkingLevelMap | undefined {
	if (levels.length === 0) {
		return undefined;
	}
	const supported = new Set(levels.map((level) => level.trim().toLowerCase()).filter(Boolean));
	const map: ThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) {
		if (level === "off") {
			map.off = supported.has("none") ? "none" : null;
			continue;
		}
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

/** The override template written by `/cpa-overrides init`. */
export function buildStarterOverrides(
	entries: Array<{ id: string; contextWindow: number; maxTokens: number }>,
): OverridesFile {
	return {
		defaults: {
			contextWindowSource: "context_window",
			respectVisibility: true,
			unlistedGraceMs: DEFAULT_UNLISTED_GRACE_MS,
			unlistedPolicy: "drop",
			pricing: true,
		},
		models: Object.fromEntries(
			entries.map((entry) => [
				entry.id,
				{ contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, pin: true } satisfies ModelOverride,
			]),
		),
		patterns: [],
	};
}

/** Persist a rendered overrides file atomically. Returns the path written. */
export function saveOverridesFile(agentDir: string, file: OverridesFile): string {
	const path = overridesPath(agentDir, loadConfig(agentDir));
	writeJsonAtomic(path, file);
	return path;
}

/**
 * Set or clear one boolean field of one model's override entry, editing the file in
 * place. Every other key, including entries this module does not know about, is
 * preserved. Matching is case-insensitive and reuses an existing key's casing.
 *
 * `null` deletes the field (back to the catalog or pattern value); `false` writes an
 * explicit false, which is how a pattern-provided value is switched off.
 */
export function updateModelOverride(
	agentDir: string,
	modelId: string,
	field: "pin" | "hidden" | "show",
	value: boolean | null,
): string {
	const path = overridesPath(agentDir, loadConfig(agentDir));
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			raw = parsed as Record<string, unknown>;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	const models = asRecord(raw.models) ?? {};
	const existingKey = Object.keys(models).find((key) => key.trim().toLowerCase() === modelId.trim().toLowerCase());
	const key = existingKey ?? modelId.trim();
	const entry = asRecord(models[key]) ?? {};
	if (value === null) {
		delete entry[field];
	} else {
		entry[field] = value;
	}
	models[key] = entry;
	raw.models = models;
	writeJsonAtomic(path, raw);
	return path;
}
