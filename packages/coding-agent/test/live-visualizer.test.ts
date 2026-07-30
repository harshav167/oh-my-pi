import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { LiveVisualizer } from "../src/live/visualizer";
import { initTheme } from "../src/modes/theme/theme";

describe("LiveVisualizer", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders across the entire provided width even when wider than 120 columns", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
			onToggleOutputMute: () => {},
			onRefreshMicrophone: () => {},
			onRetry: () => {},
		});

		for (const targetWidth of [80, 140, 200]) {
			const lines = visualizer.render(targetWidth);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
		}
	});

	it("routes r to retry on a failed start and to microphone refresh otherwise", () => {
		// A failed start has no microphone to refresh, and without a retry route the
		// error panel offered no recovery at all — only Escape.
		const pressed: string[] = [];
		const visualizer = new LiveVisualizer({
			onStop: () => pressed.push("stop"),
			onToggleMute: () => {},
			onToggleOutputMute: () => {},
			onRefreshMicrophone: () => pressed.push("refresh"),
			onRetry: () => pressed.push("retry"),
		});

		visualizer.handleInput("r");
		visualizer.setState({
			connection: "error",
			voice: "listening",
			worker: "idle",
			inputMuted: false,
			outputMuted: false,
		});
		visualizer.handleInput("r");

		expect(pressed).toEqual(["refresh", "retry"]);
	});

	it("offers retry and back in the footer only while the call is failed", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
			onToggleOutputMute: () => {},
			onRefreshMicrophone: () => {},
			onRetry: () => {},
		});

		const connecting = visualizer.render(120).join("\n");
		visualizer.setState({
			connection: "error",
			voice: "listening",
			worker: "idle",
			inputMuted: false,
			outputMuted: false,
		});
		const failed = visualizer.render(120).join("\n");

		expect(connecting).not.toContain("retry");
		expect(failed).toContain("r retry");
		expect(failed).toContain("esc back");
	});
});
