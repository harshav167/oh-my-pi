/**
 * xai-grok-cli wire: Build host, encrypted reasoning, concise summary,
 * static fingerprint + lifecycle headers.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

afterEach(() => {
	vi.restoreAllMocks();
});

const FIXED_TIMESTAMP = 1_700_000_000_000;

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: FIXED_TIMESTAMP }],
};

function makeCliModel(): Model<"openai-responses"> {
	return buildModel({
		id: "grok-4.5",
		name: "Grok 4.5",
		provider: "xai-grok-cli",
		baseUrl: "https://cli-chat-proxy.grok.com/v1",
		api: "openai-responses",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 500_000,
		headers: {
			"x-xai-token-auth": "xai-grok-cli",
			"x-authenticateresponse": "authenticate-response",
			"x-grok-client-mode": "interactive",
			"x-compaction-at": "400000",
			"x-grok-client-version": "0.2.99",
			"x-grok-client-identifier": "grok-pager",
			"user-agent": "grok-pager/0.2.99 grok-shell/0.2.99 (macos; aarch64)",
		},
		compat: {
			includeEncryptedReasoning: true,
			filterReasoningHistory: false,
			supportsReasoningEffort: true,
		},
	} as ModelSpec<"openai-responses">);
}

async function getRequestBody(input: string | URL | Request, init?: RequestInit): Promise<Record<string, unknown>> {
	if (input instanceof Request) {
		return (await input.clone().json()) as Record<string, unknown>;
	}
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function getRequestHeaders(input: string | URL | Request, init?: RequestInit): Headers {
	if (input instanceof Request) return input.headers;
	return new Headers(init?.headers);
}

function createUnauthorizedResponse(): Response {
	return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
		status: 401,
		headers: { "Content-Type": "application/json" },
	});
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("xai-grok-cli wire", () => {
	it("targets Build host with fingerprint and lifecycle headers", async () => {
		let url = "";
		let headers: Headers | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			url = input instanceof Request ? input.url : String(input);
			headers = getRequestHeaders(input, init);
			return createUnauthorizedResponse();
		});

		await streamOpenAIResponses(makeCliModel(), testContext, {
			apiKey: "xai-oauth-access",
			sessionId: "session-abc",
			promptCacheKey: "pcache-xyz",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(url).toContain("cli-chat-proxy.grok.com");
		expect(headers?.get("x-xai-token-auth")).toBe("xai-grok-cli");
		expect(headers?.get("x-grok-client-identifier")).toBe("grok-pager");
		expect(headers?.get("x-grok-session-id")).toBe("pcache-xyz");
		expect(headers?.get("x-grok-conv-id")).toBe("pcache-xyz");
		expect(headers?.get("x-grok-model-override")).toBe("grok-4.5");
		expect(headers?.get("x-grok-req-id")).toBeTruthy();
		expect(headers?.get("x-grok-agent-id")).toBeTruthy();
		expect(headers?.get("x-grok-turn-idx")).toBe("0");
	});

	it("includes encrypted reasoning, store false, and concise summary", async () => {
		let body: Record<string, unknown> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			body = await getRequestBody(input, init);
			return createUnauthorizedResponse();
		});

		await streamOpenAIResponses(makeCliModel(), testContext, {
			apiKey: "xai-oauth-access",
			reasoning: "high",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(body.store).toBe(false);
		expect((body.include as string[] | undefined)?.includes("reasoning.encrypted_content")).toBe(true);
		const reasoning = body.reasoning as { summary?: string } | undefined;
		expect(reasoning?.summary).toBe("concise");
	});

	it("does not inject reasoning summary when reasoning is omitted", async () => {
		let body: Record<string, unknown> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			body = await getRequestBody(input, init);
			return createUnauthorizedResponse();
		});

		await streamOpenAIResponses(makeCliModel(), testContext, {
			apiKey: "xai-oauth-access",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		// No caller reasoning → no forced medium-effort reasoning object from summary alone.
		const reasoning = body.reasoning as { summary?: string; effort?: string } | undefined;
		if (reasoning) {
			expect(reasoning.summary).not.toBe("concise");
		}
	});

	it("increments turn-idx and preserves encrypted reasoning history", async () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_enc_1",
			summary: [{ type: "summary_text", text: "thinking" }],
			encrypted_content: "enc-blob-test",
		};
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "thinking",
					thinkingSignature: JSON.stringify(reasoningItem),
					itemId: "rs_enc_1",
				},
				{ type: "text", text: "answer" },
			],
			api: "openai-responses",
			provider: "xai-grok-cli",
			model: "grok-4.5",
			stopReason: "stop",
			usage: zeroUsage(),
			timestamp: FIXED_TIMESTAMP + 1,
		};
		const multiTurn: Context = {
			messages: [
				{ role: "user", content: "q1", timestamp: FIXED_TIMESTAMP },
				priorAssistant,
				{ role: "user", content: "q2", timestamp: FIXED_TIMESTAMP + 2 },
			],
		};

		let headers: Headers | undefined;
		let body: Record<string, unknown> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			headers = getRequestHeaders(input, init);
			body = await getRequestBody(input, init);
			return createUnauthorizedResponse();
		});

		await streamOpenAIResponses(makeCliModel(), multiTurn, {
			apiKey: "xai-oauth-access",
			sessionId: "sess-2",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(headers?.get("x-grok-turn-idx")).toBe("1");
		const input = body.input as Record<string, unknown>[];
		const reasoningItems = input.filter(item => item.type === "reasoning");
		expect(reasoningItems.length).toBeGreaterThan(0);
		expect(reasoningItems[0]?.encrypted_content).toBe("enc-blob-test");
	});
});
