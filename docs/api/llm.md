# LLM

The LLM client is what the agent's loop streams from. agex-ts ships provider packages for Anthropic, OpenAI, and Gemini, plus a `Dummy` for tests. Embedders can implement their own.

## `LLMClient`

```ts
interface LLMClient {
  complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk>
  dumpConfig(): LLMConfig
}

interface LLMRequest {
  readonly system: string
  readonly turns: ReadonlyArray<NeutralTurn>
}

interface LLMConfig {
  readonly provider: string
  readonly model: string
  readonly timeoutSeconds: number
  readonly extras?: Readonly<Record<string, unknown>>
}
```

`complete(request, signal)` streams a response as `TokenChunk`s. The agent loop forwards chunks to `onToken` and assembles full `Emission`s from `done` boundaries. `dumpConfig()` serializes the client's configuration for transport (e.g. when state config carries the LLM shape across a worker boundary).

`NeutralTurn` is agex-ts's provider-agnostic conversation shape — `{ role: 'user' | 'assistant', content: NeutralPart[] }`. Provider clients lower these into their wire format (Anthropic content blocks, OpenAI tool messages, Gemini parts arrays).

## Provider packages

### `@agex-ts/anthropic`

```ts
import { connectAnthropic } from '@agex-ts/anthropic'

const llm = connectAnthropic({
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY,        // optional; defaults to env
  timeoutSeconds: 30,
  // ... extras
})
```

Returns an `LLMClient` that streams from Anthropic's Messages API. Tool-use blocks for the four built-in tools (`ts_action`, `terminal_action`, `write_file`, `edit_file`) are wired automatically.

### `@agex-ts/openai`

```ts
import { connectOpenAI } from '@agex-ts/openai'

const llm = connectOpenAI({
  model: 'gpt-4.1-nano',
  apiKey: process.env.OPENAI_API_KEY,
  timeoutSeconds: 30,
})
```

Returns an `LLMClient` for OpenAI's Chat Completions / Tool Use APIs.

### `@agex-ts/gemini`

```ts
import { connectGemini } from '@agex-ts/gemini'

const llm = connectGemini({
  model: 'gemini-2.5-pro',
  apiKey: process.env.GEMINI_API_KEY,
  timeoutSeconds: 30,
})
```

Returns an `LLMClient` for Google's Gemini API.

## `Dummy` (for tests)

```ts
import { Dummy } from 'agex-ts/llm-dummy'

const llm = new Dummy({
  responses: [
    { emissions: [{ type: 'ts', code: 'taskSuccess(42)' }], inputTokens: 100 },
  ],
})
```

Cycles through the configured responses in order, one per `complete()` call. Useful for unit-testing the agent loop without burning API tokens or testing for non-determinism. The `responses` array can include `Error` instances to simulate provider failures.

`Dummy` exposes `callCount`, `allTurns`, and `allSystems` for assertions about what the agent loop sent on each turn.

## Configuration

| Field | Purpose |
|---|---|
| `model` | The provider's model identifier. |
| `apiKey` | API key; usually defaults to a provider-specific env var. |
| `timeoutSeconds` | Per-call timeout. Defaults vary by provider. |
| `extras` | Provider-specific knobs (max_tokens, temperature, top_p, etc.). |

Each provider's connector supports its native knobs; check the provider package's source for the exact `extras` shape.

## Streaming model

`complete(request, signal)` yields `TokenChunk`s as the provider streams. The agent loop:

1. Forwards each chunk to `options.onToken` (if set).
2. Assembles full `Emission`s from `done` boundaries within the chunk stream.
3. After the stream completes, the assembled emissions become an `ActionEvent`.

`TokenChunk` shape:

```ts
interface TokenChunk {
  readonly type: TokenChunkType
  readonly text?: string
  readonly emission?: Emission       // present on `done` chunks
  readonly inputTokens?: number      // from final chunk
  readonly outputTokens?: number
  readonly done?: boolean
}
```

See `agex-ts/src/types.ts` for the full `TokenChunkType` union.

## Implementing a custom client

```ts
import type { LLMClient, LLMRequest, LLMConfig, TokenChunk } from 'agex-ts'

class MyLLM implements LLMClient {
  async *complete(req: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk> {
    // Stream tokens; yield TokenChunks; finally yield a done chunk with the
    // assembled emission.
  }
  dumpConfig(): LLMConfig {
    return { provider: 'mine', model: '...', timeoutSeconds: 30 }
  }
}
```

Useful for self-hosted models, local inference (llama.cpp, MLX), and provider proxies. The agex-ts core never reaches past `LLMClient` — wiring up a custom client is the whole job.

## Retry and resilience

agex-ts core does not retry failed LLM calls automatically. Provider clients implement transient-error retry (e.g. `@agex-ts/anthropic` retries `TypeError` once before giving up — useful for browser fetch transient failures). The agent loop catches errors as `ErrorEvent` and lets the agent see and react.

For aggressive retry policies, wrap your `LLMClient` in a thin adapter that retries `complete()` on configured failures.
