/**
 * Single source of truth for the CUA driver's package wiring.
 *
 * The root package, its per-platform native leaves, and its UniFFI companions
 * are needed in four places — the runtime installer, the compiled-binary
 * external list, the npm bundle external list, and the platform leaf selector.
 * Duplicating them let a routine version bump ship a compiled binary that
 * externalizes a different set than the npm bundle, or miss a newly added leaf
 * on exactly one release target.
 *
 * The *version* deliberately does not live here: `package.json` declares it, and
 * both the runtime and the compile-time define derive from that declaration.
 */

/** Root SDK package. */
export const CUA_PACKAGE = "@trycua/cua-driver";

/**
 * UniFFI companions the SDK loads at runtime, with their pins.
 *
 * Pinned here rather than at the install call site: they travel with the driver
 * version and were previously a fifth place to forget during an upgrade.
 */
export const CUA_COMPANION_PINS: Readonly<Record<string, string>> = Object.freeze({
	"@ubjs/core": "0.31.0-3",
	"@ubjs/node": "0.31.0-3",
});

/** Companion package names. */
export const CUA_COMPANION_PACKAGES: readonly string[] = Object.freeze(Object.keys(CUA_COMPANION_PINS));

/**
 * Native leaf per `${platform}-${arch}`.
 *
 * Only the host's leaf is installed on demand; every leaf is externalized so no
 * build embeds a platform binary it cannot use.
 */
export const CUA_RUNTIME_DEPENDENCIES: Readonly<Record<string, string>> = Object.freeze({
	"darwin-arm64": "@trycua/cua-driver-darwin-arm64",
	"darwin-x64": "@trycua/cua-driver-darwin-x64",
	"linux-arm64": "@trycua/cua-driver-linux-arm64-gnu",
	"linux-x64": "@trycua/cua-driver-linux-x64-gnu",
	"win32-arm64": "@trycua/cua-driver-win32-arm64-msvc",
	"win32-x64": "@trycua/cua-driver-win32-x64-msvc",
});

/**
 * Every CUA package that must stay external to a build.
 *
 * Derived from the leaf map, so adding a platform above automatically
 * externalizes it in both the compiled binary and the npm bundle.
 */
export const CUA_EXTERNAL_PACKAGES: readonly string[] = Object.freeze([
	CUA_PACKAGE,
	...Object.values(CUA_RUNTIME_DEPENDENCIES),
	...CUA_COMPANION_PACKAGES,
]);
