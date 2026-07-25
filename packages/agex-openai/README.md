# @agex-ts/openai

OpenAI Chat Completions provider for [`agex-ts`](https://www.npmjs.com/package/agex-ts). Implements `LLMClient.complete()` against `/v1/chat/completions` using raw `fetch` + SSE — no SDK dependency, runs anywhere `fetch` is available (Node 20+, browsers, edge runtimes).

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

`baseUrl` override makes this drop-in for any OpenAI-compatible server — local models via ollama / vLLM / LM Studio, aggregators like OpenRouter / Together / Anyscale, or your own proxy. The same client handles tool calls, streaming, `AbortSignal` cancellation, and transient-network retry.

**Scope:** Chat Completions API, streaming, tool calls, cancellation, retry,
and opt-in native reasoning for OpenAI-compatible extensions. The client
normalizes streamed `reasoning`, `reasoning_content`, and visible
`reasoning_details` text into agex thinking events. Namespaced uncodex
reasoning details are also retained as hidden opaque thinking signatures and
replayed verbatim on later requests. **Out of scope:** the Responses API.

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
    model: 'gpt-5',
    apiKey: process.env.OPENAI_API_KEY,
    nativeThinking: true,
    reasoningEffort: 'medium',
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
| `actionSurface` | `agex` | Set to `agex-patch` to advertise `apply_patch` instead of `write_file` / `edit_file`, or `provider-native` for a compatibility endpoint that supplies its own shell/file tools. In provider-native mode only `ts_action` is advertised and forced dynamic-tool selection is disabled. Set the same value on `AgentOptions`. |
| `nativeThinking` | `false` | Uses the provider reasoning channel, removes narration-style `thinking` from action schemas, and surfaces streamed reasoning as agex thinking events. |
| `reasoningEffort` | `medium` | Sends OpenAI-style `reasoning_effort` when native thinking is enabled. |
| `extras` | `{}` | Extra fields merged into the request body (`temperature`, `top_p`, `seed`, `response_format`, etc.). |
| `headers` | `{}` | Per-request header overrides; `null` deletes a default header. |
| `fetchImpl` | global `fetch` | Override `fetch` for tests / custom transports. |

`provider-native` is intended for bridges that translate provider-native
workspace actions back into agex events. A typical compatible endpoint also
needs an opt-in request field in `extras`; consult that bridge's documentation.
Ordinary OpenAI and OpenAI-compatible endpoints should keep the default `agex`
surface.

`agex-patch` is useful with GPT/Codex-style models that natively produce the
`*** Begin Patch` grammar. A provider-native bridge may also return an
`apply_patch` call even though only `ts_action` was advertised; the shared
parser preserves it as a single patch emission and dispatches it against the
agent VFS.

See [the LLM API doc](https://github.com/ashenfad/agex-ts/blob/main/docs/api/llm.md) for the broader provider contract.

## License

MIT
