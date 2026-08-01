import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
	HandoffSummaryMessageComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/compaction-summary-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionSummaryMessage, CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function makeHandoffMessage(content: CustomMessage<unknown>["content"]): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "handoff",
		content,
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

describe("handoff summary divider", () => {
	it("renders handoff custom messages with the compact divider instead of a framed block", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage(
				`<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>\n\nThe above is a handoff document.`,
			),
			false,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const collapsed = Bun.stripANSI(component!.render(80).join("\n"));
		expect(collapsed).toContain("handoff");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).not.toContain("[handoff]");
		expect(collapsed).not.toContain("Continue the resize fix");
	});

	it("expands to the handoff document without the provider-only XML wrapper", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage([
				{
					type: "text",
					text: "<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>",
				},
			]),
			true,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const expanded = Bun.stripANSI(component!.render(80).join("\n"));
		expect(expanded).toContain("Handoff context");
		expect(expanded).toContain("Continue the resize fix");
		expect(expanded).not.toContain("<handoff-context>");
		expect(expanded).not.toContain("</handoff-context>");
	});

	it("leaves unrelated custom messages on the generic renderer path", () => {
		const message = makeHandoffMessage("Not a handoff.");
		message.customType = "extension-note";

		expect(createHandoffSummaryMessageComponent(message, false)).toBeUndefined();
	});
});

describe("compaction summary divider", () => {
	it("renders the V2 usage metrics line when the message carries usage", () => {
		const message: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "Remote compaction preserved provider-native history for this session.",
			tokensBefore: 138423,
			timestamp: Date.now(),
			compactionV2Usage: {
				inputTokens: 366539,
				cachedInputTokens: 365312,
				cacheWriteInputTokens: 0,
				outputTokens: 2175,
				totalTokens: 368714,
				transport: "websocket",
				continuation: "delta",
			},
		};
		const component = new CompactionSummaryMessageComponent(message);
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(80).join("\n"));

		// The Markdown box wraps the line at the render width; collapse the
		// wrapping whitespace so the full metrics line is asserted as one unit.
		const normalized = expanded.replace(/\s+/g, " ");
		expect(normalized).toContain(
			"Compaction V2 · input 366,539 · cache read 365,312 (99.7%) · cache write 0 · output 2,175 · websocket delta",
		);
	});

	it("omits the metrics line when the message has no usage", () => {
		const message: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "Local summary.",
			tokensBefore: 1000,
			timestamp: Date.now(),
		};
		const component = new CompactionSummaryMessageComponent(message);
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(80).join("\n"));

		expect(expanded).not.toContain("Compaction V2 ·");
	});

	it("guards the ratio when input is zero", () => {
		const message: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "Empty.",
			tokensBefore: 0,
			timestamp: Date.now(),
			compactionV2Usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		};
		const component = new CompactionSummaryMessageComponent(message);
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(80).join("\n"));

		expect(expanded).toContain("cache read 0 (0.0%)");
	});
});
