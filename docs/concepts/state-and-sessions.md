# State & Sessions

agex-ts treats the agent's whole world — event log, per-session cache, optional VFS — as a single versioned substrate per session. A session is one isolated kvgit `VersionedKV`. One commit captures everything atomically. Roll back any session independently of every other.

## The model

| Concept | What it is |
|---|---|
| **Session** | A framework-level identifier (`"alice"`, `"req-42"`, etc.). Each session resolves to its own `VersionedKV` — its own commit chain. |
| **State backend** | The Map-shaped surface every component reads/writes against. `Live` (in-process, no versioning) or `KvgitState` (kvgit-backed). |
| **`Staged`** | The buffered-writes layer kvgit-ts provides. Writes accumulate in memory; `commit()` flushes them as one atomic version. |
| **Polymorphic encoder** | One `Staged` carries both file content (`FileRecord`) and arbitrary state values (JSON) via a single-byte type tag. |
| **VFS** | The agent's filesystem. `MemoryFS` (ephemeral) or `KvgitFS` (versioned, sharing the session's `Staged`). |

## Session = separate VersionedKV

Every session opens a fresh kvgit substrate keyed by session id. Writes from one session never appear in another's commit chain.

| Backend | Per-session storage |
|---|---|
| `live` | A fresh `Live` (in-process Map) per session id. |
| `versioned: memory` | A fresh `Memory()` KVStore per session. |
| `versioned: indexeddb` | One IndexedDB database per session: `kvgit/<session>`. |
| `versioned: sqlite` | One SQLite file per session: `${path}/<session>.db`. |

```ts
import { connectState } from 'agex-ts/state'

const resolver = await connectState({ type: 'versioned', storage: 'memory' })

const aliceState = await resolver.resolve('alice')
const bobState   = await resolver.resolve('bob')
// Different VersionedKV instances. Different commit chains.
```

The `Agent` class wraps this internally — `agent.cache(session)`, `agent.events(session)`, `agent.fs(session)`, `agent.state(session)`, and `agent.commit(session)` all route through the resolver and cache the per-session views.

## Why a session is its own commit chain

Three concrete benefits:

1. **Independent rollback.** Roll back alice's commits without touching bob's.
2. **Atomic per-session commits.** A single `staged.commit()` captures alice's state, cache, event log, and VFS together. Either everything from this turn lands or nothing does.
3. **Storage-natural multiplexing.** Sessions map to the storage layer's natural unit (DB, file), so backups, deletes, and migrations already operate at session granularity.

## The polymorphic encoder

Within a session's `VersionedKV`, two value shapes need to coexist on the same `Staged`:

- **JSON values** — state writes from the cache, event log entries, framework metadata.
- **`FileRecord`** — file content from `KvgitFS`, with a binary header (type tag, ISO timestamps) and raw content bytes.

Without coexistence, you'd need two `Staged` instances — and commits across them wouldn't be atomic. The polymorphic encoder (in `termish-ts/fs/kvgit`) puts a single byte at position 0 to discriminate:

| Tag | Meaning |
|---|---|
| `0x46` (`F`) | File record (regular file) |
| `0x44` (`D`) | File record (directory) |
| `0x4a` (`J`) | JSON value |

The encoder routes by structural inspection: a value with a `Uint8Array` `content` field (and the other FileRecord shape requirements) goes through the file branch; everything else through the JSON branch. JSON.stringify can't naturally produce a `Uint8Array`, so the discrimination is collision-proof in practice.

This means one `staged.commit()` flushes both file writes and state writes as one kvgit commit. The agent's VFS edits and its event log entries land together. Rollback rolls back the whole world.

## Session resolution

`connectState(config)` returns a `StateResolver`:

```ts
interface StateResolver {
  resolve(session: string): Promise<StateBackend>
  readonly versioned: boolean
}
```

`resolve(session)` lazily constructs and caches the per-session backend. First call opens the underlying KV (IDB / SQLite open is async); subsequent calls await one map lookup.

Session ids are validated: `^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`. They become directory names (SQLite) and database names (IDB), so `..`, `/`, `\`, leading `.`, control chars, and empty strings are rejected. agex-studio's `chat-<uuid>` style and the default `"default"` session pass.

## Two layers, two concepts of "session"

A note on terminology: **agex-studio** uses "session" to mean "kvgit branch within a substrate" — different chat threads sharing one DB, multiplexed by branch name. agex-ts core uses "session" to mean "which substrate" — a separate `VersionedKV` per session.

These are layered, not in conflict. An embedder building a chat-style app picks one framework session (e.g. `"default"`) and uses kvgit branches *within* that substrate to multiplex chat threads. An embedder running a multi-tenant API picks framework sessions per user/request and ignores branches.

| Concept | What it does |
|---|---|
| **Framework session** (agex-ts core) | Which `VersionedKV` to operate on. Substrate boundary. Multi-tenant isolation. |
| **kvgit branch** (within a `VersionedKV`) | Which timeline within the substrate. UI-level chat threading. agex-studio's pattern. |

Both can be used together. agex-ts core only manages framework sessions; branches are an embedder-level feature you can build on top.

## Atomicity in practice

When the agent's runtime adapter dispatches a `ts_action` emission, it executes within the session's `Staged` view. The agent's writes accumulate in the buffer:

```ts
// inside the agent's ts_action emission:
await fs.write('/notes/today.md', new TextEncoder().encode('...'))
await cache.set('lastEdit', { path: '/notes/today.md' })
console.log('saved')
```

After dispatch, an `ActionEvent` is appended to the event log (also a write to the same `Staged`). Then the agent loop calls `state.commit({ info: { ... } })` — one kvgit commit captures the file write, the cache write, and the event log update atomically.

If anything in the turn fails (network error, timeout, unhandled exception), the buffer can be discarded with `staged.reset()` — the commit chain is unchanged, no partial state lands.

## Configuration cheat sheet

```ts
// Default: in-process, no versioning.
await createAgent({ name: 'a' })

// Versioned in-memory — fast, ephemeral.
await createAgent({ name: 'a', state: { type: 'versioned', storage: 'memory' } })

// Versioned + browser-persistent.
await createAgent({ name: 'a', state: { type: 'versioned', storage: 'indexeddb' } })

// Versioned + Node SQLite — sessions live as ./agex/<session>.db.
await createAgent({
  name: 'a',
  state: { type: 'versioned', storage: 'sqlite', path: './agex' },
})

// Versioned state + versioned VFS in one substrate.
await createAgent({
  name: 'a',
  state: { type: 'versioned', storage: 'indexeddb' },
  fs: { type: 'kvgit' },
})
```

`fs: { type: 'kvgit' }` requires versioned state — the kvgit-backed VFS shares the session's `Staged`. The combination is rejected eagerly at `createAgent` time if state is `live`.

## Time travel

When state is versioned, every commit carries an info dict and the parent commit hash. `agent.history(undefined, { session })` walks backward through the commit chain. `agent.eventsAt(hash, session)` opens a read-only view at that historical commit and returns its event log.

```ts
const head = await agent.commit('alice', { info: { phase: 'after-task-1' } })
// ... agent does more work, more commits land ...

const log = await agent.eventsAt(head, 'alice')
const events: AgentEvent[] = []
for await (const e of log!.iter()) events.push(e)
// `events` is the session's log as it was at `head`.
```

This is how chaptering's `/chapters/<slug>/events/...` overlay surfaces the originals on demand: it walks `ChapterEvent.eventRefs` against the current state, but since the originals are stored content-addressed, they remain accessible through any historical commit they're reachable from.
