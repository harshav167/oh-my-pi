import * as os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { liveAudioProcessingAvailable } from "@oh-my-pi/pi-natives";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AgentTurnOverrides } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { AuthStorage } from "../session/auth-storage";
import type { CustomMessagePayload } from "../session/messages";
import {
	LIVE_TRANSCRIPT_MESSAGE_TYPE,
	LIVE_WORKER_MESSAGE_TYPE,
	type LiveTranscriptDetails,
	type LiveWorkerDetails,
} from "../session/messages";
import type { LiveConfig } from "./config";
import { buildLiveInitialItems } from "./continuity";
import type { LiveHandoffSession } from "./handoff";
import { LiveHandoffBridge } from "./handoff";
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };
import { buildSessionClose, type LiveClientMessage, type LiveServerEvent } from "./protocol";
import { CodexLiveTransport, LiveEndError, type LiveTransportOptions } from "./transport";
import type { LiveVoiceState, LiveWorkerState } from "./visualizer";

interface LiveTransport {
	connect(): Promise<void>;
	send(message: LiveClientMessage): Promise<void>;
	close(): Promise<void>;
	activate(): void;
	setMuted(muted: boolean): Promise<void>;
	setOutputMuted(muted: boolean): Promise<void>;
	refreshMicrophone(inputDeviceId: string): void;
}

export interface LiveSessionDependencies {
	readonly audioProcessingAvailable: boolean;
	createTransport(options: LiveTransportOptions): LiveTransport;
	setTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
	clearTimer(timer: NodeJS.Timeout): void;
}

const DEFAULT_DEPENDENCIES: LiveSessionDependencies = {
	audioProcessingAvailable: liveAudioProcessingAvailable(),
	createTransport: options => new CodexLiveTransport(options),
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: timer => clearTimeout(timer),
};

/** Incremental or final transcript for one realtime conversational turn. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	/** Monotonic role-local turn number used to coalesce streaming updates. */
	turn: number;
	final: boolean;
}

/** Connection lifecycle of a realtime call, independent of audio activity. */
export type LiveConnectionState = "connecting" | "active" | "error" | "closed";

/**
 * Orthogonal live-call state.
 *
 * Voice activity and backend work are independent: the assistant can speak
 * while a delegated turn runs, and a fresh call is never "working" just
 * because unrelated session streaming is in flight.
 */
export interface LiveState {
	readonly connection: LiveConnectionState;
	readonly voice: LiveVoiceState;
	readonly worker: LiveWorkerState;
	readonly inputMuted: boolean;
	readonly outputMuted: boolean;
}

/** UI notifications emitted during a live session. */
export interface LiveSessionCallbacks {
	/** Reports any change to the orthogonal call state. */
	onState(state: LiveState): void;
	/** Reports clamped microphone and speaker RMS levels. */
	onLevels(input: number, output: number): void;
	/** Reports the latest available conversational transcript. */
	onTranscript(transcript: LiveTranscript | undefined): void;
	/**
	 * Reports the part of a delegated turn's body that audio never took: code past
	 * a fence, an overflow tail, or a directive-led detail part.
	 *
	 * Nothing fires when the voice lane took the whole answer — it is already on
	 * screen as the voice model's transcript row, and drawing it again put the same
	 * answer up twice in two different colours. The durable row keeps the FULL
	 * body either way, because the voice paraphrases and a reload has no voice at
	 * all.
	 */
	onScreen?(text: string): void;
	/** Reports one terminal stop, optionally carrying its cause. */
	onTerminal(error?: Error): void;
}

/**
 * Everything a live call needs from its host, named explicitly.
 *
 * A port rather than `AgentSession`: the controller used six unrelated members
 * of it (display context, active tools, auth storage, session id, settings,
 * log-only append), which tied the whole voice feature to the concrete session
 * class and made it unreachable from an extension. Each member below maps to a
 * capability the extension surface already exposes.
 */
export interface LiveSessionHost {
	/** Delegation port: turn sends with overrides, abort, and the event stream. */
	readonly turnSession: LiveTurnSession;
	/** Consumer OAuth for the private call route. */
	readonly authStorage: AuthStorage;
	/** Session identity carried on the call. */
	readonly sessionId: string;
	/** Messages continuity seeds the next call from. */
	contextMessages(): AgentMessage[];
	/** Tool names active on this session, for computer-use gating. */
	activeToolNames(): string[];
	/** The resolved identity delegated coding turns run on. */
	resolveCodingOverrides(): AgentTurnOverrides;
	/**
	 * Persist a row without touching model context.
	 *
	 * The single persistence site for a call: transcript turns and the screen
	 * artifact both route here, so no caller can double-write them.
	 */
	appendLogOnly<T>(message: CustomMessagePayload<T>): boolean;
	/** Visible assistant text, using the host's own extraction rules. */
	extractAssistantText(message: AssistantMessage): string;
}

/** Session capabilities the handoff bridge and controller drive turns through. */
export type LiveTurnSession = LiveHandoffSession & {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
};

export interface LiveSessionControllerOptions {
	/** Host capabilities this call runs on. */
	host: LiveSessionHost;
	/** UI callbacks for live session state. */
	callbacks: LiveSessionCallbacks;
	/** Immutable settings snapshot for this call. */
	config: LiveConfig;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, level);
}

function currentUser(): { username: string; firstName: string } {
	let username = "user";
	try {
		const candidate = os.userInfo().username.trim();
		if (candidate) username = candidate;
	} catch {
		// Sandboxed runtimes may not expose OS account information.
	}
	const firstPart = username.split(/[._\-\s]+/).find(part => part.length > 0);
	return { username, firstName: firstPart ?? "there" };
}

/**
 * Reduces one role's transcript stream into discrete turns.
 *
 * Codex sends either cumulative snapshots or incremental deltas depending on
 * the utterance, and whitespace inside a delta is meaningful. Cumulative
 * updates are accepted only when they extend the current text; anything else is
 * appended verbatim. A final event closes the turn, so an identical utterance
 * spoken twice stays two turns.
 */
class TranscriptTurns {
	#text = "";
	#turn = 0;
	#open = false;

	/** Applies a streaming delta, returning the current turn's full text. */
	delta(text: string): { turn: number; text: string } | undefined {
		if (!text) return undefined;
		if (!this.#open) {
			this.#turn += 1;
			this.#open = true;
			this.#text = text;
		} else if (text.startsWith(this.#text)) {
			this.#text = text;
		} else {
			this.#text += text;
		}
		return { turn: this.#turn, text: this.#text };
	}

	/**
	 * Closes the current turn with the server's authoritative final bytes.
	 *
	 * Re-delivering the identical final for an already-closed turn is a
	 * duplicate, not a second utterance; a genuine repeat arrives with deltas
	 * that reopen the turn first.
	 */
	final(text: string): { turn: number; text: string } | undefined {
		if (!text) return undefined;
		if (!this.#open) {
			if (this.#text === text) return undefined;
			this.#turn += 1;
		}
		this.#open = false;
		this.#text = text;
		return { turn: this.#turn, text };
	}
}

/** Coordinates the realtime conversational surface with normal AgentSession turns. */
export class LiveSessionController {
	readonly #host: LiveSessionHost;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	readonly #config: LiveConfig;
	readonly #deps: LiveSessionDependencies;
	readonly #audioProcessingAvailable: boolean;

	#transport: LiveTransport | undefined;
	#handoff: LiveHandoffBridge | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#stopPromise: Promise<void> | undefined;
	#refreshPromise: Promise<void> | undefined;
	#startup = Promise.withResolvers<void>();
	readonly #abortController = new AbortController();
	#connectTimer: NodeJS.Timeout | undefined;
	#inactivityTimer: NodeJS.Timeout | undefined;
	#started = false;
	#signalingEstablished = false;
	#active = false;
	#stopped = false;
	#terminalEmitted = false;
	#failure: Error | undefined;

	#connection: LiveConnectionState = "connecting";
	#voice: LiveVoiceState = "listening";
	#worker: LiveWorkerState = "idle";
	#muted = false;
	#outputMuted = false;
	#inputLevel = 0;
	#outputLevel = 0;
	readonly #userTurns = new TranscriptTurns();
	readonly #assistantTurns = new TranscriptTurns();
	/** Full screen bodies for the delegation currently owned, in message order. */
	readonly #screenBody: string[] = [];
	/**
	 * What the call actually drew for that delegation, in message order.
	 *
	 * Persisted beside the full body so a rebuilt transcript can reproduce the
	 * call instead of restating an answer the voice already delivered.
	 */
	readonly #drawnBody: string[] = [];
	/** Resolved once in `start()`; the identity delegated turns actually run on. */
	#codingOverrides: AgentTurnOverrides | undefined;
	#lastTranscript: LiveTranscript | undefined;

	constructor(options: LiveSessionControllerOptions, dependencies: LiveSessionDependencies = DEFAULT_DEPENDENCIES) {
		this.#host = options.host;
		this.#callbacks = options.callbacks;
		this.#extractAssistantText = message => options.host.extractAssistantText(message);
		this.#config = options.config;
		this.#deps = dependencies;
		this.#audioProcessingAvailable = dependencies.audioProcessingAvailable;
	}

	/** Current orthogonal call state. */
	get state(): LiveState {
		return {
			connection: this.#connection,
			voice: this.#voice,
			worker: this.#worker,
			inputMuted: this.#muted,
			outputMuted: this.#outputMuted,
		};
	}

	/**
	 * Whether the voice handoff currently owns a delegated coding turn.
	 *
	 * Scoped to the handoff's own generation, not to the call: an unrelated
	 * terminal or extension turn running during a live call is not owned here and
	 * keeps its ordinary transcript rendering.
	 */
	get delegatedTurnActive(): boolean {
		return this.#handoff?.owningPresentation === true;
	}

	/** Whether microphone input is currently muted. */
	get muted(): boolean {
		return this.#muted;
	}

	/** Whether speaker output is currently muted. */
	get outputMuted(): boolean {
		return this.#outputMuted;
	}

	/** Connects the realtime surface and starts microphone streaming. */
	async start(): Promise<void> {
		if (this.#stopped) {
			throw (
				this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.")
			);
		}
		if (this.#started) return;
		this.#started = true;
		this.#emitState();
		this.#emitTranscript(undefined);

		if (!this.#audioProcessingAvailable) {
			logger.warn("Live WebRTC audio processing is unavailable; using unprocessed microphone audio", {
				echoCancellationMode: this.#config.echoCancellationMode,
				noiseSuppressionLevel: this.#config.noiseSuppressionLevel,
				agcMode: this.#config.agcMode,
			});
		}
		try {
			const initialItems = this.#config.includeContinuity
				? buildLiveInitialItems(this.#host.contextMessages(), {
						maxItems: this.#config.continuityMaxItems,
						maxTokens: this.#config.continuityMaxTokens,
					})
				: [];
			const instructions = prompt.render(liveInstructionsTemplate, {
				...currentUser(),
				hasContinuity: initialItems.length > 0,
				computerAvailable: this.#config.computerUse === "auto" && this.#host.activeToolNames().includes("computer"),
			});
			const transport = this.#deps.createTransport({
				authStorage: this.#host.authStorage,
				sessionId: this.#host.sessionId,
				instructions,
				model: this.#config.model,
				voice: this.#config.voice,
				initialItems,
				audioProcessing: {
					echoCancellation: this.#config.echoCancellationMode,
					echoDelayMs: this.#config.echoDelayMs,
					noiseSuppression: this.#config.noiseSuppressionLevel,
					agc: this.#config.agcMode,
					agcTargetLevelDbfs: this.#config.agcTargetLevelDbfs,
					agcCompressionGainDb: this.#config.agcCompressionGainDb,
					agcLimiter: this.#config.agcLimiter,
				},
				inputDeviceId: this.#config.inputDeviceId,
				outputDeviceId: this.#config.outputDeviceId,
				connectTimeoutMs: this.#config.connectTimeoutMs,
				sidebandConnectAttempts: this.#config.sidebandConnectAttempts,
				signal: this.#abortController.signal,
				callbacks: {
					onEvent: event => this.#guardEvent(() => this.#handleLiveEvent(event)),
					onInputLevel: level => this.#guardEvent(() => this.#handleInputLevel(level)),
					onOutputLevel: level => this.#guardEvent(() => this.#handleOutputLevel(level)),
					onSignalingEstablished: () => {
						this.#signalingEstablished = true;
					},
					onTerminal: error => this.#reportFailure(error),
				},
			});
			this.#transport = transport;
			this.#handoff = new LiveHandoffBridge({
				session: this.#host.turnSession,
				send: message => transport.send(message),
				extractAssistantText: this.#extractAssistantText,
				config: this.#config,
				onError: error => this.#reportFailure(error),
				onWorking: working => this.#guardEvent(() => this.#setWorker(working ? "working" : "idle")),
				// Persist both: the full body for a reload, and the part the voice lane
				// never took, which is the only part drawn now.
				onScreen: (body, withheld) =>
					this.#guardEvent(() => {
						this.#screenBody.push(body);
						if (!withheld) return;
						this.#drawnBody.push(withheld);
						this.#callbacks.onScreen?.(withheld);
					}),
				// Persist on the explicit close, never on the `working` indicator:
				// teardown reports not-working before the final output is flushed, so
				// keying persistence off the indicator would write an empty boundary
				// and strand the body.
				onTurnClosed: () => this.#guardEvent(() => this.#persistWorkerArtifact()),
				turnOverrides: this.#turnOverrides(),
			});
			this.#unsubscribeSession = this.#host.turnSession.subscribe(event =>
				this.#guardEvent(() => this.#handleSessionEvent(event)),
			);
			const timeout = Promise.withResolvers<void>();
			this.#connectTimer = this.#deps.setTimer(
				() => timeout.reject(new Error("Timed out activating the live voice session")),
				this.#config.connectTimeoutMs,
			);
			await Promise.race([transport.connect().then(() => this.#startup.promise), timeout.promise]);
			this.#clearConnectTimer();
			if (this.#stopped) throw this.#failure ?? new Error("The live session stopped while connecting.");
			this.#active = true;
			this.#connection = "active";
			if (this.#muted) await transport.setMuted(true);
			if (this.#outputMuted) await transport.setOutputMuted(true);
			// One activation, after the barrier: retained startup speech is
			// released natively and never crosses this boundary as PCM.
			transport.activate();
			this.#resetInactivity();
			this.#emitState();
		} catch (cause) {
			const error = errorFrom(cause);
			this.#reportFailure(error);
			await this.stop().catch(() => {});
			throw error;
		}
	}

	/** Toggles microphone capture while leaving output and the session connected. */
	toggleMute(): void {
		if (this.#stopped) return;
		this.#muted = !this.#muted;
		if (this.#muted) {
			this.#inputLevel = 0;
			this.#emitLevels();
		}
		this.#emitState();
		void this.#transport?.setMuted(this.#muted).catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	/** Toggles user-controlled speaker mute without stopping remote media. */
	toggleOutputMute(): void {
		if (this.#stopped) return;
		this.#outputMuted = !this.#outputMuted;
		this.#emitState();
		void this.#transport?.setOutputMuted(this.#outputMuted).catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	/** Reopens the configured microphone while retaining the live transport. */
	refreshMicrophone(): Promise<void> {
		if (this.#refreshPromise) return this.#refreshPromise;
		const operation = (async () => {
			if (this.#stopped) return;
			this.#transport?.refreshMicrophone(this.#config.inputDeviceId);
		})().catch(cause => {
			const error = errorFrom(cause);
			this.#reportFailure(error);
			throw error;
		});
		this.#refreshPromise = operation.finally(() => {
			this.#refreshPromise = undefined;
		});
		return this.#refreshPromise;
	}

	/** Stops recording, drains handoffs, closes transports, and emits one terminal callback. */
	stop(): Promise<void> {
		if (!this.#stopPromise) this.#stopPromise = this.#stop();
		return this.#stopPromise;
	}

	async #stop(): Promise<void> {
		this.#startup.resolve();
		this.#stopped = true;
		// A call that reached signaling has a server-side session even if it
		// never activated; it must be closed, not just abandoned.
		const needsSessionClose = this.#active || this.#signalingEstablished;
		this.#active = false;
		this.#clearConnectTimer();
		this.#clearInactivityTimer();
		const errors: Error[] = [];
		try {
			await this.#handoff?.dispose();
		} catch (cause) {
			errors.push(errorFrom(cause));
		}
		this.#handoff = undefined;
		const transport = this.#transport;
		this.#transport = undefined;
		if (transport && needsSessionClose) {
			try {
				await transport.send(buildSessionClose());
			} catch (cause) {
				errors.push(errorFrom(cause));
			}
		}
		this.#abortController.abort(new DOMException("Live session stopped", "AbortError"));
		if (transport) {
			try {
				await transport.close();
			} catch (cause) {
				errors.push(errorFrom(cause));
			}
		}
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		const cleanupError = errors.length ? new AggregateError(errors, "Live session cleanup failed") : undefined;
		this.#connection = this.#failure || cleanupError ? "error" : "closed";
		this.#emitStateSafely();
		this.#emitTerminal(this.#failure ?? cleanupError);
		if (cleanupError) throw cleanupError;
	}

	#guardEvent(handler: () => void): void {
		if (this.#stopped) return;
		try {
			handler();
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	/**
	 * Model, effort, and voice contract for every delegated coding turn.
	 *
	 * Resolved once during `start()` so a bad `live.codingModel` fails the
	 * command with a readable reason instead of surfacing as a wrong-sounding
	 * turn mid-call. It MUST NOT degrade to `undefined` on failure: a turn with
	 * no contract is exactly the unrestrained, terminal-shaped agent this
	 * whole path exists to prevent.
	 */
	#turnOverrides(): AgentTurnOverrides {
		if (this.#codingOverrides) return this.#codingOverrides;
		// Resolved by the host: model resolution needs the registry and settings,
		// neither of which belongs in this controller's surface. Cached so the
		// artifact identity and the turn identity cannot diverge — re-resolving
		// could pick a different model if the registry changed mid-call.
		this.#codingOverrides = this.#host.resolveCodingOverrides();
		return this.#codingOverrides;
	}

	/** The model delegated coding turns run on, once resolved by `start()`. */
	get codingModel(): AgentTurnOverrides["model"] {
		return this.#codingOverrides?.model;
	}

	#handleLiveEvent(event: LiveServerEvent): void {
		this.#handoff?.handleRealtimeEvent(event);
		switch (event.type) {
			case "session.started":
				this.#startup.resolve();
				break;
			case "session.updated":
			case "unknown":
				break;
			case "live.diagnostic":
				logger.warn("Live media diagnostic", { message: event.message });
				break;
			case "output_audio.delta":
				this.#resetInactivity();
				break;
			case "input_transcript.added":
				this.#resetInactivity();
				this.#applyTranscript("user", this.#userTurns.delta(event.item.text), false);
				break;
			case "output_transcript.added":
				this.#resetInactivity();
				this.#applyTranscript("assistant", this.#assistantTurns.delta(event.item.text), false);
				break;
			case "turn.done": {
				this.#resetInactivity();
				const turns = event.turn.role === "user" ? this.#userTurns : this.#assistantTurns;
				this.#applyTranscript(event.turn.role, turns.final(event.turn.transcript), true);
				break;
			}
			case "delegation.created":
				this.#resetInactivity();
				void this.#handoff?.handleDelegation(event).catch(error => this.#reportFailure(error));
				break;
			case "error": {
				const error = new Error(event.message);
				this.#startup.reject(error);
				this.#reportFailure(error);
				break;
			}
		}
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		this.#handoff?.handleSessionEvent(event);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			this.#resetInactivity();
		}
	}

	#handleInputLevel(level: number): void {
		this.#inputLevel = this.#muted ? 0 : clampLevel(level);
		this.#emitLevels();
		if (this.#inputLevel >= this.#config.vadStartRms) this.#resetInactivity();
	}

	#handleOutputLevel(level: number): void {
		this.#outputLevel = clampLevel(level);
		this.#emitLevels();
		// Rendered output level is the only source of the speaking state; it
		// never mutes anything.
		this.#setVoice(this.#outputLevel > this.#config.outputActiveLevel ? "speaking" : "listening");
	}

	#resetInactivity(): void {
		this.#clearInactivityTimer();
		if (this.#config.inactivityTimeoutMinutes === 0 || this.#stopped) return;
		this.#inactivityTimer = this.#deps.setTimer(
			() => this.#reportFailure(new LiveEndError("inactivity", "Live voice session ended after inactivity")),
			this.#config.inactivityTimeoutMinutes * 60_000,
		);
	}

	#clearConnectTimer(): void {
		if (!this.#connectTimer) return;
		this.#deps.clearTimer(this.#connectTimer);
		this.#connectTimer = undefined;
	}

	#clearInactivityTimer(): void {
		if (!this.#inactivityTimer) return;
		this.#deps.clearTimer(this.#inactivityTimer);
		this.#inactivityTimer = undefined;
	}

	#applyTranscript(
		role: LiveTranscript["role"],
		turn: { turn: number; text: string } | undefined,
		final: boolean,
	): void {
		if (!turn) return;
		// Whitespace inside deltas is meaningful; only display and persistence
		// are trimmed.
		const text = turn.text.trim();
		if (!text) return;
		if (final) this.#persistTranscriptTurn(role, text);
		if (
			this.#lastTranscript?.role === role &&
			this.#lastTranscript.turn === turn.turn &&
			this.#lastTranscript.text === text &&
			this.#lastTranscript.final === final
		) {
			return;
		}
		this.#emitTranscript({ role, turn: turn.turn, text, final });
	}

	/**
	 * Records one completed voice turn so a later call can be seeded from it.
	 *
	 * Log-only by necessity, not preference: `sendCustomMessage` appends to
	 * `agent.state.messages` in every branch, so the assistant's own speech
	 * would re-enter the model as input — the echo loop that produced 13 coding
	 * turns from one delegation. `display: false` is a TUI flag and does not gate
	 * that. `appendLogOnlyCustomMessage` is the canonical boundary for exactly
	 * this, and it swallows write failures: this runs under `#guardEvent`, where
	 * an escaping throw becomes `#reportFailure` and ends the call, while a lost
	 * transcript row only degrades the next call's seed.
	 */
	#persistTranscriptTurn(role: LiveTranscript["role"], text: string): void {
		this.#host.appendLogOnly<LiveTranscriptDetails>({
			customType: LIVE_TRANSCRIPT_MESSAGE_TYPE,
			content: text,
			display: false,
			// The voice model, not the coding model: rebuild credits a replayed
			// assistant utterance to whoever actually said it.
			details: { role, text, model: this.#config.model },
			attribution: "agent",
		});
	}

	/**
	 * Closes the persisted presentation range for one delegated turn.
	 *
	 * Written for every delegation, screen body or not: the row IS the ownership
	 * boundary a rebuilt transcript needs, so omitting it when the turn spoke
	 * without written detail would leave that range replaying as ordinary
	 * main-agent output. Log-only for the same reason as
	 * {@link #persistTranscriptTurn}, and best-effort for the same reason.
	 */
	#persistWorkerArtifact(): void {
		const screen = this.#screenBody.join("\n\n").trim();
		const withheld = this.#drawnBody.join("\n\n").trim();
		this.#screenBody.length = 0;
		this.#drawnBody.length = 0;
		this.#host.appendLogOnly<LiveWorkerDetails>({
			customType: LIVE_WORKER_MESSAGE_TYPE,
			content: screen,
			// Never displayed as a generic custom card. Rendering this row belongs to
			// code that understands the ownership range — the TUI rebuild projection —
			// and the surfaces that key off `display` (the HTML export, the chat
			// transcript builder) do not, so they drew the report a second time beside
			// the prose it was meant to replace.
			display: false,
			details: { screen, withheld },
			attribution: "agent",
		});
	}

	#setVoice(voice: LiveVoiceState): void {
		if (this.#voice === voice) return;
		this.#voice = voice;
		this.#emitState();
	}

	#setWorker(worker: LiveWorkerState): void {
		if (this.#worker === worker) return;
		this.#worker = worker;
		this.#emitState();
	}

	#emitState(): void {
		try {
			this.#callbacks.onState(this.state);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitStateSafely(): void {
		try {
			this.#callbacks.onState(this.state);
		} catch {
			// Terminal callback is the final error boundary for UI failures.
		}
	}

	#emitLevels(): void {
		try {
			this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitTranscript(transcript: LiveTranscript | undefined): void {
		this.#lastTranscript = transcript;
		try {
			this.#callbacks.onTranscript(transcript);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#reportFailure(error: Error): void {
		if (this.#terminalEmitted || this.#failure) return;
		this.#failure = error;
		this.#connection = "error";
		this.#emitStateSafely();
		void this.stop();
	}

	#emitTerminal(error?: Error): void {
		if (this.#terminalEmitted) return;
		this.#terminalEmitted = true;
		try {
			this.#callbacks.onTerminal(error);
		} catch {
			// Nothing remains above the terminal callback to receive its error.
		}
	}
}
