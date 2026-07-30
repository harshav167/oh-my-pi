import type { DesktopAction, DesktopCapabilities, DesktopSessionOptions } from "@oh-my-pi/pi-natives";
import { ToolAbortError, ToolError } from "../tool-errors";
import { type CuaTargetWindow, captureCuaWindow, performCuaAction, selectCuaTarget } from "./cua-actions";
import { type CuaDriverClient, type CuaRuntimeLoader, CuaSetupError, loadCuaRuntime } from "./cua-runtime";
import { type ComputerCapture, type ComputerController, ComputerSupervisor } from "./supervisor";

export * from "./cua-runtime";

const WAIT_ACTION_MS = 2_000;

/**
 * Deadline for each graceful CUA teardown call.
 *
 * A daemon that accepted a session but stopped answering is exactly when
 * teardown matters: the native fallback waits on this close, so an unbounded
 * await here would block the recovery it exists to enable. Mirrors the native
 * supervisor's bounded close.
 */
const DEFAULT_TIMEOUTS: CuaControllerTimeouts = { setupMs: 10_000, teardownMs: 1_500 };

/** Deadlines for the daemon handshake and for releasing a driver handle. */
export interface CuaControllerTimeouts {
	/** Bounds `metadata`/`startSession` so a mute daemon still reaches fallback. */
	readonly setupMs: number;
	/** Bounds each graceful teardown call before the handle is released anyway. */
	readonly teardownMs: number;
}

/**
 * Runs one teardown call under its own abort deadline.
 *
 * Per-call, not per-disposal: a shared controller that already fired would hand
 * `shutdown` a signal that is aborted before it starts, and an SDK which only
 * subscribes to future abort events would then never settle.
 */
async function boundedTeardownCall(timeoutMs: number, call: (options: { signal: AbortSignal }) => Promise<unknown>) {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new ToolError("CUA teardown timed out")), timeoutMs);
	try {
		await call({ signal: deadline.signal });
	} catch {
		// Best-effort: the handle release by the caller is what must not be skipped.
	} finally {
		clearTimeout(timer);
	}
}

async function disposeCuaDriver(driver: CuaDriverClient, timeoutMs: number, sessionId?: string): Promise<void> {
	// Deadlines arrive as aborts and every call is awaited, so no native work is
	// still in flight when the handle is destroyed. A `withTimeout` race would
	// abandon the promise and let a late completion touch freed memory.
	try {
		if (sessionId !== undefined) {
			await boundedTeardownCall(timeoutMs, options => driver.endSession({ session: sessionId }, options));
		}
		await boundedTeardownCall(timeoutMs, options => driver.shutdown(options));
	} finally {
		driver.uniffiDestroy();
	}
}

async function waitForComputerAction(signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(WAIT_ACTION_MS);
		return;
	}
	if (signal.aborted) throw new ToolAbortError();
	const aborted = Promise.withResolvers<void>();
	const onAbort = (): void => aborted.reject(new ToolAbortError());
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([Bun.sleep(WAIT_ACTION_MS), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export class CuaComputerController implements ComputerController {
	#driver: CuaDriverClient | undefined;
	#target: CuaTargetWindow | undefined;
	readonly #sessionId = `omp-${crypto.randomUUID()}`;
	#startPromise: Promise<void> | undefined;
	#closed = false;
	readonly #loadRuntime: CuaRuntimeLoader;
	readonly #timeouts: CuaControllerTimeouts;
	capabilities: DesktopCapabilities | undefined;

	constructor(loadRuntime: CuaRuntimeLoader = loadCuaRuntime, timeouts: Partial<CuaControllerTimeouts> = {}) {
		this.#loadRuntime = loadRuntime;
		this.#timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
	}

	get driver(): CuaDriverClient | undefined {
		return this.#driver;
	}

	execute(actions: DesktopAction[], signal?: AbortSignal): Promise<ComputerCapture> {
		return this.#execute(actions, signal);
	}

	async #execute(actions: DesktopAction[], signal?: AbortSignal): Promise<ComputerCapture> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (signal?.aborted) throw new ToolAbortError();
		await this.#start(signal);
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (!this.#target) this.#target = await selectCuaTarget(this.#driver!, this.#sessionId, signal);
		let capture = await captureCuaWindow(this.#driver!, this.#sessionId, this.#target, signal);
		for (const action of actions) {
			if (action.type === "wait") {
				await waitForComputerAction(signal);
			} else if (action.type !== "screenshot") {
				await performCuaAction(this.#driver!, this.#sessionId, this.#target, action, signal);
			}
			if (action.type !== "screenshot") {
				if (signal?.aborted) throw new ToolAbortError();
				capture = await captureCuaWindow(this.#driver!, this.#sessionId, this.#target, signal);
			}
		}
		this.capabilities = {
			backend: "cua",
			displayServer: "cua-driver daemon",
			capture: true,
			input: true,
			capturePermission: "granted",
			inputPermission: "granted",
			displayCount: 1,
		};
		return capture;
	}

	#start(signal?: AbortSignal): Promise<void> {
		if (this.#startPromise) return this.#startPromise;
		this.#startPromise = this.#connect(signal).catch(error => {
			// A caller abort is the user cancelling, not a broken daemon. Wrapping it
			// as `CuaSetupError` would trip automatic fallback and stickily commit the
			// session to the native backend because someone pressed Escape.
			if (error instanceof ToolAbortError) throw error;
			throw error instanceof CuaSetupError
				? error
				: new CuaSetupError(`CUA daemon setup failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		return this.#startPromise;
	}

	async #connect(signal?: AbortSignal): Promise<void> {
		const runtime = await this.#loadRuntime();
		const driver = runtime.CuaDriver.connect(undefined);
		// The deadline is delivered as an abort, not as a `withTimeout` race:
		// abandoning the promise would leave the native call running against a
		// handle we are about to `uniffiDestroy`. Aborting makes the SDK settle the
		// call, and awaiting it means the FFI work is finished before teardown.
		const deadline = new AbortController();
		const timer = setTimeout(
			() => deadline.abort(new CuaSetupError(`CUA daemon handshake exceeded ${this.#timeouts.setupMs}ms`)),
			this.#timeouts.setupMs,
		);
		const options = { signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal };
		try {
			if (driver.executionMode() !== runtime.DriverExecutionMode.Daemon || !driver.isAvailable()) {
				throw new CuaSetupError("CUA daemon is unavailable or not running in daemon mode");
			}
			await driver.metadata(options);
			await driver.startSession({ session: this.#sessionId, captureScope: runtime.CaptureScope.Auto }, options);
			if (this.#closed) {
				// Closed while connecting: release what we just opened.
				await disposeCuaDriver(driver, this.#timeouts.teardownMs, this.#sessionId);
				return;
			}
			this.#driver = driver;
		} catch (error) {
			// An aborted `startSession` may still have registered the session, so end
			// it by id rather than assuming there is nothing to release.
			await disposeCuaDriver(driver, this.#timeouts.teardownMs, this.#sessionId);
			// Caller abort first: the SDK rejects both cases the same way, and only
			// the deadline means "this daemon is unusable, fall back".
			if (signal?.aborted) throw new ToolAbortError();
			throw deadline.signal.aborted ? (deadline.signal.reason ?? error) : error;
		} finally {
			clearTimeout(timer);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#startPromise?.catch(() => {});
		const driver = this.#driver;
		this.#driver = undefined;
		if (!driver) return;
		await disposeCuaDriver(driver, this.#timeouts.teardownMs, this.#sessionId);
	}
}

/**
 * Builds the controller for a `computer` session.
 *
 * `auto` (the default) prefers the CUA daemon and falls back to the native
 * backend, then **stays** on whatever it picked. Selection is sticky because
 * the fallback closes the CUA controller: re-entering it on the next call
 * raises an ordinary "session is closed" `ToolError`, which is not a
 * `CuaSetupError` and so does not re-trigger fallback — the tool would work
 * once and then fail permanently on any host without a usable daemon.
 */
export function createComputerController(
	options: DesktopSessionOptions,
	createCua: () => ComputerController = () => new CuaComputerController(),
	createNative: (options: DesktopSessionOptions) => ComputerController = nativeOptions =>
		new ComputerSupervisor(nativeOptions),
): ComputerController {
	if (options.backend === "native") return createNative(options);
	if (options.backend === "cua") return createCua();
	const cua = createCua();
	const native = createNative(options);
	/** `undefined` until the first execution resolves which backend serves this session. */
	let selected: ComputerController | undefined;
	return {
		get capabilities() {
			return selected?.capabilities ?? cua.capabilities ?? native.capabilities;
		},
		async execute(actions, signal) {
			if (selected) return selected.execute(actions, signal);
			try {
				const capture = await cua.execute(actions, signal);
				selected = cua;
				return capture;
			} catch (error) {
				if (!(error instanceof CuaSetupError)) throw error;
				// Setup failed, so the daemon is unusable for this session. Commit to
				// native before awaiting the close: a wedged daemon must not delay the
				// fallback, and the bounded teardown runs to completion regardless.
				selected = native;
				await cua.close();
				return native.execute(actions, signal);
			}
		},
		async close() {
			await Promise.allSettled([cua.close(), native.close()]);
		},
	};
}
