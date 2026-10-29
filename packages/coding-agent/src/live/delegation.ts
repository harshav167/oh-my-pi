/**
 * How a delegated voice request reaches the main agent, ported from Codex:
 * `<realtime_delegation>` user input (`core/src/context/realtime_delegation.rs`) and the
 * `<realtime_conversation>` start/end developer instructions (`prompts/templates/realtime`).
 */
import type { DeveloperMessage, Message, UserMessage } from "@oh-my-pi/pi-ai";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { truncateHeadBytes, truncateTailBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { escapeXmlText, isRecord, prompt } from "@oh-my-pi/pi-utils";
import realtimeDelegationTemplate from "./prompts/realtime-delegation.md" with { type: "text" };
import realtimeEndInstructions from "./prompts/realtime-end.md" with { type: "text" };
import realtimeStartInstructions from "./prompts/realtime-start.md" with { type: "text" };
import type { LiveTranscriptEntry } from "./transcript";

/** Hidden developer context telling the main agent that voice mode has ended. */
export const LIVE_VOICE_CONTEXT_MESSAGE_TYPE = "live-voice-context";

/** Session record of one finished realtime utterance; never sent to the model. */
export const LIVE_TRANSCRIPT_ENTRY_TYPE = "live-transcript";

/** Developer instructions for the first turn after voice mode ends. */
export const LIVE_VOICE_END_INSTRUCTIONS = realtimeEndInstructions.trim();

const LIVE_VOICE_START_INSTRUCTIONS = realtimeStartInstructions.trim();
const MAX_REALTIME_DELEGATION_FIELD_BYTES = 4 * 1024;
const TRUNCATION_MARKER = "…";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER);

/** Escapes and caps one field at 4 KiB, keeping its start (`input`) or end (`transcript_delta`). */
function boundedXmlField(text: string, retain: "start" | "end"): string {
	const escaped = escapeXmlText(text);
	if (Buffer.byteLength(escaped) <= MAX_REALTIME_DELEGATION_FIELD_BYTES) return escaped;
	const retainedBytes = MAX_REALTIME_DELEGATION_FIELD_BYTES - TRUNCATION_MARKER_BYTES;
	if (retain === "start") return truncateHeadBytes(escaped, retainedBytes).text + TRUNCATION_MARKER;
	return TRUNCATION_MARKER + truncateTailBytes(escaped, retainedBytes).text;
}

/** Renders Codex's `<realtime_delegation>` user input for one voice request. */
export function renderRealtimeDelegation(input: string, transcriptDelta: string | undefined): string {
	// Compiled without post-render formatting: transcript text must reach the model byte-for-byte.
	return prompt
		.compile(realtimeDelegationTemplate)({
			input: boundedXmlField(input, "start"),
			transcriptDelta: transcriptDelta ? boundedXmlField(transcriptDelta, "end") : undefined,
		})
		.trimEnd();
}

/**
 * The user's utterances since the previous request, for the on-screen request row. The voice
 * model's request text can be a short excerpt of them; an utterance identical to it is left
 * out because the row shows the request text itself.
 */
export function spokenSinceLastRequest(transcript: readonly LiveTranscriptEntry[], request: string): string[] {
	const requestText = request.trim();
	const spoken: string[] = [];
	for (const entry of transcript) {
		const text = entry.text.trim();
		if (entry.role === "user" && text && text !== requestText) spoken.push(text);
	}
	return spoken;
}

/**
 * Model view of a delegated voice request: the voice start instructions on a session's first
 * request, then the request as `<realtime_delegation>` user input. Undefined for non-text content.
 */
export function liveDelegationToLlm(message: CustomMessage<unknown>): Message[] | undefined {
	if (typeof message.content !== "string") return undefined;
	const details = isRecord(message.details) ? message.details : undefined;
	const transcriptDelta = typeof details?.transcriptDelta === "string" ? details.transcriptDelta : undefined;
	const messages: Message[] = [];
	if (details?.voiceStart === true) {
		const start: DeveloperMessage = {
			role: "developer",
			content: [{ type: "text", text: LIVE_VOICE_START_INSTRUCTIONS }],
			attribution: "agent",
			timestamp: message.timestamp,
		};
		messages.push(start);
	}
	const request: UserMessage = {
		role: "user",
		content: [{ type: "text", text: renderRealtimeDelegation(message.content, transcriptDelta) }],
		attribution: message.attribution,
		timestamp: message.timestamp,
	};
	messages.push(request);
	return messages;
}
