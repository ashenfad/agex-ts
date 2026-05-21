# agex-ts

Embeddable LLM-agent primitive for TypeScript. You define a typed task with `agent.task({...})` and the agent fills it in by writing TypeScript that calls into the modules you've registered. Real values flow in and out without JSON serialization at the boundary, and there's no separate runtime to deploy — `agex-ts` is a library you import.

> **Status:** Pre-1.0. Public API is experimental and may change. Wire format, on-disk format, and registration shapes are the most likely to shift before 1.0.

## Concept

A [CodeAct](https://arxiv.org/abs/2402.01030)-style harness: the agent's action space is TypeScript code, not JSON tool calls. The agent's TS runs in an isolated Web Worker (via [`@agex-ts/runtime-worker`](https://www.npmjs.com/package/@agex-ts/runtime-worker)) or in-process via `evalRuntime` for tests. Per-session state is versioned by [`kvgit-ts`](https://www.npmjs.com/package/kvgit-ts); one commit captures cache, event log, and (optional) virtual filesystem together.

## Quick start

```bash
pnpm add agex-ts @agex-ts/runtime-worker @agex-ts/anthropic
```

```ts
import { createAgent } from 'agex-ts'
import { workerRuntime } from '@agex-ts/runtime-worker'
import { Anthropic } from '@agex-ts/anthropic'
import * as stats from './stats'

const agent = await createAgent({
  name: 'analyst',
  llm: new Anthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY }),
  runtime: workerRuntime({ workerUrl: new URL('./worker.js', import.meta.url) }),
  state: { type: 'versioned', storage: 'indexeddb' },
})
agent.namespace(stats, { name: 'stats', description: 'Stats helpers.' })

const summarize = agent.task<number[], { mean: number; stdev: number }>({
  description: 'Compute mean and stdev of the input values.',
})

const result = await summarize([3, 1, 4, 1, 5, 9, 2, 6])
//   ^? { mean: number; stdev: number }
```

For tests or trusted code without worker isolation, swap `workerRuntime` for `evalRuntime` from `agex-ts/runtime-eval` — same realm as the host.

## Sub-path imports

The default `agex-ts` import is the lean surface (`Agent`, `createAgent`, types, errors, `prettyEvents`). Heavier surfaces live behind sub-paths so unused code paths tree-shake cleanly:

| Sub-path | What it exports |
|---|---|
| `agex-ts/types` | Contract types only, no runtime code. |
| `agex-ts/state` | `connectState`, `Live`, `KvgitState`, backend types. |
| `agex-ts/llm-dummy` | `Dummy` LLM client for tests. |
| `agex-ts/runtime-eval` | Same-realm `evalRuntime` `RuntimeAdapter`. |
| `agex-ts/render` | Shared action-tool schemas used by providers. |
| `agex-ts/providers` | Provider-internal helpers (`NeutralTurn`, lowering utilities). |

Production runtime (`@agex-ts/runtime-worker`) and provider clients (`@agex-ts/anthropic`, `@agex-ts/openai`, `@agex-ts/gemini`) ship as separate packages.

## Documentation

Full docs live in the [repo](https://github.com/ashenfad/agex-ts/tree/main/docs):

- [Quick Start](https://github.com/ashenfad/agex-ts/blob/main/docs/quick-start.md)
- [The Big Picture](https://github.com/ashenfad/agex-ts/blob/main/docs/concepts/big-picture.md)
- [Concepts](https://github.com/ashenfad/agex-ts/blob/main/docs/concepts/overview.md) — sandboxing, state & sessions, chapters
- [API Reference](https://github.com/ashenfad/agex-ts/blob/main/docs/api/overview.md)

## Relationship to agex (Python)

`agex-ts` is a TypeScript port of [agex](https://github.com/ashenfad/agex). Same thesis, different runtime: `agex` uses a pure-Python AST sandbox ([sandtrap](https://github.com/ashenfad/sandtrap)); `agex-ts` uses Web Worker isolation (and eventually `worker_threads`). Pick `agex-ts` for browser-native deployments or a TS-only stack; pick `agex` (Python) for the data-science library ecosystem.

## License

MIT
