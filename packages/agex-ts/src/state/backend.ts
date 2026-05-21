/**
 * `StateBackend` — the minimal Map-shaped surface every state store
 * exposes. Both `Live` (in-process) and a @agex-ts/kvgit `Staged` wrapper
 * satisfy it, so agex-ts core can read/write state without caring
 * which one is underneath.
 *
 * Why `set`/`delete` are sync: kvgit's `Staged` writes go to an
 * in-memory buffer immediately and only flush on `commit()`. `Live`
 * has no buffer/flush distinction at all. Either way, the write
 * itself never awaits storage IO.
 *
 * `keys()` returns `AsyncIterable<string>` to match kvgit's surface,
 * which streams keys lazily for stores too large to materialize at
 * once. Live yields synchronously but uses the same protocol.
 */

export interface StateBackend {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T): void
  delete(key: string): void
  has(key: string): Promise<boolean>
  keys(): AsyncIterable<string>
}

/** State backends with version history (kvgit-backed). `commit()`
 *  flushes pending writes as a single atomic commit; `currentCommit`
 *  reads the current HEAD. `Live` returns `null` for both — it has
 *  no versioning. */
export interface VersionedStateBackend extends StateBackend {
  /** Current HEAD commit hash, or `null` if the backend isn't
   *  versioned (i.e. `Live`). */
  readonly currentCommit: string | null
  /** Flush staged writes as one commit. Returns the resulting commit
   *  hash, or `null` if nothing changed. Throws if the backend isn't
   *  versioned. */
  commit(opts?: { info?: Readonly<Record<string, unknown>> }): Promise<string | null>
  /** True if there are uncommitted writes since the last commit. */
  readonly hasChanges: boolean
}

/** Type guard distinguishing versioned backends from plain `Live`. */
export function isVersioned(backend: StateBackend): backend is VersionedStateBackend {
  return 'commit' in backend && typeof (backend as VersionedStateBackend).commit === 'function'
}
