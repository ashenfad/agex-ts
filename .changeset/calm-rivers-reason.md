---
"@agex-ts/openai": minor
---

Add opt-in native reasoning to the Chat Completions client. The provider now
supports `nativeThinking` and `reasoningEffort`, strips schema-level narration
when native mode is active, normalizes common streamed reasoning extensions,
and replays visible reasoning text across tool turns.
