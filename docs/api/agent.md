# Agent

`Agent` is the host-facing surface that ties registration, state, and tasks together. Construct via `createAgent({...})` (async).

## `createAgent(opts)`

```ts
async function createAgent(opts: AgentOptions): Promise<Agent>
```

Async factory — handles awaitable state setup (IDB / SQLite open). Returns a configured `Agent`.

```ts
import { createAgent } from 'agex-ts'
import { connectAnthropic } from '@agex-ts/anthropic'
import { evalRuntime } from 'agex-ts/runtime-eval'

const agent = await createAgent({
  name: 'analyst',
  llm: connectAnthropic({ model: 'claude-sonnet-4-6' }),
  runtime: evalRuntime(),
  state: { type: 'versioned', storage: 'memory' },
})
```

## `AgentOptions`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `name` | `string` | required | Display name. Used in event logs and error messages. |
| `primer` | `string` | `undefined` | System-prompt addendum (the agent's voice). |
| `llm` | `LLMClient` | `undefined` | LLM driver. Required for any task that calls the model. |
| `runtime` | `RuntimeAdapter` | `undefined` | Runtime that executes `ts` emissions. Required for any task. |
| `state` | `StateConfig` | `{ type: 'live' }` | Persistent state. See [State](state.md). |
| `fs` | `FSConfig` | `{ type: 'memory' }` | VFS. `{ type: 'kvgit' }` shares the agent's versioned state. |
| `maxIterations` | `number` | `10` | Per-task turn cap. |
| `chapteringTrigger` | `number` | `undefined` | When latest action's `inputTokens` >= this, run a chapter task. Setting this option auto-registers an internal chapter task with the default primer; see [Chapters](../concepts/chapters.md). |
| `chapterPrimer` | `string` | `DEFAULT_CHAPTER_PRIMER` | Override the auto-registered chapter task's primer. Most embedders should leave this undefined. Ignored when `chapteringTrigger` is undefined. |
| `agexPrimerOverride` | `string` | `undefined` | Replace the built-in environment description. Use only if you really mean to override agex-ts's conventions. |
| `capabilitiesPrimer` | `string` | `undefined` | Replace the auto-rendered Registered Resources section with curated prose. The runtime adapter still injects everything registered. |

`AgentOptions` is `readonly` — passing the same object to multiple `createAgent` calls is fine.

## Registration

```ts
agent.fn(fn,             opts?: FnRegistration)        // → this
agent.cls(cls,           opts?: ClsRegistration)       // → this
agent.namespace(target,  opts:  NsRegistration)        // → this
agent.skill(content,     opts:  SkillRegistration)     // → this
agent.terminal(handler,  opts:  TerminalRegistration)  // → this
```

Each returns `this` for chaining. See [Registration](registration.md) for full options.

Chaptering is configured via `AgentOptions.chapteringTrigger` (and optionally `AgentOptions.chapterPrimer` to override the default primer) — the framework auto-registers the chapter task internally.

## Tasks

```ts
agent.task<I, O>(def: TaskDefinition<I, O>): TaskFn<I, O>
```

Returns a typed callable: `(input: I, options?: TaskCallOptions) => Promise<O>`. See [Task](task.md).

## Per-session host APIs

All async. `session` defaults to `"default"`. Each is cached per-session — first call resolves the underlying substrate; subsequent calls return immediately.

### `agent.fs(session?)`

```ts
async fs(session?: string): Promise<VirtualFileSystem>
```

The agent's filesystem for the session. Mounts read-only overlays at `/chapters/` and `/skills/`; writes go to the configured backing FS (`MemoryFS` or `KvgitFS`).

### `agent.cache(session?)`

```ts
async cache(session?: string): Promise<Cache>
```

A typed Map-shaped cache scoped to the session. Backed by `StateBackend.set/get` under the `cache/` key prefix.

### `agent.events(session?)`

```ts
async events(session?: string): Promise<EventLogImpl>
```

The session's append-only event log. `iter()` yields events in chronological order (with chapter events spliced in for ranges that have been chaptered).

### `agent.state(session?)`

```ts
async state(session?: string): Promise<StateBackend>
```

Raw state backend for inspection or manual reads/writes. `isVersioned(state)` distinguishes `KvgitState` from `Live`.

### `agent.commit(session?, opts?)`

```ts
async commit(
  session?: string,
  opts?:    { info?: Readonly<Record<string, unknown>> },
): Promise<string | null>
```

Flush pending writes for `session` if the backend is versioned. Returns the new commit hash, or `null` for `Live` state. The `info` dict is stored on the kvgit commit and surfaced via `commitInfo`.

### `agent.commitInfo(hash, session?)`

```ts
async commitInfo(hash?: string, session?: string): Promise<CommitInfo | null>
```

Read the info dict at `hash` (or current HEAD if omitted). `null` on non-versioned state or unknown hash.

### `agent.history(hash?, opts?)`

```ts
async *history(
  hash?: string,
  opts?: { allParents?: boolean; session?: string },
): AsyncIterable<string>
```

Walk the session's commit chain backward from `hash` (or HEAD). With `allParents: true`, walks merge-second-parents too.

### `agent.eventsAt(hash, session?)`

```ts
async eventsAt(commitHash: string, session?: string): Promise<EventLog | null>
```

Open a read-only event log as it was at a historical commit. Returns `null` for non-versioned state or unknown hash.

### `agent.runChaptering(session?, opts?)`

```ts
async runChaptering(
  session?: string,
  opts?: { signal?: AbortSignal; onEvent?: (event: AgentEvent) => void | Promise<void> },
): Promise<number>
```

Manually trigger chaptering for `session`. Bypasses the `chapteringTrigger` threshold check — chaptering runs whenever called. Useful when an embedder wants explicit control: a "compact now" UI button, scheduled compaction, or app-specific signals beyond the auto-trigger.

The runtime guard still applies — if there's nothing safe to fold (only an in-progress task with no completed predecessors and no prior chapters), the chapter task isn't invoked and `0` is returned. Otherwise returns the number of `ChapterEvent`s applied.

Requires the chapter task to be registered (set `AgentOptions.chapteringTrigger` to enable). For manual-only control, set `chapteringTrigger` to a value high enough that the auto-trigger never trips.

### Internal: `refreshSkillsOverlay` / `refreshChaptersOverlay`

Used by the framework to rebuild VFS overlays when skills or chapters change. Most embedders don't call these directly.

## Lifecycle: `dispose`

```ts
async dispose(): Promise<void>
```

Release runtime resources. Required when using `workerRuntime` — the worker doesn't get GC'd otherwise. After `dispose()`, calling tasks fails. Don't reuse the agent.

```ts
const agent = await createAgent({ /* ... */ })
try {
  await myTask(input)
} finally {
  await agent.dispose()
}
```

## `agent.reconfigure(opts)`

```ts
interface ReconfigurableOptions {
  readonly llm?: LLMClient
  readonly primer?: string
  readonly agexPrimerOverride?: string
  readonly capabilitiesPrimer?: string
  readonly chapteringTrigger?: number
  readonly chapterPrimer?: string
  readonly maxIterations?: number
}

reconfigure(opts: ReconfigurableOptions): void
```

Hot-swap the safe-to-mutate subset of `AgentOptions` on a constructed agent. Useful for embedders with a settings UI ("user changed model in the drawer"), where reconstructing the agent would orphan per-session state and runtime resources.

Each provided field replaces its current value; omitted fields stay as they were. Pass `undefined` explicitly to clear a value (e.g. `chapteringTrigger: undefined` turns auto-chaptering off).

**Per-field timing — when changes take effect:**

| Field | Takes effect on... |
|---|---|
| `llm` | Next LLM call. In-flight HTTP requests continue with the old client. |
| `primer` / `agexPrimerOverride` / `capabilitiesPrimer` | Next task's system message. (Note: invalidates the LLM provider's prompt cache for system text.) |
| `chapteringTrigger` | Next task-boundary chaptering check. `undefined` disables. |
| `chapterPrimer` | Next chapter task run. |
| `maxIterations` | Start of the next task. |

**Excluded fields** (require dispose + recreate): `name`, `state`, `runtime`, `fs`. Mutating these mid-session would orphan per-session resources or break invariants the substrate depends on. The TypeScript signature prevents you from accidentally including them.

**Example: settings drawer** ("user changed model"):

```ts
function onSettingsChange(newSettings: Settings) {
  agent.reconfigure({ llm: buildLlmClient(newSettings) })
  // Next task uses the new model. No teardown, no state re-attach.
}
```

**Example: turn off auto-chaptering**:

```ts
agent.reconfigure({ chapteringTrigger: undefined })
```

**Example: composing several settings**:

```ts
agent.reconfigure({
  llm: newLlm,
  primer: 'New voice',
  maxIterations: 25,
})
```

## Properties

| Property | Type | Purpose |
|---|---|---|
| `agent.name` | `string` | The configured name. |
| `agent.maxIterations` | `number` | Per-task turn cap. |
| `agent.fingerprint` | `string` | Stable id for the current registration shape. Changes when registrations change. |
| `agent.primer` | `string \| undefined` | The configured primer prose. |
| `agent.llm` | `LLMClient \| undefined` | The configured LLM. |
| `agent.runtime` | `RuntimeAdapter \| undefined` | The configured runtime. |
| `agent.chapteringTrigger` | `number \| undefined` | The configured trigger. |
| `agent.policy()` | `Policy` | Read-only snapshot of the registration policy. |

## Direct construction (rare)

```ts
new Agent(opts: AgentOptions, stateResolver: StateResolver)
```

Used by `createAgent` internally. Direct construction is useful for tests that want to mock the resolver, but normal embedders should always go through `createAgent`.

## Full example

```ts
import { createAgent } from 'agex-ts'
import { evalRuntime } from 'agex-ts/runtime-eval'
import { connectAnthropic } from '@agex-ts/anthropic'
import { z } from 'zod'

const agent = await createAgent({
  name: 'sales',
  llm: connectAnthropic({ model: 'claude-sonnet-4-6' }),
  runtime: evalRuntime(),
  state: { type: 'versioned', storage: 'memory' },
  chapteringTrigger: 50_000,
})

agent
  .fn((...a: unknown[]) => (a[0] as number[]).reduce((s, x) => s + x, 0), {
    name: 'sum', description: 'Sum of an array of numbers.',
  })
  .skill(`# Domain notes\nProducts SKUs follow the pattern …`, { name: 'domain' })

const summarize = agent.task({
  description: 'Compute total sales for the given line items.',
  input: z.array(z.object({ sku: z.string(), amount: z.number() })),
  output: z.object({ total: z.number(), count: z.number() }),
})

const items = [
  { sku: 'A-1', amount: 100 },
  { sku: 'B-2', amount: 250 },
]

try {
  const result = await summarize(items, { session: 'q1' })
  console.log(result)
  await agent.commit('q1', { info: { phase: 'q1-complete' } })
} finally {
  await agent.dispose()
}
```
