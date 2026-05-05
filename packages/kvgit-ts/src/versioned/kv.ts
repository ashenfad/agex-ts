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
 * The keyset is a content-addressable HAMT (`Keyset` over `Hamt`) so
 * unchanged subtrees are shared across commits by hash equality. A
 * single-key change writes O(log N) new HAMT nodes instead of
 * rewriting a full snapshot per commit.
 */

import { Keyset } from '../keyset'
import type { CommitInfo, KVStore, KeysetEntry, MetaEntry, Versioned } from '../types'
import { VersionedBase } from './base'
import type { MergeResolution } from './merge'

const STORAGE_VERSION = 1
const STORAGE_VERSION_KEY = '__kvgit_version__'

const BRANCH_HEAD = (branch: string): string => `__branch_head__${branch}`
const BRANCH_HEAD_PREV = (branch: string): string => `__branch_head_prev__${branch}`
const COMMIT_ROOT = (commit: string): string => `__commit_root__${commit}`
const PARENT_COMMIT = (commit: string): string => `__parent_commit__${commit}`
const COMMIT_TIME = (commit: string): string => `__commit_time__${commit}`
const INFO_KEY = (commit: string): string => `__info__${commit}`
const BRANCH_HEAD_PREFIX = '__branch_head__'

// ---------------------------------------------------------------------------
// JSON byte helpers
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

function dumps(value: unknown): Uint8Array {
  return _encoder.encode(JSON.stringify(value))
}

function loads(raw: Uint8Array): unknown {
  return JSON.parse(_decoder.decode(raw))
}

function safeLoads(raw: Uint8Array): unknown {
  try {
    return loads(raw)
  } catch {
    return null
  }
}

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
 *   2. `__branch_head_prev__<branch>` — backup written before each CAS
 *   3. `recoverFromCorruptHead` — optional injected fallback (slot-only in v1)
 *
 * If `repair` is true, a recovered HEAD is written back to current.
 * Returns null if nothing recovers.
 */
async function resolveHead(
  store: KVStore,
  branch: string,
  opts: { repair?: boolean; recoverFromCorruptHead?: CorruptHeadRecoverer } = {},
): Promise<string | null> {
  const repair = opts.repair ?? true

  // Try current HEAD.
  const headBytes = await store.get(BRANCH_HEAD(branch))
  if (headBytes !== null) {
    const commitHash = safeLoads(headBytes)
    if (typeof commitHash === 'string' && (await store.get(COMMIT_ROOT(commitHash))) !== null) {
      return commitHash
    }
  }

  // Try prev HEAD.
  const prevBytes = await store.get(BRANCH_HEAD_PREV(branch))
  if (prevBytes !== null) {
    const commitHash = safeLoads(prevBytes)
    if (typeof commitHash === 'string' && (await store.get(COMMIT_ROOT(commitHash))) !== null) {
      console.warn(`kvgit: branch '${branch}' HEAD corrupt, recovered from prev HEAD`)
      if (repair) await store.set(BRANCH_HEAD(branch), dumps(commitHash))
      return commitHash
    }
  }

  // Try the injected commit-scan fallback (slot-only in v1).
  if (opts.recoverFromCorruptHead && headBytes !== null) {
    const recovered = await opts.recoverFromCorruptHead(store, branch)
    if (recovered !== null) {
      console.warn(`kvgit: branch '${branch}' HEAD corrupt, recovered via scan`)
      if (repair) await store.set(BRANCH_HEAD(branch), dumps(recovered))
      return recovered
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Storage version
// ---------------------------------------------------------------------------

async function checkStorageVersion(store: KVStore): Promise<void> {
  const raw = await store.get(STORAGE_VERSION_KEY)
  if (raw !== null) {
    const version = safeLoads(raw)
    if (version !== STORAGE_VERSION) {
      throw new Error(
        `Store has kvgit storage version ${JSON.stringify(version)}, ` +
          `this code supports ${STORAGE_VERSION}. Use a fresh store.`,
      )
    }
    return
  }

  // No version sentinel. Either fresh, or pre-v1.
  let hasExisting = false
  for await (const k of store.keys()) {
    if (k.startsWith(BRANCH_HEAD_PREFIX)) {
      hasExisting = true
      break
    }
  }
  if (hasExisting) {
    throw new Error(
      `Store appears to use an older kvgit storage format. This version requires storage v${STORAGE_VERSION}. Use a fresh store.`,
    )
  }
  await store.set(STORAGE_VERSION_KEY, dumps(STORAGE_VERSION))
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    hex += (b < 16 ? '0' : '') + b.toString(16)
  }
  return hex
}

/**
 * Compute a content-addressable commit hash.
 *
 * Hashes the parent pointers, sorted keyset preview, sorted update
 * blob bytes, and optional info to produce a deterministic 40-hex-char
 * commit hash. Truncating to 40 keeps commits visually compact while
 * leaving plenty of collision resistance.
 */
async function contentHash(
  parents: readonly string[],
  keyset: ReadonlyMap<string, string>,
  updates: ReadonlyMap<string, Uint8Array>,
  info: CommitInfo | null,
): Promise<string> {
  // Concatenate the inputs into a single byte stream, then hash.
  const parts: Uint8Array[] = []
  parts.push(_encoder.encode(JSON.stringify(parents)))
  const sortedKeyset = [...keyset.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  parts.push(_encoder.encode(JSON.stringify(sortedKeyset)))
  const sortedUpdateKeys = [...updates.keys()].sort()
  for (const key of sortedUpdateKeys) {
    parts.push(_encoder.encode(key))
    parts.push(updates.get(key) as Uint8Array)
  }
  if (info !== null) {
    parts.push(_encoder.encode(canonicalJson(info)))
  }

  let total = 0
  for (const p of parts) total += p.length
  const flat = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    flat.set(p, off)
    off += p.length
  }
  const hex = await sha256Hex(flat)
  return hex.slice(0, 40)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${parts.join(',')}}`
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
      repair: false,
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
    for (const k of updates.keys()) previewKeys.set(k, `<pending:${k}>`)
    const newHash = await contentHash([this.currentCommitHash], previewKeys, updates, info)

    // Resolve real blob keys for the updates.
    const blobWrites: Array<[string, Uint8Array]> = []
    const now = Date.now()
    for (const [key, value] of updates) {
      const versionedKey = `${newHash}:${key}`
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
    for (const k of mergedValues.keys()) previewKeys.set(k, `<pending:${k}>`)
    const mergeHash = await contentHash(parents, previewKeys, mergedValues, info)

    // Resolve real blob keys for merged values.
    const blobWrites: Array<[string, Uint8Array]> = []
    for (const [key, value] of mergedValues) {
      const versionedKey = `${mergeHash}:${key}`
      blobWrites.push([versionedKey, value])
      mergedKeyset.set(key, versionedKey)
    }

    // Build merged meta. Our meta is in memory; theirs we fetch from
    // their HAMT.
    const theirParent = parents[0] as string
    const theirRootBytes = await this.store.get(COMMIT_ROOT(theirParent))
    const theirMeta = new Map<string, MetaEntry>()
    if (theirRootBytes !== null) {
      const theirRoot = loads(theirRootBytes) as string
      const theirKs = Keyset.fromRoot(this.store, theirRoot)
      for await (const [k, e] of theirKs.items()) theirMeta.set(k, e.meta)
    }

    const now = Date.now()
    const mergedMeta = new Map<string, MetaEntry>()
    for (const k of mergedKeyset.keys()) {
      if (mergedValues.has(k)) {
        mergedMeta.set(k, { size: (mergedValues.get(k) as Uint8Array).length, createdAt: now })
      } else if (this.meta.has(k)) {
        mergedMeta.set(k, this.meta.get(k) as MetaEntry)
      } else if (theirMeta.has(k)) {
        mergedMeta.set(k, theirMeta.get(k) as MetaEntry)
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
    writes.push([PARENT_COMMIT(mergeHash), dumps([...parents])])
    writes.push([COMMIT_TIME(mergeHash), dumps(Date.now())])
    if (info !== null) writes.push([INFO_KEY(mergeHash), dumps(info)])

    await this.store.setMany(writes)

    this.commitKeys = mergedKeyset
    this.currentCommitHash = mergeHash
    this.meta = mergedMeta
    return mergeHash
  }

  protected async casHead(expected: string, newHead: string): Promise<boolean> {
    // Save current as prev BEFORE the CAS so a crash mid-write can
    // be recovered from. The slight cost is one extra write per
    // commit; the value is durable HEAD recovery.
    await this.store.set(BRANCH_HEAD_PREV(this.branch), dumps(expected))
    return this.store.cas(BRANCH_HEAD(this.branch), dumps(newHead), dumps(expected))
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
    // Note: orphan cleanup happens in cleanOrphans (TBD), not here.
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
    const head = await resolveHead(this.store, opts.branch, { repair: false })
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
    for await (const k of this.store.keys()) {
      if (k.startsWith(BRANCH_HEAD_PREFIX) && !k.startsWith('__branch_head_prev__')) {
        const name = k.slice(BRANCH_HEAD_PREFIX.length)
        if (name.length > 0) out.push(name)
      }
    }
    return out.sort()
  }

  async commitInfo(commitHash?: string): Promise<CommitInfo | null> {
    const target = commitHash ?? this.currentCommitHash
    const raw = await this.store.get(INFO_KEY(target))
    if (raw === null) return null
    return loads(raw) as CommitInfo
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
