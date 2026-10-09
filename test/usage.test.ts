import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { mapCatalog } from "../extensions/catalog.ts";
import { compileOverrides } from "../extensions/overrides.ts";
import { buildCostCatalog, matchCost } from "../extensions/pricing.ts";
import { normalizeTransientError } from "../extensions/retry.ts";
import { addMessageUsage, emptyUsageTotals, formatElapsed, formatTokens, UsageReporter } from "../extensions/usage.ts";
import { CODEX_MODEL, MODELS_DEV_PROVIDERS, RELAY_MODEL } from "./fixtures.ts";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "cliproxyapi",
		model: "gpt-6.1-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

describe("normalizeTransientError", () => {
	it("rewrites the CLIProxyAPI connection-drop wording so pi retries it", () => {
		const message = assistantMessage({ stopReason: "error", errorMessage: "closed network connection" });
		const normalized = normalizeTransientError(message);
		expect(normalized.errorMessage).toBe("network error: closed network connection");
	});

	it("rewrites a truncated stream and invalid SSE payloads", () => {
		for (const text of [
			"stream disconnected before completion: stream closed before response.completed",
			"invalid SSE data JSON",
			"auth_unavailable",
		]) {
			const normalized = normalizeTransientError(assistantMessage({ stopReason: "error", errorMessage: text }));
			expect(normalized.errorMessage).toMatch(/^network error: /);
		}
	});

	it("leaves errors pi already classifies as retryable untouched", () => {
		// pi's own pattern covers overloaded/service_unavailable/5xx/timeouts.
		for (const text of [
			"Our servers are currently overloaded. Please try again later.",
			"503 service unavailable",
			"request timed out",
		]) {
			const message = assistantMessage({ stopReason: "error", errorMessage: text });
			expect(normalizeTransientError(message)).toBe(message);
		}
	});

	it("leaves a genuine failure alone rather than turning it into a long retry", () => {
		const message = assistantMessage({ stopReason: "error", errorMessage: "invalid_request_error: unknown model" });
		expect(normalizeTransientError(message)).toBe(message);
	});

	it("ignores a successful message", () => {
		const message = assistantMessage({ stopReason: "stop" });
		expect(normalizeTransientError(message)).toBe(message);
	});
});

describe("UsageReporter.computeTps", () => {
	it("divides output tokens by the generation window, not total latency", () => {
		// 100 output tokens over exactly 2 seconds of streaming.
		expect(UsageReporter.computeTps(100, 10_000, 8_000)).toBeCloseTo(50, 6);
	});

	it("returns undefined when there is no first-event marker", () => {
		expect(UsageReporter.computeTps(100, 10_000, undefined)).toBeUndefined();
	});

	it("returns undefined for zero output", () => {
		expect(UsageReporter.computeTps(0, 10_000, 8_000)).toBeUndefined();
	});

	it("refuses to report throughput from a window too short to be meaningful", () => {
		expect(UsageReporter.computeTps(100, 8_100, 8_000)).toBeUndefined();
	});
});

describe("usage accumulation", () => {
	it("adds every bucket and the cost", () => {
		const totals = emptyUsageTotals();
		addMessageUsage(
			totals,
			assistantMessage({
				usage: {
					input: 100,
					output: 20,
					cacheRead: 1_000,
					cacheWrite: 50,
					totalTokens: 1_170,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
			}),
		);
		expect(totals).toEqual({
			input: 100,
			output: 20,
			cacheRead: 1_000,
			cacheWrite: 50,
			totalTokens: 1_170,
			cost: 10,
		});
	});

	it("tolerates a message without usage", () => {
		const totals = emptyUsageTotals();
		addMessageUsage(totals, assistantMessage({ usage: undefined as never }));
		expect(totals).toEqual(emptyUsageTotals());
	});
});

describe("formatting", () => {
	it("formats token counts compactly", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1_500)).toBe("1.5k");
		expect(formatTokens(2_500_000)).toBe("2.50M");
	});

	it("formats elapsed time with only the significant leading units", () => {
		expect(formatElapsed(45)).toBe("45s");
		expect(formatElapsed(90)).toBe("1m 30s");
		expect(formatElapsed(3_725)).toBe("1h 2m 5s");
		expect(formatElapsed(90_000)).toBe("1d 1h 0m 0s");
	});

	it("clamps a negative elapsed value", () => {
		expect(formatElapsed(-5)).toBe("0s");
	});
});

describe("cost integration on real catalog shapes", () => {
	const costCatalog = buildCostCatalog(MODELS_DEV_PROVIDERS);

	it("prices a Codex route from models.dev and estimates a request", () => {
		const cost = matchCost("gpt-6.1-sol", costCatalog);
		const models = mapCatalog([CODEX_MODEL], {
			overrides: compileOverrides(undefined, "test.json"),
			costCatalog,
		});
		expect(models[0]?.config.cost).toEqual(cost);
	});

	it("reports zero for a model with no published price", () => {
		const models = mapCatalog([RELAY_MODEL], {
			overrides: compileOverrides({ defaults: { pricing: true } }, "test.json"),
			costCatalog: buildCostCatalog({}),
		});
		expect(models[0]?.meta.costSource).toBe("none");
	});
});
