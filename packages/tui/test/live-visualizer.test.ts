import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { LiveVisualizer } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

describe("LiveVisualizer", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders across the entire provided width even when wider than 120 columns", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
		});

		for (const targetWidth of [80, 140, 200]) {
			const lines = visualizer.render(targetWidth);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
		}
	});

	it("wraps long speech to its last three lines instead of one truncated line", () => {
		const visualizer = new LiveVisualizer({ onStop: () => {}, onToggleMute: () => {} });
		const width = 40;
		visualizer.setTranscript("short");
		const shortLines = visualizer.render(width);

		const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
		visualizer.setTranscript(words.join(" "));
		const lines = visualizer.render(width);
		const text = lines.map(line => Bun.stripANSI(line)).join("\n");

		expect(lines.length).toBe(shortLines.length + 2);
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
		expect(text).toContain("word59");
		expect(text).toContain("…");
		expect(text).not.toContain("word0 ");
	});
});
