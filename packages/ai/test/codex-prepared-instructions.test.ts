import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	getCodexPreparedPromptBlocks,
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

	it("chains three turns while applying the same append-style hook exactly once per wire frame", async () => {
		const tempDir = TempDir.createSync("@codex-prepared-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class PersistentHookWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const index = sentRequests.length;
				this.emitCodexResponse({ messageId: `msg_${index}`, responseId: `resp_${index}`, text: `Answer ${index}` });
			}
		}

		global.WebSocket = PersistentHookWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		let hookCalls = 0;
		const hook = async (payload: unknown) => {
			const frame = payload as Record<string, unknown>;
			hookCalls += 1;
			const input = Array.isArray(frame.input) ? frame.input : [];
			const instructions = typeof frame.instructions === "string" ? frame.instructions : "";
			const tools = Array.isArray(frame.tools) ? frame.tools : [];
			return {
				...frame,
				instructions: `${instructions}|hook`,
				tools: [
					...tools,
					{ type: "function", name: "hooked_tool", parameters: { type: "object", properties: {} } },
				],
				input: [
					...input,
					{ type: "message", role: "developer", content: [{ type: "input_text", text: "WIRE_HOOK" }] },
				],
			};
		};
		try {
			let messages = createCodexTestContext(["You are a helpful assistant."], "Question 1").messages;
			for (let turn = 1; turn <= 3; turn += 1) {
				const result = await streamOpenAICodexResponses(
					model,
					{ systemPrompt: ["You are a helpful assistant."], messages },
					{
						apiKey: token,
						fetch: fetchMock as FetchImpl,
						sessionId: "persistent-hook-session",
						providerSessionState,
						responsesLite: false,
						onPayload: hook,
					},
				).result();
				if (turn < 3) {
					messages = [
						...messages,
						result,
						{ role: "user", content: `Question ${turn + 1}`, timestamp: Date.now() },
					];
				}
			}

			expect(hookCalls).toBe(3);
			expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
			expect(sentRequests[2]?.previous_response_id).toBe("resp_2");
			for (const request of sentRequests) {
				expect(request.instructions).toBe("You are a helpful assistant.|hook");
				expect(JSON.stringify(request.input).match(/WIRE_HOOK/g)).toHaveLength(1);
				expect(JSON.stringify(request.tools).match(/hooked_tool/g)).toHaveLength(1);
			}
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
		}
	});

	it("warm request with an explicit cache key makes the next turn chain from it", async () => {
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
				this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "main" });
			}
		}

		global.WebSocket = WarmWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "warm-chain-session";
		const promptCacheKey = "fork-cache-key";
		const firstTimestamp = Date.now();
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
				promptCacheKey,
				providerSessionState,
				responsesLite: true,
				warmRequest: {
					systemPrompt: ["You are a helpful assistant."],
					tools: [],
					messages: [{ role: "user", content: "First question", timestamp: firstTimestamp }],
					...parityOptions,
				},
			});

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
					promptCacheKey,
					providerSessionState,
					responsesLite: true,
					...parityOptions,
				},
			).result();

			expect(result.stopReason).toBe("stop");
			expect(sentRequests).toHaveLength(2);
			expect(sentRequests[0]?.generate).toBe(false);
			expect(sentRequests[0]?.prompt_cache_key).toBe(promptCacheKey);
			expect(sentRequests[1]?.prompt_cache_key).toBe(promptCacheKey);
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

	it("skips the warm request when cache retention is disabled", async () => {
		const tempDir = TempDir.createSync("@codex-prepared-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];

		class RetentionWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.sendJson({ type: "response.completed", response: { id: "resp-warm", status: "completed" } });
			}
		}

		global.WebSocket = RetentionWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			await prewarmOpenAICodexResponses(model, {
				apiKey: token,
				sessionId: "warm-retention-session",
				providerSessionState,
				cacheRetention: "none",
				warmRequest: {
					systemPrompt: ["You are a helpful assistant."],
					tools: [],
					messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
				},
			});
			// The warm exists to write the server-side prompt cache; with caching
			// disabled, no frame may be sent at all.
			expect(sentRequests).toHaveLength(0);
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
		}
	});

	it("runs the payload hook on the warm frame exactly once", async () => {
		const tempDir = TempDir.createSync("@codex-prepared-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const hookPayloads: Array<Record<string, unknown>> = [];

		class HookWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.sendJson({ type: "response.completed", response: { id: "resp-warm", status: "completed" } });
			}
		}

		global.WebSocket = HookWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			await prewarmOpenAICodexResponses(model, {
				apiKey: token,
				sessionId: "warm-hook-session",
				providerSessionState,
				onPayload: payload => {
					const frame = payload as Record<string, unknown>;
					hookPayloads.push(frame);
					return {
						...frame,
						client_metadata: { ...(frame.client_metadata as Record<string, string>), hook_seen: "1" },
					};
				},
				warmRequest: {
					systemPrompt: ["You are a helpful assistant."],
					tools: [],
					messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
				},
			});
			// The warm is a real billed request: an extension must see it exactly
			// once, and its rewrite must reach the wire.
			expect(hookPayloads).toHaveLength(1);
			expect(hookPayloads[0]?.generate).toBe(false);
			const metadata = sentRequests[0]?.client_metadata as Record<string, string>;
			expect(metadata.hook_seen).toBe("1");
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

	it("hydrates a full SSE compaction from the provider-prepared snapshot", () => {
		const prepared = {
			request: {
				model: "gpt-5.6-terra",
				input: [{ type: "message", role: "user", content: "server-seen" }],
				text: { verbosity: "high" },
			},
			responseItems: [{ type: "message", role: "assistant", content: "completed" }],
		};
		const hydrated = hydrateCodexCompactionOptions(
			{
				model: "gpt-5.6-terra",
				input: [{ type: "message", role: "user", content: "rebuilt-differently" }, { type: "compaction_trigger" }],
				store: false,
			} as never,
			undefined,
			false,
			prepared as never,
		);

		expect(hydrated.text).toEqual({ verbosity: "high" });
		expect(hydrated.input).toEqual([
			{ type: "message", role: "user", content: "server-seen" },
			{ type: "message", role: "assistant", content: "completed" },
			{ type: "compaction_trigger" },
		]);
	});

	it("reuses only an ordered identity-proven pending tool-output tail", () => {
		const prepared = {
			request: { model: "gpt-5.6-terra", input: [{ type: "message", role: "user", content: "seen" }] },
			responseItems: [{ type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" }],
		};
		const output = { type: "function_call_output", call_id: "call_1", output: "LOCAL_RESULT" };
		const hydrated = hydrateCodexCompactionOptions(
			{ model: "gpt-5.6-terra", input: [output, { type: "compaction_trigger" }], store: false } as never,
			undefined,
			true,
			prepared as never,
		);

		expect(hydrated.input).toEqual([
			{ type: "message", role: "user", content: "seen" },
			{ type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
			output,
			{ type: "compaction_trigger" },
		]);
	});

	it.each([
		["wrong output kind", [{ type: "custom_tool_call_output", call_id: "call_1", output: "x" }]],
		[
			"duplicate output",
			[
				{ type: "function_call_output", call_id: "call_1", output: "x" },
				{ type: "function_call_output", call_id: "call_1", output: "again" },
			],
		],
		[
			"queued user input",
			[
				{ type: "function_call_output", call_id: "call_1", output: "x" },
				{ type: "message", role: "user", content: "do not drop me" },
			],
		],
	] as const)("preserves the original pending body for %s", (_name, tail) => {
		const body = { model: "gpt-5.6-terra", input: [...tail, { type: "compaction_trigger" }], store: false };
		const hydrated = hydrateCodexCompactionOptions(body as never, undefined, true, {
			request: { model: "gpt-5.6-terra", input: [] },
			responseItems: [{ type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" }],
		} as never);
		expect(hydrated).toBe(body);
	});
});
