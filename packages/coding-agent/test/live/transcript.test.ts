import { describe, expect, test } from "bun:test";
import { formatTranscriptDelta, LiveActiveTranscript, type LiveTranscriptEntry } from "../../src/live/transcript";

function entryBytes(entry: LiveTranscriptEntry): number {
	return Buffer.byteLength(entry.role) + Buffer.byteLength(entry.text) + 3;
}

describe("LiveActiveTranscript", () => {
	test("a delegation takes the conversation since the previous one", () => {
		const transcript = new LiveActiveTranscript();
		transcript.delta("user", "hello wor");
		transcript.done("user", "hello world");
		transcript.delta("assistant", "Sure");
		transcript.done("assistant", "Sure, on it");

		const entries = transcript.takeForDelegation("hello world");
		expect(entries).toEqual([
			{ role: "user", text: "hello world" },
			{ role: "assistant", text: "Sure, on it" },
		]);
		expect(formatTranscriptDelta(entries)).toBe("user: hello world\nassistant: Sure, on it");

		expect(transcript.takeForDelegation("then run the tests")).toEqual([
			{ role: "user", text: "then run the tests" },
		]);
		expect(formatTranscriptDelta([])).toBeUndefined();
	});

	test("a late final keeps newer speech it does not extend", () => {
		const transcript = new LiveActiveTranscript();
		transcript.delta("user", "first utterance");
		transcript.delta("user", " and more");
		transcript.done("user", "first utterance");

		expect(transcript.takeForDelegation("")).toEqual([{ role: "user", text: "first utterance and more" }]);
	});

	test("bounds the transcript to an 8 KiB suffix", () => {
		const transcript = new LiveActiveTranscript();
		transcript.delta("user", `old${"x".repeat(8 * 1024)}new`);

		const [entry] = transcript.takeForDelegation("");
		expect(entry?.text.startsWith("…")).toBe(true);
		expect(entry?.text.endsWith("new")).toBe(true);
		expect(entry ? entryBytes(entry) : 0).toBeLessThanOrEqual(8 * 1024);
	});

	test("equally recent speakers keep their suffixes within the budget", () => {
		const transcript = new LiveActiveTranscript();
		const frame = { startMs: 0, endMs: 200 };
		transcript.delta("user", "u".repeat(6000), frame);
		transcript.delta("assistant", "a".repeat(6000), frame);

		const entries = transcript.takeForDelegation("");
		expect(entries.map(entry => entry.role)).toEqual(["user", "assistant"]);
		for (const entry of entries) expect(entry.text.startsWith("…")).toBe(true);
		expect(entries.reduce((total, entry) => total + entryBytes(entry), 0)).toBeLessThanOrEqual(8 * 1024);
	});

	test("cuts the kept suffix on a character boundary", () => {
		// The 8182-byte suffix would start inside a 3-byte '€'; the cut moves forward to the next character.
		const transcript = new LiveActiveTranscript();
		transcript.delta("user", "€".repeat(3000));
		expect(transcript.takeForDelegation("")).toEqual([{ role: "user", text: `…${"€".repeat(2727)}` }]);
	});

	test("a final replaces truncated speech only when the cut lands on its character boundary", () => {
		const extended = new LiveActiveTranscript();
		extended.delta("user", "€".repeat(3000));
		extended.done("user", `${"€".repeat(3000)}!`);
		expect(extended.takeForDelegation("")).toEqual([{ role: "user", text: `…${"€".repeat(2727)}!` }]);

		// One leading byte shifts the dropped prefix's end inside a character of the final.
		const shifted = new LiveActiveTranscript();
		shifted.delta("user", "€".repeat(3000));
		shifted.done("user", `a${"€".repeat(3000)}`);
		expect(shifted.takeForDelegation("")).toEqual([{ role: "user", text: `…${"€".repeat(2727)}` }]);
	});
});
