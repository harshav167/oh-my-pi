# Evidence Inventory and Confidence Boundaries
**Version 1.0.0** · Evidence frozen 2026-07-24

---

## AI READING INSTRUCTION

Read `[SPEC]` for admissible evidence and version boundaries. Read `[?]` as unresolved; do not fill gaps by analogy. No secret or personal identifier may be reconstructed from this inventory.

---

## 1. Classification rules

**[SPEC]**

| Class | Meaning | Allowed inference |
|---|---|---|
| Static app evidence | Directly visible in installed build-5828 metadata/minified assets | Only behavior literally present in that build |
| OpenAI source evidence | First-party Codex source at an exact tag/commit | Protocol/core behavior at that revision; renderer behavior only when separately observed |
| Observed runtime evidence | Sanitized anchors from a real build-5828 run | Only the event sequence visible in cited lines |
| OMP source/history evidence | Current repository files and exact history commits | Current `/live`, extension seams, and predecessor provenance |
| Unresolved | Not established by the above | No guessing, backfilling, or silent defaults |

Research packets `agent://CurrentAppVoice`, `agent://CodexVoiceHarness`, and `agent://OmpLiveArchaeology` carried the investigation results, but claims cite their underlying primary artifacts rather than treating an agent summary as a new source.

## 2. Version ledger

**[SPEC]**

| Artifact | Exact version | Boundary |
|---|---|---|
| Installed ChatGPT/Codex desktop | `26.721.31836`, build `5828` | Current desktop evidence |
| Installed bundled Codex | `codex-cli 0.146.0-alpha.3.1` | Core shipped with build 5828 |
| Matching first-party source | `rust-v0.146.0-alpha.3.1` @ `ff75c5b939c477c49eb1bd5248da6dab71b109d1` | Exact bundled-core source packet |
| Newer first-party local source | `rust-v0.146.0-alpha.6` @ `f474de492a896643efa03481ac03e3f8ffbcbb37` | Latest corroboration/drift, not build-5828 renderer evidence |
| Current OMP live generation | commit `3d64910bb06d043bd0d7c4f7c27bd92105779bbf`, released 17.1.0 | Current July implementation |

The app updated from build 5813 to build 5828 mid-research. The 5813 artifact was not independently retained, so this dossier discards its implementation observations and does not merge them into build 5828. [APP-5828: `Contents/Info.plist:159-175`; CurrentAppVoice version boundary]

## 3. Static app evidence

**[SPEC]**

| Artifact | Lines | Facts admitted |
|---|---:|---|
| `Contents/Info.plist` | 159-175 | App version `26.721.31836`, build `5828` |
| `Contents/Resources/codex` | binary/version command | Bundled `codex-cli 0.146.0-alpha.3.1` |
| `Contents/Resources/app.asar/.vite/build/main-D9i1FeCI.js` | 8 | Bundled Codex resolution and app-server construction |
| `Contents/Resources/app.asar/.vite/build/main-D9i1FeCI.js` | 305-307 | Realtime notification recorder, SDP/audio redaction, handoff-to-turn correlation |
| `Contents/Resources/app.asar/.vite/build/main-D9i1FeCI.js` | 1273-1274 | Session reservation/reset, launch-state coordination, `realtimeVoice` hotkey |
| `Contents/Resources/app.asar/webview/assets/app-initial-C-fROkKo.js` | 749 | Renderer recognizes realtime notification family |
| `Contents/Resources/app.asar/webview/assets/app-initial-C-fROkKo.js` | 777-894 | Coordinator flags/prompts, continuity/memory, control surface, WebRTC/session lifecycle |
| `Contents/Resources/app.asar/webview/assets/app-initial-C-fROkKo.js`, byte-derived segment corresponding to original line 894 | descriptive anchor only | `rrs` coordinator builds `fns`, prepares WebRTC, and handles realtime events |
| `Contents/Resources/app.asar/webview/assets/realtime-voice-launch-surface-C9glm7ls.js` | 1 | Starting/failure/retry/back and handoff UI |
| `Contents/Resources/app.asar/webview/assets/realtime-voice-stage-layout-CjclUtP9.js` | 1 | Animation-frame handoff completion |
| `Contents/Resources/app.asar/webview/assets/realtime-voice-handoff-target-Dyx7hOYI.js` | asset identity | Presentation-anchor handoff asset exists |
| `Contents/Resources/app.asar/webview/assets/realtime-buffered-audio-worklet-lroxYXhj.js` | asset identity | Realtime AudioWorklet exists; constants not asserted |

**[SPEC]**
Bundle searches found no static consumer endpoint, alpha header, intent, architecture, or fixed realtime model literal in build 5828's renderer assets. Those values are owned by the bundled Codex core/source, not safely backfilled as renderer literals. [APP-5828 byte-accurate negative search boundary from CurrentAppVoice]

No proprietary bundle excerpt longer than a short descriptive anchor is committed; no extracted source is part of this dossier.

## 4. OpenAI source evidence: bundled alpha.3.1

**[SPEC]**
These first-party permalinks are pinned to `ff75c5b939c477c49eb1bd5248da6dab71b109d1`:

| Source | Lines | Facts admitted |
|---|---:|---|
| [`core/src/realtime_conversation.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L99-L100) | 99-100 | V3 Frameless default model |
| [`core/src/realtime_conversation.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L1113-L1197) | 1113-1197 | Provider/auth/transport preparation and session/thread headers |
| [`core/src/realtime_conversation.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L1271-L1320) | 1271-1320 | V3 model/parser/session-ID selection |
| [`core/src/realtime_conversation.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L1561-L1620) | 1561-1620 | Direct-WS auth distinction and alpha-header mapping |
| [`codex-api/src/endpoint/realtime_call.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/codex-api/src/endpoint/realtime_call.rs#L49-L79) | 49-79 | Backend `realtime/calls` vs non-backend `live` path selection |
| [`codex-api/src/endpoint/realtime_call.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/codex-api/src/endpoint/realtime_call.rs#L129-L209) | 129-209 | Initial session call request and SDP/Location handling |
| [`codex-api/src/endpoint/realtime_call.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/codex-api/src/endpoint/realtime_call.rs#L213-L243) | 213-243 | AVAS intent/architecture query |
| [`codex-api/src/endpoint/realtime_call.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/codex-api/src/endpoint/realtime_call.rs#L674-L725) | 674-725 | Consumer backend URL and JSON-body assertions |
| [`app-server-protocol/src/protocol/v2/realtime.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs#L3-L125) | 3-125 | Start/audio/text/speech/stop/list schemas and V3 initial items |
| [`app-server-protocol/src/protocol/v2/realtime.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs#L227-L238) | 227-238 | Start notification fields |
| [`app-server/src/bespoke_event_handling.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server/src/bespoke_event_handling.rs#L393-L412) | 393-412 | Core started/SDP to app-server notifications |
| [`app-server/src/message_processor.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server/src/message_processor.rs#L1283-L1309) | 1283-1309 | Realtime request dispatch |
| [`app-server/src/request_processors/turn_processor.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server/src/request_processors/turn_processor.rs#L234-L290) | 234-290 | Realtime handlers |
| [`app-server/src/request_processors/turn_processor.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server/src/request_processors/turn_processor.rs#L1028-L1051) | 1028-1051 | Thread listener/feature gate |
| [`core/src/config/mod.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/config/mod.rs#L985-L1010) | 985-1010 | Effective realtime config fields |
| [`app-server/tests/suite/v2/realtime_conversation.rs`](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server/tests/suite/v2/realtime_conversation.rs#L1567-L1588) | 1567-1588 | Frameless model/delegation/non-backend `/v1/live`/sideband/header fixture |

**[NOTE] Source naming boundary**
There is no production `realtime_websocket.rs` at the investigated source versions; it is a directory module under `codex-rs/codex-api/src/endpoint/realtime_websocket/`. There is no production `app_server.rs`; exact-name files are tests, while production is under `codex-rs/app-server/src/`. Required citations use actual production module paths rather than fabricated filenames.

## 5. OpenAI source evidence: newer alpha.6

**[SPEC]**
The authoritative local first-party checkout is `~/.codex/codex`, tag `rust-v0.146.0-alpha.6`, commit `f474de492a896643efa03481ac03e3f8ffbcbb37`. It is newer than the app's alpha.3.1 binary and is used only for current-source corroboration/drift.

| Local source | Lines | Facts admitted |
|---|---:|---|
| `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs` | 87-100 | queue/context/initial-item limits, models |
| `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs` | 506-630 | manager state, call creation, sideband task |
| `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs` | 1113-1214 | auth/transport preparation and AVAS version validation |
| `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs` | 1246-1320 | V3 initial limits, model/parser/session ID |
| `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs` | 1377-1506 | start, notifications, event drain, close |
| `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs` | 1561-1620 | direct-WS auth and alpha-header mapping |
| `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs` | 1665-1825 | sideband join/input loop/transcript-tail flush |
| `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs` | 43-79,129-165,213-243 | consumer/backend request selection and shape |
| `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs` | 646-746 | exact consumer backend URL/body assertions |
| `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/mod.rs` | 1-21 | actual module/export surface |
| `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs` | 948-984 | call-ID path join and Frameless path normalization |
| `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs` | 11-114 | session JSON, initial items, 500-byte chunks |
| `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs` | 14-83 | parser and outbound message taxonomy |
| `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs` | 15-95 | current Frameless event parser |
| `~/.codex/codex/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs` | 15-148,231-308 | app-server realtime request/notification schemas |
| `~/.codex/codex/codex-rs/app-server/src/message_processor.rs` | 1295-1322 | request dispatch |
| `~/.codex/codex/codex-rs/app-server/src/request_processors/turn_processor.rs` | 1029-1212 | feature gate and core operations |
| `~/.codex/codex/codex-rs/app-server/src/bespoke_event_handling.rs` | 399-555 | notification translation |
| `~/.codex/codex/codex-rs/config/src/config_toml.rs` | 380-403,583-620 | configured version/mode/transport/voice and URL/model overrides |
| `~/.codex/codex/codex-rs/protocol/src/protocol.rs` | 205-247,1628-1655 | core start schema, V1/V2/V3 enum, handoff modes |
| `~/.codex/codex/codex-rs/core/src/config/mod.rs` | 983-1011,4087-4115 | effective config and defaults merge |
| `~/.codex/codex/codex-rs/app-server/README.md` | 20-29,77-89,903-1003,1571 | JSONL initialization, WebRTC RPC, V3 continuity/handoff, attestation contract |

Alpha.6 contains no current realtime `OpenAI-Beta: realtime=sideband` requirement. It joins Frameless sideband by appending the accepted call ID to the path. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:948-970`; `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1587-1620`]

## 6. Observed runtime evidence

**[SPEC]**
The only retained runtime artifact used here is identified by the dossier alias:

`RUN-5828` — the sanitized current desktop log under `~/Library/Logs/com.openai.codex/`; its UUID-bearing filename is intentionally omitted.

Only these sanitized anchors are admissible:

| Lines | Facts admitted |
|---:|---|
| 1725-1778 | Thread creation/ownership, `thread/realtime/start`, continuity/memory status, DeviceCheck generation, session-start notification, later `rtc_u2_…` session update, bundled local Codex selection |
| 1990-2001 | Realtime screen-context request, appshot capture, screenshot + accessibility text completion, tool result, server response |

No identifier, UUID-bearing filename, absolute home path, or unrelated log content from those lines may be copied.

## 7. OMP current-source evidence

**[SPEC]**

| Source | Lines | Facts admitted |
|---|---:|---|
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | 2431-2437,2455-2463 | Builtin `/live` and reserved name |
| `packages/coding-agent/src/modes/interactive-mode.ts` | 797,1023-1027,3855-3861,3899-3904,4454-4461 | Builtin controller lifecycle and STT exclusion |
| `packages/coding-agent/src/modes/controllers/live-command-controller.ts` | 75-177 | Visualizer/editor/focus/vocalizer ownership and restore |
| `packages/coding-agent/src/live/controller.ts` | 124-243,254-350,352-408 | Recorder/transport, events, delegation, transcripts, activity, cleanup |
| `packages/coding-agent/src/live/transport.ts` | 21-27,84-112,176-405,408-489 | Consumer signaling/auth, browser/WebRTC, sideband, queues, cleanup |
| `packages/coding-agent/src/live/protocol.ts` | 1-55,140-234 | Model, Frameless schemas/parser, payloads, chunking |
| `packages/coding-agent/src/live/browser-runtime.txt` | 54-220 | Resampling, streams, WebRTC/data channel, playback, mute, teardown |
| `packages/coding-agent/src/live/audio-worklet.txt` | 1-59 | 0.75-second bounded injected-audio queue |
| `packages/coding-agent/src/live/visualizer.ts` | 5-18,82-89 | Current phases and keys |
| `packages/coding-agent/src/live/protocol.test.ts` | 13-140 | Existing protocol-only tests |
| `packages/catalog/src/wire/codex.ts` | 5-34 | Consumer base, client version, header names |
| `packages/coding-agent/src/extensibility/extensions/types.ts` | 250-282,413-445,1090-1122,1149-1214 | UI/context/events/commands/send surface |
| `packages/coding-agent/src/extensibility/extensions/runner.ts` | 513-531 | Reserved collision skip |
| `packages/coding-agent/src/extensibility/shared-events.ts` | 190-200 | Agent terminal/continuation event |
| `packages/coding-agent/src/config/model-registry.ts` | 814-835 | Public auth storage |
| `packages/coding-agent/package.json` | 529-559 | Recorder and deep tool export patterns |
| `packages/coding-agent/src/tts/vocalizer.ts` | 103-131 | Internal suspension lease semantics |

A supplied runtime import check confirmed `@oh-my-pi/pi-coding-agent/tools/browser/launch` resolves through `./tools/*`. This corrects the archaeology packet's initial “absent export” claim: the import exists but remains a deep unstable surface. [OMP: `packages/coding-agent/package.json:545-559`; supplied runtime check]

## 8. OMP history evidence

**[SPEC]**

| Commit | Date | Admitted fact |
|---|---|---|
| `40586a8919f6cb9311baf41a205e5cefa333b789` | 2026-01-05 | Batch STT/TTS push-to-talk predecessor |
| `8b3870514648fa2fbb302a4e285adb81c69ec318` | 2026-01-05 | Public Realtime `VoiceSupervisor`/`VoiceController` predecessor |
| `fc1a2bc5daf3efed6268e3f1c4f5cdcc9d7fab2f` and twin `24f0e41...` | 2026-01-11 | Refactor of that predecessor |
| `a51321bf40f2619cae0187f7e4c87ae378b52582` and twin `fa881fd...` | 2026-01-21 | Removed voice supervisor/controller/manager integration |
| `3d64910bb06d043bd0d7c4f7c27bd92105779bbf` | 2026-07-24 | Added current private Codex `/live` subsystem |
| `f1875dc45a8217f1a6f8b8c65ff9581b9396c469` | 2026-07-24 | Formatting-only follow-up |

Changelog anchors corroborate the January addition/removal and July release, but committed code is authoritative where January changelog model naming conflicts with code. [OMP: `packages/coding-agent/CHANGELOG.md:5-15,10282-10291,11342-11381`]

## 9. Unresolved facts

**[?]**

| Unknown | Why unresolved | Required evidence |
|---|---|---|
| Exact build-5828 renderer `thread/realtime/start` object | Minified bundle/no source map; identifiers do not prove optional fields | Permitted sanitized IPC trace or first-party renderer source |
| Whether renderer pins V3 or relies on remote/config default | Same boundary | Sanitized request parameters, no identifiers |
| Effective production voice slug at call start | Fetched dynamically; no fixed value observed | Sanitized start trace |
| Remote-host feature-gate/config drift | Only local authenticated runtime observed | Remote-host trace and matching host source/config |
| Exact DeviceCheck placement and header ownership | Runtime proves generation, not every layer | First-party call-chain source or sanitized attestation request trace |
| Consumer auth scopes/account-selection edge cases | Credential values intentionally not inspected | First-party auth contract/tests without tokens |
| Sideband recovery after an established connection fails | OMP initial retry is visible; server resume behavior not exercised | Controlled private runtime failure trace |
| Desktop buffered-worklet queue constants | Worklet asset exists; exact constants not retained after version correction | Fresh permitted static inspection of build 5828 without extraction retention |
| Public extension seam for appshot/AX screen capture | Current extension API does not document one | Narrow host API/source or explicit product decision |
| Stable audio-ownership lease for extensions | `vocalizer.suspend()` is internal | Narrow exported contract and lifecycle test |
| Whether awaitable `sendUserMessage` is necessary in practice | Needed only for immediate delivery-failure parity | Failure-path requirement/test |
| Remote media placement | Desktop selects host; OMP extension design not implemented | Approved local/remote architecture and runtime QA |

No unresolved row authorizes a public fallback, model substitution, local STT/TTS replacement, or generic transport layer.

## 10. Redaction and handling

**[SPEC]**
- Never include bearer/refresh/session token values.
- Never include account, thread, session, request, call, window, socket, host, or local-network identifiers.
- Never include unrelated application/user activity from runtime logs.
- Use only the two designated runtime line ranges.
- Keep proprietary bundle excerpts short and descriptive; do not commit extracted source.
- Source paths and the explicitly designated runtime artifact path may be cited; no other personal local paths are needed.

## 11. Changelog

**[SPEC]**
- 1.0.0 — classified all admissible evidence, split alpha.3.1 from alpha.6, recorded actual production module paths, and enumerated unresolved facts without guessing.
