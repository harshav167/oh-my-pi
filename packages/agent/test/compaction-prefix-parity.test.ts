/**
 * The compaction request's rendered prefix must be byte-identical to the live
 * turn's, or OpenAI's prompt cache misses from the first token and native
 * compaction pays full price.
 *
 * The live turn maps `systemPrompt[0]` to `instructions` and emits
 * `systemPrompt[1..]` as leading `developer` input items; Responses Lite then
 * folds `instructions` into a synthetic developer item behind an
 * `additional_tools` marker. Both shapes are covered here: a single-block or
 * non-Lite-only test passes against the very bug this file exists to catch.
 */

import { describe, expect, test } from "bun:test";
import { buildCompactionV2Request, buildCompactionV2RequestBody } from "@oh-my-pi/pi-agent-core/compaction/openai";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";

const SESSION_ID = "prefix-parity-session";
const THREE_BLOCKS = ["BASE", "PROJECT FOOTER", "REPO CONTEXT"];

function makeCodexModel(overrides: Partial<ModelSpec<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.example/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 372000,
		maxTokens: 128000,
		useResponsesLite: false,
		remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
		...overrides,
	});
}

function makeContext(systemPrompt: string[]): Context {
	return {
		systemPrompt,
		messages: [{ role: "user", content: "Start the turn", timestamp: 0 }],
	};
}

/** Text of each leading `developer` item, skipping Lite's `additional_tools` marker. */
function leadingDeveloperTexts(input: unknown): string[] {
	const items = Array.isArray(input) ? input : [];
	const texts: string[] = [];
	for (const item of items) {
		if (!isRecord(item)) break;
		if (item.type === "additional_tools") continue;
		if (item.role !== "developer") break;
		const parts = Array.isArray(item.content) ? item.content : [];
		const chunks: string[] = [];
		for (const part of parts) {
			if (isRecord(part) && part.type === "input_text" && typeof part.text === "string") {
				chunks.push(part.text);
			}
		}
		texts.push(chunks.join("\n"));
	}
	return texts;
}

/** Conversation items after the rendered prompt prefix. */
function historyTail(input: unknown): unknown[] {
	const items = Array.isArray(input) ? input : [];
	let index = 0;
	while (index < items.length) {
		const item = items[index];
		if (!isRecord(item)) break;
		if (item.type !== "additional_tools" && item.role !== "developer") break;
		index += 1;
	}
	return items.slice(index);
}

function makeCompactionRequest(model: Model, input: unknown[], promptBlocks: string[]) {
	return buildCompactionV2Request(model, input, promptBlocks, {
		sessionId: SESSION_ID,
		promptCacheKey: SESSION_ID,
		retainedMessageBudget: 100,
	});
}

async function buildBothBodies(model: Model<"openai-codex-responses">, blocks: string[]) {
	const liveBody = await buildTransformedCodexRequestBody(model, makeContext(blocks), {
		sessionId: SESSION_ID,
		promptCacheKey: SESSION_ID,
	});
	const compactionBody = buildCompactionV2RequestBody(
		model,
		makeCompactionRequest(model, historyTail(liveBody.input), blocks),
	);
	return { liveBody, compactionBody };
}

describe("compaction prefix parity", () => {
	test("non-Lite: secondary blocks lead the compaction input exactly as the live turn", async () => {
		const { liveBody, compactionBody } = await buildBothBodies(makeCodexModel(), THREE_BLOCKS);

		expect(liveBody.instructions).toBe("BASE");
		expect(compactionBody.instructions).toBe("BASE");
		expect(leadingDeveloperTexts(liveBody.input)).toEqual(["PROJECT FOOTER", "REPO CONTEXT"]);
		expect(leadingDeveloperTexts(compactionBody.input)).toEqual(leadingDeveloperTexts(liveBody.input));
	});

	test("Lite: the synthetic primary and every secondary block appear once, in live order", async () => {
		const model = makeCodexModel({ useResponsesLite: true });
		const { liveBody, compactionBody } = await buildBothBodies(model, THREE_BLOCKS);

		// Lite folds instructions into the input behind `additional_tools`.
		expect(liveBody.instructions).toBeUndefined();
		expect(compactionBody.instructions).toBeUndefined();
		const firstItem = Array.isArray(compactionBody.input) ? compactionBody.input[0] : undefined;
		expect(isRecord(firstItem) ? firstItem.type : undefined).toBe("additional_tools");
		expect(leadingDeveloperTexts(liveBody.input)).toEqual(THREE_BLOCKS);
		expect(leadingDeveloperTexts(compactionBody.input)).toEqual(leadingDeveloperTexts(liveBody.input));

		// Guards the double-prepend: Lite synthesizes the primary itself, so a
		// pre-composed primary would surface it twice.
		const primaryCount = leadingDeveloperTexts(compactionBody.input).filter(text => text === "BASE").length;
		expect(primaryCount).toBe(1);
	});

	test("non-Lite single block: no developer items are invented", async () => {
		const { liveBody, compactionBody } = await buildBothBodies(makeCodexModel(), ["BASE"]);

		expect(liveBody.instructions).toBe("BASE");
		expect(compactionBody.instructions).toBe("BASE");
		expect(leadingDeveloperTexts(liveBody.input)).toEqual([]);
		expect(leadingDeveloperTexts(compactionBody.input)).toEqual([]);
	});

	test("Lite single block: only the synthetic primary leads the input", async () => {
		const model = makeCodexModel({ useResponsesLite: true });
		const { liveBody, compactionBody } = await buildBothBodies(model, ["BASE"]);

		expect(leadingDeveloperTexts(liveBody.input)).toEqual(["BASE"]);
		expect(leadingDeveloperTexts(compactionBody.input)).toEqual(["BASE"]);
	});
});
