/**
 * Usage, elapsed time and throughput.
 *
 * CLIProxyAPI reports exact token counts per response, so accounting uses those
 * rather than local estimates. Throughput is reported as output tokens over the
 * generation window (first upstream event to settle) and never as
 * `output / total_latency`, which would fold in queueing and tool time.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, log } from "./log.ts";
import type { PauseController } from "./pause.ts";

export const USAGE_STATUS_KEY = "cpa-usage";
const REFRESH_INTERVAL_MS = 1000;

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export function emptyUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function addMessageUsage(totals: UsageTotals, message: AssistantMessage): void {
	const usage = message.usage;
	if (!usage) {
		return;
	}
	totals.input += usage.input || 0;
	totals.output += usage.output || 0;
	totals.cacheRead += usage.cacheRead || 0;
	totals.cacheWrite += usage.cacheWrite || 0;
	totals.totalTokens += usage.totalTokens || 0;
	totals.cost += usage.cost?.total || 0;
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(2)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(Math.round(value));
}

export function formatElapsed(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (days > 0 || hours > 0) parts.push(`${hours}h`);
	if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
	parts.push(`${rest}s`);
	return parts.join(" ");
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return Boolean(message) && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

/** Only the interactive parent session owns the footer timer and notifications. */
function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

function isProviderMessage(message: AssistantMessage, providerId: string): boolean {
	return message.provider === providerId;
}

export interface UsageReporterOptions {
	providerId: string;
	pauseMode: PauseController;
	/** Whether Fast is in effect for a model, so the summary can mark priority billing. */
	isFastEffective?: (model: { provider: string; id: string }) => boolean;
}

interface RunState {
	startedAtMs: number;
	pausedAtStartMs: number;
	pausedWhenStarted: boolean;
	/** When the upstream began streaming, approximated by the first parsed event. */
	firstEventMs?: number;
	/** When response headers arrived, i.e. before the body was consumed. */
	headersMs?: number;
	lastRequestMs?: number;
	traceId?: string;
	/** Whether any request in this run carried the priority service tier. */
	fast: boolean;
}

export class UsageReporter {
	private run: RunState | undefined;
	private refreshedTimer: ReturnType<typeof setInterval> | undefined;
	private statusCtx: ExtensionContext | undefined;
	/** Usage accumulated for the current run. */
	private runUsage: UsageTotals = emptyUsageTotals();
	/** Usage accumulated for the whole session. */
	readonly sessionUsage: UsageTotals = emptyUsageTotals();
	/** Last completed run summary, for `/cpa-usage`. */
	lastRun: (UsageTotals & { elapsedMs: number; ttftMs?: number; tps?: number; fast: boolean }) | undefined;
	lastTraceId: string | undefined;
	/** Last failed provider response, for `/cpa-doctor`. */
	lastResponseError: { status: number; traceId?: string; at: number } | undefined;

	constructor(private readonly options: UsageReporterOptions) {}

	private get providerId(): string {
		return this.options.providerId;
	}

	private elapsedMs(now = Date.now()): number {
		const run = this.run;
		if (!run) {
			return 0;
		}
		if (!run.pausedWhenStarted) {
			return Math.max(0, now - run.startedAtMs);
		}
		const pausedSince = Math.max(0, this.options.pauseMode.totalPausedMs(now) - run.pausedAtStartMs);
		return Math.max(0, now - run.startedAtMs - pausedSince);
	}

	private setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (!isPrimaryUiSession(ctx)) {
			return;
		}
		try {
			ctx.ui.setStatus(USAGE_STATUS_KEY, text ? ctx.ui.theme.fg("dim", text) : undefined);
		} catch (error) {
			if (!errorMessage(error).includes("stale")) {
				log.debug("failed to update usage status", errorMessage(error));
			}
		}
	}

	private refreshStatus(): void {
		const ctx = this.statusCtx;
		if (!ctx || !this.run) {
			return;
		}
		this.setStatus(ctx, `Elapsed ${formatElapsed(this.elapsedMs() / 1000)}`);
	}

	private clearTimer(): void {
		if (this.refreshedTimer !== undefined) {
			clearInterval(this.refreshedTimer);
			this.refreshedTimer = undefined;
		}
	}

	/** Throughput over the generation window, excluding queueing and TTFT. */
	static computeTps(outputTokens: number, settledAtMs: number, firstEventMs: number | undefined): number | undefined {
		if (firstEventMs === undefined || outputTokens <= 0) {
			return undefined;
		}
		const windowMs = settledAtMs - firstEventMs;
		if (windowMs < 250) {
			return undefined;
		}
		return outputTokens / (windowMs / 1000);
	}

	register(pi: ExtensionAPI): void {
		pi.on("before_agent_start", (_event, ctx) => {
			if (!isPrimaryUiSession(ctx)) {
				return;
			}
			// Keep one timer across retries and tool continuations within a single run.
			if (this.run) {
				this.statusCtx = ctx;
				return;
			}
			const startedAtMs = Date.now();
			this.run = {
				startedAtMs,
				pausedAtStartMs: this.options.pauseMode.totalPausedMs(startedAtMs),
				pausedWhenStarted: this.options.pauseMode.isEnabled(),
				fast: false,
			};
			this.runUsage = emptyUsageTotals();
			this.statusCtx = ctx;
			this.refreshStatus();
			this.clearTimer();
			this.refreshedTimer = setInterval(() => this.refreshStatus(), REFRESH_INTERVAL_MS);
			this.refreshedTimer.unref?.();
		});

		pi.on("before_provider_request", (_event, ctx) => {
			if (!this.run) {
				return;
			}
			const model = ctx.model;
			if (!model || model.provider !== this.providerId) {
				return;
			}
			this.run.lastRequestMs = Date.now();
			this.run.firstEventMs = undefined;
			this.run.headersMs = undefined;
			if (this.options.isFastEffective?.(model)) {
				this.run.fast = true;
			}
		});

		pi.on("after_provider_response", (event) => {
			// A failed response is worth recording even outside a tracked run: it is the
			// first thing /cpa-doctor shows when a request keeps failing.
			if (event.status >= 400) {
				const traceId = readHeader(event.headers, "x-cpa-trace-id");
				this.lastResponseError = { status: event.status, ...(traceId ? { traceId } : {}), at: Date.now() };
			}
			if (!this.run) {
				return;
			}
			this.run.headersMs = Date.now();
			const runTraceId = readHeader(event.headers, "x-cpa-trace-id");
			if (runTraceId) {
				this.run.traceId = runTraceId;
				this.lastTraceId = runTraceId;
			}
			const retryAfter = readHeader(event.headers, "retry-after");
			if (retryAfter) {
				log.debug(`gateway asked to retry after ${retryAfter}s`, { traceId: runTraceId });
			}
		});

		pi.on("provider_stream_event", (event) => {
			if (!this.run || event.provider !== this.providerId) {
				return;
			}
			if (this.run.firstEventMs === undefined) {
				this.run.firstEventMs = Date.now();
			}
		});

		pi.on("agent_end", (event, ctx) => {
			if (!this.run || !isPrimaryUiSession(ctx)) {
				return;
			}
			for (const message of event.messages) {
				if (isAssistantMessage(message) && isProviderMessage(message, this.providerId)) {
					addMessageUsage(this.runUsage, message);
				}
			}
		});

		pi.on("agent_settled", (_event, ctx) => {
			const run = this.run;
			if (!run) {
				return;
			}
			// Measure before clearing the run state that the timer reads.
			const settledAtMs = Date.now();
			const elapsedMs = this.elapsedMs(settledAtMs);

			this.run = undefined;
			this.clearTimer();
			this.setStatus(ctx, undefined);

			const ttftMs =
				run.firstEventMs !== undefined && run.lastRequestMs !== undefined
					? run.firstEventMs - run.lastRequestMs
					: undefined;
			const tps = UsageReporter.computeTps(this.runUsage.output, settledAtMs, run.firstEventMs);

			this.lastRun = { ...this.runUsage, elapsedMs, ttftMs, tps, fast: run.fast };
			this.addToSession(this.runUsage);

			if (!isPrimaryUiSession(ctx)) {
				return;
			}
			try {
				ctx.ui.notify(this.formatSummary(this.runUsage, elapsedMs, ttftMs, tps, run.fast), "info");
			} catch (error) {
				if (!errorMessage(error).includes("stale")) {
					log.debug("failed to notify usage", errorMessage(error));
				}
			}
		});

		pi.on("session_shutdown", () => {
			this.clearTimer();
			this.run = undefined;
			this.statusCtx = undefined;
		});
	}

	private addToSession(usage: UsageTotals): void {
		this.sessionUsage.input += usage.input;
		this.sessionUsage.output += usage.output;
		this.sessionUsage.cacheRead += usage.cacheRead;
		this.sessionUsage.cacheWrite += usage.cacheWrite;
		this.sessionUsage.totalTokens += usage.totalTokens;
		this.sessionUsage.cost += usage.cost;
	}

	formatSummary(usage: UsageTotals, elapsedMs: number, ttftMs?: number, tps?: number, fast = false): string {
		const parts: string[] = [];
		// Fast bills at a higher rate than the catalog rates the cost came from, so the
		// marker is shown next to the price rather than left implicit.
		if (fast) {
			parts.push("fast");
		}
		parts.push(`${formatElapsed(elapsedMs / 1000)}`);
		if (ttftMs !== undefined) {
			parts.push(`ttft ${(ttftMs / 1000).toFixed(2)}s`);
		}
		parts.push(`out ${formatTokens(usage.output)}`);
		parts.push(`in ${formatTokens(usage.input)}`);
		if (usage.cacheRead > 0) {
			parts.push(`cache r ${formatTokens(usage.cacheRead)}`);
		}
		if (usage.cacheWrite > 0) {
			parts.push(`cache w ${formatTokens(usage.cacheWrite)}`);
		}
		if (tps !== undefined) {
			parts.push(`${tps.toFixed(1)} tok/s`);
		}
		if (usage.cost > 0) {
			parts.push(`~$${usage.cost.toFixed(4)}`);
		}
		const trace = this.lastTraceId ? `  ${this.lastTraceId}` : "";
		return `${parts.join(" • ")}${trace}`;
	}

	/** Reset the accumulated session totals. */
	resetSessionUsage(): void {
		const empty = emptyUsageTotals();
		this.sessionUsage.input = empty.input;
		this.sessionUsage.output = empty.output;
		this.sessionUsage.cacheRead = empty.cacheRead;
		this.sessionUsage.cacheWrite = empty.cacheWrite;
		this.sessionUsage.totalTokens = empty.totalTokens;
		this.sessionUsage.cost = empty.cost;
	}
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value) {
			return value;
		}
	}
	return undefined;
}
