import { describe, expect, it } from "vitest";
import { type CatalogModel, mapCatalog, reconcileCatalog } from "../extensions/catalog.ts";
import { compileOverrides, type OverridesFile } from "../extensions/overrides.ts";
import { buildCostCatalog, emptyCostCatalog } from "../extensions/pricing.ts";
import {
	CATALOG,
	CODEX_MODEL,
	HIDDEN_MODEL,
	LEGACY_LIMIT_MODEL,
	MODELS_DEV_PROVIDERS,
	RELAY_MODEL,
} from "./fixtures.ts";

const costCatalog = buildCostCatalog(MODELS_DEV_PROVIDERS);

function mapWith(file: OverridesFile | undefined, models = CATALOG): CatalogModel[] {
	return mapCatalog(models, {
		overrides: compileOverrides(file, "test.json"),
		costCatalog,
	});
}

function find(models: CatalogModel[], id: string): CatalogModel {
	const found = models.find((model) => model.meta.id === id);
	if (!found) {
		throw new Error(`model ${id} was not mapped`);
	}
	return found;
}

describe("toCatalogModel limits", () => {
	it("prefers context_window by default and records the other value", () => {
		const model = find(mapWith(undefined), "gpt-6.1-sol");
		expect(model.config.contextWindow).toBe(272_000);
		expect(model.meta.catalog.maxContextWindow).toBe(872_000);
	});

	it("can take max_context_window instead", () => {
		const models = mapWith({ defaults: { contextWindowSource: "max_context_window" } });
		expect(find(models, "gpt-6.1-sol").config.contextWindow).toBe(872_000);
	});

	it("falls back through max_tokens, max_output_tokens and the default", () => {
		const models = mapWith(undefined);
		expect(find(models, "gpt-6.1-sol").config.maxTokens).toBe(128_000);
		expect(find(models, "legacy-relay").config.maxTokens).toBe(32_000);
		// space-bunny advertises no output limit at all.
		expect(find(models, "space-bunny").config.maxTokens).toBe(16_384);
	});

	it("lets an override replace limits the catalog gets wrong", () => {
		const models = mapWith({
			models: {
				"space-bunny": { contextWindow: 1_048_576, maxTokens: 524_288, pin: true },
				"gpt-6.1-sol": { contextWindow: 372_000 },
			},
		});
		const relay = find(models, "space-bunny");
		expect(relay.config.contextWindow).toBe(1_048_576);
		expect(relay.config.maxTokens).toBe(524_288);
		expect(relay.meta.listing).toBe("pinned");
		// The catalog values are still reported so drift stays visible.
		expect(relay.meta.catalog.contextWindow).toBe(272_000);
		expect(find(models, "gpt-6.1-sol").config.contextWindow).toBe(372_000);
	});
});

describe("toCatalogModel reasoning and input", () => {
	it("derives reasoning and the thinking ladder from the catalog", () => {
		const model = find(mapWith(undefined), "gpt-6.1-sol");
		expect(model.config.reasoning).toBe(true);
		expect(model.config.thinkingLevelMap).toMatchObject({ low: "low", ultra: "ultra", minimal: null });
	});

	it("reports a non-reasoning model as such", () => {
		const model = find(mapWith(undefined), "legacy-relay");
		// No supported levels at all: the model is not a reasoning model.
		expect(model.config.reasoning).toBe(false);
		expect(model.config.thinkingLevelMap).toBeUndefined();
	});

	it("restricts the ladder when the proxy advertises more than the model supports", () => {
		const models = mapWith({ models: { "space-bunny": { thinkingLevels: ["low", "high"] } } });
		expect(find(models, "space-bunny").config.thinkingLevelMap).toMatchObject({
			low: "low",
			high: "high",
			medium: null,
			xhigh: null,
		});
	});

	it("always includes text and keeps images when offered", () => {
		expect(find(mapWith(undefined), "gpt-6.1-sol").config.input).toEqual(["text", "image"]);
		expect(find(mapWith(undefined), "legacy-relay").config.input).toEqual(["text"]);
	});
});

describe("toCatalogModel visibility and passthrough", () => {
	it("drops models the catalog hides", () => {
		expect(mapWith(undefined).some((model) => model.meta.id === "internal-embed")).toBe(false);
	});

	it("can surface a hidden model on request", () => {
		const models = mapWith({ models: { "internal-embed": { show: true } } });
		expect(models.some((model) => model.meta.id === "internal-embed")).toBe(true);
	});

	it("can hide a listed model", () => {
		const models = mapWith({ models: { "space-bunny": { hidden: true } } });
		expect(find(models, "space-bunny").meta.listing).toBe("hidden");
	});

	it("preserves catalog fields pi cannot act on", () => {
		const extras = find(mapWith(undefined), "gpt-6.1-sol").meta.extras;
		expect(extras).toMatchObject({
			tool_mode: "code_mode_only",
			supports_parallel_tool_calls: true,
			prefer_websockets: true,
			default_reasoning_level: "low",
			truncation_policy: { limit: 10_000, mode: "tokens" },
			available_in_plans: ["plus", "pro"],
		});
	});

	it("marks Fast capability from service_tiers only", () => {
		const models = mapWith(undefined);
		expect(find(models, "gpt-6.1-sol").meta.fast).toBe(true);
		// additional_speed_tiers alone is not a priority tier.
		expect(find(models, "space-bunny").meta.fast).toBe(false);
	});
});

describe("toCatalogModel cost", () => {
	it("takes an override when present and reports the source", () => {
		const models = mapWith({ models: { "gpt-6.1-sol": { cost: { input: 9, output: 90 } } } });
		const model = find(models, "gpt-6.1-sol");
		expect(model.config.cost).toMatchObject({ input: 9, output: 90 });
		expect(model.meta.costSource).toBe("override");
	});

	it("falls back to models.dev for a known model", () => {
		const model = find(mapWith(undefined), "gpt-6.1-sol");
		expect(model.config.cost).toMatchObject({ input: 1.25, output: 10 });
		expect(model.meta.costSource).toBe("models.dev");
	});

	it("reports no price rather than guessing", () => {
		const model = find(mapWith(undefined), "space-bunny");
		expect(model.config.cost).toMatchObject({ input: 0, output: 0 });
		expect(model.meta.costSource).toBe("none");
	});

	it("skips pricing entirely when disabled", () => {
		const models = mapWith({ defaults: { pricing: false } });
		expect(find(models, "gpt-6.1-sol").config.cost).toMatchObject({ input: 0, output: 0 });
	});

	it("still prices a disabled catalog when an explicit override exists", () => {
		const models = mapWith({
			defaults: { pricing: false },
			models: { "space-bunny": { cost: { input: 1, output: 2 } } },
		});
		const model = find(models, "space-bunny");
		expect(model.config.cost).toMatchObject({ input: 1, output: 2 });
		expect(model.meta.costSource).toBe("override");
	});
});

describe("reconcileCatalog", () => {
	const overrides = compileOverrides(undefined, "test.json");
	const now = 1_700_000_000_000;

	function previous(): CatalogModel[] {
		return mapCatalog([CODEX_MODEL, RELAY_MODEL, LEGACY_LIMIT_MODEL], {
			overrides,
			costCatalog: emptyCostCatalog(),
			now,
		});
	}

	it("keeps a freshly listed model and clears its unlisted state", () => {
		const prior = previous().map((model) =>
			model.meta.id === "space-bunny"
				? {
						...model,
						meta: { ...model.meta, listed: false, listing: "unlisted" as const, unlistedSince: now - 1000 },
					}
				: model,
		);
		const result = reconcileCatalog(prior, prior, overrides, now);
		expect(result.models).toHaveLength(prior.length);
		expect(result.retained).toEqual([]);
	});

	it("retains a model inside the grace period as unlisted", () => {
		const fresh = mapCatalog([CODEX_MODEL], { overrides, costCatalog: emptyCostCatalog(), now });
		const result = reconcileCatalog(fresh, previous(), overrides, now);
		const unlisted = result.models.filter((model) => model.meta.listing === "unlisted").map((model) => model.meta.id);
		expect(unlisted.sort()).toEqual(["legacy-relay", "space-bunny"]);
		expect(result.dropped).toEqual([]);
	});

	it("drops a model after the grace period expires", () => {
		const fresh = mapCatalog([CODEX_MODEL], { overrides, costCatalog: emptyCostCatalog(), now });
		// `previous` was fetched at `now`, and the next refresh happens 25h later.
		const result = reconcileCatalog(fresh, previous(), overrides, now + 25 * 60 * 60 * 1000, now);
		expect(result.dropped.sort()).toEqual(["legacy-relay", "space-bunny"]);
		expect(result.models.map((model) => model.meta.id)).toEqual(["gpt-6.1-sol"]);
	});

	it("never drops or flags a pinned model", () => {
		const pinned = compileOverrides({ models: { "space-bunny": { pin: true } } }, "test.json");
		const fresh = mapCatalog([CODEX_MODEL], { overrides: pinned, costCatalog: emptyCostCatalog(), now });
		const result = reconcileCatalog(fresh, previous(), pinned, now + 365 * 24 * 60 * 60 * 1000, now);
		const model = result.models.find((entry) => entry.meta.id === "space-bunny");
		expect(model?.meta.listing).toBe("pinned");
		expect(model?.meta.listed).toBe(false);
		expect(model?.meta.pinned).toBe(true);
		expect(result.dropped).toEqual(["legacy-relay"]);
	});

	it("honours the retain policy over the grace period", () => {
		const retain = compileOverrides({ defaults: { unlistedPolicy: "retain" } }, "test.json");
		const fresh = mapCatalog([CODEX_MODEL], { overrides: retain, costCatalog: emptyCostCatalog(), now });
		const result = reconcileCatalog(fresh, previous(), retain, now + 365 * 24 * 60 * 60 * 1000, now);
		expect(result.dropped).toEqual([]);
		expect(result.models).toHaveLength(3);
	});

	it("starts the grace period at the fetch that last listed the model", () => {
		const firstMiss = reconcileCatalog(
			mapCatalog([CODEX_MODEL], { overrides, costCatalog: emptyCostCatalog(), now }),
			previous(),
			overrides,
			now + 1000,
			now,
		);
		expect(firstMiss.retained.map((model) => model.meta.id).sort()).toEqual(["legacy-relay", "space-bunny"]);
		// The baseline is the last listing, not the moment the absence was noticed.
		expect(firstMiss.retained[0]?.meta.unlistedSince).toBe(now);

		// A second miss one hour later still has 23h of grace left.
		const secondMiss = reconcileCatalog(
			mapCatalog([CODEX_MODEL], { overrides, costCatalog: emptyCostCatalog(), now }),
			firstMiss.models,
			overrides,
			now + 60 * 60 * 1000,
			now + 1000,
		);
		expect(secondMiss.dropped).toEqual([]);
		expect(secondMiss.retained[0]?.meta.unlistedSince).toBe(now);

		// ...and by 25h it is gone.
		const thirdMiss = reconcileCatalog(
			mapCatalog([CODEX_MODEL], { overrides, costCatalog: emptyCostCatalog(), now }),
			secondMiss.models,
			overrides,
			now + 25 * 60 * 60 * 1000,
			now + 60 * 60 * 1000,
		);
		expect(thirdMiss.dropped.sort()).toEqual(["legacy-relay", "space-bunny"]);
	});
});

describe("toCatalogModel edge cases", () => {
	it("skips an entry with no usable id", () => {
		const models = mapCatalog([{ display_name: "nameless" }, HIDDEN_MODEL], {
			overrides: compileOverrides(undefined, "test.json"),
			costCatalog: emptyCostCatalog(),
		});
		expect(models).toEqual([]);
	});

	it("falls back to the id when the catalog has no display name", () => {
		const models = mapCatalog([{ slug: "bare-id" }], {
			overrides: compileOverrides(undefined, "test.json"),
			costCatalog: emptyCostCatalog(),
		});
		expect(models[0]?.config.name).toBe("bare-id");
		expect(models[0]?.config.contextWindow).toBe(128_000);
		expect(models[0]?.config.maxTokens).toBe(16_384);
	});
});
