import { truncateHeadBytes } from "../session/streaming-output";
import type { LiveContextChannel } from "./protocol";

/**
 * Opens a content part whose body is rendered on screen and never spoken.
 *
 * Scoped to its own part, not to the message: one assistant message routinely
 * carries a `commentary` preamble part and a `final_answer` part, and the
 * directive belongs to whichever part it opens. Anything before it inside that
 * part makes the part ordinary speech.
 */
const VISUAL_DIRECTIVE = "::codex-realtime-inline{}";

/** Fence markers that open a code block. */
const FENCES = ["```", "~~~"] as const;

/** Longest partial fence that could still be completed by the next delta. */
const FENCE_HOLDBACK = 2;

/**
 * Inline code span: text the model itself marked as exact.
 *
 * Unlike a heading or a table, a backtick span is an explicit annotation rather
 * than an inference about prose, which is why it is allowed to drive rendering.
 * The voice model rewrites what it speaks — `1.4.0` came out as "one point four"
 * — so a marked token that is only ever spoken is a token the user never
 * actually receives.
 */
const INLINE_CODE = /`[^`\n]+`/g;

/**
 * Speech ceiling per assistant message, in UTF-8 bytes.
 *
 * An explicit fork, not parity: it sits above the largest observed reference
 * reply (589 chars) so it can never clip legitimate output, and well below the
 * ~2000-character markdown the broken build spoke. Only audio is charged
 * against it — `commentary` is context, never sound.
 */
const SPEECH_BYTE_BUDGET = 1000;

/** Spoken when the rest of a long message was diverted to the screen. */
const OVERFLOW_SUFFIX = " More detail is shown on screen.";

/**
 * Budget for spoken body text, leaving room for {@link OVERFLOW_SUFFIX}.
 *
 * Reserved up front because emitted bytes cannot be retracted: spending the
 * full budget on body and then appending the suffix would overrun the ceiling.
 */
const SPEECH_BODY_BUDGET = SPEECH_BYTE_BUDGET - Buffer.byteLength(OVERFLOW_SUFFIX);

/**
 * Spoken when a message produced no audio and had no preamble to promote. The
 * body itself reaches the screen as the turn's guaranteed artifact — the
 * ordinary assistant-message path is suppressed while the handoff owns the
 * turn — so this cue is what sends the user to look there instead of leaving
 * the turn silent.
 */
const WITHHELD_CUE = "Details are shown on screen.";

/** Part index for text reconciled from the final message after the stream. */
export const REMAINDER_PART = -1;

/** One assistant content part: its own directive probe, lane, and fence state. */
type Part = {
	/** Channel the part's phase metadata selected; fixed at first delta. */
	readonly channel: LiveContextChannel | undefined;
	/** Held bytes while the leading directive is still ambiguous. */
	probe: string;
	lane: "speech" | "visual" | undefined;
	/** Body so far, directive excluded. Emitted text is a prefix of this. */
	raw: string;
	/** How much of `raw` has been emitted. */
	sentChars: number;
	fenced: boolean;
};

/**
 * Splits the coding agent's output between the voice wire and the screen.
 *
 * Ordinary prose crosses byte-for-byte; the boundary exists so that an ignored
 * instruction cannot become unsafe audio, and so that every message the model
 * ends still leaves the user with something spoken.
 *
 * Four rules carry that guarantee:
 *
 * - Lanes are per content part. A `final_answer` part opening with the visual
 *   directive is screen-only even when an earlier part in the same message
 *   already opened a speech lane — otherwise the directive itself and the
 *   markdown behind it are read aloud.
 * - `commentary` is buffered until the message closes, then promoted to
 *   `speakable` when the message produced no audio at all. A turn whose entire
 *   answer is written detail is exactly when the preamble IS the spoken reply,
 *   and holding it that long costs nothing: `endMessage` runs at the message
 *   boundary, still ahead of any tool wait it was narrating.
 * - Screen-only bodies go to `onScreen`, which owns the single rendered
 *   artifact for the delegated turn. The ordinary transcript path is suppressed
 *   while the handoff owns the turn, so this is the one place written detail
 *   reaches the terminal and it cannot be rendered twice.
 * - An answer message always projects its body for the screen: its visual parts
 *   when the model used the directive, otherwise the answer itself. The body is
 *   unconditional so a resumed session can always replay it, and it is paired
 *   with the withheld remainder — the text audio never took — so the live
 *   surface can draw the unspoken detail without restating what the voice says.
 */
export class LiveHandoffOutput {
	readonly #emit: (text: string, channel: LiveContextChannel | undefined) => void;
	readonly #onScreen: (body: string, withheld: string) => void;
	readonly #parts = new Map<number, Part>();
	/** Audio bytes emitted for the open message; drives promotion and the cap. */
	#spokenBytes = 0;
	#overflowed = false;

	constructor(
		emit: (text: string, channel: LiveContextChannel | undefined) => void,
		onScreen: (body: string, withheld: string) => void = () => {},
	) {
		this.#emit = emit;
		this.#onScreen = onScreen;
	}

	/** Starts a new assistant message; each gets its own lanes and budget. */
	beginMessage(): void {
		this.#parts.clear();
		this.#spokenBytes = 0;
		this.#overflowed = false;
	}

	append(text: string, channel: LiveContextChannel | undefined, index: number): void {
		if (!text) return;
		const part = this.#part(index, channel);
		let body = text;
		if (part.lane === undefined) {
			part.probe += text;
			// Completed marker first: a probe equal to the directive also
			// satisfies `VISUAL_DIRECTIVE.startsWith(probe)`, so testing the
			// ambiguous case first would hold a finished marker forever and
			// then speak it at the end of the message.
			if (part.probe.startsWith(VISUAL_DIRECTIVE)) {
				part.lane = "visual";
				part.raw = part.probe.slice(VISUAL_DIRECTIVE.length);
				part.probe = "";
				return;
			}
			// Still indistinguishable from the directive: hold everything.
			if (VISUAL_DIRECTIVE.startsWith(part.probe)) return;
			// Not the directive after all — release the held bytes.
			part.lane = "speech";
			body = part.probe;
			part.probe = "";
		}
		part.raw += body;
		if (part.lane === "visual") return;
		this.#drainSpeakable(false);
	}

	/** Mid-message push. Buffered `commentary` waits for {@link endMessage}. */
	flush(): void {
		this.#drainSpeakable(false);
	}

	/**
	 * Closes the message: releases held bytes, resolves the commentary channel,
	 * and — for the message carrying the turn's answer — guarantees both audio
	 * and exactly one screen artifact.
	 *
	 * `answer` is false for a tool-use message. Its preamble is progress, so it
	 * crosses as silent context and never becomes speech; promoting it would
	 * make the assistant narrate every tool step aloud.
	 */
	endMessage(answer = true): void {
		for (const part of this.#parts.values()) {
			if (part.lane !== undefined || !part.probe) continue;
			// Never long enough to be the directive, so it was always speech.
			part.lane = "speech";
			part.raw += part.probe;
			part.probe = "";
		}
		this.#drainSpeakable(true);
		// Decided only now: whether any speakable part produced audio is what
		// separates a silent preamble from the turn's only spoken reply.
		const promote = answer && this.#spokenBytes === 0;
		for (const part of this.#parts.values()) {
			if (part.channel !== "commentary" || part.lane !== "speech") continue;
			this.#drain(part, true, promote ? "speakable" : "commentary");
		}
		// One artifact per message, unconditionally for the message that carries
		// the answer. A conditional body IS the defect this replaces: the ordinary
		// transcript is suppressed while the handoff owns the turn, so a message
		// that projected nothing lost the answer outright — which is what a model
		// ignoring the directive did. Fences and the byte cap gate audio only.
		//
		// Preference order: the directive's visual parts, else the answer parts.
		// `commentary` is progress narration addressed to the voice model, not
		// report content, so it is dropped whenever the message also carried an
		// answer — and kept when it is the only body there is, because then the
		// artifact is the last place that content can still be seen.
		const parts = [...this.#parts.values()];
		let shown = parts.filter(part => part.lane === "visual");
		if (shown.length === 0 && answer) {
			const answered = parts.filter(part => part.channel !== "commentary");
			shown = answered.some(part => part.raw.trim()) ? answered : parts;
		}
		// Two payloads, because the screen has two consumers with different needs.
		//
		// `body` is the whole thing: the durable row a reload replays, which must
		// carry the full detail even though the voice model paraphrases when it
		// speaks. `withheld` is only what audio never took — `sentChars` marks the
		// exact boundary — so the live surface can draw the code, the overflow tail,
		// or the directive-led detail WITHOUT restating the sentence the voice is
		// already delivering. That restatement, in a second colour, is the duplicate
		// this split removes; an empty `withheld` means the voice has it all and the
		// call draws nothing.
		const body = shown
			.map(part => part.raw.trim())
			.filter(Boolean)
			.join("\n\n");
		let withheld = shown
			.map(part => part.raw.slice(part.sentChars).trim())
			.filter(Boolean)
			.join("\n\n");
		// Text the answer marked as exact, appended whenever audio was its only
		// carrier — including a mixed answer whose fence tail is already withheld but
		// whose marked command sits up in the spoken prose. ONLY the tokens, never
		// the sentence around them: the voice is delivering that, and repeating it in
		// a second colour is the duplicate this whole split exists to remove.
		const exact = [...new Set(body.match(INLINE_CODE) ?? [])].filter(span => !withheld.includes(span));
		if (exact.length > 0) withheld = withheld ? `${withheld}\n\n${exact.join("\n")}` : exact.join("\n");
		if (body) this.#onScreen(body, withheld);
		if (answer && this.#spokenBytes === 0 && this.#hasBody()) this.#speak(WITHHELD_CUE);
		this.beginMessage();
	}

	/** Emits one synthesized status record; never promoted to speech. */
	emitStatus(text: string): void {
		if (!text) return;
		this.#emit(text, "commentary");
	}

	reset(): void {
		this.beginMessage();
	}

	#part(index: number, channel: LiveContextChannel | undefined): Part {
		const existing = this.#parts.get(index);
		if (existing) return existing;
		// Streamed phase metadata can lapse on later deltas, so the channel is
		// latched from the delta that opened the part.
		const part: Part = { channel, probe: "", lane: undefined, raw: "", sentChars: 0, fenced: false };
		this.#parts.set(index, part);
		return part;
	}

	#hasBody(): boolean {
		for (const part of this.#parts.values()) {
			if (part.raw.trim()) return true;
		}
		return false;
	}

	#drainSpeakable(complete: boolean): void {
		for (const part of this.#parts.values()) {
			if (part.channel === "commentary" || part.lane !== "speech") continue;
			this.#drain(part, complete, "speakable");
		}
	}

	/**
	 * Emits the unsent prefix of a part's body.
	 *
	 * A code fence ends audio for the remainder of that part: the reference
	 * never speaks code, and reading a mermaid diagram aloud is the defect this
	 * exists to prevent. Until the part is complete, a trailing partial fence is
	 * held back so a fence split across deltas is still caught. Neither the
	 * fence rule nor the byte cap applies to `commentary`, which is context.
	 */
	#drain(part: Part, complete: boolean, channel: LiveContextChannel): void {
		const audible = channel === "speakable";
		if (audible && (part.fenced || this.#overflowed)) return;
		let limit = part.raw.length;
		if (audible) {
			for (const fence of FENCES) {
				const at = part.raw.indexOf(fence, part.sentChars);
				if (at !== -1 && at < limit) limit = at;
			}
			const fenceFound = limit < part.raw.length;
			if (!fenceFound && !complete) {
				// A tail of fence characters may be the start of a split fence.
				while (limit > part.sentChars && limit > part.raw.length - FENCE_HOLDBACK) {
					const ch = part.raw[limit - 1];
					if (ch !== "`" && ch !== "~") break;
					limit -= 1;
				}
			}
			if (fenceFound) part.fenced = true;
		}
		const pending = part.raw.slice(part.sentChars, limit);
		if (!pending) return;
		if (audible) {
			// Advance by what audio actually took, never by `limit`: the byte cap can
			// truncate inside this chunk, and the untaken tail is exactly what the
			// screen projection still has to carry.
			part.sentChars += this.#speak(pending);
			return;
		}
		part.sentChars = limit;
		this.#emit(pending, channel);
	}

	/**
	 * Emits audio, or truncates and stops once the budget is spent.
	 *
	 * Returns how many characters of `text` were actually voiced, which is what
	 * advances the part's emitted prefix.
	 */
	#speak(text: string): number {
		const remaining = SPEECH_BODY_BUDGET - this.#spokenBytes;
		const bytes = Buffer.byteLength(text);
		if (bytes <= remaining) {
			this.#spokenBytes += bytes;
			this.#emit(text, "speakable");
			return text.length;
		}
		this.#overflowed = true;
		const head = truncateHeadBytes(text, Math.max(0, remaining)).text;
		const spoken = head + OVERFLOW_SUFFIX;
		// Counts as spoken: the turn already has audio, so the withheld cue must
		// not fire on top of it and push the total past the ceiling.
		this.#spokenBytes += Buffer.byteLength(spoken);
		this.#emit(spoken, "speakable");
		// The suffix is ours, not the model's, so only the head advances the prefix.
		return head.length;
	}
}
