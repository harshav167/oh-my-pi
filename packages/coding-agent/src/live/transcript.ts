/**
 * Bounded transcript of the realtime conversation since the previous delegation.
 *
 * Port of Codex's `ActiveTranscriptState` for the frameless (V3) protocol
 * (`codex-api/src/endpoint/realtime_websocket/methods.rs`). Each delegation takes the
 * accumulated entries, so the main agent receives the conversation that led to the request.
 */
import { truncateTailBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";

const MAX_ACTIVE_TRANSCRIPT_BYTES = 8 * 1024;
const TRUNCATED_TRANSCRIPT_PREFIX = "…";
const TRUNCATED_TRANSCRIPT_PREFIX_BYTES = Buffer.byteLength(TRUNCATED_TRANSCRIPT_PREFIX);

/** Speaker of one realtime transcript entry. */
export type LiveTranscriptRole = "user" | "assistant";

/** One speaker's utterance in the active transcript. */
export interface LiveTranscriptEntry {
	role: LiveTranscriptRole;
	text: string;
}

/** Audio span the server reports with a transcript delta; both speakers in one frame are equally recent. */
export interface LiveTranscriptFrame {
	startMs: number;
	endMs: number;
}

interface ActiveEntry {
	transcript: LiveTranscriptEntry;
	lastRawFrame: number | undefined;
	truncatedPrefixBytes: number;
}

function entryBytes(entry: LiveTranscriptEntry): number {
	return Buffer.byteLength(entry.role) + Buffer.byteLength(entry.text) + 3;
}

function retainedText(entry: ActiveEntry): string {
	return entry.truncatedPrefixBytes > 0
		? entry.transcript.text.slice(TRUNCATED_TRANSCRIPT_PREFIX.length)
		: entry.transcript.text;
}

function findLastEntry(entries: ActiveEntry[], role: LiveTranscriptRole): ActiveEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.transcript.role === role) return entry;
	}
	return undefined;
}

function truncateEntry(entry: ActiveEntry, maxBytes: number): void {
	const overhead = Buffer.byteLength(entry.transcript.role) + 3;
	const maxTextBytes = Math.max(0, maxBytes - overhead);
	const textBytes = Buffer.byteLength(entry.transcript.text);
	if (textBytes <= maxTextBytes) return;
	const suffix = truncateTailBytes(
		entry.transcript.text,
		Math.max(0, maxTextBytes - TRUNCATED_TRANSCRIPT_PREFIX_BYTES),
	);
	const previousMarkerBytes = entry.truncatedPrefixBytes > 0 ? TRUNCATED_TRANSCRIPT_PREFIX_BYTES : 0;
	entry.truncatedPrefixBytes += textBytes - suffix.bytes - previousMarkerBytes;
	entry.transcript.text = TRUNCATED_TRANSCRIPT_PREFIX + suffix.text;
}

function truncateActiveTranscript(entries: ActiveEntry[]): void {
	let totalBytes = 0;
	for (const entry of entries) totalBytes += entryBytes(entry.transcript);
	while (totalBytes > MAX_ACTIVE_TRANSCRIPT_BYTES && entries.length > 1) {
		// An earlier utterance can contain the newest speech: evict by frame recency, or FIFO without timing.
		let oldest = 0;
		if (entries.every(entry => entry.lastRawFrame !== undefined)) {
			for (let index = 1; index < entries.length; index += 1) {
				if ((entries[index]?.lastRawFrame ?? 0) < (entries[oldest]?.lastRawFrame ?? 0)) oldest = index;
			}
		}
		const frame = entries[oldest]?.lastRawFrame;
		if (frame !== undefined && entries.every(entry => entry.lastRawFrame === frame)) {
			// Both speakers are equally recent: keep each suffix, letting short entries keep their text.
			let remainingBytes = MAX_ACTIVE_TRANSCRIPT_BYTES;
			let remainingEntries = entries.length;
			const bySize = [...entries].sort((left, right) => entryBytes(left.transcript) - entryBytes(right.transcript));
			for (const entry of bySize) {
				truncateEntry(entry, Math.floor(remainingBytes / remainingEntries));
				remainingBytes = Math.max(0, remainingBytes - entryBytes(entry.transcript));
				remainingEntries -= 1;
			}
			return;
		}
		const [removed] = entries.splice(oldest, 1);
		if (removed) totalBytes -= entryBytes(removed.transcript);
	}
	const first = entries[0];
	if (first) truncateEntry(first, MAX_ACTIVE_TRANSCRIPT_BYTES);
}

function appendDelta(
	entries: ActiveEntry[],
	role: LiveTranscriptRole,
	delta: string,
	forceNew: boolean,
	frameSequence: number | undefined,
): void {
	if (delta.length === 0) return;
	// The frameless protocol interleaves the two speakers, so append to the speaker's latest entry.
	const entry = findLastEntry(entries, role);
	if (!forceNew && entry) {
		entry.transcript.text += delta;
		entry.lastRawFrame = frameSequence;
		return;
	}
	entries.push({ transcript: { role, text: delta }, lastRawFrame: frameSequence, truncatedPrefixBytes: 0 });
}

function applyDone(
	entries: ActiveEntry[],
	role: LiveTranscriptRole,
	text: string,
	forceNew: boolean,
	lastRawFrame: number | undefined,
): void {
	if (text.length === 0) return;
	const entry = findLastEntry(entries, role);
	if (!forceNew && entry) {
		// A delayed final can arrive after deltas from the next utterance: keep accumulated
		// speech unless the final extends it.
		const textBytes = Buffer.byteLength(text);
		const offset = entry.truncatedPrefixBytes;
		// The tail keeps exactly `textBytes - offset` bytes only when the offset is a character boundary.
		const suffix = offset <= textBytes ? truncateTailBytes(text, textBytes - offset) : undefined;
		if (suffix?.bytes === textBytes - offset && suffix.text.startsWith(retainedText(entry))) {
			entry.transcript.text = text;
			entry.truncatedPrefixBytes = 0;
		}
		return;
	}
	// A final for an evicted current utterance must not become newer than retained speech.
	entries.push({
		transcript: { role, text },
		lastRawFrame: forceNew ? undefined : lastRawFrame,
		truncatedPrefixBytes: 0,
	});
}

function appendDelegationInput(entries: ActiveEntry[], input: string): void {
	const trimmed = input.trim();
	if (!trimmed) return;
	if (entries.some(entry => entry.transcript.role === "user" && entry.transcript.text.trim() === trimmed)) return;
	entries.push({ transcript: { role: "user", text: trimmed }, lastRawFrame: undefined, truncatedPrefixBytes: 0 });
}

/** Renders entries as Codex's `role: text` lines; undefined when empty. */
export function formatTranscriptDelta(entries: readonly LiveTranscriptEntry[]): string | undefined {
	const lines = entries.map(entry => `${entry.role}: ${entry.text}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Realtime conversation since the previous delegation, bounded to 8 KiB. */
export class LiveActiveTranscript {
	#entries: ActiveEntry[] = [];
	#lastFrame: LiveTranscriptFrame | undefined;
	#frameSequence = 0;
	#inputLastRawFrame: number | undefined;
	#outputLastRawFrame: number | undefined;
	#newInputEntry = false;
	#newOutputEntry = false;

	/** Records a streaming transcript delta for one speaker. */
	delta(role: LiveTranscriptRole, delta: string, frame?: LiveTranscriptFrame): void {
		const frameSequence = this.#observeFrame(frame);
		const forceNew = role === "user" ? this.#newInputEntry : this.#newOutputEntry;
		appendDelta(this.#entries, role, delta, forceNew, frameSequence);
		if (delta.length > 0) {
			if (role === "user") {
				this.#newInputEntry = false;
				this.#inputLastRawFrame = frameSequence;
			} else {
				this.#newOutputEntry = false;
				this.#outputLastRawFrame = frameSequence;
			}
		}
		this.#bound(frameSequence);
	}

	/** Reconciles one speaker's final transcript for the turn. */
	done(role: LiveTranscriptRole, text: string): void {
		if (role === "user") {
			applyDone(this.#entries, role, text, this.#newInputEntry, this.#inputLastRawFrame);
			this.#newInputEntry = true;
			this.#inputLastRawFrame = undefined;
		} else {
			applyDone(this.#entries, role, text, this.#newOutputEntry, this.#outputLastRawFrame);
			this.#newOutputEntry = true;
			this.#outputLastRawFrame = undefined;
		}
		this.#bound(undefined);
	}

	/** Takes the transcript for a delegation, recording its input when the transcript lacks it. */
	takeForDelegation(input: string): LiveTranscriptEntry[] {
		truncateActiveTranscript(this.#entries);
		appendDelegationInput(this.#entries, input);
		this.#inputLastRawFrame = undefined;
		this.#outputLastRawFrame = undefined;
		const entries = this.#entries.splice(0).map(entry => entry.transcript);
		this.#newInputEntry = true;
		this.#newOutputEntry = true;
		return entries;
	}

	#observeFrame(frame: LiveTranscriptFrame | undefined): number | undefined {
		if (!frame) return undefined;
		const last = this.#lastFrame;
		if (!last || last.startMs !== frame.startMs || last.endMs !== frame.endMs) {
			truncateActiveTranscript(this.#entries);
			this.#frameSequence += 1;
			this.#lastFrame = frame;
		}
		return this.#frameSequence;
	}

	#bound(frameSequence: number | undefined): void {
		if (frameSequence === undefined) {
			truncateActiveTranscript(this.#entries);
			return;
		}
		// Wait for both speakers before evicting utterances from this frame; bound each updated one.
		for (const entry of this.#entries) {
			if (entry.lastRawFrame === frameSequence) truncateEntry(entry, MAX_ACTIVE_TRANSCRIPT_BYTES);
		}
	}
}
