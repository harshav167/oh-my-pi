import * as path from "node:path";
import { $ } from "bun";
import { getToolPath } from "./tools-manager";

export interface VideoPreview {
	readonly duration?: string;
	readonly poster?: {
		readonly type: "image";
		readonly data: string;
		readonly mimeType: "image/png";
	};
}

export function formatVideoDuration(seconds: number): string {
	const rounded = Math.max(0, Math.round(seconds));
	const hours = Math.floor(rounded / 3600);
	const minutes = Math.floor((rounded % 3600) / 60);
	const remaining = rounded % 60;
	return hours > 0
		? `${hours}:${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`
		: `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export async function createVideoPreview(videoPath: string): Promise<VideoPreview> {
	const ffmpeg = getToolPath("ffmpeg");
	if (!ffmpeg) return {};

	const metadata = await $`${ffmpeg} -hide_banner -i ${videoPath}`.quiet().nothrow();
	const durationMatch = metadata.stderr.toString().match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	const duration = durationMatch
		? formatVideoDuration(Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]))
		: undefined;

	const result =
		await $`${ffmpeg} -hide_banner -loglevel error -ss 0 -i ${videoPath} -frames:v 1 -f image2pipe -vcodec png -`
			.quiet()
			.nothrow();
	const poster =
		result.exitCode === 0 && result.stdout.byteLength > 0
			? { type: "image" as const, data: result.stdout.toString("base64"), mimeType: "image/png" as const }
			: undefined;
	return {
		...(duration ? { duration } : {}),
		...(poster ? { poster } : {}),
	};
}

export function videoPreviewName(videoPath: string): string {
	return path.basename(videoPath);
}
