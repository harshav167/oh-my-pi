# CUA SDK integration for native `/live` screen context

## Decision

Use the TypeScript SDK package `@trycua/cua-driver@0.12.3` as an application API, but connect it to the already-running `CuaDriver.app` daemon with `CuaDriver.connect(undefined)`. Do not use `CuaDriver.create()` in OMP: that executes desktop work inside OMP’s process, while the daemon retains the stable macOS Accessibility and Screen Recording identity already granted to `CuaDriver.app`. The SDK is not a replacement realtime protocol; it is the implementation behind OMP’s existing first-class `ComputerTool`/`ComputerController` boundary. [SDK reference](https://cua.ai/docs/reference/cua-driver/sdk-reference) [SDK/MCP/hosting](https://cua.ai/docs/concepts/sdk-mcp-and-hosting)

## Verified SDK surface

- Node/TypeScript package and import: `@trycua/cua-driver`, `import { CuaDriver } from "@trycua/cua-driver"`. The current npm release is `0.12.3`. [SDK reference](https://cua.ai/docs/reference/cua-driver/sdk-reference) [package manifest](https://unpkg.com/@trycua/cua-driver@0.12.3/package.json)
- `CuaDriver.connect(socketPath?)` connects the typed surface to a daemon; `CuaDriver.create(options?)` creates a same-process runtime. `executionMode()` distinguishes `Daemon` from `Embedded`, and `metadata()` reports driver/protocol/platform identity. [SDK reference](https://cua.ai/docs/reference/cua-driver/sdk-reference) [generated TypeScript contract](https://unpkg.com/@trycua/cua-driver@0.12.3/dist/native/cua_driver_sdk.d.ts)
- Typed lifecycle/session methods are asynchronous: `startSession`, `getSessionState`, `escalateSession`, `endSession`, `shutdown`, and `uniffiDestroy`. Connected daemon clients do not own the daemon, so `shutdown()` is a no-op for daemon ownership; applications still release the UniFFI handle deterministically with `uniffiDestroy()`. [SDK reference](https://cua.ai/docs/reference/cua-driver/sdk-reference)
- Typed desktop calls include `getDesktopState`, `click`, `drag`, `scroll`, `typeText`, `pressKey`, and `hotkey`. Platform-extensible window/app operations use `callTool(name, argumentsJson)`. Every asynchronous operation accepts `{signal: AbortSignal}`. [generated TypeScript contract](https://unpkg.com/@trycua/cua-driver@0.12.3/dist/native/cua_driver_sdk.d.ts)
- `ToolResult` carries `text`, `images`, `structuredJson`, `isError`, `errorCode`, `verified`, `degraded`, and `rawJson`. Screen context can therefore preserve both screenshot image content and accessibility/structured text instead of reducing the result to pixels. [SDK reference](https://cua.ai/docs/reference/cua-driver/sdk-reference)
- CUA sessions declare immutable `captureScope` (`AUTO`, `WINDOW`, or `DESKTOP`). The driver requires a fresh state snapshot before and after actions; window element indexes are scoped to the latest `(pid, window_id)` snapshot. [SDK/MCP/hosting](https://cua.ai/docs/concepts/sdk-mcp-and-hosting) [Cua Driver skill/reference](https://cua.ai/docs/cua-driver)

## Why SDK behind OMP's ComputerTool

The typed SDK and MCP server are downstream of the same canonical Cua Driver contract. CUA explicitly recommends `cua-driver mcp` for ordinary agents using their runtime's existing MCP client; that remains the supported user-mounted alternative. OMP's built-in integration is a narrower application-owned exception: OMP already exposes one first-party `ComputerTool` with its own schema, approvals, ownership, cancellation, and `ComputerController` factory, so the SDK supplies that controller's backend rather than exposing CUA's open-ended agent tool inventory a second time. This preserves OMP’s existing `computerApproval`, exclusive concurrency, provider safety metadata, and owner cleanup. [SDK/MCP/hosting](https://cua.ai/docs/concepts/sdk-mcp-and-hosting) [OMP upstream `ComputerTool`](../../packages/coding-agent/src/tools/computer.ts)

The daemon topology remains necessary on macOS. Accessibility and Screen Recording grants attach to process identity/responsibility; `CuaDriver.app` provides stable identity across reconnects. A same-process `CuaDriver.create()` would instead use OMP’s identity and require separate permission onboarding. [SDK/MCP/hosting](https://cua.ai/docs/concepts/sdk-mcp-and-hosting)

## Realtime architecture boundary

The investigated ChatGPT flow is not a special Frameless sideband screen event. The Codex thread is started with a dynamic screen-context tool, and the desktop host answers an app-server `item/tool/call` request. The request is correlated by `threadId`, `turnId`, and `callId`; the response is `{contentItems, success}` with text/image/audio content items. [inspected Codex source: `~/.codex/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:1534-1565`] [current architecture](01-current-codex-architecture.md#9-screen-context-tool-server)

OMP does not need to recreate app-server JSON-RPC around an in-process AgentSession. Its equivalent is:

1. `/live` forwards a voice delegation to the existing AgentSession.
2. The AgentSession invokes its first-class `computer` tool.
3. A CUA SDK-backed `ComputerController` calls the daemon directly and returns screenshot plus accessibility/structured context.
4. Existing handoff streaming returns the coding agent’s grounded response to the voice model.

The AgentSession tool-call ID and `AbortSignal` replace app-server request-ID correlation/cancellation inside OMP. No private screen message should be invented or serialized onto the realtime sideband.

## Packaging constraint

The root SDK package has platform-specific optional dependencies for macOS, Linux, and Windows. The macOS arm64 leaf ships both `libcua_driver_sdk.dylib` and `cua_driver_node_runtime.node`. OMP must explicitly verify source, npm-tarball, and compiled-binary loading rather than assuming Bun embeds these native files. [root package manifest](https://unpkg.com/@trycua/cua-driver@0.12.3/package.json) [darwin-arm64 manifest](https://unpkg.com/@trycua/cua-driver-darwin-arm64@0.12.3/package.json)

Required smoke assertion for each supported distribution: import the package, call `CuaDriver.connect(undefined)`, inspect `executionMode()`, and release the client handle with `uniffiDestroy()`. This is the part every gate can run — it proves the host native leaf loaded and the typed surface is callable in that build shape. If compiled binaries cannot load the external native leaf, package/install it as an external runtime dependency; never silently fall back to same-process mode.

**[SPEC] Daemon-handshake tier — revised 2026-07-29**
The daemon half of the assertion (compatible `metadata()`, non-embedded, live session) requires a provisioned `CuaDriver.app` with Accessibility and Screen Recording grants. Hosted CI runners have no such daemon, so making it unconditional would fail every gate for an absent optional user install rather than for a packaging defect.

Two tiers, both implemented in `smokeTestCuaRuntime` (`packages/coding-agent/src/tools/computer/cua-runtime.ts`):

1. **Every distribution gate (default).** Package import, native-leaf load, `connect(undefined)`, `executionMode()`, handle release. A driver that is absent or not in daemon mode is logged and skipped; a daemon that answers *incorrectly* — empty `driverVersion`/`contractVersion`, or `embedded: true` on a daemon connection — fails.
2. **Daemon-provisioned gate (`PI_CUA_SMOKE_STRICT=1`).** Absent or non-daemon mode becomes fatal, so a host that is supposed to have a daemon cannot pass by skipping.

Tier 2 has no gate wired yet; it is available for one and is the mechanism a future daemon-provisioned runner must use. Until then the daemon handshake is verified manually on a developer host, and tier 1 is the automated contract.
