import { beforeAll, describe, expect, it } from "bun:test";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { type CustomMessage, LIVE_DELEGATION_MESSAGE_TYPE } from "@oh-my-pi/pi-tui/chat/messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

function delegation(details: unknown): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: LIVE_DELEGATION_MESSAGE_TYPE,
		content: "explain the configs",
		display: true,
		details,
		attribution: "agent",
		timestamp: 1,
	};
}

function renderedText(message: CustomMessage<unknown>): string {
	return new CustomMessageComponent(message)
		.render(80)
		.map(line => Bun.stripANSI(line).trim())
		.join("\n");
}

describe("live voice request row", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("shows what the user said above the voice model's request text", () => {
		const spoken = ["I just restarted", "how verbose or terse, explain the configs"];
		const text = renderedText(
			delegation({ transcriptDelta: spoken.map(line => `user: ${line}`).join("\n"), spoken }),
		);
		const first = text.indexOf(spoken[0]);
		const second = text.indexOf(spoken[1]);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(first);
		// The request text appears again on its own, after the last utterance.
		expect(text.indexOf("explain the configs", second + spoken[1].length)).toBeGreaterThan(-1);
		expect(text.split("\n").every(line => !line.trimStart().startsWith(">"))).toBe(true);
	});

	it("renders a short prior utterance and the full request as plain text", () => {
		const text = renderedText({
			...delegation({ spoken: ["Hello"] }),
			content: "Can you sync this branch to upstream main first?",
		});
		expect(text.indexOf("Hello")).toBeLessThan(text.indexOf("Can you sync"));
		expect(text.split("\n").every(line => !line.trimStart().startsWith(">"))).toBe(true);
	});

	it("shows only the request text for requests recorded without speech", () => {
		for (const details of [{ transcriptDelta: "user: explain the configs" }, { spoken: [] }, undefined]) {
			const text = renderedText(delegation(details));
			expect(text.split("explain the configs").length - 1).toBe(1);
		}
	});
});
