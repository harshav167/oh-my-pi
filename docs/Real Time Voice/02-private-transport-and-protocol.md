# Private Consumer Transport and V3 Frameless Protocol
**Version 1.0.0** · Consumer Codex only · No public fallback

---

## AI READING INSTRUCTION

Read all `[SPEC]` and `[BUG]` blocks. `[?]` marks unresolved facts. Keep app build 5828/bundled alpha.3.1 separate from newer alpha.6 source. Never reinterpret the alpha-header value as a protocol version.

---

## 1. Identity matrix

**[SPEC]**

| Axis | Current private parity value | What it is not | Evidence |
|---|---|---|---|
| Desktop build | `26.721.31836` / `5828` | Not build 5813 | APP-5828: `Contents/Info.plist:159-175` |
| Bundled core | `codex-cli 0.146.0-alpha.3.1` | Not the Electron build number | APP-5828: `Contents/Resources/codex`, `codex --version` |
| Conversation version | `RealtimeWsVersion::V3` | Not alpha-header `v2` | [A3.1 core](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L1271-L1320) |
| Model default | `gpt-live-1-boulder-alpha` | Not `gpt-realtime-1.5` | [A3.1 core](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L99-L100) |
| Event parser/wire adapter | `RealtimeEventParser::FramelessBidi` | Not `RealtimeV2` | [A3.1 core](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L1271-L1320) |
| Alpha header | `OpenAI-Alpha: quicksilver=v2` | Not public Realtime V2 | [A3.1 core](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/core/src/realtime_conversation.rs#L1595-L1602) |
| Media/signaling family | WebRTC + AVAS + sideband WebSocket | Not public `/v1/realtime` WebSocket voice | [A3.1 app-server README](https://github.com/openai/codex/blob/ff75c5b939c477c49eb1bd5248da6dab71b109d1/codex-rs/app-server/README.md#L898-L943) |

Newer source `rust-v0.146.0-alpha.6` at `f474de492a896643efa03481ac03e3f8ffbcbb37` retains the same V3 model/parser/header relationship. This corroborates the fingerprint but is not retroactively evidence about the renderer request object shipped in app build 5828. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:99-100,1271-1320,1595-1602`]

**[BUG] Version-name conflation**
- **Symptom:** `quicksilver=v2` is described as an obsolete V2 realtime model/protocol.
- **Cause:** one header's private rollout value was confused with `RealtimeWsVersion` and `RealtimeEventParser`.
- **Fix:** record all three independently: V3 conversation, FramelessBidi parser, alpha header `quicksilver=v2`. Actual Realtime V2 selects `RealtimeV2`, defaults to `gpt-realtime-1.5`, emits no alpha header, and is rejected for AVAS WebRTC. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1200-1214,1271-1291,1595-1603`]

## 2. Consumer call creation

**[SPEC]**
The consumer provider base is `https://chatgpt.com/backend-api/codex`. For a backend-shaped Frameless call, Codex performs:

```text
POST https://chatgpt.com/backend-api/codex/realtime/calls
     ?intent=quicksilver&architecture=avas
Content-Type: application/json

{"sdp": <offer SDP>, "session": <Frameless session object>}
```

`RealtimeCallClient::path()` returns `realtime/calls`; a provider base containing `/backend-api` always uses that path, and backend Frameless adds `intent=quicksilver&architecture=avas`. Tests assert the full consumer URL and JSON body. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:43-79,129-165,213-243,646-746`]

The response body is the SDP answer. The `Location` response header is parsed to obtain the accepted call ID; that call ID later joins the matching sideband WebSocket. [Codex A3.1: `codex-rs/codex-api/src/endpoint/realtime_call.rs:129-165`; Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:251-283`]

**[SPEC]**
The consumer backend and non-backend provider routes must not be merged:

- **Consumer ChatGPT backend:** `/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`, JSON `{sdp,session}`. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:66-79,146-165,695-746`]
- **Non-backend API-provider Frameless:** provider-relative `/v1/live`, multipart SDP/session. This branch is useful source coverage but is not the consumer behavior targeted here. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:66-75,168-204`; `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:974-984`]

## 3. Session JSON

**[SPEC]**
The V3 call's `session` contains:

```json
{
  "model": "gpt-live-1-boulder-alpha",
  "instructions": "<voice coordinator prompt>",
  "audio": { "output": { "voice": "<resolved v1-family voice>" } },
  "delegation": { "type": "client" },
  "initial_items": [
    { "type": "message", "role": "developer|user", "content": [{ "type": "input_text", "text": "…" }] },
    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "…" }] }
  ]
}
```

`initial_items` is omitted when empty. The upstream session `id` is removed from the call body even though core keeps a realtime session ID for correlation. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:129-165`; `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs:35-88`]

V3 is the only version accepting initial items. Limits are 128 items, 8,192 estimated tokens for each item, and 8,192 estimated tokens total; allowed roles are user, developer, and assistant. [Codex A6: `~/.codex/codex/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs:101-135`; `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:91-95,1246-1270`]

The model falls back to `gpt-live-1-boulder-alpha` for V3, the event parser becomes `FramelessBidi`, and the upstream realtime session ID defaults to the normal Codex thread ID when the caller does not provide one. [Codex A3.1: `codex-rs/core/src/realtime_conversation.rs:1271-1319`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1271-1320`]

## 4. Authentication and headers

**[SPEC]**
The consumer call is authenticated by Codex's provider session; credentials never need to enter renderer JavaScript. WebRTC preparation deliberately calls `realtime_request_headers` with `api_key: None`, then the authenticated endpoint session applies consumer bearer authentication. [Codex A3.1: `codex-rs/core/src/realtime_conversation.rs:1141-1182`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1113-1197`; `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:49-60,129-165`]

The request/header set comprises the OAuth bearer credential, account selection when available, the realtime `x-session-id`, Codex session/thread correlation headers, an originator, client version metadata, and `OpenAI-Alpha: quicksilver=v2`. Header **names** are part of the contract; credential and identifier **values** must never be logged or copied into fixtures. [OMP matching implementation: `packages/coding-agent/src/live/transport.ts:100-112,229-244`; OMP header definitions: `packages/catalog/src/wire/codex.ts:5-34`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1154-1182,1587-1620`]

Direct WebSocket mode has a different auth rule: it searches provider API key, experimental bearer, Codex auth API key, then `OPENAI_API_KEY`, and errors without one. That direct-WS path is neither the desktop WebRTC consumer path nor an acceptable fallback for this project. [Codex A3.1: `codex-rs/core/src/realtime_conversation.rs:1561-1584`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1561-1585`]

**[SPEC]**
Current alpha.6 realtime source contains no `OpenAI-Beta: realtime=sideband` requirement. Frameless sideband identity comes from the accepted call ID appended to the normalized WebSocket path plus the current authenticated/session/default/alpha headers. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:948-970`; `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1587-1620`]

## 5. Sideband join

**[SPEC]**
After call creation, core opens a sideband WebSocket for the call. For `FramelessBidi`, the call ID is appended as a path segment; V1/RealtimeV2 instead use a `call_id` query parameter. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:948-970`]

The consumer base therefore normalizes to the consumer Codex path and joins the accepted call as a path segment. OMP's direct implementation independently builds `${CODEX_BASE_URL}/codex/<call-id>`, changes `https` to `wss`, and sends the same session/auth headers. [OMP: `packages/coding-agent/src/live/transport.ts:84-112,259-353`]

WebRTC media/data-channel connection and sideband connection are separate readiness conditions. Codex core passes `call_id` and call-specific sideband headers into `connect_webrtc_sideband`, then multiplexes text input, worker output, server events, and audio frames. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:571-596,1665-1825`]

## 6. Frameless events and parsing

**[SPEC]**
Current Frameless inbound events are:

| Wire event | Parsed meaning | Evidence |
|---|---|---|
| `session.started`, `session.updated` | Session initialized/updated | `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:15-35` |
| `output_audio.delta` | 24 kHz mono output audio frame | `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:38-45` |
| `input_transcript.added` | User transcript delta | `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:20-22,48-56` |
| `output_transcript.added` | Assistant transcript delta | `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:23-25,48-56` |
| `turn.done` | Role-specific final transcript | `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:58-70` |
| `delegation.created` | Client-targeted handoff request | `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:73-95` |
| `error` | Realtime error | `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:28` |

Unsupported Frameless event types are ignored by current Codex parsing rather than being reclassified as public Realtime events. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs:29-34`]

App-server translates core events into `thread/realtime/{started,sdp,itemAdded,transcript/delta,transcript/done,outputAudio/delta,error,closed}` keyed to the normal Codex thread. [Codex A6: `~/.codex/codex/codex-rs/app-server/src/bespoke_event_handling.rs:399-555`; `~/.codex/codex/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs:231-308`]

## 7. Client messages, chunking, and handoff

**[SPEC]**
Frameless outbound control uses:

- `delegation.context.append` with `delegation_item_id`, optional `speakable|commentary` channel, and `input_text` content.
- `session.context.append` with optional channel and `input_text` content.
- `session.close` for graceful termination. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs:49-81`; `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs:13-33`]

Context append text is split at UTF-8 character boundaries into chunks no larger than 500 bytes. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs:11,98-114`; OMP: `packages/coding-agent/src/live/protocol.ts:4-5,203-234`]

`delegation.created` is normalized into a handoff request and routed into the normal Codex thread. Unless `clientManagedHandoffs` is true, Codex streams worker output back to the active delegation; V3 supports `thinking`, `commentary`, and `bemTags`, with `codexResponsesAsItems` as a distinct experimental delivery mode. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:434-445,726-1022,1451-1487`; `~/.codex/codex/codex-rs/app-server/README.md:977-1003`]

The realtime input task serializes text, worker output, server events, and audio, optionally flushes the remaining transcript tail through Codex when the session ends, and drains already-parsed events before closing so a queued handoff is not lost. [Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:1451-1506,1747-1825`]

## 8. App-server surface

**[SPEC]**
`ThreadRealtimeStartParams` is the authoritative app-server schema: `threadId`, handoff flags/modes, response-item flags/prefix, optional model, audio/text output modality, startup-context flag, V3 initial items, nullable prompt, optional upstream realtime session ID, WebSocket/WebRTC transport, version, and voice. Wire names are camelCase. [Codex A3.1: `codex-rs/app-server-protocol/src/protocol/v2/realtime.rs:3-125`; Codex A6: `~/.codex/codex/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs:15-148`]

App-server dispatches start/appendAudio/appendText/appendSpeech/stop/listVoices into core and requires realtime support on the loaded thread. [Codex A6: `~/.codex/codex/codex-rs/app-server/src/message_processor.rs:1295-1322`; `~/.codex/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:1029-1212`]

**[NOTE] Source filename correction**
The requested source names `realtime_websocket.rs` and production `app_server.rs` do not exist at the investigated OpenAI tags. The realtime WebSocket implementation is the directory module `codex-rs/codex-api/src/endpoint/realtime_websocket/{mod.rs,methods.rs,methods_frameless_bidi.rs,protocol*.rs}`; production app-server is `codex-rs/app-server/src/{lib.rs,message_processor.rs,request_processors/*,bespoke_event_handling.rs}`. Exact-name `app_server.rs` files are tests. This dossier cites the actual production paths rather than inventing anchors. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_websocket/mod.rs:1-21`; `~/.codex/codex/codex-rs/app-server/src/message_processor.rs:1295-1322`]

## 9. Source-version boundary

**[SPEC]**
- Build 5828 bundles alpha.3.1. Exact A3.1 links above are first-party commit permalinks carried by the source packet.
- Alpha.6 is a newer local, first-party checkout. It confirms the consumer route, V3 initial-items behavior, path-segment sideband join, and current handoff streaming; those are labeled A6 and not attributed to the minified build-5828 renderer.
- `/v1/live` in a non-backend provider test is not evidence that the consumer desktop uses that route. The consumer test explicitly asserts `/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`. [Codex A6: `~/.codex/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs:646-746`]

## 10. Changelog

**[SPEC]**
- 1.0.0 — documented exact V3/Frameless consumer call, headers, sideband, schemas, limits, parsing, and version boundaries.
