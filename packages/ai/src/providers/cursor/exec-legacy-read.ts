import { create } from "@bufbuild/protobuf";
import {
	ReadErrorSchema,
	ReadFileNotFoundSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ToolResultMessage } from "../../types";
import { piOutputText } from "./exec-modern";

function details(toolResult: ToolResultMessage): Record<string, unknown> | undefined {
	return isRecord(toolResult.details) ? toolResult.details : undefined;
}

function totalFileLines(toolResult: ToolResultMessage): number | undefined {
	const resultDetails = details(toolResult);
	const explicit = resultDetails?.totalFileLines;
	if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
	const meta = resultDetails?.meta;
	if (!isRecord(meta) || !isRecord(meta.truncation)) return undefined;
	const totalLines = meta.truncation.totalLines;
	return typeof totalLines === "number" && Number.isFinite(totalLines) ? totalLines : undefined;
}

function fileSize(toolResult: ToolResultMessage): number | undefined {
	const value = details(toolResult)?.fileSize;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function wasTruncated(toolResult: ToolResultMessage): boolean {
	const truncation = details(toolResult)?.truncation;
	return isRecord(truncation) && truncation.truncated === true;
}

export function buildLegacyReadResult(path: string, toolResult: ToolResultMessage, rangeApplied = false) {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildLegacyReadError(path, text || "Read failed");
	const totalLines = totalFileLines(toolResult) ?? (rangeApplied ? 0 : text ? text.split("\n").length : 0);
	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path,
				totalLines,
				fileSize: BigInt(fileSize(toolResult) ?? Buffer.byteLength(text, "utf-8")),
				truncated: wasTruncated(toolResult),
				output: { case: "content", value: text },
				rangeApplied,
			}),
		},
	});
}

export function buildLegacyReadError(path: string, error: string) {
	if (error.startsWith("Path '") && error.endsWith("' not found")) {
		return create(ReadResultSchema, {
			result: { case: "fileNotFound", value: create(ReadFileNotFoundSchema, { path }) },
		});
	}
	return create(ReadResultSchema, {
		result: { case: "error", value: create(ReadErrorSchema, { path, error }) },
	});
}

export function buildLegacyReadRejected(path: string, reason: string) {
	return create(ReadResultSchema, {
		result: { case: "rejected", value: create(ReadRejectedSchema, { path, reason }) },
	});
}
