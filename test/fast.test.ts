import { describe, expect, it } from "vitest";
import { FastModeController, withPriorityServiceTier } from "../extensions/fast.ts";

describe("FastModeController.stateFor", () => {
	it("says on or off for a Fast-capable model, following the switch", () => {
		const fast = new FastModeController(false);
		fast.setSupportedModelIds(["gpt-6.1-sol"]);
		expect(fast.stateFor("gpt-6.1-sol")).toBe("off");
		fast.setEnabled(true);
		expect(fast.stateFor("gpt-6.1-sol")).toBe("on");
	});

	it("says nothing for a model without a priority tier, whichever way the switch is set", () => {
		const fast = new FastModeController(true);
		fast.setSupportedModelIds(["gpt-6.1-sol"]);
		expect(fast.stateFor("deepseek-flash")).toBeUndefined();
		fast.setEnabled(false);
		expect(fast.stateFor("deepseek-flash")).toBeUndefined();
	});

	it("matches model ids case-insensitively and follows a catalog refresh", () => {
		const fast = new FastModeController(true);
		fast.setSupportedModelIds(["GPT-6.1-Sol"]);
		expect(fast.stateFor("gpt-6.1-sol")).toBe("on");
		fast.setSupportedModelIds([]);
		expect(fast.stateFor("gpt-6.1-sol")).toBeUndefined();
	});

	it("only changes the wire request when the switch is on and the model is capable", () => {
		const fast = new FastModeController(false);
		fast.setSupportedModelIds(["gpt-6.1-sol"]);
		expect(fast.isEffectiveFor("gpt-6.1-sol")).toBe(false);
		fast.setEnabled(true);
		expect(fast.isEffectiveFor("gpt-6.1-sol")).toBe(true);
		expect(fast.isEffectiveFor("deepseek-flash")).toBe(false);
	});
});

describe("withPriorityServiceTier", () => {
	it("adds the priority tier without mutating the payload", () => {
		const payload = { model: "gpt-6.1-sol", input: [] };
		expect(withPriorityServiceTier(payload)).toEqual({ ...payload, service_tier: "priority" });
		expect(payload).not.toHaveProperty("service_tier");
	});

	it("leaves a non-object payload alone", () => {
		expect(withPriorityServiceTier(undefined)).toBeUndefined();
		expect(withPriorityServiceTier([1])).toEqual([1]);
	});
});
