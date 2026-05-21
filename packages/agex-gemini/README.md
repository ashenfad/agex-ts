# @agex-ts/gemini

Google Gemini provider for [`agex-ts`](https://www.npmjs.com/package/agex-ts). Implements `LLMClient.complete()` against Gemini's `:streamGenerateContent?alt=sse` endpoint — no SDK dependency, raw `fetch` + SSE. Same architecture as `@agex-ts/anthropic` and `@agex-ts/openai`.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

Lowers the agex-ts neutral turn shape into Gemini's `Content[]` and round-trips Gemini 3 native thought parts via `thought_signature`. `tool_config.mode = ANY` is used so the model emits a function call each turn — the agex action tools (`ts_action`, `terminal_action`, `write_file`, `edit_file`) are declared from the shared schemas in `agex-ts/render`.

**Scope (v1):** streaming `generateContent` with function calling, Gemini 3 native thought signatures, `AbortSignal` cancellation, transient-network retry. **Out of scope:** grounding tools (`google_search`, `url_context`), Vertex AI auth (only AI Studio API-key auth), file / video parts in multimodal input.

## Quick start

```bash
pnpm add agex-ts @agex-ts/gemini
```

```ts
import { createAgent } from 'agex-ts'
import { Gemini } from '@agex-ts/gemini'

const agent = await createAgent({
  name: 'analyst',
  llm: new Gemini({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GEMINI_API_KEY,
  }),
  // ...
})
```

## Options

`new Gemini(opts)` accepts:

| Option | Default | Purpose |
|---|---|---|
| `model` | `gemini-2.5-flash` | Gemini model id (e.g. `gemini-2.5-pro`, `gemini-3.1-flash`). |
| `apiKey` | — | AI Studio API key. Sent as `x-goog-api-key`. |
| `baseUrl` | `https://generativelanguage.googleapis.com/v1beta` | API base URL. |
| `timeoutMs` | `90_000` | Per-request timeout. |
| `maxOutputTokens` | `16_384` | Cap on output tokens (`generationConfig.maxOutputTokens`). |
| `forceToolUse` | `true` | Sends `tool_config.function_calling_config.mode = 'ANY'`. Set false to allow text-only turns. |
| `nativeThinking` | `true` | Surface Gemini 3 signed thought parts so they round-trip on subsequent turns. |
| `generationConfig` | `{}` | Extra fields merged into `generationConfig` (`temperature`, `topP`, `topK`, etc.). |
| `headers` | `{}` | Per-request header overrides; `null` deletes a default header. |
| `fetchImpl` | global `fetch` | Override `fetch` for tests / custom transports. |

See [the LLM API doc](https://github.com/ashenfad/agex-ts/blob/main/docs/api/llm.md) for the broader provider contract.

## License

MIT
