/**
 * Options for {@link chunkByUtf8Bytes}.
 */
export interface Utf8ChunkOptions {
	/**
	 * Cut at the last `\n` inside the window when one exists.
	 *
	 * For terminal writes, where a chunk boundary inside an escape sequence
	 * corrupts the frame: escape sequences never contain `\n`, so a newline cut
	 * keeps them intact. Wire payloads that carry no escape sequences want the
	 * default hard cut, which packs chunks tighter.
	 */
	readonly preferNewline?: boolean;
	/**
	 * Value to return for empty input.
	 *
	 * Defaults to no chunks. A protocol that must send at least one (possibly
	 * empty) frame passes `[""]`.
	 */
	readonly emptyResult?: readonly string[];
}

/**
 * Split `text` into chunks whose UTF-8 encoding is at most `maxBytes` each.
 *
 * Never splits a character: UTF-16 code units are walked and their UTF-8 width
 * derived from their value (`<0x80` → 1, `<0x800` → 2, surrogate pair → 4 across
 * two units, other BMP or unpaired surrogate → 3), and surrogate pairs are kept
 * together. Walking beats measuring each candidate slice with
 * `Buffer.byteLength` because the width of every unit is already known.
 *
 * The ceiling is hard, and enforced per character rather than by a blanket
 * minimum: `("abc", 1)` is perfectly satisfiable, while a character wider than
 * the ceiling has nowhere to go and throws `RangeError`. Silently emitting an
 * over-budget chunk would break the one guarantee callers rely on.
 */
export function chunkByUtf8Bytes(text: string, maxBytes: number, options?: Utf8ChunkOptions): string[] {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) {
		throw new RangeError(`maxBytes must be a positive integer, received ${maxBytes}`);
	}
	if (!text) return [...(options?.emptyResult ?? [])];
	const limit = maxBytes;
	if (Buffer.byteLength(text, "utf8") <= limit) return [text];
	const preferNewline = options?.preferNewline === true;
	const chunks: string[] = [];
	const length = text.length;
	let start = 0;
	while (start < length) {
		let bytes = 0;
		// Index just past the most recent `\n` consumed inside [start, index).
		let lastNewlineEnd = -1;
		let index = start;
		while (index < length) {
			const unit = text.charCodeAt(index);
			let unitLength = 1;
			let unitBytes: number;
			if (unit < 0x80) {
				unitBytes = 1;
			} else if (unit < 0x800) {
				unitBytes = 2;
			} else if (unit >= 0xd800 && unit < 0xdc00) {
				// High surrogate: a following low surrogate makes one 4-byte
				// character across two units; an unpaired one encodes as the 3-byte
				// U+FFFD replacement.
				const next = index + 1 < length ? text.charCodeAt(index + 1) : 0;
				if (next >= 0xdc00 && next < 0xe000) {
					unitBytes = 4;
					unitLength = 2;
				} else {
					unitBytes = 3;
				}
			} else {
				unitBytes = 3;
			}
			if (unitBytes > limit) {
				// Wider than the whole ceiling: there is no chunk that can hold it, so
				// the alternative to throwing is emitting an over-budget chunk.
				throw new RangeError(`a ${unitBytes}-byte character cannot fit a ${limit}-byte chunk`);
			}
			if (bytes + unitBytes > limit && index > start) {
				let cut = index;
				if (preferNewline && lastNewlineEnd > start) cut = lastNewlineEnd;
				chunks.push(text.slice(start, cut));
				start = cut;
				break;
			}
			bytes += unitBytes;
			index += unitLength;
			if (unit === 0x0a) lastNewlineEnd = index;
		}
		if (index >= length) {
			chunks.push(text.slice(start));
			start = length;
		}
	}
	return chunks;
}
