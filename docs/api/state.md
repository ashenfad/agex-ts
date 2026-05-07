# State

agex-ts's state model: each session resolves to its own kvgit `VersionedKV`, with the agent's cache, event log, and (optionally) VFS sharing one `Staged` per session. See [State & Sessions](../concepts/state-and-sessions.md) for the architectural rationale.

## `connectState`

```ts
import { connectState } from 'agex-ts/state'

async function connectState(config?: StateConfig): Promise<StateResolver>
```

Constructs a `StateResolver` — a lazy per-session factory. Default config is `{ type: 'live' }`.

```ts
const resolver = await connectState({ type: 'versioned', storage: 'memory' })
const aliceState = await resolver.resolve('alice')
```

Most embedders don't call `connectState` directly — `createAgent({ state })` calls it internally and exposes the result via `agent.state(session)` / `agent.cache(session)` / etc.

## `StateConfig`

```ts
type StateConfig =
  | { readonly type: 'live' }
  | {
      readonly type: 'versioned'
      readonly storage: 'memory' | 'indexeddb' | 'sqlite'
      readonly path?: string  // required for 'sqlite'
    }
```

| Variant | Per-session storage | Use for |
|---|---|---|
| `live` | A fresh `Live` (in-process Map) per session | Tests, ephemeral runs, no persistence needed |
| `versioned` + `memory` | A fresh `Memory()` KVStore per session | Tests + versioned commit chain, ephemeral |
| `versioned` + `indexeddb` | One IDB database per session: `kvgit/<session>` | Browser, persistent across reloads |
| `versioned` + `sqlite` | One SQLite file per session: `${path}/<session>.db` | Node, persistent on disk |

Session ids are validated: `^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`. They become directory names (SQLite) and database names (IDB), so `..`, `/`, `\`, leading `.`, control chars, and empty strings are rejected at `resolve(session)` time.

## `StateResolver`

```ts
interface StateResolver {
  resolve(session: string): Promise<StateBackend>
  readonly versioned: boolean
}
```

`resolve(session)` lazily constructs and caches the per-session backend. First call opens the underlying KV (IDB / SQLite open is async); subsequent calls return immediately.

`versioned` lets callers (notably `VfsManager`) reason about whether the produced backends are kvgit-backed without forcing a resolution.

## `StateBackend`

```ts
interface StateBackend {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T): void
  delete(key: string): void
  has(key: string): Promise<boolean>
  keys(): AsyncIterable<string>
}
```

The minimal Map-shaped surface every state implementation provides. `set` and `delete` are sync because kvgit's `Staged` writes are buffered (no IO until commit) and `Live` has no buffer/flush distinction. `keys()` is `AsyncIterable<string>` to match kvgit's streaming API.

### `VersionedStateBackend` (extends `StateBackend`)

```ts
interface VersionedStateBackend extends StateBackend {
  readonly currentCommit: string | null
  readonly hasChanges: boolean
  commit(opts?: { info?: Readonly<Record<string, unknown>> }): Promise<string | null>
}
```

Versioned backends add commit access. `currentCommit` is the current HEAD hash; `hasChanges` is true when the buffer has uncommitted writes. `commit(opts)` flushes the buffer as one atomic kvgit commit, optionally tagging it with `opts.info`.

### `isVersioned(backend)` type guard

```ts
import { isVersioned } from 'agex-ts/state'

function tryCommit(state: StateBackend) {
  if (isVersioned(state)) {
    return state.commit({ info: { reason: 'manual' } })
  }
  return null  // Live — no versioning
}
```

## `Live`

```ts
import { Live } from 'agex-ts/state'

const live = new Live()
live.set('foo', { value: 42 })
await live.get('foo')  // → { value: 42 }
```

In-process Map. No commits, no history, no rollback. Good for tests and ephemeral runs. `isVersioned(new Live()) === false`.

## `KvgitState`

```ts
import { KvgitState } from 'agex-ts/state'

class KvgitState implements VersionedStateBackend {
  constructor(staged: Staged)
  get staged(): Staged
  // ... StateBackend methods + commit, currentCommit, hasChanges
  async commitInfo(hash?: string): Promise<CommitInfo | null>
  history(hash?: string, opts?: { allParents?: boolean }): AsyncIterable<string>
  async checkoutAt(hash: string): Promise<Versioned | null>
}
```

Wraps a kvgit-ts `Staged` — writes go to the buffer; `commit()` flushes them. The underlying `Staged` is exposed via the `staged` getter for callers that need kvgit-specific surfaces (branch ops, etc.).

The `Agent` exposes most of the useful surface via per-session host APIs (`agent.commit(session, opts)`, `agent.commitInfo(hash, session)`, `agent.history(hash, { session })`, `agent.eventsAt(hash, session)`) — direct `KvgitState` access is for advanced cases.

## The polymorphic encoder

Within a versioned session, both file content (`FileRecord` from `KvgitFS`) and arbitrary state values (JSON from cache / event log / metadata) flow through a single `Staged`. The polymorphic encoder discriminates by a one-byte type tag at position 0:

| Tag | Meaning |
|---|---|
| `0x46` (`F`) | `FileRecord` (regular file) |
| `0x44` (`D`) | `FileRecord` (directory) |
| `0x4a` (`J`) | JSON value |

Discrimination on encode: a value with all four `FileRecord` keys (`isDir`, `createdAt`, `modifiedAt`, `content` as `Uint8Array`) goes through the file branch; everything else through JSON. The structure is collision-proof against legitimate JSON values (which can't naturally carry a `Uint8Array`).

The encoder is exported from `termish-ts/fs/kvgit` as `polymorphicEncoder` / `polymorphicDecoder`. agex-ts uses it automatically when `state: { type: 'versioned', ... }` is configured. Custom embedders building their own state stack can import it directly.

## Atomicity

When `state: { type: 'versioned', ... }` and `fs: { type: 'kvgit' }`, file writes and state writes share one `Staged`. A single `staged.commit()` (or `agent.commit(session)`) flushes both atomically:

```ts
const enc = new TextEncoder()
const fs = await agent.fs('alice')
const cache = await agent.cache('alice')

await fs.write('/notes/today.md', enc.encode('Hello'))
await cache.set('lastEdit', { path: '/notes/today.md' })
//  ↑ both writes accumulate in one buffer

const hash = await agent.commit('alice', { info: { reason: 'first edit' } })
//  ↑ one kvgit commit captures both
```

Either everything from this moment lands or nothing does. Rollback to a prior commit rolls back the whole world.

## Configuration cheat sheet

```ts
// Default: in-process, no versioning.
await createAgent({ name: 'a' })

// Versioned in-memory — fast, ephemeral.
await createAgent({ name: 'a', state: { type: 'versioned', storage: 'memory' } })

// Versioned + browser-persistent.
await createAgent({ name: 'a', state: { type: 'versioned', storage: 'indexeddb' } })

// Versioned + Node SQLite. Treats path as a directory; sessions live as ./agex/<session>.db.
await createAgent({
  name: 'a',
  state: { type: 'versioned', storage: 'sqlite', path: './agex' },
})

// Versioned state + versioned VFS (one substrate, atomic).
await createAgent({
  name: 'a',
  state: { type: 'versioned', storage: 'indexeddb' },
  fs: { type: 'kvgit' },
})
```

`fs: { type: 'kvgit' }` requires versioned state — combining with `live` is rejected eagerly at `createAgent` time.

## Implementing a custom backend

Anything implementing `StateBackend` can be swapped in. For state that should be versioned, also implement `VersionedStateBackend` (commit semantics + `currentCommit` + `hasChanges`). The `Agent` and per-session host APIs work against the interface — no agex-ts internal touches the concrete type.

For a custom `StateResolver`, implement `{ resolve, versioned }` directly — useful for tests that want to inject specific backends per session.
