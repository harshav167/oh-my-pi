import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	getCodexPreparedPromptBlocks,
	getOpenAICodexTransportDetails,
	hydrateCodexCompactionOptions,
	prewarmOpenAICodexResponses,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type {
	CodexCompactionRequestContext,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(
	overrides: Partial<Model<"openai-codex-responses">> = {},
): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
		...overrides,
	});
}

function createCodexTestContext(systemPrompt: string[], userText = "Say hello"): Context {
	return {
		systemPrompt,
		messages: [{ role: "user", content: userText, timestamp: Date.now() }],
	};
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

type WsHeaders = Record<string, string>;
type WsOptions = { headers?: WsHeaders; proxy?: string };
type WsEventType = "open" | "message" | "error" | "close";

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";

	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: WsOptions,
	) {}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	emit(type: WsEventType, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
	}

	scheduleOpen(): void {
		setTimeout(() => {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open", new Event("open"));
		}, 0);
	}

	sendMessage(data: unknown): void {
		this.emit("message", { data } as unknown as MessageEvent);
	}

	sendJson(payload: Record<string, unknown>): void {
		this.sendMessage(JSON.stringify(payload));
	}

	emitCodexResponse(opts: { messageId: string; responseId: string; text: string; includeCreated?: boolean }): void {
		const { messageId, responseId, text, includeCreated = true } = opts;
		if (includeCreated) {
			this.sendJson({ type: "response.created", response: { id: responseId } });
		}
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		});
		this.sendJson({ type: "response.completed", response: { id: responseId, status: "completed" } });
	}
}

const COMPACTION: CodexCompactionRequestContext = {
	operationId: "op-1",
	trigger: "auto",
	reason: "context_limit",
	phase: "mid_turn",
	strategy: "memento",
	hasPendingLocalInput: false,
	implementation: "responses_compaction_v2",
};

describe("prepared prompt-blocks capture lifecycle", () => {
	it("captures the live turn's instructions and serves them until the turn rotates", async () => {
		const tempDir = TempDir.createSync("@codex-prepared-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sse = createCompletedCodexSse("Hello");
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const model = { ...createCodexTestModel(), preferWebsockets: false };
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "prepared-session";

		const first = await streamOpenAICodexResponses(model, createCodexTestContext(["You are a helpful assistant."]), {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
			sessionId,
			providerSessionState,
		}).result();
		expect(first.stopReason).toBe("stop");
		expect(getCodexPreparedPromptBlocks(providerSessionState, sessionId)).toEqual(["You are a helpful assistant."]);

		// A compaction-kind request must not overwrite the capture.
		await streamOpenAICodexResponses(model, createCodexTestContext(["You are a helpful assistant."], "compact me"), {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
			sessionId,
			providerSessionState,
			codexCompaction: COMPACTION,
		}).result();
		expect(getCodexPreparedPromptBlocks(providerSessionState, sessionId)).toEqual(["You are a helpful assistant."]);

		// A new turn with no system prompt rotates turnId without capturing:
		// the stale capture must be invalidated, not served.
		await streamOpenAICodexResponses(model, createCodexTestContext([], "no prompt turn"), {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
			sessionId,
			providerSessionState,
		}).result();
		// A promptless turn captures `[]` — the faithful record of what it sent —
		// so the stale prior capture is invalidated rather than served.
		expect(getCodexPreparedPromptBlocks(providerSessionState, sessionId)).toEqual([]);
	});

	it("captures the Lite relocated instructions over SSE", async () => {
		const tempDir = TempDir.createSync("@codex-prepared-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sse = createCompletedCodexSse("Hello");
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const model = { ...createCodexTestModel(), preferWebsockets: false };
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "prepared-lite-session";

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(["You are a helpful assistant."]), {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
			sessionId,
			providerSessionState,
			responsesLite: true,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(getCodexPreparedPromptBlocks(providerSessionState, sessionId)).toEqual(["You are a helpful assistant."]);
	});

	it("keeps the WS onPayload contract: full frame with instructions, delta on the wire", async () => {
		const tempDir = TempDir.createSync("@codex-prepared-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const hookPayloads: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class PreparedWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_${responseIndex}`,
					responseId: `resp_${responseIndex}`,
					text: responseIndex === 1 ? "First answer" : "Second answer",
				});
			}
		}

		global.WebSocket = PreparedWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "prepared-ws-session";
		try {
			const first = await streamOpenAICodexResponses(
				model,
				createCodexTestContext(["You are a helpful assistant."]),
				{
					apiKey: token,
					fetch: fetchMock as FetchImpl,
					sessionId,
					providerSessionState,
					responsesLite: true,
					onPayload: async payload => {
						hookPayloads.push(payload as Record<string, unknown>);
						return undefined;
					},
				},
			).result();
			expect(first.stopReason).toBe("stop");

			const secondContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					...createCodexTestContext(["You are a helpful assistant."]).messages,
					first,
					{ role: "user", content: "Second question", timestamp: Date.now() },
				],
			};
			const second = await streamOpenAICodexResponses(model, secondContext, {
				apiKey: token,
				fetch: fetchMock as FetchImpl,
				sessionId,
				providerSessionState,
				responsesLite: true,
				onPayload: async payload => {
					hookPayloads.push(payload as Record<string, unknown>);
					return undefined;
				},
			}).result();
			expect(second.stopReason).toBe("stop");

			// Hook contract: onPayload still sees the chained delta frame (unchanged
			// from before this change) — type wrapper, previous_response_id, delta input.
			expect(hookPayloads).toHaveLength(2);
			expect(hookPayloads[1]?.type).toBe("response.create");
			expect(hookPayloads[1]?.previous_response_id).toBe("resp_1");
			const hookDelta = hookPayloads[1]?.input as Array<{ role?: string }>;
			expect(hookDelta).toHaveLength(1);
			expect(hookDelta[0]?.role).toBe("user");

			// Wire contract: the sent second frame is a delta without the instructions item.
			expect(sentRequests).toHaveLength(2);
			expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
			const deltaItems = sentRequests[1]?.input as Array<{ role?: string }>;
			expect(deltaItems).toHaveLength(1);
			expect(deltaItems[0]?.role).toBe("user");
			expect(JSON.stringify(deltaItems)).not.toContain("You are a helpful assistant.");

			// Capture still worked on the appendable Lite path (pre-chain full frame).
			expect(getCodexPreparedPromptBlocks(providerSessionState, sessionId)).toEqual([
				"You are a helpful assistant.",
			]);
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
		}
	});

	it("warm request with non-default options makes the next turn chain from it", async () => {
		const tempDir = TempDir.createSync("@codex-prepared-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class WarmWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(frame);
				if (frame.generate === false) {
					this.sendJson({ type: "response.completed", response: { id: "resp-warm", status: "completed" } });
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_1",
					responseId: "resp_1",
					text: "main",
				});
			}
		}

		global.WebSocket = WarmWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "warm-chain-session";
		const firstTimestamp = Date.now();
		// Non-default options on BOTH the warm and the next turn: strict parity is
		// the whole point of threading reasoning/summary/verbosity/tier through.
		// The warm messages mirror the turn's leading messages (an empty-message
		// warm would get the transformer's final-instruction injection and diverge).
		const parityOptions = {
			reasoning: "medium",
			reasoningSummary: "detailed",
			textVerbosity: "high",
			serviceTier: "priority",
		} as const;
		try {
			await prewarmOpenAICodexResponses(model, {
				apiKey: token,
				sessionId,
				providerSessionState,
				responsesLite: true,
				warmRequest: {
					systemPrompt: ["You are a helpful assistant."],
					tools: [],
					messages: [{ role: "user", content: "First question", timestamp: firstTimestamp }],
					...parityOptions,
				},
			});
			expect(sentRequests).toHaveLength(1);
			expect(sentRequests[0]?.generate).toBe(false);
			expect(sentRequests[0]?.previous_response_id).toBeUndefined();
			expect(getOpenAICodexTransportDetails(model, { sessionId, providerSessionState }).canAppend).toBe(true);

			const result = await streamOpenAICodexResponses(
				model,
				{
					systemPrompt: ["You are a helpful assistant."],
					messages: [
						{ role: "user", content: "First question", timestamp: firstTimestamp },
						{ role: "user", content: "Second question", timestamp: Date.now() },
					],
				},
				{
					apiKey: token,
					fetch: fetchMock as FetchImpl,
					sessionId,
					providerSessionState,
					responsesLite: true,
					...parityOptions,
				},
			).result();
			expect(result.stopReason).toBe("stop");

			// Strict top-level parity between the warm and turn frames is the gate
			// the delta comparator enforces; the diff names any non-input drift.
			{
				const {
					type: _t1,
					input: _i1,
					client_metadata: _c1,
					previous_response_id: _p1,
					generate: _g1,
					...warmOptions
				} = sentRequests[0] ?? {};
				const {
					type: _t2,
					input: _i2,
					client_metadata: _c2,
					previous_response_id: _p2,
					generate: _g2,
					...turnOptions
				} = sentRequests[1] ?? {};
				expect(turnOptions).toEqual(warmOptions);
			}

			// The turn chained from the warm baseline: delta + warm response id.
			expect(sentRequests).toHaveLength(2);
			expect(sentRequests[1]?.previous_response_id).toBe("resp-warm");
			const deltaItems = sentRequests[1]?.input as Array<{ role?: string }>;
			expect(deltaItems).toHaveLength(1);
			expect(deltaItems[0]?.role).toBe("user");
			expect(JSON.stringify(deltaItems)).toContain("Second question");
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
		}
	});
});

describe("compaction option hydration", () => {
	/** Minimal live-lane state: only `lastRequest` is read. */
	function laneWithLiveRequest(lastRequest: Record<string, unknown>) {
		return { lastRequest } as unknown as Parameters<typeof hydrateCodexCompactionOptions>[1];
	}

	it("copies the live turn's prefix-owned fields and drops ones it never sent", () => {
		const state = laneWithLiveRequest({
			input: [{ type: "additional_tools", role: "developer", tools: [{ name: "live_tool" }] }],
			reasoning: { effort: "medium", summary: "auto" },
			text: { verbosity: "medium" },
			previous_response_id: "resp_live",
		});

		const hydrated = hydrateCodexCompactionOptions(
			{
				model: "gpt-5.6-terra",
				input: [{ type: "additional_tools", role: "developer", tools: [{ name: "compaction_tool" }] }],
				reasoning: { effort: "low", summary: "auto", context: "all_turns" },
				tools: [{ name: "compaction_tool" }],
				store: false,
			} as never,
			state,
			false,
		);

		// Prefix-owned fields become the live turn's, exactly.
		expect(hydrated.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect(hydrated.text).toEqual({ verbosity: "medium" });
		// The live turn sent no top-level `tools`, so neither may the compaction.
		expect("tools" in hydrated).toBe(false);
		// Compaction keeps what is genuinely its own, and never inherits the
		// baseline's chaining identity.
		expect(hydrated.store).toBe(false);
		expect(hydrated.previous_response_id).toBeUndefined();
		expect(Array.isArray(hydrated.input) ? hydrated.input[0] : undefined).toEqual({
			type: "additional_tools",
			role: "developer",
			tools: [{ name: "live_tool" }],
		});
	});

	it("never lets a later in-place rewrite reach the comparator's baseline", () => {
		const lastRequest = {
			input: [{ type: "additional_tools", role: "developer", tools: [{ name: "live_tool" }] }],
			reasoning: { effort: "medium", summary: "auto" },
			text: { verbosity: "medium" },
		};
		const hydrated = hydrateCodexCompactionOptions(
			{
				model: "gpt-5.6-terra",
				input: [{ type: "additional_tools", role: "developer", tools: [] }],
				store: false,
			} as never,
			laneWithLiveRequest(lastRequest),
			false,
		);

		// `onPayload` runs after hydration; an extension mutating the body in
		// place must not corrupt `lastRequest`, which the next turn compares
		// against to decide whether it can chain.
		const lead = Array.isArray(hydrated.input) ? hydrated.input[0] : undefined;
		if (lead && typeof lead === "object") (lead as Record<string, unknown>).tools = ["MUTATED"];
		if (hydrated.reasoning) (hydrated.reasoning as Record<string, unknown>).effort = "MUTATED";
		if (hydrated.text) (hydrated.text as Record<string, unknown>).verbosity = "MUTATED";

		expect(lastRequest.input[0]?.tools).toEqual([{ name: "live_tool" }]);
		expect(lastRequest.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect(lastRequest.text).toEqual({ verbosity: "medium" });
	});

	it("leaves a pending-local-input request untouched so its hook runs once", () => {
		const body = {
			model: "gpt-5.6-terra",
			input: [{ type: "additional_tools", role: "developer", tools: [{ name: "compaction_tool" }] }],
			store: false,
		};
		const hydrated = hydrateCodexCompactionOptions(
			body as never,
			laneWithLiveRequest({
				input: [{ type: "additional_tools", role: "developer", tools: [{ name: "live_tool" }] }],
				reasoning: { effort: "medium", summary: "auto" },
				text: { verbosity: "medium" },
			}),
			true,
		);

		// The baseline was recorded after `onPayload`, and this request will run
		// that hook again on the way out. Copying any baseline-owned bytes here
		// would let a non-idempotent extension apply itself twice, so the body
		// must come back exactly as it went in.
		expect(hydrated).toBe(body);
		expect(hydrated.reasoning).toBeUndefined();
		expect(hydrated.text).toBeUndefined();
		expect(JSON.stringify(hydrated)).toContain("compaction_tool");
		expect(JSON.stringify(hydrated)).not.toContain("live_tool");
	});
});
