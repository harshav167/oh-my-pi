import { describe, expect, test } from "bun:test";
import { renderRealtimeDelegation, spokenSinceLastRequest } from "../../src/live/delegation";
import { convertToLlm } from "../../src/session/messages";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (block.type === "text" ? block.text : "")).join("");
}

describe("Codex realtime delegation input", () => {
	test("renders the request with and without the transcript since the previous one", () => {
		expect(renderRealtimeDelegation("fix the build", "user: fix the build\nassistant: on it")).toBe(
			"<realtime_delegation>\n  <input>fix the build</input>\n  <transcript_delta>user: fix the build\nassistant: on it</transcript_delta>\n</realtime_delegation>",
		);
		expect(renderRealtimeDelegation("fix the build", undefined)).toBe(
			"<realtime_delegation>\n  <input>fix the build</input>\n</realtime_delegation>",
		);
	});

	test("escapes markup and caps each field at 4 KiB from the side Codex keeps", () => {
		expect(renderRealtimeDelegation(`a < b && "c" > d`, undefined)).toContain(
			`<input>a &lt; b &amp;&amp; "c" &gt; d</input>`,
		);

		const rendered = renderRealtimeDelegation("x".repeat(5000), `${"y".repeat(5000)}END`);
		const input = /<input>(.*)<\/input>/s.exec(rendered)?.[1] ?? "";
		const delta = /<transcript_delta>(.*)<\/transcript_delta>/s.exec(rendered)?.[1] ?? "";
		expect(Buffer.byteLength(input)).toBe(4 * 1024);
		expect(input.endsWith("…")).toBe(true);
		expect(Buffer.byteLength(delta)).toBe(4 * 1024);
		expect(delta.startsWith("…")).toBe(true);
		expect(delta.endsWith("END")).toBe(true);
	});

	test("cuts capped fields on character boundaries", () => {
		// The 4093 bytes kept beside the marker end inside a 3-byte '€' at either side.
		const rendered = renderRealtimeDelegation("€".repeat(2000), `${"€".repeat(2000)}END`);
		expect(/<input>(.*)<\/input>/s.exec(rendered)?.[1]).toBe(`${"€".repeat(1364)}…`);
		expect(/<transcript_delta>(.*)<\/transcript_delta>/s.exec(rendered)?.[1]).toBe(`…${"€".repeat(1363)}END`);
	});
});

describe("speech shown on the request row", () => {
	test("keeps every user utterance the voice model shortened its request from", () => {
		// Shape of a real handoff: the request text was an excerpt of the second utterance, and
		// the transcript also carried that excerpt appended as its own line.
		const request = "some skill regarding explaining what are all the configs";
		const spoken = spokenSinceLastRequest(
			[
				{ role: "user", text: " I mean, I just restarted the session. I'd like the how" },
				{ role: "assistant", text: " Mm-hmm." },
				{
					role: "user",
					text: " verbose or how terse, like some skill regarding explaining what are all the configs",
				},
				{ role: "assistant", text: " Mm." },
				{ role: "user", text: request },
			],
			request,
		);
		expect(spoken).toEqual([
			"I mean, I just restarted the session. I'd like the how",
			"verbose or how terse, like some skill regarding explaining what are all the configs",
		]);
	});

	test("is empty when the request is everything the user said", () => {
		expect(spokenSinceLastRequest([{ role: "user", text: " fix the build " }], "fix the build")).toEqual([]);
	});
});

describe("voice requests in the main agent's model view", () => {
	const delegation = {
		role: "custom" as const,
		customType: "live-delegation",
		content: "fix the build",
		display: true,
		details: { transcriptDelta: "user: fix the build", voiceStart: true },
		attribution: "agent" as const,
		timestamp: 1,
	};

	test("the first request of a voice session carries Codex's start instructions, then user input", () => {
		const [start, request, ...rest] = convertToLlm([delegation]);
		expect(rest).toEqual([]);
		expect(start?.role).toBe("developer");
		expect(textOf(start?.content)).toStartWith("<realtime_conversation>\nRealtime conversation started.\n");
		expect(textOf(start?.content)).toEndWith("\n</realtime_conversation>");
		expect(request?.role).toBe("user");
		expect(textOf(request?.content)).toBe(
			"<realtime_delegation>\n  <input>fix the build</input>\n  <transcript_delta>user: fix the build</transcript_delta>\n</realtime_delegation>",
		);
	});

	test("later requests are user input only, and malformed details are ignored", () => {
		const messages = convertToLlm([{ ...delegation, details: { transcriptDelta: 42, voiceStart: "yes" } }]);
		expect(messages.map(message => message.role)).toEqual(["user"]);
		expect(textOf(messages[0]?.content)).toBe(
			"<realtime_delegation>\n  <input>fix the build</input>\n</realtime_delegation>",
		);
	});
});
