/**
 * Per-turn overrides (`AgentPromptOptions.systemPromptAppend` / `model` /
 * `thinkingLevel`) only survive a `sendCustomMessage` call that starts the turn
 * right here. Every other route either steers into a turn that is already
 * configured, or queues into `#queueHiddenNextTurnMessage` — a shared batch
 * flushed as one prompt with nowhere to put one message's overrides.
 *
 * Silently dropping them is the dangerous outcome: a delegated live turn would
 * then run on the terminal's model with none of its voice contract, which is
 * how the original implementation mutated the repo mid-interview. The session
 * refuses instead, and the caller retires.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const DELEGATION = "delegated-request-marker";

describe("AgentSession per-turn overrides", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-turn-overrides-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		// Restored before the storages close: a live spy on a closed handle would
		// leak into later files in the same suite run.
		mock.restore();
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	/** A session whose first turn blocks, once entered, until `release()`. */
	async function streamingSession(settings?: Record<string, unknown>): Promise<{
		mock: MockModel;
		entered: Promise<void>;
		release: () => void;
		authStorage: AuthStorage;
	}> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async () => {
				// Entering the handler IS the turn being in flight: await this
				// rather than sleeping until `isStreaming` happens to flip.
				entered.resolve();
				await gate.promise;
				return { content: ["done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		return { mock, entered: entered.promise, release: () => gate.resolve(), authStorage };
	}

	/** True once any model call carried the delegation text in its context. */
	function sawDelegation(mock: MockModel): boolean {
		return mock.calls.some(call =>
			call.context.messages.some(message =>
				typeof message.content === "string"
					? message.content.includes(DELEGATION)
					: Array.isArray(message.content) &&
						message.content.some(part => part.type === "text" && part.text.includes(DELEGATION)),
			),
		);
	}

	it("refuses a turn-starting send whose overrides a steer would drop", async () => {
		const { mock, entered, release } = await streamingSession();
		const running = session.prompt("work");
		await entered;

		const started = await session.sendCustomMessage(
			{ customType: "live-delegation", content: DELEGATION, display: false },
			{ triggerTurn: true, turnOverrides: { systemPromptAppend: ["voice contract"] } },
		);
		// Release before asserting: a throw while the handler is still gated
		// would deadlock the suite instead of reporting the failure.
		release();
		await running;
		await session.waitForIdle();

		expect(started).toBe(false);
		// Refused outright: it never reached the model under the running turn's
		// configuration, which is the whole point of failing closed.
		expect(sawDelegation(mock)).toBe(false);
	});

	it("still steers an ordinary turn-starting send while streaming", async () => {
		const { mock, entered, release } = await streamingSession();
		const running = session.prompt("work");
		await entered;

		// Positive control: identical call minus `turnOverrides`. Without this,
		// the assertion above would also pass if delivery were broken entirely.
		const started = await session.sendCustomMessage(
			{ customType: "live-delegation", content: DELEGATION, display: false },
			{ triggerTurn: true },
		);
		release();
		await running;
		await session.waitForIdle();

		expect(started).toBe(false);
		expect(sawDelegation(mock)).toBe(true);
	});

	it("commits no turn when the caller aborts before acceptance", async () => {
		const { mock, release } = await streamingSession();
		let accepted = false;
		const cancellation = new AbortController();
		cancellation.abort();

		// `#runUsageAwarePreflight` reaches the network and can wait on an
		// interactive fallback confirmation, so a caller must be able to release
		// it — not merely decline the turn afterwards. Otherwise the live bridge
		// gives up, and an orphan coding turn starts behind it.
		await session.sendCustomMessage(
			{ customType: "live-delegation", content: DELEGATION, display: false },
			{
				triggerTurn: true,
				signal: cancellation.signal,
				onAccepted: () => {
					accepted = true;
				},
			},
		);
		release();
		await session.waitForIdle();

		expect(accepted).toBe(false);
		expect(mock.calls).toHaveLength(0);
	});

	it("releases an in-flight preflight when the caller aborts", async () => {
		const { mock, release, authStorage } = await streamingSession({
			"retry.modelFallback": true,
			"retry.usageAwareFallback": true,
		});
		const reached = Promise.withResolvers<void>();
		// Block inside the preflight's health request until its signal aborts.
		// This is the wait that pinned `#promptAgentInitiatedMessage`: without
		// the signal reaching it, aborting only stopped the turn from being
		// committed while this promise — and the in-flight count behind it —
		// stayed held forever.
		const health = spyOn(authStorage, "getModelUsageHealth").mockImplementation(
			async (_provider: string, options: { signal?: AbortSignal }) => {
				reached.resolve();
				const released = Promise.withResolvers<void>();
				options.signal?.addEventListener("abort", () => released.resolve(), { once: true });
				await released.promise;
				throw new Error("aborted");
			},
		);

		let accepted = false;
		const cancellation = new AbortController();
		const delivery = session.sendCustomMessage(
			{ customType: "live-delegation", content: DELEGATION, display: false },
			{
				triggerTurn: true,
				signal: cancellation.signal,
				onAccepted: () => {
					accepted = true;
				},
			},
		);

		await reached.promise;
		cancellation.abort();

		// The delivery settles instead of hanging, and no turn was committed.
		await delivery;
		release();
		await session.waitForIdle();

		expect(health).toHaveBeenCalled();
		expect(accepted).toBe(false);
		expect(mock.calls).toHaveLength(0);
	});
});
