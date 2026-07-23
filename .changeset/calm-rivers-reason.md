---
"@agex-ts/openai": minor
---

Add opt-in native reasoning to the Chat Completions client. The provider now
supports `nativeThinking` and `reasoningEffort`, strips schema-level narration
when native mode is active, normalizes common streamed reasoning extensions,
replays visible reasoning text across tool turns, and losslessly retains
uncodex encrypted reasoning items in hidden agex thinking signatures.
