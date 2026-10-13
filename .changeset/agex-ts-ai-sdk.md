---
"agex-ts": minor
---

**AI SDK models:** `new Agent({ model })` takes any AI SDK `LanguageModelV4` and drives its `doStream` through `AiSdkProvider`, without the AI SDK's core. `settings.thinking` is the spec's reasoning effort, provider metadata (signatures, encrypted reasoning) is kept on the record's parts and sent back to its provider alone, `settings.extra` is provider options, and rate limits, overloads and unreachable providers interrupt a run. Depends on `@ai-sdk/provider`.
