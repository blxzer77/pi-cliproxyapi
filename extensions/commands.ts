/**
 * Slash commands.
 *
 * `/fast`, `/pause` and `/continue` keep the names users already have muscle memory
 * for. The `/cpa-*` commands expose the catalog, overrides and diagnostics.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cachePath } from "./cache.ts";
import {
	hasStoredLogin,
	loadConfigSafe,
	overridesPath,
	resolveConnection,
	resolveEndpoints,
	resolveIdentity,
} from "./config.ts";
import type { FastModeController } from "./fast.ts";
import { persistFastPreference } from "./fast.ts";
import { errorMessage, log } from "./log.ts";
import { buildStarterOverrides, loadOverrides } from "./overrides.ts";
import type { PauseController } from "./pause.ts";
import { persistPausePreference } from "./pause.ts";
import type { CatalogController } from "./provider.ts";
import { flushNotices, registerProvider } from "./provider.ts";
import type { UsageReporter } from "./usage.ts";
import { formatElapsed, formatTokens } from "./usage.ts";

function requireNoArgs(args: string, command: string, ctx: ExtensionCommandContext): boolean {
	if (args.trim()) {
		ctx.ui.notify(`Usage: /${command}`, "error");
		return false;
	}
	return true;
}

function formatRelative(timestamp: number | undefined): string {
	if (!timestamp) {
		return "never";
	}
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	if (seconds < 3600) {
		return `${Math.round(seconds / 60)}m ago`;
	}
	if (seconds < 86400) {
		return `${Math.round(seconds / 3600)}h ago`;
	}
	return `${Math.round(seconds / 86400)}d ago`;
}

export interface CommandContext {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	catalog: CatalogController;
	fastMode: FastModeController;
	pauseMode: PauseController;
	usage: UsageReporter;
	defaultBaseUrl: string;
	/** Redraw the footer labels (Fast, paused); commands call it after changing either. */
	refreshStatus: (ctx: ExtensionContext) => void;
}

export function registerCommands(context: CommandContext): void {
	const { pi, agentDir, providerId, providerName, catalog, fastMode, pauseMode, usage, refreshStatus } = context;

	pi.registerCommand("cpa-refresh", {
		description: "Force refresh the CLIProxyAPI model catalog.",
		handler: async (args, ctx) => {
			if (!requireNoArgs(args, "cpa-refresh", ctx)) {
				return;
			}
			const connection = resolveConnection(agentDir, providerId);
			if (!connection) {
				ctx.ui.notify(`CLIProxyAPI is not configured. Run /login ${providerName}.`, "error");
				return;
			}
			ctx.ui.notify("Refreshing CLIProxyAPI models...", "info");
			try {
				const snapshot = await catalog.refresh({ allowNetwork: true, force: true });
				fastMode.setSupportedModelIds(catalog.fastModelIds());
				refreshStatus(ctx);
				registerProvider({
					pi,
					agentDir,
					providerId,
					providerName,
					baseUrlInput: connection.baseUrlInput,
					apiKey: connection.apiKey,
					catalog,
				});
				flushNotices(catalog, ctx);
				if (snapshot.error) {
					ctx.ui.notify(`Refresh failed: ${snapshot.error}. Keeping the previous list.`, "warning");
					return;
				}
				const pinned = snapshot.models.filter((model) => model.meta.pinned).length;
				const unlisted = snapshot.models.filter((model) => model.meta.listing === "unlisted").length;
				const suffix = [pinned > 0 ? `${pinned} pinned` : "", unlisted > 0 ? `${unlisted} unlisted` : ""].filter(
					Boolean,
				);
				ctx.ui.notify(
					`Refreshed ${snapshot.models.length} model(s)${suffix.length > 0 ? ` (${suffix.join(", ")})` : ""}.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Failed to refresh models: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("cpa-models", {
		description: "List CLIProxyAPI models with their resolved limits and overrides.",
		handler: async (args, ctx) => {
			if (!requireNoArgs(args, "cpa-models", ctx)) {
				return;
			}
			const models = catalog.getModels();
			if (models.length === 0) {
				ctx.ui.notify("No CLIProxyAPI models are registered. Run /cpa-refresh.", "warning");
				return;
			}
			const overrides = loadOverrides(agentDir);
			const lines = models
				.filter((model) => model.meta.listing !== "hidden")
				.map((model) => {
					const flags = [
						model.meta.listing === "pinned" ? "pinned" : "",
						model.meta.listing === "unlisted" ? "unlisted" : "",
						model.meta.fast ? "fast" : "",
						model.meta.costSource === "none" ? "no-price" : model.meta.costSource,
					]
						.filter(Boolean)
						.join(" ");
					const overridden = overrides.models.has(model.meta.id.toLowerCase()) ? "*" : " ";
					const catalogContext = model.meta.catalog.contextWindow;
					const drift =
						catalogContext && catalogContext !== model.config.contextWindow
							? ` (catalog ${formatTokens(catalogContext)})`
							: "";
					return `${overridden} ${model.meta.id.padEnd(24)} ${formatTokens(model.config.contextWindow).padStart(7)}${drift}  out ${formatTokens(model.config.maxTokens)}  ${flags}`;
				});
			ctx.ui.notify(
				`${models.length} model(s), ${formatRelative(catalog.getFetchedAt())}:\n${lines.join("\n")}\n* = an override file entry applies`,
				"info",
			);
		},
	});

	pi.registerCommand("cpa-doctor", {
		description: "Show CLIProxyAPI provider configuration and catalog diagnostics.",
		handler: async (args, ctx) => {
			if (!requireNoArgs(args, "cpa-doctor", ctx)) {
				return;
			}
			const identity = resolveIdentity(agentDir);
			const config = loadConfigSafe(agentDir);
			const overrides = loadOverrides(agentDir);
			const snapshot = catalog.getSnapshot();
			const connection = resolveConnection(agentDir, providerId);
			const lines: string[] = [];

			lines.push(`provider       ${identity.providerId} (${identity.providerName})`);
			lines.push(`api            openai-responses -> {root}/backend-api/codex/responses`);
			if (connection) {
				const endpoints = resolveEndpoints(connection.baseUrlInput);
				lines.push(`baseUrl        ${connection.baseUrlInput}`);
				lines.push(`models URL     ${endpoints.modelsUrl}`);
			} else {
				lines.push(`baseUrl        unresolved (no credential)`);
			}
			lines.push(
				`credential     ${hasStoredLogin(agentDir, providerId) ? "auth.json" : connection ? "config/env" : "missing"}`,
			);
			lines.push(`config file    ${config.error ? `unreadable: ${config.error}` : "ok"}`);
			lines.push(`overrides      ${overrides.found ? overrides.path : `${overrides.path} (not present)`}`);
			if (overrides.models.size > 0 || overrides.patterns.length > 0) {
				lines.push(`  entries      ${overrides.models.size} model(s), ${overrides.patterns.length} pattern(s)`);
			}
			for (const problem of overrides.problems) {
				lines.push(`  problem      ${problem}`);
			}
			lines.push(
				`catalog        ${snapshot.models.length} model(s) from ${catalog.getLastSource()} (${formatRelative(snapshot.fetchedAt)})`,
			);
			lines.push(`  pinned       ${snapshot.models.filter((m) => m.meta.pinned).length}`);
			lines.push(`  unlisted     ${snapshot.models.filter((m) => m.meta.listing === "unlisted").length}`);
			lines.push(`  fast-capable ${catalog.fastModelIds().length}`);
			lines.push(`cache          ${cachePath(agentDir)}`);
			if (snapshot.error) {
				lines.push(`last error     ${snapshot.error}`);
			}
			if (usage.lastTraceId) {
				lines.push(`last trace     ${usage.lastTraceId}`);
			}
			lines.push(`fast           ${fastMode.isEnabled() ? "on" : "off"}`);
			lines.push(`paused         ${pauseMode.isEnabled() ? "yes" : "no"}`);

			ctx.ui.notify(lines.join("\n"), snapshot.error ? "warning" : "info");
		},
	});

	pi.registerCommand("cpa-usage", {
		description: "Show token usage and cost for this session.",
		handler: async (args, ctx) => {
			if (!requireNoArgs(args, "cpa-usage", ctx)) {
				return;
			}
			const session = usage.sessionUsage;
			const lines = [
				`session  in ${formatTokens(session.input)}  out ${formatTokens(session.output)}  cache r ${formatTokens(session.cacheRead)}  cache w ${formatTokens(session.cacheWrite)}  total ${formatTokens(session.totalTokens)}`,
			];
			if (session.cost > 0) {
				lines.push(`cost     ~$${session.cost.toFixed(4)} (estimated from catalog rates)`);
			}
			if (usage.lastRun) {
				const last = usage.lastRun;
				lines.push(
					`last run ${formatElapsed(last.elapsedMs / 1000)}  out ${formatTokens(last.output)}  in ${formatTokens(last.input)}${last.tps !== undefined ? `  ${last.tps.toFixed(1)} tok/s` : ""}`,
				);
			}
			lines.push("Token counts come from CLIProxyAPI; cost is estimated and is not a bill.");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("cpa-overrides", {
		description: "Show or seed the CLIProxyAPI model overrides file.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const path = overridesPath(agentDir, loadConfigSafe(agentDir).config);
			const overrides = loadOverrides(agentDir);

			if (trimmed === "" || trimmed === "show") {
				ctx.ui.notify(
					[
						`path    ${path}`,
						`status  ${overrides.found ? "loaded" : "not present"}`,
						`entries ${overrides.models.size} model(s), ${overrides.patterns.length} pattern(s)`,
						overrides.problems.length > 0 ? `problems\n  ${overrides.problems.join("\n  ")}` : "",
						"",
						"Write it with: /cpa-overrides init (pins every current model), or edit it directly.",
					]
						.filter(Boolean)
						.join("\n"),
					overrides.problems.length > 0 ? "warning" : "info",
				);
				return;
			}

			if (trimmed !== "init") {
				ctx.ui.notify("Usage: /cpa-overrides [show|init]", "error");
				return;
			}

			if (
				overrides.found &&
				!(await ctx.ui.confirm("Overwrite overrides file?", `${path} already exists. Replace it?`))
			) {
				return;
			}

			const entries = catalog.getModels().map((model) => ({
				id: model.meta.id,
				contextWindow: model.config.contextWindow,
				maxTokens: model.config.maxTokens,
			}));
			if (entries.length === 0) {
				ctx.ui.notify("No models to seed from. Run /cpa-refresh first.", "warning");
				return;
			}
			try {
				const starter = buildStarterOverrides(entries);
				writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
				ctx.ui.notify(
					`Wrote ${path} with ${entries.length} pinned model(s). Edit it to change limits, thinking levels or prices; changes apply on the next refresh.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Failed to write ${path}: ${errorMessage(error)}`, "error");
			}
		},
	});

	let fastToggleInProgress = false;
	pi.registerCommand("fast", {
		description: "Toggle CLIProxyAPI Fast mode (OpenAI priority service tier).",
		handler: async (args, ctx) => {
			if (!requireNoArgs(args, "fast", ctx)) {
				return;
			}
			if (fastToggleInProgress) {
				ctx.ui.notify("Fast mode is already being updated.", "warning");
				return;
			}
			fastToggleInProgress = true;
			try {
				const enabled = !fastMode.isEnabled();
				try {
					persistFastPreference(agentDir, enabled);
				} catch (error) {
					ctx.ui.notify(`Failed to save Fast mode: ${errorMessage(error)}`, "error");
					return;
				}
				fastMode.setEnabled(enabled);
				refreshStatus(ctx);

				const model = ctx.model;
				const supported = model && model.provider === providerId ? fastMode.isModelSupported(model.id) : undefined;
				if (!enabled) {
					ctx.ui.notify("Fast mode disabled.", "info");
				} else if (supported === false) {
					ctx.ui.notify(
						`Fast mode enabled, but ${model?.id} does not advertise a priority service tier. Requests are unchanged.`,
						"warning",
					);
				} else if (supported === undefined) {
					ctx.ui.notify("Fast mode enabled. Switch to a Fast-capable model to use it.", "info");
				} else {
					ctx.ui.notify("Fast mode enabled. Priority processing bills at a higher rate.", "info");
				}
			} finally {
				fastToggleInProgress = false;
			}
		},
	});

	const setPause = (enabled: boolean, command: string, args: string, ctx: ExtensionCommandContext): void => {
		if (!requireNoArgs(args, command, ctx)) {
			return;
		}
		try {
			persistPausePreference(agentDir, enabled);
		} catch (error) {
			ctx.ui.notify(`Failed to save the pause setting: ${errorMessage(error)}`, "error");
			return;
		}
		pauseMode.setEnabled(enabled);
		refreshStatus(ctx);
		ctx.ui.notify(
			enabled ? "Provider requests are paused. Use /continue to resume." : "Provider requests resumed.",
			"info",
		);
	};

	pi.registerCommand("pause", {
		description: "Pause CLIProxyAPI requests until /continue.",
		handler: async (args, ctx) => setPause(true, "pause", args, ctx),
	});

	pi.registerCommand("continue", {
		description: "Resume CLIProxyAPI requests paused by /pause.",
		handler: async (args, ctx) => setPause(false, "continue", args, ctx),
	});

	log.debug("commands registered");
}
