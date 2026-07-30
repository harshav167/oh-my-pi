# Real Time Voice: Exact Private Codex Parity Dossier
**Version 1.0.0** · Evidence date 2026-07-24 · Scope: OMP/pi extension reproduction

---

## AI READING INSTRUCTION

Read `[SPEC]` and `[BUG]` blocks as authoritative within the stated version boundary. Read `[NOTE]` for interpretation and history. Treat `[?]` as unresolved. Do not substitute the public OpenAI Realtime API for the private consumer Codex target.

---

## 1. Decision

**[SPEC]**
The sole implementation target is the current private consumer Codex voice stack: WebRTC media, the ChatGPT Codex consumer call route, an authenticated sideband WebSocket, `RealtimeWsVersion::V3`, the private live model identifier, and the `FramelessBidi` event adapter. The value `OpenAI-Alpha: quicksilver=v2` belongs to that V3/Frameless combination; it is not the public Realtime V2 protocol or model. [Codex A3.1: `codex-rs/core/src/realtime_conversation.rs:99-100,1271-1319,1595-1602`; Codex A6: `~/.codex/codex/codex-rs/core/src/realtime_conversation.rs:99-100,1271-1320,1595-1602`]

**[SPEC] Model identifier — superseded 2026-07-29**
This document originally pinned `gpt-live-1-boulder-alpha`, read from Codex at revision `ff75c5b93`. That value is **superseded by `gpt-live-1-codex`**, which is the implementation target from here on.

Authority: commit `b76c07ece` ("Updated live session model to `gpt-live-1-codex` and default voice to `sol` across protocol and controller") is maintainer-authored and merged to `origin/main`, i.e. upstream adopted the new identifier deliberately after this document's pinned revision was read. The identifier is a moving upstream detail, so this section — not a hardcoded string elsewhere in the doc set — is where its current value is recorded. Sibling documents that still quote `gpt-live-1-boulder-alpha` in captured payloads or blueprints are historical transcripts of that earlier revision and are not independent requirements.

Current value lives in code at `packages/coding-agent/src/live/protocol.ts` (`LIVE_MODEL`), with the user-facing default in `live.model` (`packages/coding-agent/src/config/settings-schema.ts`).

OMP's July `/live` already has that same core fingerprint: the private live model, alpha header, private consumer OAuth, AVAS call route, JSON `{sdp, session}` request, WebRTC, and Frameless events are present today. The work is a harness-parity and completeness rewrite, not a migration away from an obsolete model identifier. [OMP: `packages/coding-agent/src/live/protocol.ts:1-55,165-200`; `packages/coding-agent/src/live/transport.ts:21-27,84-112,176-257`]

**[BUG] Corrected recommendation**
- **Symptom:** the removed single-file report recommended replacing private Codex transport with the public Realtime API and described current OMP as if it were the January public-WebSocket implementation.
- **Cause:** it merged evidence from different app builds and protocol generations before the current app-server/Codex source was traced.
- **Fix:** reproduce exact private V3 parity, retain strict source-version boundaries, and treat January's removed public implementation only as history. [OMP history: commits `8b3870514648fa2fbb302a4e285adb81c69ec318`, `a51321bf40f2619cae0187f7e4c87ae378b52582`, `3d64910bb06d043bd0d7c4f7c27bd92105779bbf`; OMP: `packages/coding-agent/CHANGELOG.md:10282-10291,11342-11381,5-15`]

## 2. Version boundary

**[SPEC]**

| Evidence set | Version | Permitted use |
|---|---|---|
| Installed desktop | `26.721.31836`, build `5828` | Current renderer/main-process behavior and observed runtime |
| Bundled Codex executable | `codex-cli 0.146.0-alpha.3.1` | Exact implementation shipped inside app build 5828 |
| Matching OpenAI source packet | tag `rust-v0.146.0-alpha.3.1`, commit `ff75c5b939c477c49eb1bd5248da6dab71b109d1` | Exact shipped protocol/source anchors |
| Newer authoritative local OpenAI checkout | tag `rust-v0.146.0-alpha.6`, commit `f474de492a896643efa03481ac03e3f8ffbcbb37` | Current-source corroboration and drift; never silently attributed to build 5828 |
| OMP checkout | July 24 implementation, introduced by `3d64910bb06d043bd0d7c4f7c27bd92105779bbf` | Existing `/live`, extension seams, and gap analysis |

The installed app updated from build 5813 to 5828 during research. Build 5813 was not retained as an independently inspectable artifact, so no 5813 implementation observation is merged into this dossier; every desktop claim is explicitly build 5828. [APP-5828: `Contents/Info.plist:159-175`; installed `Contents/Resources/codex`, `codex --version`; CurrentAppVoice packet version boundary]

## 3. Reports

**[SPEC]**

1. [Current Codex architecture](01-current-codex-architecture.md) — end-to-end ownership and data flow.
2. [Private transport and protocol](02-private-transport-and-protocol.md) — exact consumer route, headers, V3/Frameless wire semantics, and source-version boundary.
3. [Desktop harness and runtime](03-desktop-harness-and-runtime.md) — build-5828 launch, UI, lifecycle, continuity, handoff, screen context, and sanitized runtime observations.
4. [OMP `/live` archaeology and gap analysis](04-omp-live-archaeology-and-gap-analysis.md) — current July implementation, removed January predecessor, and parity deficits.
5. [Plugin parity blueprint](05-plugin-parity-blueprint.md) — extension-owned `/live` cutover and implementation/QA contract.
6. [Evidence inventory](06-evidence-inventory.md) — fact classification, exact source map, redaction rules, and unresolved questions.
7. [CUA SDK native integration](07-cua-sdk-native-integration.md) — SDK/MCP/daemon boundaries and the first-class ComputerTool backend for `/live` screen context.

## 4. Non-goals

**[SPEC]**
- No public OpenAI Realtime API.
- No API-key billing path.
- No local STT/TTS replacement.
- No realtime model substitution.
- No generic transport abstraction.
- No fallback protocol.
- No external Codex app-server as the shipped architecture; it is only a reference/probe strategy. [Design constraint: `05-plugin-parity-blueprint.md`]

## 5. Reading rule

**[NOTE]**
Terms that look similar are intentionally kept separate: desktop app build, Codex source tag, `RealtimeWsVersion`, event parser, alpha-header value, and model name are six different axes. Any future update must change the relevant evidence row rather than relabeling one axis from another.

## 6. Changelog

**[SPEC]**
- 1.0.0 — replaced the obsolete public-API feasibility recommendation with the seven-file exact-private-parity dossier.
