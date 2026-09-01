/**
 * KVStore-backed versioned state.
 *
 * Storage layout:
 *
 *   `__kvgit_version__`              — storage version sentinel (1 in v1)
 *   `__branch_head__<branch>`        — current HEAD commit hash
 *   `__branch_head_prev__<branch>`   — previous HEAD (recovery backup)
 *   `__commit_root__<commit>`        — keyset HAMT root hash
 *   `__parent_commit__<commit>`      — JSON list of parent commit hashes
 *   `__commit_time__<commit>`        — wall time epoch ms
 *   `__info__<commit>`               — optional caller-supplied info dict
 *   `kvgit:keyset:<node_hash>`       — HAMT node bytes (via Keyset)
 *   `<commit_hash>:<user_key>`       — blob value bytes
 *
 * `__branch_head_prev__` is written only after a HEAD swap succeeds, so
 * it always names a commit `__branch_head__` really held. Recovery
 * reads it, so a value that was never HEAD would graft onto the branch
 * a lineage it never had. See `casHead` for what that does and does
 * not guarantee, and `repairHead` for the explicit repair path.
 *
 * The keyset is a content-addressable HAMT (`Keyset` over `Hamt`) so
 * unchanged subtrees are shared across commits by hash equality. A
 * single-key change writes O(log N) new HAMT nodes instead of
 * rewriting a full snapshot per commit.
 */

import { Keyset } from '../keyset'
import type { CommitInfo, KVStore, KeysetEntry, MetaEntry, Versioned } from '../types'
import { VersionedBase } from './base'
import {
  BRANCH_HEAD,
  BRANCH_HEAD_PREFIX,
  BRANCH_HEAD_PREV,
  COMMIT_ROOT,
  COMMIT_TIME,
  INFO_KEY,
  PARENT_COMMIT,
  blobPointer,
  checkStorageVersion,
  contentHash,
  dumps,
  loads,
  pendingPointer,
  safeLoads,
} from './layout'
import type { MergeResolution } from './merge'

// ---------------------------------------------------------------------------
// Recovery layer
// ---------------------------------------------------------------------------

/**
 * Optional second-tier corrupt-HEAD recovery.
 *
 * Slot for the deferred kvgit-py `_resolve_head` commit-scan fallback.
 * v1 ships without an implementation; users with a corruption surface
 * can wire one in (the function gets the store + branch and returns a
 * recovered commit hash, or null if unrecoverable).
 *
 * If unset, corrupt-HEAD recovery stops at the prev-HEAD tier.
 */
export type CorruptHeadRecoverer = (store: KVStore, branch: string) => Promise<string | null>

/**
 * Resolve the HEAD of a branch with prev-HEAD fallback.
 *
 * Tries:
 *   1. `__branch_head__<branch>` — current pointer
 *   2. `__branch_head_prev__<branch>` — backup written after each CAS
 *   3. `recoverFromCorruptHead` — optional injected fallback (slot-only in v1)
 *
 * **Never writes.** Every read path in the library goes through here,
 * so healing the damage in place would make an ordinary `get` a
 * mutation — impossible for a read-only consumer, and a race between
 * two readers repairing the same branch to different answers. The
 * recovery is returned to the caller and forgotten; {@link repairHead}
 * is the explicit call that makes it durable, and the write path heals
 * HEAD itself as part of the CAS that has to move it anyway.
 *
 * Returns null if nothing recovers.
 */
async function resolveHead(
  store: KVStore,
  branch: string,
  opts: { recoverFromCorruptHead?: CorruptHeadRecoverer } = {},
): Promise<string | null> {
  // Try current HEAD.
  const headBytes = await store.get(BRANCH_HEAD(branch))
  if (headBytes !== null) {
    const commitHash = safeLoads(headBytes)
    if (typeof commitHash === 'string' && (await store.get(COMMIT_ROOT(commitHash))) !== null) {
      return commitHash
    }
  }

  // HEAD is present but unusable — try the backup.
  //
  // Gated on HEAD *existing*, the same condition the injected tier
  // below already applies. An absent HEAD is not damage, it means the
  // branch is gone: `deleteBranch` removes the key. A backup that
  // outlives it — a writer descheduled between its CAS and its backup
  // write, resuming after a concurrent delete and recreating only the
  // backup — must not bring the branch back through this tier.
  //
  // Nothing legitimate needs the ungated form: `casHead` writes the
  // backup only after a successful CAS, so HEAD exists whenever the
  // backup means anything.
  const prevBytes = headBytes === null ? null : await store.get(BRANCH_HEAD_PREV(branch))
  if (prevBytes !== null) {
    const commitHash = safeLoads(prevBytes)
    if (typeof commitHash === 'string' && (await store.get(COMMIT_ROOT(commitHash))) !== null) {
      console.warn(`kvgit: branch '${branch}' HEAD corrupt, recovered from prev HEAD`)
      return commitHash
    }
  }

  // Try the injected commit-scan fallback (slot-only in v1).
  if (opts.recoverFromCorruptHead && headBytes !== null) {
    const recovered = await opts.recoverFromCorruptHead(store, branch)
    if (recovered !== null) {
      console.warn(`kvgit: branch '${branch}' HEAD corrupt, recovered via scan`)
      return recovered
    }
  }

  return null
}

/** Bytewise equality for two `Uint8Array`s. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Atomically replace an unresolvable HEAD with a recovered value.
 *
 * Returns true only when HEAD was damaged *and* this call is the one
 * that replaced it. Three cases are deliberately left alone:
 *
 *   - HEAD resolves fine — it did not break, it *moved*, and another
 *     writer won a legitimate race. Overwriting it would destroy a
 *     good commit to make a losing CAS succeed.
 *   - HEAD already holds `recovered` — nothing to do.
 *   - HEAD is absent — the branch was deleted. Re-creating the key is
 *     exactly the resurrection `deleteBranch` drops the prev-HEAD
 *     backup to prevent.
 *
 * The replacement is a CAS against the exact damaged bytes, so two
 * writers healing the same branch cannot both win, and a HEAD that
 * someone else repaired (or advanced) in the meantime is never
 * clobbered.
 */
async function healHead(store: KVStore, branch: string, recovered: Uint8Array): Promise<boolean> {
  const branchKey = BRANCH_HEAD(branch)
  const raw = await store.get(branchKey)
  if (raw === null || bytesEqual(raw, recovered)) return false
  const commitHash = safeLoads(raw)
  if (typeof commitHash === 'string' && (await store.get(COMMIT_ROOT(commitHash))) !== null) {
    return false
  }
  if (!(await store.cas(branchKey, recovered, raw))) return false
  console.warn(`kvgit: branch '${branch}' corrupt HEAD replaced with recovered commit`)
  return true
}

/**
 * Persist a recovered HEAD for a damaged branch.
 *
 * Read paths recover a corrupt `__branch_head__` in memory and leave
 * the store untouched, so the damage stays visible until someone
 * decides what to do about it. This is that decision: resolve the
 * branch the way a read would, and write the answer back.
 *
 * Handle-independent, like `cleanOrphans` — it takes a raw `KVStore`,
 * so it works with or without a `VersionedKV` anchored on the branch.
 *
 * Idempotent, and a no-op on a healthy branch. The write is a CAS
 * against the damaged bytes, so it cannot overwrite a HEAD another
 * writer fixed, or advanced, in the meantime.
 *
 * When that CAS does not win, the recovery candidate is stale and
 * returning it would name an older commit than HEAD actually holds.
 * The branch is re-resolved instead, so the answer describes the store
 * rather than the attempt.
 *
 * @returns The commit HEAD now names, or null if the branch does not
 *   exist or nothing recoverable was found.
 */
export async function repairHead(
  store: KVStore,
  branch = 'main',
  opts: { recoverFromCorruptHead?: CorruptHeadRecoverer } = {},
): Promise<string | null> {
  const commitHash = await resolveHead(store, branch, opts)
  if (commitHash === null) return null
  if (await healHead(store, branch, dumps(commitHash))) return commitHash
  // The heal declined: another writer repaired, advanced or deleted
  // the branch in between, so the candidate is stale and returning it
  // would name an older commit than HEAD actually holds.
  return resolveHead(store, branch, opts)
}

// ---------------------------------------------------------------------------
// VersionedKV
// ---------------------------------------------------------------------------

export interface VersionedKVOptions {
  branch?: string
  /** Pin to a specific commit instead of resolving the branch HEAD. */
  commitHash?: string
  /** Slot for second-tier corrupt-HEAD recovery (see `CorruptHeadRecoverer`). */
  recoverFromCorruptHead?: CorruptHeadRecoverer
}

interface SnapshotState {
  currentCommit: string
  commitKeys: Map<string, string>
  meta: Map<string, MetaEntry>
}

/**
 * A commit log over a `KVStore`.
 *
 * Construct via the async `VersionedKV.open(store, opts?)` factory —
 * the constructor itself is private because initialization needs to
 * resolve HEAD (and possibly create an initial empty commit), both of
 * which are async.
 */
export class VersionedKV extends VersionedBase {
  readonly store: KVStore
  private meta: Map<string, MetaEntry>
  private readonly recoverFromCorruptHead: CorruptHeadRecoverer | undefined

  private constructor(opts: {
    store: KVStore
    branch: string
    commitHash: string
    commitKeys: Map<string, string>
    meta: Map<string, MetaEntry>
    recoverFromCorruptHead: CorruptHeadRecoverer | undefined
  }) {
    super({ branch: opts.branch, commitHash: opts.commitHash })
    this.store = opts.store
    this.commitKeys = opts.commitKeys
    this.meta = opts.meta
    this.recoverFromCorruptHead = opts.recoverFromCorruptHead
  }

  /**
   * Open or create a versioned store on `store`.
   *
   * Resolves the branch HEAD with prev-HEAD recovery; creates an
   * initial empty commit if the branch doesn't exist yet. Validates
   * the storage version (rejects formats from other versions).
   */
  static async open(store: KVStore, opts: VersionedKVOptions = {}): Promise<VersionedKV> {
    await checkStorageVersion(store)
    const branch = opts.branch ?? 'main'

    let commitHash = opts.commitHash
    if (commitHash === undefined) {
      const recovered = await resolveHead(store, branch, {
        ...(opts.recoverFromCorruptHead !== undefined && {
          recoverFromCorruptHead: opts.recoverFromCorruptHead,
        }),
      })
      if (recovered !== null) {
        commitHash = recovered
      } else if ((await store.get(BRANCH_HEAD(branch))) !== null) {
        throw new Error(`Branch '${branch}' HEAD is corrupt and unrecoverable`)
      } else {
        // Create initial empty commit.
        const initialHash = await contentHash([], new Map(), new Map(), null)
        await store.setMany([
          [COMMIT_ROOT(initialHash), dumps((await Keyset.empty(store)).root)],
          [PARENT_COMMIT(initialHash), dumps([])],
          [COMMIT_TIME(initialHash), dumps(Date.now())],
          [BRANCH_HEAD(branch), dumps(initialHash)],
        ])
        commitHash = initialHash
      }
    }

    const { commitKeys, meta } = await populateState(store, commitHash)
    return new VersionedKV({
      store,
      branch,
      commitHash,
      commitKeys,
      meta,
      recoverFromCorruptHead: opts.recoverFromCorruptHead,
    })
  }

  // --- VersionedBase abstract methods ---

  async latestHead(): Promise<string | null> {
    return resolveHead(this.store, this.branch, {
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    })
  }

  protected snapshotState(): SnapshotState {
    return {
      currentCommit: this.currentCommitHash,
      commitKeys: new Map(this.commitKeys),
      meta: new Map(this.meta),
    }
  }

  protected restoreState(saved: unknown): void {
    const s = saved as SnapshotState
    this.currentCommitHash = s.currentCommit
    this.commitKeys = s.commitKeys
    this.meta = s.meta
  }

  protected async createCommit(opts: {
    updates?: Map<string, Uint8Array>
    removals?: Set<string>
    info?: CommitInfo
  }): Promise<string> {
    const updates = opts.updates ?? new Map<string, Uint8Array>()
    const removals = opts.removals ?? new Set<string>()
    const info = opts.info ?? null

    // Build new keyset by carrying forward, applying removals, then
    // reserving slots for updates (real blob keys depend on the new
    // commit hash, computed below).
    const newCommitKeys = new Map<string, string>()
    const newMeta = new Map<string, MetaEntry>()
    for (const [k, ptr] of this.commitKeys) {
      if (removals.has(k)) continue
      newCommitKeys.set(k, ptr)
      const m = this.meta.get(k)
      if (m !== undefined) newMeta.set(k, m)
    }

    // Compute the new hash from a placeholder keyset that uses
    // <pending:key> sentinels for new updates (real versioned keys
    // depend on the hash itself, which we don't know yet).
    const previewKeys = new Map(newCommitKeys)
    for (const k of updates.keys()) previewKeys.set(k, pendingPointer(k))
    const newHash = await contentHash([this.currentCommitHash], previewKeys, updates, info)

    // Resolve real blob keys for the updates.
    const blobWrites: Array<[string, Uint8Array]> = []
    const now = Date.now()
    for (const [key, value] of updates) {
      const versionedKey = blobPointer(newHash, key)
      blobWrites.push([versionedKey, value])
      newCommitKeys.set(key, versionedKey)
      const existing = newMeta.get(key)
      const createdAt = existing !== undefined ? existing.createdAt : now
      newMeta.set(key, { size: value.length, createdAt })
    }

    // Build the new keyset HAMT by applying changes over the parent's.
    const parentRootBytes = await this.store.get(COMMIT_ROOT(this.currentCommitHash))
    const parentRoot = parentRootBytes !== null ? (loads(parentRootBytes) as string) : null
    const parentKs =
      parentRoot !== null ? Keyset.fromRoot(this.store, parentRoot) : await Keyset.empty(this.store)

    const keysetUpdates: Array<[string, KeysetEntry]> = []
    for (const k of updates.keys()) {
      const m = newMeta.get(k) as MetaEntry
      keysetUpdates.push([k, { blob: newCommitKeys.get(k) as string, meta: m }])
    }
    const newKs = await parentKs.updated({ updates: keysetUpdates, removals })

    // Build the atomic write batch: blobs + HAMT pending + commit
    // metadata. One setMany so a crash mid-write doesn't strand
    // partial state visible to readers.
    const writes: Array<[string, Uint8Array]> = [...blobWrites]
    for (const [k, v] of newKs.pending) writes.push([k, v])
    writes.push([COMMIT_ROOT(newHash), dumps(newKs.root)])
    writes.push([PARENT_COMMIT(newHash), dumps([this.currentCommitHash])])
    writes.push([COMMIT_TIME(newHash), dumps(Date.now())])
    if (info !== null) writes.push([INFO_KEY(newHash), dumps(info)])

    await this.store.setMany(writes)

    this.commitKeys = newCommitKeys
    this.currentCommitHash = newHash
    this.meta = newMeta
    return newHash
  }

  protected async createMergeCommit(
    resolution: MergeResolution,
    parents: readonly string[],
    info: CommitInfo | null,
  ): Promise<string> {
    const mergedKeyset = new Map(resolution.mergedKeyset)
    const mergedValues = resolution.mergedValues

    // Placeholder keys for newly-merged values (their real blob keys
    // depend on the merge hash, which we compute from the placeholder
    // form — same trick as createCommit).
    const previewKeys = new Map(mergedKeyset)
    for (const k of mergedValues.keys()) previewKeys.set(k, pendingPointer(k))
    const mergeHash = await contentHash(parents, previewKeys, mergedValues, info)

    // Resolve real blob keys for merged values.
    const blobWrites: Array<[string, Uint8Array]> = []
    for (const [key, value] of mergedValues) {
      const versionedKey = blobPointer(mergeHash, key)
      blobWrites.push([versionedKey, value])
      mergedKeyset.set(key, versionedKey)
    }

    // Build merged meta. Most keys' meta comes from our in-memory
    // map; the only keys we need from "their" side are those that
    // ended up in mergedKeyset, weren't merged-value-produced, and
    // we don't already have meta for. That's typically a small set
    // (keys "they" added that "we" didn't have). Look those up
    // pointwise rather than walking the entire "their" keyset.
    const theirParent = parents[0] as string
    const theirRootBytes = await this.store.get(COMMIT_ROOT(theirParent))
    const theirKs =
      theirRootBytes !== null ? Keyset.fromRoot(this.store, loads(theirRootBytes) as string) : null

    const now = Date.now()
    const mergedMeta = new Map<string, MetaEntry>()
    for (const k of mergedKeyset.keys()) {
      if (mergedValues.has(k)) {
        mergedMeta.set(k, { size: (mergedValues.get(k) as Uint8Array).length, createdAt: now })
      } else if (this.meta.has(k)) {
        mergedMeta.set(k, this.meta.get(k) as MetaEntry)
      } else if (theirKs !== null) {
        const theirEntry = await theirKs.get(k)
        if (theirEntry !== null) mergedMeta.set(k, theirEntry.meta)
      }
    }

    // Apply on top of our parent's HAMT, computing the minimal
    // updates and removals so structural sharing kicks in for
    // unchanged subtrees.
    const ourRootBytes = await this.store.get(COMMIT_ROOT(this.currentCommitHash))
    const ourRoot = ourRootBytes !== null ? (loads(ourRootBytes) as string) : null
    const parentKs =
      ourRoot !== null ? Keyset.fromRoot(this.store, ourRoot) : await Keyset.empty(this.store)

    const keysetUpdates: Array<[string, KeysetEntry]> = []
    for (const [k, blob] of mergedKeyset) {
      const newEntry: KeysetEntry = { blob, meta: mergedMeta.get(k) as MetaEntry }
      const oldBlob = this.commitKeys.get(k)
      const oldMeta = this.meta.get(k)
      if (
        oldBlob !== newEntry.blob ||
        oldMeta?.size !== newEntry.meta.size ||
        oldMeta?.createdAt !== newEntry.meta.createdAt
      ) {
        keysetUpdates.push([k, newEntry])
      }
    }
    const keysetRemovals = new Set<string>()
    for (const k of this.commitKeys.keys()) {
      if (!mergedKeyset.has(k)) keysetRemovals.add(k)
    }

    const newKs = await parentKs.updated({
      updates: keysetUpdates,
      removals: keysetRemovals,
    })

    const writes: Array<[string, Uint8Array]> = [...blobWrites]
    for (const [k, v] of newKs.pending) writes.push([k, v])
    writes.push([COMMIT_ROOT(mergeHash), dumps(newKs.root)])
    writes.push([PARENT_COMMIT(mergeHash), dumps(parents)])
    writes.push([COMMIT_TIME(mergeHash), dumps(Date.now())])
    if (info !== null) writes.push([INFO_KEY(mergeHash), dumps(info)])

    await this.store.setMany(writes)

    this.commitKeys = mergedKeyset
    this.currentCommitHash = mergeHash
    this.meta = mergedMeta
    return mergeHash
  }

  /**
   * Atomically advance the branch HEAD, then back up what it held.
   *
   * The prev-HEAD backup is written **after** the swap succeeds, never
   * before. Written first, it lands whether or not the CAS does, so a
   * writer that loses the race still leaves its own stale `expected`
   * as the branch's recovery target — clobbering the winner's backup,
   * and, when `expected` came from a corrupt-HEAD recovery, naming a
   * commit that was never HEAD at all. Writing it afterwards makes it
   * always a value `__branch_head__` really held.
   *
   * What this does **not** buy is a backup that is always exactly one
   * commit back. The swap and the backup write are two steps, and
   * anything that separates them — a crash, or simply losing the CPU
   * while another writer completes both of its own — lets the older
   * writer's backup land last. HEAD then sits two or more commits
   * ahead of a backup that is still a real former HEAD, and recovery
   * skips whatever came between.
   *
   * So the guarantee is the narrower one: the backup always names a
   * commit `__branch_head__` really held, never a commit invented by a
   * losing writer. Recovery may lose more than one commit; it cannot
   * graft on a lineage the branch never had. `KVStore.cas` takes a
   * single key and no backend exposes a transaction spanning two, so
   * HEAD and its backup cannot move in one step.
   *
   * A CAS that fails against a *damaged* HEAD is retried once behind
   * {@link healHead}, which repairs it atomically. That is the only
   * place a corrupt HEAD is written back, now that reads do not.
   */
  protected async casHead(expected: string, newHead: string): Promise<boolean> {
    const branchKey = BRANCH_HEAD(this.branch)
    const expectedBytes = dumps(expected)
    const newBytes = dumps(newHead)

    let won = await this.store.cas(branchKey, newBytes, expectedBytes)
    if (!won && (await healHead(this.store, this.branch, expectedBytes))) {
      won = await this.store.cas(branchKey, newBytes, expectedBytes)
    }
    if (won) await this.store.set(BRANCH_HEAD_PREV(this.branch), expectedBytes)
    return won
  }

  protected async loadKeyset(commitHash: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const rootBytes = await this.store.get(COMMIT_ROOT(commitHash))
    if (rootBytes === null) return out
    const root = loads(rootBytes) as string
    const ks = Keyset.fromRoot(this.store, root)
    for await (const [k, entry] of ks.items()) out.set(k, entry.blob)
    return out
  }

  protected async loadParents(commitHash: string): Promise<readonly string[]> {
    const raw = await this.store.get(PARENT_COMMIT(commitHash))
    if (raw === null) return []
    const parsed = loads(raw)
    if (typeof parsed === 'string') return [parsed]
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string')
    return []
  }

  protected async findLca(commitA: string, commitB: string): Promise<string | null> {
    if (commitA === commitB) return commitA

    const seenA = new Set<string>([commitA])
    const seenB = new Set<string>([commitB])
    const queueA: string[] = [commitA]
    const queueB: string[] = [commitB]

    while (queueA.length > 0 || queueB.length > 0) {
      if (queueA.length > 0) {
        const current = queueA.shift() as string
        if (seenB.has(current)) return current
        for (const p of await this.loadParents(current)) {
          if (!seenA.has(p)) {
            seenA.add(p)
            queueA.push(p)
            if (seenB.has(p)) return p
          }
        }
      }
      if (queueB.length > 0) {
        const current = queueB.shift() as string
        if (seenA.has(current)) return current
        for (const p of await this.loadParents(current)) {
          if (!seenB.has(p)) {
            seenB.add(p)
            queueB.push(p)
            if (seenA.has(p)) return p
          }
        }
      }
    }
    return null
  }

  protected async readBlob(blobId: string): Promise<Uint8Array | null> {
    return this.store.get(blobId)
  }

  // --- Navigation ---

  async refresh(): Promise<void> {
    const head = await resolveHead(this.store, this.branch, {
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    })
    if (head === null) {
      throw new Error(`No HEAD commit found for branch '${this.branch}'`)
    }
    await this.loadCommitInto(head, true)
  }

  async checkout(commitHash: string, opts: { branch?: string } = {}): Promise<Versioned | null> {
    if ((await this.store.get(COMMIT_ROOT(commitHash))) === null) return null
    return VersionedKV.open(this.store, {
      commitHash,
      branch: opts.branch ?? this.branch,
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    })
  }

  async createBranch(name: string, opts: { at?: string } = {}): Promise<Versioned> {
    const target = opts.at ?? this.currentCommitHash
    if (opts.at !== undefined && (await this.store.get(COMMIT_ROOT(opts.at))) === null) {
      throw new Error(`Commit '${opts.at}' does not exist`)
    }
    const ok = await this.store.cas(BRANCH_HEAD(name), dumps(target), null)
    if (!ok) throw new Error(`Branch '${name}' already exists`)
    return VersionedKV.open(this.store, {
      branch: name,
      commitHash: target,
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    })
  }

  async deleteBranch(name: string): Promise<void> {
    if (name === this.branch) {
      throw new Error('Cannot delete the current branch')
    }
    if ((await this.store.get(BRANCH_HEAD(name))) === null) {
      throw new Error(`Branch '${name}' does not exist`)
    }
    await this.store.remove(BRANCH_HEAD(name))
    await this.store.remove(BRANCH_HEAD_PREV(name))
    // Note: the branch's now-unreachable commits are left in place;
    // reclaim them with cleanOrphans (or deepClean).
  }

  async switchBranch(name: string): Promise<void> {
    const head = await resolveHead(this.store, name, {
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    })
    if (head === null) {
      if ((await this.store.get(BRANCH_HEAD(name))) !== null) {
        throw new Error(`Branch '${name}' HEAD is corrupt and unrecoverable`)
      }
      throw new Error(`Branch '${name}' does not exist`)
    }
    this.branch = name
    await this.loadCommitInto(head, true)
  }

  async peek(key: string, opts: { branch: string }): Promise<Uint8Array | null> {
    const head = await resolveHead(this.store, opts.branch)
    if (head === null) return null
    const rootBytes = await this.store.get(COMMIT_ROOT(head))
    if (rootBytes === null) return null
    const root = loads(rootBytes) as string
    const ks = Keyset.fromRoot(this.store, root)
    const entry = await ks.get(key)
    if (entry === null) return null
    return this.store.get(entry.blob)
  }

  async resetTo(commitHash: string): Promise<boolean> {
    if ((await this.store.get(COMMIT_ROOT(commitHash))) === null) return false
    // Save current HEAD as prev before overwriting.
    const current = await this.store.get(BRANCH_HEAD(this.branch))
    if (current !== null) await this.store.set(BRANCH_HEAD_PREV(this.branch), current)
    await this.store.set(BRANCH_HEAD(this.branch), dumps(commitHash))
    await this.loadCommitInto(commitHash, true)
    return true
  }

  async listBranches(): Promise<string[]> {
    const out: string[] = []
    // `__branch_head_prev__*` doesn't start with `__branch_head__`
    // (the prev variant has `_p` where `__` would be), so the prefix
    // scan naturally excludes prev backups — no extra filter needed.
    for await (const k of this.store.keys(BRANCH_HEAD_PREFIX)) {
      const name = k.slice(BRANCH_HEAD_PREFIX.length)
      if (name.length > 0) out.push(name)
    }
    return out.sort()
  }

  async commitInfo(commitHash?: string): Promise<CommitInfo | null> {
    const target = commitHash ?? this.currentCommitHash
    const raw = await this.store.get(INFO_KEY(target))
    if (raw === null) return null
    return loads(raw) as CommitInfo
  }

  // --- Recovery ---

  /**
   * Persist a recovered HEAD for this branch.
   *
   * Thin instance wrapper over the module-level {@link repairHead}.
   * Reads recover a damaged HEAD without writing it back; this is the
   * explicit call that makes the recovery durable.
   *
   * @returns The commit HEAD now names, or null if nothing was
   *   recoverable.
   */
  async repairHead(): Promise<string | null> {
    return repairHead(this.store, this.branch, {
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    })
  }

  // --- Orphan cleanup ---

  /**
   * Remove orphaned commits — and the blobs and HAMT nodes they own —
   * that are not reachable from any live branch HEAD.
   *
   * Mark phase walks every branch's full ancestry, accumulating
   * reachable commits / blobs / HAMT node hashes. `Keyset.walk(skipNodes)`
   * is given the cumulative seen-set so subtrees shared via structural
   * sharing across commits are visited exactly once.
   *
   * **Safe under concurrent writers.** Every deletion candidate is
   * discovered by walking an orphan commit's own keyset — never by
   * scanning a storage namespace. Both classes it deletes are
   * commit-scoped: blob keys are `<commitHash>:<userKey>`, and a HAMT
   * leaf payload is `[blobPointer, meta]`, so node hashes transitively
   * embed a commit-scoped pointer and never dedup across unrelated
   * commits. A commit that lands mid-sweep is therefore in no orphan's
   * tree and cannot contribute a candidate. `store.keys()` is an async
   * iterable here, so a namespace scan would interleave with the event
   * loop and lose that race inside a single JS context — see
   * `tests/gc-concurrency.test.ts`.
   *
   * **What it deliberately leaves.** HAMT nodes that no commit points
   * at — an interrupted write, a crash between the node write and the
   * CAS, damage from an older sweep — are unreachable from any orphan
   * keyset, so nothing finds them. {@link deepClean} reclaims those, at
   * the cost of requiring a quiescent store. Blobs belonging to an
   * orphan whose keyset is unreadable are leaked permanently by either
   * path: nothing scans blobs by namespace, so a blob is only ever
   * found through the keyset that points at it.
   *
   * The `minAge` guard (default 1 hour) protects recently-created
   * commits from being swept. Within that window, an orphan commit's
   * blobs and nodes are marked reachable too — they may belong to an
   * in-flight writer whose CAS hasn't landed yet.
   *
   * @param opts.minAge Milliseconds. Commits younger than this are
   *   protected from sweep, even if currently unreachable. Default: 1 hour.
   * @returns Number of orphaned commits removed.
   */
  async cleanOrphans(opts: { minAge?: number } = {}): Promise<number> {
    return this.sweep(opts.minAge ?? 3_600_000, false)
  }

  /**
   * Orphan sweep plus a full unreferenced-node scan. **Unsafe against
   * concurrent writers.**
   *
   * Does everything {@link cleanOrphans} does, then additionally scans
   * the whole `kvgit:keyset:` namespace and deletes any node not
   * reachable from a live branch head or a young orphan. That scan is
   * the only way to reclaim nodes no commit references any more —
   * leftovers from an interrupted write, a crash between a write and
   * its CAS, or historical damage — because no orphan keyset points at
   * them.
   *
   * The scan runs after the mark phase, so it sees, and deletes,
   * anything written by a commit that landed in between — including a
   * commit that has since become a live branch HEAD, leaving a live
   * head whose keyset root is missing. Run it only on a quiescent
   * store: no other tab, worker, or process writing, for the whole
   * call. `minAge` does not protect you here; it governs commit
   * deletion, not the namespace scan.
   *
   * Use {@link cleanOrphans} for routine cleanup; schedule this one for
   * maintenance windows.
   *
   * @param opts.minAge Milliseconds. Commits younger than this are
   *   protected from sweep, even if currently unreachable. Default: 1 hour.
   * @returns Number of orphaned commits removed.
   */
  async deepClean(opts: { minAge?: number } = {}): Promise<number> {
    return this.sweep(opts.minAge ?? 3_600_000, true)
  }

  /** Shared mark-and-sweep behind `cleanOrphans` / `deepClean`. */
  private async sweep(minAge: number, deep: boolean): Promise<number> {
    const cutoffTime = Date.now() - minAge

    const reachableCommits = new Set<string>()
    const reachableBlobs = new Set<string>()
    const reachableNodes = new Set<string>()

    // Walk one commit's keyset, accumulating reachable refs.
    const walkCommitForMarks = async (commitHash: string): Promise<void> => {
      const rootBytes = await this.store.get(COMMIT_ROOT(commitHash))
      if (rootBytes === null) return
      const root = loads(rootBytes) as string
      const ks = Keyset.fromRoot(this.store, root)
      // skipNodes is read at call time, then we add to it after — so
      // subtrees shared with already-visited commits are skipped, and
      // newly-discovered nodes become reachable for the next iteration.
      const [entries, newNodes] = await ks.walk(reachableNodes)
      for (const entry of entries.values()) reachableBlobs.add(entry.blob)
      for (const node of newNodes) reachableNodes.add(node)
    }

    // Mark phase: walk every branch's full ancestry. Prefix scan
    // returns only branch-head pointers (prev backups don't match
    // — see listBranches comment).
    for await (const k of this.store.keys(BRANCH_HEAD_PREFIX)) {
      const branchName = k.slice(BRANCH_HEAD_PREFIX.length)
      const branchHead = await resolveHead(this.store, branchName)
      if (branchHead === null) continue
      // Use allParents=true to follow merge commits' second parents too.
      for await (const commit of this.history(branchHead, { allParents: true })) {
        if (reachableCommits.has(commit)) continue
        reachableCommits.add(commit)
        await walkCommitForMarks(commit)
      }
    }

    // Sweep phase: scan commit roots, partition into orphans (old enough
    // to delete) and young orphans (within the minAge window).
    const orphans: string[] = []
    const youngOrphanCommits: string[] = []
    const COMMIT_ROOT_PREFIX = '__commit_root__'

    for await (const k of this.store.keys(COMMIT_ROOT_PREFIX)) {
      const commitHash = k.slice(COMMIT_ROOT_PREFIX.length)
      if (commitHash.length === 0 || reachableCommits.has(commitHash)) continue
      const timeBytes = await this.store.get(COMMIT_TIME(commitHash))
      if (timeBytes === null) continue // no timestamp — be conservative, skip
      const ts = safeLoads(timeBytes)
      if (typeof ts !== 'number') continue
      if (ts < cutoffTime) {
        orphans.push(commitHash)
      } else {
        youngOrphanCommits.push(commitHash)
      }
    }

    // Protect blobs/HAMT nodes referenced by young orphans — they may
    // belong to in-flight writers whose CAS hasn't landed yet.
    for (const young of youngOrphanCommits) {
      await walkCommitForMarks(young)
    }

    // Collect everything to delete in one batch so the sweep is atomic
    // at the store level (defends against partial sweeps under crash).
    const allRemovals = new Set<string>()
    const KEYSET_PREFIX = Keyset.DEFAULT_PREFIX

    // Every deletion candidate comes from walking an orphan's own
    // keyset — never from a namespace scan. That is what makes the
    // incremental path safe under concurrent writers: a commit that
    // lands after the mark phase is in nobody's orphan tree, so
    // nothing it wrote can end up on this list.
    //
    // `skipNodes` starts as the reachable set (subtrees shared with a
    // live commit or a young orphan must not be touched, and are the
    // bulk of the tree) and grows with each orphan's nodes, so a
    // subtree shared between two orphans is walked once and queued
    // once rather than per orphan.
    const skipNodes = new Set(reachableNodes)

    for (const orphan of orphans) {
      const orphanRootBytes = await this.store.get(COMMIT_ROOT(orphan))
      if (orphanRootBytes !== null) {
        try {
          const orphanRoot = loads(orphanRootBytes) as string
          const orphanKs = Keyset.fromRoot(this.store, orphanRoot)
          const [orphanEntries, orphanNodes] = await orphanKs.walk(skipNodes)
          for (const entry of orphanEntries.values()) {
            if (!reachableBlobs.has(entry.blob)) allRemovals.add(entry.blob)
          }
          for (const node of orphanNodes) {
            skipNodes.add(node)
            allRemovals.add(KEYSET_PREFIX + node)
          }
        } catch {
          // Deliberate catch-all: a damaged orphan must not stall the
          // sweep. We drop its payload and still reclaim its commit
          // metadata below. Narrowing this would let one corrupt
          // keyset block GC for the whole store.
          //
          // The cost is a permanent leak: the orphan's nodes survive
          // until a `deepClean`, and its blobs survive forever —
          // nothing scans blobs by namespace, and once the commit
          // metadata is gone there is no keyset left to find them
          // through. That is why nodes and blobs are collected in the
          // same walk above rather than in separate passes.
        }
      }
      allRemovals.add(COMMIT_ROOT(orphan))
      allRemovals.add(PARENT_COMMIT(orphan))
      allRemovals.add(COMMIT_TIME(orphan))
      allRemovals.add(INFO_KEY(orphan))
    }

    if (deep) {
      // Namespace scan: reclaims nodes no orphan keyset points at
      // (interrupted writes, crashes between a write and its CAS,
      // historical damage). Unsafe against a concurrent writer,
      // because anything committed since the mark phase looks
      // unreferenced here. Quiescent stores only — see `deepClean`.
      for await (const k of this.store.keys(KEYSET_PREFIX)) {
        const nodeHash = k.slice(KEYSET_PREFIX.length)
        if (nodeHash.length > 0 && !reachableNodes.has(nodeHash)) {
          allRemovals.add(k)
        }
      }
    }

    if (allRemovals.size > 0) {
      await this.store.removeMany(allRemovals)
    }
    return orphans.length
  }

  // --- Internal ---

  private async loadCommitInto(commitHash: string, updateBase: boolean): Promise<void> {
    this.currentCommitHash = commitHash
    if (updateBase) this.baseCommitHash = commitHash
    const { commitKeys, meta } = await populateState(this.store, commitHash)
    this.commitKeys = commitKeys
    this.meta = meta
  }
}

/**
 * Materialize a commit's flat keyset and meta map from its HAMT.
 *
 * Uses `Keyset.materialize()` (batched BFS, one `getMany` per HAMT
 * level) so cold loads against high-latency stores are O(log N)
 * round-trips instead of O(N).
 *
 * **Eager-materialization tradeoff.** This holds the entire commit's
 * keyset (key → blob pointer + meta) in memory. The benefit:
 * `get(key)` is one in-memory map lookup followed by a single store
 * fetch for the blob, regardless of total commit size. The cost:
 * memory scales with key count.
 *
 * Matches kvgit-py's design. For agex sessions (typically hundreds
 * to a few thousand keys) this is fine. A lazy/HAMT-walk-on-demand
 * variant would scale better for very large keysets at the cost of
 * extra store reads per `get`. Worth revisiting if a real consumer
 * measures the limit.
 */
async function populateState(
  store: KVStore,
  commitHash: string,
): Promise<{ commitKeys: Map<string, string>; meta: Map<string, MetaEntry> }> {
  const rootBytes = await store.get(COMMIT_ROOT(commitHash))
  if (rootBytes === null) {
    return { commitKeys: new Map(), meta: new Map() }
  }
  const root = loads(rootBytes) as string
  const ks = Keyset.fromRoot(store, root)
  const materialized = await ks.materialize()
  const commitKeys = new Map<string, string>()
  const meta = new Map<string, MetaEntry>()
  for (const [k, entry] of materialized) {
    commitKeys.set(k, entry.blob)
    meta.set(k, entry.meta)
  }
  return { commitKeys, meta }
}
