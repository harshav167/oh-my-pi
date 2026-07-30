import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { LIVE_DELEGATION_MESSAGE_TYPE, LIVE_TRANSCRIPT_MESSAGE_TYPE } from "../session/messages";
import { buildLiveInitialItems } from "./continuity";

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function voiceTurn(role: "user" | "assistant", text: string, timestamp = 1): AgentMessage {
	return {
		role: "custom",
		customType: LIVE_TRANSCRIPT_MESSAGE_TYPE,
		content: text,
		display: false,
		details: { role, text },
		timestamp,
	} as unknown as AgentMessage;
}

describe("buildLiveInitialItems", () => {
	it("seeds the summary followed by voice turns in spoken order", () => {
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "Condensed history",
				shortSummary: "Short",
				tokensBefore: 900,
				timestamp: 1,
			},
			voiceTurn("user", "Earlier question", 2),
			voiceTurn("assistant", "Earlier answer", 3),
			voiceTurn("user", "Newest question", 4),
		];

		expect(buildLiveInitialItems(messages, { maxItems: 4, maxTokens: 100 })).toEqual([
			{ role: "developer", text: "Session compaction summary:\nCondensed history" },
			{ role: "user", text: "Earlier question" },
			{ role: "assistant", text: "Earlier answer" },
			{ role: "user", text: "Newest question" },
		]);
	});

	it("excludes ordinary coding messages so the voice model is not fed a code transcript", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "refactor the parser", timestamp: 1 },
			assistant("I refactored src/parser.ts"),
			voiceTurn("user", "what did you change", 3),
		];

		expect(buildLiveInitialItems(messages, { maxItems: 8, maxTokens: 100 })).toEqual([
			{ role: "user", text: "what did you change" },
		]);
	});

	it("excludes internal delegation envelopes", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: LIVE_DELEGATION_MESSAGE_TYPE,
				content: "<realtime_delegation><input>inspect</input></realtime_delegation>",
				display: false,
				timestamp: 1,
			} as unknown as AgentMessage,
			voiceTurn("user", "spoken", 2),
		];

		expect(buildLiveInitialItems(messages, { maxItems: 8, maxTokens: 100 })).toEqual([
			{ role: "user", text: "spoken" },
		]);
	});

	it("only considers turns after the newest compaction summary", () => {
		const messages: AgentMessage[] = [
			voiceTurn("user", "before compaction", 1),
			{ role: "compactionSummary", summary: "Condensed", tokensBefore: 900, timestamp: 2 },
			voiceTurn("user", "after compaction", 3),
		];

		expect(buildLiveInitialItems(messages, { maxItems: 8, maxTokens: 100 })).toEqual([
			{ role: "developer", text: "Session compaction summary:\nCondensed" },
			{ role: "user", text: "after compaction" },
		]);
	});

	it("truncates the newest turn rather than skipping it for older context", () => {
		const messages: AgentMessage[] = [voiceTurn("user", "older but small", 1), voiceTurn("user", "n".repeat(400), 2)];

		const items = buildLiveInitialItems(messages, { maxItems: 8, maxTokens: 10 });

		expect(items).toHaveLength(1);
		expect(items[0]?.text.startsWith("n")).toBe(true);
		expect(Buffer.byteLength(items[0]?.text ?? "")).toBeLessThanOrEqual(40);
	});

	it("keeps a truncated summary within the aggregate token ceiling", () => {
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "summary".repeat(100), tokensBefore: 900, timestamp: 1 },
		];

		const items = buildLiveInitialItems(messages, { maxItems: 1, maxTokens: 1 });
		const totalTokens = items.reduce((total, item) => total + Math.ceil(Buffer.byteLength(item.text, "utf8") / 4), 0);

		expect(totalTokens).toBeLessThanOrEqual(1);
	});

	it("reserves budget for the transcript tail when the summary is long", () => {
		// One shared allowance let a verbose compaction summary consume everything
		// and drop the newest spoken turns, which reads as the model having
		// forgotten the last thing it was told.
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "S".repeat(8_000),
				shortSummary: "Short",
				tokensBefore: 9_000,
				timestamp: 1,
			} as unknown as AgentMessage,
			voiceTurn("user", "What did we just decide?", 2),
		];

		const items = buildLiveInitialItems(messages, { maxItems: 8, maxTokens: 200 });

		expect(items.at(-1)).toEqual({ role: "user", text: "What did we just decide?" });
		expect(items).toHaveLength(2);
	});

	it("gives the only slot to the newest live turn, not the summary", () => {
		// `maxItems` clamps to 1, and pushing the summary first consumed that slot
		// before the candidate loop could run — the live conversation vanished while
		// a stale summary survived.
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "Condensed history",
				shortSummary: "Short",
				tokensBefore: 900,
				timestamp: 1,
			} as unknown as AgentMessage,
			voiceTurn("user", "Latest spoken turn", 2),
		];

		const items = buildLiveInitialItems(messages, { maxItems: 1, maxTokens: 4_000 });

		expect(items).toEqual([{ role: "user", text: "Latest spoken turn" }]);
	});

	it("still seeds the summary when there is no live turn to protect", () => {
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "Condensed history",
				shortSummary: "Short",
				tokensBefore: 900,
				timestamp: 1,
			} as unknown as AgentMessage,
		];

		const items = buildLiveInitialItems(messages, { maxItems: 1, maxTokens: 4_000 });

		expect(items).toHaveLength(1);
		expect(items[0]?.role).toBe("developer");
	});
});
