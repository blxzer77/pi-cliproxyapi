import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../extensions/config.ts";

const BASE_URL = "http://127.0.0.1:8317";
const SOL = { slug: "gpt-6.1-sol", display_name: "Sol", context_window: 272_000, visibility: "list" };

/** The slice of ExtensionAPI the extension entry point uses. */
interface FakePi {
	commands: Map<string, unknown>;
	providers: Map<string, { models?: unknown[]; oauth?: unknown }>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	unregistered: string[];
}

function createFakePi(): { pi: ExtensionAPI; fake: FakePi } {
	const commands = new Map<string, unknown>();
	const providers = new Map<string, { models?: unknown[]; oauth?: unknown }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const unregistered: string[] = [];
	const fake: FakePi = { commands, providers, handlers, unregistered };
	const pi = {
		registerCommand: (name: string, options: unknown) => {
			commands.set(name, options);
		},
		registerProvider: (name: string, config: { models?: unknown[]; oauth?: unknown }) => {
			providers.set(name, config);
		},
		unregisterProvider: (name: string) => {
			unregistered.push(name);
			providers.delete(name);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { pi, fake };
}

let agentDir: string;
let previousAgentDir: string | undefined;
let previousMinRefresh: string | undefined;
let originalFetch: typeof globalThis.fetch;

/** Let the background pricing fetch resolve instantly against the mock. */
function installFetch(models: unknown[]): void {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/v1/models")) {
			return new Response(JSON.stringify({ data: models }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.startsWith("https://models.dev")) {
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
}

/** Flush the background pricing task so the fetch mock can be restored safely. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "cpa-entry-test-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousMinRefresh = process.env.CLIPROXYAPI_CATALOG_MIN_REFRESH_MS;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	originalFetch = globalThis.fetch;
	saveConfig(agentDir, { baseUrl: BASE_URL, apiKey: "sk-test" });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	if (previousMinRefresh === undefined) {
		delete process.env.CLIPROXYAPI_CATALOG_MIN_REFRESH_MS;
	} else {
		process.env.CLIPROXYAPI_CATALOG_MIN_REFRESH_MS = previousMinRefresh;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

describe("extension entry point", () => {
	it("registers the provider, commands and hooks against a configured proxy", async () => {
		installFetch([SOL]);
		const { pi, fake } = createFakePi();
		const extension = (await import("../extensions/index.ts")).default;

		await extension(pi);
		await settle();

		const registration = fake.providers.get("cliproxyapi");
		expect(registration).toBeDefined();
		expect(registration?.models).toHaveLength(1);
		expect(registration?.models?.[0]).toMatchObject({ id: "gpt-6.1-sol", api: "openai-responses" });
		// The login flow is offered so the provider can be reconfigured.
		expect(registration?.oauth).toBeDefined();

		for (const name of ["cpa-refresh", "cpa-models", "cpa-doctor", "cpa-usage", "cpa-overrides"]) {
			expect(fake.commands.has(name), `/${name}`).toBe(true);
		}
		for (const event of ["before_provider_request", "session_start", "model_select", "session_shutdown"]) {
			expect(fake.handlers.has(event), event).toBe(true);
		}
	});

	it("re-registers the provider with the refreshed catalog on session_start", async () => {
		// session_start throttles a refresh that just succeeded, so open the throttle
		// for this test through the documented env override.
		process.env.CLIPROXYAPI_CATALOG_MIN_REFRESH_MS = "0";
		installFetch([SOL]);
		const { pi, fake } = createFakePi();
		const extension = (await import("../extensions/index.ts")).default;
		await extension(pi);
		await settle();
		expect(fake.providers.get("cliproxyapi")?.models).toHaveLength(1);

		// A second fetch lists another model; session_start picks it up.
		installFetch([SOL, { slug: "space-bunny", display_name: "Bunny", context_window: 272_000, visibility: "list" }]);
		const sessionStart = fake.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeDefined();
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = {
			hasUI: true,
			mode: "tui",
			model: undefined,
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => {
					notifications.push(type ? { message, type } : { message });
				},
			},
		};
		await sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
		await settle();

		const models = fake.providers.get("cliproxyapi")?.models as Array<{ id: string }> | undefined;
		expect(models?.map((model) => model.id)).toContain("space-bunny");
		// The new-model notice was surfaced exactly once.
		expect(notifications.filter((entry) => entry.message.includes("new model(s) available"))).toHaveLength(1);
	});

	it("still registers the provider for /login when nothing is configured", async () => {
		saveConfig(agentDir, { apiKey: undefined, baseUrl: undefined });
		delete process.env.CLIPROXYAPI_API_KEY;
		const { pi, fake } = createFakePi();
		const extension = (await import("../extensions/index.ts")).default;

		await extension(pi);
		await settle();

		// No models (nothing fetched without a credential) but the provider exists.
		expect(fake.providers.has("cliproxyapi")).toBe(true);
		expect(fake.providers.get("cliproxyapi")?.models).toEqual([]);
		expect(fake.commands.has("cpa-refresh")).toBe(true);
	});
});
