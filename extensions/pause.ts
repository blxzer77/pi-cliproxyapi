/**
 * Pause gate.
 *
 * `/pause` makes every provider request wait until `/continue`. The setting is
 * persisted, so a paused session stays paused across restarts. Waiting time is
 * excluded from elapsed-time and TPS accounting.
 */

import { resolvePauseDefault, saveConfig } from "./config.ts";
import { log } from "./log.ts";

export const PAUSE_POLL_INTERVAL_MS = 200;

export class PauseController {
	private enabled = false;
	private pauseStartedAtMs: number | undefined;
	private pausedDurationMs = 0;

	constructor(enabled = false) {
		this.setEnabled(enabled);
	}

	setEnabled(enabled: boolean, now = Date.now()): void {
		if (enabled === this.enabled) {
			return;
		}
		if (enabled) {
			this.pauseStartedAtMs = now;
		} else if (this.pauseStartedAtMs !== undefined) {
			this.pausedDurationMs += Math.max(0, now - this.pauseStartedAtMs);
			this.pauseStartedAtMs = undefined;
		}
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/** Total time spent paused so far, including an in-progress pause. */
	totalPausedMs(now = Date.now()): number {
		if (this.pauseStartedAtMs === undefined) {
			return this.pausedDurationMs;
		}
		return this.pausedDurationMs + Math.max(0, now - this.pauseStartedAtMs);
	}
}

export const pauseController = new PauseController();

function readPauseSetting(agentDir: string, fallback: boolean): boolean {
	try {
		return resolvePauseDefault(agentDir);
	} catch {
		return fallback;
	}
}

/**
 * Block until the persisted pause setting is false.
 *
 * The setting is re-read from disk on every poll so `/continue` takes effect while
 * a request is already waiting.
 */
export async function waitForPauseToEnd(
	agentDir: string,
	controller: PauseController = pauseController,
): Promise<void> {
	while (true) {
		const enabled = readPauseSetting(agentDir, controller.isEnabled());
		controller.setEnabled(enabled);
		if (!enabled) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, PAUSE_POLL_INTERVAL_MS));
	}
}

export function persistPausePreference(agentDir: string, enabled: boolean): void {
	saveConfig(agentDir, { pause: enabled });
	log.debug(`pause preference saved: ${enabled}`);
}
