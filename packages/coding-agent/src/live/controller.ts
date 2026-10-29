import * as os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { LivePhase } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { logger, prompt, toError } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE, type LiveDelegationDetails, USER_INTERRUPT_LABEL } from "../session/messages";
import {
	LIVE_TRANSCRIPT_ENTRY_TYPE,
	LIVE_VOICE_CONTEXT_MESSAGE_TYPE,
	LIVE_VOICE_END_INSTRUCTIONS,
	spokenSinceLastRequest,
} from "./delegation";
import { OUTPUT_ACTIVE_LEVEL, OutputActivity } from "./output-activity";
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };
import {
	buildDelegationContextAppend,
	buildSessionContextAppend,
	chunkLiveContext,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol";
import {
	formatTranscriptDelta,
	LiveActiveTranscript,
	type LiveTranscriptFrame,
	type LiveTranscriptRole,
} from "./transcript";
import { CodexLiveTransport, LiveStartupInterruptedError } from "./transport";
import { cfgLiveAnswerLength } from "./settings";
import { DEFAULT_LIVE_VOICE } from "./voices";

/** Codex keeps the speaker counted as active this long after its last audible level. */
const SPEAKER_ACTIVITY_HOLD_MS = 500;

/** Incremental or final transcript for one realtime conversational turn. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	/** Monotonic role-local turn number used to coalesce streaming updates. */
	turn: number;
	final: boolean;
}

/** UI notifications emitted during a live session. */
export interface LiveSessionCallbacks {
	/** Reports connection and activity phase changes. */
	onPhase(phase: LivePhase): void;
	/** Reports clamped microphone and speaker RMS levels. */
	onLevels(input: number, output: number): void;
	/** Reports the latest available conversational transcript. */
	onTranscript(transcript: LiveTranscript | undefined): void;
	/** Reports one terminal stop, optionally carrying its cause. */
	onTerminal(error?: Error): void;
	/** Reports a recoverable connection notice, such as a startup retry. */
	onNotice?(message: string): void;
}

/** Dependencies and presentation callbacks for a live session. */
export interface LiveSessionControllerOptions {
	/** Agent session that performs all delegated work. */
	session: AgentSession;
	/** UI callbacks for live session state. */
	callbacks: LiveSessionCallbacks;
	/** Extracts visible assistant text using the caller's normal UI rules. */
	extractAssistantText(message: AssistantMessage): string;
	/** Realtime output voice, defaulting to sol. */
	voice?: string;
	/**
	 * Handlebars template replacing the bundled live instructions; rendered with
	 * `{ username, firstName, user_first_name, answerLength }` like the bundled prompt.
	 */
	instructions?: string;
	/**
	 * SDP offer from a caller-owned WebRTC peer that carries the microphone and speaker audio
	 * (see `LiveTransportOptions.sdpOffer`). When set, no host microphone or speaker is opened;
	 * the caller applies {@link LiveSessionController.sdpAnswer} to its peer after `start()`
	 * and handles echo cancellation itself. There is no host track to mute: `toggleMute` only
	 * moves the phase to `muted`, and the caller must silence its own microphone track while the
	 * phase is `muted`. Levels are not reported in this mode.
	 */
	sdpOffer?: string;
}

function currentUser(): { username: string; firstName: string; user_first_name: string } {
	let username = "user";
	try {
		const candidate = os.userInfo().username.trim();
		if (candidate) username = candidate;
	} catch {
		// Sandboxed runtimes may not expose OS account information.
	}
	const firstName = username.split(/[._\-\s]+/).find(part => part.length > 0) ?? "there";
	return { username, firstName, user_first_name: firstName };
}

/** Identity of one spoken input, used to recognize a late transcript of input that typing superseded. */
function inputFingerprint(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

interface PendingLiveAnswer {
	text: string;
	timestamp: number;
	generation: number;
	needsRetry: boolean;
}

interface LiveDelegationMessage {
	customType: typeof LIVE_DELEGATION_MESSAGE_TYPE;
	content: string;
	display: true;
	details: LiveDelegationDetails;
	attribution: "agent";
}

/** Coordinates the realtime conversational surface with normal AgentSession turns. */
export class LiveSessionController {
	readonly #session: AgentSession;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	readonly #voice: string;
	readonly #instructionsTemplate: string;
	readonly #sdpOffer: string | undefined;

	#transport: CodexLiveTransport | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#stopPromise: Promise<void> | undefined;
	#started = false;
	#starting = false;
	#startupFailure: Error | undefined;
	#stopped = false;
	#terminalEmitted = false;
	#failure: Error | undefined;
	#muted = false;
	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	/** Last pair passed to `onLevels`; repeated identical levels are not re-emitted. */
	#emittedInputLevel = -1;
	#emittedOutputLevel = -1;
	readonly #outputActivity = new OutputActivity(
		() => this.#guardEvent(() => this.#refreshAudioPhase()),
		SPEAKER_ACTIVITY_HOLD_MS,
	);
	#activeDelegationId: string | undefined;
	#userTranscript = "";
	#assistantTranscript = "";
	#userTranscriptFinal = false;
	#assistantTranscriptFinal = false;
	#userTranscriptTurn = 0;
	#assistantTranscriptTurn = 0;
	#lastTranscript: LiveTranscript | undefined;
	/** Conversation since the previous delegation, handed to the main agent with the next one. */
	readonly #activeTranscript = new LiveActiveTranscript();
	// Codex's input-generation bookkeeping (`tui/src/chatwidget/realtime.rs`): which input the
	// speaker's audio answers, and whether the current run's answer may still be spoken.
	#inputGeneration = 0;
	#transcriptInputGeneration: number | undefined;
	#assistantTranscriptGeneration: number | undefined;
	#speakerSuppressionGeneration: number | undefined;
	#latestInputWasVoice = false;
	#latestVoiceInputFingerprint: string | undefined;
	#delegatedRun: { maySpeak: boolean } | undefined;
	/** Serializes abort-and-send so a newer utterance cannot race an older one's interruption. */
	#delegationDispatch: Promise<void> = Promise.resolve();
	/** User turn consumed by a real or fallback delegation. */
	#lastDelegatedUserTurn: number | undefined;
	/** Fallback turn whose late server delegation must be ignored as a duplicate. */
	#fallbackDelegatedUserTurn: number | undefined;
	/** Timestamp of the last answer initially queued, so agent completion does not repeat it. */
	#spokenAnswerTimestamp: number | undefined;
	/** Answers queued to the voice but not yet followed by an assistant output transcript. */
	#pendingAnswers: PendingLiveAnswer[] = [];
	#assistantCaptionAfterSpeechQueue = false;
	/** The main agent has not yet been told this voice session started. */
	#needsVoiceStart = true;
	/** The main agent believes voice mode is active, so it must be told when it ends. */
	#voiceContextActive = false;

	constructor(options: LiveSessionControllerOptions) {
		this.#session = options.session;
		this.#callbacks = options.callbacks;
		this.#extractAssistantText = options.extractAssistantText;
		this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
		this.#instructionsTemplate = options.instructions ?? liveInstructionsTemplate;
		this.#sdpOffer = options.sdpOffer;
	}

	/** Current realtime call phase. */
	get phase(): LivePhase {
		return this.#phase;
	}

	/** Whether microphone input is currently muted. */
	get muted(): boolean {
		return this.#muted;
	}

	/**
	 * SDP answer for the caller's peer in an `sdpOffer` session. It exists as soon as the offer is
	 * signaled, before the control socket connects, so apply it only after `start()` resolves.
	 */
	get sdpAnswer(): string | undefined {
		return this.#transport?.sdpAnswer;
	}

	/** Connects the realtime surface; the native peer records and plays audio, or with `sdpOffer` only signals. */
	async start(): Promise<void> {
		if (this.#stopped) {
			throw (
				this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.")
			);
		}
		if (this.#started) return;
		this.#started = true;
		this.#emitPhase("connecting", true);
		this.#emitTranscript(undefined);

		try {
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped during startup.");
			}
			// A pending end notice means the main agent still believes voice is active. Decided before
			// connecting, so a failed start re-queues the notice and early delegations keep the flag.
			const resumed = this.#session.dropPendingNextTurnMessages(LIVE_VOICE_CONTEXT_MESSAGE_TYPE) > 0;
			this.#voiceContextActive = resumed;
			this.#needsVoiceStart = !resumed;
			const instructions = prompt.render(this.#instructionsTemplate, {
				...currentUser(),
				answerLength: cfgLiveAnswerLength.get(this.#session.settings),
			});
			await this.#connect(instructions);
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while connecting.");
			}
			this.#unsubscribeSession = this.#session.subscribe(event =>
				this.#guardEvent(() => this.#handleSessionEvent(event)),
			);

			this.#refreshAudioPhase();
		} catch (cause) {
			const error = toError(cause);
			this.#reportFailure(error);
			await this.stop();
			throw error;
		}
	}

	/** Toggles microphone capture while leaving output and the session connected. */
	toggleMute(): void {
		if (this.#stopped) return;
		this.#muted = !this.#muted;
		// Remote audio reports no levels, so a mute must not emit a `(0, 0)` pair either.
		if (this.#muted && this.#sdpOffer === undefined) {
			this.#inputLevel = 0;
			this.#emitLevels();
		}
		this.#refreshAudioPhase();
		const transport = this.#transport;
		if (transport) {
			void transport.setMuted(this.#muted).catch(cause => this.#reportFailure(toError(cause)));
		}
	}

	/** Stops recording, closes the live session, and emits one terminal callback. */
	stop(): Promise<void> {
		if (!this.#stopPromise) this.#stopPromise = this.#stop();
		return this.#stopPromise;
	}

	async #stop(): Promise<void> {
		this.#stopped = true;
		this.#outputActivity.dispose();
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		let cleanupError: Error | undefined;

		const transport = this.#transport;
		this.#transport = undefined;
		if (transport) {
			try {
				await transport.close();
			} catch (cause) {
				cleanupError = toError(cause);
			}
		}
		this.#queueVoiceEnd();

		if (cleanupError) this.#emitPhaseSafely("error");
		this.#emitTerminal(cleanupError);
	}

	/** Connects, retrying once after cleanup when startup times out or the connection closes, as Codex does. */
	async #connect(instructions: string): Promise<void> {
		this.#starting = true;
		try {
			try {
				await this.#openTransport(instructions);
			} catch (cause) {
				if (!(cause instanceof LiveStartupInterruptedError) || this.#stopped) throw cause;
				await this.#closeTransport();
				if (this.#stopped) throw cause;
				this.#notify(
					cause.timedOut
						? "Voice connection timed out. Retrying once after cleanup."
						: "Voice connection closed during startup. Retrying once.",
				);
				await this.#openTransport(instructions);
			}
		} finally {
			this.#starting = false;
		}
	}

	async #openTransport(instructions: string): Promise<void> {
		this.#startupFailure = undefined;
		if (this.#stopped) {
			throw this.#failure ?? new Error("The live session stopped before opening a transport.");
		}
		const transport = new CodexLiveTransport({
			authStorage: this.#session.modelRegistry.authStorage,
			sessionId: this.#session.sessionId,
			instructions,
			voice: this.#voice,
			sdpOffer: this.#sdpOffer,
			callbacks: {
				onEvent: event => this.#guardEvent(() => this.#handleLiveEvent(event)),
				onLevels: (input, output) => this.#guardEvent(() => this.#handleLevels(input, output)),
				onEnded: () => this.#guardEvent(() => void this.stop()),
			},
		});
		this.#transport = transport;
		try {
			await transport.setMuted(this.#muted);
			await transport.connect();
			if (this.#startupFailure) throw this.#startupFailure;
		} finally {
			if (this.#stopped) await this.#closeTransport();
		}
		if (this.#stopped) {
			throw this.#failure ?? new Error("The live session stopped while connecting.");
		}
	}

	async #closeTransport(): Promise<void> {
		const transport = this.#transport;
		this.#transport = undefined;
		if (!transport) return;
		try {
			await transport.close();
		} catch (cause) {
			logger.debug("Live transport cleanup before retry failed", { error: toError(cause).message });
		}
	}

	/** Tells the main agent that voice mode ended, if it was told voice mode started. */
	#queueVoiceEnd(): void {
		if (!this.#voiceContextActive) return;
		this.#voiceContextActive = false;
		void this.#session
			.sendCustomMessage(
				{
					customType: LIVE_VOICE_CONTEXT_MESSAGE_TYPE,
					content: LIVE_VOICE_END_INSTRUCTIONS,
					display: false,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn" },
			)
			.catch(cause => {
				logger.warn("Failed to queue the live voice end notice", { error: toError(cause).message });
			});
	}

	#guardEvent(handler: () => void): void {
		if (this.#stopped) return;
		try {
			handler();
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#handleLiveEvent(event: LiveServerEvent): void {
		switch (event.type) {
			case "session.started":
				// Mute wins over server-driven phases: a remote peer treats any other phase as unmuted.
				this.#refreshAudioPhase();
				break;
			case "session.updated":
			case "output_audio.delta":
				break;
			case "unknown":
				logger.debug("Live event ignored", { wireType: event.wireType });
				break;
			case "input_transcript.added":
				this.#handleTranscriptDelta("user", event.item.text, event.frame);
				break;
			case "output_transcript.added":
				this.#handleTranscriptDelta("assistant", event.item.text, event.frame);
				break;
			case "turn.done":
				this.#handleTranscriptDone(event.turn.role, event.turn.transcript);
				break;
			case "delegation.created":
				this.#handleDelegation(event);
				break;
			case "error":
				if (this.#starting) {
					// Startup surfaces its own failure; the retry decision belongs to `#connect`.
					this.#startupFailure ??= new Error(event.message);
					break;
				}
				this.#reportFailure(new Error(event.message));
				break;
		}
	}

	#handleTranscriptDelta(role: LiveTranscriptRole, text: string, frame: LiveTranscriptFrame | undefined): void {
		this.#activeTranscript.delta(role, text, frame);
		if (role === "user" && this.#transcriptInputGeneration === undefined) {
			// A new utterance is new voice input: it supersedes speech answering older input.
			this.#inputGeneration += 1;
			this.#transcriptInputGeneration = this.#inputGeneration;
			this.#fallbackDelegatedUserTurn = undefined;
			this.#markAnswersForRetry();
			this.#suppressActiveSpeaker();
		}
		if (role === "assistant" && text.trim() && this.#assistantTranscriptGeneration === undefined) {
			this.#assistantTranscriptGeneration = this.#inputGeneration;
			this.#assistantCaptionAfterSpeechQueue = this.#pendingAnswers.some(
				answer => !answer.needsRetry && answer.generation === this.#inputGeneration,
			);
		}
		this.#resumeSpeakerFor(role, text);
		if (role === "user" && this.#transcriptInputGeneration === this.#inputGeneration) {
			this.#latestInputWasVoice = true;
		}
		this.#addTranscript(role, text);
	}

	#handleTranscriptDone(role: LiveTranscriptRole, text: string): void {
		this.#activeTranscript.done(role, text);
		const hasText = text.trim().length > 0;
		if (hasText) this.#resumeSpeakerFor(role, text);
		if (role === "assistant") {
			if (hasText && this.#assistantCaptionAfterSpeechQueue && this.#assistantTranscriptGeneration !== undefined) {
				const captionGeneration = this.#assistantTranscriptGeneration;
				this.#pendingAnswers = this.#pendingAnswers.filter(
					answer => answer.needsRetry || answer.generation !== captionGeneration,
				);
			}
			this.#assistantTranscriptGeneration = undefined;
			this.#assistantCaptionAfterSpeechQueue = false;
		}
		if (role === "user") {
			if (!hasText) logger.debug("Live user turn ended without a transcript");
			this.#noteVoiceInputDone(text, hasText);
		}
		this.#finishTranscript(role, text);
		if (hasText) this.#recordTranscript(role, text);
		if (role === "user" && hasText && this.#lastDelegatedUserTurn !== this.#userTranscriptTurn) {
			this.#fallbackDelegatedUserTurn = this.#userTranscriptTurn;
			this.#delegate(text.trim(), undefined);
		}
	}

	#noteVoiceInputDone(text: string, hasText: boolean): void {
		const generation = this.#transcriptInputGeneration;
		this.#transcriptInputGeneration = undefined;
		const fingerprint = inputFingerprint(text);
		if (generation !== undefined) {
			if (generation === this.#inputGeneration) {
				this.#latestInputWasVoice = hasText;
				if (!hasText) this.#releaseSpeaker();
			}
		} else {
			const superseded = !this.#latestInputWasVoice && this.#latestVoiceInputFingerprint === fingerprint;
			if (superseded || !hasText) return;
			this.#inputGeneration += 1;
			this.#latestInputWasVoice = true;
			this.#markAnswersForRetry();
			this.#suppressActiveSpeaker();
		}
		if (hasText) this.#latestVoiceInputFingerprint = fingerprint;
	}

	/** Keeps a session record of what was said; the model never sees these entries. */
	#recordTranscript(role: LiveTranscriptRole, text: string): void {
		try {
			this.#session.sessionManager.appendCustomEntry(LIVE_TRANSCRIPT_ENTRY_TYPE, { role, text });
		} catch (cause) {
			logger.warn("Failed to record a live transcript entry", { error: toError(cause).message });
		}
	}

	#handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
		if (this.#fallbackDelegatedUserTurn === this.#userTranscriptTurn) {
			this.#fallbackDelegatedUserTurn = undefined;
			logger.debug("Ignored a late live delegation already delivered from its transcript", { id: event.item.id });
			return;
		}
		this.#fallbackDelegatedUserTurn = undefined;
		const request = event.item.content
			.map(content => content.text)
			.join("")
			.trim();
		this.#delegate(request, event.item.id);
	}

	#delegate(request: string, delegationId: string | undefined): void {
		const transcript = this.#activeTranscript.takeForDelegation(request);
		const transcriptDelta = formatTranscriptDelta(transcript);
		const input = request || transcriptDelta;
		if (!input) return;
		this.#lastDelegatedUserTurn = this.#userTranscriptTurn;

		const staleVoiceInput =
			!this.#latestInputWasVoice &&
			this.#latestVoiceInputFingerprint !== undefined &&
			this.#latestVoiceInputFingerprint === inputFingerprint(input);
		const maySpeak = !staleVoiceInput;
		if (maySpeak) {
			if (!this.#latestInputWasVoice || this.#delegatedRun?.maySpeak) {
				this.#inputGeneration += 1;
				if (this.#speakerSuppressionGeneration !== undefined) {
					this.#speakerSuppressionGeneration = this.#inputGeneration;
				}
			}
			this.#latestInputWasVoice = true;
		}

		const details: LiveDelegationDetails = transcriptDelta ? { transcriptDelta } : {};
		// Without request text the transcript itself is the request, so there is no excerpt to explain.
		const spoken = request ? spokenSinceLastRequest(transcript, request) : [];
		if (spoken.length > 0) details.spoken = spoken;
		if (this.#needsVoiceStart) {
			details.voiceStart = true;
			this.#needsVoiceStart = false;
			this.#voiceContextActive = true;
		}
		logger.debug("Live delegation received", {
			id: delegationId,
			previousId: this.#activeDelegationId,
			requestLength: request.length,
			transcriptEntries: transcript.length,
		});
		const message: LiveDelegationMessage = {
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: input,
			display: true,
			details,
			attribution: "agent",
		};
		this.#delegationDispatch = this.#delegationDispatch.then(() =>
			this.#dispatchDelegation(message, delegationId, maySpeak),
		);
		void this.#delegationDispatch.catch(cause => this.#reportFailure(toError(cause)));
	}

	async #dispatchDelegation(
		message: LiveDelegationMessage,
		delegationId: string | undefined,
		maySpeak: boolean,
	): Promise<void> {
		if (this.#stopped) return;
		this.#markAnswersForRetry();
		if (this.#session.isStreaming) await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
		if (this.#stopped) return;
		this.#activateDelegatedRun(delegationId, maySpeak);
		// sendCustomMessage settles after the agent turn, not after admission. Do not hold the
		// delegation queue for that lifetime: the next utterance must be able to abort this turn.
		void this.#session
			.sendCustomMessage(message, { triggerTurn: true })
			.catch(cause => this.#reportFailure(toError(cause)));
		this.#retryAnswers();
		this.#refreshAudioPhase();
	}

	#activateDelegatedRun(delegationId: string | undefined, maySpeak: boolean): void {
		this.#delegatedRun = { maySpeak };
		this.#activeDelegationId = delegationId;
		this.#refreshAudioPhase();
	}

	#markAnswersForRetry(): void {
		this.#assistantCaptionAfterSpeechQueue = false;
		for (const answer of this.#pendingAnswers) answer.needsRetry = true;
	}

	#retryAnswers(): void {
		for (const answer of this.#pendingAnswers) {
			if (!answer.needsRetry) continue;
			answer.needsRetry = false;
			answer.generation = this.#inputGeneration;
			this.#sendAnswerChunks(answer.text);
		}
	}

	#sendAnswerChunks(text: string): void {
		for (const chunk of chunkLiveContext(text)) {
			this.#queueSend(buildSessionContextAppend(chunk, "speakable"));
		}
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (
			event.type === "message_start" &&
			event.message.role === "user" &&
			!event.message.synthetic &&
			event.message.attribution !== "agent"
		) {
			this.#invalidateVoiceInput();
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "toolUse") {
				this.#appendProgress(event.message);
			} else if (event.message.stopReason === "stop" && this.#delegatedRun?.maySpeak) {
				const text = this.#extractAssistantText(event.message).trim();
				if (text) this.#queueAnswer({ text, timestamp: event.message.timestamp });
			}
			return;
		}
		if (event.type !== "agent_end") return;
		// A background job the agent started may resume it later; its answer is still due now.
		const awaitingAsyncWork = event.awaitingAsyncWork === true;
		if (event.isTerminal === false && !awaitingAsyncWork) return;
		this.#appendFinalResponse(event.messages, awaitingAsyncWork);
	}

	/** Typed input supersedes voice input: silence the old answer and keep this run's answer unspoken. */
	#invalidateVoiceInput(): void {
		this.#latestInputWasVoice = false;
		this.#inputGeneration += 1;
		this.#speakerSuppressionGeneration = this.#inputGeneration;
		this.#setSpeakerSuppressed(true);
		this.#outputLevel = 0;
		this.#outputActivity.dispose();
		this.#emitLevels();
		if (this.#delegatedRun) this.#delegatedRun.maySpeak = false;
		this.#pendingAnswers = [];
		this.#assistantCaptionAfterSpeechQueue = false;
	}

	#appendProgress(message: AssistantMessage): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		const progress = this.#extractAssistantText(message).trim();
		if (!progress) return;
		for (const chunk of chunkLiveContext(progress)) {
			this.#queueSend(buildDelegationContextAppend(delegationId, chunk, "commentary"));
		}
	}

	#appendFinalResponse(messages: readonly AgentMessage[], awaitingAsyncWork: boolean): void {
		const run = this.#delegatedRun;
		// The run stays open so the answer written after background results is spoken too.
		if (!awaitingAsyncWork) this.#delegatedRun = undefined;
		this.#activeDelegationId = undefined;
		if (run?.maySpeak) {
			const answer = this.#lastAnswer(messages);
			if (answer) this.#queueAnswer(answer);
		}
		this.#refreshAudioPhase();
	}

	#queueAnswer(answer: { text: string; timestamp: number }): void {
		if (answer.timestamp === this.#spokenAnswerTimestamp) return;
		this.#spokenAnswerTimestamp = answer.timestamp;
		this.#pendingAnswers.push({ ...answer, generation: this.#inputGeneration, needsRetry: false });
		this.#sendAnswerChunks(answer.text);
	}

	#lastAnswer(messages: readonly AgentMessage[]): { text: string; timestamp: number } | undefined {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant" || message.stopReason !== "stop") continue;
			const text = this.#extractAssistantText(message).trim();
			if (text) return { text, timestamp: message.timestamp };
		}
		return undefined;
	}

	/** Levels arrive clamped to [0, 1] by the transport. */
	#handleLevels(input: number, output: number): void {
		this.#inputLevel = this.#muted ? 0 : input;
		this.#outputLevel = output;
		this.#outputActivity.observe(this.#outputLevel);
		this.#emitLevels();
		if (!this.#delegatedRun) this.#refreshAudioPhase();
	}

	#speakerActive(): boolean {
		return this.#outputLevel > OUTPUT_ACTIVE_LEVEL || this.#outputActivity.active;
	}

	/** Interrupts only output that may answer older input. */
	#suppressActiveSpeaker(): void {
		if (
			this.#assistantTranscriptGeneration !== undefined ||
			this.#speakerActive() ||
			this.#speakerSuppressionGeneration !== undefined
		) {
			this.#suppressSpeaker();
		}
	}

	#suppressSpeaker(): void {
		this.#speakerSuppressionGeneration = this.#inputGeneration;
		this.#setSpeakerSuppressed(true);
		this.#outputLevel = 0;
		this.#outputActivity.dispose();
		this.#emitLevels();
	}

	#releaseSpeaker(): void {
		this.#speakerSuppressionGeneration = undefined;
		this.#setSpeakerSuppressed(false);
	}

	/** Resumes playback once the voice answers the latest voice input. */
	#resumeSpeakerFor(role: LiveTranscriptRole, text: string): void {
		if (
			role === "assistant" &&
			text.trim() &&
			this.#assistantTranscriptGeneration === this.#inputGeneration &&
			this.#latestInputWasVoice &&
			this.#speakerSuppressionGeneration === this.#inputGeneration
		) {
			this.#releaseSpeaker();
		}
	}

	#setSpeakerSuppressed(suppressed: boolean): void {
		try {
			this.#transport?.setSpeakerSuppressed(suppressed);
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#addTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		let next: string;
		if (!current) {
			this.#startTranscriptTurn(role);
			next = text;
		} else if (wasFinal) {
			if (text === current || current.endsWith(text)) return;
			this.#startTranscriptTurn(role);
			next = text;
		} else if (text.startsWith(current)) {
			next = text;
		} else if (current.endsWith(text)) {
			next = current;
		} else {
			next = current + text;
		}
		this.#storeTranscript(role, next, false);
	}

	#finishTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		if (!current) {
			this.#startTranscriptTurn(role);
		} else if (wasFinal) {
			if (text === current) return;
			this.#startTranscriptTurn(role);
		}
		const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
		this.#storeTranscript(role, next, true);
	}

	#startTranscriptTurn(role: LiveTranscript["role"]): void {
		if (role === "user") {
			this.#userTranscriptTurn += 1;
		} else {
			this.#assistantTranscriptTurn += 1;
		}
	}

	#storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		const normalized = text.trim();
		if (!normalized) return;
		const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
		if (role === "user") {
			this.#userTranscript = normalized;
			this.#userTranscriptFinal = final;
		} else {
			this.#assistantTranscript = normalized;
			this.#assistantTranscriptFinal = final;
		}
		if (
			this.#lastTranscript?.role === role &&
			this.#lastTranscript.turn === turn &&
			this.#lastTranscript.text === normalized &&
			this.#lastTranscript.final === final
		) {
			return;
		}
		this.#emitTranscript({ role, turn, text: normalized, final });
	}

	/** Hands the message to the transport now, so it keeps send order and precedes a later close. */
	#queueSend(message: LiveClientMessage): void {
		const transport = this.#transport;
		if (!transport || this.#stopped) return;
		transport.send(message).catch(cause => {
			// Stopping rejects messages still waiting for the sideband to rejoin; that is not a failure.
			if (!this.#stopped) this.#reportFailure(toError(cause));
		});
	}

	#refreshAudioPhase(): void {
		if (this.#stopped) return;
		if (this.#muted) {
			this.#emitPhase("muted");
		} else if (this.#delegatedRun) {
			this.#emitPhase("working");
		} else if (this.#speakerActive()) {
			this.#emitPhase("speaking");
		} else {
			this.#emitPhase("listening");
		}
	}

	#emitPhase(phase: LivePhase, force = false): void {
		if (!force && this.#phase === phase) return;
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#emitPhaseSafely(phase: LivePhase): void {
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch {
			// Terminal callback is the final error boundary for UI failures.
		}
	}

	#emitLevels(): void {
		if (this.#inputLevel === this.#emittedInputLevel && this.#outputLevel === this.#emittedOutputLevel) return;
		const input = this.#inputLevel;
		const output = this.#outputLevel;
		try {
			this.#callbacks.onLevels(input, output);
			this.#emittedInputLevel = input;
			this.#emittedOutputLevel = output;
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#emitTranscript(transcript: LiveTranscript | undefined): void {
		this.#lastTranscript = transcript;
		try {
			this.#callbacks.onTranscript(transcript);
		} catch (cause) {
			this.#reportFailure(toError(cause));
		}
	}

	#notify(message: string): void {
		try {
			this.#callbacks.onNotice?.(message);
		} catch (cause) {
			logger.debug("Live notice callback failed", { error: toError(cause).message });
		}
	}

	#reportFailure(error: Error): void {
		if (this.#terminalEmitted) return;
		this.#failure = error;
		this.#emitPhaseSafely("error");
		this.#emitTerminal(error);
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
