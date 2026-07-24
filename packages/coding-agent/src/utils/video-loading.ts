import * as path from "node:path";
import type { VideoContent } from "@oh-my-pi/pi-ai";
import { VIDEO_MIME_TYPES } from "../cli/file-processor";
import { resolveReadPath } from "../tools/path-utils";
import { formatBytes } from "../tools/render-utils";

export const MAX_VIDEO_INPUT_BYTES = 100 * 1024 * 1024;

export interface LoadedVideoInput {
	video: VideoContent;
	resolvedPath: string;
}

export async function loadVideoInput(options: {
	path: string;
	cwd: string;
	maxBytes?: number;
}): Promise<LoadedVideoInput | null> {
	const resolvedPath = resolveReadPath(options.path, options.cwd);
	const mimeType = VIDEO_MIME_TYPES.get(path.extname(resolvedPath).toLowerCase());
	if (!mimeType) return null;

	const file = Bun.file(resolvedPath);
	const stat = await file.stat();
	const maxBytes = options.maxBytes ?? MAX_VIDEO_INPUT_BYTES;
	if (stat.size > maxBytes) {
		throw new Error(`Video file too large: ${formatBytes(stat.size)} exceeds ${formatBytes(maxBytes)} limit.`);
	}
	const data = await file.bytes();
	if (data.byteLength === 0) {
		throw new Error("Video file is empty.");
	}
	return {
		video: { type: "video", data: data.toBase64(), mimeType },
		resolvedPath,
	};
}
