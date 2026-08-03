import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepCountResultSchema,
	GrepErrorSchema,
	type GrepFileCount,
	GrepFileCountSchema,
	GrepFileMatchSchema,
	GrepFilesResultSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	type GrepUnionResult,
	GrepUnionResultSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ToolResultMessage } from "../../types";
import { piOutputText } from "./exec-modern";

interface LegacyGrepArgs {
	pattern: string;
	path?: string;
	outputMode?: string;
	offset?: number;
}

export function legacyMutationToolName(toolCallId: string): "write" | "edit" | undefined {
	if (toolCallId.startsWith("Write_") || toolCallId.startsWith("Write:")) return "write";
	if (toolCallId.startsWith("StrReplace_") || toolCallId.startsWith("StrReplace:")) return "edit";
	return undefined;
}

interface ParsedGrepLine {
	line: number;
	content: string;
	isContextLine: boolean;
}

type ParsedGrepFiles = Map<string, ParsedGrepLine[]>;

function detailRecord(toolResult: ToolResultMessage): Record<string, unknown> | undefined {
	const details = toolResult.details;
	return isRecord(details) ? details : undefined;
}

function detailBoolean(toolResult: ToolResultMessage, key: string): boolean {
	const value = detailRecord(toolResult)?.[key];
	return typeof value === "boolean" ? value : false;
}

function detailNumber(toolResult: ToolResultMessage, key: string): number | undefined {
	const value = detailRecord(toolResult)?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function appendMatch(files: ParsedGrepFiles, file: string, match: ParsedGrepLine): void {
	const matches = files.get(file);
	if (matches) matches.push(match);
	else files.set(file, [match]);
}

function cleanGroupedHeader(value: string): string {
	return value
		.trimEnd()
		.replace(/\s+\([^)]*\)\s*$/, "")
		.replace(/#[0-9a-f]+$/i, "");
}

function joinGroupedPath(parent: string | undefined, name: string): string {
	if (!parent || path.isAbsolute(name)) return name;
	return path.join(parent, name);
}

function parseGrepContent(text: string, fallbackFile: string | undefined): ParsedGrepFiles {
	const files: ParsedGrepFiles = new Map();
	const directories = new Map<number, string>();
	let currentFile = fallbackFile;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		const hashlineHeader = /^\[(.+)#[0-9a-f]+\]$/i.exec(line);
		if (hashlineHeader) {
			currentFile = hashlineHeader[1];
			continue;
		}
		const groupedHeader = /^(#+)\s+(.*)$/.exec(line);
		if (groupedHeader) {
			const depth = groupedHeader[1].length;
			const value = cleanGroupedHeader(groupedHeader[2]);
			for (const key of directories.keys()) if (key >= depth) directories.delete(key);
			const parent = depth > 1 ? directories.get(depth - 1) : undefined;
			if (value.endsWith("/")) {
				const directory = joinGroupedPath(parent, value.slice(0, -1));
				directories.set(depth, directory);
				currentFile = undefined;
			} else {
				currentFile = joinGroupedPath(parent, value);
			}
			continue;
		}
		const groupedLine = /^([* ])(\d+)[|:](.*)$/.exec(line);
		if (groupedLine && currentFile) {
			appendMatch(files, currentFile, {
				line: Number(groupedLine[2]),
				content: groupedLine[3],
				isContextLine: groupedLine[1] !== "*",
			});
			continue;
		}
		const matchLine = /^(.+?):(\d+):\s?(.*)$/.exec(line);
		const contextLine = matchLine ? null : /^(.+?)-(\d+)-\s?(.*)$/.exec(line);
		const legacyLine = matchLine ?? contextLine;
		if (legacyLine) {
			appendMatch(files, legacyLine[1], {
				line: Number(legacyLine[2]),
				content: legacyLine[3],
				isContextLine: contextLine !== null,
			});
		}
	}
	return files;
}

function singleDetailFile(toolResult: ToolResultMessage): string | undefined {
	const files = detailRecord(toolResult)?.files;
	return Array.isArray(files) && files.length === 1 && typeof files[0] === "string" ? files[0] : undefined;
}

export function buildLegacyGrepResult(args: LegacyGrepArgs, toolResult: ToolResultMessage) {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildLegacyGrepError(text || "Grep failed");
	const outputMode = args.outputMode || "content";
	const clientTruncated = detailBoolean(toolResult, "truncated");
	const lines = text
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));

	let unionResult: GrepUnionResult;
	if (outputMode === "files_with_matches") {
		const files = lines;
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "files",
				value: create(GrepFilesResultSchema, {
					files,
					totalFiles: files.length,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	} else if (outputMode === "count") {
		const counts: GrepFileCount[] = lines.flatMap(line => {
			const separatorIndex = line.lastIndexOf(":");
			if (separatorIndex < 1) return [];
			const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
			return Number.isNaN(count)
				? []
				: [create(GrepFileCountSchema, { file: line.slice(0, separatorIndex), count })];
		});
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "count",
				value: create(GrepCountResultSchema, {
					counts,
					totalFiles: counts.length,
					totalMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	} else {
		const parsed = parseGrepContent(text, singleDetailFile(toolResult) ?? args.path);
		const parsedMatchCount = Array.from(parsed.values()).reduce(
			(count, matches) => count + matches.filter(match => !match.isContextLine).length,
			0,
		);
		if (text.trim() && (detailNumber(toolResult, "matchCount") ?? 0) > 0 && parsedMatchCount === 0) {
			return buildLegacyGrepError(`Could not decode grep matches from local output:\n${text}`);
		}
		const matches = Array.from(parsed, ([file, entries]) =>
			create(GrepFileMatchSchema, {
				file,
				matches: entries.map(entry =>
					create(GrepContentMatchSchema, {
						lineNumber: entry.line,
						content: entry.content,
						contentTruncated: false,
						isContextLine: entry.isContextLine,
					}),
				),
			}),
		);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "content",
				value: create(GrepContentResultSchema, {
					matches,
					totalLines: Array.from(parsed.values()).reduce((sum, entries) => sum + entries.length, 0),
					totalMatchedLines: parsedMatchCount,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	}
	const workspaceKey = args.path || ".";
	return create(GrepResultSchema, {
		result: {
			case: "success",
			value: create(GrepSuccessSchema, {
				pattern: args.pattern,
				path: args.path || "",
				outputMode,
				workspaceResults: { [workspaceKey]: unionResult },
			}),
		},
	});
}

export function buildLegacyGrepError(error: string) {
	return create(GrepResultSchema, {
		result: { case: "error", value: create(GrepErrorSchema, { error }) },
	});
}
