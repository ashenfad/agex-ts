# Task

A task is a typed callable. You declare its description and shape via `agent.task({...})`; the agent fills in the body by emitting TypeScript that calls into your registrations.

## `agent.task({...})`

```ts
agent.task<I, O>(def: TaskDefinition<I, O>): TaskFn<I, O>

interface TaskDefinition<I, O> {
  readonly description: string
  readonly input?: StandardSchemaV1<I, I>
  readonly output?: StandardSchemaV1<O, O>
  readonly inputJsonSchema?: object
  readonly outputJsonSchema?: object
  readonly inputDescription?: string
  readonly outputDescription?: string
  readonly primer?: string
}

type TaskFn<I, O> = (input: I, options?: TaskCallOptions) => Promise<O>
```

Returns a typed function. Each call drives the agent's action loop: render the system prompt, send to the LLM, dispatch each emission, observe outputs, iterate until the agent calls `taskSuccess` / `taskFail` / `taskClarify` (or hits `maxIterations`).

```ts
const summarize = agent.task<string[], string>({
  description: 'Compose a one-paragraph summary of the input lines.',
})

const out = await summarize(['Q1 was strong.', 'Q2 had a downturn.', 'Q3 recovered.'])
```

## Schemas (Standard Schema)

Validation hooks via [Standard Schema](https://standardschema.dev/) — Zod, Valibot, ArkType, and others all work transparently.

```ts
import { z } from 'zod'

const summarize = agent.task({
  description: 'Compute total sales and identify the top product.',
  input: z.array(z.object({ product: z.string(), amount: z.number() })),
  output: z.object({ total: z.number(), topProduct: z.string() }),
})
```

| Schema | Where it runs | What happens on failure |
|---|---|---|
| `input` | Before the task starts; on the host | `SchemaError` thrown to the caller — agent never runs |
| `output` | When the agent calls `taskSuccess(...)` | Agent sees a runtime error and tries again |

When you provide `input`/`output` schemas, agex-ts also extracts a JSON Schema view to surface the shape to the agent. Override with `inputJsonSchema` / `outputJsonSchema` for a curated representation (e.g., to hide implementation fields), or `inputDescription` / `outputDescription` for prose where schema introspection isn't enough.

Without schemas, the typed call signature is enforced at compile time but runtime values pass through unchecked.

## Per-task `primer`

```ts
const summarize = agent.task({
  description: 'Summarize line items.',
  primer: 'Be terse — one sentence, no marketing language.',
})
```

The `primer` is appended to the per-task user message (after `description`, before the inputs block). Use it for task-specific guidance that the agent's overall `primer` (set on `AgentOptions`) doesn't cover.

## `TaskCallOptions`

```ts
interface TaskCallOptions {
  readonly session?: string                                // default "default"
  readonly signal?: AbortSignal
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>
  readonly onToken?: (token: TokenChunk) => void | Promise<void>
}
```

### `session`

Picks the substrate. Each session is its own kvgit `VersionedKV` — its own commit chain, event log, cache, and (if configured) VFS. See [State & Sessions](../concepts/state-and-sessions.md).

```ts
await summarize(items, { session: 'q1-2026' })
```

### `signal`

Cancellation. The agent loop checks at iteration boundaries and threads the signal into both the LLM client and the runtime adapter.

```ts
const ac = new AbortController()
setTimeout(() => ac.abort(), 30_000)

try {
  await summarize(items, { signal: ac.signal })
} catch (e) {
  if (e instanceof CancelledError) {
    // Aborted — partial output accumulated up to the abort
  }
}
```

### `onEvent`

Fired for every event written to the session's log. Use for live progress UIs:

```ts
await summarize(items, {
  onEvent: (e) => {
    if (e.type === 'taskStart') console.log('starting:', e.taskName)
    if (e.type === 'output')    console.log('output:', e.parts)
    if (e.type === 'success')   console.log('done:', e.result)
  },
})
```

See [Events](events.md) for the full event taxonomy.

### `onToken`

Fired for every streaming token chunk from the LLM. Includes `start` / `delta` / `done` markers per emission, plus tokenization stats. Use for typewriter-style UIs.

## The action loop

What happens inside one `await summarize(...)` call:

1. **Resolve session** — the session's VFS, cache, event log are looked up (or created on first touch).
2. **Validate input** — if `def.input` is set, validate. Failure throws `SchemaError`.
3. **Initialize runtime** — `runtimeAdapter.init(policy)` once per task call.
4. **Refresh skills overlay** — newly registered skills become browseable.
5. **Append `TaskStartEvent`** — with the per-task user message.
6. **Loop** (up to `maxIterations`):
    - Render conversation: system message + every event in the log → `NeutralTurn[]`.
    - Stream from LLM, assemble emissions.
    - Append `ActionEvent` carrying the emissions.
    - Check chaptering trigger; run chapter task if needed.
    - Dispatch each emission (`ts` → runtime; `terminal` → termish; `fileWrite` / `fileEdit` → VFS).
    - If outcome is `success` / `fail` / `clarify` — log the corresponding event and return.
    - Otherwise (continue), iterate.
7. **Loop budget exhausted** — log a `FailEvent` and throw `TaskFailError`.

## Outcomes

The agent decides task lifecycle by calling one of three injected functions inside its TS:

| Call | Result |
|---|---|
| `taskSuccess(value)` | Validate `value` against `def.output` if set; resolve the task with the validated value. |
| `taskFail(message)` | Reject the task with `TaskFailError(message)`. The agent has decided the task is impossible. |
| `taskClarify(message)` | Reject with `TaskClarifyError(message)`. The agent needs human input — distinct from failure. |

A turn that doesn't call any of these falls off the end and the loop iterates. See [Errors](errors.md).

## Multi-agent: tasks calling tasks

Tasks are functions; orchestrators call them like any other function. There's no special "sub-agent" type or workflow DSL.

```ts
const research = orchestrator.task<string, Report>({ description: 'Research a topic.' })
const critique = critic.task<Report, Review>({ description: 'Review a report.' })

let report = await research('AI trends in 2025')
while (true) {
  const review = await critique(report)
  if (review.approved) break
  report = await hone(review.feedback, report)
}
```

Each task call gets its own session resolution, event log, and lifecycle. Sessions are not shared across agents — `orchestrator.session('alice')` and `critic.session('alice')` are two separate substrates because they're two different agents.

## Cancellation semantics

When `signal.aborted` fires:

1. The current LLM streaming call is aborted (provider-specific cancellation).
2. The current `runtimeAdapter.execute(...)` is signaled. Under `workerRuntime`, the worker is terminated; the next task call will spawn a fresh one.
3. A `CancelledEvent` is appended to the log.
4. `await summarize(...)` rejects with `CancelledError`.

Partial output (events appended before the abort) stays in the log.

## Examples

### Simple task

```ts
const greet = agent.task<string, string>({ description: 'Greet the user by name.' })
await greet('Ada')
```

### Schema-validated task

```ts
const compute = agent.task({
  description: 'Sum and average the input numbers.',
  input: z.array(z.number()),
  output: z.object({ total: z.number(), mean: z.number() }),
})
const result = await compute([1, 2, 3, 4])
//   ^? { total: number; mean: number }
```

### Multi-session

```ts
await analyze(data, { session: 'tenant-A' })
await analyze(data, { session: 'tenant-B' })
// Two separate substrates, two separate event logs.
```

### Cancelled task

```ts
const ac = new AbortController()
setTimeout(() => ac.abort(), 5_000)
try {
  await longTask(input, { signal: ac.signal })
} catch (e) {
  if (e instanceof CancelledError) console.log('cancelled')
  else throw e
}
```
