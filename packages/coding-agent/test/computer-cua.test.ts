import { describe, expect, it } from "bun:test";
import type { ToolResult } from "@trycua/cua-driver";
import { captureCuaWindow, performCuaAction, selectCuaTarget } from "../src/tools/computer/cua-actions";
import {
	CuaComputerController,
	type CuaRuntime,
	CuaSetupError,
	createComputerController,
	resolveCuaPlatformPackage,
} from "../src/tools/computer/cua-controller";
import type { ComputerCapture, ComputerController } from "../src/tools/computer/supervisor";
import { resizeImage } from "../src/utils/image-resize";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function result(structured: unknown, image = false, text = ""): ToolResult {
	return {
		text,
		images: image ? [{ mimeType: "image/png", dataBase64: PNG }] : [],
		structuredJson: JSON.stringify(structured),
		isError: false,
		degraded: false,
		rawJson: "{}",
	};
}

function capture(): ComputerCapture {
	return {
		data: Buffer.from(PNG, "base64"),
		width: 1,
		height: 1,
		displays: [],
		backend: "test",
		capturePermission: "granted",
		inputPermission: "granted",
	};
}

describe("CUA runtime platforms", () => {
	it("uses GNU leaves and leaves Linux musl to the native fallback", () => {
		expect(resolveCuaPlatformPackage("linux", "x64", true)).toBe("@trycua/cua-driver-linux-x64-gnu");
		expect(resolveCuaPlatformPackage("linux", "x64", false)).toBeUndefined();
	});
});

describe("CuaComputerController", () => {
	it("validates daemon mode, snapshots before and after input, and closes in order", async () => {
		const calls: string[] = [];
		const toolArgs: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
		const abort = new AbortController();
		const driver = {
			executionMode: () => 1,
			isAvailable: () => true,
			metadata: async () => ({ driverVersion: "0.12.3" }),
			startSession: async () => {
				calls.push("start");
			},
			callTool: async (name: string, args: string, options?: { signal?: AbortSignal }) => {
				calls.push(name);
				toolArgs.push({ name, args: JSON.parse(args) as Record<string, unknown>, signal: options?.signal });
				switch (name) {
					case "list_apps":
						return result({ apps: [{ pid: 10, active: false }] });
					case "list_windows":
						return result({
							windows: [
								{
									pid: 99,
									window_id: 19,
									is_on_screen: true,
									on_current_space: null,
									z_index: 0,
									bounds: { width: 1, height: 1 },
								},
								{
									pid: 10,
									window_id: 20,
									is_on_screen: true,
									on_current_space: null,
									z_index: 1,
									bounds: { width: 100, height: 100 },
								},
							],
						});
					case "get_window_state":
						return result({ tree_markdown: "[1] Button" }, true, "[1] Button");
					default:
						return result({ effect: "confirmed" });
				}
			},
			endSession: async () => {
				calls.push("end");
				return { session: "test", active: false };
			},
			shutdown: async () => {
				calls.push("shutdown");
			},
			uniffiDestroy: () => calls.push("destroy"),
		};
		const runtime = {
			CuaDriver: { connect: () => driver },
			DriverExecutionMode: { Daemon: 1 },
			CaptureScope: { Auto: 0 },
		} as unknown as CuaRuntime;
		const controller = new CuaComputerController({ backend: "cua" }, async () => runtime);

		const output = await controller.execute([{ type: "click", x: 1, y: 1, button: "left" }], abort.signal);
		expect(calls).toEqual(["start", "list_apps", "list_windows", "get_window_state", "click", "get_window_state"]);
		expect(output.contextText).toBe("[1] Button");
		expect(output.structuredJson).toContain("tree_markdown");
		expect(toolArgs.find(call => call.name === "click")).toMatchObject({
			args: { pid: 10, window_id: 20, x: 1, y: 1, count: 1 },
			signal: abort.signal,
		});
		await controller.close();
		expect(calls.slice(-3)).toEqual(["end", "shutdown", "destroy"]);
	});

	it("destroys an incompatible daemon and surfaces a typed setup error", async () => {
		const calls: string[] = [];
		const driver = {
			executionMode: () => 0,
			isAvailable: () => true,
			metadata: async () => ({}),
			startSession: async () => ({}),
			callTool: async () => result({}),
			endSession: async () => ({ session: "test", active: false }),
			shutdown: async () => {
				calls.push("shutdown");
			},
			uniffiDestroy: () => calls.push("destroy"),
		};
		const runtime = {
			CuaDriver: { connect: () => driver },
			DriverExecutionMode: { Daemon: 1 },
			CaptureScope: { Auto: 0 },
		} as unknown as CuaRuntime;
		const controller = new CuaComputerController({ backend: "cua" }, async () => runtime);

		const error = await controller.execute([{ type: "screenshot" }]).catch(cause => cause);
		expect(error).toBeInstanceOf(CuaSetupError);
		expect(calls).toEqual(["shutdown", "destroy"]);
	});

	it("does not fall back when CUA is explicitly selected", async () => {
		let nativeCreated = false;
		const controller = createComputerController(
			{ backend: "cua" },
			cuaOptions => new CuaComputerController(cuaOptions, async () => Promise.reject(new Error("missing runtime"))),
			() => {
				nativeCreated = true;
				throw new Error("native must not load");
			},
		);

		const error = await controller.execute([{ type: "screenshot" }]).catch(cause => cause);
		expect(error).toBeInstanceOf(CuaSetupError);
		expect(nativeCreated).toBe(false);
	});

	it("aborts an in-flight wait promptly", async () => {
		const driver = {
			executionMode: () => 1,
			isAvailable: () => true,
			metadata: async () => ({}),
			startSession: async () => ({}),
			callTool: async (name: string) => {
				if (name === "list_apps") return result({ apps: [{ pid: 10, frontmost: true }] });
				if (name === "list_windows") {
					return result({
						windows: [
							{
								window_id: 20,
								is_on_screen: true,
								on_current_space: true,
								z_index: 0,
								bounds: { width: 100, height: 100 },
							},
						],
					});
				}
				return result({}, true);
			},
			endSession: async () => ({ session: "test", active: false }),
			shutdown: async () => {},
			uniffiDestroy: () => {},
		};
		const runtime = {
			CuaDriver: { connect: () => driver },
			DriverExecutionMode: { Daemon: 1 },
			CaptureScope: { Auto: 0 },
		} as unknown as CuaRuntime;
		const controller = new CuaComputerController({ backend: "cua" }, async () => runtime);
		const abort = new AbortController();
		const startedAt = performance.now();
		setTimeout(() => abort.abort(), 10);

		const error = await controller.execute([{ type: "wait" }], abort.signal).catch(cause => cause);

		expect(error).toMatchObject({ name: "ToolAbortError" });
		expect(performance.now() - startedAt).toBeLessThan(500);
		await controller.close();
	});

	it("falls back to native only for automatic CUA setup failures", async () => {
		const calls: string[] = [];
		const cua: ComputerController = {
			capabilities: undefined,
			execute: async () => {
				throw new CuaSetupError("daemon unavailable");
			},
			close: async () => {
				calls.push("cua.close");
			},
		};
		const native: ComputerController = {
			capabilities: undefined,
			execute: async () => {
				calls.push("native.execute");
				return capture();
			},
			close: async () => {},
		};
		const controller = createComputerController(
			{ backend: "auto" },
			() => cua,
			() => native,
		);

		await controller.execute([{ type: "screenshot" }]);
		expect(calls).toEqual(["cua.close", "native.execute"]);
	});

	it("stays on native for every later call after one CUA setup failure", async () => {
		// The regression: `execute` used to re-enter the closed CUA controller on
		// the next call, which raises an ordinary "session is closed" ToolError —
		// not a CuaSetupError — so fallback never re-triggered. `auto` is the
		// default backend, so the tool worked once per session and then died.
		const calls: string[] = [];
		let cuaAttempts = 0;
		const cua: ComputerController = {
			capabilities: undefined,
			execute: async () => {
				cuaAttempts += 1;
				throw new CuaSetupError("daemon unavailable");
			},
			close: async () => {
				calls.push("cua.close");
			},
		};
		const native: ComputerController = {
			capabilities: undefined,
			execute: async () => {
				calls.push("native.execute");
				return capture();
			},
			close: async () => {},
		};
		const controller = createComputerController(
			{ backend: "auto" },
			() => cua,
			() => native,
		);

		await controller.execute([{ type: "screenshot" }]);
		await controller.execute([{ type: "screenshot" }]);
		await controller.execute([{ type: "screenshot" }]);

		expect(cuaAttempts).toBe(1);
		expect(calls).toEqual(["cua.close", "native.execute", "native.execute", "native.execute"]);
	});

	it("keeps serving CUA once it has succeeded", async () => {
		let nativeUsed = false;
		const cua: ComputerController = {
			capabilities: undefined,
			execute: async () => capture(),
			close: async () => {},
		};
		const native: ComputerController = {
			capabilities: undefined,
			execute: async () => {
				nativeUsed = true;
				return capture();
			},
			close: async () => {},
		};
		const controller = createComputerController(
			{ backend: "auto" },
			() => cua,
			() => native,
		);

		await controller.execute([{ type: "screenshot" }]);
		await controller.execute([{ type: "screenshot" }]);

		expect(nativeUsed).toBe(false);
	});
	it("bounds teardown so a wedged daemon cannot pin the fallback", async () => {
		// A daemon that accepted the session then stopped answering is exactly when
		// fallback matters. `endSession`/`shutdown` used to be awaited without a
		// deadline, so close() — and the native fallback waiting on it — hung
		// forever. Both are now independently bounded and the handle is always
		// released, so a stuck `endSession` cannot skip `shutdown` either.
		// Honors the abort the production code now sends: a stub that ignored the
		// signal would prove nothing, because the fix is cancellation rather than
		// abandoning the promise.
		const untilAborted = (options?: { signal?: AbortSignal }) => {
			const { promise, reject } = Promise.withResolvers<never>();
			const signal = options?.signal;
			// Already-aborted must reject immediately, exactly as the SDK does: only
			// subscribing to future events is what let a shared deadline leave the
			// second teardown call pending forever.
			if (signal?.aborted) reject(signal.reason);
			else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		};
		const attempted: string[] = [];
		let destroyed = false;
		const runtime = {
			CuaDriver: {
				connect: () => ({
					executionMode: () => 1,
					isAvailable: () => true,
					metadata: async () => ({ driverVersion: "0.12.3" }),
					startSession: async () => {},
					callTool: async () => result({}),
					endSession: (_input: unknown, options?: { signal?: AbortSignal }) => {
						attempted.push("endSession");
						return untilAborted(options);
					},
					shutdown: (options?: { signal?: AbortSignal }) => {
						attempted.push("shutdown");
						return untilAborted(options);
					},
					uniffiDestroy: () => {
						destroyed = true;
					},
				}),
			},
			DriverExecutionMode: { Daemon: 1 },
			CaptureScope: { Auto: 0 },
		} as unknown as CuaRuntime;
		// Small deadlines injected so the suite proves the bounds without sleeping
		// through the production ones.
		const controller = new CuaComputerController({ backend: "cua" }, async () => runtime, {
			setupMs: 50,
			teardownMs: 5,
		});
		await controller.execute([{ type: "screenshot" }]).catch(() => {});

		await controller.close();

		expect(attempted).toEqual(["endSession", "shutdown"]);
		expect(destroyed).toBe(true);
	});
});

describe("CUA setup abort handling", () => {
	it("surfaces a caller abort as an abort, not as a setup failure", async () => {
		// A user pressing Escape during the handshake must not look like a broken
		// daemon: wrapped as CuaSetupError it tripped automatic fallback and stuck
		// the whole session on the native backend.
		const abort = new AbortController();
		const runtime = {
			CuaDriver: {
				connect: () => ({
					executionMode: () => 1,
					isAvailable: () => true,
					metadata: (options?: { signal?: AbortSignal }) => {
						const { promise, reject } = Promise.withResolvers<never>();
						const signal = options?.signal;
						if (signal?.aborted) reject(signal.reason);
						else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
						abort.abort();
						return promise;
					},
					endSession: async () => {},
					shutdown: async () => {},
					uniffiDestroy: () => {},
				}),
			},
			DriverExecutionMode: { Daemon: 1 },
			CaptureScope: { Auto: 0 },
		} as unknown as CuaRuntime;
		const controller = new CuaComputerController({ backend: "cua" }, async () => runtime, {
			setupMs: 5_000,
			teardownMs: 5,
		});

		const error = await controller.execute([{ type: "screenshot" }], abort.signal).catch(cause => cause);

		expect(error).toMatchObject({ name: "ToolAbortError" });
		expect(error).not.toBeInstanceOf(CuaSetupError);
	});
});

describe("CUA action wire contract", () => {
	function recordingDriver(sent: Array<{ name: string; args: Record<string, unknown> }>) {
		return {
			callTool: async (name: string, args: string) => {
				sent.push({ name, args: JSON.parse(args) as Record<string, unknown> });
				return result({ effect: "confirmed" });
			},
		} as unknown as Parameters<typeof performCuaAction>[0];
	}

	// The model reasons over a downscaled frame while the daemon clicks in native
	// window pixels. Without the inverse mapping every pointer action lands at
	// the wrong offset on retina windows.
	it("converts model coordinates back into native daemon pixels", async () => {
		const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
		const target = { pid: 1, windowId: 2, width: 640, height: 480, scale: 0.5 };
		await performCuaAction(recordingDriver(sent), "s", target, { type: "click", x: 100, y: 60, button: "left" });
		await performCuaAction(recordingDriver(sent), "s", target, { type: "move", x: 10, y: 20 });
		await performCuaAction(recordingDriver(sent), "s", target, {
			type: "drag",
			path: [
				{ x: 4, y: 6 },
				{ x: 8, y: 10 },
			],
		});

		expect(sent[0]).toMatchObject({ name: "click", args: { x: 200, y: 120 } });
		expect(sent[1]).toMatchObject({ name: "move_cursor", args: { x: 20, y: 40 } });
		expect(sent[2]).toMatchObject({ name: "drag", args: { from_x: 8, from_y: 12, to_x: 16, to_y: 20 } });
	});

	it("leaves coordinates untouched when the frame was not downscaled", async () => {
		const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
		const target = { pid: 1, windowId: 2, width: 640, height: 480, scale: 1 };
		await performCuaAction(recordingDriver(sent), "s", target, { type: "click", x: 100, y: 60, button: "left" });
		expect(sent[0]).toMatchObject({ args: { x: 100, y: 60 } });
	});

	// The tool schema documents pixels; `ScrollBy` is Line | Page. Sending a raw
	// pixel delta as a line count overscrolls by an order of magnitude.
	it("converts a pixel scroll delta into a line count, never below one line", async () => {
		const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
		const target = { pid: 1, windowId: 2, width: 640, height: 480, scale: 1 };
		await performCuaAction(recordingDriver(sent), "s", target, {
			type: "scroll",
			x: 5,
			y: 5,
			scroll_x: 0,
			scroll_y: 400,
		});
		await performCuaAction(recordingDriver(sent), "s", target, {
			type: "scroll",
			x: 5,
			y: 5,
			scroll_x: 0,
			scroll_y: 3,
		});

		expect(sent[0]).toMatchObject({ name: "scroll", args: { direction: "down", amount: 10, by: "line" } });
		expect(sent[1]?.args.amount).toBe(1);
	});

	// The schema accepts a chord in one entry and the native backend splits it;
	// sending "CTRL+A" as a key name is not a key the daemon knows.
	it("splits a single-entry chord into a hotkey", async () => {
		const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
		const target = { pid: 1, windowId: 2, width: 640, height: 480, scale: 1 };
		await performCuaAction(recordingDriver(sent), "s", target, { type: "keypress", keys: ["CTRL+A"] });
		await performCuaAction(recordingDriver(sent), "s", target, { type: "keypress", keys: ["ENTER"] });

		expect(sent[0]).toMatchObject({ name: "hotkey", args: { keys: ["CTRL", "A"] } });
		expect(sent[1]).toMatchObject({ name: "press_key", args: { key: "ENTER" } });
	});
});

describe("CUA target selection", () => {
	function windowListDriver(byPid: Record<string, unknown>, unfiltered: unknown) {
		return {
			callTool: async (name: string, args: string) => {
				if (name === "list_apps") return result({ apps: [{ pid: 7, active: true }] });
				const parsed = JSON.parse(args) as { pid?: number };
				return result(parsed.pid === undefined ? unfiltered : byPid);
			},
		} as unknown as Parameters<typeof selectCuaTarget>[0];
	}

	const usable = {
		windows: [
			{
				pid: 42,
				window_id: 7,
				is_on_screen: true,
				on_current_space: true,
				z_index: 0,
				bounds: { width: 80, height: 60 },
			},
		],
	};

	// A frontmost menu-bar app owns no on-screen window, but the desktop is still
	// capturable; hard-failing there stranded every computer call.
	it("falls back to any visible window when the frontmost app has none", async () => {
		const target = await selectCuaTarget(windowListDriver({ windows: [] }, usable), "s");
		expect(target).toMatchObject({ pid: 42, windowId: 7, scale: 1 });
	});

	// CuaSetupError, not ToolError: only the former re-triggers `auto` fallback.
	it("raises a setup error when no window exists at all, so auto can fall back", async () => {
		const error = await selectCuaTarget(windowListDriver({ windows: [] }, { windows: [] }), "s").catch(
			cause => cause,
		);
		expect(error).toBeInstanceOf(CuaSetupError);
	});
});

describe("CUA start memoization", () => {
	// A rejected #startPromise used to be cached forever: Escape during the
	// handshake, or one transient daemon outage, re-threw the same error for the
	// rest of the session even though the daemon had recovered.
	it("retries after a failed handshake instead of caching the rejection", async () => {
		const calls: string[] = [];
		const driver = {
			executionMode: () => 1,
			isAvailable: () => true,
			metadata: async () => ({ driverVersion: "0.12.3" }),
			startSession: async () => {
				calls.push("start");
			},
			callTool: async (name: string) => {
				calls.push(name);
				switch (name) {
					case "list_apps":
						return result({ apps: [{ pid: 10, active: true }] });
					case "list_windows":
						return result({
							windows: [
								{
									pid: 10,
									window_id: 20,
									is_on_screen: true,
									on_current_space: true,
									z_index: 0,
									bounds: { width: 10, height: 10 },
								},
							],
						});
					default:
						return result({ tree_markdown: "ok" }, true, "ok");
				}
			},
			endSession: async () => ({ session: "test", active: false }),
			shutdown: async () => {},
			uniffiDestroy: () => {},
		};
		const runtime = {
			CuaDriver: { connect: () => driver },
			DriverExecutionMode: { Daemon: 1 },
			CaptureScope: { Auto: 0 },
		} as unknown as CuaRuntime;
		let attempt = 0;
		const controller = new CuaComputerController({ backend: "cua" }, async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("daemon is down");
			return runtime;
		});

		const first = await controller.execute([{ type: "screenshot" }]).catch(cause => cause);
		expect(first).toBeInstanceOf(CuaSetupError);

		const second = await controller.execute([{ type: "screenshot" }]);
		expect(attempt).toBe(2);
		expect(second.backend).toBe("cua");
		expect(calls).toContain("get_window_state");
	});
});

describe("CUA capture sizing", () => {
	// Transports that silently downscale a large frame leave the model reasoning
	// in one pixel space while the daemon acts in another. The capture caps the
	// frame itself and records the ratio so actions can be mapped back.
	async function oversizedPng(edge: number): Promise<string> {
		const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const grown = await resizeImage(
			{ type: "image", data: tiny, mimeType: "image/png" },
			{ maxWidth: edge, maxHeight: edge, minDimension: edge, maxBytes: 50 * 1024 * 1024, excludeWebP: true },
		);
		return Buffer.from(grown.buffer).toBase64();
	}

	function captureDriver(dataBase64: string) {
		return {
			callTool: async () => ({
				text: "",
				images: [{ mimeType: "image/png", dataBase64 }],
				structuredJson: "{}",
				isError: false,
				degraded: false,
				rawJson: "{}",
			}),
		} as unknown as Parameters<typeof captureCuaWindow>[0];
	}

	it("caps an oversized frame, records the ratio, and reports decodable bytes", async () => {
		const native = 2000;
		const target = { pid: 1, windowId: 2, width: 0, height: 0, scale: 1 };
		const capture = await captureCuaWindow(captureDriver(await oversizedPng(native)), "s", target, undefined, {
			maxWidth: 1280,
			maxHeight: 896,
		});

		expect(capture.width).toBeLessThanOrEqual(1280);
		expect(capture.height).toBeLessThanOrEqual(896);
		expect(target.scale).toBeCloseTo(capture.width / native, 5);
		expect(target.scale).toBeLessThan(1);
		// The consumer labels the image with `capture.mimeType`, so the bytes must
		// actually be that format and decode to the reported dimensions.
		const decoded = await new Bun.Image(Buffer.from(capture.data)).metadata();
		expect(decoded.width).toBe(capture.width);
		expect(capture.mimeType).toBe(`image/${decoded.format}`);

		// A click at the centre of what the model saw lands at the centre natively.
		const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
		const recorder = {
			callTool: async (name: string, args: string) => {
				sent.push({ name, args: JSON.parse(args) as Record<string, unknown> });
				return result({ effect: "confirmed" });
			},
		} as unknown as Parameters<typeof performCuaAction>[0];
		const centre = Math.round(capture.width / 2);
		await performCuaAction(recorder, "s", target, { type: "click", x: centre, y: centre, button: "left" });
		expect(sent[0]?.args.x).toBeGreaterThan(capture.width);
		expect(sent[0]?.args.x).toBeCloseTo(native / 2, -1);
	});

	it("leaves a frame within the caps untouched at scale 1", async () => {
		const target = { pid: 1, windowId: 2, width: 0, height: 0, scale: 0.25 };
		const capture = await captureCuaWindow(captureDriver(await oversizedPng(320)), "s", target, undefined, {
			maxWidth: 1280,
			maxHeight: 896,
		});

		expect(capture.width).toBe(320);
		// A stale ratio from an earlier downscale must not survive into this frame.
		expect(target.scale).toBe(1);
		expect(capture.mimeType).toBeUndefined();
	});
});
