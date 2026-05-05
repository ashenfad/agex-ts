/**
 * Shared commit / merge orchestration for versioned stores.
 *
 * `VersionedBase` provides:
 * - The `commit()` flow: fast-forward + CAS, three-way merge fallback
 *   on HEAD divergence, snapshot/restore on failed CAS.
 * - History walking, key-level diff, parent lookup, merge fn registry.
 *
 * Subclasses provide storage-specific operations (CAS, commit creation,
 * blob reading, LCA finding). Anything that touches storage layout is
 * abstract; everything that orchestrates the protocol is concrete.
 */

import {
  type BytesMergeFn,
  type CommitInfo,
  ConcurrencyError,
  type ConflictDisposition,
  type DiffResult,
  MergeConflict,
  type MergeResult,
  type Versioned,
  type VersionedCommitOptions,
} from '../types'
import { diffKeysets, walkHistory } from './helpers'
import { type MergeResolution, resolveMerge } from './merge'

/**
 * Abstract base for versioned KV stores.
 *
 * Manages the in-memory snapshot of the current commit's flat keyset
 * and orchestrates `commit()`. Subclasses fill in the abstract methods
 * to bind the orchestration to specific storage.
 */
export abstract class VersionedBase implements Versioned {
  protected branch: string
  protected currentCommitHash: string
  protected baseCommitHash: string
  protected commitKeys: Map<string, string>
  protected mergeFns: Map<string, BytesMergeFn>
  protected defaultMergeFn: BytesMergeFn | null
  lastMergeResult: MergeResult | null

  /** Cached on first access; the root commit walking back from HEAD. */
  private cachedInitialCommit: string | null = null

  protected constructor(opts: { branch: string; commitHash: string }) {
    this.branch = opts.branch
    this.currentCommitHash = opts.commitHash
    this.baseCommitHash = opts.commitHash
    this.commitKeys = new Map()
    this.mergeFns = new Map()
    this.defaultMergeFn = null
    this.lastMergeResult = null
  }

  // --- Properties ---

  get currentCommit(): string {
    return this.currentCommitHash
  }

  get baseCommit(): string {
    return this.baseCommitHash
  }

  get currentBranch(): string {
    return this.branch
  }

  get initialCommit(): string {
    if (this.cachedInitialCommit !== null) return this.cachedInitialCommit
    // Synchronous accessor over an async walk: we kick off a sync best-
    // effort walk by re-using the in-memory state. The first call after
    // construction is async-only, so callers should `await initial()`
    // when they need it. The property here is a convenience for the
    // already-resolved case.
    throw new Error('initialCommit not yet resolved; call await initial() first')
  }

  /** Resolve the root commit by walking the parent chain. Caches the result. */
  async initial(): Promise<string> {
    if (this.cachedInitialCommit !== null) return this.cachedInitialCommit
    let last = this.currentCommitHash
    for await (const c of this.history()) last = c
    this.cachedInitialCommit = last
    return last
  }

  // --- Reads (in-memory keyset) ---

  async get(key: string): Promise<Uint8Array | null> {
    const blob = this.commitKeys.get(key)
    if (blob === undefined) return null
    return this.readBlob(blob)
  }

  async getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    for (const key of keys) {
      const v = await this.get(key)
      if (v !== null) out.set(key, v)
    }
    return out
  }

  async has(key: string): Promise<boolean> {
    return this.commitKeys.has(key)
  }

  async *keys(): AsyncIterable<string> {
    for (const k of this.commitKeys.keys()) yield k
  }

  // --- Merge fn registry ---

  setMergeFn(key: string, fn: BytesMergeFn): void {
    this.mergeFns.set(key, fn)
  }

  setDefaultMerge(fn: BytesMergeFn): void {
    this.defaultMergeFn = fn
  }

  // --- History and diff ---

  async diff(commitA: string, commitB: string): Promise<DiffResult> {
    const a = await this.loadKeyset(commitA)
    const b = await this.loadKeyset(commitB)
    return diffKeysets(a, b)
  }

  history(commitHash?: string, opts: { allParents?: boolean } = {}): AsyncIterable<string> {
    const start = commitHash ?? this.currentCommitHash
    return walkHistory(start, (h) => this.loadParents(h), opts)
  }

  async parents(commitHash?: string): Promise<readonly string[]> {
    return this.loadParents(commitHash ?? this.currentCommitHash)
  }

  // --- Commit orchestration ---

  async commit(opts: VersionedCommitOptions = {}): Promise<MergeResult> {
    const updates = opts.updates ?? null
    const removals = opts.removals ?? null
    const onConflict: ConflictDisposition = opts.onConflict ?? 'raise'
    const info = opts.info ?? null

    // No-op when nothing was provided. Matching kvgit-py's "nothing to do"
    // shortcut: a bare commit() with no changes and no info simply
    // reports the current HEAD, doesn't write anything.
    if (
      (updates === null || updates.size === 0) &&
      (removals === null || removals.size === 0) &&
      info === null
    ) {
      const result: MergeResult = {
        merged: true,
        commit: this.currentCommitHash,
        strategy: 'no_op',
        autoMergedKeys: [],
        carriedKeys: [],
      }
      this.lastMergeResult = result
      return result
    }

    if (onConflict !== 'raise' && onConflict !== 'skip') {
      throw new TypeError(`onConflict must be 'raise' or 'skip', got ${String(onConflict)}`)
    }

    const currentHead = await this.latestHead()

    // Fast-forward path: HEAD hasn't moved.
    if (currentHead === this.baseCommitHash) {
      const saved = this.snapshotState()
      await this.createCommit({
        ...(updates !== null && { updates }),
        ...(removals !== null && { removals }),
        ...(info !== null && { info }),
      })
      const ok = await this.casHead(this.baseCommitHash, this.currentCommitHash)
      if (ok) {
        this.baseCommitHash = this.currentCommitHash
        const result: MergeResult = {
          merged: true,
          commit: this.currentCommitHash,
          strategy: 'fast_forward',
          autoMergedKeys: [],
          carriedKeys: [...this.commitKeys.keys()],
        }
        this.lastMergeResult = result
        return result
      }
      this.restoreState(saved)
      if (onConflict === 'skip') {
        const result: MergeResult = {
          merged: false,
          commit: null,
          strategy: 'fast_forward',
          autoMergedKeys: [],
          carriedKeys: [],
        }
        this.lastMergeResult = result
        return result
      }
      throw new ConcurrencyError(`HEAD changed from ${this.baseCommitHash}. Refresh and retry.`)
    }

    // Three-way merge path: HEAD has moved.
    if (currentHead === null) {
      throw new Error(`Branch '${this.branch}' has no HEAD`)
    }
    const saved = this.snapshotState()
    await this.createCommit({
      ...(updates !== null && { updates }),
      ...(removals !== null && { removals }),
    })
    return this.threeWayMerge(currentHead, {
      onConflict,
      ...(opts.mergeFns !== null && opts.mergeFns !== undefined && { mergeFns: opts.mergeFns }),
      ...(opts.defaultMerge !== null &&
        opts.defaultMerge !== undefined && { defaultMerge: opts.defaultMerge }),
      ...(info !== null && { info }),
      savedState: saved,
    })
  }

  private async threeWayMerge(
    theirHead: string,
    opts: {
      onConflict: ConflictDisposition
      mergeFns?: Map<string, BytesMergeFn>
      defaultMerge?: BytesMergeFn
      info?: CommitInfo
      savedState: unknown
    },
  ): Promise<MergeResult> {
    const lca = await this.findLca(this.currentCommitHash, theirHead)
    if (lca === null) {
      this.restoreState(opts.savedState)
      if (opts.onConflict === 'skip') {
        const result: MergeResult = {
          merged: false,
          commit: null,
          strategy: 'three_way',
          autoMergedKeys: [],
          carriedKeys: [],
        }
        this.lastMergeResult = result
        return result
      }
      throw new ConcurrencyError('No common ancestor found between current commit and HEAD.')
    }

    // Load each unique commit's keyset exactly once. Skipping this dedup
    // costs ~3× the round-trips on high-latency stores.
    const lcaKeyset = await this.loadKeyset(lca)
    const ourKeyset = await this.loadKeyset(this.currentCommitHash)
    const theirKeyset = await this.loadKeyset(theirHead)

    const ourDiff = diffKeysets(lcaKeyset, ourKeyset)
    const theirDiff = diffKeysets(lcaKeyset, theirKeyset)

    const effectiveFns = new Map(this.mergeFns)
    if (opts.mergeFns) {
      for (const [k, v] of opts.mergeFns) effectiveFns.set(k, v)
    }
    const effectiveDefault = opts.defaultMerge ?? this.defaultMergeFn

    let resolution: MergeResolution
    try {
      resolution = await resolveMerge({
        lcaKeyset,
        ourKeyset,
        theirKeyset,
        ourDiff,
        theirDiff,
        blobReader: (id) => this.readBlob(id),
        mergeFns: effectiveFns,
        defaultMerge: effectiveDefault,
      })
    } catch (e) {
      if (e instanceof MergeConflict) {
        this.restoreState(opts.savedState)
        if (opts.onConflict === 'skip') {
          const result: MergeResult = {
            merged: false,
            commit: null,
            strategy: 'three_way',
            autoMergedKeys: [],
            carriedKeys: [],
          }
          this.lastMergeResult = result
          return result
        }
      }
      throw e
    }

    const parents: readonly string[] = [theirHead, this.currentCommitHash]
    await this.createMergeCommit(resolution, parents, opts.info ?? null)
    const mergeHash = this.currentCommitHash
    const mergedKeyset = this.commitKeys

    if (await this.casHead(theirHead, mergeHash)) {
      this.baseCommitHash = mergeHash
      const carriedKeys: string[] = []
      for (const k of mergedKeyset.keys()) {
        if (!resolution.autoMergedKeys.includes(k) && !resolution.mergedValues.has(k)) {
          carriedKeys.push(k)
        }
      }
      const result: MergeResult = {
        merged: true,
        commit: mergeHash,
        strategy: 'three_way',
        autoMergedKeys: [...resolution.autoMergedKeys],
        carriedKeys,
      }
      this.lastMergeResult = result
      return result
    }

    this.restoreState(opts.savedState)
    if (opts.onConflict === 'skip') {
      const result: MergeResult = {
        merged: false,
        commit: null,
        strategy: 'three_way',
        autoMergedKeys: [],
        carriedKeys: [],
      }
      this.lastMergeResult = result
      return result
    }
    throw new ConcurrencyError('HEAD changed during three-way merge. Refresh and retry.')
  }

  // --- Abstract methods (concrete subclasses provide) ---

  abstract latestHead(): Promise<string | null>
  abstract peek(key: string, opts: { branch: string }): Promise<Uint8Array | null>
  abstract refresh(): Promise<void>
  abstract checkout(commitHash: string, opts?: { branch?: string }): Promise<Versioned | null>
  abstract createBranch(name: string, opts?: { at?: string }): Promise<Versioned>
  abstract deleteBranch(name: string): Promise<void>
  abstract switchBranch(name: string): Promise<void>
  abstract resetTo(commitHash: string): Promise<boolean>
  abstract listBranches(): Promise<string[]>
  abstract commitInfo(commitHash?: string): Promise<CommitInfo | null>

  protected abstract snapshotState(): unknown
  protected abstract restoreState(saved: unknown): void
  protected abstract createCommit(opts: {
    updates?: Map<string, Uint8Array>
    removals?: Set<string>
    info?: CommitInfo
  }): Promise<string>
  protected abstract createMergeCommit(
    resolution: MergeResolution,
    parents: readonly string[],
    info: CommitInfo | null,
  ): Promise<string>
  protected abstract casHead(expected: string, newHead: string): Promise<boolean>
  protected abstract loadKeyset(commitHash: string): Promise<Map<string, string>>
  protected abstract loadParents(commitHash: string): Promise<readonly string[]>
  protected abstract findLca(commitA: string, commitB: string): Promise<string | null>
  protected abstract readBlob(blobId: string): Promise<Uint8Array | null>
}
