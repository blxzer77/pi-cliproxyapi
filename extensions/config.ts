/**
 * Configuration, identity and endpoint resolution for the CLIProxyAPI provider.
 *
 * Resolution order for connection settings:
 *   env CLIPROXYAPI_* > ~/.pi/agent/cliproxyapi.json > /login credential in auth.json > default baseUrl
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";

export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const OVERRIDES_FILE_NAME = "cliproxyapi-overrides.json";
export const AUTH_FILE_NAME = "auth.json";

/** The models catalog query that makes CLIProxyAPI return its extended metadata. */
export const CLIENT_VERSION = "pi";

export const MODELS_REQUEST_TIMEOUT_MS = 60_000;
/** Keep API-key credentials effectively permanent; reconfigure via /login. */
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** Model-metadata fallbacks when the catalog omits a usable value. */
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface ConfigFile {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
	/** Persisted Fast preference. */
	fast?: boolean;
	/** Persisted request-pause preference. */
	pause?: boolean;
	/** Override the override-file location. Absolute path, or relative to the agent dir. */
	overridesFile?: string;
	/** Persisted model ids the user pinned in the model picker. */
	pinned?: string[];
}

export interface ResolvedIdentity {
	providerId: string;
	providerName: string;
}

export interface ResolvedEndpoints {
	/** Root origin plus optional path prefix, e.g. `https://host:50123`. */
	rootOrigin: string;
	/**
	 * Base URL handed to pi's `openai-responses` API.
	 *
	 * The API implementation appends `/responses`, so this ends in `/codex`.
	 */
	inferenceBaseUrl: string;
	modelsUrl: string;
}

export interface ResolvedConnection extends ResolvedEndpoints {
	baseUrlInput: string;
	apiKey: string;
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Normalize a user-provided base URL into the endpoints this provider talks to.
 *
 * Accepted inputs and their inference base:
 *   http://127.0.0.1:8317              -> http://127.0.0.1:8317/backend-api/codex
 *   http://127.0.0.1:8317/v1           -> http://127.0.0.1:8317/backend-api/codex
 *   http://127.0.0.1:8317/backend-api  -> http://127.0.0.1:8317/backend-api/codex
 *   http://127.0.0.1:8317/backend-api/codex -> unchanged
 *
 * The catalog always lives at `{root}/v1/models?client_version=pi`.
 */
export function resolveEndpoints(baseUrlInput: string): ResolvedEndpoints {
	const raw = baseUrlInput.trim();
	if (!raw) {
		throw new Error("baseUrl is empty");
	}
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
	const url = new URL(withScheme);

	let path = url.pathname.replace(/\/+$/, "");
	// Accept a pasted catalog or inference URL and reduce it to the server root.
	path = path.replace(/\/v1\/models$/, "");
	path = path.replace(/\/v1$/, "");
	path = path.replace(/\/backend-api(\/codex)?(\/responses)?$/, "");
	const rootPath = path;
	const rootOrigin = `${url.origin}${rootPath}`;

	return {
		rootOrigin,
		inferenceBaseUrl: `${rootOrigin}/backend-api/codex`,
		modelsUrl: `${url.origin}${`${rootPath}/v1/models`.replace(/\/{2,}/g, "/")}?client_version=${encodeURIComponent(CLIENT_VERSION)}`,
	};
}

/** Write JSON atomically so a crash mid-write cannot leave a truncated config. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${path} is not valid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export function loadConfig(agentDir: string): ConfigFile {
	const parsed = readJsonObject(configPath(agentDir));
	return parsed ? (parsed as ConfigFile) : {};
}

/** Never throws: an unreadable config degrades to defaults instead of breaking startup. */
export function loadConfigSafe(agentDir: string): { config: ConfigFile; error?: string } {
	try {
		return { config: loadConfig(agentDir) };
	} catch (error) {
		return { config: {}, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Merge `patch` into the existing config file, preserving unknown keys. */
export function saveConfig(agentDir: string, patch: ConfigFile): void {
	const existing = loadConfigSafe(agentDir).config;
	writeJsonAtomic(configPath(agentDir), { ...existing, ...patch });
}

export function parseBooleanSetting(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function resolveBoolean(
	envName: string,
	envValue: string | undefined,
	fileValue: unknown,
	fileField: string,
	fallback: boolean,
): boolean {
	if (envValue !== undefined && envValue !== "") {
		const parsed = parseBooleanSetting(envValue);
		if (parsed === undefined) {
			throw new Error(`${envName} must be one of: true, false, 1, 0, yes, no, on, off`);
		}
		return parsed;
	}
	if (fileValue === undefined) {
		return fallback;
	}
	if (typeof fileValue !== "boolean") {
		throw new Error(`${CONFIG_FILE_NAME} field "${fileField}" must be a boolean`);
	}
	return fileValue;
}

/** Fast preference: env CLIPROXYAPI_FAST > config `fast` > false. */
export function resolveFastDefault(agentDir: string): boolean {
	return resolveBoolean(
		"CLIPROXYAPI_FAST",
		process.env.CLIPROXYAPI_FAST,
		loadConfigSafe(agentDir).config.fast,
		"fast",
		false,
	);
}

/** Pause preference: env CLIPROXYAPI_PAUSE > config `pause` > false. */
export function resolvePauseDefault(agentDir: string): boolean {
	return resolveBoolean(
		"CLIPROXYAPI_PAUSE",
		process.env.CLIPROXYAPI_PAUSE,
		loadConfigSafe(agentDir).config.pause,
		"pause",
		false,
	);
}

function loadAuthConnection(agentDir: string, providerId: string): { baseUrl?: string; apiKey?: string } | null {
	const authPath = join(agentDir, AUTH_FILE_NAME);
	const entry = readStoredCredential(providerId, authPath);
	if (!entry) {
		return null;
	}

	if (entry.type === "oauth") {
		const access = typeof entry.access === "string" ? entry.access.trim() : "";
		let baseUrl: string | undefined;
		if (typeof entry.refresh === "string" && entry.refresh.trim()) {
			try {
				const meta = JSON.parse(entry.refresh) as { baseUrl?: unknown };
				if (typeof meta.baseUrl === "string" && meta.baseUrl.trim()) {
					baseUrl = meta.baseUrl.trim();
				}
			} catch {
				// Older or non-JSON refresh payloads carry no baseUrl.
			}
		}
		return access ? { apiKey: access, baseUrl } : null;
	}

	const key = typeof entry.key === "string" ? entry.key.trim() : "";
	return key ? { apiKey: key } : null;
}

export function resolveIdentity(agentDir: string): ResolvedIdentity {
	const { config } = loadConfigSafe(agentDir);
	return {
		providerId: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_ID, config.providerId, DEFAULT_PROVIDER_ID)!,
		providerName: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_NAME, config.providerName, DEFAULT_PROVIDER_NAME)!,
	};
}

/** Resolve connection settings, or `null` when no API key is available anywhere. */
export function resolveConnection(agentDir: string, providerId: string): ResolvedConnection | null {
	const { config } = loadConfigSafe(agentDir);
	let auth: { baseUrl?: string; apiKey?: string } | null = null;
	try {
		auth = loadAuthConnection(agentDir, providerId);
	} catch {
		auth = null;
	}

	const baseUrlInput = firstNonEmpty(
		process.env.CLIPROXYAPI_BASE_URL,
		config.baseUrl,
		auth?.baseUrl,
		DEFAULT_BASE_URL,
	)!;
	const apiKey = firstNonEmpty(process.env.CLIPROXYAPI_API_KEY, config.apiKey, auth?.apiKey);
	if (!apiKey) {
		return null;
	}

	return { baseUrlInput, apiKey, ...resolveEndpoints(baseUrlInput) };
}

export function defaultBaseUrlInput(agentDir: string, providerId: string): string {
	const { config } = loadConfigSafe(agentDir);
	let authBaseUrl: string | undefined;
	try {
		authBaseUrl = loadAuthConnection(agentDir, providerId)?.baseUrl;
	} catch {
		authBaseUrl = undefined;
	}
	return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, config.baseUrl, authBaseUrl, DEFAULT_BASE_URL)!;
}

export function hasStoredLogin(agentDir: string, providerId: string): boolean {
	try {
		return Boolean(loadAuthConnection(agentDir, providerId)?.apiKey);
	} catch {
		return false;
	}
}

export function overridesPath(agentDir: string, config: ConfigFile): string {
	const configured = firstNonEmpty(process.env.CLIPROXYAPI_OVERRIDES_FILE, config.overridesFile);
	if (!configured) {
		return join(agentDir, OVERRIDES_FILE_NAME);
	}
	return /^([A-Za-z]:[\\/]|\/)/.test(configured) ? configured : join(agentDir, configured);
}

export interface ConfiguredDefaultModel {
	defaultProvider?: string;
	defaultModel?: string;
}

export function loadConfiguredDefault(agentDir: string): ConfiguredDefaultModel {
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = readJsonObject(join(agentDir, "settings.json"));
	} catch {
		// settings.json belongs to pi; a malformed copy must not break this provider.
		return {};
	}
	if (!parsed) {
		return {};
	}
	return {
		defaultProvider: typeof parsed.defaultProvider === "string" ? parsed.defaultProvider.trim() : undefined,
		defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel.trim() : undefined,
	};
}

/** Whether `modelId` is the configured default model of this provider. */
export function isConfiguredDefaultModel(
	configured: ConfiguredDefaultModel | undefined,
	modelId: string,
	providerId: string,
): boolean {
	if (!configured?.defaultModel) {
		return false;
	}
	const value = configured.defaultModel.trim();
	if (value === `${providerId}/${modelId}` || value === `${providerId}:${modelId}`) {
		return true;
	}
	if (value === modelId) {
		return configured.defaultProvider === undefined || configured.defaultProvider === providerId;
	}
	return false;
}
