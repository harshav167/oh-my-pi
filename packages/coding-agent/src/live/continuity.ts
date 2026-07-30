import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { LIVE_TRANSCRIPT_MESSAGE_TYPE, type LiveTranscriptDetails } from "../session/messages";
import { truncateHeadBytes } from "../session/streaming-output";
import summaryTemplate from "./prompts/live-continuity-summary.md" with { type: "text" };
import type { LiveInitialItem } from "./protocol";

export interface LiveContinuityLimits {
	readonly maxItems: number;
	readonly maxTokens: number;
}

/**
 * Largest share of `maxTokens` the compaction summary may claim.
 *
 * The remainder is reserved for the transcript tail, so the newest spoken turns
 * always survive a verbose summary. Truncating the summary loses older detail
 * the coding session still holds; losing the tail loses the live conversation.
 */
const SUMMARY_BUDGET_SHARE = 0.5;
function estimatedTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function liveTranscriptTurn(message: AgentMessage): LiveInitialItem | undefined {
	if (message.role !== "custom") return undefined;
	const custom = message as { customType?: string; details?: unknown };
	if (custom.customType !== LIVE_TRANSCRIPT_MESSAGE_TYPE) return undefined;
	const details = custom.details as LiveTranscriptDetails | undefined;
	const text = details?.text?.trim();
	if (!text || (details?.role !== "user" && details?.role !== "assistant")) return undefined;
	return { role: details.role, text };
}

function summaryItem(message: AgentMessage, maxTokens: number): LiveInitialItem | undefined {
	if (message.role !== "compactionSummary") return undefined;
	const source = message.summary.trim() || message.shortSummary?.trim() || "";
	if (!source) return undefined;
	const rendered = prompt.render(summaryTemplate, { summary: source }).trim();
	if (estimatedTokens(rendered) <= maxTokens) return { role: "developer", text: rendered };
	const byteBudget = maxTokens * 4;
	const fullMarker = "\n…summary truncated…";
	const marker =
		Buffer.byteLength(fullMarker, "utf8") <= byteBudget ? fullMarker : truncateHeadBytes("…", byteBudget).text;
	const head = truncateHeadBytes(rendered, Math.max(0, byteBudget - Buffer.byteLength(marker, "utf8"))).text;
	return { role: "developer", text: `${head}${marker}` };
}

/**
 * Seeds a fresh Frameless V3 call from the latest compaction summary plus the
 * hidden structured voice turns recorded since it.
 *
 * Unrelated coding messages are deliberately excluded: ChatGPT's build seeds
 * the realtime session with conversational continuity only, and replaying a
 * coding transcript into a voice model produces confident nonsense.
 */
export function buildLiveInitialItems(
	messages: readonly AgentMessage[],
	limits: LiveContinuityLimits,
): LiveInitialItem[] {
	const maxItems = Math.min(128, Math.max(1, limits.maxItems));
	const maxTokens = Math.min(8192, Math.max(1, limits.maxTokens));

	let summaryIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "compactionSummary") {
			summaryIndex = index;
			break;
		}
	}

	const candidates: LiveInitialItem[] = [];
	for (let index = summaryIndex + 1; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		const turn = liveTranscriptTurn(message);
		if (turn) candidates.push(turn);
	}

	// The summary may not spend the whole budget, and it may not take the only
	// slot. It is the older, coarser half of continuity; the transcript tail is
	// what the user just said. One shared allowance let a long summary starve the
	// tail to zero, and pushing it first let `maxItems: 1` drop the tail entirely —
	// both read as the model having forgotten the last thing it was told.
	const summaryCeiling = Math.max(1, Math.floor(maxTokens * SUMMARY_BUDGET_SHARE));
	const items: LiveInitialItem[] = [];
	let remainingTokens = maxTokens;
	const summary = summaryIndex >= 0 ? messages[summaryIndex] : undefined;
	const roomForSummary = maxItems > 1 || candidates.length === 0;
	const summarySeed = summary && roomForSummary ? summaryItem(summary, summaryCeiling) : undefined;
	if (summarySeed) {
		items.push(summarySeed);
		remainingTokens = Math.max(0, maxTokens - estimatedTokens(summarySeed.text));
	}

	const selected: LiveInitialItem[] = [];
	for (let index = candidates.length - 1; index >= 0 && items.length + selected.length < maxItems; index--) {
		const candidate = candidates[index];
		if (!candidate) continue;
		const tokens = estimatedTokens(candidate.text);
		if (tokens <= remainingTokens) {
			remainingTokens -= tokens;
			selected.push(candidate);
			continue;
		}
		// The newest turn is the one the user just spoke: truncate it rather than
		// dropping it in favour of older context.
		if (selected.length === 0 && remainingTokens > 0) {
			const text = truncateHeadBytes(candidate.text, remainingTokens * 4).text.trim();
			if (text) {
				remainingTokens = 0;
				selected.push({ role: candidate.role, text });
			}
		}
		break;
	}
	selected.reverse();
	items.push(...selected);
	return items;
}
