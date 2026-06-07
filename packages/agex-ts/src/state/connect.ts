/**
 * `connectState(config)` — factory that turns a `StateConfig` into a
 * `StateResolver`: the resolver owns the per-session state lookup and
 * caches a fresh `StateBackend` per session id on first request.
 *
 * Each framework session gets its own KV-store namespace so its
 * commit chain is independent of every other session's. Mirrors
 * agex-py's `host/local.py` model: separate Disk dirs per session,
 * separate ModalDicts per session, etc. Storage backends embed the
 * session differently — Memory: a fresh `Memory()` per session;
 * IndexedDB: a session-suffixed db name; SQLite: a per-session file.
 *
 * The earlier "one VersionedKV per agent + key-prefix sessions"
 * shape conflated the substrate boundary with the namespace boundary.
 * Splitting them lets cache / event log / VFS share one substrate
 * within a session (atomic commits across all three) and lets sessions
 * roll back independently of each other.
 *
 * Storage-specific backends are loaded via dynamic `import()` so a
 * browser bundle doesn't pull `node:sqlite` and a Node bundle doesn't
 * pull `idb`. Tree-shaking handles the unused branches per environment.
 */

import type { StateConfig } from '../types'
import type { StateBackend } from './backend'
import { Live } from './live'

/** Lazy per-session resolver. `resolve(session)` returns the
 *  `StateBackend` for that session, constructing it on first access
 *  and caching for the rest of the resolver's lifetime. The
 *  `versioned` flag tells callers (notably `VfsManager`) whether the
 *  produced backends are kvgit-backed without forcing a resolution. */
export interface StateResolver {
  resolve(session: string): Promise<StateBackend>
  readonly versioned: boolean
}

/** Permitted session-id shape. Sessions are embedded into filesystem
 *  paths (SQLite) and IndexedDB names, so untrusted strings can let
 *  an attacker escape the configured directory or namespace. The
 *  rule is intentionally narrow — agex-py's session ids are typically
 *  `chat-<uuid>` style; anything outside `[A-Za-z0-9_.-]`, anything
 *  starting with `.`, or empty strings are rejected. Apply uniformly
 *  across all backends so the contract doesn't depend on which
 *  storage the embedder chose. */
const SAFE_SESSION_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/

function assertSafeSession(session: string): void {
  if (typeof session !== 'string' || session.length === 0 || !SAFE_SESSION_RE.test(session)) {
    throw new Error(
      `connectState: invalid session id ${JSON.stringify(session)} — must match /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/ to prevent path traversal in storage backends`,
    )
  }
}

export async function connectState(config: StateConfig = { type: 'live' }): Promise<StateResolver> {
  // Bring-your-own resolver: the embedder built the StateResolver
  // itself (e.g. a shared `VersionedKV` with a branch per session, which
  // the built-in storage modes — one substrate per session — can't
  // express). Hand it back untouched. `createAgent` flows `opts.state`
  // straight through here, so this is the one place that needs to know.
  if (config.type === 'resolver') {
    return config.resolver
  }
  if (config.type === 'live') {
    const cache = new Map<string, StateBackend>()
    return {
      versioned: false,
      async resolve(session: string): Promise<StateBackend> {
        assertSafeSession(session)
        const cached = cache.get(session)
        if (cached !== undefined) return cached
        const fresh = new Live()
        cache.set(session, fresh)
        return fresh
      },
    }
  }

  // Versioned path: one VersionedKV / Staged / KvgitState per session,
  // each over its own KVStore namespace. Imports are lazy so a Live-
  // only embedder doesn't pull @agex-ts/kvgit / @agex-ts/termish into their
  // bundle.
  const { Staged, VersionedKV } = await import('@agex-ts/kvgit')
  const { KvgitState } = await import('./kvgit')
  const { polymorphicDecoder: polyDecoder, polymorphicEncoder: polyEncoder } = await import(
    '@agex-ts/termish/fs/kvgit'
  )

  // Per-storage factory: produce a fresh `KVStore` keyed by session id.
  // This is where the substrate boundary lives — different stores for
  // different sessions means different commit chains.
  let makeStore: (session: string) => Promise<import('@agex-ts/kvgit').KVStore>
  switch (config.storage) {
    case 'memory': {
      const { Memory } = await import('@agex-ts/kvgit/backends/memory')
      // Each session = a fresh `Memory()`; sessions are completely
      // isolated and ephemeral.
      makeStore = async () => new Memory()
      break
    }
    case 'indexeddb': {
      const { IndexedDB } = await import('@agex-ts/kvgit/backends/idb')
      // Each session = its own IndexedDB database name. Default base
      // name is `kvgit`; sessions land at `kvgit/<session>` (a single
      // distinct database per session, so closing/reopening a session
      // doesn't disturb others).
      makeStore = async (session) => IndexedDB.open({ dbName: `kvgit/${session}` })
      break
    }
    case 'sqlite': {
      if (config.path === undefined) {
        throw new Error('connectState: storage "sqlite" requires a `path` option')
      }
      const { Sqlite } = await import('@agex-ts/kvgit/backends/sqlite')
      // `config.path` is treated as a directory; each session occupies
      // its own SQLite file under it. Differs from the prior single-
      // session shape that took `path` as a file path directly — pre-
      // 1.0 we trade the breaking change for multi-session correctness.
      const dir = config.path
      makeStore = async (session) => Sqlite.open({ path: `${dir}/${session}.db` })
      break
    }
    default: {
      const exhaustive: never = config.storage
      throw new Error(`connectState: unknown storage type: ${exhaustive as string}`)
    }
  }

  const cache = new Map<string, StateBackend>()
  return {
    versioned: true,
    async resolve(session: string): Promise<StateBackend> {
      assertSafeSession(session)
      const cached = cache.get(session)
      if (cached !== undefined) return cached
      const store = await makeStore(session)
      const vk = await VersionedKV.open(store)
      // Polymorphic encoder lets one Staged carry both FileRecord
      // (KvgitFS writes) and JSON-able state (cache, event log,
      // metadata) — atomically commitable in one call.
      const staged = new Staged(vk, { encoder: polyEncoder, decoder: polyDecoder })
      const fresh = new KvgitState(staged)
      cache.set(session, fresh)
      return fresh
    },
  }
}
