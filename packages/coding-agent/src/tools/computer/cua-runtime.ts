import { createRequire } from "node:module";
import * as path from "node:path";
import {
	ensureRuntimeInstalled,
	getTinyModelsCacheDir,
	isCompiledBinary,
	logger,
	resolveRuntimeModule,
} from "@oh-my-pi/pi-utils";
import type { CaptureScope, CuaDriver, CuaDriverLike, DriverExecutionMode } from "@trycua/cua-driver";
import { ToolError } from "../tool-errors";
import { CUA_COMPANION_PINS, CUA_PACKAGE, CUA_RUNTIME_DEPENDENCIES } from "./cua-packages";

const sourceRequire = createRequire(import.meta.url);
/** Deadline for the smoke handshake; a live daemon answers in milliseconds. */
const SMOKE_METADATA_TIMEOUT_MS = 5_000;
/** Own package name, used to find our manifest from either layout. */
const OWN_PACKAGE = "@oh-my-pi/pi-coding-agent";

let cachedVersion: string | undefined;

/**
 * Pinned driver version, from the one declaration that governs it.
 *
 * `packages/coding-agent/package.json` pins `@trycua/cua-driver` exactly, and
 * everything derives from that: compiled binaries bake it in as
 * `PI_CUA_DRIVER_VERSION`, source and npm runs read the declaration back out.
 * The driver's own manifest is deliberately NOT consulted — its `exports` map
 * omits `./package.json`, so that path only resolves under a lenient resolver.
 *
 * Resolved lazily and memoized: a module-level `const` would sit in
 * `sourceRequire`'s temporal dead zone and make importing this file throw.
 */
function cuaVersion(): string {
	if (cachedVersion) return cachedVersion;
	const baked = process.env.PI_CUA_DRIVER_VERSION;
	if (baked) {
		cachedVersion = baked;
		return cachedVersion;
	}
	// `src/tools/computer/` when running from source, `dist/` in the npm bundle,
	// so walk up rather than assuming a fixed depth.
	let dir = import.meta.dir;
	for (let depth = 0; depth < 6; depth++) {
		const candidate = path.join(dir, "package.json");
		try {
			const manifest = sourceRequire(candidate) as { name?: string; dependencies?: Record<string, string> };
			const declared = manifest.name === OWN_PACKAGE ? manifest.dependencies?.[CUA_PACKAGE] : undefined;
			if (declared) {
				cachedVersion = declared;
				return cachedVersion;
			}
		} catch {
			// No manifest at this level; keep walking.
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new ToolError(`Could not resolve the pinned ${CUA_PACKAGE} version from ${OWN_PACKAGE}'s package.json`);
}

export type CuaDriverClient = CuaDriverLike & Pick<CuaDriver, "uniffiDestroy">;
export type CuaRuntime = {
	CuaDriver: { connect(socketPath: string | undefined): CuaDriverClient };
	DriverExecutionMode: typeof DriverExecutionMode;
	CaptureScope: typeof CaptureScope;
};
export type CuaRuntimeLoader = () => Promise<CuaRuntime>;

export class CuaSetupError extends ToolError {
	override name = "CuaSetupError";
}

function isGlibcRuntime(): boolean {
	const report = process.report?.getReport();
	if (!report || !("header" in report)) return false;
	const header = report.header;
	return (
		header !== null &&
		typeof header === "object" &&
		"glibcVersionRuntime" in header &&
		typeof header.glibcVersionRuntime === "string"
	);
}

export function resolveCuaPlatformPackage(platform: string, arch: string, glibc = true): string | undefined {
	if (platform === "linux" && !glibc) return undefined;
	return CUA_RUNTIME_DEPENDENCIES[`${platform}-${arch}`];
}

function platformPackage(): string {
	const glibc = process.platform !== "linux" || isGlibcRuntime();
	const packageName = resolveCuaPlatformPackage(process.platform, process.arch, glibc);
	if (!packageName && process.platform === "linux" && !glibc) {
		throw new CuaSetupError("CUA has no native runtime for Linux musl");
	}
	if (!packageName) throw new CuaSetupError(`CUA does not support ${process.platform}-${process.arch}`);
	return packageName;
}

function requireCuaRuntime(nodeModules: string): CuaRuntime | undefined {
	const entry = resolveRuntimeModule(nodeModules, CUA_PACKAGE);
	return entry ? (createRequire(entry)(entry) as CuaRuntime) : undefined;
}
async function requireBundledCuaRuntime(runtimeDir: string): Promise<CuaRuntime> {
	const bundlePath = path.join(runtimeDir, "cua-runtime.cjs");
	if (!(await Bun.file(bundlePath).exists())) {
		const nodeModules = path.join(runtimeDir, "node_modules");
		const entry = resolveRuntimeModule(nodeModules, CUA_PACKAGE);
		if (!entry) throw new CuaSetupError(`Unable to resolve ${CUA_PACKAGE} in ${runtimeDir}`);
		const output = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			format: "cjs",
			minify: true,
		});
		const artifact = output.outputs[0];
		if (!output.success || !artifact) {
			throw new CuaSetupError(`Unable to prepare ${CUA_PACKAGE}: ${output.logs.join("\n")}`);
		}
		await Bun.write(bundlePath, artifact);
	}
	return createRequire(bundlePath)(bundlePath) as CuaRuntime;
}

export async function loadCuaRuntime(): Promise<CuaRuntime> {
	if (!isCompiledBinary()) {
		for (const nodeModules of sourceRequire.resolve.paths(CUA_PACKAGE) ?? []) {
			const runtime = requireCuaRuntime(nodeModules);
			if (runtime) return runtime;
		}
		throw new CuaSetupError(`Unable to resolve ${CUA_PACKAGE}`);
	}
	const nativePackage = platformPackage();
	const version = cuaVersion();
	const key = `${version}-${nativePackage}`.replace(/[^A-Za-z0-9._-]/g, "_");
	const runtimeDir = path.join(path.dirname(getTinyModelsCacheDir()), "cua-runtime", key);
	await ensureRuntimeInstalled({
		runtimeDir,
		install: {
			dependencies: {
				[CUA_PACKAGE]: version,
				[nativePackage]: version,
				...CUA_COMPANION_PINS,
			},
		},
		probePackage: nativePackage,
	});
	return requireBundledCuaRuntime(runtimeDir);
}

/**
 * Distribution smoke: prove the pinned SDK, its host native leaf, and the
 * daemon handshake all work in *this* build shape.
 *
 * Exercises the same surface `CuaComputerController.#connect` depends on —
 * `connect`, `executionMode`, `metadata` — and validates the contract fields
 * rather than mere truthiness, then releases the handle. A `typeof` check on
 * `connect` would pass on a build whose native leaf is missing or whose daemon
 * never answers, which is precisely what this gate exists to catch for compiled
 * binaries and tarball installs.
 *
 * `CuaDriver.app` is a separate user install, so by default a driver that is
 * absent or not in daemon mode is reported and skipped — the smoke runs in CI
 * and install tests on hosts that have no daemon. Set `PI_CUA_SMOKE_STRICT=1`
 * on a gate that genuinely provisions one to make those cases fatal. A daemon
 * that answers *incorrectly* always fails, strict or not.
 */
export async function smokeTestCuaRuntime(): Promise<void> {
	if (process.platform === "linux" && !isGlibcRuntime()) return;
	const strict = process.env.PI_CUA_SMOKE_STRICT === "1";
	const skip = (reason: string): void => {
		if (strict) throw new Error(`CUA runtime smoke failed: ${reason}`);
		logger.debug("cua smoke skipped", { reason });
	};
	const runtime = await loadCuaRuntime();
	if (typeof runtime.CuaDriver.connect !== "function") {
		throw new Error("CUA runtime smoke failed: CuaDriver.connect is unavailable");
	}
	const driver = runtime.CuaDriver.connect(undefined);
	// Deadline as an abort, not a race: `uniffiDestroy` below must not run while a
	// native call is still live against the handle.
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("CUA metadata timed out")), SMOKE_METADATA_TIMEOUT_MS);
	try {
		// Never silently accept same-process mode: it would run under OMP's own
		// identity and bypass the daemon's permission onboarding.
		if (driver.executionMode() !== runtime.DriverExecutionMode.Daemon) {
			return skip("driver is not in daemon mode");
		}
		if (!driver.isAvailable()) return skip("daemon is not running");
		const metadata = await driver.metadata({ signal: deadline.signal });
		// Contract fields, not truthiness: a daemon that connects but reports an
		// empty contract version or claims embedded mode is a real incompatibility.
		if (!metadata.contractVersion || !metadata.driverVersion) {
			throw new Error("CUA runtime smoke failed: daemon reported no driver/contract version");
		}
		if (metadata.embedded) {
			throw new Error("CUA runtime smoke failed: daemon connection reported embedded mode");
		}
	} finally {
		clearTimeout(timer);
		driver.uniffiDestroy();
	}
}
