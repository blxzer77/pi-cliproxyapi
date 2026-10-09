/**
 * Shared fixtures modelled on real CLIProxyAPI catalog responses.
 *
 * Two shapes matter: a Codex route such as `gpt-6.1-sol` that carries the full
 * upstream client metadata, and a relayed third-party model such as `space-bunny`
 * that carries only a handful of generic fields.
 */

import type { CpaModel } from "../extensions/catalog.ts";

export const CODEX_MODEL: CpaModel = {
	slug: "gpt-6.1-sol",
	display_name: "GPT 6.1 Sol",
	description: "Codex route",
	context_window: 272_000,
	max_context_window: 872_000,
	max_tokens: 128_000,
	auto_compact_token_limit: null,
	default_reasoning_level: "low",
	default_verbosity: "medium",
	input_modalities: ["text", "image"],
	supported_reasoning_levels: [
		{ effort: "low" },
		{ effort: "medium" },
		{ effort: "high" },
		{ effort: "xhigh" },
		{ effort: "max" },
		{ effort: "ultra" },
	],
	default_service_tier: null,
	service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
	additional_speed_tiers: [],
	visibility: "list",
	tool_mode: "code_mode_only",
	supports_parallel_tool_calls: true,
	prefer_websockets: true,
	truncation_policy: { limit: 10_000, mode: "tokens" },
	available_in_plans: ["plus", "pro"],
};

/** A relayed model with no output limit and a regionally wrong context window. */
export const RELAY_MODEL: CpaModel = {
	slug: "space-bunny",
	display_name: "space-bunny",
	context_window: 272_000,
	max_context_window: 272_000,
	input_modalities: ["text", "image"],
	supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
	service_tiers: [],
	visibility: "list",
};

/** A model exposed only through an older field name. */
export const LEGACY_LIMIT_MODEL: CpaModel = {
	slug: "legacy-relay",
	display_name: "Legacy Relay",
	context_window: 128_000,
	max_output_tokens: 32_000,
	input_modalities: ["text"],
	supported_reasoning_levels: [],
	visibility: "list",
};

export const HIDDEN_MODEL: CpaModel = {
	slug: "internal-embed",
	display_name: "Internal Embedding",
	context_window: 8_192,
	input_modalities: ["text"],
	service_tiers: [],
	visibility: "hide",
};

export const CATALOG: CpaModel[] = [CODEX_MODEL, RELAY_MODEL, LEGACY_LIMIT_MODEL, HIDDEN_MODEL];

/** A minimal models.dev document with one unambiguous and one ambiguous model. */
export const MODELS_DEV_PROVIDERS: Record<string, unknown> = {
	openai: {
		models: {
			"gpt-6.1-sol": {
				cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
				experimental: { modes: { fast: { cost: { input: 2.5, output: 20 } } } },
			},
			"tiered-model": {
				cost: {
					input: 1,
					output: 2,
					tiers: [{ tier: { type: "context", size: 200_000 }, input: 2, output: 4 }],
				},
			},
		},
	},
	anthropic: {
		models: {
			"claude-sonnet-5-5": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
		},
	},
	// Two resellers publish the same id at different rates: the lookup must refuse.
	resellerA: { models: { "ambiguous-model": { cost: { input: 1, output: 2 } } } },
	resellerB: { models: { "ambiguous-model": { cost: { input: 9, output: 18 } } } },
	deepseek: {
		models: {
			"deepseek-v4.1-flash": { cost: { input: 0.28, output: 0.42 } },
		},
	},
	// A generic reseller that also sells the deepseek model at a different rate.
	relayHub: {
		models: {
			"deepseek-v4.1-flash": { cost: { input: 5, output: 9 } },
		},
	},
};
