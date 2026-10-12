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

import { EMPTY_HASH } from '../hamt'
import { Keyset } from '../keyset'
import type { CommitInfo, KVStore, KeysetEntry, MetaEntry, Versioned } from '../types'
import { UnknownBranchError } from '../types'
import { VersionedBase } from './base'
import {
  BLOB_PREFIX,
  BRANCH_HEAD,
  BRANCH_HEAD_PREFIX,
  BRANCH_HEAD_PREV,
  COMMIT_ROOT,
  COMMIT_TIME,
  INFO_KEY,
  PARENT_COMMIT,
  PARENT_GENS,
  ROOT_COMMIT,
  blobKey,
  checkStorageVersion,
  commitHash,
  commitRecords,
  dumps,
  generationOf,
  loads,
  loadsInfo,
  safeLoads,
} from './layout'
import type { MergeResolution } from './merge'

// ---------------------------------------------------------------------------
// Recovery layer
// ---------------------------------------------------------------------------

/**
 * Last-resort recovery for a HEAD that is present but unresolvable.
 *
 * Called with the store and the branch name; returns a commit hash to
 * treat as that branch's HEAD, or null if it cannot say.
 *
 * There is no default, and none is shipped. When HEAD is unresolvable
 * and the prev-HEAD backup is missing or equally broken, the
 * information needed is no longer in the store, so no implementation
 * can be correct — only lucky. kvgit reports null and leaves the guess
 * to a caller who has decided the trade is worth it. Unset, corrupt-
 * HEAD recovery stops at the prev-HEAD tier.
 *
 * The answer is checked before it is used: it must be a string naming
 * a commit whose `__commit_root__` is present in this store. Anything
 * else leaves the branch unrecoverable.
 */
export type CorruptHeadRecoverer = (store: KVStore, branch: string) => Promise<string | null>

/**
 * Resolve the HEAD of a branch with prev-HEAD fallback.
 *
 * Tries:
 *   1. `__branch_head__<branch>` — current pointer
 *   2. `__branch_head_prev__<branch>` — backup written after each CAS
 *   3. `recoverFromCorruptHead` — optional caller-supplied last resort
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

  // HEAD existed, is corrupt, and the backup did not save it. The
  // store no longer holds the answer, so there is nothing left to read
  // — only to guess. Guessing is the caller's call, not ours.
  if (opts.recoverFromCorruptHead && headBytes !== null) {
    const recovered: unknown = await opts.recoverFromCorruptHead(store, branch)
    // A recoverer is caller-supplied, so its answer is no more
    // trustworthy than anything else read out of the store: it counts
    // only if it is a string naming a commit whose `__commit_root__`
    // is present. This function promises a valid commit or null, and
    // an unchecked answer is worse than no answer — `repairHead` makes
    // it durable, replacing obviously corrupt HEAD bytes with a
    // plausible hash that names nothing, which is harder to diagnose
    // than the damage it replaced.
    if (typeof recovered === 'string' && (await store.get(COMMIT_ROOT(recovered))) !== null) {
      console.warn(`kvgit: branch '${branch}' HEAD corrupt, recovered via injected recoverer`)
      return recovered
    }
    if (recovered !== null && recovered !== undefined) {
      console.warn(
        `kvgit: branch '${branch}' recoverer returned ${describeCandidate(recovered)}, which is not a commit in this store; treating the branch as unrecoverable`,
      )
    }
  }

  return null
}

/**
 * Render a value for a log line, showing what it actually was.
 *
 * A rejected recovery candidate is worth naming: the whole point of
 * rejecting it is that someone has to go and fix the recoverer.
 */
function describeCandidate(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
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
  /**
   * Mint the branch with an initial commit when it does not exist
   * (default true). Pass false to throw `UnknownBranchError` instead,
   * so a read after a delete cannot resurrect the branch and block a
   * later create.
   */
  create?: boolean
  /** Last resort for a corrupt HEAD with no usable backup (see `CorruptHeadRecoverer`). */
  recoverFromCorruptHead?: CorruptHeadRecoverer
  /** The clock commits are stamped with, in seconds. Default: wall
   *  time. A test pins it to replay a history byte for byte. */
  now?: () => number
}

const wallClock = (): number => Date.now() / 1000

/**
 * Create branch `name` at commit `target`, in one conditional write:
 * the head (expected absent), the root commit's records when `target`
 * is the root commit and the store lacks it, and the removal of any
 * stale backup left under the name by an earlier branch.
 *
 * @throws if the branch exists, or `target` is not in the store.
 */
async function createBranchHead(
  store: KVStore,
  name: string,
  target: string,
  now: () => number,
): Promise<void> {
  const branchKey = BRANCH_HEAD(name)
  for (;;) {
    const expected = new Map<string, Uint8Array | null>([[branchKey, null]])
    const writes = new Map<string, Uint8Array>([[branchKey, dumps(target)]])
    if ((await store.get(COMMIT_ROOT(target))) === null) {
      if (target !== ROOT_COMMIT) throw new Error(`Commit '${target}' does not exist`)
      // Minted with the head, and only if nobody minted it first.
      expected.set(COMMIT_ROOT(ROOT_COMMIT), null)
      const records = commitRecords({
        commit: ROOT_COMMIT,
        root: EMPTY_HASH,
        parents: [],
        parentGens: null,
        created: now(),
        info: null,
      })
      for (const [k, v] of records) writes.set(k, v)
    }
    if (await store.casMany(expected, writes, [BRANCH_HEAD_PREV(name)])) return
    if ((await store.get(branchKey)) !== null) throw new Error(`Branch '${name}' already exists`)
    // Another writer minted the root commit first: decide again.
  }
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
  private readonly now: () => number
  /** Generations of commits this handle has written or read. A
   *  commit's generation never changes, so nothing here goes stale. */
  private readonly generations = new Map<string, number>()

  private constructor(opts: {
    store: KVStore
    branch: string
    commitHash: string
    commitKeys: Map<string, string>
    meta: Map<string, MetaEntry>
    recoverFromCorruptHead: CorruptHeadRecoverer | undefined
    now: () => number
  }) {
    super({ branch: opts.branch, commitHash: opts.commitHash })
    this.store = opts.store
    this.commitKeys = opts.commitKeys
    this.meta = opts.meta
    this.recoverFromCorruptHead = opts.recoverFromCorruptHead
    this.now = opts.now
  }

  /** The options a handle derived from this one opens with. */
  private inherited(): Pick<VersionedKVOptions, 'recoverFromCorruptHead' | 'now'> {
    return {
      now: this.now,
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    }
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
    const create = opts.create ?? true

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
      } else if (!create) {
        throw new UnknownBranchError(branch, true)
      } else {
        // A new branch starts at the empty root commit. Another writer
        // may create it first, at any commit; then the handle opens at
        // whatever head that writer gave it.
        let created = true
        try {
          await createBranchHead(store, branch, ROOT_COMMIT, opts.now ?? wallClock)
        } catch (e) {
          if ((await store.get(BRANCH_HEAD(branch))) === null) throw e
          created = false
        }
        if (created) {
          commitHash = ROOT_COMMIT
        } else {
          const winner = await resolveHead(store, branch, {
            ...(opts.recoverFromCorruptHead !== undefined && {
              recoverFromCorruptHead: opts.recoverFromCorruptHead,
            }),
          })
          if (winner === null) {
            throw new Error(`Branch '${branch}' HEAD is corrupt and unrecoverable`)
          }
          commitHash = winner
        }
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
      now: opts.now ?? wallClock,
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

    // Carry forward, apply removals, then point each update at its blob.
    const newCommitKeys = new Map<string, string>()
    const newMeta = new Map<string, MetaEntry>()
    for (const [k, ptr] of this.commitKeys) {
      if (removals.has(k)) continue
      newCommitKeys.set(k, ptr)
      const m = this.meta.get(k)
      if (m !== undefined) newMeta.set(k, m)
    }

    // Every blob is written, even one already stored: the key is its
    // content, so the rewrite changes nothing but guarantees the batch
    // holds everything its commit needs.
    const writes = new Map<string, Uint8Array>()
    const keysetUpdates: Array<[string, KeysetEntry]> = []
    for (const [key, value] of updates) {
      const pointer = await blobKey(value)
      writes.set(pointer, value)
      newCommitKeys.set(key, pointer)
      const meta: MetaEntry = { size: value.length }
      newMeta.set(key, meta)
      keysetUpdates.push([key, { blob: pointer, meta }])
    }

    // Apply the changes to the parent's HAMT: structural sharing reuses
    // every subtree the commit didn't touch.
    const parentKs = Keyset.fromRoot(this.store, await this.rootOf(this.currentCommitHash))
    const newKs = await parentKs.updated({ updates: keysetUpdates, removals })
    for (const [k, v] of newKs.pending) writes.set(k, v)

    // The hash is computed last, over the parents, the root, the time
    // and the info, so it names exactly one root.
    const parents = [this.currentCommitHash]
    const parentGens = await this.parentGenerations(parents)
    const created = this.now()
    const newHash = await commitHash(parents, newKs.root, created, info)
    const records = commitRecords({
      commit: newHash,
      root: newKs.root,
      parents,
      parentGens,
      created,
      info,
    })
    for (const [k, v] of records) writes.set(k, v)

    // One batch, so a crash mid-write doesn't strand a partial commit.
    await this.store.setMany(writes)

    this.commitKeys = newCommitKeys
    this.currentCommitHash = newHash
    this.meta = newMeta
    this.generations.set(newHash, generationOf(parentGens))
    return newHash
  }

  /** A commit's keyset root, or the empty tree's for a commit with none. */
  private async rootOf(commit: string): Promise<string> {
    const raw = await this.store.get(COMMIT_ROOT(commit))
    return raw === null ? EMPTY_HASH : (loads(raw) as string)
  }

  /** The generation of each of a new commit's parents. */
  private async parentGenerations(parents: readonly string[]): Promise<number[]> {
    const out: number[] = []
    for (const parent of parents) {
      let gen = this.generations.get(parent)
      if (gen === undefined) {
        gen = await this.generationFromStore(parent)
        this.generations.set(parent, gen)
      }
      out.push(gen)
    }
    return out
  }

  /** A commit's generation, from its own records: 0 for a commit with no
   *  parents, else one more than its highest parent's. */
  private async generationFromStore(commit: string): Promise<number> {
    const parents = await this.loadParents(commit)
    if (parents.length === 0) return 0
    const raw = await this.store.get(PARENT_GENS(commit))
    const gens = raw === null ? null : safeLoads(raw)
    if (
      Array.isArray(gens) &&
      gens.length === parents.length &&
      gens.every((g) => Number.isInteger(g) && g >= 0)
    ) {
      return generationOf(gens as number[])
    }
    // A commit with no recorded generations: count from its parents.
    let highest = 0
    for (const parent of parents) {
      highest = Math.max(highest, (await this.parentGenerations([parent]))[0] as number)
    }
    return highest + 1
  }

  protected async createMergeCommit(
    resolution: MergeResolution,
    parents: readonly string[],
    info: CommitInfo | null,
    theirHead: string,
  ): Promise<string> {
    const mergedKeyset = new Map(resolution.mergedKeyset)
    const mergedValues = resolution.mergedValues

    // A value a merge function produced is a new blob, never chunked.
    const writes = new Map<string, Uint8Array>()
    for (const [key, value] of mergedValues) {
      const pointer = await blobKey(value)
      writes.set(pointer, value)
      mergedKeyset.set(key, pointer)
    }

    // An entry carried from either side keeps its own metadata, which
    // describes its blob. Most come from our in-memory map; the few
    // only their side has are read pointwise from their keyset (via
    // `theirHead`: the commit path orders parents [theirs, ours] but
    // `mergeHeads` orders them [ours, theirs]).
    const theirKs = Keyset.fromRoot(this.store, await this.rootOf(theirHead))
    const mergedMeta = new Map<string, MetaEntry>()
    for (const k of mergedKeyset.keys()) {
      if (mergedValues.has(k)) {
        mergedMeta.set(k, { size: (mergedValues.get(k) as Uint8Array).length })
      } else if (this.meta.has(k) && this.commitKeys.get(k) === mergedKeyset.get(k)) {
        mergedMeta.set(k, this.meta.get(k) as MetaEntry)
      } else {
        const theirEntry = await theirKs.get(k)
        if (theirEntry !== null) mergedMeta.set(k, theirEntry.meta)
        else if (this.meta.has(k)) mergedMeta.set(k, this.meta.get(k) as MetaEntry)
      }
    }

    // Apply only what changed on top of our HAMT, so structural sharing
    // keeps every subtree the merge didn't touch.
    const keysetUpdates: Array<[string, KeysetEntry]> = []
    for (const [k, blob] of mergedKeyset) {
      if (this.commitKeys.get(k) !== blob) {
        keysetUpdates.push([k, { blob, meta: mergedMeta.get(k) as MetaEntry }])
      }
    }
    const keysetRemovals = new Set<string>()
    for (const k of this.commitKeys.keys()) {
      if (!mergedKeyset.has(k)) keysetRemovals.add(k)
    }
    const ourKs = Keyset.fromRoot(this.store, await this.rootOf(this.currentCommitHash))
    const newKs = await ourKs.updated({ updates: keysetUpdates, removals: keysetRemovals })
    for (const [k, v] of newKs.pending) writes.set(k, v)

    const parentGens = await this.parentGenerations(parents)
    const created = this.now()
    const mergeHash = await commitHash(parents, newKs.root, created, info)
    const records = commitRecords({
      commit: mergeHash,
      root: newKs.root,
      parents,
      parentGens,
      created,
      info,
    })
    for (const [k, v] of records) writes.set(k, v)

    await this.store.setMany(writes)

    this.commitKeys = mergedKeyset
    this.currentCommitHash = mergeHash
    this.meta = mergedMeta
    this.generations.set(mergeHash, generationOf(parentGens))
    return mergeHash
  }

  /**
   * Publish `newHead` as this branch's HEAD if HEAD is `expected`.
   *
   * One atomic write (`casMany`) moves HEAD and records `expected` as
   * the prev-HEAD backup, so the backup always names the commit HEAD
   * held immediately before: never a value a losing writer invented,
   * and never more than one commit back.
   *
   * A write that fails against a *damaged* HEAD is retried once behind
   * {@link healHead}, which repairs it atomically. That is the only
   * place a corrupt HEAD is written back, now that reads do not.
   */
  protected async casHead(expected: string, newHead: string): Promise<boolean> {
    const branchKey = BRANCH_HEAD(this.branch)
    const expectedBytes = dumps(expected)
    const publish = (): Promise<boolean> =>
      this.store.casMany(
        new Map([[branchKey, expectedBytes]]),
        new Map([
          [branchKey, dumps(newHead)],
          [BRANCH_HEAD_PREV(this.branch), expectedBytes],
        ]),
      )
    if (await publish()) return true
    if (!(await healHead(this.store, this.branch, expectedBytes))) return false
    return publish()
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
    // Ancestor-set intersection with non-minimal candidates dropped
    // (a candidate that is itself an ancestor of another candidate is
    // not lowest). When several commits tie for lowest — criss-cross
    // histories — the smallest hash wins: deterministic, but
    // arbitrary, so criss-cross merges resolve cleanly rather than
    // raising.
    if (commitA === commitB) return commitA

    const parents = new Map<string, readonly string[]>()
    const ancestorsA = await this.walkAncestors(commitA, parents)
    // Fast path: B inside A's history (or vice versa) names the
    // lowest directly — every other common ancestor sits above it.
    if (ancestorsA.has(commitB)) return commitB
    const ancestorsB = await this.walkAncestors(commitB, parents)
    if (ancestorsB.has(commitA)) return commitA

    const common = new Set<string>()
    for (const c of ancestorsA) {
      if (ancestorsB.has(c)) common.add(c)
    }
    if (common.size === 0) return null
    // Minimality in one bottom-up pass: a candidate is lowest when no
    // other candidate sits below it. Propagate "a candidate is
    // at-or-below here" from tips to roots over the in-memory parent
    // map — no further store reads, linear in the history.
    const children = new Map<string, string[]>()
    for (const node of parents.keys()) children.set(node, [])
    for (const [node, nodeParents] of parents) {
      for (const parent of nodeParents) {
        const kids = children.get(parent)
        if (kids !== undefined) kids.push(node)
      }
    }
    const below = new Map<string, boolean>()
    const remaining = new Map<string, number>()
    for (const [node, kids] of children) {
      below.set(node, false)
      remaining.set(node, kids.length)
    }
    const queue: string[] = []
    for (const [node, kids] of children) {
      if (kids.length === 0) queue.push(node)
    }
    while (queue.length > 0) {
      const node = queue.shift() as string
      const nodeParents = parents.get(node) ?? []
      for (const parent of nodeParents) {
        if (common.has(node) || below.get(node) === true) below.set(parent, true)
        const left = (remaining.get(parent) ?? 1) - 1
        remaining.set(parent, left)
        if (left === 0) queue.push(parent)
      }
    }
    let best: string | null = null
    for (const c of common) {
      if (below.get(c) !== true && (best === null || c < best)) best = c
    }
    return best
  }

  private async walkAncestors(
    start: string,
    parents: Map<string, readonly string[]>,
  ): Promise<Set<string>> {
    // All ancestors of `start` (itself included), recording each
    // visited commit's parents in `parents` for later passes.
    const ancestors = new Set<string>([start])
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (parents.has(current)) continue
      const nodeParents = await this.loadParents(current)
      parents.set(current, nodeParents)
      for (const parent of nodeParents) {
        if (!ancestors.has(parent)) {
          ancestors.add(parent)
          stack.push(parent)
        }
      }
    }
    return ancestors
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
      ...this.inherited(),
    })
  }

  async createBranch(name: string, opts: { at?: string } = {}): Promise<Versioned> {
    const target = opts.at ?? this.currentCommitHash
    if (opts.at !== undefined && (await this.store.get(COMMIT_ROOT(opts.at))) === null) {
      throw new Error(`Commit '${opts.at}' does not exist`)
    }
    await createBranchHead(this.store, name, target, this.now)
    return VersionedKV.open(this.store, {
      branch: name,
      commitHash: target,
      ...this.inherited(),
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
      throw new UnknownBranchError(name)
    }
    this.branch = name
    await this.loadCommitInto(head, true)
  }

  async peek(key: string, opts: { branch: string }): Promise<Uint8Array | null> {
    const head = await resolveHead(this.store, opts.branch, {
      ...(this.recoverFromCorruptHead !== undefined && {
        recoverFromCorruptHead: this.recoverFromCorruptHead,
      }),
    })
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

  static async exists(store: KVStore, name: string): Promise<boolean> {
    // Same predicate listBranches lists by: the branch has a HEAD
    // entry. A single read that never writes, so checking cannot
    // resurrect a deleted branch. A damaged HEAD still counts as
    // existing; opening it raises either way.
    return (await store.get(BRANCH_HEAD(name))) !== null
  }

  async branchExists(name: string): Promise<boolean> {
    return VersionedKV.exists(this.store, name)
  }

  async commitInfo(commitHash?: string): Promise<CommitInfo | null> {
    const target = commitHash ?? this.currentCommitHash
    const raw = await this.store.get(INFO_KEY(target))
    if (raw === null) return null
    return loadsInfo(raw) as CommitInfo
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
   * **Run it on a quiescent store.** Every deletion candidate is
   * discovered by walking an orphan commit's own keyset, and nothing
   * reachable from a live head or a young orphan is deleted. But blobs
   * and nodes are keyed by content (storage v4), so a writer committing
   * during the sweep can reuse a blob or node an orphan held, and lose
   * it. The GC lease that makes a sweep safe beside writers (writers'
   * batches conditional on it, sweeps holding it) is not here yet; until
   * it is, no other tab, worker or process may write for the whole call.
   *
   * **What it deliberately leaves.** HAMT nodes that no commit points
   * at — an interrupted write, a crash between the node write and the
   * CAS, damage from an older sweep — are unreachable from any orphan
   * keyset, so nothing finds them, and neither are the blobs of an
   * orphan whose keyset is unreadable. {@link deepClean} reclaims both.
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
   * the whole `kvgit:keyset:` and `kvgit:blob:` namespaces and deletes
   * any node or blob not reachable from a live branch head or a young
   * orphan. That scan is the only way to reclaim content no commit
   * references any more — leftovers from an interrupted write, a crash
   * between a write and its CAS, or a damaged orphan's blobs — because
   * no orphan keyset points at them.
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
    // Commit times are in seconds; minAge is in milliseconds.
    const cutoffTime = this.now() - minAge / 1000

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
      // No `recoverFromCorruptHead` here, deliberately, even when this
      // handle carries one. GC must not decide reachability from a
      // guess: a wrong answer marks the wrong commits live, so real
      // garbage survives forever, and a guessed tip gets walked as
      // though it were this branch's own history, pinning another
      // branch's ancestry into this one's mark set. The sweep sees
      // only what the store actually claims — a branch whose HEAD
      // resolves is marked from its real HEAD, and one whose HEAD does
      // not resolve marks nothing and keeps its commits as young
      // orphans until `minAge` and an explicit `repairHead` settle
      // what it points at. The inconsistency with the read paths is
      // the point, not an oversight.
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
    // keyset — never from a namespace scan — so content a commit
    // landing mid-sweep wrote for itself is never on this list. Content
    // it shares with an orphan can be, which is why the sweep is for a
    // quiescent store.
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
          // The cost is a leak: once the commit metadata is gone there
          // is no keyset left to find the orphan's nodes and blobs
          // through, so they survive until a `deepClean`.
        }
      }
      allRemovals.add(COMMIT_ROOT(orphan))
      allRemovals.add(PARENT_COMMIT(orphan))
      allRemovals.add(PARENT_GENS(orphan))
      allRemovals.add(COMMIT_TIME(orphan))
      allRemovals.add(INFO_KEY(orphan))
    }

    if (deep) {
      // Namespace scans: reclaim nodes and blobs no orphan keyset
      // points at (interrupted writes, crashes between a write and its
      // CAS, a damaged orphan's content). Unsafe against a concurrent
      // writer, because anything committed since the mark phase looks
      // unreferenced here. Quiescent stores only — see `deepClean`.
      for await (const k of this.store.keys(KEYSET_PREFIX)) {
        const nodeHash = k.slice(KEYSET_PREFIX.length)
        if (nodeHash.length > 0 && !reachableNodes.has(nodeHash)) {
          allRemovals.add(k)
        }
      }
      for await (const k of this.store.keys(BLOB_PREFIX)) {
        if (!reachableBlobs.has(k)) allRemovals.add(k)
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
