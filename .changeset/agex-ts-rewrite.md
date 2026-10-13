---
"agex-ts": minor
---

Breaking: agex-ts is rewritten as a loop over `@agex-ts/world`. This step holds the run record (`Run`, `Message` and their parts, `loadRun`/`dumpRun`), the provider protocol (`Provider`, `stream` with an abort signal, `transient`), `ScriptedProvider`, and agex's shape corpus at `agex-ts/conformance`. The previous design's API is gone, and with it `@agex-ts/runtime-worker`, `@agex-ts/git`, `@agex-ts/anthropic`, `@agex-ts/openai` and `@agex-ts/gemini`, replaced by the world's kernel and ws-git and, to come, the AI SDK's providers.
