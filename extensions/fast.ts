/**
 * Fast mode: CLIProxyAPI's OpenAI priority service tier.
 *
 * A model is Fast-capable when the catalog advertises a non-empty `service_tiers`
 * array. Enabling fast injects `service_tier: "priority"` into the request payload
 * through pi's `before_provider_request` hook, so no stream handler is involved.
 *
 * Priority processing bills at a higher rate, so this is off by default.
 */

import type { Model } from "@earendil-works/pi-ai";
import { saveConfig } from "./config.ts";
import { log } from "./log.ts";

export const PRIORITY_SERVICE_TIER = "priority";

export class FastModeController {
	private enabled: boolean;
	private supported = new Set<string>();

	constructor(enabled: boolean) {
		this.enabled = enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/** Replace the set of Fast-capable model ids from the latest catalog. */
	setSupportedModelIds(modelIds: Iterable<string>): void {
		this.supported = new Set(
			Array.from(modelIds, (id) => id.trim())
				.filter(Boolean)
				.map((id) => id.toLowerCase()),
		);
	}

	supportedModelIds(): string[] {
		return [...this.supported].sort();
	}

	isModelSupported(modelId: string): boolean {
		return this.supported.has(modelId.trim().toLowerCase());
	}

	/**
	 * What the footer should say about Fast for this model: `on` or `off` when the
	 * model has a priority tier, `undefined` when it has none (nothing to show).
	 */
	stateFor(modelId: string): "on" | "off" | undefined {
		if (!this.isModelSupported(modelId)) {
			return undefined;
		}
		return this.enabled ? "on" : "off";
	}

	/** Whether Fast changes the wire request for this model right now. */
	isEffectiveFor(modelId: string): boolean {
		return this.enabled && this.isModelSupported(modelId);
	}

	isEffectiveForModel(model: Pick<Model<any>, "provider"> & { id: string }, providerId: string): boolean {
		return model.provider === providerId && this.isEffectiveFor(model.id);
	}
}

/** Add the priority service tier to a request payload. */
export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return { ...(payload as Record<string, unknown>), service_tier: PRIORITY_SERVICE_TIER };
}

export function persistFastPreference(agentDir: string, enabled: boolean): void {
	saveConfig(agentDir, { fast: enabled });
	log.debug(`fast preference saved: ${enabled}`);
}
