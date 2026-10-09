import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig, writeJsonAtomic } from "../extensions/config.ts";
import { CatalogController } from "../extensions/provider.ts";
import { MODELS_DEV_PROVIDERS } from "./fixtures.ts";

const BASE_URL = "http://127.0.0.1:8317";
const SOL = { slug: "gpt-6.1-sol", display_name: "Sol", context_window: 272_000 };

let agentDir: string;
let originalFetch: typeof globalThis.fetch;
/** Requests served per path, so tests can assert on network traffic. */
let requests: { catalog: number; modelsDev: number };
/** Set while a models.dev response is being held back. */
let holdModelsDev: (() => void) | undefined;

function modelsDevResponse(): Response {
	return new Response(JSON.stringify(MODELS_DEV_PROVIDERS), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function installFetch(models: unknown[]): void {
	requests = { catalog: 0, modelsDev: 0 };
	holdModelsDev = undefined;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/v1/models")) {
			requests.catalog += 1;
			return new Response(JSON.stringify({ data: models }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.startsWith("https://models.dev")) {
			requests.modelsDev += 1;
			if (holdModelsDev) {
				await new Promise<void>((resolve) => {
					holdModelsDev = resolve;
				});
			}
			return modelsDevResponse();
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
}

function find(models: ReturnType<CatalogController["getModels"]>, id: string) {
	const model = models.find((entry) => entry.meta.id === id);
	if (!model) {
		throw new Error(`model ${id} missing`);
	}
	return model;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "cpa-provider-test-"));
	originalFetch = globalThis.fetch;
	saveConfig(agentDir, { baseUrl: BASE_URL, apiKey: "sk-test" });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("CatalogController refresh", () => {
	it("fetches once and skips a second refresh that follows moments later", async () => {
		installFetch([SOL]);
		const catalog = new CatalogController(agentDir, "cliproxyapi");

		await catalog.refresh({ allowNetwork: true, pricing: "await" });
		expect(requests.catalog).toBe(1);

		// Throttled: a successful fetch happened a moment ago.
		await catalog.refresh({ allowNetwork: true, pricing: "await" });
		expect(requests.catalog).toBe(1);
		expect(catalog.getModels()).toHaveLength(1);

		// An explicit force always goes to the network.
		await catalog.refresh({ allowNetwork: true, force: true, pricing: "await" });
		expect(requests.catalog).toBe(2);
	});

	it("restores the picker from disk without a network call when offline", async () => {
		installFetch([SOL]);
		const first = new CatalogController(agentDir, "cliproxyapi");
		await first.refresh({ allowNetwork: true, pricing: "await" });
		expect(requests.catalog).toBe(1);

		// A new process: no in-memory state, and the cache supplies the models.
		const restarted = new CatalogController(agentDir, "cliproxyapi");
		await restarted.refresh({ allowNetwork: false });
		expect(requests.catalog).toBe(1);
		expect(restarted.getModels()).toHaveLength(1);
		expect(restarted.getLastSource()).toBe("cache");
	});

	it("registers models before the pricing fetch lands and reprices when it does", async () => {
		installFetch([SOL]);
		holdModelsDev = () => {};
		let onUpdated = (): void => {};
		const updated = new Promise<void>((resolve) => {
			onUpdated = resolve;
		});
		const catalog = new CatalogController(agentDir, "cliproxyapi", { onCatalogUpdated: () => onUpdated() });

		await catalog.refresh({ allowNetwork: true, pricing: "background" });
		// The picker is populated and usable while models.dev is still in flight.
		expect(catalog.getModels()).toHaveLength(1);
		expect(find(catalog.getModels(), "gpt-6.1-sol").meta.costSource).toBe("none");

		// Let the held response through; the controller reprices and notifies.
		holdModelsDev?.();
		await updated;
		expect(requests.modelsDev).toBe(1);
		expect(find(catalog.getModels(), "gpt-6.1-sol").meta.costSource).toBe("models.dev");
		expect(find(catalog.getModels(), "gpt-6.1-sol").config.cost).toMatchObject({ input: 1.25, output: 10 });
	});

	it("blocks on pricing when the caller asks to await it", async () => {
		installFetch([SOL]);
		const catalog = new CatalogController(agentDir, "cliproxyapi");
		await catalog.refresh({ allowNetwork: true, pricing: "await" });
		expect(requests.modelsDev).toBe(1);
		expect(find(catalog.getModels(), "gpt-6.1-sol").meta.costSource).toBe("models.dev");
	});

	it("notifies once about a model that appeared in the catalog", async () => {
		installFetch([SOL]);
		const catalog = new CatalogController(agentDir, "cliproxyapi");
		await catalog.refresh({ allowNetwork: true, pricing: "await" });
		expect(catalog.takeNotices()).toEqual([]);

		installFetch([SOL, { slug: "space-bunny", display_name: "Bunny", context_window: 272_000 }]);
		await catalog.refresh({ allowNetwork: true, force: true, pricing: "await" });
		const notices = catalog.takeNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("space-bunny");
		// Drained: a second read shows nothing.
		expect(catalog.takeNotices()).toEqual([]);
	});

	it("notifies about a dropped model only when it is the configured default", async () => {
		writeJsonAtomic(join(agentDir, "settings.json"), { defaultModel: "cliproxyapi/space-bunny" });
		// Drop immediately instead of keeping the model for the unlisted grace period.
		writeJsonAtomic(join(agentDir, "cliproxyapi-overrides.json"), { defaults: { unlistedGraceMs: 0 } });
		installFetch([SOL, { slug: "space-bunny", display_name: "Bunny", context_window: 272_000 }]);
		const catalog = new CatalogController(agentDir, "cliproxyapi");
		await catalog.refresh({ allowNetwork: true, pricing: "await" });

		installFetch([SOL]);
		await catalog.refresh({ allowNetwork: true, force: true, pricing: "await" });
		const notices = catalog.takeNotices();
		expect(notices.some((notice) => notice.includes("space-bunny") && notice.includes("removed"))).toBe(true);
	});

	it("keeps the previous models when the fetch fails", async () => {
		installFetch([SOL]);
		const catalog = new CatalogController(agentDir, "cliproxyapi");
		await catalog.refresh({ allowNetwork: true, pricing: "await" });

		globalThis.fetch = (async () => new Response("boom", { status: 500, statusText: "Server Error" })) as never;
		const snapshot = await catalog.refresh({ allowNetwork: true, force: true, pricing: "await" });
		expect(snapshot.error).toContain("500");
		expect(snapshot.models).toHaveLength(1);
	});
});
