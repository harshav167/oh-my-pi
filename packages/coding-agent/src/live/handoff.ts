import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { parseTextSignature } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { logger, prompt, toError } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentTurnOverrides } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE, LIVE_TAIL_MESSAGE_TYPE } from "../session/messages";
import type { LiveConfig } from "./config";
import { LiveHandoffOutput, REMAINDER_PART } from "./handoff-output";
import delegationTemplate from "./prompts/live-delegation-request.md" with { type: "text" };
import cancelledTemplate from "./prompts/live-handoff-cancelled.md" with { type: "text" };
import redirectedTemplate from "./prompts/live-handoff-redirected.md" with { type: "text" };
import retiredTemplate from "./prompts/live-handoff-retired.md" with { type: "text" };
import supersededTemplate from "./prompts/live-handoff-superseded.md" with { type: "text" };
import transcriptTailTemplate from "./prompts/live-transcript-tail.md" with { type: "text" };
import {
	buildDelegationContextAppend,
	chunkLiveContext,
	type LiveClientMessage,
	type LiveContextChannel,
	type LiveServerEvent,
} from "./protocol";

const CANCEL_SENTINEL = "[[LIVE_CANCEL_ACTIVE]]";

// No bracketed channel markers anywhere. `delegation.context.append` carries an
// explicit `channel`, and assistant parts carry `textSignature.phase`, so a
// marker adds nothing to routing — it only risks the voice model reading the
// label aloud and leaks protocol noise into the rendered transcript.
const TOOL_STARTED_STATUS = "Work is in progress.";
const TOOL_FAILED_STATUS = "A tool failed; the coding agent is handling it.";

/** Longest a single sideband send may take before it is abandoned. */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Longest a delegation may go unaccepted before it is retired.
 *
 * Far larger than the transport bound: acceptance waits on the usage preflight,
 * which may be asking the user to confirm a model fallback. This only catches a
 * delivery that will never be taken up at all.
 */
const ACCEPT_TIMEOUT_MS = 60_000;

/** Longest a cancellation abort may take before the call is failed. */
const ABORT_TIMEOUT_MS = 5_000;

/** Longest shutdown will wait for the queued sideband backlog. */
const SEND_DRAIN_TIMEOUT_MS = 2_000;

type HandoffConfig = Pick<LiveConfig, "handoffFlushMs" | "flushTranscriptTail">;

export type LiveHandoffSession = Pick<AgentSession, "abort" | "isStreaming" | "sendCustomMessage">;

export interface LiveHandoffBridgeOptions {
	readonly session: LiveHandoffSession;
	readonly send: (message: LiveClientMessage) => Promise<void>;
	readonly extractAssistantText: (message: AssistantMessage) => string;
	readonly config: HandoffConfig;
	readonly onError?: (error: Error) => void;
	/** Reports whether a delegated backend turn is currently running. */
	readonly onWorking?: (working: boolean) => void;
	/**
	 * Receives the delegated turn's body for the screen, plus the part of it audio
	 * never took.
	 *
	 * `body` always fires for an answer message, so the durable row the next
	 * reload replays is never missing — the voice model paraphrases, so what it
	 * says is not a substitute for the text. `withheld` is the remainder the voice
	 * lane never received (code past a fence, the overflow tail, directive-led
	 * detail) and is empty when the voice has all of it, which is the host's
	 * signal to draw nothing rather than restate the answer beside it.
	 */
	readonly onScreen?: (body: string, withheld: string) => void;
	/**
	 * Fires exactly once per owned delegation, after its output is finalized.
	 *
	 * Separate from {@link onWorking}: that drives a UI indicator and is reported
	 * early during teardown, while this marks the durable end of the delegation's
	 * presentation range and must observe every screen body first.
	 */
	readonly onTurnClosed?: (delegationId: string) => void;
	/**
	 * Per-turn model, effort, and voice contract for delegated coding turns.
	 * Resolved once at `/live` startup so a failure surfaces there rather than
	 * mid-call, and applied only to sends that actually start a turn.
	 */
	readonly turnOverrides?: AgentTurnOverrides;
	/**
	 * Liveness bounds, in milliseconds. Defaults are production values; tests
	 * override them so a stalled-transport case does not have to elapse in real
	 * time.
	 */
	readonly timeouts?: {
		readonly send?: number;
		readonly accept?: number;
		readonly abort?: number;
		readonly drain?: number;
	};
}

type PendingDelegation = { id: string; request: string };
type TranscriptTurn = { role: "user" | "assistant"; text: string };

/**
 * Where a delegated turn stands in its assistant lifecycle.
 *
 * Ordered and one-way: `awaiting-start` → `streaming` → `message-closed`, with
 * `abandoned` reachable from any of them when a cancel or replacement takes the
 * turn. Replaces three independent booleans (`started`, `closed`, `abandoned`)
 * whose eight combinations included five that could never legally occur — and
 * whose correctness depended on remembering to set them in the right order.
 */
type GenerationPhase = "awaiting-start" | "streaming" | "message-closed" | "abandoned";

/** One delegated backend turn and the assistant lifecycle it owns. */
type Generation = {
	readonly id: number;
	readonly delegationId: string;
	phase: GenerationPhase;
	/**
	 * A correction queued behind this turn, waiting for the next assistant
	 * `message_start` to own it.
	 *
	 * Stored on the generation, not beside it: a pending delegation with no
	 * running turn is meaningless, and a separate bridge field made that illegal
	 * pair representable and left every transition responsible for clearing both.
	 */
	pending: PendingDelegation | undefined;
	/** Whether a commentary line has already been emitted for this turn. */
	commentaryEmitted: boolean;
	/** Whether a tool failure has already been reported for this turn. */
	toolFailureReported: boolean;
	/**
	 * Content parts of the open message already known to be commentary from an
	 * explicit leading marker, since only their first delta carries it.
	 */
	commentaryParts: Set<number>;
	/**
	 * Whether the currently open assistant message has already been projected.
	 *
	 * A turn can end its answer message without ending the turn — a queued
	 * advisory or follow-up runs on the same delegation — and the later terminal
	 * event then repeats that same answer. Reset by `message_start`, so this
	 * tracks the message rather than its bytes: two messages in one turn may
	 * legitimately carry identical text, and comparing content would silence the
	 * second.
	 */
	answerProjected: boolean;
};

/**
 * The bridge's turn lifecycle.
 *
 * `running` implies the durable close obligation, so an owned turn without one —
 * unreachable, since activation always incurs it — is now unrepresentable.
 * `closing` is the window after the active turn is cleared but before its
 * presentation range is written.
 */
type TurnState =
	| { readonly kind: "idle"; readonly debt: number }
	| { readonly kind: "running"; readonly generation: Generation; readonly debt: number }
	| { readonly kind: "closing"; readonly debt: number; readonly delegationId: string };

/** Whether this generation may still accept assistant text. */
function acceptsText(generation: Generation): boolean {
	return generation.phase === "streaming";
}

/**
 * Bridges the realtime voice surface and the coding `AgentSession`.
 *
 * Every mutation runs on one FIFO chain so delegation, assistant lifecycle, and
 * cancellation cannot interleave. A *generation* owns one delegated turn: text
 * that arrives before its own `message_start`, after its `message_end`, or
 * after it was abandoned belongs to nobody and is dropped.
 */
export class LiveHandoffBridge {
	readonly #session: LiveHandoffSession;
	readonly #send: (message: LiveClientMessage) => Promise<void>;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	readonly #config: HandoffConfig;
	readonly #onError: (error: Error) => void;
	readonly #onWorking: (working: boolean) => void;
	readonly #turnOverrides: AgentTurnOverrides | undefined;
	readonly #sendTimeoutMs: number;
	readonly #acceptTimeoutMs: number;
	readonly #abortTimeoutMs: number;
	readonly #drainTimeoutMs: number;
	readonly #transcript: TranscriptTurn[] = [];

	#generationCounter = 0;
	/**
	 * The bridge's turn lifecycle as one value.
	 *
	 * `running` carries the close obligation implicitly: activation always incurs
	 * it, so the previously separate flag made `active && !closeOwed` — a state
	 * that can never legally occur — representable. `closing` is the window after
	 * the active turn is cleared but before its durable presentation range is
	 * written, which is deliberate: the range must close after the final output is
	 * flushed, not when the working indicator drops.
	 *
	 * `debt` rides on every variant because it genuinely spans turns: a cancel
	 * increments it and the owed terminal may arrive after a replacement has
	 * started, or after everything settled. `agent_end` carries no turn
	 * identifier (`packages/agent/src/types.ts:763-769`), so an ordered count is
	 * the only correlation the event contract permits.
	 */
	#turn: TurnState = { kind: "idle", debt: 0 };
	/**
	 * Text observed for the currently open assistant message only. `#finish`
	 * reconciles the final bytes against this, so a tool-use turn's earlier
	 * messages cannot make the last one look already-sent.
	 */
	#messageText = "";
	readonly #output: LiveHandoffOutput;
	#flushTimer: NodeJS.Timeout | undefined;
	#sendChain: Promise<void> = Promise.resolve();
	#eventChain: Promise<void> = Promise.resolve();
	#lastHandoffTurn = 0;
	#disposed = false;
	/** Last `onWorking` value reported, so a transition fires at most once. */
	#workingReported = false;
	/** Latched once a send blew its deadline; the transport is not usable after. */
	#sendWedged = false;
	/**
	 * Fires exactly once per owned delegation, after its output is finalized.
	 *
	 * `dispose()` can run after `#complete` already closed the turn, and a
	 * `#complete` for a superseded generation is a no-op. The `closing` state is
	 * what keeps the boundary exactly one-per-delegation either way: only a
	 * transition out of `running` produces it, and `#closeTurn` consumes it.
	 */
	readonly #onTurnClosed: (delegationId: string) => void;

	constructor(options: LiveHandoffBridgeOptions) {
		this.#session = options.session;
		this.#send = options.send;
		this.#extractAssistantText = options.extractAssistantText;
		this.#config = options.config;
		this.#onError = options.onError ?? (() => {});
		this.#onWorking = options.onWorking ?? (() => {});
		this.#onTurnClosed = options.onTurnClosed ?? (() => {});
		this.#turnOverrides = options.turnOverrides;
		this.#sendTimeoutMs = options.timeouts?.send ?? SEND_TIMEOUT_MS;
		this.#acceptTimeoutMs = options.timeouts?.accept ?? ACCEPT_TIMEOUT_MS;
		this.#abortTimeoutMs = options.timeouts?.abort ?? ABORT_TIMEOUT_MS;
		this.#drainTimeoutMs = options.timeouts?.drain ?? SEND_DRAIN_TIMEOUT_MS;
		const onScreen = options.onScreen ?? (() => {});
		this.#output = new LiveHandoffOutput(
			(text, channel) => this.#emitText(text, channel),
			(body, withheld) => onScreen(body, withheld),
		);
	}

	/** Closes the owned delegation's durable presentation range, exactly once. */
	/** The generation this bridge owns, if any. */
	get #active(): Generation | undefined {
		return this.#turn.kind === "running" ? this.#turn.generation : undefined;
	}

	/** Replace the owned generation, preserving cross-turn terminal debt. */
	#setActive(generation: Generation | undefined): void {
		const { debt } = this.#turn;
		if (generation) {
			this.#turn = { kind: "running", generation, debt };
			return;
		}
		// Leaving `running` owes a close; any other exit has nothing pending. The
		// delegation id rides along so the close can name the range it ends.
		this.#turn =
			this.#turn.kind === "running"
				? { kind: "closing", debt, delegationId: this.#turn.generation.delegationId }
				: { kind: "idle", debt };
	}

	#closeTurn(): void {
		if (this.#turn.kind !== "closing") return;
		const { delegationId } = this.#turn;
		this.#turn = { kind: "idle", debt: this.#turn.debt };
		this.#onTurnClosed(delegationId);
	}

	/** Whether a delegated backend turn is currently owned by this bridge. */
	get working(): boolean {
		return this.#active !== undefined;
	}

	/**
	 * Whether this bridge owns the presentation of the turn now streaming.
	 *
	 * Held until the durable range closes, not just while `#active` is set:
	 * `#complete` reports `working: false` for the indicator before the boundary
	 * callback runs, and the host must not start rendering that turn normally in
	 * the gap.
	 */
	get owningPresentation(): boolean {
		return this.#turn.kind !== "idle";
	}

	handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): Promise<void> {
		const request = event.item.content
			.map(part => part.text)
			.join("\n")
			.trim();
		if (!request || this.#disposed) return this.#eventChain;
		return this.#enqueue(() => this.#applyDelegation(event.item.id, request));
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		// Ingress closes at dispose; events already queued still drain.
		if (this.#disposed) return;
		void this.#enqueue(() => this.#applySessionEvent(event));
	}

	handleRealtimeEvent(event: LiveServerEvent): void {
		if (event.type === "turn.done" && event.turn.transcript.trim()) {
			this.#transcript.push({ role: event.turn.role, text: event.turn.transcript.trim() });
		}
	}

	/**
	 * Bounded wait for queued sideband sends.
	 *
	 * The transport can stall — a status addressed to a delegation the server
	 * already tore down never settles. Shutdown must not inherit that: an
	 * unbounded await here is what makes Ctrl-C stop working.
	 */
	async #drainSends(): Promise<void> {
		await this.#bounded(this.#sendChain, this.#drainTimeoutMs);
	}

	/** Drains queued events, then pushes buffered output to the voice model. */
	async flush(): Promise<void> {
		this.#clearFlushTimer();
		await this.#eventChain;
		this.#output.flush();
		await this.#drainSends();
	}

	/**
	 * Closes ingress, drains every accepted delegation and event, flushes
	 * output, and sends at most one remaining transcript tail. Nothing is sent
	 * after this resolves.
	 */
	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#clearFlushTimer();
		// Report not-working to the UI up front. Ownership itself is released
		// after the bounded drain below, because buffered speech is applied by
		// handlers still on that chain and `#emitText` needs `#active` to send
		// it. The callback is what the indicator reads, so the stuck "working"
		// indicator cannot outlive this call even if the drain times out.
		this.#setWorking(false);
		// Bounded: a handler still wedged on the chain must not make shutdown
		// unkillable. This is the wait that turned a stalled cancel into a
		// terminal that would not respond to Ctrl-C.
		const drained = await this.#bounded(this.#eventChain, this.#drainTimeoutMs);
		// Flush while `#active` is still set, since `#emitText` is gated on it.
		if (drained) this.#output.endMessage();
		this.#setActive(undefined);
		// Only a drained shutdown closes the durable range. An abandoned handler may
		// still produce output — a projection, a remainder, another message — so
		// closing here would make an incomplete artifact authoritative for the whole
		// range. The range simply stays unclosed and rebuild replays that turn's raw
		// history, which is strictly better. Nothing reopens it: `#active` is cleared
		// above, so a resumed `#complete` fails its generation guard and returns.
		//
		// Note this is NOT "no body has been flushed yet": a turn whose answer ended
		// non-terminally has already projected one, so the controller can be holding
		// a partial body at this point.
		if (drained) this.#closeTurn();
		if (!drained) {
			// Nothing further is flushed or sent from here: the abandoned handler may
			// still be mid-flight, and controller teardown owns closing the transport.
			logger.warn("Live event chain did not drain before shutdown; abandoning it", {
				timeoutMs: this.#drainTimeoutMs,
			});
			return;
		}
		await this.#drainSends();
		if (!this.#config.flushTranscriptTail) return;
		const tail = this.#transcriptDelta();
		if (!tail) return;
		const content = prompt.render(transcriptTailTemplate, { transcriptDelta: tail });
		// Bounded like every other shutdown wait: this goes through the agent
		// session rather than the transport, but an unbounded await here hangs
		// Ctrl-C just the same. Losing the tail is preferable to not exiting.
		const delivered = await this.#bounded(
			// Its own type: this opens no presentation range, so filing it as a
			// delegation would leave one open at the end of every call.
			this.#sendToSession(content, { deliverAs: "followUp", customType: LIVE_TAIL_MESSAGE_TYPE }),
			this.#drainTimeoutMs,
		);
		if (!delivered) {
			logger.warn("Live transcript tail did not deliver before shutdown; dropped", {
				timeoutMs: this.#drainTimeoutMs,
			});
		}
	}

	// --- FIFO event chain ---------------------------------------------------

	#enqueue(step: () => Promise<void>): Promise<void> {
		this.#eventChain = this.#eventChain.then(step).catch(error => {
			this.#onError(toError(error));
		});
		return this.#eventChain;
	}

	async #applyDelegation(id: string, rawRequest: string): Promise<void> {
		if (this.#disposed) return;
		// The sentinel is a control token; it must never reach the coding agent.
		const cancelling = rawRequest.includes(CANCEL_SENTINEL);
		const request = cancelling ? rawRequest.replaceAll(CANCEL_SENTINEL, "").trim() : rawRequest;
		if (cancelling && this.#active) {
			await this.#cancelActive();
			if (request) await this.#start(id, request);
			return;
		}
		if (!request) return;
		if (!this.#active) {
			await this.#start(id, request);
			return;
		}
		// A correction while a turn is running steers the same backend turn; the
		// pending ID only becomes active on the next assistant `message_start`.
		// Queued, never awaited: `#sendChain` already preserves outbound order,
		// and awaiting a sideband send on the FIFO event chain lets one stalled
		// send block every later delegation.
		const queued = this.#active;
		if (queued.pending) void this.#sendStatus(queued.pending.id, prompt.render(supersededTemplate, {}));
		queued.pending = { id, request };
		// Bounded for the same reason as the abort: this await sits on the FIFO
		// chain, and a delivery that never settles wedges every later
		// delegation. A steer is an in-process `agent.steer()`, so exceeding the
		// bound means something is genuinely broken — and because the delivery
		// may still land afterwards, the state is indeterminate. Fail loudly
		// rather than continue against a turn that may or may not have been
		// corrected.
		const steered = await this.#bounded(
			this.#sendToSession(this.#buildRequest(request), { deliverAs: "steer", delegationId: id }),
			this.#sendTimeoutMs,
		);
		if (!steered) {
			// Local state first, exactly as cancellation does: leaving `#active`
			// set here would reproduce the stuck-on-"working" UI this whole
			// change exists to eliminate.
			this.#setActive(undefined);
			this.#output.reset();
			this.#setWorking(false);
			// Nothing to project — `reset` discarded it — but the range still has
			// to close, or rebuild would treat the rest of the session as owned.
			this.#closeTurn();
			this.#disposed = true;
			this.#onError(new Error(`Live correction did not deliver within ${this.#sendTimeoutMs}ms; restart /live`));
		}
	}

	/**
	 * Explicit cancellation.
	 *
	 * Local state is torn down BEFORE the abort is awaited. `#cancelActive` runs
	 * on the FIFO event chain, so an abort that never settles would otherwise
	 * pin `#active` (the UI sticks on "working") and block every later
	 * delegation behind it — indistinguishable, from the outside, from a stalled
	 * sideband send. The abort is then awaited with a bound so neither wait can
	 * wedge the chain.
	 */
	async #cancelActive(): Promise<void> {
		const active = this.#active;
		if (!active) return;
		active.phase = "abandoned";
		if (active.pending) {
			void this.#sendStatus(active.pending.id, prompt.render(supersededTemplate, {}));
			active.pending = undefined;
		}
		// Counted before the abort so the aborted turn's terminal event is still
		// swallowed whenever it arrives.
		this.#turn = { ...this.#turn, debt: this.#turn.debt + 1 };
		await this.#complete(active, prompt.render(cancelledTemplate, {}));
		const settled = await this.#bounded(
			this.#session.abort({ goalReason: "interrupted", reason: "Live voice task cancelled" }),
			this.#abortTimeoutMs,
		);
		if (!settled) {
			// The coding turn may still be running. Continuing would let
			// the terminal debt swallow some later unrelated terminal event and
			// let a fresh delegation race the turn we failed to stop. Close
			// ingress and surface it: the call must be restarted.
			this.#turn = { ...this.#turn, debt: this.#turn.debt - 1 };
			this.#disposed = true;
			this.#onError(new Error(`Live cancellation did not settle within ${this.#abortTimeoutMs}ms; restart /live`));
		}
	}

	/** Awaits `work`, resolving `false` if it outlives `timeoutMs`. */
	async #bounded(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
		const expiry = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => expiry.resolve("timeout"), timeoutMs);
		try {
			return (await Promise.race([work.then(() => "done" as const), expiry.promise])) === "done";
		} finally {
			clearTimeout(timer);
		}
	}

	async #applySessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_end" && event.isTerminal !== false && this.#turn.debt > 0) {
			// The aborted turn's own terminal event, whether or not a replacement
			// has started. Consuming exactly one keeps it from completing anything.
			this.#turn = { ...this.#turn, debt: this.#turn.debt - 1 };
			return;
		}
		const active = this.#active;
		if (!active) return;
		switch (event.type) {
			case "message_start": {
				if (event.message.role !== "assistant") return;
				if (active.pending) {
					// The steered correction produced a fresh assistant turn: the
					// pending delegation owns it from here.
					const pending = active.pending;
					active.pending = undefined;
					await this.#complete(active, prompt.render(redirectedTemplate, {}));
					this.#activate(pending.id);
					const replacement = this.#active;
					if (replacement) replacement.phase = "streaming";
					return;
				}
				active.phase = "streaming";
				// A new message is a new answer, whatever it says.
				active.answerProjected = false;
				// A tool-use turn emits several assistant messages; each one gets
				// its own lane, speech budget, and final-text reconciliation.
				active.commentaryParts.clear();
				this.#output.beginMessage();
				this.#messageText = "";
				return;
			}
			case "message_update":
				if (!acceptsText(active)) return;
				if (event.assistantMessageEvent.type !== "text_delta") return;
				this.#appendDelta(active, event.assistantMessageEvent);
				return;
			case "message_end":
				if (event.message.role !== "assistant" || active.phase === "awaiting-start") return;
				if (event.message.stopReason === "toolUse") {
					// Not the turn's answer: close the message so its buffered
					// preamble crosses as silent context ahead of the tool wait,
					// without promoting it to speech. Never `flush()` here — this
					// handler runs ON the FIFO event chain that `flush()` awaits,
					// so awaiting it deadlocks the chain. `endMessage` already
					// queues the bytes; `#sendChain` drains them on its own.
					this.#clearFlushTimer();
					this.#output.endMessage(false);
					return;
				}
				active.phase = "message-closed";
				return;
			case "tool_execution_start":
			case "tool_execution_update":
				// Tool arguments and raw results never reach the voice model; only
				// that work is happening does.
				if (!active.commentaryEmitted) {
					active.commentaryEmitted = true;
					// A complete standalone record, not part of any assistant
					// message: emit it now. Waiting on the flush timer loses it
					// entirely when a fast tool start is followed by the next
					// `message_start`, which resets the stream.
					this.#emitStatusRecord(TOOL_STARTED_STATUS);
				}
				return;
			case "tool_execution_end":
				if (event.isError !== true || active.toolFailureReported) return;
				active.toolFailureReported = true;
				this.#emitStatusRecord(TOOL_FAILED_STATUS);
				return;
			case "agent_end":
				if (event.isTerminal === false) {
					// The turn continues on this same delegation, so ownership, the
					// working indicator and the durable range all stay put. The message
					// that just ended is still this turn's answer though: prose is
					// suppressed while the turn is owned, so leaving it unprojected is
					// the reply reaching neither the voice lane in full nor the screen.
					if (this.#projectAnswer(active, event.messages)) this.#output.endMessage();
					return;
				}
				// No debt check here: the guard at the top of this method already
				// consumes an owed terminal and returns, so this line is only reached
				// when the count is zero.
				await this.#finish(active, event.messages);
				return;
			default:
		}
	}

	#appendDelta(
		active: Generation,
		event: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
	): void {
		if (event.type !== "text_delta") return;
		const part = event.partial.content[event.contentIndex];
		const phase = part?.type === "text" ? parseTextSignature(part.textSignature)?.phase : undefined;
		// One assistant message can carry commentary and final parts, so the
		// channel follows each part, not the message. The verdict is latched per
		// part because streamed phase metadata can lapse on later deltas. Phase
		// is the only signal: no marker is ever emitted or parsed, and a part
		// with no phase is treated as the spoken answer.
		if (phase === "commentary") active.commentaryParts.add(event.contentIndex);
		const commentary = active.commentaryParts.has(event.contentIndex);
		const channel: LiveContextChannel = commentary ? "commentary" : "speakable";
		this.#messageText += event.delta;
		if (commentary) active.commentaryEmitted = true;
		this.#output.append(event.delta, channel, event.contentIndex);
		this.#scheduleFlush();
	}

	/**
	 * Emits one self-contained commentary record immediately.
	 *
	 * Internal statuses are whole messages of their own, so they get their own
	 * message boundary rather than joining whatever assistant message happens
	 * to be open. Channel routing is carried entirely by the streamed `phase`
	 * metadata and the explicit `channel` field on the wire; no bracketed
	 * marker is emitted or parsed anywhere.
	 */
	#emitStatusRecord(text: string): void {
		this.#output.emitStatus(text);
	}

	// --- Delegation lifecycle ------------------------------------------------

	async #start(id: string, request: string): Promise<void> {
		// Nothing may be sent after teardown: a handler abandoned by the bounded
		// dispose drain can resume here and would otherwise open a fresh coding
		// turn against a session that is already gone.
		if (this.#disposed) return;
		this.#activate(id);
		await this.#sendToSession(this.#buildRequest(request), { triggerTurn: true, delegationId: id });
	}

	/**
	 * Reports a working transition exactly once.
	 *
	 * Cancel, steer timeout, complete, retire, and dispose can all land on the
	 * same transition; latching keeps the indicator from flickering and, more
	 * importantly, stops a late handler re-reporting `true` after teardown.
	 */
	#setWorking(working: boolean): void {
		if (this.#workingReported === working) return;
		this.#workingReported = working;
		this.#onWorking(working);
	}

	#activate(id: string): void {
		this.#generationCounter += 1;
		this.#setActive({
			id: this.#generationCounter,
			delegationId: id,
			phase: "awaiting-start",
			pending: undefined,
			commentaryEmitted: false,
			toolFailureReported: false,
			commentaryParts: new Set(),
			answerProjected: false,
		});
		this.#messageText = "";
		this.#output.reset();
		this.#setWorking(true);
	}

	async #complete(generation: Generation, status?: string): Promise<void> {
		if (this.#active?.id !== generation.id) return;
		this.#output.endMessage();
		// Local state transitions BEFORE any network work, and the status send is
		// deliberately not awaited.
		//
		// `#complete` runs on the FIFO event chain. Awaiting a sideband send here
		// means one stalled `transport.send` pins `#active` (the UI sticks on
		// "working"), blocks every later delegation behind it, and hangs
		// `dispose()` — which awaits the same chain — so Ctrl-C stops working
		// too. That is exactly what a cancel triggers: the status is addressed to
		// the delegation we just tore down. Ordering of outbound messages is
		// preserved by `#sendChain` itself, so nothing here needs to await it.
		this.#setActive(undefined);
		this.#setWorking(false);
		// After `endMessage`: the boundary must observe this turn's screen body.
		this.#closeTurn();
		if (status) void this.#sendStatus(generation.delegationId, status);
	}

	/**
	 * Reconciles the answer message that just ended against what the stream
	 * already carried, so the visible final text is what crosses.
	 *
	 * Returns whether this answer is new. A turn can end its answer without
	 * ending the turn, and the later terminal event repeats that same answer;
	 * projecting it again would speak the reply twice and draw it twice.
	 */
	#projectAnswer(generation: Generation, messages: readonly AgentMessage[]): boolean {
		let finalText = "";
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			finalText = this.#extractAssistantText(message);
			if (finalText) break;
		}
		if (generation.answerProjected) return false;
		// Nothing to project yet. Marking the message done here would suppress a
		// later terminal event that carries the real answer.
		if (!finalText && !this.#messageText) return false;
		generation.answerProjected = true;
		const remainder = finalText.startsWith(this.#messageText)
			? finalText.slice(this.#messageText.length)
			: this.#messageText
				? ""
				: finalText;
		if (remainder) {
			// `extractAssistantText` is the visible final answer, so anything the
			// stream did not already carry is spoken, never commentary.
			this.#output.append(remainder, "speakable", REMAINDER_PART);
		}
		return true;
	}

	async #finish(generation: Generation, messages: readonly AgentMessage[]): Promise<void> {
		this.#projectAnswer(generation, messages);
		const pending = generation.pending;
		generation.pending = undefined;
		await this.#complete(generation);
		if (pending) await this.#start(pending.id, pending.request);
	}

	// --- Outbound ------------------------------------------------------------

	#scheduleFlush(): void {
		if (this.#flushTimer) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.#output.flush();
		}, this.#config.handoffFlushMs);
	}

	#clearFlushTimer(): void {
		if (!this.#flushTimer) return;
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
	}

	#queueMessage(message: LiveClientMessage): void {
		this.#sendChain = this.#sendChain
			.then(() => this.#sendBounded(message))
			.catch(error => {
				this.#onError(toError(error));
			});
	}

	/**
	 * Sends one sideband message under a deadline.
	 *
	 * `#sendChain` is strictly serial, and an unbounded `transport.send` that
	 * never settles pins every later status and every spoken word behind it —
	 * which also wedges the FIFO event chain and shutdown. So the wait is
	 * bounded.
	 *
	 * A timeout cannot "skip" the message: `Promise.race` does not cancel the
	 * underlying send, which is still running and may still write to the wire.
	 * Starting the next send would therefore overlap it and break the serial
	 * ordering the chain exists to guarantee. A transport that has not accepted
	 * a small message within the deadline is wedged, so stop writing to it and
	 * surface that instead of corrupting the stream.
	 */
	async #sendBounded(message: LiveClientMessage): Promise<void> {
		if (this.#sendWedged) return;
		const expiry = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => expiry.resolve("timeout"), this.#sendTimeoutMs);
		try {
			const outcome = await Promise.race([this.#send(message).then(() => "sent" as const), expiry.promise]);
			if (outcome === "timeout") {
				this.#sendWedged = true;
				this.#disposed = true;
				this.#setWorking(false);
				this.#onError(new Error(`Live sideband send stalled beyond ${this.#sendTimeoutMs}ms; restart /live`));
			}
		} finally {
			clearTimeout(timer);
		}
	}

	#emitText(text: string, channel: LiveContextChannel | undefined): void {
		const id = this.#active?.delegationId;
		if (!id || !text) return;
		for (const chunk of chunkLiveContext(text)) {
			this.#queueMessage(buildDelegationContextAppend(id, chunk, channel));
		}
	}

	#sendStatus(id: string, text: string): Promise<void> {
		for (const chunk of chunkLiveContext(text)) {
			this.#queueMessage(buildDelegationContextAppend(id, chunk, "commentary"));
		}
		return this.#sendChain;
	}

	// --- Transcript hand-off -------------------------------------------------

	/** Turns recorded since the last accepted hand-off, as `role: text` lines. */
	#transcriptDelta(): string {
		return this.#transcript
			.slice(this.#lastHandoffTurn)
			.map(turn => `${turn.role}: ${turn.text}`)
			.join("\n");
	}

	#buildRequest(request: string): string {
		return prompt.render(delegationTemplate, {
			request,
			transcriptDelta: this.#transcriptDelta(),
		});
	}

	/**
	 * Sends one internal delegation envelope and advances the transcript
	 * watermark only once the session reports it accepted the message, so a
	 * rejected send leaves the same turns available for the retry or the final
	 * tail flush.
	 *
	 * `triggerTurn` sends resolve only when the whole backend turn ends, so the
	 * returned promise is not awaited for those: the FIFO event chain must keep
	 * draining the very `message_start`/`message_end` events that turn emits.
	 * `onAccepted` is what separates "the session owns this" from "the turn
	 * finished". A refused triggered send produces no lifecycle events at all,
	 * so it must retire its own generation or the bridge stays busy forever.
	 */
	#sendToSession(
		content: string,
		options: {
			deliverAs?: "steer" | "followUp";
			triggerTurn?: boolean;
			customType?: string;
			/** Stamped on the row so rebuild pairs this opener with its own close. */
			delegationId?: string;
		},
	): Promise<void> {
		const boundary = this.#transcript.length;
		const generation = options.triggerTurn ? this.#active : undefined;
		let accepted = false;
		// Aborted when the acceptance deadline fires. This cancels the usage
		// preflight inside `sendCustomMessage` — which reaches the network and
		// can wait on a fallback confirmation — so a delegation we gave up on is
		// actually released rather than left pinned, and cannot commit a turn
		// behind our back afterwards.
		const cancellation = new AbortController();
		const delivery = this.#session.sendCustomMessage(
			{
				customType: options.customType ?? LIVE_DELEGATION_MESSAGE_TYPE,
				content,
				// Internal protocol envelopes stay persisted for provenance but
				// never render as framed transcript boxes.
				display: false,
				...(options.delegationId ? { details: { delegationId: options.delegationId } } : {}),
				attribution: "agent",
			},
			{
				...options,
				// Only a turn-starting send can carry these; a steer joins a turn
				// that is already configured, and the session refuses rather than
				// dropping them silently.
				turnOverrides: options.triggerTurn ? this.#turnOverrides : undefined,
				signal: cancellation.signal,
				onAccepted: () => {
					if (cancellation.signal.aborted) return;
					accepted = true;
					this.#lastHandoffTurn = boundary;
				},
			},
		);
		if (!options.triggerTurn) return delivery.then(() => {});
		const retire = (): void => {
			// Settled without acceptance — a rejection, or a preflight decline
			// that resolves normally. Either way no lifecycle event is coming.
			if (accepted || !generation) return;
			void this.#enqueue(() => this.#retire(generation));
		};
		// The delivery itself cannot be bounded: it resolves only when the whole
		// backend turn ends, which is legitimately minutes. Acceptance can be —
		// but generously, because the preflight it waits on may be asking the
		// user to confirm a model fallback. Without this the generation would
		// stay active, with the indicator stuck on "working" and no event ever
		// arriving to clear it.
		const acceptance = setTimeout(() => {
			if (accepted) return;
			// Aborting is what actually releases it: the signal cancels the
			// in-flight preflight and is re-checked before acceptance and before
			// the prompt, so a delivery still pending here can neither pin the
			// session nor commit work after we release ownership.
			cancellation.abort();
			logger.warn("Live delegation was never accepted; retiring it", {
				timeoutMs: this.#acceptTimeoutMs,
			});
			retire();
		}, this.#acceptTimeoutMs);
		void delivery
			.then(retire, error => {
				this.#onError(toError(error));
				retire();
			})
			.finally(() => clearTimeout(acceptance));
		return Promise.resolve();
	}

	/**
	 * Drop a generation that never ran, leaving a later one untouched.
	 *
	 * A rejection can settle long after `dispose()`, so this never starts a
	 * replacement once ingress is closed — nothing may be sent after dispose.
	 */
	async #retire(generation: Generation): Promise<void> {
		if (this.#active?.id !== generation.id || generation.phase !== "awaiting-start") return;
		this.#output.reset();
		const pending = generation.pending;
		// Local state first, then the notice — queued, never awaited. This runs
		// on the FIFO event chain, so awaiting a sideband send here would let one
		// stalled send pin "working" and block every later delegation.
		// `#sendStatus` takes the id explicitly, so it does not depend on
		// `#active` the way `#emitText` does.
		this.#setActive(undefined);
		this.#setWorking(false);
		// Closed before any replacement activates, so the ranges never nest.
		this.#closeTurn();
		if (!pending && !this.#disposed) {
			// Nothing is replacing this request, so the user asked for something
			// that will never run. Say so rather than leaving them in silence.
			void this.#sendStatus(generation.delegationId, prompt.render(retiredTemplate, {}));
		}
		if (pending && !this.#disposed) await this.#start(pending.id, pending.request);
	}
}
