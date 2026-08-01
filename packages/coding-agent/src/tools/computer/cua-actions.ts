import type { DesktopAction, DesktopDisplay } from "@oh-my-pi/pi-natives";
import type { ToolResult } from "@trycua/cua-driver";
import { resizeImage } from "../../utils/image-resize";
import { ToolError } from "../tool-errors";
import { type CuaDriverClient, CuaSetupError } from "./cua-runtime";
import type { ComputerCapture } from "./supervisor";

export type CuaTargetWindow = {
	pid: number;
	windowId: number;
	width: number;
	height: number;
	scale: number;
};

type StructuredRecord = Record<string, unknown>;

/**
 * Pixels per scroll line. The `computer` schema documents scroll deltas in
 * pixels, but the daemon's `ScrollBy` is `Line | Page`, so a raw pixel delta
 * would scroll by that many lines.
 */
const SCROLL_PIXELS_PER_LINE = 40;

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
	caps?: { maxWidth?: number; maxHeight?: number },
): Promise<ComputerCapture> {
	const result = await driver.callTool(
		"get_window_state",
		JSON.stringify({ session: sessionId, pid: target.pid, window_id: target.windowId }),
		signal ? { signal } : undefined,
	);
	if (result.isError) throw new ToolError(result.text || result.errorCode || "CUA operation failed");
	const image = result.images[0];
	if (!image) throw new ToolError("CUA window state returned no screenshot");
	let data = Buffer.from(image.dataBase64, "base64");
	const metadata = await new Bun.Image(data).metadata();
	let width = metadata.width ?? 0;
	let height = metadata.height ?? 0;
	let mimeType: string | undefined;
	// The target is cached across captures, so a stale ratio from an earlier
	// downscale would keep expanding coordinates once the window shrinks.
	target.scale = 1;
	// The daemon returns the window at native resolution and clicks in that same
	// pixel space. Transports that silently downscale a large frame would leave
	// the model reasoning in one space and the daemon acting in another, so cap
	// the frame ourselves and record the ratio for `performCuaAction` to undo.
	const maxWidth = caps?.maxWidth;
	const maxHeight = caps?.maxHeight;
	if (width > 0 && height > 0 && ((maxWidth && width > maxWidth) || (maxHeight && height > maxHeight))) {
		const resized = await resizeImage(
			{ type: "image", data: data.toBase64(), mimeType: "image/png" },
			{ maxWidth, maxHeight },
		);
		if (resized.wasResized && resized.width > 0) {
			target.scale = resized.width / resized.originalWidth;
			data = Buffer.from(resized.buffer);
			width = resized.width;
			height = resized.height;
			mimeType = resized.mimeType;
		}
	}
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
		...(mimeType ? { mimeType } : {}),
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
	const listWindows = async (pid: number | undefined): Promise<StructuredRecord[]> =>
		resultRecords(
			await driver.callTool(
				"list_windows",
				JSON.stringify(pid === undefined ? { session: sessionId } : { session: sessionId, pid }),
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
	let windows = await listWindows(frontmostPid);
	let pidForWindow = frontmostPid;
	if (windows.length === 0 && frontmostPid !== undefined) {
		// A windowless frontmost app (menu-bar item, everything minimised) must not
		// strand the whole session: the desktop is still capturable, so fall back
		// to the topmost window of any app.
		windows = await listWindows(undefined);
		pidForWindow = undefined;
	}
	const selected = windows[0];
	const windowId = selected ? numberField(selected, "window_id", "id") : undefined;
	const pid = pidForWindow ?? (selected ? numberField(selected, "pid", "process_id") : undefined);
	if (pid === undefined || windowId === undefined) {
		// `CuaSetupError`, not `ToolError`: this is the daemon being unusable for
		// this session, which is exactly what `auto` falls back to native on.
		throw new CuaSetupError("CUA found no visible window to target");
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
	// The model reasons over the (possibly downscaled) frame; the daemon acts in
	// native window pixels. Every outgoing coordinate is converted back.
	const toDaemon = (value: number | undefined): number | undefined =>
		value === undefined ? undefined : Math.round(value / (target.scale || 1));
	let name: string;
	let args: StructuredRecord;
	switch (action.type) {
		case "click":
		case "double_click":
			name = action.button === "right" ? "right_click" : "click";
			args = {
				...base,
				x: toDaemon(action.x),
				y: toDaemon(action.y),
				count: action.type === "double_click" ? 2 : 1,
				modifier: action.keys,
			};
			break;
		case "drag": {
			const first = action.path?.[0];
			const last = action.path?.at(-1);
			if (!first || !last) throw new ToolError("CUA drag requires a path");
			name = "drag";
			args = {
				...base,
				from_x: toDaemon(first.x),
				from_y: toDaemon(first.y),
				to_x: toDaemon(last.x),
				to_y: toDaemon(last.y),
				modifier: action.keys,
			};
			break;
		}
		case "keypress": {
			// A single entry may itself be a chord ("CTRL+A"): the tool schema
			// accepts that form and the native backend splits it. Sending it as a
			// literal key name is not a key the daemon knows.
			const keys = (action.keys ?? []).flatMap(entry =>
				entry
					.split("+")
					.map(part => part.trim())
					.filter(Boolean),
			);
			name = keys.length > 1 ? "hotkey" : "press_key";
			args = keys.length > 1 ? { ...base, keys } : { ...base, key: keys[0] ?? "" };
			break;
		}
		case "move":
			name = "move_cursor";
			args = { ...base, x: toDaemon(action.x), y: toDaemon(action.y) };
			break;
		case "scroll": {
			const vertical = Math.abs(action.scroll_y ?? 0) >= Math.abs(action.scroll_x ?? 0);
			const delta = vertical ? (action.scroll_y ?? 0) : (action.scroll_x ?? 0);
			name = "scroll";
			args = {
				...base,
				x: toDaemon(action.x),
				y: toDaemon(action.y),
				direction: vertical ? (delta >= 0 ? "down" : "up") : delta >= 0 ? "right" : "left",
				// The schema documents pixels; the daemon counts lines or pages.
				// Sending pixels as lines overscrolls by an order of magnitude.
				amount: Math.max(1, Math.round(Math.abs(delta) / SCROLL_PIXELS_PER_LINE)),
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
