# OMP `/live` Archaeology and Gap Analysis
**Version 1.0.0** · Current OMP generation: July 24, 2026

---

## AI READING INSTRUCTION

Read `[SPEC]` and `[BUG]` as authoritative. Read `[NOTE]` for history. Do not treat January's removed public Realtime code as the current `/live`, and do not call the current model/header obsolete.

---

## 1. Executive correction

**[SPEC]**
Current OMP `/live` is the July private Codex consumer implementation introduced by commit `3d64910bb06d043bd0d7c4f7c27bd92105779bbf`, not the January public OpenAI Realtime WebSocket implementation. The current subsystem is registered in release 17.1.0 and lives under `packages/coding-agent/src/live/`. [OMP: `packages/coding-agent/CHANGELOG.md:5-15`; current files `protocol.ts`, `transport.ts`, `controller.ts`, `browser-runtime.txt`, `audio-worklet.txt`, `visualizer.ts`]

It already implements the private V3/Frameless fingerprint directly:

- model `gpt-live-1-boulder-alpha`;
- `OpenAI-Alpha: quicksilver=v2`;
- consumer `POST ${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
- Codex OAuth bearer plus account/session/thread/originator metadata;
- JSON `{sdp, session}` call creation and `Location` call-ID extraction;
- WebRTC audio plus `oai-events` data channel;
- authenticated `/codex/<call-id>` sideband WebSocket;
- Frameless session/transcript/delegation/context/close messages. [OMP: `packages/coding-agent/src/live/protocol.ts:1-55,140-200`; `packages/coding-agent/src/live/transport.ts:21-27,84-112,176-280`; `packages/coding-agent/src/live/browser-runtime.txt:114-185`]

**[BUG] Wrong-generation diagnosis**
- **Symptom:** the old report called current OMP an obsolete public Realtime implementation and recommended replacing it with a public API model.
- **Cause:** the removed January `VoiceSupervisor` history was conflated with the newly added July subsystem, and `quicksilver=v2` was mistaken for Realtime V2.
- **Fix:** preserve the July private transport target and close harness/completeness gaps against Codex V3/Desktop build 5828. [OMP history: commits `8b3870514648fa2fbb302a4e285adb81c69ec318`, `a51321bf40f2619cae0187f7e4c87ae378b52582`, `3d64910bb06d043bd0d7c4f7c27bd92105779bbf`]

## 2. Current end-to-end path

**[SPEC]**

```mermaid
flowchart LR
    C[/live builtin] --> I[InteractiveMode]
    I --> U[LiveCommandController + LiveVisualizer]
    U --> L[LiveSessionController]
    L --> R[16 kHz recorder]
    L --> T[CodexLiveTransport]
    T --> B[Headless Chromium WebRTC]
    T --> P[Private consumer signaling + sideband]
    P --> L
    L --> A[Active AgentSession]
    A --> L
```

1. Builtin registry reserves `/live` and calls `InteractiveModeContext.handleLiveCommand()`. [OMP: `packages/coding-agent/src/slash-commands/builtin-registry.ts:2431-2437,2455-2463`]
2. Interactive mode rejects overlapping push-to-talk STT and delegates to `LiveCommandController`; session switch, synchronous stop, and async shutdown stop/dispose the live controller. [OMP: `packages/coding-agent/src/modes/interactive-mode.ts:797,1023-1027,3855-3861,3899-3904,4454-4461`]
3. `LiveCommandController` mounts the visualizer, replaces/focuses the editor surface, hides cursors, animates every 80 ms, and suspends local vocalizer output; cleanup restores each resource. [OMP: `packages/coding-agent/src/modes/controllers/live-command-controller.ts:75-177`]
4. `LiveSessionController` renders the live prompt, reads `AgentSession.modelRegistry.authStorage` and `sessionId`, connects transport, subscribes to normal agent events, then starts the shared 16 kHz streaming recorder. [OMP: `packages/coding-agent/src/live/controller.ts:124-185`]
5. `CodexLiveTransport` launches centralized headless Chromium, injects the browser/worklet runtimes, creates an offer, signals the consumer endpoint, applies the answer, waits for the data channel, then opens the sideband. [OMP: `packages/coding-agent/src/live/transport.ts:176-257`]
6. The browser runtime creates a synthetic microphone track from host Float32 PCM, resamples 16 kHz input to the browser AudioContext rate, plays/analyzes remote audio, and owns the `oai-events` data channel. [OMP: `packages/coding-agent/src/live/browser-runtime.txt:54-112,114-200`]
7. `delegation.created` invokes the active `AgentSession`; tool-use progress and final output return to Frameless context in UTF-8-safe 500-byte chunks. [OMP: `packages/coding-agent/src/live/controller.ts:281-329`; `packages/coding-agent/src/live/protocol.ts:175-234`]
8. Stop serializes recorder stop, queued sends, `session.close`, sideband/page/browser cleanup, and one terminal callback. [OMP: `packages/coding-agent/src/live/controller.ts:203-243`; `packages/coding-agent/src/live/transport.ts:453-489`]

## 3. Current private signaling

**[SPEC]**
OMP's signaling URL resolves from `CODEX_BASE_URL = https://chatgpt.com/backend-api` to the private consumer route. It sends JSON `{sdp, session}`, accepts raw SDP, parses `Location` for `rtc_<uuid>`, and builds the consumer sideband path. [OMP: `packages/catalog/src/wire/codex.ts:5-34`; `packages/coding-agent/src/live/transport.ts:21-27,84-112,229-280`]

`buildLiveSessionPayload` sends model, instructions, output voice, and `delegation: {type: "client"}`. The client/server wire schema covers session start/update, output audio, transcript additions, turn completion, delegation creation, errors, delegation/session context append, and session close. [OMP: `packages/coding-agent/src/live/protocol.ts:13-55,140-200`]

When the authenticated sideband is open, it is authoritative: non-error events from the WebRTC data channel are dropped. Client control messages are serialized onto sideband; the browser runtime's data-channel `send()` currently has no host caller. [OMP: `packages/coding-agent/src/live/transport.ts:355-405`; `packages/coding-agent/src/live/browser-runtime.txt:182-185,220`]

## 4. Media, UI, and delegation behavior already present

**[SPEC]**
- Host microphone capture uses the shared streaming recorder; PCM is pushed into Chromium, not acquired with browser `getUserMedia`. [OMP: `packages/coding-agent/src/live/controller.ts:124-185,337-350`; `packages/coding-agent/src/live/browser-runtime.txt:54-89,114-132,187-200`]
- Remote audio reaches the browser AudioContext destination and reports RMS every 50 ms. [OMP: `packages/coding-agent/src/live/browser-runtime.txt:91-112`]
- The AudioWorklet bounds queued injected microphone audio to 0.75 seconds. Host transport separately bounds queued samples. [OMP: `packages/coding-agent/src/live/audio-worklet.txt:1-59`; `packages/coding-agent/src/live/transport.ts:408-440`]
- Visual phases are connecting, listening, working, speaking, muted, and error. Escape ends the call; Space toggles microphone mute. [OMP: `packages/coding-agent/src/live/visualizer.ts:5-18,82-89`]
- Input echo gating suppresses low microphone frames while output is active; output level selects speaking/listening when no worker delegation is active. [OMP: `packages/coding-agent/src/live/controller.ts:20-24,331-350,398-408`]
- A client-targeted delegation becomes one normal AgentSession user message. Tool-use assistant output is appended as commentary; the final assistant message uses the final-message template and clears active delegation state. [OMP: `packages/coding-agent/src/live/controller.ts:281-329`]

## 5. What is missing for build-5828 parity

**[SPEC]**

| Gap | Current OMP | Required parity | Evidence |
|---|---|---|---|
| App-server V3 orchestration | Direct browser signaling/sideband owned by `CodexLiveTransport` | Port V3 manager semantics: versioned start schema, notification translation, session IDs, event drain/close | OMP `transport.ts:176-405`; Codex A6 `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:506-630,1377-1506` |
| Activation/reservation barrier | Connect then recorder; no four-condition activation or host reservation | Request accepted + realtime started + WebRTC connected + session initialized, plus claim/release | OMP `controller.ts:124-185`; APP-5828 `app-initial-C-fROkKo.js:894`, `.vite/build/main-D9i1FeCI.js:1273-1274` |
| V3 continuity | Session payload has no `initial_items` | Role-bearing initial items, limits, memory/continuity policy, silence-until-new-input | OMP `protocol.ts:13-19,165-172`; Codex A6 `app-server-protocol/.../realtime.rs:101-135`; APP-5828 `app-initial-C-fROkKo.js:777-894` |
| Handoff modes | One active delegation; commentary progress + final append | `thinking`, `commentary`, `bemTags`, response-as-items, streamed flush/truncation, transcript-tail behavior | OMP `controller.ts:281-329`; Codex A6 `core/src/realtime_conversation.rs:434-445,726-1022,1747-1825` |
| Screen context | None in `/live` | Thread-bound dynamic tool server, appshot-equivalent capture boundary, response/cancel lifecycle | RUN-5828 log lines 1990-2001 |
| Input/output controls | Microphone mute only; fixed voice; no microphone refresh | Independent input mute, output mute, microphone refresh, output stream ownership | OMP `controller.ts:188-201`; APP-5828 `app-initial-C-fROkKo.js:777-894` |
| Remote/local association | Active local AgentSession/session ID only | Host-selected manager, explicit local/remote thread association and cleanup | OMP `controller.ts:139-159`; APP-5828 `app-initial-C-fROkKo.js:894` |
| Lifecycle/telemetry | Basic terminal error and cleanup | Typed start/end reasons, inactivity, archive/unmount/usage-limit paths, reservation release, redacted telemetry | OMP `controller.ts:180-243`; APP-5828 `app-initial-C-fROkKo.js:777-894`, `.vite/build/main-D9i1FeCI.js:305-307` |
| Client metadata | Catalog pins Codex client version `0.144.1` | Deliberate parity/version policy rather than accidental stale metadata | OMP `packages/catalog/src/wire/codex.ts:7-10`; APP-5828 bundled CLI version evidence |

**[NOTE]**
The model, alpha header, private OAuth, AVAS route, and Frameless parser do not constitute the gap. Those are already aligned. The deficit is the desktop/app-server harness around them.

## 6. Lifecycle gaps in detail

**[SPEC]**
OMP start currently considers transport connection sufficient to subscribe and begin recording; `session.started` later switches phase to listening. It has no explicit request-accepted, app-server-started, WebRTC-connected, session-initialized barrier. [OMP: `packages/coding-agent/src/live/controller.ts:124-185,254-279`]

OMP has idempotent cleanup for recorder, control message, sideband, page, and browser, but lacks desktop parity for inactivity auto-end, thread archive, app unmount, usage-limit speech, cross-window termination, host-claim release, and typed end-reason telemetry. [OMP: `packages/coding-agent/src/live/controller.ts:203-243`; `packages/coding-agent/src/live/transport.ts:453-489`; APP-5828: `app-initial-C-fROkKo.js:777-894`]

OMP reconnects sideband only during initial establishment with bounded backoff. An established sideband close becomes terminal; there is no app-server-owned resume/translation layer. [OMP: `packages/coding-agent/src/live/transport.ts:259-353`]

## 7. Handoff and continuity gaps in detail

**[SPEC]**
OMP tracks one `activeDelegationId`, forwards a single request to AgentSession, sends tool-use text as commentary, and sends one templated final response. It does not implement response-as-items, BEM channel routing, explicit `clientManagedHandoffs`, 200 ms streamed flush scheduling, output token-budget truncation, or transcript-tail flush. [OMP: `packages/coding-agent/src/live/controller.ts:281-329`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:91-109,173-220,434-445,820-1022,1747-1885`]

OMP's initial session shape has no role-bearing history, memory summary, or continuity list. Build-5828 resolves continuity and memory before starting and V3 core validates initial items. [OMP: `packages/coding-agent/src/live/protocol.ts:13-19,165-172`; APP-5828: `app-initial-C-fROkKo.js:777-894`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1246-1320`]

## 8. January predecessor: separate and removed

**[NOTE]**
- `40586a8919f6cb9311baf41a205e5cefa333b789` (2026-01-05) added batch STT/TTS push-to-talk voice.
- `8b3870514648fa2fbb302a4e285adb81c69ec318` (2026-01-05) added `VoiceSupervisor`/`VoiceController` using `@openai/agents/realtime`, public `RealtimeSession(... transport: "websocket")`, default `gpt-realtime`, 24 kHz PCM, semantic VAD, and supervisor tools.
- `fc1a2bc5daf3efed6268e3f1c4f5cdcc9d7fab2f` (parallel-history twin `24f0e41...`, 2026-01-11) refactored that generation without changing its protocol.
- `a51321bf40f2619cae0187f7e4c87ae378b52582` (parallel-history twin `fa881fd...`, 2026-01-21) deleted the voice supervisor/controller/manager/settings/UI path. The changelog records the removal. [OMP: `packages/coding-agent/CHANGELOG.md:10282-10291`]
- `3d64910bb06d043bd0d7c4f7c27bd92105779bbf` (2026-07-24) introduced the current private Codex `/live`; `f1875dc45a8217f1a6f8b8c65ff9581b9396c469` is formatting-only. [OMP: `packages/coding-agent/CHANGELOG.md:5-15`; OmpLiveArchaeology history packet]

The January changelog called the feature `gpt-5-realtime`, while committed code defaulted to `gpt-realtime`; the committed code is authoritative. Neither name describes July's `gpt-live-1-boulder-alpha`. [OMP: `packages/coding-agent/CHANGELOG.md:11342-11381`; OmpLiveArchaeology commit inspection]

No separately named advanced-voice generation was found in source/history. The two WebSockets are different: January used public Realtime as the primary transport; July uses WebRTC media plus a private consumer sideband. [OmpLiveArchaeology `git log -S/-G` findings retained in packet]

## 9. Existing test coverage

**[SPEC]**
`packages/coding-agent/src/live/protocol.test.ts:13-140` is the only current live-specific suite. It covers event parsing, exact session/context/close JSON, and UTF-8-safe 500-byte chunking. [OMP: `packages/coding-agent/src/live/protocol.test.ts:13-140`]

It does not cover signaling URL/headers/body/Location, OAuth retry/account selection, browser/WebRTC/worklet behavior, sideband precedence/reconnect, AgentSession delegation, UI mount/restore, recorder failure, mute/echo behavior, or teardown. [OmpLiveArchaeology test inventory; source comparison against `transport.ts`, `controller.ts`, and `live-command-controller.ts`]

## 10. Extension migration facts

**[SPEC]**
- Extension commands, lifecycle events, focused `ui.custom`, terminal input, widgets/editor APIs, `sendUserMessage`, model registry, auth storage, and session ID access exist. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:250-305,413-445,1090-1122,1149-1214`; `packages/coding-agent/src/config/model-registry.ts:814-835`]
- `/live` cannot be registered by an extension while it remains a reserved builtin; collisions are skipped. [OMP: `packages/coding-agent/src/slash-commands/builtin-registry.ts:2431-2437,2455-2463`; `packages/coding-agent/src/extensibility/extensions/runner.ts:513-531`]
- Recorder reuse is exported through `./stt/*`. A runtime import check confirmed `@oh-my-pi/pi-coding-agent/tools/browser/launch` resolves through `./tools/*`; it is available but is a deep unstable export, not absent. [OMP: `packages/coding-agent/package.json:529-535,545-559`; supplied runtime import check]
- Vocalizer suspension/audio ownership remains internal. Clean parity needs a narrow lease/export; direct editor-container mutation is unnecessary when `ui.custom` owns focus. [OMP: `packages/coding-agent/src/tts/vocalizer.ts:103-131`; `packages/coding-agent/src/extensibility/extensions/types.ts:250-282`]
- Extension `sendUserMessage` returns `void`; awaitability is needed only to match delivery-failure reporting, because agent events already expose completion and continuation state. [OMP: `packages/coding-agent/src/extensibility/extensions/types.ts:1210-1214`; `packages/coding-agent/src/extensibility/shared-events.ts:190-200`]

## 11. Changelog

**[SPEC]**
- 1.0.0 — separated January public history from July private `/live`, verified the matching private fingerprint, and enumerated only the remaining harness/completeness gaps.
