/**
 * @agex-ts/kvgit public type contracts.
 *
 * Canonical source for the public types of @agex-ts/kvgit. Implementations
 * (`Hamt`, `Keyset`, `VersionedKV`, `Staged`, `Namespaced`, the
 * backends) live in sibling files and import from here.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Branch HEAD moved between read and CAS — caller raced another writer.
 *
 * Recovery: refresh and retry, or call `commit({ onConflict: 'merge' })`
 * to attempt a three-way merge.
 */
export class ConcurrencyError extends Error {
  override readonly name = 'ConcurrencyError'
}

/**
 * One or more contested keys had no merge function (or their merge fn
 * threw). The merge attempt is aborted; staged changes remain intact
 * for inspection.
 */
export class MergeConflict extends Error {
  override readonly name = 'MergeConflict'
  readonly keys: ReadonlySet<string>
  readonly causes: ReadonlyMap<string, unknown>

  constructor(keys: Iterable<string>, causes?: ReadonlyMap<string, unknown>) {
    const keySet = new Set(keys)
    super(`Merge conflict on ${keySet.size} key(s): ${[...keySet].sort().join(', ')}`)
    this.keys = keySet
    this.causes = causes ?? new Map()
  }
}

// ---------------------------------------------------------------------------
// KV store
// ---------------------------------------------------------------------------

/**
 * Bytes-only key-value store. Serialization happens at higher layers
 * (e.g. `VersionedKV`).
 *
 * All operations are async to accommodate IndexedDB / OPFS / remote
 * backends. In-process backends (`Memory`) wrap sync operations in
 * resolved promises so user code is uniform across backends.
 *
 * `cas` is correctness-critical — it underpins branch HEAD advancement
 * in `VersionedKV`. Backends must guarantee atomicity (read + conditional
 * write within a single transaction or equivalent).
 */
export interface KVStore {
  get(key: string): Promise<Uint8Array | null>
  set(key: string, value: Uint8Array): Promise<void>
  remove(key: string): Promise<void>
  has(key: string): Promise<boolean>

  /** Returns only keys that exist; missing keys are silently omitted. */
  getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>>
  setMany(items: Iterable<readonly [string, Uint8Array]>): Promise<void>
  removeMany(keys: Iterable<string>): Promise<void>

  /**
   * Atomic compare-and-swap.
   *
   * Sets `value` only if the current value equals `expected` (compared
   * bytewise). `expected = null` means "key must not exist".
   *
   * Returns `true` if the swap succeeded.
   */
  cas(key: string, value: Uint8Array, expected: Uint8Array | null): Promise<boolean>

  /**
   * Iterate keys, optionally restricted to a string prefix.
   *
   * Backends with native prefix support (IDB key ranges, SQLite
   * range scans) implement this in O(matching keys). Memory falls
   * back to filter-after-iterate, which is still O(N) but correct.
   * Pass `undefined` (or no argument) to iterate all keys.
   */
  keys(prefix?: string): AsyncIterable<string>

  /** Iterate `(key, value)` pairs, optionally restricted to a prefix. */
  items(prefix?: string): AsyncIterable<readonly [string, Uint8Array]>

  clear(): Promise<void>
}

// ---------------------------------------------------------------------------
// HAMT
// ---------------------------------------------------------------------------

/**
 * Per-key metadata stored in the HAMT alongside the blob pointer.
 *
 * `size` is the encoded blob length in bytes; `createdAt` is epoch
 * milliseconds at commit time.
 */
export interface MetaEntry {
  readonly size: number
  readonly createdAt: number
}

/**
 * One entry in the keyset HAMT: a pointer to the blob's storage
 * location plus its metadata.
 *
 * Blob pointers are versioned keys of the form `<commitHash>:<userKey>`.
 */
export interface KeysetEntry {
  readonly blob: string
  readonly meta: MetaEntry
}

/**
 * Structural diff between two HAMT roots.
 *
 * Computed in O(changes + log N) by skipping subtrees that share a
 * hash. The primary payoff of structural sharing.
 */
export interface HamtDiff {
  readonly added: ReadonlyMap<string, Uint8Array>
  readonly removed: ReadonlyMap<string, Uint8Array>
  readonly modified: ReadonlyMap<string, readonly [Uint8Array, Uint8Array]>
}

/**
 * Structural diff between two `Keyset` roots — the typed-entry analog
 * of `HamtDiff`. Same hash-skipping payoff: cost is proportional to the
 * number of changed entries, not the total entry count.
 */
export interface KeysetDiff {
  readonly added: ReadonlyMap<string, KeysetEntry>
  readonly removed: ReadonlyMap<string, KeysetEntry>
  readonly modified: ReadonlyMap<string, readonly [KeysetEntry, KeysetEntry]>
}

// ---------------------------------------------------------------------------
// Versioned
// ---------------------------------------------------------------------------

/** Key-level differences between two commits. */
export interface DiffResult {
  readonly added: ReadonlySet<string>
  readonly removed: ReadonlySet<string>
  readonly modified: ReadonlySet<string>
}

/**
 * Result of a `commit()` attempt.
 *
 * - `merged: true, strategy: 'fast_forward'` — HEAD was at the expected
 *   parent; new commit appended directly.
 * - `merged: true, strategy: 'three_way'` — HEAD had moved; performed a
 *   three-way merge using the registered merge fns.
 * - `merged: false, strategy: 'no_op'` — nothing to commit (empty
 *   updates + removals), or the caller passed `onConflict: 'skip'` and
 *   HEAD had moved.
 *
 * `autoMergedKeys` lists keys that a merge function resolved without
 * user intervention. `carriedKeys` lists keys carried unchanged from
 * either side during a three-way merge.
 */
export interface MergeResult {
  readonly merged: boolean
  readonly commit: string | null
  readonly strategy: 'no_op' | 'fast_forward' | 'three_way'
  readonly autoMergedKeys: readonly string[]
  readonly carriedKeys: readonly string[]
}

/**
 * Three-way merge function over raw bytes. Any argument may be `null`
 * (key absent or removed on that side).
 *
 * Throw to signal an unresolvable conflict — the framework wraps it
 * in `MergeConflict` along with conflicts from any other contested
 * keys.
 */
export type BytesMergeFn = (
  old: Uint8Array | null,
  ours: Uint8Array | null,
  theirs: Uint8Array | null,
) => Uint8Array

/**
 * User-level merge function. Receives decoded values; the encoding
 * layer wraps these into a `BytesMergeFn` at commit time.
 */
export type MergeFn<T = unknown> = (old: T | null, ours: T | null, theirs: T | null) => T

/**
 * Disposition for a `commit()` that can't land cleanly.
 *
 * `commit()` always attempts to advance HEAD: if HEAD has moved, it
 * tries a three-way merge using the registered merge fns. This flag
 * governs only what happens when *that* fails (no LCA, contested key
 * with no merge fn, CAS lost the race).
 *
 * - `'raise'` (default): throw `ConcurrencyError` or `MergeConflict`.
 * - `'skip'`: return `{ merged: false }`. Staged changes remain;
 *   in-memory base is restored. Caller decides whether to retry.
 */
export type ConflictDisposition = 'raise' | 'skip'

/** Optional commit-level metadata. Surfaced via `commitInfo()`. */
export type CommitInfo = Record<string, unknown>

/** Options for `Versioned.commit()`. */
export interface VersionedCommitOptions {
  updates?: Map<string, Uint8Array> | null
  removals?: Set<string> | null
  onConflict?: ConflictDisposition
  mergeFns?: Map<string, BytesMergeFn> | null
  defaultMerge?: BytesMergeFn | null
  info?: CommitInfo | null
}

/**
 * Versioned key-value store. A commit log over a `KVStore`.
 *
 * `VersionedKV` is the v1 implementation; the protocol leaves room for
 * alternative implementations (e.g. a remote-RPC variant).
 */
export interface Versioned {
  readonly currentCommit: string
  readonly baseCommit: string
  readonly currentBranch: string
  readonly initialCommit: string
  readonly lastMergeResult: MergeResult | null

  /** Resolve the branch's HEAD from storage (reflects other writers). */
  latestHead(): Promise<string | null>

  // --- Reads ---

  get(key: string): Promise<Uint8Array | null>
  getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>>
  has(key: string): Promise<boolean>
  keys(): AsyncIterable<string>

  /** Read a key from another branch's HEAD without switching to it. */
  peek(key: string, opts: { branch: string }): Promise<Uint8Array | null>

  // --- Merge fn registry ---

  setMergeFn(key: string, fn: BytesMergeFn): void
  setDefaultMerge(fn: BytesMergeFn): void

  // --- Writes ---

  commit(opts?: VersionedCommitOptions): Promise<MergeResult>

  // --- Navigation ---

  refresh(): Promise<void>
  checkout(commitHash: string, opts?: { branch?: string }): Promise<Versioned | null>
  createBranch(name: string, opts?: { at?: string }): Promise<Versioned>
  deleteBranch(name: string): Promise<void>
  switchBranch(name: string): Promise<void>
  resetTo(commitHash: string): Promise<boolean>
  history(commitHash?: string, opts?: { allParents?: boolean }): AsyncIterable<string>
  listBranches(): Promise<string[]>

  // --- Inspection ---

  commitInfo(commitHash?: string): Promise<CommitInfo | null>
  diff(commitA: string, commitB: string): Promise<DiffResult>
  parents(commitHash?: string): Promise<readonly string[]>
}

// ---------------------------------------------------------------------------
// Sync / wire
// ---------------------------------------------------------------------------

/**
 * One kvgit commit in wire form — the unit of transfer between two
 * kvgit histories (sync remotes, bundles).
 *
 * A `WireCommit` carries exactly what a replayer needs to reproduce
 * the commit byte-identically: parents, the changed values, and the
 * provenance of carried pointers. It deliberately does NOT carry HAMT
 * nodes (rebuilt locally; commit hashes don't cover node bytes) or
 * blob pointers for updates (reconstructed as `<hash>:<key>` during
 * replay).
 *
 * Replay must reproduce `hash` exactly — recomputing `contentHash`
 * over the replayed state and comparing against `hash` is the
 * integrity check of the sync layer.
 */
export interface WireCommit {
  /** kvgit commit hash (40-hex). */
  readonly hash: string
  /** Parent hashes, order-significant (order participates in `hash`).
   *  For three-way merges, `parents[0]` is "theirs" (the head that won
   *  the CAS race) and `parents[1]` is "ours" — see `VersionedBase`. */
  readonly parents: readonly string[]
  /** Wall time epoch ms (`__commit_time__`). Not part of `hash`. */
  readonly time: number
  /** Caller-supplied commit info (`__info__`), or null. */
  readonly info: CommitInfo | null
  /** Values written at this commit: key → value bytes. Their blob
   *  pointers are `<hash>:<key>` by construction. */
  readonly updates: ReadonlyMap<string, Uint8Array>
  /** Keys present in `parents[0]`'s keyset but absent here. */
  readonly removals: ReadonlySet<string>
  /** Per-key metadata fidelity for `updates`: kvgit stamps `createdAt`
   *  slightly before commit time, so replay can't derive it. Not part
   *  of `hash` (display metadata), but carried for exactness. */
  readonly meta: ReadonlyMap<string, { readonly createdAt: number }>
  /**
   * Keys whose pointer differs from `parents[0]`'s but was NOT written
   * at this commit — adopted from another ancestor (merge carries from
   * the non-first parent's side). The pointer is `<owner>:<key>`.
   * Replay must reproduce these pointers exactly — `contentHash`
   * covers the pointer map, so deriving them from `parents[0]` instead
   * would change the hash. `size`/`createdAt` ride along so the
   * replayer can rebuild the carried keyset entry without consulting
   * any parent keyset (the carry's blob was written by an earlier
   * commit, so its meta isn't derivable from this commit's wire form).
   */
  readonly carries: ReadonlyMap<
    string,
    { readonly owner: string; readonly size: number; readonly createdAt: number }
  >
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode a value to bytes for storage. The chunk-aware variants from
 * kvgit-py are deferred from v1; the encoder/decoder shape here will
 * extend additively when chunked codecs land.
 */
export type Encoder<T = unknown> = (value: T) => Uint8Array

export type Decoder<T = unknown> = (bytes: Uint8Array) => T
