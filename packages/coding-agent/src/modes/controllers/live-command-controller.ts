import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { resolveModelOverride } from "../../config/model-resolver";
import type { LiveConfig } from "../../live/config";
import { resolveLiveConfig } from "../../live/config";
import {
	LiveSessionController,
	type LiveSessionControllerOptions,
	type LiveSessionHost,
	type LiveTranscript,
	type LiveTurnSession,
} from "../../live/controller";
import { acquireLiveSessionLease } from "../../live/lease";
import liveCodingInstructions from "../../live/prompts/live-coding-instructions.md" with { type: "text" };
import { LIVE_MODEL } from "../../live/protocol";
import { LiveVisualizer } from "../../live/visualizer";
import type { AgentSession } from "../../session/agent-session";
import { resolveThinkingLevelForModel, toReasoningEffort } from "../../thinking";
import { vocalizer } from "../../tts/vocalizer";
import type { AssistantMessageComponent } from "../components/assistant-message";
import type { CustomEditor } from "../components/custom-editor";
import { createLiveWorkerArtifact, liveVoiceMessage } from "../components/live-worker-artifact";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";

const ANIMATION_INTERVAL_MS = 80;
type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionController;

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Owns the editor-replacing visualizer and realtime session lifecycle for `/live`. */
export class LiveCommandController {
	readonly #ctx: InteractiveModeContext;
	readonly #createSession: LiveSessionFactory | undefined;

	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#visualizer: LiveVisualizer | undefined;
	#detachedEditor: CustomEditor | undefined;
	#animationInterval: NodeJS.Timeout | undefined;
	#previousShowHardwareCursor: boolean | undefined;
	#previousUseTerminalCursor: boolean | undefined;
	#resumeVocalizer: (() => void) | undefined;
	#assistantTranscriptComponent: AssistantMessageComponent | undefined;
	#assistantTranscriptTurn = 0;
	#assistantTranscriptStartedAt = 0;
	#releaseLease: (() => void) | undefined;
	#liveModel: string = LIVE_MODEL;
	/**
	 * Whether the current call ever reached the active state.
	 *
	 * Separates a failed start (hold the surface so retry is reachable) from a
	 * mid-call drop (return to the editor). Reset by `#start`.
	 */
	#everActive = false;

	constructor(ctx: InteractiveModeContext, createSession?: LiveSessionFactory) {
		this.#ctx = ctx;
		this.#createSession = createSession;
	}

	/**
	 * Whether the live surface owns the editor area.
	 *
	 * Includes a held failed-start panel: it has no session, but the editor is
	 * still detached, so anything that would take the editor (STT, a new turn)
	 * must not start behind it.
	 */
	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined || this.#visualizer !== undefined;
	}

	/** Start live mode, or stop the currently active session. */
	async handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		if (this.#settling) await this.#settling;
		await this.#start();
	}

	/** Stop the active live session and restore the editor. */
	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			// A held failed-start surface has no session left; Escape must still
			// dismiss it, or the user is stranded on an error panel.
			if (this.#visualizer) this.#restoreEditor();
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, errorFrom(cause));
		} finally {
			this.#finish(session);
		}
	}

	/** Release UI resources during synchronous InteractiveMode teardown. */
	dispose(): void {
		const session = this.#session;
		if (session) {
			this.#finish(session);
			void session.stop().catch(cause => {
				logger.debug("Live session teardown failed", { error: errorFrom(cause).message });
			});
		} else {
			this.#restoreEditor();
		}
	}

	async #start(): Promise<void> {
		const releaseLease = acquireLiveSessionLease();
		this.#releaseLease = releaseLease;
		try {
			const config = resolveLiveConfig(this.#ctx.settings);
			this.#everActive = false;
			this.#liveModel = config.model;
			this.#assistantTranscriptTurn = 0;
			this.#assistantTranscriptStartedAt = 0;
			const visualizer = new LiveVisualizer({
				onStop: () => {
					void this.stop().catch(cause => this.#ctx.showError(errorFrom(cause).message));
				},
				onToggleMute: () => this.#session?.toggleMute(),
				onToggleOutputMute: () => this.#session?.toggleOutputMute(),
				onRefreshMicrophone: () => {
					void this.#session?.refreshMicrophone().catch(cause => this.#ctx.showError(errorFrom(cause).message));
				},
				onRetry: () => {
					void this.#retry().catch(cause => this.#ctx.showError(errorFrom(cause).message));
				},
				stopKeys: this.#ctx.keybindings.getKeys("app.live.toggle"),
			});
			this.#mountVisualizer(visualizer);

			let session: LiveSessionController;
			const options: LiveSessionControllerOptions = {
				host: this.#buildLiveHost(config, this.#ctx.session),
				config,
				callbacks: {
					onState: state => {
						if (this.#visualizer !== visualizer) return;
						// Latched: once a call has been active, a later failure is a drop
						// rather than a failed start, and drops return to the editor.
						if (state.connection === "active") this.#everActive = true;
						visualizer.setState(state);
						this.#ctx.ui.requestComponentRender(visualizer);
					},
					onLevels: input => {
						if (this.#visualizer !== visualizer) return;
						visualizer.setInputLevel(input);
						this.#ctx.ui.requestComponentRender(visualizer);
					},
					onTranscript: transcript => {
						if (this.#visualizer !== visualizer) return;
						if (!transcript) {
							visualizer.clearTranscript();
							this.#ctx.ui.requestComponentRender(visualizer);
						} else if (transcript.role === "user") {
							visualizer.setTranscript(transcript.text);
							this.#ctx.ui.requestComponentRender(visualizer);
						} else {
							this.#presentAssistantTranscript(transcript);
						}
					},
					onScreen: text => this.#presentWorkerArtifact(session, text),
					onTerminal: error => this.#finish(session, error),
				},
			};
			session = this.#createSession?.(options) ?? new LiveSessionController(options);
			this.#session = session;
			// Scoped to the handoff's active delegation, not to the call: an
			// unrelated terminal or extension turn during this call still renders
			// normally. While a delegation IS owned, the event controller suppresses
			// its assistant and tool rendering and this controller owns the turn's
			// single visible artifact.
			this.#ctx.turnPresentationOwned = () => this.#session === session && session.delegatedTurnActive;

			try {
				await session.start();
			} catch (cause) {
				if (this.#session === session) {
					await session.stop().catch(cleanupCause => {
						logger.debug("Live session startup cleanup failed", { error: errorFrom(cleanupCause).message });
					});
					this.#finish(session, errorFrom(cause));
				}
			}
		} catch (cause) {
			if (this.#releaseLease === releaseLease) {
				releaseLease();
				this.#releaseLease = undefined;
			}
			this.#restoreEditor();
			throw cause;
		}
	}

	#presentAssistantTranscript(transcript: LiveTranscript): void {
		if (
			transcript.turn < this.#assistantTranscriptTurn ||
			(transcript.turn === this.#assistantTranscriptTurn && !this.#assistantTranscriptComponent)
		) {
			return;
		}
		if (transcript.turn > this.#assistantTranscriptTurn) {
			this.#finalizeAssistantTranscript();
			this.#assistantTranscriptTurn = transcript.turn;
		}

		let component = this.#assistantTranscriptComponent;
		if (!component) {
			component = createAssistantMessageComponent(this.#ctx);
			component.setTextColorTransform(text => theme.fg("borderAccent", text));
			this.#assistantTranscriptComponent = component;
			this.#assistantTranscriptStartedAt = Date.now();
		}
		component.updateContent(liveVoiceMessage(transcript.text, this.#liveModel, this.#assistantTranscriptStartedAt), {
			transient: !transcript.final,
		});
		if (transcript.final) {
			component.markTranscriptBlockFinalized();
			this.#assistantTranscriptComponent = undefined;
			this.#assistantTranscriptStartedAt = 0;
		}
		if (!this.#ctx.chatContainer.children.includes(component)) {
			this.#ctx.present(component);
		} else {
			this.#ctx.ui.requestComponentRender(component);
		}
	}

	/**
	 * Build the live host port from this interactive session.
	 *
	 * The only place `AgentSession` is turned into the narrow set of capabilities
	 * a call needs. Model resolution lives here because it needs the registry and
	 * settings, which the controller no longer sees; the resolved overrides are
	 * what both the delegated turn and the rendered artifact are credited to.
	 */
	#buildLiveHost(config: LiveConfig, turnSession: LiveTurnSession): LiveSessionHost {
		const session = this.#ctx.session;
		return {
			// The port the caller already acquired, so the controller cannot end up
			// sending through a different session than the caller checked.
			turnSession,
			authStorage: session.modelRegistry.authStorage,
			sessionId: session.sessionId,
			contextMessages: () => session.buildDisplaySessionContext().messages,
			activeToolNames: () => session.getActiveToolNames(),
			resolveCodingOverrides: () => {
				// An empty `live.codingModel` means "whatever the session is already
				// on". Forcing a model here silently swapped the user's chat model
				// mid-call, and made /live fail outright when the pinned provider had
				// no credentials even though the session had a working model. The
				// voice contract below is what constrains the turn, not the model id.
				const model = config.codingModel
					? resolveConfiguredCodingModel(config.codingModel, session)
					: session.model;
				if (!model) {
					// MUST NOT degrade to undefined: a delegated turn with no contract is
					// the unrestrained, terminal-shaped agent this whole path prevents.
					throw new Error("live coding turns need a model: the session has none and live.codingModel is unset");
				}
				// Effort inherits the session's current level unless the user pinned
				// one for voice. Forcing a level here overrode a deliberate choice —
				// someone who sets high already knows it costs latency.
				const effort = config.codingThinkingLevel ?? session.thinkingLevel;
				return {
					systemPromptAppend: [prompt.render(liveCodingInstructions, {})],
					model,
					thinkingLevel: toReasoningEffort(resolveThinkingLevelForModel(model, effort)),
				};
			},
			appendLogOnly: message => session.appendLogOnlyCustomMessage(message),
			extractAssistantText: message => this.#ctx.extractAssistantText(message),
		};
	}

	/**
	 * Renders the delegated turn's screen-only body as its single visible
	 * artifact.
	 *
	 * The ordinary transcript path is suppressed for an owned turn, so this is
	 * the only place that detail reaches the terminal during the call. Transcript
	 * rebuild projects the persisted `live-worker` row through the same renderer,
	 * so a resumed session shows the identical block.
	 */
	#presentWorkerArtifact(session: LiveSessionController, text: string): void {
		if (!text.trim()) return;
		this.#finalizeAssistantTranscript();
		// The delegated coding model produced this body, not the voice model, and
		// exports read these fields. `codingModel` is the same resolved override
		// the turn ran on; it cannot be unset here, because the bridge that emits
		// this callback is only constructed after the override resolves.
		const model = session.codingModel;
		if (!model) {
			logger.warn("Live worker artifact arrived before the coding model resolved; dropping it");
			return;
		}
		this.#ctx.present(
			createLiveWorkerArtifact(this.#ctx, { text, api: model.api, provider: model.provider, model: model.id }),
		);
	}

	#finalizeAssistantTranscript(): void {
		const component = this.#assistantTranscriptComponent;
		if (!component) return;
		component.markTranscriptBlockFinalized();
		this.#assistantTranscriptComponent = undefined;
		this.#assistantTranscriptStartedAt = 0;
		this.#ctx.ui.requestComponentRender(component);
	}

	#mountVisualizer(visualizer: LiveVisualizer): void {
		this.#visualizer = visualizer;
		this.#detachedEditor = this.#ctx.editor;
		this.#previousShowHardwareCursor = this.#ctx.ui.getShowHardwareCursor();
		this.#previousUseTerminalCursor = this.#ctx.editor.getUseTerminalCursor();
		this.#ctx.ui.setShowHardwareCursor(false);
		this.#ctx.editor.setUseTerminalCursor(false);
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(visualizer);
		this.#ctx.ui.setFocus(visualizer);
		this.#resumeVocalizer = vocalizer.suspend();
		let frame = 0;
		this.#animationInterval = setInterval(() => {
			if (this.#visualizer !== visualizer) return;
			frame += 1;
			visualizer.setFrame(frame);
			this.#ctx.ui.requestComponentRender(visualizer);
		}, ANIMATION_INTERVAL_MS);
		this.#ctx.ui.requestRender();
	}

	/**
	 * Releases a session.
	 *
	 * A call that failed before ever going active keeps its visualizer mounted in
	 * the error state so `r retry` / `esc back` are reachable — restoring the
	 * editor here is what made the failed-start controls unreachable. Everything
	 * else (user stop, mid-call terminal error) returns to the editor as before.
	 */
	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#ctx.turnPresentationOwned = undefined;
		const holdForRetry = error !== undefined && !this.#everActive && this.#visualizer !== undefined;
		if (holdForRetry) {
			this.#visualizer?.setState({
				connection: "error",
				voice: "listening",
				worker: "idle",
				inputMuted: false,
				outputMuted: false,
			});
			if (this.#visualizer) this.#ctx.ui.requestComponentRender(this.#visualizer);
		} else {
			this.#restoreEditor();
		}
		if (error) this.#ctx.showError(error.message);
		const settling = session.stop().catch(cause => {
			logger.debug("Live session cleanup failed", { error: errorFrom(cause).message });
		});
		this.#settling = settling;
		void settling.finally(() => {
			if (this.#settling === settling) this.#settling = undefined;
			this.#releaseLease?.();
			this.#releaseLease = undefined;
		});
	}

	/** Restarts after a failed start; the held visualizer is replaced by a fresh one. */
	async #retry(): Promise<void> {
		if (this.#session) return;
		if (this.#settling) await this.#settling;
		// Back to the editor first so `#start` mounts a clean surface and the
		// detached-editor bookkeeping stays paired.
		this.#restoreEditor();
		await this.#start();
	}

	#restoreEditor(): void {
		this.#ctx.turnPresentationOwned = undefined;
		this.#finalizeAssistantTranscript();
		if (this.#animationInterval) {
			clearInterval(this.#animationInterval);
			this.#animationInterval = undefined;
		}
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
		const editor = this.#detachedEditor;
		this.#detachedEditor = undefined;
		this.#visualizer = undefined;
		if (!editor) return;
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(editor);
		if (this.#previousShowHardwareCursor !== undefined) {
			this.#ctx.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
		}
		if (this.#previousUseTerminalCursor !== undefined) {
			editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
		}
		this.#previousShowHardwareCursor = undefined;
		this.#previousUseTerminalCursor = undefined;
		this.#ctx.ui.setFocus(editor);
		this.#ctx.ui.requestRender();
	}
}

/**
 * Resolves an explicitly configured `live.codingModel`.
 *
 * Only reached when the setting is non-empty, so a miss is a real
 * misconfiguration and must fail the command with a readable reason rather
 * than quietly running the turn on a model the user did not choose.
 */
function resolveConfiguredCodingModel(pattern: string, session: AgentSession): Model {
	const { model, warning } = resolveModelOverride([pattern], session.modelRegistry, session.settings);
	if (!model) {
		throw new Error(`live.codingModel "${pattern}" did not match an available model${warning ? `: ${warning}` : ""}`);
	}
	return model;
}
