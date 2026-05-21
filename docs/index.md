# agex-ts: Embeddable LLM Agents in TypeScript

**`agex-ts`** is a TypeScript-native agentic framework that lets LLM agents take action by writing TypeScript that calls into your registered functions, classes, and modules. The agent's code runs in an isolated Web Worker (or Node `worker_threads`), with state and a virtual filesystem persisted in a versioned kvgit substrate.

## What makes this different

Most agent frameworks ask you to define tools — JSON schemas wrapping your code, the model picking from a list, arguments serializing across a boundary on every call. agex-ts doesn't have that boundary. You hand the agent your existing TypeScript code via registration, define a typed task, and the agent fills in the body by emitting TS that calls your functions directly. Real values flow in and out without JSON wrapping.

```ts
import { createAgent } from 'agex-ts'
import { workerRuntime } from '@agex-ts/runtime-worker'
import { Anthropic } from '@agex-ts/anthropic'

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

## Core ideas

- **Code as the medium.** The agent's action surface is TypeScript: emit code, run it in a sandboxed worker, observe what came back, iterate.
- **Library shape, not service.** agex-ts is a library you import. The agent is something you call, like a typed function. Multi-agent flows are just function calls.
- **Worker-isolated runtime.** Agent code runs in a Web Worker by default — no shared globals, no eval-in-host. URL-shipped registrations let you ship code into the worker realm without piping every call through `postMessage`.
- **Versioned state, browsable history.** Agent state, cache, event log, and (optionally) the agent's VFS all live in one kvgit substrate per session. One commit captures the whole world. Roll back any session independently.
- **Agent-directed compaction.** When context grows, the agent writes its own chapter summaries. Originals stay browsable at `/chapters/<slug>/`.

## Get started

- **[Quick Start](quick-start.md)** — install, register a function, define a task, run it.
- **[The Big Picture](concepts/big-picture.md)** — the architectural thesis and how the pieces fit.
- **[API Reference](api/overview.md)** — typed contracts for every component.
- **[Concepts](concepts/overview.md)** — sandboxing, state & sessions, chapters.

## Packages

agex-ts is a small monorepo. Pick what you need:

| Package | Purpose |
|---|---|
| `agex-ts` | Core: `Agent`, `createAgent`, registration, task, state, render. |
| `@agex-ts/runtime-worker` | Web Worker runtime adapter (browser today; Node `worker_threads` planned). |
| `@agex-ts/anthropic` | Anthropic provider (`Anthropic`). |
| `@agex-ts/openai` | OpenAI provider (`OpenAI`). |
| `@agex-ts/gemini` | Gemini provider (`Gemini`). |
| `@agex-ts/kvgit` | Versioned KV store powering state. Standalone-usable. |
| `@agex-ts/termish` | Async filesystem protocol + parser/interpreter for `terminal_action`. Standalone-usable. |

## Status

> **Pre-1.0.** Public API is experimental and may change. The core thesis is settled; surfaces are still narrowing. Wire format, on-disk format (kvgit polymorphic encoder), and registration shapes are the most likely to shift.

## Built on

- **[@agex-ts/kvgit](https://github.com/ashenfad/agex-ts/tree/main/packages/kvgit-ts)** — versioned KV store with HAMT-backed branches and three-way merge.
- **[@agex-ts/termish](https://github.com/ashenfad/agex-ts/tree/main/packages/termish-ts)** — async filesystem protocol with shell-style command interpreter for the agent's `terminal_action` surface.
