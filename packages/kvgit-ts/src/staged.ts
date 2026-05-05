/**
 * Staged: a buffered, Map-shaped layer over a `Versioned`.
 *
 * Writes (`set` / `delete`) accumulate in memory; nothing reaches the
 * underlying store until `commit()` flushes them as a single atomic
 * commit (with optional three-way merge if HEAD has moved).
 *
 * Reads check the staging buffer first, then a per-instance read cache,
 * then the underlying store. Decoded values are cached so repeat reads
 * don't re-decode.
 *
 * The encoder/decoder convert user values to/from bytes for storage.
 * The default is JSON over UTF-8; pass custom codecs for richer types
 * (cbor for Map/Set/Date/typed arrays, msgpack for compactness, etc.).
 */

import type {
  CommitInfo,
  ConflictDisposition,
  Decoder,
  Encoder,
  MergeFn,
  MergeResult,
  Versioned,
} from './types'
import type { BytesMergeFn } from './types'

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

/** Default encoder: JSON via UTF-8. JSON-serializable values only. */
export const jsonEncoder: Encoder = (value) => _encoder.encode(JSON.stringify(value))

/** Default decoder: JSON via UTF-8. Mirrors `jsonEncoder`. */
export const jsonDecoder: Decoder = (bytes) => JSON.parse(_decoder.decode(bytes))

export interface StagedOptions {
  encoder?: Encoder
  decoder?: Decoder
}

export interface StagedCommitOptions {
  /** If provided, only these keys are flushed; others remain staged. */
  keys?: Set<string>
  onConflict?: ConflictDisposition
  /** Per-key merge fns added on top of the registered ones for this commit. */
  mergeFns?: Map<string, MergeFn>
  defaultMerge?: MergeFn
  info?: CommitInfo
}

/**
 * Buffered writes over a `Versioned`. Implements a Map-shaped surface;
 * staged changes flush atomically via `commit()`.
 *
 * Per-call generics on `get` / `set` give the call site typed access
 * (`staged.get<Model>('model')`); without a generic the value type is
 * `unknown` and the caller narrows.
 */
export class Staged {
  readonly versioned: Versioned
  private readonly encoder: Encoder
  private readonly decoder: Decoder

  // Buffered state. `_updates` holds new/replaced values; `_removals`
  // holds keys to delete. A key in `_updates` overrides any prior
  // removal and vice versa.
  private updates = new Map<string, unknown>()
  private removals = new Set<string>()
  private cache = new Map<string, unknown>()

  // User-level merge fns (decoded values cross the boundary).
  private userMergeFns = new Map<string, MergeFn>()
  private userDefaultMerge: MergeFn | null = null

  constructor(versioned: Versioned, opts: StagedOptions = {}) {
    this.versioned = versioned
    this.encoder = opts.encoder ?? jsonEncoder
    this.decoder = opts.decoder ?? jsonDecoder
  }

  // --- Versioned pass-through (read-only) ---

  get currentCommit(): string {
    return this.versioned.currentCommit
  }

  get baseCommit(): string {
    return this.versioned.baseCommit
  }

  get currentBranch(): string {
    return this.versioned.currentBranch
  }

  get initialCommit(): string {
    return this.versioned.initialCommit
  }

  get lastMergeResult(): MergeResult | null {
    return this.versioned.lastMergeResult
  }

  // --- Reads ---

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (this.removals.has(key)) return undefined
    if (this.updates.has(key)) return this.updates.get(key) as T
    if (this.cache.has(key)) return this.cache.get(key) as T
    const raw = await this.versioned.get(key)
    if (raw === null) return undefined
    const value = this.decoder(raw) as T
    this.cache.set(key, value)
    return value
  }

  async has(key: string): Promise<boolean> {
    if (this.removals.has(key)) return false
    if (this.updates.has(key)) return true
    return this.versioned.has(key)
  }

  async *keys(): AsyncIterable<string> {
    const seen = new Set<string>()
    for await (const k of this.versioned.keys()) {
      if (this.removals.has(k)) continue
      seen.add(k)
      yield k
    }
    for (const k of this.updates.keys()) {
      if (!seen.has(k)) yield k
    }
  }

  // --- Writes (in-memory buffer; no IO) ---

  set<T = unknown>(key: string, value: T): void {
    this.removals.delete(key)
    this.updates.set(key, value)
  }

  delete(key: string): void {
    this.updates.delete(key)
    this.removals.add(key)
  }

  /** Whether there are any staged changes. */
  get hasChanges(): boolean {
    return this.updates.size > 0 || this.removals.size > 0
  }

  /** Whether a specific key has a pending update or removal. */
  isStaged(key: string): boolean {
    return this.updates.has(key) || this.removals.has(key)
  }

  /** Discard all staged changes and the read cache. */
  reset(): void {
    this.updates.clear()
    this.removals.clear()
    this.cache.clear()
  }

  // --- Merge fn registry (user-level: decoded values) ---

  setMergeFn<T = unknown>(key: string, fn: MergeFn<T>): void {
    this.userMergeFns.set(key, fn as MergeFn)
  }

  setDefaultMerge<T = unknown>(fn: MergeFn<T>): void {
    this.userDefaultMerge = fn as MergeFn
  }

  // --- Commit ---

  async commit(opts: StagedCommitOptions = {}): Promise<MergeResult> {
    const { keys: filterKeys } = opts

    // Encode the staged updates targeted by this commit.
    let encodedUpdates: Map<string, Uint8Array> | null = null
    let effectiveRemovals: Set<string> | null = null

    if (filterKeys !== undefined) {
      // Targeted commit: only flush keys in the filter that are also staged.
      const matchedUpdates = new Map<string, unknown>()
      for (const k of filterKeys) {
        if (this.updates.has(k)) matchedUpdates.set(k, this.updates.get(k))
      }
      if (matchedUpdates.size > 0) {
        encodedUpdates = new Map()
        for (const [k, v] of matchedUpdates) {
          encodedUpdates.set(k, this.encoder(v))
        }
      }
      const matchedRemovals = new Set<string>()
      for (const k of filterKeys) {
        if (this.removals.has(k)) matchedRemovals.add(k)
      }
      if (matchedRemovals.size > 0) effectiveRemovals = matchedRemovals
    } else {
      if (this.updates.size > 0) {
        encodedUpdates = new Map()
        for (const [k, v] of this.updates) {
          encodedUpdates.set(k, this.encoder(v))
        }
      }
      if (this.removals.size > 0) effectiveRemovals = new Set(this.removals)
    }

    // Build effective merge fns and wrap user-level → bytes-level.
    const effectiveFns = new Map(this.userMergeFns)
    if (opts.mergeFns) {
      for (const [k, fn] of opts.mergeFns) effectiveFns.set(k, fn)
    }
    const effectiveDefault = opts.defaultMerge ?? this.userDefaultMerge

    let bytesMergeFns: Map<string, BytesMergeFn> | null = null
    if (effectiveFns.size > 0) {
      bytesMergeFns = new Map()
      for (const [k, fn] of effectiveFns) {
        bytesMergeFns.set(k, this.wrapMergeFn(fn))
      }
    }
    const bytesDefault: BytesMergeFn | null =
      effectiveDefault !== null && effectiveDefault !== undefined
        ? this.wrapMergeFn(effectiveDefault)
        : null

    const result = await this.versioned.commit({
      ...(encodedUpdates !== null && { updates: encodedUpdates }),
      ...(effectiveRemovals !== null && { removals: effectiveRemovals }),
      ...(opts.onConflict !== undefined && { onConflict: opts.onConflict }),
      ...(bytesMergeFns !== null && { mergeFns: bytesMergeFns }),
      ...(bytesDefault !== null && { defaultMerge: bytesDefault }),
      ...(opts.info !== undefined && { info: opts.info }),
    })

    if (result.merged) {
      if (filterKeys !== undefined) {
        for (const k of filterKeys) {
          this.updates.delete(k)
          this.removals.delete(k)
        }
      } else {
        this.updates.clear()
        this.removals.clear()
      }
      // The full read cache must be cleared on any successful merge:
      // a three-way merge may have introduced changes from the other
      // side under keys we haven't touched, leaving cached entries
      // stale.
      this.cache.clear()
    }
    return result
  }

  /**
   * Wrap a user-level merge fn (decoded values) into a bytes-level fn
   * the `Versioned` layer can call. Encodes the merge result with the
   * configured encoder.
   */
  private wrapMergeFn(fn: MergeFn): BytesMergeFn {
    const encoder = this.encoder
    const decoder = this.decoder
    return (oldB, oursB, theirsB) => {
      const oldV = oldB !== null ? decoder(oldB) : null
      const ours = oursB !== null ? decoder(oursB) : null
      const theirs = theirsB !== null ? decoder(theirsB) : null
      return encoder(fn(oldV, ours, theirs))
    }
  }
}
