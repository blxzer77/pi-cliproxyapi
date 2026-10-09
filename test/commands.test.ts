import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCommands } from "../extensions/commands.ts";
import { saveConfig } from "../extensions/config.ts";
import { FastModeController } from "../extensions/fast.ts";
import { loadOverrides } from "../extensions/overrides.ts";
import { PauseController } from "../extensions/pause.ts";
import { CatalogController } from "../extensions/provider.ts";
import { UsageReporter } from "../extensions/usage.ts";

const BASE_URL = "http://127.0.0.1:8317";
const SOL = { slug: "gpt-6.1-sol", display_name: "Sol", context_window: 272_000, visibility: "list" };
const BUNNY = {
	slug: "space-bunny",
	display_name: "Bunny",
	context_window: 272_000,
	visibility: "list",
	service_tiers: [{ id: "priority" }],
	supported_reasoning_levels: ["low", "high"],
};

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

/** The slice of ExtensionAPI the commands under test actually use. */
interface FakePi {
	commands: Map<string, RegisteredCommand>;
	providers: Map<string, { models?: unknown[] }>;
}

function createFakePi(): { pi: ExtensionAPI; fake: FakePi } {
	const commands = new Map<string, RegisteredCommand>();
	const providers = new Map<string, { models?: unknown[] }>();
	const fake: FakePi = { commands, providers };
	const pi = {
		registerCommand: (name: string, options: RegisteredCommand) => {
			commands.set(name, options);
		},
		registerProvider: (name: string, config: { models?: unknown[] }) => {
			providers.set(name, config);
		},
		unregisterProvider: (name: string) => {
			providers.delete(name);
		},
		on: () => () => {},
	} as unknown as ExtensionAPI;
	return { pi, fake };
}

interface FakeCtx {
	ctx: ExtensionCommandContext;
	notifications: Array<{ message: string; type?: string }>;
}

function createCtx(model?: { provider: string; id: string }): FakeCtx {
	const notificationsList: Array<{ message: string; type?: string }> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notificationsList.push(type ? { message, type } : { message });
			},
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications: notificationsList };
}

let agentDir: string;
let originalFetch: typeof globalThis.fetch;

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

async function setup(models: unknown[] = [SOL, BUNNY]): Promise<{
	pi: ExtensionAPI;
	fake: FakePi;
	catalog: CatalogController;
	fastMode: FastModeController;
	usage: UsageReporter;
}> {
	installFetch(models);
	const { pi, fake } = createFakePi();
	const catalog = new CatalogController(agentDir, "cliproxyapi");
	await catalog.refresh({ allowNetwork: true, force: true, pricing: "await" });
	const fastMode = new FastModeController(false);
	const pauseMode = new PauseController(false);
	const usage = new UsageReporter({ providerId: "cliproxyapi", pauseMode });
	registerCommands({
		pi,
		agentDir,
		providerId: "cliproxyapi",
		providerName: "CLIProxyAPI",
		catalog,
		fastMode,
		pauseMode,
		usage,
		defaultBaseUrl: BASE_URL,
		refreshStatus: () => {},
	});
	return { pi, fake, catalog, fastMode, usage };
}

function run(fake: FakePi, command: string, args: string, ctx: ExtensionCommandContext): Promise<void> | void {
	const handler = fake.commands.get(command)?.handler;
	if (!handler) {
		throw new Error(`command /${command} was not registered`);
	}
	return handler(args, ctx);
}

function overridesFile(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(agentDir, "cliproxyapi-overrides.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "cpa-commands-test-"));
	originalFetch = globalThis.fetch;
	saveConfig(agentDir, { baseUrl: BASE_URL, apiKey: "sk-test" });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("slash commands", () => {
	it("registers every documented command", async () => {
		const { fake } = await setup();
		for (const name of [
			"cpa-refresh",
			"cpa-models",
			"cpa-doctor",
			"cpa-usage",
			"cpa-overrides",
			"cpa-pin",
			"cpa-hide",
			"cpa-show",
			"fast",
			"pause",
			"continue",
		]) {
			expect(fake.commands.has(name), `/${name}`).toBe(true);
		}
	});

	it("/cpa-models lists the catalog with the thinking ladder", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-models", "", ctx);
		const message = notifications.at(-1)?.message ?? "";
		expect(message).toContain("gpt-6.1-sol");
		expect(message).toContain("space-bunny");
		expect(message).toContain("lvl low,high");
		expect(message).toContain("/cpa-models <id>");
	});

	it("/cpa-models <id> shows one model in detail", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-models", "gpt-6.1-sol", ctx);
		const message = notifications.at(-1)?.message ?? "";
		expect(message).toContain("id            gpt-6.1-sol");
		expect(message).toContain("context       272.0k");
		expect(message).toContain("selectable");
		expect(message).toContain("none (catalog values)");
	});

	it("/cpa-models <unknown> reports an error", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-models", "nope", ctx);
		expect(notifications.at(-1)).toMatchObject({ type: "error" });
	});

	it("/cpa-pin with no argument pins the current model, and again unpins it", async () => {
		const { fake, catalog } = await setup();
		const model = { provider: "cliproxyapi", id: "gpt-6.1-sol" };

		const first = createCtx(model);
		await run(fake, "cpa-pin", "", first.ctx);
		expect(first.notifications.at(-1)?.message).toContain("gpt-6.1-sol: pin on");
		expect(overridesFile().models).toMatchObject({ "gpt-6.1-sol": { pin: true } });
		expect(catalog.findModel("gpt-6.1-sol")?.meta.listing).toBe("pinned");

		const second = createCtx(model);
		await run(fake, "cpa-pin", "", second.ctx);
		expect(second.notifications.at(-1)?.message).toContain("gpt-6.1-sol: pin off");
		// The entry is kept (for other fields) but the flag is gone.
		expect(overridesFile().models).toEqual({ "gpt-6.1-sol": {} });
		expect(catalog.findModel("gpt-6.1-sol")?.meta.listing).toBe("listed");
	});

	it("/cpa-hide removes a model from the picker through the provider registration", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-hide", "space-bunny", ctx);
		expect(notifications.at(-1)?.message).toContain("space-bunny: hidden on");
		const registered = fake.providers.get("cliproxyapi") as { models?: Array<{ id: string }> };
		const ids = (registered.models ?? []).map((model) => model.id);
		expect(ids).toContain("gpt-6.1-sol");
		expect(ids).not.toContain("space-bunny");
	});

	it("/cpa-pin without a usable model id explains the usage", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx({ provider: "anthropic", id: "claude" });
		await run(fake, "cpa-pin", "", ctx);
		expect(notifications.at(-1)).toMatchObject({ type: "error" });
		expect(notifications.at(-1)?.message).toContain("Usage: /cpa-pin");
	});

	it("/cpa-pin on a model outside the catalog still writes the override", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-pin", "ghost-model", ctx);
		expect(overridesFile().models).toMatchObject({ "ghost-model": { pin: true } });
		expect(notifications.some((entry) => entry.type === "warning" && entry.message.includes("ghost-model"))).toBe(
			true,
		);
	});

	it("/cpa-overrides init seeds a pinned starter file", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-overrides", "init", ctx);
		expect(notifications.at(-1)?.message).toContain("Wrote");
		const file = overridesFile();
		expect(file.models).toMatchObject({
			"gpt-6.1-sol": { contextWindow: 272_000, maxTokens: 16_384, pin: true },
		});
		expect(loadOverrides(agentDir).problems).toEqual([]);
	});

	it("/cpa-overrides show reports the file state", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-overrides", "show", ctx);
		expect(notifications.at(-1)?.message).toContain("not present");
		run(fake, "cpa-overrides", "init", ctx);
		const second = createCtx();
		await run(fake, "cpa-overrides", "show", second.ctx);
		expect(second.notifications.at(-1)?.message).toContain("loaded");
	});

	it("/cpa-usage reset zeroes the session totals", async () => {
		const { fake, usage } = await setup();
		usage.sessionUsage.input = 5_000;
		usage.sessionUsage.cost = 1.5;
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-usage", "reset", ctx);
		expect(notifications.at(-1)?.message).toContain("reset");
		expect(usage.sessionUsage.input).toBe(0);
		expect(usage.sessionUsage.cost).toBe(0);
	});

	it("/cpa-usage rejects an unknown argument", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-usage", "nonsense", ctx);
		expect(notifications.at(-1)).toMatchObject({ type: "error" });
	});

	it("/fast persists the preference and flips the controller", async () => {
		const { fake, fastMode } = await setup();
		const { ctx, notifications } = createCtx({ provider: "cliproxyapi", id: "gpt-6.1-sol" });
		await run(fake, "fast", "", ctx);
		expect(fastMode.isEnabled()).toBe(true);
		expect(notifications.at(-1)?.message).toContain("Fast mode enabled");
		const config = JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8")) as { fast?: boolean };
		expect(config.fast).toBe(true);
	});

	it("/cpa-doctor reports the resolved configuration", async () => {
		const { fake } = await setup();
		const { ctx, notifications } = createCtx();
		await run(fake, "cpa-doctor", "", ctx);
		const message = notifications.at(-1)?.message ?? "";
		expect(message).toContain("provider       cliproxyapi (CLIProxyAPI)");
		expect(message).toContain("credential     config/env");
		expect(message).toContain("cliproxyapi-catalog.json");
		expect(message).toContain("fast-capable 1");
	});
});
