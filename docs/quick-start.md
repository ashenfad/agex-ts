# Quick Start

Get an agex-ts agent calling your code in five minutes.

## Install

```bash
pnpm add agex-ts @agex-ts/anthropic @agex-ts/runtime-worker
```

(`@agex-ts/openai` and `@agex-ts/gemini` are interchangeable provider packages — pick one.)

## Smallest possible agent

For tests and examples, the in-process `evalRuntime` skips the worker boundary. Same agent surface as production; no isolation.

```ts
import { createAgent } from 'agex-ts'
import { evalRuntime } from 'agex-ts/runtime-eval'
import { Anthropic } from '@agex-ts/anthropic'

const agent = await createAgent({
  name: 'greeter',
  llm: new Anthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY }),
  runtime: evalRuntime(),
})

const greet = agent.task<string, string>({
  description: 'Return a friendly greeting for the given name.',
})

const out = await greet('Ada')
console.log(out) // → "Hello, Ada — welcome!"
```

The `description` is what the agent sees. The agent emits a `ts` action calling `taskSuccess(...)` with a string; agex-ts validates against the typed contract and returns it.

## Registering your code

The agent's action space is TypeScript that calls into the things you register. Three primary shapes: functions, namespaces, classes.

```ts
const agent = await createAgent({
  name: 'data',
  llm: new Anthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY }),
  runtime: evalRuntime(),
})

// A standalone function
agent.fn(
  (...args: unknown[]) => {
    const xs = args[0] as number[]
    return xs.reduce((s, x) => s + x, 0) / xs.length
  },
  { name: 'mean', description: 'Arithmetic mean of an array of numbers.' },
)

// A whole module exposed as a namespace
import * as stats from './stats'
agent.namespace(stats, {
  name: 'stats',
  description: 'Statistical helpers — mean, stdev, percentile.',
})

// A class — agent can `new` instances and call methods
class Vec {
  constructor(public x: number, public y: number) {}
  magnitude() { return Math.sqrt(this.x * this.x + this.y * this.y) }
}
agent.cls(Vec, { description: '2D vector with magnitude().' })
```

The agent then emits TS like:

```ts
const m = mean([1, 2, 3])
const v = new Vec(3, 4)
taskSuccess({ avg: m, magnitude: v.magnitude() })
```

If you want the agent to reach for arbitrary npm-style imports without pre-registering each one, add a `namespaceResolver` on `AgentOptions` — the runtime calls it for any specifier the registry doesn't know:

```ts
const agent = await createAgent({
  name: 'data',
  llm,
  runtime: evalRuntime(),
  namespaceResolver: (name) => `https://esm.sh/${name}`,
})
```

See [Registration § namespaceResolver](api/registration.md#namespaceresolver) for the contract and tradeoffs.

## Tasks: typed contracts

`agent.task({...})` returns a typed function. The agent fills in the body.

```ts
interface Sale { product: string; amount: number }

const summarize = agent.task<Sale[], { total: number; topProduct: string }>({
  description: 'Compute total sales and identify the highest-grossing product.',
})

const result = await summarize([
  { product: 'A', amount: 100 },
  { product: 'B', amount: 250 },
  { product: 'C', amount: 80 },
])
//   ^? { total: number; topProduct: string }
```

The typed input becomes the `inputs` variable inside the agent's TS action. The typed output is enforced — if the agent calls `taskSuccess` with a value that doesn't match a [Standard Schema](https://standardschema.dev/) you supply, it sees a validation error and tries again.

For full validation, attach a schema:

```ts
import { z } from 'zod'

const summarize = agent.task({
  description: 'Compute total sales and identify the highest-grossing product.',
  input: z.array(z.object({ product: z.string(), amount: z.number() })),
  output: z.object({ total: z.number(), topProduct: z.string() }),
})
```

Without a schema, the typed call signature is enforced at the TS layer (compile time) but runtime values pass through.

## Production runtime: workers

For production, use `@agex-ts/runtime-worker` — agent code runs in an isolated Web Worker. Browser-side today; Node `worker_threads` is on the [roadmap](https://github.com/ashenfad/agex-ts/blob/main/roadmap.md).

```ts
import { createAgent } from 'agex-ts'
import { workerRuntime } from '@agex-ts/runtime-worker'
import { Anthropic } from '@agex-ts/anthropic'

const agent = await createAgent({
  name: 'analyst',
  llm: new Anthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY }),
  runtime: workerRuntime({
    workerUrl: new URL('./worker.js', import.meta.url),
  }),
  state: { type: 'versioned', storage: 'indexeddb' },
})
```

The worker bundle is shipped by `@agex-ts/runtime-worker`. You point `workerUrl` at it; the runtime spawns the worker, configures it with your registered policy, and dispatches each `ts_action` emission across the postMessage boundary.

## Sessions: isolated histories per caller

Tasks accept an optional `session` — a string identifier that picks the substrate. Each session gets its own kvgit `VersionedKV`, so its event log, cache, and (if configured) VFS roll back independently.

```ts
const ask = agent.task<string, string>({ description: 'Answer the question.' })

await ask('What is the capital of France?', { session: 'alice' })
await ask('Tell me a joke.',                { session: 'bob' })
```

Default session is `"default"`. Each caller (user, request, queue job) typically maps to one session.

## Running it: a complete script

```ts
import { createAgent } from 'agex-ts'
import { evalRuntime } from 'agex-ts/runtime-eval'
import { Anthropic } from '@agex-ts/anthropic'

const agent = await createAgent({
  name: 'arith',
  llm: new Anthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY }),
  runtime: evalRuntime(),
})

agent.fn((...a: unknown[]) => (a[0] as number) + (a[1] as number), {
  name: 'add', description: 'Add two numbers.',
})
agent.fn((...a: unknown[]) => (a[0] as number) * (a[1] as number), {
  name: 'mul', description: 'Multiply two numbers.',
})

const compute = agent.task<{ a: number; b: number }, number>({
  description: 'Compute (a + b) * b using the registered helpers.',
})

console.log(await compute({ a: 3, b: 4 })) // → 28
```

Save as `quick.ts`, set `ANTHROPIC_API_KEY`, run with `tsx quick.ts`.

## What's next

- **[The Big Picture](concepts/big-picture.md)** — why agex-ts is shaped this way and how it differs from JSON-tool frameworks.
- **[State & Sessions](concepts/state-and-sessions.md)** — kvgit-backed substrate, sessions as isolated VersionedKVs, atomic commits across state + VFS.
- **[Chapters](concepts/chapters.md)** — agent-directed context compaction.
- **[API Reference](api/overview.md)** — every type and method.
