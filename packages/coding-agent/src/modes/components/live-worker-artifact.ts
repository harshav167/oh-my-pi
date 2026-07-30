import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { LIVE_MODEL } from "../../live/protocol";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import type { AssistantMessageComponent } from "./assistant-message";

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * One live voice turn as an assistant message.
 *
 * The realtime route is always the Codex backend, so `api` and `provider` are
 * fixed here; the model rides on the persisted row because the voice model is
 * configurable, and rows written before that field existed fall back to the
 * current default. Shared by the live surface and transcript rebuild so a
 * resumed call is attributed to the model that actually spoke, never to the
 * coding model that ran underneath it.
 */
export function liveVoiceMessage(text: string, model: string | undefined, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: model ?? LIVE_MODEL,
		usage: { ...ZERO_USAGE },
		stopReason: "stop",
		timestamp,
	};
}

/**
 * The delegated turn's screen-only body plus the identity that produced it.
 *
 * The identity is carried rather than assumed: this body comes from the
 * delegated coding model (`live.codingModel`, which may be any provider), not
 * from the voice model, and exports and copy read these fields. Rebuild passes
 * the owned assistant message's own values; the live path passes the resolved
 * coding model.
 */
export interface LiveWorkerArtifact {
	readonly text: string;
	readonly api: AssistantMessage["api"];
	readonly provider: string;
	readonly model: string;
	readonly timestamp?: number;
}

/**
 * Renders a delegated `/live` turn's screen-only body as its single artifact.
 *
 * Shared by the live path and transcript rebuild on purpose: the two must
 * produce the same component, or resuming a session would reframe the same
 * report as a different kind of block. Rendered as an assistant message rather
 * than a custom-message card because the body is the agent's own markdown and
 * has to stay readable — no colour transform, no frame.
 *
 * Usage is zeroed: the owned assistant record already carries this turn's real
 * usage, and counting it twice would double the session's reported cost.
 *
 * Finalized on creation: the handoff hands over a whole message, never a
 * partial, so there is nothing left to stream into it.
 */
export function createLiveWorkerArtifact(
	ctx: InteractiveModeContext,
	artifact: LiveWorkerArtifact,
): AssistantMessageComponent {
	const component = createAssistantMessageComponent(ctx);
	component.updateContent({
		role: "assistant",
		content: [{ type: "text", text: artifact.text }],
		api: artifact.api,
		provider: artifact.provider,
		model: artifact.model,
		usage: { ...ZERO_USAGE },
		stopReason: "stop",
		timestamp: artifact.timestamp ?? Date.now(),
	});
	component.markTranscriptBlockFinalized();
	return component;
}
