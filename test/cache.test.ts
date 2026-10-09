import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type CatalogCacheFile, cachePath, loadCatalogCache, saveCatalogCache } from "../extensions/cache.ts";
import { type CatalogModel, mapCatalog, reconcileCatalog } from "../extensions/catalog.ts";
import { compileOverrides } from "../extensions/overrides.ts";
import { emptyCostCatalog } from "../extensions/pricing.ts";
import { CODEX_MODEL, RELAY_MODEL } from "./fixtures.ts";

const MODELS_URL = "https://proxy.example.com/v1/models?client_version=pi";

function sampleModels(): CatalogModel[] {
	return mapCatalog([CODEX_MODEL, RELAY_MODEL], {
		overrides: compileOverrides(undefined, "test.json"),
		costCatalog: emptyCostCatalog(),
	});
}

describe("catalog cache", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "cpa-cache-"));
	});

	it("round-trips reconciled models with their state", () => {
		const models = sampleModels();
		models[0]!.meta.listing = "pinned";
		models[0]!.meta.pinned = true;
		models[1]!.meta.unlistedSince = 1234;

		saveCatalogCache(agentDir, MODELS_URL, models);
		const loaded = loadCatalogCache(agentDir, MODELS_URL);

		expect(loaded?.models).toHaveLength(2);
		expect(loaded?.models[0]?.meta).toMatchObject({ listing: "pinned", pinned: true });
		expect(loaded?.models[1]?.meta.unlistedSince).toBe(1234);
		expect(loaded?.models[0]?.config.contextWindow).toBe(models[0]?.config.contextWindow);
	});

	it("ignores a cache written for a different endpoint", () => {
		saveCatalogCache(agentDir, MODELS_URL, sampleModels());
		expect(loadCatalogCache(agentDir, "https://other.example.com/v1/models?client_version=pi")).toBeUndefined();
	});

	it("ignores a cache from an older schema version", () => {
		saveCatalogCache(agentDir, MODELS_URL, sampleModels());
		const parsed = JSON.parse(readFileSync(cachePath(agentDir), "utf8")) as CatalogCacheFile;
		writeFileSync(cachePath(agentDir), JSON.stringify({ ...parsed, version: 1 }), "utf8");
		expect(loadCatalogCache(agentDir, MODELS_URL)).toBeUndefined();
	});

	it("ignores a structurally invalid cache instead of throwing", () => {
		writeFileSync(
			cachePath(agentDir),
			JSON.stringify({ version: 2, fetchedAt: 1, modelsUrl: MODELS_URL, models: [{ nope: true }] }),
			"utf8",
		);
		expect(loadCatalogCache(agentDir, MODELS_URL)).toBeUndefined();
	});

	it("ignores unreadable JSON instead of throwing", () => {
		writeFileSync(cachePath(agentDir), "{ truncated", "utf8");
		expect(loadCatalogCache(agentDir, MODELS_URL)).toBeUndefined();
	});

	it("returns undefined when no cache exists", () => {
		expect(loadCatalogCache(agentDir, MODELS_URL)).toBeUndefined();
	});
});

describe("a pinned model survives a restart", () => {
	/**
	 * This is the scenario the cache exists for: a new process fetches a catalog that
	 * no longer lists a pinned model. Without seeding state from disk, the pinned model
	 * cannot be reconstructed at all, because the catalog was its only source.
	 */
	it("keeps a pinned model that the first fetch of a new process does not list", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "cpa-pin-"));
		const overrides = compileOverrides({ models: { "space-bunny": { pin: true } } }, "test.json");
		const now = 1_700_000_000_000;

		const cached = mapCatalog([CODEX_MODEL, RELAY_MODEL], {
			overrides,
			costCatalog: emptyCostCatalog(),
			now,
		});
		saveCatalogCache(agentDir, MODELS_URL, cached);

		// A new process starts: no in-memory state, only the cache.
		const restored = loadCatalogCache(agentDir, MODELS_URL);
		expect(restored).toBeDefined();

		// The fresh catalog lists only the Codex route.
		const fresh = mapCatalog([CODEX_MODEL], { overrides, costCatalog: emptyCostCatalog(), now });
		const result = reconcileCatalog(fresh, restored!.models, overrides, now + 1000, restored!.fetchedAt);

		const pinned = result.models.find((model) => model.meta.id === "space-bunny");
		expect(pinned?.meta.listing).toBe("pinned");
		expect(pinned?.meta.listed).toBe(false);
		expect(pinned?.config.contextWindow).toBe(RELAY_MODEL.context_window);
		expect(result.dropped).toEqual([]);
	});

	it("drops an unpinned model once the cached state is older than the grace period", () => {
		const overrides = compileOverrides(undefined, "test.json");
		const cachedAt = 1_700_000_000_000;
		const cached = mapCatalog([CODEX_MODEL, RELAY_MODEL], {
			overrides,
			costCatalog: emptyCostCatalog(),
			now: cachedAt,
		});
		const fresh = mapCatalog([CODEX_MODEL], { overrides, costCatalog: emptyCostCatalog(), now: cachedAt + 1000 });
		const result = reconcileCatalog(fresh, cached, overrides, cachedAt + 25 * 60 * 60 * 1000, cachedAt);
		expect(result.dropped).toEqual(["space-bunny"]);
	});
});
