import type { DesktopAction, DesktopDisplay } from "@oh-my-pi/pi-natives";
import type { ToolResult } from "@trycua/cua-driver";
import { ToolError } from "../tool-errors";
import type { CuaDriverClient } from "./cua-runtime";
import type { ComputerCapture } from "./supervisor";

export type CuaTargetWindow = {
	pid: number;
	windowId: number;
	width: number;
	height: number;
	scale: number;
};

type StructuredRecord = Record<string, unknown>;

function record(value: unknown): StructuredRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as StructuredRecord)
		: undefined;
}

function records(value: unknown): StructuredRecord[] {
	if (!Array.isArray(value)) return [];
	const output: StructuredRecord[] = [];
	for (const item of value) {
		const parsed = record(item);
		if (parsed) output.push(parsed);
	}
	return output;
}

function numberField(value: StructuredRecord, ...keys: string[]): number | undefined {
	for (const key of keys) if (typeof value[key] === "number") return value[key];
	return undefined;
}

function booleanField(value: StructuredRecord, ...keys: string[]): boolean {
	return keys.some(key => value[key] === true);
}

function notFalseField(value: StructuredRecord, ...keys: string[]): boolean {
	return !keys.some(key => value[key] === false);
}

function hasUsableBounds(value: StructuredRecord): boolean {
	const bounds = record(value.bounds);
	return !!bounds && (numberField(bounds, "width") ?? 0) > 1 && (numberField(bounds, "height") ?? 0) > 1;
}

function parseStructured(result: ToolResult): unknown {
	for (const candidate of [result.structuredJson, result.rawJson, result.text]) {
		if (!candidate) continue;
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed !== null && typeof parsed === "object") return parsed;
		} catch {
			// Human-readable text is allowed when structured output is absent.
		}
	}
	return {};
}

function resultRecords(result: ToolResult, key: string): StructuredRecord[] {
	const parsed = parseStructured(result);
	if (Array.isArray(parsed)) return records(parsed);
	const root = record(parsed);
	return root ? records(root[key] ?? root.data) : [];
}

export async function captureCuaWindow(
	driver: CuaDriverClient,
	sessionId: string,
	target: CuaTargetWindow,
	signal?: AbortSignal,
): Promise<ComputerCapture> {
	const result = await driver.callTool(
		"get_window_state",
		JSON.stringify({ session: sessionId, pid: target.pid, window_id: target.windowId }),
		signal ? { signal } : undefined,
	);
	if (result.isError) throw new ToolError(result.text || result.errorCode || "CUA operation failed");
	const image = result.images[0];
	if (!image) throw new ToolError("CUA window state returned no screenshot");
	const data = Buffer.from(image.dataBase64, "base64");
	const metadata = await new Bun.Image(data).metadata();
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	target.width = width;
	target.height = height;
	const display: DesktopDisplay = {
		id: "cua-window",
		name: "CUA window",
		x: 0,
		y: 0,
		width,
		height,
		scale: target.scale,
		pixelX: 0,
		pixelY: 0,
		pixelWidth: width,
		pixelHeight: height,
		isPrimary: true,
	};
	return {
		data,
		width,
		height,
		displays: [display],
		backend: "cua",
		displayServer: "cua-driver daemon",
		capturePermission: "granted",
		inputPermission: "granted",
		contextText: result.text || undefined,
		structuredJson: result.structuredJson || result.rawJson || undefined,
	};
}

export async function selectCuaTarget(
	driver: CuaDriverClient,
	sessionId: string,
	signal?: AbortSignal,
): Promise<CuaTargetWindow> {
	const options = signal ? { signal } : undefined;
	const apps = resultRecords(
		await driver.callTool("list_apps", JSON.stringify({ session: sessionId }), options),
		"apps",
	);
	const frontmost = apps.find(app => booleanField(app, "frontmost", "is_frontmost", "active"));
	const frontmostPid = frontmost ? numberField(frontmost, "pid", "process_id") : undefined;
	const windows = resultRecords(
		await driver.callTool(
			"list_windows",
			JSON.stringify(
				frontmostPid === undefined ? { session: sessionId } : { session: sessionId, pid: frontmostPid },
			),
			options,
		),
		"windows",
	)
		.filter(
			window =>
				booleanField(window, "is_on_screen", "on_screen") &&
				notFalseField(window, "on_current_space", "is_on_current_space") &&
				hasUsableBounds(window),
		)
		.sort((left, right) => {
			const z =
				(numberField(left, "z_index") ?? Number.MAX_SAFE_INTEGER) -
				(numberField(right, "z_index") ?? Number.MAX_SAFE_INTEGER);
			if (z !== 0) return z;
			const leftBounds = record(left.bounds) ?? {};
			const rightBounds = record(right.bounds) ?? {};
			return (
				(numberField(rightBounds, "width") ?? 0) * (numberField(rightBounds, "height") ?? 0) -
				(numberField(leftBounds, "width") ?? 0) * (numberField(leftBounds, "height") ?? 0)
			);
		});
	const selected = windows[0];
	const windowId = selected ? numberField(selected, "window_id", "id") : undefined;
	const pid = frontmostPid ?? (selected ? numberField(selected, "pid", "process_id") : undefined);
	if (pid === undefined || windowId === undefined) {
		throw new ToolError("CUA found no visible window for the frontmost application");
	}
	return { pid, windowId, width: 0, height: 0, scale: 1 };
}

export async function performCuaAction(
	driver: CuaDriverClient,
	sessionId: string,
	target: CuaTargetWindow,
	action: DesktopAction,
	signal?: AbortSignal,
): Promise<void> {
	const base = { session: sessionId, pid: target.pid, window_id: target.windowId };
	let name: string;
	let args: StructuredRecord;
	switch (action.type) {
		case "click":
		case "double_click":
			name = action.button === "right" ? "right_click" : "click";
			args = {
				...base,
				x: action.x,
				y: action.y,
				count: action.type === "double_click" ? 2 : 1,
				modifier: action.keys,
			};
			break;
		case "drag": {
			const first = action.path?.[0];
			const last = action.path?.at(-1);
			if (!first || !last) throw new ToolError("CUA drag requires a path");
			name = "drag";
			args = { ...base, from_x: first.x, from_y: first.y, to_x: last.x, to_y: last.y, modifier: action.keys };
			break;
		}
		case "keypress":
			name = (action.keys?.length ?? 0) > 1 ? "hotkey" : "press_key";
			args = name === "hotkey" ? { ...base, keys: action.keys } : { ...base, key: action.keys?.[0] ?? "" };
			break;
		case "move":
			name = "move_cursor";
			args = { ...base, x: action.x, y: action.y };
			break;
		case "scroll": {
			const vertical = Math.abs(action.scroll_y ?? 0) >= Math.abs(action.scroll_x ?? 0);
			const delta = vertical ? (action.scroll_y ?? 0) : (action.scroll_x ?? 0);
			name = "scroll";
			args = {
				...base,
				x: action.x,
				y: action.y,
				direction: vertical ? (delta >= 0 ? "down" : "up") : delta >= 0 ? "right" : "left",
				amount: Math.abs(delta),
				by: "line",
			};
			break;
		}
		case "type":
			name = "type_text";
			args = { ...base, text: action.text };
			break;
		default:
			return;
	}
	const result = await driver.callTool(name, JSON.stringify(args), signal ? { signal } : undefined);
	if (result.isError) throw new ToolError(result.text || result.errorCode || `CUA ${name} failed`);
}
