import { describe, expect, it } from "vitest";
import { FastModeController } from "../extensions/fast.ts";
import { buildStatusLabels } from "../extensions/index.ts";
import { PauseController } from "../extensions/pause.ts";

const PROVIDER = "cliproxyapi";

function fastModel(): FastModeController {
	const controller = new FastModeController(false);
	controller.setSupportedModelIds(["gpt-6.1-sol"]);
	return controller;
}

describe("buildStatusLabels", () => {
	it("shows nothing when the model belongs to another provider", () => {
		// The pause gate returns early for other providers, so no label may claim it.
		const pause = new PauseController(true);
		expect(buildStatusLabels({ provider: "anthropic", id: "claude" }, fastModel(), pause, PROVIDER)).toEqual({
			paused: false,
		});
	});

	it("shows nothing when no model is selected", () => {
		expect(buildStatusLabels(undefined, fastModel(), new PauseController(true), PROVIDER)).toEqual({ paused: false });
	});

	it("shows fast off on a Fast-capable model with Fast disabled", () => {
		const labels = buildStatusLabels(
			{ provider: PROVIDER, id: "gpt-6.1-sol" },
			fastModel(),
			new PauseController(),
			PROVIDER,
		);
		expect(labels).toEqual({ fast: "off", paused: false });
	});

	it("shows fast on when Fast is enabled for a capable model", () => {
		const fast = fastModel();
		fast.setEnabled(true);
		expect(
			buildStatusLabels({ provider: PROVIDER, id: "gpt-6.1-sol" }, fast, new PauseController(), PROVIDER),
		).toEqual({
			fast: "on",
			paused: false,
		});
	});

	it("omits the fast label for a model with no priority tier", () => {
		const labels = buildStatusLabels(
			{ provider: PROVIDER, id: "space-bunny" },
			fastModel(),
			new PauseController(),
			PROVIDER,
		);
		expect(labels).toEqual({ paused: false });
	});

	it("shows paused only for this provider's model", () => {
		const pause = new PauseController(true);
		expect(buildStatusLabels({ provider: PROVIDER, id: "space-bunny" }, fastModel(), pause, PROVIDER)).toEqual({
			paused: true,
		});
	});
});
