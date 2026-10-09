import { describe, expect, it } from "vitest";
import {
	buildStarterOverrides,
	buildThinkingLevelMap,
	compileOverrides,
	DEFAULT_UNLISTED_GRACE_MS,
	type OverridesFile,
	resolveOverride,
} from "../extensions/overrides.ts";

describe("compileOverrides", () => {
	it("applies documented defaults for an absent file", () => {
		const compiled = compileOverrides(undefined, "test.json");
		expect(compiled.found).toBe(false);
		expect(compiled.defaults.contextWindowSource).toBe("context_window");
		expect(compiled.defaults.respectVisibility).toBe(true);
		expect(compiled.defaults.unlistedGraceMs).toBe(DEFAULT_UNLISTED_GRACE_MS);
		expect(compiled.defaults.unlistedPolicy).toBe("drop");
		expect(compiled.problems).toEqual([]);
	});

	it("reports every problem instead of throwing on malformed input", () => {
		const compiled = compileOverrides(
			{
				defaults: { contextWindowSource: "nonsense", unlistedGraceMs: -1, pricing: "yes" },
				models: {
					ok: { contextWindow: 1_000, maxTokens: 100 },
					bad: { contextWindow: "big", cost: 3 },
					alsoBad: "not-an-object",
				},
				patterns: [{ match: "([", contextWindow: 5 }],
			},
			"test.json",
		);

		expect(compiled.problems.length).toBeGreaterThanOrEqual(5);
		expect(compiled.problems.join("\n")).toMatch(/contextWindowSource/);
		expect(compiled.problems.join("\n")).toMatch(/unlistedGraceMs/);
		expect(compiled.problems.join("\n")).toMatch(/pricing/);
		expect(compiled.problems.join("\n")).toMatch(/contextWindow/);
		expect(compiled.problems.join("\n")).toMatch(/not a valid regular expression/);
		// The usable entries still load.
		expect(compiled.models.has("ok")).toBe(true);
		expect(compiled.models.get("ok")?.contextWindow).toBe(1_000);
		expect(compiled.models.has("bad")).toBe(true);
		expect(compiled.models.get("bad")?.contextWindow).toBeUndefined();
		expect(compiled.models.has("alsobad")).toBe(false);
	});

	it("lowercases model keys so lookups are case-insensitive", () => {
		const compiled = compileOverrides({ models: { "GPT-6.1-Sol": { pin: true } } }, "test.json");
		expect(resolveOverride(compiled, "gpt-6.1-sol")?.pin).toBe(true);
		expect(resolveOverride(compiled, "GPT-6.1-SOL")?.pin).toBe(true);
	});

	it("normalizes cost field spellings and tiers", () => {
		const compiled = compileOverrides(
			{
				models: {
					m: {
						cost: {
							input: 1,
							output: 2,
							cache_read: 0.1,
							cache_write: 0.2,
							tiers: [{ inputTokensAbove: 100_000, input: 3, output: 4 }],
						},
					},
				},
			},
			"test.json",
		);
		const cost = compiled.models.get("m")?.cost;
		expect(cost).toMatchObject({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
		// A tier that omits a rate inherits the top-level one, so unspecified
		// cache rates keep the base rate rather than dropping to zero.
		expect(cost?.tiers).toEqual([
			{ inputTokensAbove: 100_000, input: 3, output: 4, cacheRead: 0.1, cacheWrite: 0.2 },
		]);
		expect(compiled.problems).toEqual([]);
	});

	it("filters thinkingLevels to the pi level vocabulary", () => {
		const compiled = compileOverrides(
			{ models: { m: { thinkingLevels: ["off", "LOW", "bogus", "high"] } } },
			"test.json",
		);
		// Unknown provider levels are kept so a proxy-only effort name still works.
		expect(compiled.models.get("m")?.thinkingLevels).toEqual(["off", "low", "bogus", "high"]);
	});
});

describe("resolveOverride precedence", () => {
	const file: OverridesFile = {
		models: {
			"claude-sonnet-5-5": { contextWindow: 1_000_000, maxTokens: 128_000, pin: true },
		},
		patterns: [
			{ match: "^claude-", contextWindow: 200_000, maxTokens: 8_192 },
			{ match: "^claude-opus-", contextWindow: 400_000 },
		],
	};

	it("lets an exact entry win over a pattern", () => {
		const compiled = compileOverrides(file, "test.json");
		const resolved = resolveOverride(compiled, "claude-sonnet-5-5");
		expect(resolved?.contextWindow).toBe(1_000_000);
		expect(resolved?.maxTokens).toBe(128_000);
		expect(resolved?.pin).toBe(true);
	});

	it("lets a later pattern override an earlier one", () => {
		const compiled = compileOverrides(file, "test.json");
		const resolved = resolveOverride(compiled, "claude-opus-5-5");
		expect(resolved?.contextWindow).toBe(400_000);
		// The earlier pattern still supplies fields the later one omits.
		expect(resolved?.maxTokens).toBe(8_192);
	});

	it("merges cost and headers field by field", () => {
		const compiled = compileOverrides(
			{
				patterns: [
					{ match: "^gpt-", cost: { input: 1, output: 2 }, headers: { a: "1", b: "2" } },
					{ match: "^gpt-6", cost: { output: 5 }, headers: { b: "3" } },
				],
			},
			"test.json",
		);
		const resolved = resolveOverride(compiled, "gpt-6-luna");
		expect(resolved?.cost).toMatchObject({ input: 1, output: 5 });
		expect(resolved?.headers).toEqual({ a: "1", b: "3" });
	});

	it("returns undefined when nothing matches", () => {
		const compiled = compileOverrides(file, "test.json");
		expect(resolveOverride(compiled, "space-bunny")).toBeUndefined();
	});
});

describe("buildStarterOverrides", () => {
	it("produces a file that compiles without problems", () => {
		const starter = buildStarterOverrides([
			{ id: "gpt-6.1-sol", contextWindow: 372_000, maxTokens: 128_000 },
			{ id: "deepseek-flash", contextWindow: 1_000_000, maxTokens: 384_000 },
		]);
		// Round-trip through JSON so the test also covers serialization.
		const compiled = compileOverrides(JSON.parse(JSON.stringify(starter)), "test.json");
		expect(compiled.problems).toEqual([]);
		expect(compiled.models.size).toBe(2);
		expect(resolveOverride(compiled, "gpt-6.1-sol")).toMatchObject({
			contextWindow: 372_000,
			maxTokens: 128_000,
			pin: true,
		});
		expect(compiled.defaults.unlistedPolicy).toBe("drop");
	});

	it("handles an empty catalog without inventing entries", () => {
		const compiled = compileOverrides(JSON.parse(JSON.stringify(buildStarterOverrides([]))), "test.json");
		expect(compiled.models.size).toBe(0);
		expect(compiled.problems).toEqual([]);
	});
});

describe("buildThinkingLevelMap", () => {
	it("marks unsupported pi levels as null and keeps supported ones", () => {
		const map = buildThinkingLevelMap(["low", "high", "xhigh"]);
		expect(map).toMatchObject({ low: "low", high: "high", xhigh: "xhigh", minimal: null, ultra: null });
		expect(map?.off).toBeNull();
	});

	it("maps off to the provider's none level when offered", () => {
		expect(buildThinkingLevelMap(["none", "low"])?.off).toBe("none");
	});

	it("returns undefined for an empty list so the model keeps pi's default", () => {
		expect(buildThinkingLevelMap([])).toBeUndefined();
	});
});
