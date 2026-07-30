# Desktop Harness and Runtime Evidence
**Version 1.0.0** · Installed application 26.721.31836/build 5828 only

---

## AI READING INSTRUCTION

Read `[SPEC]` as build-5828 evidence. `[NOTE]` explains interpretation. `[?]` is unresolved. Static bundle evidence and observed runtime logs are distinct; neither permits disclosure of identifiers, credentials, or unrelated activity.

---

## 1. Build integrity

**[SPEC]**
The current installed artifact is ChatGPT/Codex desktop `26.721.31836`, build `5828`, bundle identifier `com.openai.codex`, with bundled `codex-cli 0.146.0-alpha.3.1`. [APP-5828: `Contents/Info.plist:159-175`; `Contents/Resources/codex`, `codex --version`]

The app updated from build 5813 to 5828 during research. Build 5813 was not retained independently, so earlier 5813 static observations are discarded rather than merged with build 5828. [CurrentAppVoice packet version/breaking-change boundary]

No source map was shipped for the minified Electron assets. Static claims below are limited to directly visible behavior and short descriptive anchors; no extracted proprietary source is committed. [APP-5828 evidence boundary: `Contents/Resources/app.asar`]

## 2. Static evidence assets

**[SPEC]**

| Asset | Established responsibility | Anchor |
|---|---|---|
| `webview/assets/app-initial-C-fROkKo.js` | Renderer coordinator `rrs`, WebRTC runtime `fns`, flags, prompt, notification handling, stream/control API | lines 749, 777-894 |
| `webview/assets/realtime-voice-launch-surface-C9glm7ls.js` | starting/failed/retry/back UI and launch handoff | line 1 |
| `webview/assets/realtime-voice-stage-layout-CjclUtP9.js` | post-connect animation-frame handoff completion | line 1 |
| `webview/assets/realtime-voice-handoff-target-Dyx7hOYI.js` | presentation-anchor handoff animation | static asset identity |
| `webview/assets/realtime-buffered-audio-worklet-lroxYXhj.js` | AudioWorklet shipped for realtime buffering | static asset identity; queue constants not claimed |
| `.vite/build/main-D9i1FeCI.js` | packaged Codex resolver, app-server broker, recorder, reservation/hotkey/overlay lifecycle | lines 8, 305-307, 1273-1274 |

## 3. Renderer coordinator flow

**[SPEC]**
1. Availability requires `getUserMedia` and `RTCPeerConnection`. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
2. `rrs.start` accepts host/conversation identity, prompt, source, output modality, preferred surface, mute state, microphone, continuity/memory inputs, response-handoff flags/prefixes, optional session overrides, and voice/user presentation inputs. [APP-5828: `app-initial-C-fROkKo.js:777-894`, exact minified `start(...)` signature recorded by CurrentAppVoice]
3. The coordinator gets the selected host's AppServerManager, claims the cross-window/host session, calls `prepareWebRtcSession`, resolves the effective voice slug, loads enabled continuity/memory, creates the Codex voice bridge, then calls the WebRTC runtime with voice, prompt, and V3 initial context. [APP-5828: `app-initial-C-fROkKo.js:894`, byte-derived coordinator description]
4. Runtime becomes active only after request acceptance, `thread/realtime/started`, WebRTC connection, and session initialization. Active starts in `listening`, plays the start sound, enables the bridge, and schedules inactivity end. [APP-5828: `app-initial-C-fROkKo.js:894`]

## 4. Input/output media and activity

**[SPEC]**
- The runtime exposes separate microphone input and remote output `MediaStream`s through `getStream` and `getOutputStream`. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
- `refreshMicrophoneInput` updates the preferred microphone in preparing or active state. `toggleMicrophoneMute` controls input; `toggleMute` independently controls output. Host controls synchronize these states across presentation surfaces. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
- Output audio is level-analyzed. Activity enters `speaking` above the output threshold and returns to `listening` after sustained silence; microphone/output levels remain independent. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
- The shipped realtime AudioWorklet proves a dedicated buffering path exists, but exact worklet queue constants were not retained after the build mismatch was discovered and are not asserted here. [APP-5828: `realtime-buffered-audio-worklet-lroxYXhj.js`, static asset evidence]

## 5. App-server manager and ordinary thread lifecycle

**[SPEC]**
- Electron main resolves `Contents/Resources/codex` unless `CODEX_CLI_PATH` is set, constructs app-server connections, routes responses/notifications to renderer web contents, and keeps a recorder/ledger for realtime sessions. [APP-5828: `.vite/build/main-D9i1FeCI.js:8,305-307`]
- The coordinator starts a normal Codex thread with `threadSource: realtime_voice`, `threadStartKind: realtime_voice`, dynamic tools, instructions, and optional model/reasoning configuration. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
- The renderer consumes `thread/realtime/started`, `sdp`, `itemAdded`, transcript delta/done, `outputAudio/delta`, `error`, and `closed`, while ordinary `turn/started`, `turn/completed`, and `thread/archived` drive delegated work and lifecycle. [APP-5828: `app-initial-C-fROkKo.js:749,894`; `.vite/build/main-D9i1FeCI.js:305-307`]
- The main-process recorder redacts SDP and audio bytes in feedback material, correlates a backend handoff request to its subsequent ordinary Codex turn, and can attach that turn's rollout. [APP-5828: `.vite/build/main-D9i1FeCI.js:305-307`]

## 6. Continuity and memory harness

**[SPEC]**

| Setting family | Build-5828 behavior | Anchor |
|---|---|---|
| `realtime_continuity_enabled` | Enables previous conversation items | `app-initial-C-fROkKo.js:777-894` |
| `realtime_continuity_max_items` | Range 1-20, default 10 | `app-initial-C-fROkKo.js:777-894` |
| `realtime_continuity_max_text_length` | Range 100-4000 | `app-initial-C-fROkKo.js:777-894` |
| `realtime_continuity_prompt` | Controls continuity instructions | `app-initial-C-fROkKo.js:777-894` |
| `realtime_memory_summary_enabled` | Enables memory summary | `app-initial-C-fROkKo.js:777-894` |
| `realtime_memory_summary_prompt` | Controls summary instructions | `app-initial-C-fROkKo.js:777-894` |

Resumed context explicitly tells the voice layer not to speak until a new message arrives in the current session. This prevents old context from being treated as a fresh utterance. [APP-5828: `app-initial-C-fROkKo.js:777-894`]

## 7. Delegation and speaking policy

**[SPEC]**
- The prompt maintains one assistant identity while selecting direct conversation, a quick direct check, or worker delegation for blocking mechanics. [APP-5828: `app-initial-C-fROkKo.js:894`]
- Realtime receives user and backend text as user-role items with `[USER]` and `[BACKEND]` prefixes. [APP-5828: `app-initial-C-fROkKo.js:894`]
- Build-5828 flags cover response-as-items, handoff channel prefixes, handoff mode (`thinking|commentary|bemTags`), response prefixes, explicit `speak_to_user`, explicit end-call behavior, and realtime tool developer instructions. [APP-5828: `app-initial-C-fROkKo.js:777-894`]
- Main-process recording associates handoff IDs with normal turn start/completion, proving delegated coding remains on the regular Codex thread/turn path. [APP-5828: `.vite/build/main-D9i1FeCI.js:305-307`]

## 8. Launch/presentation and cross-window controls

**[SPEC]**
- Launch UI renders starting and failed states with retry/back navigation, then leaves only after connection and handoff completion. [APP-5828: `realtime-voice-launch-surface-C9glm7ls.js:1`]
- Stage handoff completes on the first animation frame after connecting ends. [APP-5828: `realtime-voice-stage-layout-CjclUtP9.js:1`]
- Electron main registers the `realtimeVoice` hotkey, coordinates avatar-overlay launch/presentation state, and reserves/resets the session across windows. [APP-5828: `.vite/build/main-D9i1FeCI.js:1273-1274`]
- Stop, terminate, input mute, output mute, delegation accounting, and usage-limit simulation are cross-window controls rather than renderer-local toggles. [APP-5828: `app-initial-C-fROkKo.js:777-894`]

## 9. Failure and cleanup behavior

**[SPEC]**
Failures distinguish SDP rejection, WebRTC connection failure, app-server realtime error, unexpected close, thread archive, inactivity, app unmount, and user end. Requested shutdown treats `transport_closed` as expected rather than a new failure. [APP-5828: `app-initial-C-fROkKo.js:777-894`]

A usage-limit warning uses `appendSpeech` with an urgent instruction so it can interrupt either side of the conversation. Startup cancellation terminates local runtime state and releases the host claim only after cleanup. [APP-5828: `app-initial-C-fROkKo.js:777-894`]

## 10. Sanitized runtime observation: start

**[SPEC]**
Runtime log lines 1725-1778 establish this sequence without reproducing any identifiers:

1. configuration/model/experimental-feature reads complete;
2. a realtime-voice thread is created and assigned an owner;
3. browser-use routing and thread settings initialize;
4. continuity is enabled with zero prior items and memory summary is present;
5. `thread/realtime/start` is accepted;
6. DeviceCheck attestation is generated during startup;
7. app-server reports the realtime session started;
8. the renderer later reports a realtime session identifier with the `rtc_u2_…` prefix. [RUN-5828: sanitized current desktop log, lines 1725-1778]

The log also shows the bundled Codex executable was selected for the local host. No account, thread, session, request, window, socket, filename UUID, or other identifier from these lines is reproduced here. [RUN-5828: sanitized current desktop log, lines 1765-1770]

## 11. Sanitized runtime observation: screen context

**[SPEC]**
Runtime log lines 1990-2001 establish that a realtime screen-context tool request chose the appshot route, captured both a screenshot and accessibility text, completed successfully, prepared a tool result, and sent the realtime server response. No target application name, bundle identifier, call ID, thread ID, request ID, filename UUID, or window metadata is reproduced. [RUN-5828: sanitized current desktop log, lines 1990-2001]

**[NOTE]**
This runtime evidence closes a gap left by static asset inspection: the screen-context tool server was not merely bundled; it handled a real realtime request and returned a result.

## 12. What runtime did not establish

**[?]**
- The log proves DeviceCheck generation occurred during start, but not its exact ownership boundary or every upstream header placement. [RUN-5828: lines 1752-1754]
- Static and runtime evidence do not expose credential values, and this dossier does not infer them.
- Remote-host feature gates may drift independently of the local path; no remote authenticated call was observed.
- The production renderer's exact `thread/realtime/start` version/voice override object remains unresolved because the shipped bundle is minified and lacks source maps.
- No separately named “advanced voice” runtime or separate realtime model was observed in build 5828. `gpt-5.6-luna` elsewhere in the bundle is dictation cleanup, not realtime voice. [APP-5828: `app-initial-C-fROkKo.js:777-894`, negative static search boundary]

## 13. Changelog

**[SPEC]**
- 1.0.0 — separated static build-5828 harness evidence from sanitized live runtime observations and discarded unretained build-5813 behavior.
