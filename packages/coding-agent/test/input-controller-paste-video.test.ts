/**
 * Regression: pasting a local video file path on a video-capable model must
 * attach it as a native inline video (chip + pendingVideos), NOT paste the raw
 * path as text. On a model without native video support, the path stays as
 * plain text (no chip, no error). Reproduces the reported paste regression.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ImageContent, Model, VideoContent } from "@oh-my-pi/pi-ai";
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
});
