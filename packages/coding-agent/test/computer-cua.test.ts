import { describe, expect, it } from "bun:test";
import type { ToolResult } from "@trycua/cua-driver";
import {
	CuaComputerController,
	type CuaRuntime,
	CuaSetupError,
	createComputerController,
	resolveCuaPlatformPackage,
} from "../src/tools/computer/cua-controller";
import type { ComputerCapture, ComputerController } from "../src/tools/computer/supervisor";

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
		const controller = new CuaComputerController(async () => runtime);

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
		const controller = new CuaComputerController(async () => runtime);

		const error = await controller.execute([{ type: "screenshot" }]).catch(cause => cause);
		expect(error).toBeInstanceOf(CuaSetupError);
		expect(calls).toEqual(["shutdown", "destroy"]);
	});

	it("does not fall back when CUA is explicitly selected", async () => {
		let nativeCreated = false;
		const controller = createComputerController(
			{ backend: "cua" },
			() => new CuaComputerController(async () => Promise.reject(new Error("missing runtime"))),
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
		const controller = new CuaComputerController(async () => runtime);
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
		const controller = new CuaComputerController(async () => runtime, { setupMs: 50, teardownMs: 5 });
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
		const controller = new CuaComputerController(async () => runtime, { setupMs: 5_000, teardownMs: 5 });

		const error = await controller.execute([{ type: "screenshot" }], abort.signal).catch(cause => cause);

		expect(error).toMatchObject({ name: "ToolAbortError" });
		expect(error).not.toBeInstanceOf(CuaSetupError);
	});
});
