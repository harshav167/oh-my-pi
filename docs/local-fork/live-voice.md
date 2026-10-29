# Live voice

Owner: `local/live-voice`, independently based on the reviewed upstream `7f98973eb8`. It was already synchronized and was not rebased again.

Retain the existing live entry points, caller-owned SDP, OAuth/proxy/attestation handling, reconnect ordering and ordinary AgentSession execution gates. Native media owns microphone/speaker streams, timestamped processing, bounded queues and loss recovery; these mechanisms do not establish physical audibility or acoustic effectiveness.

Preserve bounded, XML-safe delegation, completed-utterance fallback, durable transcripts and start/end context, answer-generation suppression, background answers and the 500 ms speaking hold. Raw voice transcript records are not separately sent to the model. Persistent live/editor surfaces must survive dialogs, editor replacement and the global stop shortcut.

Retain `live.voice` and prompt-level `live.answerLength`; custom instructions receive `username`, `firstName`, `user_first_name` and `answerLength`. OAuth uses the local `authSessionId` when supplied, while wire identifiers retain `sessionId`. History supplies its ownership/privacy integration; file media remains Video-owned.

The final two-file consumer run passed 12 tests and 87 assertions. Combined native/build/install checks remain separate. Live API acceptance, physical audio/AEC and other-platform behavior remain unverified.
