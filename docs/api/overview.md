# API Reference

This is the technical reference for every public type and method in agex-ts. **New to agex-ts?** Start with the **[Quick Start](../quick-start.md)** for hands-on examples, or **[The Big Picture](../concepts/big-picture.md)** for the architectural thesis.

## Core APIs

- **[Agent](agent.md)** — `createAgent`, `Agent` class, options, per-session host APIs (`fs`, `cache`, `events`, `state`, `commit`, `history`, `eventsAt`).
- **[Registration](registration.md)** — `agent.fn` / `agent.cls` / `agent.namespace` / `agent.skill` / `agent.terminal`. URL-shipped registrations. Capability flags. Member filters.
- **[Task](task.md)** — `agent.task({...})`, `TaskDefinition`, `TaskCallOptions`, schemas via Standard Schema, the agent's task loop.
- **[State](state.md)** — `connectState`, `StateResolver`, `StateConfig`, `StateBackend`. The session-as-substrate model.
- **[Runtime](runtime.md)** — `RuntimeAdapter` contract. `evalRuntime` (in-process) and `workerRuntime` (`@agex-ts/runtime-worker`).
- **[LLM](llm.md)** — `LLMClient` contract, `Dummy` for tests, provider packages (`@agex-ts/anthropic`, `@agex-ts/openai`, `@agex-ts/gemini`).
- **[Events](events.md)** — `AgentEvent` types, `EventLog`, `ChapterEvent`, the on-event stream.
- **[Errors](errors.md)** — `TaskFailError`, `TaskClarifyError`, `CancelledError`, `RegistrationError`, `SchemaError`, `isTaskControlError`.

## Optional surfaces

- **[Git](git.md)** — `agex-git` package. Adds a `git`-style command (status / commit / branch / diff / merge) to the agent's `terminal_action`, layered over the kvgit-backed VFS. Opt in via `registerGit(agent)`.

## Import patterns

```ts
// Default surface — agent + types
import { Agent, createAgent, type AgentOptions } from 'agex-ts'

// Sub-paths for tree-shakeable extras
import { connectState, KvgitState } from 'agex-ts/state'
import { evalRuntime } from 'agex-ts/runtime-eval'
import { Dummy } from 'agex-ts/llm-dummy'
import { renderEvents, prettyEvents } from 'agex-ts'

// Provider packages
import { connectAnthropic } from '@agex-ts/anthropic'
import { connectOpenAI }    from '@agex-ts/openai'
import { connectGemini }    from '@agex-ts/gemini'

// Production runtime
import { workerRuntime } from '@agex-ts/runtime-worker'

// Optional: agent-view git
import { registerGit } from 'agex-git'
```

## API design

### Async at the seam

`createAgent` is async because state setup is async (IDB / SQLite open). Per-session host APIs (`agent.fs(session)`, `agent.cache(session)`, `agent.events(session)`, `agent.state(session)`, `agent.commit(session, opts)`) are also async — the first call resolves the session's substrate and caches it; subsequent calls return immediately.

In tests, the trio of `await createAgent(...)`, `await agent.cache()`, `await agent.fs()` is normal. Inside an `agent.task({...})`-defined function, the loop awaits these once per task call and uses them synchronously across turns.

### The "thing first, options second" registration shape

Every registration takes the thing being registered as the first arg and an options object second:

```ts
agent.fn(myFn,           { name: 'process', description: '...' })
agent.cls(MyClass,       { name: 'Foo',     description: '...' })
agent.namespace(myMod,   { name: 'utils',   description: '...' })
agent.skill('# How To', { name: 'how-to' })
agent.terminal(handler,  { name: 'beep',    description: '...' })
```

Inferred names: `agent.fn` and `agent.cls` infer from `.name` if you don't supply one. `agent.namespace` / `agent.skill` / `agent.terminal` always require a `name` — plain objects, markdown strings, and arbitrary handlers don't carry useful identifiers.

### URL-shipped registrations

Replace the live JS reference with `{ url, export? }` to ship code into the worker realm by URL:

```ts
agent.cls(
  { url: 'https://esm.sh/big-graph-lib', export: 'Graph' },
  { name: 'Graph', description: 'Graph data structure.' },
)
```

The worker dynamic-imports the module and exposes the named export to the agent natively — no host RPC bridging per call. URL-shipped registrations can't combine with `paramsSchema`, `constructable: false`, or `include`/`exclude`/`configure` — the worker imports the module whole.

### Async per-session host APIs

`agent.fs(session)`, `agent.cache(session)`, `agent.events(session)`, `agent.state(session)` all default `session = "default"`:

```ts
const fs    = await agent.fs()                  // default session
const cache = await agent.cache('alice')        // alice's cache
const events = await agent.events('req-42')     // request 42's event log
```

`agent.commit(session, { info? })` flushes the session's pending writes as one atomic kvgit commit. `agent.history(hash?, { session?, allParents? })` walks the session's commit chain. `agent.commitInfo(hash, session?)` reads the info dict at a hash. `agent.eventsAt(hash, session?)` opens the event log as it was at a historical commit.

## Status

> **Pre-1.0.** Public API is experimental. Wire format (postMessage payloads), on-disk format (kvgit polymorphic encoder), and registration shapes are the most likely to shift before 1.0.

Found a place where the docs don't match the code? Open an issue at [github.com/ashenfad/agex-ts](https://github.com/ashenfad/agex-ts).
