import { describe, expect, it } from "vitest";
import {
	buildCostCatalog,
	computeCost,
	costHasRates,
	matchCost,
	parseModelsDevCost,
	registerPriceAlias,
	ZERO_COST,
} from "../extensions/pricing.ts";
import { MODELS_DEV_PROVIDERS } from "./fixtures.ts";

const catalog = buildCostCatalog(MODELS_DEV_PROVIDERS);

describe("matchCost", () => {
	it("matches an exact id and ignores the namespace prefix", () => {
		expect(matchCost("gpt-6.1-sol", catalog)).toMatchObject({ input: 1.25, output: 10, cacheRead: 0.125 });
		expect(matchCost("openai/gpt-6.1-sol", catalog)).toMatchObject({ input: 1.25, output: 10 });
	});

	it("falls back to a normalized match when punctuation differs", () => {
		expect(matchCost("claude sonnet 5 5", catalog)).toMatchObject({ input: 3, output: 15 });
	});

	it("resolves a proxy-only id through a registered alias", () => {
		registerPriceAlias("my-relay-gpt", ["gpt-6.1-sol"]);
		expect(matchCost("my-relay-gpt", catalog)).toMatchObject({ input: 1.25, output: 10 });
	});

	it("refuses to guess when resellers disagree", () => {
		expect(matchCost("ambiguous-model", catalog)).toEqual(ZERO_COST);
	});

	it("prefers the namespace owner over a generic reseller", () => {
		// Both sell `deepseek-v4.1-flash` at different rates; the id names deepseek.
		expect(matchCost("deepseek/deepseek-v4.1-flash", catalog)).toMatchObject({ input: 0.28, output: 0.42 });
	});

	it("returns zero for an unknown model", () => {
		expect(matchCost("does-not-exist", catalog)).toEqual(ZERO_COST);
	});

	it("prefers an explicit override over every catalog match", () => {
		expect(matchCost("gpt-6.1-sol", catalog, { override: { ...ZERO_COST, input: 42 } })).toMatchObject({ input: 42 });
	});

	it("uses fast rates only when asked and only when published", () => {
		expect(matchCost("gpt-6.1-sol", catalog, { fast: true })).toMatchObject({ input: 2.5, output: 20 });
		// The model has no fast rates in the catalog, so the standard rates stay.
		expect(matchCost("claude-sonnet-5-5", catalog, { fast: true })).toMatchObject({ input: 3 });
	});

	it("does not mutate the catalog entry it returns", () => {
		const first = matchCost("gpt-6.1-sol", catalog);
		first.input = 999;
		expect(matchCost("gpt-6.1-sol", catalog).input).toBe(1.25);
	});
});

describe("parseModelsDevCost", () => {
	it("reads a context tier and keeps its threshold", () => {
		const cost = parseModelsDevCost({
			input: 1,
			output: 2,
			tiers: [{ tier: { type: "context", size: 100_000 }, input: 3, output: 4 }],
		});
		expect(cost?.tiers).toEqual([{ inputTokensAbove: 100_000, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }]);
	});

	it("ignores a non-context tier descriptor", () => {
		const cost = parseModelsDevCost({
			input: 1,
			output: 2,
			tiers: [{ tier: { type: "speed", size: 100 }, input: 9, output: 9 }],
		});
		expect(cost?.tiers).toBeUndefined();
	});

	it("reads the legacy context_over_200k shortcut as a 200k tier", () => {
		const cost = parseModelsDevCost({ input: 1, output: 2, context_over_200k: { input: 2, output: 4 } });
		expect(cost?.tiers).toEqual([{ inputTokensAbove: 200_000, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }]);
	});

	it("returns undefined without any usable rate", () => {
		expect(parseModelsDevCost({})).toBeUndefined();
		expect(parseModelsDevCost(undefined)).toBeUndefined();
	});
});

describe("computeCost", () => {
	it("multiplies each bucket by its own rate", () => {
		const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
		// 1M input, 1M output, 1M cache read, 1M cache write.
		expect(
			computeCost(cost, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
		).toBeCloseTo(1 + 2 + 0.1 + 0.2, 6);
	});

	it("switches to the tiered rate once input-side usage crosses the threshold", () => {
		const cost = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 200_000, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }],
		};
		const below = computeCost(cost, { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0 });
		expect(below).toBeCloseTo((100_000 * 1 + 100_000 * 2) / 1_000_000, 8);
		const above = computeCost(cost, { input: 300_000, output: 100_000, cacheRead: 0, cacheWrite: 0 });
		expect(above).toBeCloseTo((300_000 * 2 + 100_000 * 4) / 1_000_000, 8);
	});

	it("counts cache buckets toward the tier threshold", () => {
		const cost = {
			input: 1,
			output: 1,
			cacheRead: 1,
			cacheWrite: 1,
			tiers: [{ inputTokensAbove: 100_000, input: 5, output: 5, cacheRead: 5, cacheWrite: 5 }],
		};
		// input + cacheRead + cacheWrite = 101_000, above the threshold.
		const total = computeCost(cost, { input: 1_000, output: 1_000, cacheRead: 50_000, cacheWrite: 50_000 });
		expect(total).toBeCloseTo((101_000 * 5 + 1_000 * 5) / 1_000_000, 8);
	});

	it("never returns a negative cost for negative usage", () => {
		expect(
			computeCost(
				{ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
				{
					input: -5,
					output: -5,
					cacheRead: -5,
					cacheWrite: -5,
				},
			),
		).toBe(0);
	});
});

describe("costHasRates", () => {
	it("detects rates in the top-level fields", () => {
		expect(costHasRates({ ...ZERO_COST, output: 1 })).toBe(true);
	});

	it("detects rates that only exist inside tiers", () => {
		expect(
			costHasRates({
				...ZERO_COST,
				tiers: [{ inputTokensAbove: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }],
			}),
		).toBe(true);
	});

	it("reports a fully zero cost as unpriced", () => {
		expect(costHasRates({ ...ZERO_COST })).toBe(false);
	});
});
