# @agex-ts/openai

OpenAI Chat Completions provider for [`agex-ts`](https://www.npmjs.com/package/agex-ts). Implements `LLMClient.complete()` against `/v1/chat/completions` using raw `fetch` + SSE — no SDK dependency, runs anywhere `fetch` is available (Node 20+, browsers, edge runtimes).

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

`baseUrl` override makes this drop-in for any OpenAI-compatible server — local models via ollama / vLLM / LM Studio, aggregators like OpenRouter / Together / Anyscale, or your own proxy. The same client handles tool calls, streaming, `AbortSignal` cancellation, and transient-network retry.

**Scope (v1):** Chat Completions API (`gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, local models), streaming, tool calls, cancellation, retry. **Out of scope:** Responses API (`gpt-5` / o-series reasoning models), OpenRouter `reasoning_details` round-trip.

## Quick start

```bash
pnpm add agex-ts @agex-ts/openai
```

```ts
import { createAgent } from 'agex-ts'
import { OpenAI } from '@agex-ts/openai'

const agent = await createAgent({
  name: 'analyst',
  llm: new OpenAI({
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // ...
})
```

Pointing at a local or compatible endpoint:

```ts
const llm = new OpenAI({
  model: 'llama-3.1-70b-instruct',
  baseUrl: 'http://localhost:11434/v1',   // ollama
  apiKey: 'unused',
})
```

## Options

`new OpenAI(opts)` accepts:

| Option | Default | Purpose |
|---|---|---|
| `model` | `gpt-4o-mini` | OpenAI (or compatible) model id. |
| `apiKey` | — | Sent as `Authorization: Bearer <key>`. Required for the public endpoint; may be a dummy value for local servers. |
| `baseUrl` | `https://api.openai.com/v1` | API base URL. Set this for compat servers. |
| `timeoutMs` | `90_000` | Per-request timeout. |
| `maxTokens` | `16_384` | Cap on output tokens. |
| `forceToolUse` | `true` | Sends `tool_choice: 'required'`. Set false for models that don't reliably follow `required` (some local models). |
| `extras` | `{}` | Extra fields merged into the request body (`temperature`, `top_p`, `seed`, `response_format`, etc.). |
| `headers` | `{}` | Per-request header overrides; `null` deletes a default header. |
| `fetchImpl` | global `fetch` | Override `fetch` for tests / custom transports. |

See [the LLM API doc](https://github.com/ashenfad/agex-ts/blob/main/docs/api/llm.md) for the broader provider contract.

## License

MIT
