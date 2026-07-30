import { describe, expect, it } from "bun:test";
import { chunkByUtf8Bytes } from "../utf8-chunk";

const bytes = (chunks: string[]) => chunks.map(chunk => Buffer.byteLength(chunk, "utf8"));

describe("chunkByUtf8Bytes", () => {
	it("keeps every chunk within the byte ceiling and loses nothing", () => {
		// Mixed widths on purpose: 1-byte ASCII, 2-byte, 3-byte BMP, 4-byte astral.
		const text = `${"a".repeat(30)}é${"漢".repeat(20)}😀${"b".repeat(30)}`;

		const chunks = chunkByUtf8Bytes(text, 16);

		expect(chunks.join("")).toBe(text);
		expect(Math.max(...bytes(chunks))).toBeLessThanOrEqual(16);
	});

	it("never splits a surrogate pair", () => {
		// A 4-byte character straddling the boundary is the corruption this exists
		// to prevent. The invariant is not "no chunk ends in a surrogate" — a whole
		// emoji legitimately ends with its low surrogate — it is that a UTF-8
		// round-trip introduces no replacement character, i.e. no half pair.
		const text = "😀".repeat(8);

		for (const limit of [4, 5, 6, 7, 8]) {
			const chunks = chunkByUtf8Bytes(text, limit);
			expect(chunks.join("")).toBe(text);
			for (const chunk of chunks) {
				expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
				expect(chunk).not.toContain("\ufffd");
			}
		}
	});

	it("enforces the ceiling per character instead of by a blanket minimum", () => {
		// A 1-byte ceiling is satisfiable for ASCII and must not be rejected...
		expect(chunkByUtf8Bytes("abc", 1)).toEqual(["a", "b", "c"]);
		expect(chunkByUtf8Bytes("aéb", 2)).toEqual(["a", "é", "b"]);
		// ...but a character wider than the ceiling has nowhere to go, and emitting
		// it anyway would break the one guarantee callers rely on.
		expect(() => chunkByUtf8Bytes("aéb", 1)).toThrow(RangeError);
		expect(() => chunkByUtf8Bytes("a😀b", 3)).toThrow(RangeError);
		expect(chunkByUtf8Bytes("😀😀", 4)).toEqual(["😀", "😀"]);
		// A non-positive or fractional ceiling is a caller bug, not an edge case.
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			expect(() => chunkByUtf8Bytes("abc", bad)).toThrow(RangeError);
		}
	});

	it("cuts at the last newline only when the caller asks for it", () => {
		const text = "alpha\nbravo\ncharlie";

		const hard = chunkByUtf8Bytes(text, 12);
		const lines = chunkByUtf8Bytes(text, 12, { preferNewline: true });

		// Hard cuts pack tighter; newline cuts end on a line boundary so an escape
		// sequence spanning the window cannot be severed.
		expect(hard[0]).toBe("alpha\nbravo\n");
		expect(lines[0]).toBe("alpha\nbravo\n");
		expect(chunkByUtf8Bytes("alpha\nbr", 7, { preferNewline: true })[0]).toBe("alpha\n");
		expect(chunkByUtf8Bytes("alpha\nbr", 7)[0]).toBe("alpha\nb");
	});

	it("returns the caller's empty result for empty input", () => {
		// A protocol that must send one frame passes [""]; a writer wants nothing.
		expect(chunkByUtf8Bytes("", 10)).toEqual([]);
		expect(chunkByUtf8Bytes("", 10, { emptyResult: [""] })).toEqual([""]);
	});

	it("returns the whole string when it already fits", () => {
		expect(chunkByUtf8Bytes("漢字", 6)).toEqual(["漢字"]);
	});
});
