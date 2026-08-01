import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { buildCursorHistoryForTest } from "@oh-my-pi/pi-ai/providers/cursor";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { NON_VIDEO_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A provider whose serializer cannot emit video must still tell the model the
// attachment existed. Dropping the block silently turns a video-only message
// into an empty one; throwing poisons every later turn, because the video stays
// in history. Ollama and Cursor dropped it, Bedrock threw.
const VIDEO_ONLY: Message = {
	role: "user",
	content: [{ type: "video", mimeType: "video/mp4", data: "AAAA" }],
	timestamp: 0,
};

interface OllamaMessagePayload {
	role?: string;
	content?: string;
}

function ollamaMessages(body: string): OllamaMessagePayload[] {
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || !("messages" in parsed)) return [];
	const messages: unknown = parsed.messages;
	if (!Array.isArray(messages)) return [];
	// Shape we just serialized in-process; nothing external reaches this.
	const typed = messages as OllamaMessagePayload[];
	return typed;
}

function countPlaceholders(haystack: string): number {
	return haystack.split(NON_VIDEO_PLACEHOLDER).length - 1;
}

function collectText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(collectText).join("\n");
	if (value && typeof value === "object") return Object.values(value).map(collectText).join("\n");
	return "";
}

describe("ollama video handling", () => {
	const model = buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});

	async function capture(messages: Message[]): Promise<OllamaMessagePayload[]> {
		let body = "";
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			body = String(init?.body);
			return new Response('{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		await streamOllama(model, { messages } satisfies Context, { apiKey: "test-key", fetch: fetchMock }).result();
		return ollamaMessages(body);
	}

	it("marks a video-only message once instead of sending an empty one", async () => {
		const messages = await capture([VIDEO_ONLY]);
		const user = messages.find(message => message.role === "user");
		expect(user?.content).toBe(NON_VIDEO_PLACEHOLDER);
	});

	it("appends exactly one marker alongside the surviving text", async () => {
		const messages = await capture([
			{
				role: "user",
				content: [
					{ type: "text", text: "what happens in this clip?" },
					{ type: "video", mimeType: "video/mp4", data: "AAAA" },
					{ type: "video", mimeType: "video/mp4", data: "BBBB" },
				],
				timestamp: 0,
			},
		]);
		const user = messages.find(message => message.role === "user");
		expect(user?.content).toContain("what happens in this clip?");
		expect(countPlaceholders(user?.content ?? "")).toBe(1);
	});
});

describe("cursor video handling", () => {
	it("marks an omitted video in the root prompt", () => {
		// Only messages before the active user message become root-prompt history,
		// so the video turn needs a later turn to be projected at all.
		const { rootPromptMessagesJson } = buildCursorHistoryForTest([
			VIDEO_ONLY,
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				timestamp: 1,
				api: "cursor-agent",
				provider: "cursor",
				model: "gemini-3-flash",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			{ role: "user", content: "and now?", timestamp: 2 },
		]);
		expect(countPlaceholders(collectText(rootPromptMessagesJson))).toBe(1);
	});
});

describe("bedrock video handling", () => {
	function model(): Model<"bedrock-converse-stream"> {
		return buildModel({
			id: "us.amazon.nova-lite-v1:0",
			name: "Nova Lite",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 300_000,
			maxTokens: 8192,
		});
	}

	// An already-aborted signal short-circuits after `onPayload` fires, so the
	// conversion runs with no network call. Conversion used to throw
	// `ValidationError` here, so no payload was ever produced.
	it("marks an omitted video once rather than throwing a validation error", async () => {
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const stream = streamBedrock(model(), { messages: [VIDEO_ONLY] } satisfies Context, {
			bearerToken: "test-token",
			signal: controller.signal,
			onPayload: payload => resolve(payload),
		});
		const drain = (async () => {
			try {
				for await (const _event of stream) {
					// Drain so the request-building path runs.
				}
			} catch (error) {
				// The aborted signal is the expected terminator; anything else is a
				// real failure and must not be hidden.
				if (!(error instanceof Error) || !/abort/i.test(error.message)) throw error;
			} finally {
				resolve(undefined);
			}
		})();
		const payload = await promise;
		await drain;
		expect(payload).toBeDefined();
		expect(countPlaceholders(collectText(payload))).toBe(1);
	});
});
