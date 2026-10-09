/**
 * Transient-failure normalization.
 *
 * pi already treats most gateway failures as retryable (see its own provider-error
 * pattern: overloaded, service unavailable, 5xx, timeouts, connection errors). A few
 * CLIProxyAPI failure shapes fall outside that pattern and would otherwise end a turn
 * that a single retry would have completed, so only those are rewritten.
 *
 * Deliberately narrow: rewriting a genuine failure as retryable turns a clear error
 * into a long wait.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./log.ts";

/**
 * Failures pi does not classify as retryable on its own.
 *
 * `closed network connection` is Go's net/http wording that CLIProxyAPI forwards when
 * the upstream connection drops; `invalid SSE data JSON` marks a truncated event; an
 * unknown `auth_unavailable` credential cooldown is recoverable within seconds.
 */
const TRANSIENT_STREAM_ERROR_PATTERN =
	/\bclosed network connection\b|\bstream disconnected before completion\b|\binvalid SSE data JSON\b|\bauth_unavailable\b/i;

const NETWORK_ERROR_PREFIX = "network error:";

export function normalizeTransientError(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "error" || !message.errorMessage) {
		return message;
	}
	if (isRetryableAssistantError(message) || !TRANSIENT_STREAM_ERROR_PATTERN.test(message.errorMessage)) {
		return message;
	}
	log.debug(`normalized transient error for retry: ${message.errorMessage}`);
	return { ...message, errorMessage: `${NETWORK_ERROR_PREFIX} ${message.errorMessage}` };
}

export function registerTransientErrorNormalizer(pi: ExtensionAPI, providerId: string): void {
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== providerId) {
			return;
		}
		const normalized = normalizeTransientError(message);
		if (normalized === message) {
			return;
		}
		return { message: normalized };
	});
}
