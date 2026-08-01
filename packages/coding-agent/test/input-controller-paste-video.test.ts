/**
 * Regression: pasting a local video file path on a video-capable model must
 * attach it as a native inline video (chip + pendingVideos), NOT paste the raw
 * path as text. On a model without native video support, the path stays as
 * plain text (no chip, no error). Reproduces the reported paste regression.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ImageContent, Model, VideoContent } from "@oh-my-pi/pi-ai";
import { extractMediaPastePathsFromText } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function createContext(modelInput: ("text" | "image" | "video")[], cwd: string) {
	let editorText = "";
	const editor = {
		setText: (t: string) => {
			editorText = t;
		},
		getText: () => editorText,
		insertText: (t: string) => {
			editorText += t;
		},
		pasteText: (t: string) => {
			editorText += t;
		},
		addToHistory: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		pendingVideos: [] as VideoContent[],
		pendingVideoPaths: [] as string[],
	};
	const showStatus = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		editor,
		ui: { requestRender },
		session: { model: { input: modelInput } as Model, isStreaming: false },
		sessionManager: { getCwd: () => cwd },
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, editor, showStatus };
}

describe("InputController video path paste", () => {
	let tempDir: TempDir;
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("attaches a pasted video path natively on a video-capable model", async () => {
		tempDir = TempDir.createSync("@paste-video-");
		try {
			const mp4 = path.join(tempDir.path(), "clip.mp4");
			await Bun.write(mp4, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])); // minimal non-empty bytes
			const { ctx, editor } = createContext(["text", "image", "video"], tempDir.path());
			const controller = new InputController(ctx);

			await controller.handleImagePathPaste(mp4);

			expect(editor.pendingVideos).toHaveLength(1);
			expect(editor.pendingVideos[0]?.type).toBe("video");
			expect(editor.pendingVideos[0]?.mimeType).toBe("video/mp4");
			expect(editor.pendingVideoPaths).toEqual([mp4]);
			expect(editor.getText()).toContain("[Video #1,");
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	it("leaves the path as plain text on a model without native video support", async () => {
		tempDir = TempDir.createSync("@paste-video-nonvid-");
		try {
			const mp4 = path.join(tempDir.path(), "clip.mp4");
			await Bun.write(mp4, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
			const { ctx, editor } = createContext(["text", "image"], tempDir.path());
			const controller = new InputController(ctx);

			await controller.handleImagePathPaste(mp4);

			expect(editor.pendingVideos).toHaveLength(0);
			expect(editor.getText()).toContain(mp4);
			expect(editor.getText()).not.toContain("[Video #1,");
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	it("reports a missing video path instead of silently doing nothing", async () => {
		// A nonexistent Bun.file reports size 0, so the size gate passes and the
		// read throws ENOENT. That rejection used to escape handleImagePathPaste
		// and get swallowed by the editor's async-paste tracker: no chip, no text,
		// no status — the paste simply vanished.
		tempDir = TempDir.createSync("@paste-video-missing-");
		try {
			const missing = path.join(tempDir.path(), "gone.mp4");
			const { ctx, editor, showStatus } = createContext(["text", "image", "video"], tempDir.path());
			const controller = new InputController(ctx);

			await controller.handleImagePathPaste(missing);

			expect(editor.pendingVideos).toHaveLength(0);
			expect(showStatus).toHaveBeenCalled();
			expect(String(showStatus.mock.calls[0]?.[0])).toContain("not found");
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	it("does not classify an extension the MIME map cannot resolve as media", async () => {
		// VIDEO_PATH_REGEX used to match .wmv/.flv/.3gp, which VIDEO_MIME_TYPES
		// does not carry. Classifying those as media routed an ordinary text paste
		// into the image loader, which reported "not a supported image".
		// This is the seam that decides whether handleImagePathPaste runs at all.
		tempDir = TempDir.createSync("@paste-video-unmapped-");
		try {
			const mapped = path.join(tempDir.path(), "clip.mp4");
			const unmapped = path.join(tempDir.path(), "clip.wmv");
			await Bun.write(mapped, new Uint8Array([0, 0, 0, 24]));
			await Bun.write(unmapped, new Uint8Array([0, 0, 0, 24]));

			expect(extractMediaPastePathsFromText(mapped)).toEqual([mapped]);
			expect(extractMediaPastePathsFromText(unmapped)).toBeUndefined();
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});
});
