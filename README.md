# agex-ts: Embeddable LLM agents in TypeScript

`agex-ts` is a TypeScript-native agent framework. You define a typed task with `agent.task({...})` and the agent fills it in by writing TypeScript that calls into the modules you've registered. Real values flow in and out without JSON serialization at the boundary, and there's no separate runtime to deploy — agex-ts is a library you import.

The agent's TS runs in an isolated Web Worker by default (or `worker_threads` on Node — [planned](roadmap.md)). Per-session state and an optional virtual filesystem are versioned — one commit captures the whole world; sessions roll back independently. Browser-native: no Pyodide, no wasm Python. Just a Web Worker bundle.

```ts
import { createAgent } from 'agex-ts'
import { workerRuntime } from '@agex-ts/runtime-worker'
import { connectAnthropic } from '@agex-ts/anthropic'
import * as stats from './stats'

const agent = await createAgent({
  name: 'analyst',
  llm: connectAnthropic({ model: 'claude-sonnet-4-6' }),
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

→ Start with the **[Quick Start](docs/quick-start.md)**.

## What you get

- **Typed function tasks** — `agent.task({...})` declares the input/output contract; the agent fulfills it. [Standard Schema](https://standardschema.dev/) (Zod, Valibot, ArkType, …) for runtime validation.
- **Curated TS environment** — register exactly which functions, classes, and namespaces the agent can use. Per-member visibility filters. URL-shipped registrations let you hand the agent a whole library by URL without RPC bridging per call.
- **Worker-isolated runtime** — agent code runs in a Web Worker; no shared globals, no DOM access. In-process `evalRuntime` for tests.
- **Versioned per-session state** — agent's cache, event log, and (optional) virtual filesystem are versioned per session. One `agent.commit(session)` captures everything atomically. Time-travel via `agent.eventsAt(hash, session)`. Built on [kvgit-ts](packages/kvgit-ts).
- **Agent-directed compaction** — when context grows, the agent writes its own chapter summaries. Originals stay browsable at `/chapters/<slug>/`. See [Chapters](docs/concepts/chapters.md).
- **Multi-agent flows are regular control flow** — sub-agents are functions; orchestrators call them like any other. No workflow DSL.

## Packages

This is a small monorepo. Pick what you need:

| Package | Purpose |
|---|---|
| [`agex-ts`](packages/agex-ts) | Core: `Agent`, `createAgent`, registration, task, state, render. |
| [`@agex-ts/runtime-worker`](packages/agex-runtime-worker) | Web Worker runtime adapter. |
| [`@agex-ts/anthropic`](packages/agex-anthropic) | Anthropic provider (`connectAnthropic`). |
| [`@agex-ts/openai`](packages/agex-openai) | OpenAI provider (`connectOpenAI`). |
| [`@agex-ts/gemini`](packages/agex-gemini) | Gemini provider (`connectGemini`). |
| [`kvgit-ts`](packages/kvgit-ts) | Versioned KV store with branches and merge. Powers `state` + the kvgit-backed VFS. Standalone-usable. |
| [`termish-ts`](packages/termish-ts) | Async filesystem protocol + shell command interpreter. Powers the agent's `terminal_action` surface. Standalone-usable. |

## Documentation

In-repo at [`docs/`](docs/):

- **[Quick Start](docs/quick-start.md)** — install, register, define a task, run.
- **[The Big Picture](docs/concepts/big-picture.md)** — architectural thesis.
- **[Concepts](docs/concepts/overview.md)** — sandboxing, state & sessions, chapters.
- **[API Reference](docs/api/overview.md)** — every type and method.

## Installation

```bash
pnpm add agex-ts @agex-ts/anthropic @agex-ts/runtime-worker
# or `@agex-ts/openai` / `@agex-ts/gemini` instead of anthropic
```

For tests / trusted code (no worker isolation), the in-process `evalRuntime` ships with `agex-ts` itself — skip `@agex-ts/runtime-worker`.

### Using with Vite

If you use `@agex-ts/runtime-worker`, add the package to `optimizeDeps.exclude`:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    exclude: ['agex-runtime-worker'],
  },
})
```

Without this, the worker fails to boot with `Error: worker failed during boot: undefined`. Vite pre-bundles dependencies into `node_modules/.vite/deps/`, which rewrites `import.meta.url` away from the package's own `dist/` — breaking the `new URL('./worker.js', import.meta.url)` resolution that loads the worker bundle. Standard quirk that affects any library shipping a worker this way (comlink-based libs, tesseract.js, etc.).

### Working from a clone (this repo)

The package `dist/` directories are gitignored. After a fresh clone, build once before running anything that imports the libraries (tests, downstream apps using `file:` deps, etc.):

```bash
pnpm install
pnpm -r build
```

Each library package also has a `prepare` script, so consumers using `file:` or `git+` references will trigger the build automatically on `npm install` / `pnpm install`.

## Project Status

> **Pre-1.0.** Public API is experimental and may change. The core thesis is settled; surfaces are still narrowing. Wire format, on-disk format, and registration shapes are the most likely to shift before 1.0.

## Relationship to agex (Python)

agex-ts is a [CodeAct](https://arxiv.org/abs/2402.01030)-style harness (agent actions are TypeScript code, not JSON tool calls) with a typed function as the task contract. It's a TypeScript port of [agex](https://github.com/ashenfad/agex), a Python library that brought this shape to library-embeddable form (alongside [smolagents](https://github.com/huggingface/smolagents)). Different runtime: agex uses a pure-Python AST sandbox ([sandtrap](https://github.com/ashenfad/sandtrap)) that runs in-process / subprocess / kernel-isolated / via Pyodide; agex-ts uses Web Worker isolation (and eventually `worker_threads`).

When to pick which:

- **agex-ts** — your stack is TypeScript / Node / browser, you want browser-native (no Pyodide), you want strict TS type-checking on the agent surface, or you're shipping to a TS-only environment (Cloudflare Workers, Deno, edge).
- **agex** (Python) — your stack is Python, you want the data-science library ecosystem (pandas, scikit-learn, plotly), or you need richer in-process sandboxing (sandtrap's tick limits, CPU caps, etc.).

Both projects share the same author and thesis. They're not competitors — they're the same library shape compiled to different ecosystems.

## Contributing

Bug reports, ideas, and pull requests welcome — see [GitHub Issues](https://github.com/ashenfad/agex-ts/issues).
