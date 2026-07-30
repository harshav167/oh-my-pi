import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { type CustomMessagePayload, LIVE_TRANSCRIPT_MESSAGE_TYPE, LIVE_WORKER_MESSAGE_TYPE } from "../session/messages";
import { type LiveConfig, resolveLiveConfig } from "./config";
import {
	type LiveSessionCallbacks,
	LiveSessionController,
	type LiveSessionDependencies,
	type LiveSessionHost,
	type LiveState,
	type LiveTranscript,
} from "./controller";
import { LiveEndError, type LiveTransportOptions } from "./transport";

type PersistedMessage = { customType?: string; details?: unknown };

/**
 * Records the two outbound paths separately. Transcript turns MUST take the
 * log path (`sessionManager.appendCustomMessageEntry`) and never the delivery
 * path (`sendCustomMessage`) — delivery re-enters the model as input and is
 * the echo loop. A fake that funnels both into one array cannot express that,
 * which is why the previous 82 tests all passed against the broken build.
 */
interface SessionRecorder {
	readonly order: string[];
	readonly persisted: PersistedMessage[];
	readonly delivered: PersistedMessage[];
	isStreaming: boolean;
	/** When set, the session log rejects every append. */
	appendFails?: boolean;
	/** The controller's session subscriber, so a test can drive agent events. */
	sessionListener?: (event: AgentSessionEvent) => void;
}

/** Keeps a delegated turn in flight, the way a real backend turn does. */
type TurnGate = { holdTurn: boolean; readonly turn: PromiseWithResolvers<boolean> };

function callbacks(): LiveSessionCallbacks {
	return {
		onState: () => {},
		onLevels: () => {},
		onTranscript: () => {},
		onTerminal: () => {},
	};
}

/** Minimal assistant message carrying one text part. */
function assistantText(text: string): AssistantMessage {
	return { role: "assistant", content: text ? [{ type: "text", text }] : [] } as unknown as AssistantMessage;
}

/** Drains microtasks until `predicate` holds, so tests never count ticks. */
async function until(predicate: () => boolean, ticks = 100): Promise<void> {
	for (let index = 0; index < ticks && !predicate(); index += 1) await Promise.resolve();
	if (!predicate()) throw new Error("condition was never reached");
}

/**
 * Host port over the fake session. Mirrors the interactive builder so the tests
 * exercise the same surface the controller actually consumes.
 */
function fakeHost(recorder: SessionRecorder): LiveSessionHost {
	const session = fakeSession(recorder);
	return {
		turnSession: session,
		authStorage: session.modelRegistry.authStorage,
		sessionId: session.sessionId,
		contextMessages: () => session.buildDisplaySessionContext().messages,
		activeToolNames: () => session.getActiveToolNames(),
		resolveCodingOverrides: () => ({
			systemPromptAppend: ["live coding contract"],
			model: getBundledModel("openai-codex", "gpt-5.6-terra"),
		}),
		appendLogOnly: <T>(message: CustomMessagePayload<T>) => session.appendLogOnlyCustomMessage<T>(message),
		extractAssistantText: (message: AssistantMessage) =>
			message.content.map(part => (part.type === "text" ? part.text : "")).join(""),
	};
}

function fakeSession(recorder: SessionRecorder): AgentSession {
	return {
		modelRegistry: {
			authStorage: {},
			// Resolving `live.codingModel` is part of `start()`, so the fake must
			// offer the real default model or every lifecycle test fails.
			getAvailable: () => [getBundledModel("openai-codex", "gpt-5.6-terra")].filter(Boolean),
		},
		sessionId: "session-1",
		get isStreaming(): boolean {
			return recorder.isStreaming;
		},
		buildDisplaySessionContext: () => ({ messages: [] }),
		getActiveToolNames: () => [],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			recorder.order.push("subscribe");
			recorder.sessionListener = listener;
			return () => {
				recorder.sessionListener = undefined;
				recorder.order.push("unsubscribe");
			};
		},
		// The canonical log-only boundary the controller uses. Mirrors the real
		// method's contract: it swallows a rejected write and reports it, so the
		// caller (running under `#guardEvent`) cannot turn a lost presentation row
		// into a terminal call failure.
		appendLogOnlyCustomMessage: (message: { customType?: string; details?: unknown }) => {
			if (recorder.appendFails) return false;
			recorder.persisted.push({ customType: message.customType, details: message.details });
			return true;
		},
		sessionManager: {
			appendCustomMessageEntry: () => {
				throw new Error("transcript rows must use appendLogOnlyCustomMessage");
			},
		},
		sendCustomMessage: async (message: PersistedMessage, options?: { onAccepted?: () => void }) => {
			recorder.delivered.push(message);
			options?.onAccepted?.();
			// A real `triggerTurn` delivery resolves only when the whole backend turn
			// ends. A fake that resolves at once closes the range immediately, which
			// hides every teardown-time contract.
			const gate = recorder as Partial<TurnGate>;
			return gate.holdTurn && gate.turn ? gate.turn.promise : true;
		},
		abort: async () => {},
	} as unknown as AgentSession;
}

class LifecycleHarness implements SessionRecorder {
	readonly order: string[] = [];
	readonly persisted: PersistedMessage[] = [];
	readonly delivered: PersistedMessage[] = [];
	isStreaming = false;
	appendFails = false;
	holdTurn = false;
	readonly turn = Promise.withResolvers<boolean>();
	sessionListener: ((event: AgentSessionEvent) => void) | undefined;
	readonly inputMute: boolean[] = [];
	readonly outputMute: boolean[] = [];
	readonly states: LiveState[] = [];
	readonly transcripts: Array<LiveTranscript | undefined> = [];
	readonly timers = new Map<number, () => void>();
	transportOptions: LiveTransportOptions | undefined;
	activations = 0;
	refreshes = 0;
	connectCount = 0;
	autoStart = true;
	reachSignaling = true;
	abortClosesTransport = false;
	transportAborted = false;
	sendError: Error | undefined;
	closeError: Error | undefined;
	terminal: Error | undefined;

	readonly dependencies: LiveSessionDependencies = {
		audioProcessingAvailable: true,
		createTransport: options => {
			this.transportOptions = options;
			options.signal?.addEventListener("abort", () => {
				if (!this.abortClosesTransport) return;
				this.transportAborted = true;
				this.order.push("abort");
			});
			return {
				connect: async () => {
					this.connectCount += 1;
					if (this.reachSignaling) options.callbacks.onSignalingEstablished();
					if (this.autoStart) options.callbacks.onEvent({ type: "session.started", session: { id: "live-1" } });
				},
				send: async () => {
					this.order.push("session.close");
					if (this.transportAborted) throw new Error("transport already closed");
					if (this.sendError) throw this.sendError;
				},
				close: async () => {
					this.order.push("close");
					if (this.closeError) throw this.closeError;
				},
				activate: () => {
					this.activations += 1;
					this.order.push("activate");
				},
				refreshMicrophone: () => {
					this.refreshes += 1;
					this.order.push("refresh");
				},
				setMuted: async muted => {
					this.inputMute.push(muted);
				},
				setOutputMuted: async muted => {
					this.outputMute.push(muted);
				},
			};
		},
		setTimer: (callback, delayMs) => {
			this.timers.set(delayMs, callback);
			return { delayMs } as unknown as NodeJS.Timeout;
		},
		clearTimer: timer => {
			if ("delayMs" in timer && typeof timer.delayMs === "number") this.timers.delete(timer.delayMs);
		},
	};

	controller(config: LiveConfig = resolveLiveConfig(Settings.instance)): LiveSessionController {
		return new LiveSessionController(
			{
				host: fakeHost(this),
				callbacks: {
					...callbacks(),
					onState: state => this.states.push(state),
					onTranscript: transcript => this.transcripts.push(transcript),
					onTerminal: error => (this.terminal = error),
				},
				config,
			},
			this.dependencies,
		);
	}
}

describe("LiveSessionController lifecycle", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => resetSettingsForTest());

	it("activates capture exactly once, after the startup barrier", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();

		await controller.start();

		expect(harness.activations).toBe(1);
		expect(harness.order.indexOf("subscribe")).toBeLessThan(harness.order.indexOf("activate"));
		await controller.stop();
		expect(harness.order.slice(-2)).toEqual(["close", "unsubscribe"]);
	});

	it("closes the remote session when startup fails after signaling", async () => {
		const harness = new LifecycleHarness();
		harness.autoStart = false;
		const controller = harness.controller();

		const starting = controller.start();
		await Promise.resolve();
		harness.timers.get(20_000)?.();
		await starting.catch(() => {});

		expect(harness.activations).toBe(0);
		expect(harness.order).toContain("session.close");
		expect(harness.order.indexOf("session.close")).toBeLessThan(harness.order.indexOf("close"));
	});

	it("skips the session close when signaling never completed", async () => {
		const harness = new LifecycleHarness();
		harness.autoStart = false;
		harness.reachSignaling = false;
		const controller = harness.controller();

		const starting = controller.start();
		await Promise.resolve();
		harness.timers.get(20_000)?.();
		await starting.catch(() => {});

		expect(harness.order).not.toContain("session.close");
	});

	it("aborts a stalled transport when stopped during initialization", async () => {
		const order: string[] = [];
		const connect = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const dependencies: LiveSessionDependencies = {
			audioProcessingAvailable: true,
			createTransport: options => {
				signal = options.signal;
				options.signal?.addEventListener("abort", () => connect.reject(options.signal?.reason), { once: true });
				return {
					connect: () => connect.promise,
					send: async () => {},
					close: async () => {
						order.push("close");
					},
					activate: () => {},
					refreshMicrophone: () => {},
					setMuted: async () => {},
					setOutputMuted: async () => {},
				};
			},
			setTimer: () => ({}) as NodeJS.Timeout,
			clearTimer: () => {},
		};
		const controller = new LiveSessionController(
			{
				host: fakeHost({ order, persisted: [], delivered: [], isStreaming: false }),
				callbacks: callbacks(),
				config: resolveLiveConfig(Settings.instance),
			},
			dependencies,
		);

		const starting = controller.start();
		await Promise.resolve();
		await controller.stop();
		const startError = await starting.then(
			() => undefined,
			error => error,
		);
		expect(startError).toBeInstanceOf(Error);
		expect(signal?.aborted).toBe(true);
		expect(order).toContain("close");
	});

	it("keeps microphone and speaker mute independent", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();
		await controller.start();

		controller.toggleOutputMute();
		controller.toggleMute();

		expect(harness.outputMute).toEqual([true]);
		expect(harness.inputMute).toEqual([true]);
		expect(controller.state).toMatchObject({ inputMuted: true, outputMuted: true });
		await controller.stop();
	});

	it("never mutes output in response to microphone activity", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();
		await controller.start();

		harness.transportOptions?.callbacks.onOutputLevel(0.5);
		for (let index = 0; index < 20; index += 1) harness.transportOptions?.callbacks.onInputLevel(0.9);

		expect(harness.outputMute).toEqual([]);
		await controller.stop();
	});

	it("tracks speaking and working independently", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();
		await controller.start();

		harness.transportOptions?.callbacks.onOutputLevel(0.5);
		expect(controller.state).toMatchObject({ voice: "speaking", worker: "idle" });

		harness.transportOptions?.callbacks.onEvent({
			type: "delegation.created",
			item: { type: "delegation", target: "client", id: "d1", content: [{ type: "input_text", text: "go" }] },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(controller.state).toMatchObject({ voice: "speaking", worker: "working" });
		await controller.stop();
	});

	it("persists the durable row for a turn still open when the call stops", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();
		// The delegated turn stays in flight, so the range is still open at stop.
		harness.holdTurn = true;
		await controller.start();
		harness.transportOptions?.callbacks.onEvent({
			type: "delegation.created",
			item: { type: "delegation", target: "client", id: "d1", content: [{ type: "input_text", text: "go" }] },
		});
		// The delegation envelope reaching the session is what proves the bridge
		// activated a generation; counting ticks would race it.
		await until(() => harness.delivered.length > 0);
		const body = "The branch carries three committed themes.";
		const partial = assistantText(body);
		harness.sessionListener?.({ type: "message_start", message: assistantText("") } as AgentSessionEvent);
		harness.sessionListener?.({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: body, partial },
		} as AgentSessionEvent);

		// The turn never ended, so its range closes during teardown. That close is
		// the only thing that writes the row, and it is the delegated answer's one
		// durable record: the ordinary transcript is suppressed while the turn is
		// owned, so losing the row loses the answer from a resumed session.
		await controller.stop();
		const rows = harness.persisted.filter(message => message.customType === LIVE_WORKER_MESSAGE_TYPE);
		expect(rows).toHaveLength(1);
		const details = rows[0]?.details as { screen?: string; delegationId?: string } | undefined;
		expect(details?.screen).toBe(body);
		// Names the range it closes, so rebuild pairs it with its own opener.
		expect(details?.delegationId).toBe("d1");
	});

	it("refreshes the microphone without reconnecting", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();
		await controller.start();

		await controller.refreshMicrophone();

		expect(harness.refreshes).toBe(1);
		expect(harness.connectCount).toBe(1);
		await controller.stop();
	});

	it("logs a native media diagnostic without ending the call", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();
		await controller.start();

		harness.transportOptions?.callbacks.onEvent({
			type: "live.diagnostic",
			message: "Live microphone capture stalled",
		});

		expect(harness.terminal).toBeUndefined();
		expect(controller.state.connection).toBe("active");
		await controller.stop();
	});

	it("treats established sideband loss as terminal without reconnecting", async () => {
		const harness = new LifecycleHarness();
		const controller = harness.controller();
		await controller.start();

		harness.transportOptions?.callbacks.onTerminal(new LiveEndError("sideband_lost", "sideband closed"));
		await controller.stop();

		expect(harness.connectCount).toBe(1);
		expect(harness.terminal).toMatchObject({ reason: "sideband_lost" });
	});

	it("uses a typed inactivity end reason", async () => {
		const harness = new LifecycleHarness();
		const config = { ...resolveLiveConfig(Settings.instance), inactivityTimeoutMinutes: 1 };
		const controller = harness.controller(config);
		await controller.start();

		harness.timers.get(60_000)?.();
		await controller.stop();

		expect(harness.terminal).toMatchObject({ reason: "inactivity" });
	});

	it("sends session.close before aborting the transport", async () => {
		const harness = new LifecycleHarness();
		harness.abortClosesTransport = true;
		const controller = harness.controller();
		await controller.start();

		await controller.stop();

		expect(harness.order.indexOf("session.close")).toBeLessThan(harness.order.indexOf("abort"));
	});

	it("continues cleanup and reports all failures", async () => {
		const harness = new LifecycleHarness();
		harness.sendError = new Error("session close");
		harness.closeError = new Error("transport cleanup");
		const controller = harness.controller();
		await controller.start();

		const error = await controller.stop().catch(cause => cause);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toHaveLength(2);
		expect(harness.order).toContain("unsubscribe");
	});
});

describe("LiveSessionController transcripts", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => resetSettingsForTest());

	async function started(harness: LifecycleHarness): Promise<LiveSessionController> {
		const controller = harness.controller();
		await controller.start();
		harness.transcripts.length = 0;
		return controller;
	}

	it("preserves the first word of an utterance that starts before activation", async () => {
		const harness = new LifecycleHarness();
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		emit?.({ type: "input_transcript.added", item: { text: "Unicorn" } });
		emit?.({ type: "input_transcript.added", item: { text: " protocol check" } });
		emit?.({ type: "turn.done", turn: { role: "user", transcript: "Unicorn protocol check" } });

		expect(harness.transcripts.at(-1)).toMatchObject({
			role: "user",
			text: "Unicorn protocol check",
			final: true,
		});
		await controller.stop();
	});

	it("accepts cumulative snapshots without duplicating their prefix", async () => {
		const harness = new LifecycleHarness();
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		emit?.({ type: "input_transcript.added", item: { text: "open the" } });
		emit?.({ type: "input_transcript.added", item: { text: "open the door" } });

		expect(harness.transcripts.at(-1)).toMatchObject({ text: "open the door", final: false });
		await controller.stop();
	});

	it("keeps two identical consecutive utterances as distinct turns", async () => {
		const harness = new LifecycleHarness();
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		for (let spoken = 0; spoken < 2; spoken += 1) {
			emit?.({ type: "input_transcript.added", item: { text: "again" } });
			emit?.({ type: "turn.done", turn: { role: "user", transcript: "again" } });
		}

		const finals = harness.transcripts.filter(entry => entry?.final && entry.role === "user");
		expect(finals).toHaveLength(2);
		expect(finals[0]?.turn).not.toBe(finals[1]?.turn);
		const persisted = harness.persisted.filter(message => message.customType === LIVE_TRANSCRIPT_MESSAGE_TYPE);
		expect(persisted).toHaveLength(2);
		await controller.stop();
	});

	it("suppresses a duplicate delivery of the same closed final", async () => {
		const harness = new LifecycleHarness();
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		emit?.({ type: "input_transcript.added", item: { text: "once" } });
		emit?.({ type: "turn.done", turn: { role: "user", transcript: "once" } });
		emit?.({ type: "turn.done", turn: { role: "user", transcript: "once" } });

		const persisted = harness.persisted.filter(message => message.customType === LIVE_TRANSCRIPT_MESSAGE_TYPE);
		expect(persisted).toHaveLength(1);
		await controller.stop();
	});

	it("persists each completed voice turn as a hidden structured message", async () => {
		const harness = new LifecycleHarness();
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		emit?.({ type: "turn.done", turn: { role: "user", transcript: "  what changed  " } });
		emit?.({ type: "turn.done", turn: { role: "assistant", transcript: "the parser" } });

		const turns = harness.persisted.filter(message => message.customType === LIVE_TRANSCRIPT_MESSAGE_TYPE);
		// Role, text, order — the contract continuity reads. The row also carries the
		// voice model for rebuild attribution, which is not what this pins.
		const details = turns.map(message => message.details as { role?: string; text?: string } | undefined);
		expect(details.map(detail => ({ role: detail?.role, text: detail?.text }))).toEqual([
			{ role: "user", text: "what changed" },
			{ role: "assistant", text: "the parser" },
		]);
		await controller.stop();
	});

	it("never routes a transcript turn through delivery, even mid-stream", async () => {
		const harness = new LifecycleHarness();
		// The echo loop only reproduced while a delegated turn was streaming:
		// `sendCustomMessage` then falls through to `agent.steer()`. The old
		// fake hardcoded `isStreaming: false`, so this branch was unreachable.
		harness.isStreaming = true;
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		emit?.({ type: "turn.done", turn: { role: "assistant", transcript: "the parser changed" } });

		expect(harness.persisted.filter(m => m.customType === LIVE_TRANSCRIPT_MESSAGE_TYPE)).toHaveLength(1);
		expect(harness.delivered).toHaveLength(0);
		await controller.stop();
	});

	it("keeps the call alive when the session log rejects a transcript turn", async () => {
		const harness = new LifecycleHarness();
		harness.appendFails = true;
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		emit?.({ type: "turn.done", turn: { role: "user", transcript: "still listening" } });

		// Persistence runs under `#guardEvent`, so an escaping throw would land
		// in `#reportFailure` and set connection "error". A continuity row is
		// best-effort: losing one must not end the call.
		expect(harness.terminal).toBeUndefined();
		expect(harness.states.at(-1)?.connection).not.toBe("error");
		await controller.stop();
	});

	it("interleaves user and assistant turns without cross-contamination", async () => {
		const harness = new LifecycleHarness();
		const controller = await started(harness);
		const emit = harness.transportOptions?.callbacks.onEvent;

		emit?.({ type: "input_transcript.added", item: { text: "ask" } });
		emit?.({ type: "output_transcript.added", item: { text: "answer" } });
		emit?.({ type: "input_transcript.added", item: { text: "ing" } });

		const user = harness.transcripts.filter(entry => entry?.role === "user").at(-1);
		const assistant = harness.transcripts.filter(entry => entry?.role === "assistant").at(-1);
		expect(user?.text).toBe("asking");
		expect(assistant?.text).toBe("answer");
		await controller.stop();
	});
});
