# @agex-ts/anthropic

Anthropic Messages API provider for [`agex-ts`](https://www.npmjs.com/package/agex-ts). Implements `LLMClient.complete()` by lowering the agex-ts neutral turn shape into Anthropic's content blocks and streaming the response via SSE — no SDK dependency, runs anywhere `fetch` is available (Node 20+, browsers, edge runtimes).

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

The four agex action tools (`ts_action`, `terminal_action`, `write_file`, `edit_file`) are declared from the shared schemas in `agex-ts/render`; this package only handles the Anthropic-specific envelope translation, prompt caching, extended thinking, and SSE parsing.

## Quick start

```bash
pnpm add agex-ts @agex-ts/anthropic
```

```ts
import { createAgent } from 'agex-ts'
import { Anthropic } from '@agex-ts/anthropic'

const agent = await createAgent({
  name: 'analyst',
  llm: new Anthropic({
    model: 'claude-sonnet-4-6',
    apiKey: process.env.ANTHROPIC_API_KEY,
  }),
  // ...
})
```

## Options

`new Anthropic(opts)` accepts:

| Option | Default | Purpose |
|---|---|---|
| `model` | `claude-sonnet-4-5` | Anthropic model id. |
| `apiKey` | — | Sent as `x-api-key`. Required for the public endpoint; optional when paired with a `fetchImpl` that injects auth. |
| `baseUrl` | `https://api.anthropic.com/v1` | API base URL. Override for proxies. |
| `timeoutMs` | `90_000` | Per-request timeout. |
| `nativeThinking` | `true` | Use Claude 4+ native thinking blocks (replayable signatures). |
| `thinkingBudget` | `2048` | Token budget for extended thinking. Anthropic requires ≥ 1024. |
| `maxTokens` | `16384` | Cap on output tokens. |
| `extras` | `{}` | Extra fields merged into the request body (`temperature`, `top_p`, etc.). |
| `browserDirectAccess` | `false` | Sends `anthropic-dangerous-direct-browser-access: true` for trusted browser contexts. |
| `headers` | `{}` | Per-request header overrides; `null` deletes a default header (useful for OpenAI-compat endpoints that reject `anthropic-version`). |
| `fetchImpl` | global `fetch` | Override `fetch` for tests / custom transports. |

See [the LLM API doc](https://github.com/ashenfad/agex-ts/blob/main/docs/api/llm.md) for the broader provider contract.

## License

MIT
