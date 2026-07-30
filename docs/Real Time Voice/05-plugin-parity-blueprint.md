# Extension-Owned `/live` Private-Parity Blueprint
**Version 1.0.0** · Recommended architecture: port V3 manager semantics into an OMP extension

---

## AI READING INSTRUCTION

This file is the decision-complete implementation blueprint. `[SPEC]` is required behavior. `[?]` marks a host seam that must be resolved before parity can be claimed. Do not add a public protocol, model, API-key path, generic transport layer, or fallback.

---

## 1. Target and non-goals

**[SPEC]**
The extension shall reproduce exact private consumer Codex V3 voice while reusing the active OMP `AgentSession` for coding work. It shall preserve the current consumer model/header/AVAS/Frameless fingerprint and port the current Codex app-server realtime-manager semantics that OMP lacks. [Existing fingerprint: `packages/coding-agent/src/live/protocol.ts:1-55`; `packages/coding-agent/src/live/transport.ts:21-27,100-112`; manager reference: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:506-630,1377-1506,1665-1825`]

Exact non-goals:

- no public OpenAI Realtime API;
- no API-key billing path;
- no local STT/TTS replacement;
- no model substitution;
- no generic transport abstraction;
- no fallback protocol;
- no second coding-agent/tool loop inside the voice extension;
- no external Codex app-server in the shipped architecture.

## 2. Strategy choice

**[SPEC]**

| Strategy | Shape | Decision |
|---|---|---|
| **A. Port V3 manager semantics into the extension** | Keep OMP auth, `AgentSession`, recorder, browser media, UI/events; port current V3 session construction, initial items, parser, sideband, handoff streaming, lifecycle, and notification semantics | **Ship this. It matches the requested OMP/pi extension architecture.** |
| **B. Spawn/connect to Codex app-server** | Child JSONL client, initialize/initialized, experimental API, mirror thread and approval/server-request routing, browser WebRTC in OMP | Reference/probe only; useful for differential wire verification, not shipped |

Strategy B would duplicate process lifecycle, thread state, approvals, tool/server requests, and auth ownership around an agent OMP already has. Strategy A changes only the voice harness and keeps coding authority in `AgentSession`. [App-server process surface: `~/.codex/codex/codex-rs/app-server/README.md:20-29,77-89,903-1003`; OMP delegation: `packages/coding-agent/src/live/controller.ts:281-329`]

## 3. Command ownership cutover

**[SPEC]**
1. Remove the builtin `live` registration from `packages/coding-agent/src/slash-commands/builtin-registry.ts:2431-2437`.
2. Remove the builtin-only `LiveCommandController` construction/dispatch/session-switch/stop/shutdown ownership from `packages/coding-agent/src/modes/interactive-mode.ts:797,1023-1027,3855-3861,3899-3904,4454-4461` after the extension owns equivalent lifecycle.
3. Register exactly `live` from the extension. No temporary `/live-public`, alias, override contract, or compatibility shim.
4. Delete or move obsolete core-owned live orchestration once every caller is migrated; do not leave two implementations.

An extension cannot own `/live` before step 1 because builtin names are reserved and colliding extension commands are skipped. [OMP: `packages/coding-agent/src/slash-commands/builtin-registry.ts:2455-2463`; `packages/coding-agent/src/extensibility/extensions/runner.ts:513-531`]

## 4. Proposed extension modules

**[SPEC]**
Use one extension directory during implementation, proposed as `.omp/extensions/live/` for local incubation. These are proposed files, not claims about existing paths:

| File | Single responsibility |
|---|---|
| `index.ts` | Register `/live`, bind extension lifecycle/events, construct one coordinator |
| `coordinator.ts` | Reservation, activation barrier, session/activity/end state machines, inactivity, cleanup |
| `protocol-v3.ts` | Strict V3 session/client/server schemas, parsing, 500-byte chunking, initial-item validation |
| `auth.ts` | Resolve consumer OAuth/account/session headers from OMP auth storage; never expose values to renderer |
| `signaling.ts` | Consumer HTTP call creation, SDP/Location validation, authenticated Frameless sideband |
| `media.ts` | Recorder + headless-browser WebRTC runtime, input/output streams, independent mute, level callbacks |
| `continuity.ts` | Build role-bearing V3 `initial_items` and silence-until-current-input instructions |
| `handoff.ts` | AgentSession delegation, streamed output, channel/BEM routing, response-item mode, transcript-tail flush |
| `screen-context.ts` | Thread-bound dynamic tool request, permission/capture/result boundary |
| `view.ts` | Focused `ui.custom` launch/active/failure surface and keyboard controls |

Do not add interfaces/factories for single implementations. The separation exists only where trust, lifecycle, or independently testable wire behavior differs.

## 5. Required schemas

**[SPEC]**
`protocol-v3.ts` shall parse, not cast, these exact data families:

```ts
// Proposed internal types; wire names remain exact.
type InitialItem = {
  role: "user" | "developer" | "assistant";
  text: string;
};

type PrivateCallSession = {
  model: "gpt-live-1-boulder-alpha";
  instructions: string;
  audio: { output: { voice: string } };
  delegation: { type: "client" };
  initial_items?: Array<{
    type: "message";
    role: InitialItem["role"];
    content: Array<{ type: "input_text" | "output_text"; text: string }>;
  }>;
};

type ThreadAssociation =
  | { kind: "local"; ompSessionId: string }
  | { kind: "remote"; hostId: string; ompSessionId: string; remoteThreadId: string };
```

The call request is JSON `{sdp, session}` to the consumer route. `Location` must contain a valid accepted call ID. V3 initial items accept no more than 128 items, 8,192 estimated tokens per item, or 8,192 total. Context appends are split at UTF-8 boundaries to at most 500 bytes. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:129-165,213-243,251-283`; `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:91-95,1246-1270`; `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs:11,45-114`]

Inbound parsing shall cover `session.started|updated`, `output_audio.delta`, `input_transcript.added`, `output_transcript.added`, `turn.done`, `delegation.created`, and `error`. Outbound messages shall cover `delegation.context.append`, `session.context.append`, and `session.close`; response/item messages are added only when the selected handoff mode requires them. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:15-95`; `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs:49-83`]

## 6. State machines

**[SPEC]**

### 6.1 Session lifecycle

```text
idle
  -> reserving
  -> starting
  -> active
  -> stopping
  -> closed

reserving|starting|active -> failed -> stopping -> closed
```

Only the coordinator mutates lifecycle. Every terminal path enters `stopping`; cleanup is idempotent and releases reservation last.

### 6.2 Activation barrier

```text
requestAccepted
threadRealtimeStarted
webRtcConnected
sessionInitialized
```

`active` requires all four bits. Launch presentation also waits for its one-shot UI handoff completion. This matches build-5828 behavior instead of treating SDP success alone as activation. [APP-5828: `app-initial-C-fROkKo.js:894`; `realtime-voice-launch-surface-C9glm7ls.js:1`; `realtime-voice-stage-layout-CjclUtP9.js:1`]

### 6.3 Activity and controls

Activity is `listening | speaking | working`; input mute and output mute are independent booleans, not activity states. Output RMS enters speaking above threshold and sustained silence returns to listening. A worker claim sets working without discarding audio/mute state. [APP-5828: `app-initial-C-fROkKo.js:777-894`; contrast OMP `packages/coding-agent/src/live/controller.ts:398-408`]

### 6.4 Handoff lifecycle

```text
none -> claimed -> streaming -> completed -> none
                  \-> cancelled -> none
                  \-> failed -> none
```

Track handoff ID, associated OMP turn, streamed items, last output, channel mode, and terminal reason. Never permit stale agent events to append into a replacement handoff.

## 7. Auth, signaling, and media split

**[SPEC]**

### Auth
- Resolve consumer OAuth through `ctx.modelRegistry.authStorage`; retain OMP's retry/account-selection behavior. `ModelRegistry.authStorage` is public to the extension context. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:413-427`; `packages/coding-agent/src/config/model-registry.ts:814-835`]
- Construct bearer/account/session/thread/originator/alpha metadata only in the host extension process. Never pass bearer or account values into browser globals, SDP, transcript, errors, or telemetry. [Existing private host code: `packages/coding-agent/src/live/transport.ts:100-112,215-257`]
- Do not accept `OPENAI_API_KEY` and do not attempt direct public WebSocket auth.

### Signaling
- POST only the private consumer route with `intent=quicksilver&architecture=avas`, JSON `{sdp,session}`, and `OpenAI-Alpha: quicksilver=v2`.
- Parse raw SDP and call ID from `Location`; join the accepted Frameless sideband by path segment; the sideband becomes authoritative after it opens. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:43-79,129-165,213-243`; `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:948-970`; OMP: `packages/coding-agent/src/live/transport.ts:355-405`]
- No `OpenAI-Beta: realtime=sideband` addition: current source does not require it.

### Media
- Reuse the shared 16 kHz recorder and centralized headless-browser launcher. The recorder is exported; the runtime import check confirmed `@oh-my-pi/pi-coding-agent/tools/browser/launch` resolves through the existing wildcard, but this remains a deep unstable export. [OMP: `packages/coding-agent/package.json:529-535,545-559`; supplied runtime import check]
- Keep bearer/session headers outside Chromium. Chromium owns only WebRTC, SDP, media, data channel, playback, levels, and mute operations.
- Add output mute and microphone refresh to the media runtime; do not overload current input mute. Build 5828 exposes both input and output streams/controls. [APP-5828: `app-initial-C-fROkKo.js:777-894`]

## 8. Continuity and context

**[SPEC]**
- Build current-thread continuity from extension-visible context/session state, convert complete messages into V3 initial items, and apply the exact item/token limits before signaling. [OMP context event: `packages/coding-agent/src/extensibility/extensions/types.ts:1101-1104`; Codex limits: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1246-1270`]
- Keep continuity item count/text-length policy and memory-summary policy distinct. Build 5828 uses separate gates/prompts. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
- On resume, include an instruction to stay silent until a new current-session user message; never let history trigger speech by itself. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
- Default upstream realtime session association to the active OMP thread/session identity unless an explicit remote association supplies its own remote thread ID. Do not conflate OMP session, remote thread, and upstream realtime session identifiers. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1306-1316`]

## 9. Worker delegation and streamed handoff

**[SPEC]**
- `delegation.created` triggers exactly one `api.sendUserMessage` into the active OMP session; coding tools, approvals, and model selection remain OMP-owned. [Existing pattern: `packages/coding-agent/src/live/controller.ts:281-292`; extension API: `packages/coding-agent/src/extensibility/extensions/types.ts:1210-1214`]
- Subscribe to `message_update` for token-level worker deltas, `message_end` for final message state, and `agent_end` for terminal completion; ignore nonterminal `agent_end` when `willContinue` is true. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:1111-1118`; `packages/coding-agent/src/extensibility/shared-events.ts:190-200`]
- Implement Codex V3 output modes: default `thinking` (no channel), forced `commentary`, and `bemTags` mapping; retain `codexResponsesAsItems` only as an explicit parity flag. [Codex A6: `~/.codex/codex/codex-rs/app-server/README.md:977-1003`]
- Stream worker deltas on a 200 ms flush cadence with head/tail token-budget truncation, preserve UTF-8 boundaries, and flush pending output before completion. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:91-96,173-220,820-940,1848-1885`]
- On session end, optionally route remaining transcript tail to OMP once, after draining parsed events. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1451-1506,1814-1825`]

The extension API's `sendUserMessage` currently returns `void`. Event correlation is enough for ordinary delegation; an awaitable return is needed only if exact immediate delivery-failure parity is required. Do not block the whole port on that optional error surface. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:1210-1214`]

## 10. Screen-context tool server boundary

**[SPEC]**
The voice model shall not receive shell/file/browser tools directly. A single thread-bound screen-context server handles only the declared realtime request:

1. validate request type and active thread/handoff association;
2. request host permission/capture through a narrow UI-owned boundary;
3. collect only screenshot and accessibility text needed for the request;
4. return a structured result to the same realtime request;
5. cancel/forget the request on stop, thread switch, or reservation loss;
6. redact target identifiers and capture payloads from routine logs.

Build 5828 demonstrably routes a realtime request to appshot, captures screenshot plus accessibility text, then sends a server response. [RUN-5828: sanitized runtime log lines 1990-2001]

**[?]**
OMP's current extension surface does not document a desktop appshot/AX capture API. Clean parity therefore needs one narrow permission-aware host export or an existing capture service surfaced to the extension. Do not replace it with unrestricted shell commands, silent screenshots, or a generic tool server.

## 11. UI and audio ownership

**[SPEC]**
- Use `ctx.ui.custom` for the focused launch/active/error surface; it already owns focus and returns control when complete, so direct editor-container/cursor mutation is unnecessary. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:250-282`]
- Required controls: Escape/end, independent microphone mute, independent output mute, microphone refresh/selection, retry/back on failed start, and visible connecting/listening/speaking/working/error state. [APP-5828: `realtime-voice-launch-surface-C9glm7ls.js:1`; `app-initial-C-fROkKo.js:777-894`]
- Use extension `session_shutdown`, session-switch-equivalent lifecycle, and custom UI completion to drive the same idempotent stop path. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:1090-1118`]

**[?]**
TTS/vocalizer suspension and audio ownership remain internal. Add one narrow lease/export that stops existing local speech, suppresses new local speech while held, and releases idempotently. Current `vocalizer.suspend()` already has those semantics but is not an extension contract. [OMP: `packages/coding-agent/src/tts/vocalizer.ts:103-131`; current builtin use `packages/coding-agent/src/modes/controllers/live-command-controller.ts:119-160`]

## 12. Local and remote association

**[SPEC]**
- **Local:** bind reservation, auth correlation, continuity, delegation, and cleanup to `ctx.sessionManager.getSessionId()`; the browser/recorder run locally. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:413-427`; session accessor `packages/coding-agent/src/session/session-manager.ts:1693-1696`]
- **Remote:** require an explicit `hostId` and remote thread ID, route manager/tool/capture operations to that host, and keep the local OMP session ID only as the user-facing agent association. Never reuse a local thread ID as a remote one.
- A thread switch or host loss cancels the call before changing association. Build 5828 selects an AppServerManager by host and reserves across windows/hosts. [APP-5828: `app-initial-C-fROkKo.js:894`; `.vite/build/main-D9i1FeCI.js:1273-1274`]
- If remote media/capture routing is unavailable, fail before reservation/recording; do not silently fall back to local or public transport.

## 13. Failure mapping

**[SPEC]**

| Failure | Required result |
|---|---|
| Missing/rejected consumer OAuth | Fail start; no browser secret, API-key prompt, or fallback |
| Feature/version gate rejects V3 | Fail start and report private parity unavailable |
| Attestation request unavailable/rejected | Fail with a distinct attestation cause; do not guess placement |
| SDP rejection/empty answer | Fail start, close peer/page/browser, release reservation |
| Missing/invalid `Location` call ID | Fail start before sideband |
| WebRTC failed/disconnected before activation | Fail start or active session with typed end reason |
| Sideband fails/closes unexpectedly | Terminal failure after bounded private reconnect policy |
| Session never initializes | Activation timeout, full cleanup |
| Recorder unavailable | Fail before active; no text/STT substitute |
| Thread archive/switch/host loss | Requested stop, drain/flush, release association |
| Inactivity/usage limit | Typed end; usage limit may use `appendSpeech` before stop |
| Requested `transport_closed` | Expected close, not duplicate error |
| Screen permission/capture denial | Tool error only unless server requires termination |
| Cleanup substep fails | Continue every remaining cleanup step; report one aggregate terminal cause |

The categories mirror build-5828 distinctions and current Codex drain/close behavior. [APP-5828: `app-initial-C-fROkKo.js:777-894`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1451-1506`]

## 14. Tests

**[SPEC]**
Add contract tests at the runtime seams:

1. **Protocol fixtures:** every V3 inbound/outbound event, unknown/malformed rejection, role mapping, session JSON, 500-byte UTF-8 chunking.
2. **Consumer signaling:** exact consumer URL/query, JSON `{sdp,session}`, required header names, no beta/public headers, SDP decoding, `Location` parsing, sideband path-segment join.
3. **Initial context:** role encoding, silence instruction, 128-item and 8,192-token boundaries, V3-only enforcement.
4. **State machines:** four-bit activation, one-shot handoff, cancellation, inactivity, reservation release, idempotent stop, cleanup-error aggregation.
5. **Handoff:** one delegation per request, `message_update` delta capture, continuation-aware terminal detection, 200 ms streaming flush, channel/BEM modes, truncation, transcript tail.
6. **Media:** recorder/browser ownership, independent input/output mute, microphone refresh, sideband-vs-data-channel precedence, disconnect.
7. **Extension seams:** `/live` is extension-owned with no reserved collision; `ui.custom` returns focus; shutdown/thread switch stops; audio lease releases once.
8. **Screen context:** permission allow/deny, result routing to matching request, stop cancellation, redaction.
9. **Remote association:** local and remote IDs never cross, host loss stops, unsupported remote fails without fallback.

Existing `protocol.test.ts` covers only a subset of item 1. [OMP: `packages/coding-agent/src/live/protocol.test.ts:13-140`; OmpLiveArchaeology coverage inventory]

## 15. Runtime QA

**[SPEC]**
A signed-in private-consumer QA run must exercise the actual extension:

- cold `/live` start through all four activation conditions;
- audible two-way speech and transcript delta/done;
- speaking/listening transitions and barge-in;
- microphone mute, output mute, microphone refresh, retry, stop;
- one delegated coding turn with progress and final spoken handoff;
- each handoff mode used by production flags;
- continuity/memory resume with no unsolicited speech;
- screen-context allow and deny paths;
- inactivity, archive/thread switch, network loss, sideband loss, and requested close;
- local and available remote-host association;
- 20 repeated start/use/stop cycles with no recorder, browser, socket, reservation, audio lease, or focused-UI leak;
- log inspection confirming no credential/account/thread/session/capture payload leakage.

No public endpoint or fallback may be enabled during QA. The external app-server strategy may run separately as a differential probe against sanitized wire fixtures, never as the pass condition for the shipped extension.

## 16. Implementation order

**[SPEC]**
1. Lock private V3 protocol/signaling fixtures against alpha.3.1 and current alpha.6 evidence.
2. Cut over `/live` ownership and add the narrow audio lease; keep the browser deep import pinned/explicit.
3. Port coordinator activation/lifecycle and media controls.
4. Add V3 initial items/continuity.
5. Port streamed handoff modes and transcript-tail behavior onto AgentSession events.
6. Add permission-aware screen context.
7. Add remote association only after local parity passes.
8. Run contract tests and signed-in runtime QA; delete superseded core live code only after the extension path passes.

## 17. Changelog

**[SPEC]**
- 1.0.0 — specified extension-owned `/live`, direct private V3 port, schemas/state machines/seams, parity tests, and runtime QA without a public fallback.
