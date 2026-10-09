/**
 * On-disk catalog cache.
 *
 * Stores the reconcile result, not the raw response, so pinning and the unlisted
 * grace period survive a restart. Without this, a pinned model that happens to be
 * missing from the first fetch of a new process cannot be reconstructed at all,
 * because its metadata only ever came from the catalog.
 *
 * Kept separate from pi's own model store so the persisted shape stays owned here
 * and can carry provider-private state such as `unlistedSince`.
 *
 * The catalog response contains no credentials, so nothing secret is written.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogModel } from "./catalog.ts";
import { writeJsonAtomic } from "./config.ts";
import { log } from "./log.ts";

export const CACHE_FILE_NAME = "cliproxyapi-catalog.json";
/**
 * 2: switched from raw catalog entries to reconciled models with state.
 * A version mismatch discards the file, which costs one refresh.
 */
export const CACHE_SCHEMA_VERSION = 2;

export interface CatalogCacheFile {
	version: number;
	fetchedAt: number;
	/** A cache is only valid for the endpoint it was fetched from. */
	modelsUrl: string;
	models: CatalogModel[];
}

export function cachePath(agentDir: string): string {
	return join(agentDir, CACHE_FILE_NAME);
}

function isCatalogModel(value: unknown): value is CatalogModel {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<CatalogModel>;
	return (
		typeof candidate.config?.id === "string" &&
		typeof candidate.meta?.id === "string" &&
		typeof candidate.meta?.listing === "string"
	);
}

export function loadCatalogCache(agentDir: string, modelsUrl: string): CatalogCacheFile | undefined {
	let raw: string;
	try {
		raw = readFileSync(cachePath(agentDir), "utf8");
	} catch {
		return undefined;
	}
	let parsed: Partial<CatalogCacheFile>;
	try {
		parsed = JSON.parse(raw) as Partial<CatalogCacheFile>;
	} catch (error) {
		log.warn(`ignoring unreadable catalog cache: ${String(error)}`);
		return undefined;
	}
	if (parsed.version !== CACHE_SCHEMA_VERSION) {
		log.debug(`discarding catalog cache written by schema v${String(parsed.version)}`);
		return undefined;
	}
	if (typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt) || parsed.modelsUrl !== modelsUrl) {
		return undefined;
	}
	if (!Array.isArray(parsed.models) || !parsed.models.every(isCatalogModel)) {
		log.warn("ignoring catalog cache with an unexpected shape");
		return undefined;
	}
	return parsed as CatalogCacheFile;
}

export function saveCatalogCache(agentDir: string, modelsUrl: string, models: CatalogModel[]): void {
	try {
		writeJsonAtomic(cachePath(agentDir), {
			version: CACHE_SCHEMA_VERSION,
			fetchedAt: Date.now(),
			modelsUrl,
			models,
		} satisfies CatalogCacheFile);
	} catch (error) {
		// A read-only filesystem must not break model registration.
		log.warn(`failed to write catalog cache: ${String(error)}`);
	}
}
