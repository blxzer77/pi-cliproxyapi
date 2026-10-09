/**
 * Logging helpers.
 *
 * Everything goes through here so a single switch can silence the extension.
 * Startup logging must stay quiet by default: anything written to stdout while
 * the TUI owns the terminal corrupts the display.
 */

const PREFIX = "[pi-cliproxyapi]";

let quiet = process.env.CLIPROXYAPI_QUIET === "1" || process.env.CLIPROXYAPI_QUIET === "true";

export function setQuiet(value: boolean): void {
	quiet = value;
}

export function isQuiet(): boolean {
	return quiet;
}

function write(stream: "warn" | "info" | "debug", message: string, detail?: unknown): void {
	if (quiet && stream !== "warn") {
		return;
	}
	const suffix = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : safeStringify(detail)}`;
	// A stray console write during streaming corrupts the TUI, so debug is opt-in only.
	if (stream === "debug" && !isDebugEnabled()) {
		return;
	}
	const line = `${PREFIX} ${message}${suffix}`;
	if (stream === "warn") {
		console.warn(line);
	} else {
		console.info(line);
	}
}

export function isDebugEnabled(): boolean {
	const raw = process.env.CLIPROXYAPI_DEBUG;
	return raw === "1" || raw === "true";
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export const log = {
	debug: (message: string, detail?: unknown): void => write("debug", message, detail),
	info: (message: string, detail?: unknown): void => write("info", message, detail),
	warn: (message: string, detail?: unknown): void => write("warn", message, detail),
};

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** pi invalidates a captured extension context after a session replacement. */
export function isStaleContextError(error: unknown): boolean {
	return errorMessage(error).includes("is stale after session replacement or reload");
}
