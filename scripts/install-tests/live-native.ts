import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import type * as NativeBindings from "../../packages/natives/native/index.js";
import nativePackage from "../../packages/natives/package.json" with { type: "json" };

const addonPath = process.argv[2];
if (!addonPath) throw new Error("Usage: node scripts/install-tests/live-native.ts <addon.node>");

const watchdog = setTimeout(() => {
	console.error("LiveWebRtcPeer non-device smoke timed out");
	process.exit(1);
}, 30_000);

try {
	const bindings = createRequire(import.meta.url)(path.resolve(addonPath)) as typeof NativeBindings;
	assert.equal(bindings.__piNativesBuildVersion(), nativePackage.version);
	const Peer = bindings.LiveWebRtcPeer;
	assert.equal(typeof Peer, "function");
	for (const method of [
		"acceptAnswer",
		"close",
		"createOffer",
		"setMuted",
		"setSpeakerSuppressed",
		"waitForOpen",
	] as const) {
		assert.equal(typeof Peer.prototype[method], "function", `Missing LiveWebRtcPeer.${method}`);
	}
	const peer = new Peer(
		() => {},
		() => {},
		() => {},
	);
	await peer.close();
	process.stdout.write(
		`${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, version: nativePackage.version, peerClosed: true })}\n`,
	);
	clearTimeout(watchdog);
	// The callbacks retain the Node event loop; this probe does not test automatic process exit.
	process.exit(0);
} catch (error) {
	clearTimeout(watchdog);
	console.error(error);
	process.exit(1);
}
