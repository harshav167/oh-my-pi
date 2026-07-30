import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "../config/settings";
import { LiveAgcMode, LiveEchoCancellationMode, LiveNoiseSuppressionLevel, resolveLiveConfig } from "./config";

describe("resolveLiveConfig", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("returns the working upstream defaults", () => {
		const config = resolveLiveConfig(Settings.instance);

		expect(config.model).toBe("gpt-live-1-codex");
		expect(config.voice).toBe("sol");
		expect(config.echoCancellationMode).toBe(LiveEchoCancellationMode.Full);
		expect(config.noiseSuppressionLevel).toBe(LiveNoiseSuppressionLevel.Moderate);
		expect(config.agcMode).toBe(LiveAgcMode.AdaptiveDigital);
		expect(config.continuityMaxItems).toBe(64);
		expect(config.continuityMaxTokens).toBe(4096);
	});

	it("clamps hand-edited numeric values at the live boundary", () => {
		Settings.instance.set("live.continuityMaxItems", 10_000);
		Settings.instance.set("live.continuityMaxTokens", -1);
		Settings.instance.set("live.vadStartRms", 3);
		Settings.instance.set("live.echoDelayMs", 900);
		Settings.instance.set("live.agcTargetLevelDbfs", 100);
		Settings.instance.set("live.agcCompressionGainDb", -4);
		Settings.instance.set("live.sidebandConnectAttempts", 0);

		const config = resolveLiveConfig(Settings.instance);

		expect(config.continuityMaxItems).toBe(128);
		expect(config.continuityMaxTokens).toBe(1);
		expect(config.vadStartRms).toBe(1);
		expect(config.echoDelayMs).toBe(500);
		expect(config.agcTargetLevelDbfs).toBe(31);
		expect(config.agcCompressionGainDb).toBe(0);
		expect(config.sidebandConnectAttempts).toBe(1);
	});
	it("requires an explicit delay for mobile echo cancellation", () => {
		Settings.instance.set("live.echoCancellationMode", "mobile");
		Settings.instance.set("live.echoDelayMs", 0);

		expect(() => resolveLiveConfig(Settings.instance)).toThrow(
			"live.echoDelayMs must be greater than zero when mobile echo cancellation is selected",
		);
	});
});
