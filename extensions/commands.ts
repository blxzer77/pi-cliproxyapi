/**
 * Slash commands.
 *
 * `/fast`, `/pause` and `/continue` keep the names users already have muscle memory
 * for. The `/cpa-*` commands expose the catalog, overrides and diagnostics.
 */

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
import { buildStarterOverrides, loadOverrides, saveOverridesFile, updateModelOverride } from "./overrides.ts";
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

/** Which layer of the overrides file decides a model's settings. */
function describeOverrideSource(overrides: ReturnType<typeof loadOverrides>, id: string): string {
	if (overrides.models.has(id.trim().toLowerCase())) {
		return `exact entry (${overrides.path})`;
	}
	const matching = overrides.patterns.filter((pattern) => pattern.regex.test(id));
	const last = matching.at(-1);
	if (!last) {
		return "none (catalog values)";
	}
	return `pattern /${last.source.match}/ (last of ${matching.length} matching)`;
}

/** Compact per-million-token rate summary for one model. */
function formatCost(cost: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
	const parts = [`in $${cost.input}`, `out $${cost.output}`];
	if (cost.cacheRead > 0) {
		parts.push(`cache r $${cost.cacheRead}`);
	}
	if (cost.cacheWrite > 0) {
		parts.push(`cache w $${cost.cacheWrite}`);
	}
	return `${parts.join("  ")}  /1M tok`;
}

/** The pi levels a user can actually select, in picker order. */
function formatSelectableLevels(thinkingLevelMap: Record<string, string | null> | undefined): string {
	if (!thinkingLevelMap) {
		return "not a reasoning model";
	}
	const selectable = Object.entries(thinkingLevelMap)
		.filter(([, value]) => value !== null)
		.map(([level]) => level);
	return selectable.length > 0 ? selectable.join(", ") : "none";
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

	/**
	 * Force a catalog refresh and re-register the provider, so an overrides edit
	 * shows up in the picker immediately. Never throws.
	 */
	const refreshAndRegister = async (ctx: ExtensionCommandContext): Promise<{ error?: string }> => {
		const connection = resolveConnection(agentDir, providerId);
		if (!connection) {
			return { error: `CLIProxyAPI is not configured. Run /login ${providerName}.` };
		}
		try {
			const snapshot = await catalog.refresh({ allowNetwork: true, force: true });
			fastMode.setSupportedModelIds(catalog.fastModelIds());
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
			refreshStatus(ctx);
			return { error: snapshot.error };
		} catch (error) {
			return { error: errorMessage(error) };
		}
	};

	/**
	 * Toggle one boolean override field for a model id, or for the current model when
	 * no id is given. The overrides file is edited in place; everything else it holds
	 * is preserved.
	 */
	const toggleModelFlag = async (
		field: "pin" | "hidden" | "show",
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const requested = args.trim().toLowerCase();
		const currentId = ctx.model?.provider === providerId ? ctx.model.id.toLowerCase() : undefined;
		const id = requested || currentId;
		if (!id) {
			ctx.ui.notify(`Usage: /cpa-${field} [model-id]  (no id = the current model)`, "error");
			return;
		}
		const model = catalog.findModel(id);
		const resolvedId = model?.meta.id ?? id;
		const overrides = loadOverrides(agentDir);
		const exact = overrides.models.get(id)?.[field];
		const fromPattern = overrides.patterns.some(
			(pattern) => pattern.regex.test(id) && pattern.source[field] === true,
		);
		const enabled = exact === true || (exact === undefined && fromPattern);
		// Switching off a flag a pattern provides needs an explicit false; switching off
		// an exact entry can simply delete it.
		const next: boolean | null = !enabled ? true : exact === true ? null : false;
		try {
			updateModelOverride(agentDir, resolvedId, field, next);
		} catch (error) {
			ctx.ui.notify(`Failed to update the overrides file: ${errorMessage(error)}`, "error");
			return;
		}
		ctx.ui.notify(`${resolvedId}: ${field} ${next === true ? "on" : "off"} (${overrides.path}).`, "info");
		if (!model) {
			ctx.ui.notify(`${resolvedId} is not in the current catalog; the change applies when it appears.`, "warning");
		}
		const result = await refreshAndRegister(ctx);
		if (result.error) {
			ctx.ui.notify(result.error, "error");
		}
	};

	pi.registerCommand("cpa-refresh", {
		description: "Force refresh the CLIProxyAPI model catalog.",
		handler: async (args, ctx) => {
			if (!requireNoArgs(args, "cpa-refresh", ctx)) {
				return;
			}
			ctx.ui.notify("Refreshing CLIProxyAPI models...", "info");
			const result = await refreshAndRegister(ctx);
			if (result.error) {
				ctx.ui.notify(`Refresh failed: ${result.error}. Keeping the previous list.`, "warning");
				return;
			}
			const snapshot = catalog.getSnapshot();
			const pinned = snapshot.models.filter((model) => model.meta.pinned).length;
			const unlisted = snapshot.models.filter((model) => model.meta.listing === "unlisted").length;
			const suffix = [pinned > 0 ? `${pinned} pinned` : "", unlisted > 0 ? `${unlisted} unlisted` : ""].filter(
				Boolean,
			);
			ctx.ui.notify(
				`Refreshed ${snapshot.models.length} model(s)${suffix.length > 0 ? ` (${suffix.join(", ")})` : ""}.`,
				"info",
			);
		},
	});

	pi.registerCommand("cpa-pin", {
		description: "Toggle the pin for a model, or the current model with no argument.",
		handler: async (args, ctx) => toggleModelFlag("pin", args, ctx),
	});

	pi.registerCommand("cpa-hide", {
		description: "Toggle visibility for a model, or the current model with no argument.",
		handler: async (args, ctx) => toggleModelFlag("hidden", args, ctx),
	});

	pi.registerCommand("cpa-show", {
		description: "Surface a model the catalog hides, or the current model with no argument.",
		handler: async (args, ctx) => toggleModelFlag("show", args, ctx),
	});

	pi.registerCommand("cpa-models", {
		description: "List CLIProxyAPI models with their resolved limits and overrides.",
		handler: async (args, ctx) => {
			const requested = args.trim();
			const models = catalog.getModels();
			if (requested) {
				const model = catalog.findModel(requested);
				if (!model) {
					ctx.ui.notify(`No model ${requested} in the catalog. Run /cpa-models for the list.`, "error");
					return;
				}
				const overrides = loadOverrides(agentDir);
				const catalogMeta = model.meta.catalog;
				const lines = [
					`id            ${model.meta.id}`,
					`name          ${model.config.name}`,
					`state         ${model.meta.listing}${model.meta.unlistedSince ? ` since ${formatRelative(model.meta.unlistedSince)}` : ""}`,
					`context       ${formatTokens(model.config.contextWindow)}${catalogMeta.contextWindow && catalogMeta.contextWindow !== model.config.contextWindow ? ` (catalog ${formatTokens(catalogMeta.contextWindow)})` : ""}${catalogMeta.maxContextWindow ? `, max_context_window ${formatTokens(catalogMeta.maxContextWindow)}` : ""}`,
					`max tokens    ${formatTokens(model.config.maxTokens)}${catalogMeta.maxTokens && catalogMeta.maxTokens !== model.config.maxTokens ? ` (catalog ${formatTokens(catalogMeta.maxTokens)})` : ""}`,
					`input         ${model.config.input.join(", ")}`,
					`reasoning     ${model.config.reasoning ? "yes" : "no"}`,
					`  catalog     ${catalogMeta.reasoningLevels.length > 0 ? catalogMeta.reasoningLevels.join(", ") : "(none advertised)"}`,
					`  selectable  ${formatSelectableLevels(model.config.thinkingLevelMap)}`,
					`fast          ${model.meta.fast ? "priority tier advertised" : "no priority tier"}`,
					`cost          ${model.meta.costSource}  ${formatCost(model.config.cost)}`,
					`override      ${describeOverrideSource(overrides, model.meta.id)}`,
				];
				const extras = Object.entries(model.meta.extras);
				if (extras.length > 0) {
					lines.push(`catalog       ${extras.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
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
					const levels = model.meta.catalog.reasoningLevels;
					const ladder = levels.length > 0 ? `  lvl ${levels.join(",")}` : "";
					return `${overridden} ${model.meta.id.padEnd(24)} ${formatTokens(model.config.contextWindow).padStart(7)}${drift}  out ${formatTokens(model.config.maxTokens)}  ${flags}${ladder}`;
				});
			ctx.ui.notify(
				`${models.length} model(s), ${formatRelative(catalog.getFetchedAt())}:\n${lines.join("\n")}\n* = an override file entry applies; /cpa-models <id> for one model in detail`,
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
			if (usage.lastResponseError) {
				const trace = usage.lastResponseError.traceId ? ` trace ${usage.lastResponseError.traceId}` : "";
				lines.push(
					`last response ${usage.lastResponseError.status}${trace} (${formatRelative(usage.lastResponseError.at)})`,
				);
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
			const trimmed = args.trim();
			if (trimmed === "reset") {
				usage.resetSessionUsage();
				ctx.ui.notify("Session usage totals reset.", "info");
				return;
			}
			if (trimmed) {
				ctx.ui.notify("Usage: /cpa-usage [reset]", "error");
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
					`last run ${last.fast ? "fast  " : ""}${formatElapsed(last.elapsedMs / 1000)}  out ${formatTokens(last.output)}  in ${formatTokens(last.input)}${last.tps !== undefined ? `  ${last.tps.toFixed(1)} tok/s` : ""}`,
				);
			}
			lines.push("Token counts come from CLIProxyAPI; cost is estimated and is not a bill.");
			if (usage.lastRun?.fast) {
				lines.push("The last run used Fast, which bills above the catalog rates shown here.");
			}
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
				const written = saveOverridesFile(agentDir, starter);
				ctx.ui.notify(
					`Wrote ${written} with ${entries.length} pinned model(s). Edit it to change limits, thinking levels or prices; changes apply on the next refresh.`,
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
