import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_BASE_URL,
	defaultBaseUrlInput,
	firstNonEmpty,
	isConfiguredDefaultModel,
	loadConfig,
	loadConfiguredDefault,
	parseBooleanSetting,
	resolveConnection,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	saveConfig,
	writeJsonAtomic,
} from "../extensions/config.ts";

describe("resolveEndpoints", () => {
	it("turns a bare host:port into the backend-api and catalog URLs", () => {
		const endpoints = resolveEndpoints("http://127.0.0.1:8317");
		expect(endpoints.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/codex");
		expect(endpoints.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");
	});

	it("adds a scheme when the user types only host:port", () => {
		expect(resolveEndpoints("127.0.0.1:8317").inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/codex");
	});

	it("accepts a pasted /v1 URL", () => {
		expect(resolveEndpoints("http://host:8317/v1").inferenceBaseUrl).toBe("http://host:8317/backend-api/codex");
	});

	it("accepts a pasted backend-api URL", () => {
		expect(resolveEndpoints("http://host:8317/backend-api").inferenceBaseUrl).toBe(
			"http://host:8317/backend-api/codex",
		);
	});

	it("accepts the exact inference URL it produced earlier", () => {
		const once = resolveEndpoints("https://host:50123");
		const twice = resolveEndpoints(once.inferenceBaseUrl);
		expect(twice.inferenceBaseUrl).toBe(once.inferenceBaseUrl);
		expect(twice.modelsUrl).toBe(once.modelsUrl);
	});

	it("accepts a pasted catalog URL", () => {
		expect(resolveEndpoints("https://host:50123/v1/models").modelsUrl).toBe(
			"https://host:50123/v1/models?client_version=pi",
		);
	});

	it("preserves a base path", () => {
		const endpoints = resolveEndpoints("https://gateway.example.com/cpa/");
		expect(endpoints.inferenceBaseUrl).toBe("https://gateway.example.com/cpa/backend-api/codex");
		expect(endpoints.modelsUrl).toBe("https://gateway.example.com/cpa/v1/models?client_version=pi");
	});

	it("rejects an empty value", () => {
		expect(() => resolveEndpoints("   ")).toThrow(/empty/);
	});
});

describe("parseBooleanSetting", () => {
	it("accepts the documented spellings", () => {
		for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
			expect(parseBooleanSetting(value)).toBe(true);
		}
		for (const value of ["0", "false", "no", "off"]) {
			expect(parseBooleanSetting(value)).toBe(false);
		}
	});

	it("returns undefined for anything else", () => {
		expect(parseBooleanSetting("maybe")).toBeUndefined();
		expect(parseBooleanSetting("")).toBeUndefined();
	});
});

describe("firstNonEmpty", () => {
	it("takes the first trimmed non-empty value and ignores blanks", () => {
		expect(firstNonEmpty(undefined, "  ", "\t", " hit ", "later")).toBe("hit");
		expect(firstNonEmpty(undefined, "")).toBeUndefined();
	});
});

describe("config file round-trips", () => {
	let agentDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "cpa-config-"));
		for (const key of [
			"CLIPROXYAPI_BASE_URL",
			"CLIPROXYAPI_API_KEY",
			"CLIPROXYAPI_PROVIDER_ID",
			"CLIPROXYAPI_PROVIDER_NAME",
			"CLIPROXYAPI_FAST",
			"CLIPROXYAPI_PAUSE",
		]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("treats a missing file as an empty config", () => {
		expect(loadConfig(agentDir)).toEqual({});
	});

	it("preserves unknown keys when saving", () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({ custom: "keep", fast: false }), "utf8");
		saveConfig(agentDir, { fast: true });
		const written = loadConfig(agentDir) as Record<string, unknown>;
		expect(written).toMatchObject({ custom: "keep", fast: true });
	});

	it("reports invalid JSON through loadConfig", () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), "{ not json", "utf8");
		expect(() => loadConfig(agentDir)).toThrow(/not valid JSON/);
	});

	it("rejects a non-object config", () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), "[]", "utf8");
		expect(() => loadConfig(agentDir)).toThrow(/JSON object/);
	});
});

describe("resolveIdentity", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "cpa-identity-"));
	});

	it("defaults to cliproxyapi/CLIProxyAPI", () => {
		expect(resolveIdentity(agentDir)).toEqual({ providerId: "cliproxyapi", providerName: "CLIProxyAPI" });
	});

	it("reads the config file", () => {
		writeFileSync(
			join(agentDir, "cliproxyapi.json"),
			JSON.stringify({ providerId: "cpa", providerName: "My Proxy" }),
			"utf8",
		);
		expect(resolveIdentity(agentDir)).toEqual({ providerId: "cpa", providerName: "My Proxy" });
	});

	it("survives an unreadable config", () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), "garbage", "utf8");
		expect(resolveIdentity(agentDir).providerId).toBe("cliproxyapi");
	});
});

describe("resolveConnection and preferences", () => {
	let agentDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "cpa-connection-"));
		for (const key of ["CLIPROXYAPI_BASE_URL", "CLIPROXYAPI_API_KEY", "CLIPROXYAPI_FAST"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("returns null without any credential", () => {
		expect(resolveConnection(agentDir, "cliproxyapi")).toBeNull();
	});

	it("reads the config file and derives both endpoints", () => {
		writeFileSync(
			join(agentDir, "cliproxyapi.json"),
			JSON.stringify({ baseUrl: "https://proxy.example.com", apiKey: "sk-test" }),
			"utf8",
		);
		const connection = resolveConnection(agentDir, "cliproxyapi");
		expect(connection).toMatchObject({
			baseUrlInput: "https://proxy.example.com",
			apiKey: "sk-test",
			inferenceBaseUrl: "https://proxy.example.com/backend-api/codex",
			modelsUrl: "https://proxy.example.com/v1/models?client_version=pi",
		});
	});

	it("lets the environment win over the file", () => {
		writeFileSync(
			join(agentDir, "cliproxyapi.json"),
			JSON.stringify({ baseUrl: "https://file.example.com", apiKey: "file-key" }),
			"utf8",
		);
		process.env.CLIPROXYAPI_BASE_URL = "https://env.example.com";
		process.env.CLIPROXYAPI_API_KEY = "env-key";
		const connection = resolveConnection(agentDir, "cliproxyapi");
		expect(connection?.baseUrlInput).toBe("https://env.example.com");
		expect(connection?.apiKey).toBe("env-key");
	});

	it("reports the configured base URL even when only auth.json holds a key", () => {
		expect(defaultBaseUrlInput(agentDir, "cliproxyapi")).toBe(DEFAULT_BASE_URL);
	});

	it("defaults fast to off and rejects a non-boolean", () => {
		expect(resolveFastDefault(agentDir)).toBe(false);
		writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({ fast: "yes" }), "utf8");
		expect(() => resolveFastDefault(agentDir)).toThrow(/must be a boolean/);
	});

	it("reads a persisted fast preference", () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({ fast: true }), "utf8");
		expect(resolveFastDefault(agentDir)).toBe(true);
	});

	it("lets CLIPROXYAPI_FAST override the file and rejects nonsense", () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({ fast: false }), "utf8");
		process.env.CLIPROXYAPI_FAST = "on";
		expect(resolveFastDefault(agentDir)).toBe(true);
		process.env.CLIPROXYAPI_FAST = "sometimes";
		expect(() => resolveFastDefault(agentDir)).toThrow(/CLIPROXYAPI_FAST/);
	});
});

describe("writeJsonAtomic", () => {
	it("writes valid JSON and leaves no temporary file behind", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-atomic-"));
		const path = join(dir, "nested", "out.json");
		writeJsonAtomic(path, { a: 1 });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(join(dir, "nested"))).toEqual(["out.json"]);
	});
});

describe("loadConfiguredDefault and isConfiguredDefaultModel", () => {
	it("reads settings.json and matches the documented model reference forms", () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-default-"));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ defaultProvider: "cliproxyapi", defaultModel: "cliproxyapi/gpt-6-luna" }),
			"utf8",
		);
		const configured = loadConfiguredDefault(dir);
		expect(configured.defaultModel).toBe("cliproxyapi/gpt-6-luna");
		expect(isConfiguredDefaultModel(configured, "gpt-6-luna", "cliproxyapi")).toBe(true);
		expect(isConfiguredDefaultModel(configured, "gpt-6-luna", "other")).toBe(false);
		expect(isConfiguredDefaultModel(configured, "gpt-6-sol", "cliproxyapi")).toBe(false);
	});

	it("matches a bare model id only when the provider also matches", () => {
		const configured = { defaultProvider: "cliproxyapi", defaultModel: "gpt-6-luna" };
		expect(isConfiguredDefaultModel(configured, "gpt-6-luna", "cliproxyapi")).toBe(true);
		expect(isConfiguredDefaultModel(configured, "gpt-6-luna", "other")).toBe(false);
	});

	it("returns nothing when settings.json is absent or malformed", () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-default-"));
		expect(loadConfiguredDefault(dir)).toEqual({});
		writeFileSync(join(dir, "settings.json"), "garbage", "utf8");
		expect(loadConfiguredDefault(dir)).toEqual({});
	});
});
