/**
 * GithubRemote: the kvgit `Remote` over a GitHub repo.
 *
 * The semantic mapping (design D2): each kvgit commit becomes a real
 * git commit — kvgit parents as git parents, the keyset rendered as
 * the tree, the sidecar (`.kvgit/commit.json`) as the authoritative
 * per-commit record, and the kvgit hash in a `Kvgit-Hash:` message
 * trailer so SHAs resolve in both directions from the commits list.
 *
 * Push pipeline, per wire commit in topological order:
 *
 *   tree (`base_tree` on the first parent's tree + delta entries,
 *         values carried INLINE where `inlinable` allows and the
 *         per-tree budget still has room, so most commits cost no
 *         per-key request at all)
 *     → commit (explicit dates ⇒ deterministic git SHAs)
 *
 * Values that have no UTF-8 spelling, or that exceed the inline size
 * gate, fall back to a `createBlob` POST and a `sha` entry — the path
 * every value took before. Either way the blob object GitHub stores is
 * byte-identical, so the repo format is unchanged and a reader cannot
 * tell which route a value took.
 *
 * with ONE trailing ref CAS — `createRef` for `expectedOld === null`,
 * `force:false` `updateRef` otherwise. An interrupted push strands
 * only unreachable objects; because blob/tree/commit SHAs are all
 * deterministic, a re-run re-creates identical objects and resumes
 * for free.
 *
 * ## Transport state
 *
 * Incremental pushes need the frontier's rendering state: the
 * key→path assignments (`PathPlanner`) and the frontier commit's
 * git SHA + tree. That state is persisted in the LOCAL store under
 * `__ghsync__<repo>__<branch>` after each successful push, keyed to
 * the kvgit head it describes — and `fetch` re-arms it as it walks
 * (pulling is what makes a foreign frontier local). A push whose
 * `expectedOld` doesn't match the persisted state fails with a
 * "stale transport state" error; `rebuildTransportState(branch)`
 * recovers from remote sidecars alone.
 */

import type { Remote, RemoteRef } from '../sync/remote'
import type { KVStore, WireCommit } from '../types'
import { BLOB_PREFIX, PARENT_COMMIT, dumps, safeLoads, sha256Hex } from '../versioned/layout'
import type { GithubClient, TreeEntry } from './client'
import { GithubError } from './errors'
import { gitBlobSha1 } from './git-hash'
import { INLINE_LIMIT, INLINE_TREE_BUDGET, inlinable, inlineCost } from './inline'
import { PathPlanner, SIDECAR_PATH, naturalPath, relocatedPath } from './paths'
import { SIDECAR_FORMAT, decodeSidecar, encodeSidecar, wireFromSidecar } from './sidecar'

export interface GithubRemoteOptions {
  /** Commit author/committer identity on the sync repo. */
  author?: { name: string; email: string }
  /** Encoder discriminator recorded in sidecars. Default 'ts'. */
  kernel?: string
  /** Largest single value to carry inline in a tree entry, in bytes.
   *  Anything larger takes a `createBlob` POST. Default `INLINE_LIMIT`. */
  inlineLimit?: number
  /** Aggregate cap on inlined content per tree request, in bytes.
   *  Values that no longer fit take a `createBlob` POST, so a commit
   *  can never build a request body larger than roughly this.
   *  Default `INLINE_TREE_BUDGET`. */
  inlineBudget?: number
}

const TRAILER = /^Kvgit-Hash: ([0-9a-f]{40})$/m
const ARCHIVED = 'archived/'
const STATE_FORMAT = 1

/** Fan-out width for unthrottled GET bursts (ref resolution, sidecar
 *  prefetch). Parallel enough to matter, bounded enough to stay clear
 *  of GitHub's secondary limits on concurrent requests. */
const GET_CHUNK = 25

/** Bounded-concurrency map: `Promise.all` in chunks of `limit`. The
 *  one place the unbounded-vs-bounded policy lives. */
async function chunked<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}

const stateKey = (repo: string, branch: string): string => `__ghsync__${repo}__${branch}`

interface TransportState {
  format: number
  /** kvgit commit this state describes (the pushed head). */
  kvgitHead: string
  /** Its git commit SHA and tree SHA on the remote. */
  gitHead: string
  treeSha: string
  /** Full key → tree path assignments at that commit. */
  assignments: Array<[string, string]>
  /** Key → [value SHA-256 hex, git blob SHA] for values in that
   *  commit's tree, as far as known. Push references a value the
   *  remote already holds by its git SHA instead of sending it again;
   *  a missing entry only means the bytes are sent. */
  values?: Array<[string, string, string]>
}

/** A value as both sides name it: kvgit's SHA-256 and git's blob SHA. */
type BlobIds = readonly [hex: string, gitSha: string]

/** Per-in-stream-commit rendering state (forked per parent, like
 *  applyWire's pointer maps — merges need the non-linear ancestor). */
interface CommitRender {
  gitSha: string
  treeSha: string
  planner: PathPlanner
  /** Key → the value's ids, for values in this commit's tree. */
  values: Map<string, BlobIds>
}

/** A remote commit as learned from the commits-list walk. */
interface RemoteCommit {
  kvHash: string
  gitParents: string[]
  treeSha: string
}

/** Kahn topological order (parents first) over the needed subset of a
 *  remote walk; parents outside the subset count as satisfied. */
function topoOrder(
  walked: ReadonlyMap<string, RemoteCommit>,
  haveKv: ReadonlySet<string>,
): string[] {
  const needed = new Map([...walked].filter(([, meta]) => !haveKv.has(meta.kvHash)))
  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const [sha, meta] of needed) {
    let deg = 0
    for (const p of meta.gitParents) {
      if (!needed.has(p)) continue
      deg++
      const kids = children.get(p) ?? []
      kids.push(sha)
      children.set(p, kids)
    }
    inDegree.set(sha, deg)
  }
  const ready = [...inDegree]
    .filter(([, deg]) => deg === 0)
    .map(([sha]) => sha)
    .sort()
  const out: string[] = []
  while (ready.length > 0) {
    const sha = ready.shift() as string
    out.push(sha)
    for (const child of children.get(sha) ?? []) {
      const deg = (inDegree.get(child) as number) - 1
      inDegree.set(child, deg)
      if (deg === 0) {
        const at = ready.findIndex((r) => child < r)
        if (at === -1) ready.push(child)
        else ready.splice(at, 0, child)
      }
    }
  }
  if (out.length !== needed.size) {
    throw new Error(`GithubRemote: cycle in remote commit graph (${out.length}/${needed.size})`)
  }
  return out
}

export class GithubRemote implements Remote {
  readonly client: GithubClient
  readonly #store: KVStore
  readonly #author: { name: string; email: string }
  readonly #kernel: string
  readonly #inlineLimit: number
  readonly #inlineBudget: number
  /** git tip SHA → kvgit hash, resolved from trailers (tips only;
   *  small and long-lived). */
  readonly #kvgitBySha = new Map<string, string>()

  constructor(client: GithubClient, store: KVStore, opts: GithubRemoteOptions = {}) {
    this.client = client
    this.#store = store
    this.#author = opts.author ?? { name: 'kvgit-sync', email: 'kvgit-sync@agex.dev' }
    this.#kernel = opts.kernel ?? 'ts'
    this.#inlineLimit = opts.inlineLimit ?? INLINE_LIMIT
    this.#inlineBudget = opts.inlineBudget ?? INLINE_TREE_BUDGET
  }

  // -------------------------------------------------------------------------
  // Remote: listRefs
  // -------------------------------------------------------------------------

  /** Branches whose tips carry a Kvgit-Hash trailer. Non-session refs
   *  (`main` with its README, `archived/*` tombstones) drop out
   *  naturally or by prefix. */
  async listRefs(): Promise<RemoteRef[]> {
    const refs = await this.client.listBranchRefs()
    // Trailer resolution is independent, unthrottled GETs — resolve
    // concurrently in bounded chunks.
    const resolved = await chunked(
      refs.filter((ref) => !ref.branch.startsWith(ARCHIVED)),
      GET_CHUNK,
      async (ref) => {
        const head = await this.#kvgitHashOf(ref.sha)
        return head !== null ? { branch: ref.branch, head } : null
      },
    )
    return resolved.filter((r): r is RemoteRef => r !== null)
  }

  /** kvgit hash for a git commit, from its message trailer (cached). */
  async #kvgitHashOf(gitSha: string): Promise<string | null> {
    const cached = this.#kvgitBySha.get(gitSha)
    if (cached !== undefined) return cached
    const commit = await this.client.getCommit(gitSha)
    const match = TRAILER.exec(commit.message)
    if (match === null) return null
    this.#kvgitBySha.set(gitSha, match[1] as string)
    return match[1] as string
  }

  // -------------------------------------------------------------------------
  // Remote: fetch
  // -------------------------------------------------------------------------

  /**
   * Stream the delta from the remote: commits reachable from `want`
   * but not from `have`, parents-first.
   *
   * Mechanics: locate `want`'s branch tip, expand `have` to its full
   * LOCAL ancestry (pruning is a local read, never a request), page
   * the commits list back from the tip until every needed commit's
   * parents are accounted for, then walk the commits (topo order) in
   * `GET_CHUNK`-sized WINDOWS — reading each window's sidecars + blobs
   * concurrently (bounded to `GET_CHUNK` in-flight requests) before
   * yielding the window's `WireCommit`s in order. Batching unpairs the
   * network round-trips from the consumer's apply pace: an initial
   * checkout of N commits costs ~N/GET_CHUNK request waves instead of
   * N serial round-trips (one per commit, each gated behind the
   * previous commit's apply). Window-at-a-time keeps peak memory to a
   * single window of blobs rather than the whole history. The receiver
   * (`applyWire`) recomputes every hash — fetch verifies only
   * trailer↔sidecar agreement.
   *
   * Side effect: when the walk can fold a complete key→path map for
   * the tip (full-history fetch, or incremental atop matching
   * transport state), the transport state is persisted — this is what
   * arms the NEXT push after a pull, closing the multi-device loop.
   */
  async *fetch(want: string, have: Iterable<string>): AsyncIterable<WireCommit> {
    const tip = await this.#locateTip(want)
    if (tip === null) {
      throw new Error(`GithubRemote.fetch: no branch tip with kvgit hash ${want.slice(0, 7)}`)
    }
    const haveSet = await this.#expandLocalAncestors(have)
    if (haveSet.has(want)) return

    const walked = await this.#walkRemote(tip.gitSha, haveSet)
    const ordered = topoOrder(walked, haveSet)

    // Path-map folding for transport state (per-commit forks, like
    // the pusher's planners). Complete only when every fold has a
    // base: trivially true for full-history walks; incremental walks
    // need prior state at a have-frontier commit.
    const pathMaps = new Map<string, Map<string, string>>()
    // Values fold alongside paths, best effort: a missing entry only
    // means a later push sends those bytes rather than referencing them.
    const valueMaps = new Map<string, Map<string, BlobIds>>()
    const state = await this.#loadState(tip.branch)
    if (state !== null && haveSet.has(state.kvgitHead)) {
      pathMaps.set(state.kvgitHead, new Map(state.assignments))
      valueMaps.set(state.kvgitHead, valuesOf(state))
    }
    let foldComplete = true

    let tipTreeSha: string | null = null
    for (let i = 0; i < ordered.length; i += GET_CHUNK) {
      const window = ordered.slice(i, i + GET_CHUNK)

      // Window phase 1 — sidecars: one GET each, GET_CHUNK concurrent.
      const sidecars = new Map<string, ReturnType<typeof decodeSidecar>>()
      await chunked(window, GET_CHUNK, async (gitSha) => {
        const meta = walked.get(gitSha) as RemoteCommit
        const sidecarBytes = await this.client.getContent(SIDECAR_PATH, gitSha)
        if (sidecarBytes === null) {
          throw new Error(`GithubRemote.fetch: ${gitSha.slice(0, 8)} has no ${SIDECAR_PATH}`)
        }
        const sidecar = decodeSidecar(sidecarBytes)
        if (sidecar.hash !== meta.kvHash) {
          throw new Error(
            `GithubRemote.fetch: trailer/sidecar mismatch at ${gitSha.slice(0, 8)} (${meta.kvHash.slice(0, 7)} vs ${sidecar.hash.slice(0, 7)})`,
          )
        }
        sidecars.set(gitSha, sidecar)
      })

      // Window phase 2 — values. One the local store already holds
      // (the sidecar names it by hash) is read from there, and one that
      // several commits in the window share is downloaded once. The
      // rest come down flattened across the window and bounded at
      // GET_CHUNK concurrent, so a wide window's fan-out can't burst
      // past GitHub's secondary limits. Per-commit maps are pre-created
      // so the concurrent writes never race.
      const blobs = new Map<string, Map<string, Uint8Array>>()
      for (const gitSha of window) blobs.set(gitSha, new Map())
      const byHex = new Map<string, Uint8Array>()
      const downloads = new Map<string, { path: string; gitSha: string; hash: string }>()
      const refs = [...sidecars].flatMap(([gitSha, sidecar]) =>
        [...sidecar.updates].map(([key, entry]) => ({ gitSha, key, entry, hash: sidecar.hash })),
      )
      for (const ref of refs) {
        const hex = ref.entry.blob
        if (hex === undefined || byHex.has(hex)) continue
        const local = await this.#store.get(BLOB_PREFIX + hex)
        if (local !== null) byHex.set(hex, local)
        else if (!downloads.has(hex)) {
          downloads.set(hex, { path: ref.entry.path, gitSha: ref.gitSha, hash: ref.hash })
        }
      }
      await chunked([...downloads], GET_CHUNK, async ([hex, at]) => {
        const bytes = await this.client.getContent(at.path, at.gitSha)
        if (bytes === null) {
          throw new Error(
            `GithubRemote.fetch: blob missing at ${at.path} for ${at.hash.slice(0, 7)}`,
          )
        }
        byHex.set(hex, bytes)
      })
      const unnamed = refs.filter((ref) => ref.entry.blob === undefined)
      await chunked(unnamed, GET_CHUNK, async (ref) => {
        const bytes = await this.client.getContent(ref.entry.path, ref.gitSha)
        if (bytes === null) {
          throw new Error(
            `GithubRemote.fetch: blob missing at ${ref.entry.path} for ${ref.hash.slice(0, 7)}`,
          )
        }
        ;(blobs.get(ref.gitSha) as Map<string, Uint8Array>).set(ref.key, bytes)
      })
      for (const ref of refs) {
        if (ref.entry.blob === undefined) continue
        const bytes = byHex.get(ref.entry.blob) as Uint8Array
        ;(blobs.get(ref.gitSha) as Map<string, Uint8Array>).set(ref.key, bytes)
      }

      // Window phase 3 — fold + yield in topo order. No network here,
      // so applyWire drains the window at CPU speed; the window's blob
      // buffer is released when the next window's overwrites it.
      for (const gitSha of window) {
        const meta = walked.get(gitSha) as RemoteCommit
        const sidecar = sidecars.get(gitSha) as ReturnType<typeof decodeSidecar>
        const wire = wireFromSidecar(sidecar, blobs.get(gitSha) as Map<string, Uint8Array>)

        // Fold the key→path map forward.
        const firstParent = wire.parents[0]
        const base =
          firstParent !== undefined ? pathMaps.get(firstParent) : new Map<string, string>()
        if (base === undefined) {
          foldComplete = false
        } else {
          const fold = new Map(base)
          for (const key of wire.removals) fold.delete(key)
          for (const [key, entry] of sidecar.updates) fold.set(key, entry.path)
          pathMaps.set(wire.hash, fold)
        }
        const valueFold = new Map(
          (firstParent !== undefined ? valueMaps.get(firstParent) : undefined) ?? [],
        )
        for (const key of wire.removals) valueFold.delete(key)
        for (const [key, bytes] of wire.updates) {
          const hex = sidecar.updates.get(key)?.blob ?? (await sha256Hex(bytes))
          valueFold.set(key, [hex, await gitBlobSha1(bytes)])
        }
        valueMaps.set(wire.hash, valueFold)

        if (wire.hash === want) tipTreeSha = meta.treeSha
        yield wire
      }
    }

    const tipMap = pathMaps.get(want)
    if (foldComplete && tipMap !== undefined && tipTreeSha !== null) {
      await this.#saveState(tip.branch, {
        format: STATE_FORMAT,
        kvgitHead: want,
        gitHead: tip.gitSha,
        treeSha: tipTreeSha,
        assignments: [...tipMap],
        values: valueRows(valueMaps.get(want) ?? new Map()),
      })
    }
  }

  /**
   * Rebuild a branch's transport state from the remote alone: walk the
   * FULL history reading only sidecars (no value blobs), fold the
   * key→path map, persist. The recovery path for "stale transport
   * state" pushes — e.g. local state lost, or the branch was last
   * pushed before state existed.
   */
  async rebuildTransportState(branch: string): Promise<void> {
    const tipSha = await this.client.getRef(branch)
    if (tipSha === null) {
      throw new Error(`rebuildTransportState: branch '${branch}' has no remote ref`)
    }
    const want = await this.#kvgitHashOf(tipSha)
    if (want === null) {
      throw new Error(`rebuildTransportState: '${branch}' tip carries no Kvgit-Hash trailer`)
    }
    const walked = await this.#walkRemote(tipSha, new Set())
    const ordered = topoOrder(walked, new Set())

    // Prefetch sidecars in bounded chunks: parallel enough to make a
    // long-history rebuild fast, bounded enough to stay clear of
    // GitHub's secondary limits on concurrent request bursts. The
    // fold below stays sequential (each map builds on its parent's).
    const sidecars = new Map<string, ReturnType<typeof decodeSidecar>>()
    await chunked(ordered, GET_CHUNK, async (gitSha) => {
      const sidecarBytes = await this.client.getContent(SIDECAR_PATH, gitSha)
      if (sidecarBytes === null) {
        throw new Error(`rebuildTransportState: ${gitSha.slice(0, 8)} has no ${SIDECAR_PATH}`)
      }
      sidecars.set(gitSha, decodeSidecar(sidecarBytes))
    })

    const pathMaps = new Map<string, Map<string, string>>()
    let tipTreeSha: string | null = null
    for (const gitSha of ordered) {
      const meta = walked.get(gitSha) as RemoteCommit
      const sidecar = sidecars.get(gitSha) as ReturnType<typeof decodeSidecar>
      const firstParent = sidecar.parents[0]
      const base = firstParent !== undefined ? pathMaps.get(firstParent) : new Map<string, string>()
      if (base === undefined) {
        throw new Error(`rebuildTransportState: fold base missing at ${sidecar.hash.slice(0, 7)}`)
      }
      const fold = new Map(base)
      for (const key of sidecar.removals) fold.delete(key)
      for (const [key, entry] of sidecar.updates) fold.set(key, entry.path)
      pathMaps.set(sidecar.hash, fold)
      if (sidecar.hash === want) tipTreeSha = meta.treeSha
    }

    const tipMap = pathMaps.get(want)
    if (tipMap === undefined || tipTreeSha === null) {
      throw new Error(`rebuildTransportState: walk never reached tip ${want.slice(0, 7)}`)
    }
    await this.#saveState(branch, {
      format: STATE_FORMAT,
      kvgitHead: want,
      gitHead: tipSha,
      treeSha: tipTreeSha,
      assignments: [...tipMap],
    })
  }

  // -------------------------------------------------------------------------
  // Roster ops — session lifecycle over the ref namespace.
  //
  // The repo syncs session VISIBILITY, not just content: `refs/heads/*`
  // is the live roster, `archived/*` the recoverable trash, absence is
  // hard-deleted. Archive/restore are ref renames; objects stay
  // reachable until the tombstone is pruned and GitHub GC runs. Local
  // cleanup (sync heads, transport state, branch removal) belongs to
  // the orchestration layer, not the transport.
  // -------------------------------------------------------------------------

  /**
   * Archive a live branch: rename its ref into `archived/`. Returns
   * false when the live ref doesn't exist (already archived elsewhere,
   * or never pushed). Concurrent archives collapse benignly; if a
   * tombstone already exists it's force-pointed at the newest content
   * so no recent commits become unreachable.
   */
  async archiveBranch(branch: string): Promise<boolean> {
    const sha = await this.client.getRef(branch)
    if (sha === null) return false
    const created = await this.client.createRef(`${ARCHIVED}${branch}`, sha)
    if (!created) {
      // Tombstone exists (concurrent archive, or a prior same-named
      // session). Point it at the newest content before dropping the
      // live ref — force, since the old tombstone need not be an
      // ancestor.
      await this.client.updateRef(`${ARCHIVED}${branch}`, sha, { force: true })
    }
    await this.client.deleteRef(branch)
    return true
  }

  /**
   * Restore an archived branch. Returns the live branch name — the
   * original, or `<branch>-restored` if the original name was retaken
   * (≈ never for chat-<hex8> names). Throws if nothing is archived
   * under `branch` (e.g. restore raced an empty-trash).
   */
  async restoreBranch(branch: string): Promise<string> {
    const archivedRef = `${ARCHIVED}${branch}`
    const sha = await this.client.getRef(archivedRef)
    if (sha === null) {
      throw new Error(`restoreBranch: nothing archived under '${branch}'`)
    }
    let target = branch
    if (!(await this.client.createRef(target, sha))) {
      target = `${branch}-restored`
      if (!(await this.client.createRef(target, sha))) {
        throw new Error(`restoreBranch: both '${branch}' and '${target}' are taken`)
      }
    }
    await this.client.deleteRef(archivedRef)
    return target
  }

  /** Hard-delete one archived session ("Delete forever"). False if it
   *  was already gone. Objects become unreachable; GitHub GC reclaims
   *  on its own schedule. */
  async deleteForever(branch: string): Promise<boolean> {
    return this.client.deleteRef(`${ARCHIVED}${branch}`)
  }

  /** Hard-delete every archived session ("Empty trash"). Returns the
   *  number of tombstones removed. */
  async emptyTrash(): Promise<number> {
    const refs = await this.client.listBranchRefs()
    let removed = 0
    for (const ref of refs) {
      if (!ref.branch.startsWith(ARCHIVED)) continue
      if (await this.client.deleteRef(ref.branch)) removed++
    }
    return removed
  }

  /** Archived sessions (names without the `archived/` prefix), with
   *  their kvgit heads — the trash view. */
  async listArchivedRefs(): Promise<RemoteRef[]> {
    const refs = await this.client.listBranchRefs()
    const resolved = await chunked(
      refs.filter((ref) => ref.branch.startsWith(ARCHIVED)),
      GET_CHUNK,
      async (ref) => {
        const head = await this.#kvgitHashOf(ref.sha)
        return head !== null ? { branch: ref.branch.slice(ARCHIVED.length), head } : null
      },
    )
    return resolved.filter((r): r is RemoteRef => r !== null)
  }

  /**
   * Read one key's value bytes at a branch tip without materializing
   * the session — the cloud-stub primitive (e.g. a branch-meta key for
   * title/name display). A key's tree path is always its natural path
   * or its relocation slot, so two probes cover every assignment.
   * Bytes are kvgit-encoded; the caller's codec decodes.
   */
  async readKeyAtTip(branch: string, key: string): Promise<Uint8Array | null> {
    const sha = await this.client.getRef(branch)
    if (sha === null) return null
    const natural = await this.client.getContent(naturalPath(key), sha)
    if (natural !== null) return natural
    return this.client.getContent(relocatedPath(key), sha)
  }

  /** Find the branch whose tip resolves to kvgit hash `want`. */
  async #locateTip(want: string): Promise<{ branch: string; gitSha: string } | null> {
    const refs = await this.client.listBranchRefs()
    for (const ref of refs) {
      if (ref.branch.startsWith(ARCHIVED)) continue
      if ((await this.#kvgitHashOf(ref.sha)) === want) {
        return { branch: ref.branch, gitSha: ref.sha }
      }
    }
    return null
  }

  /** All kvgit hashes reachable locally from `have` (tolerant of
   *  unknown hashes — they just contribute nothing). */
  async #expandLocalAncestors(have: Iterable<string>): Promise<Set<string>> {
    const out = new Set<string>()
    const stack = [...have]
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (out.has(current)) continue
      const raw = await this.#store.get(PARENT_COMMIT(current))
      if (raw === null) continue
      out.add(current)
      const parsed = safeLoads(raw)
      const parents = Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === 'string')
        : []
      for (const p of parents) if (!out.has(p)) stack.push(p)
    }
    return out
  }

  /**
   * Page the commits list back from `tipSha`, recording every commit
   * until all parents of NEEDED commits are seen. Commits whose kvgit
   * hash is in `haveKv` are pruned (their parents aren't pursued), so
   * the walk's cost tracks the delta plus paging slop.
   */
  async #walkRemote(
    tipSha: string,
    haveKv: ReadonlySet<string>,
  ): Promise<Map<string, RemoteCommit>> {
    const seen = new Map<string, RemoteCommit>()
    const pending = new Set<string>([tipSha])
    for (let page = 1; page <= 500 && pending.size > 0; page++) {
      const batch = await this.client.listCommits({ sha: tipSha, perPage: 100, page })
      for (const c of batch) {
        if (seen.has(c.sha)) continue
        const kvHash = kvgitHashFromMessage(c.message)
        if (kvHash === null) {
          throw new Error(
            `GithubRemote: commit ${c.sha.slice(0, 8)} on a session branch lacks a Kvgit-Hash trailer`,
          )
        }
        seen.set(c.sha, { kvHash, gitParents: c.parents, treeSha: c.treeSha })
        this.#kvgitBySha.set(c.sha, kvHash)
        pending.delete(c.sha)
        if (!haveKv.has(kvHash)) {
          for (const p of c.parents) if (!seen.has(p)) pending.add(p)
        }
      }
      if (batch.length < 100) {
        if (pending.size > 0) {
          throw new Error(
            `GithubRemote: history exhausted with ${pending.size} unresolved parent(s) — corrupt branch?`,
          )
        }
        break
      }
    }
    if (pending.size > 0) {
      throw new Error('GithubRemote: history walk exceeded 50,000 commits')
    }
    return seen
  }

  // -------------------------------------------------------------------------
  // Remote: push
  // -------------------------------------------------------------------------

  async push(
    branch: string,
    expectedOld: string | null,
    newHead: string,
    commits: AsyncIterable<WireCommit> | Iterable<WireCommit>,
  ): Promise<boolean> {
    // CAS precheck — cheap reads before any uploads. The trailing ref
    // update is still the authoritative CAS; this just avoids paying
    // for a push that's already lost.
    const tipSha = await this.client.getRef(branch)
    if (expectedOld === null) {
      if (tipSha !== null) return false
    } else {
      if (tipSha === null) return false
      if ((await this.#kvgitHashOf(tipSha)) !== expectedOld) return false
    }

    // Frontier rendering state.
    const renders = new Map<string, CommitRender>()
    if (expectedOld !== null) {
      const state = await this.#loadState(branch)
      if (state === null || state.kvgitHead !== expectedOld) {
        throw new Error(
          `GithubRemote.push: transport state for '${branch}' is ${
            state === null ? 'missing' : `at ${state.kvgitHead.slice(0, 7)}`
          } but the push frontier is ${expectedOld.slice(0, 7)} — fetch/pull first to rebuild it`,
        )
      }
      renders.set(expectedOld, {
        gitSha: state.gitHead,
        treeSha: state.treeSha,
        planner: PathPlanner.fromAssignments(state.assignments),
        values: valuesOf(state),
      })
    }

    // Values the remote repo holds, as far as this store knows: the
    // trees every branch here last pushed or fetched, then everything
    // this push places. git stores a blob once per repo, so a value
    // under another key, path or branch is referenced by SHA rather
    // than sent again (a rename, a copy, a revert, or what a merge
    // takes from the other side).
    const known = await this.#knownBlobs()

    let head: CommitRender | null = null
    let headHash: string | null = null

    for await (const wc of commits) {
      const firstParent = wc.parents[0]
      const parentRender = firstParent !== undefined ? renders.get(firstParent) : undefined
      if (firstParent !== undefined && parentRender === undefined) {
        throw new Error(
          `GithubRemote.push: parent ${firstParent.slice(0, 7)} of ${wc.hash.slice(0, 7)} not in stream or frontier (stream must be parents-first)`,
        )
      }

      const planner =
        parentRender !== undefined
          ? PathPlanner.fromAssignments(parentRender.planner.entries())
          : new PathPlanner()

      const values = new Map(parentRender?.values ?? [])
      const keys = [...wc.updates.keys()].sort()
      const paths = new Map(keys.map((key) => [key, planner.assign(key)] as const))
      const hexes = new Map<string, string>()
      for (const key of keys) hexes.set(key, await sha256Hex(wc.updates.get(key) as Uint8Array))

      // Removals: clear the key's slot in the parent's rendering.
      const removals: TreeEntry[] = []
      for (const key of [...wc.removals].sort()) {
        const path = planner.get(key)
        if (path !== undefined) {
          removals.push({ path, mode: '100644', type: 'blob', sha: null })
          planner.remove(key)
        }
        values.delete(key)
      }

      // Sidecar last: its paths reflect this commit's planning, and it
      // records each value's hash so a fetcher can skip what it has.
      const sidecar = encodeSidecar(wc, {
        kernel: this.#kernel,
        paths: plannerView(planner),
        blobs: hexes,
      })

      /**
       * The commit's tree entries. With `dedup`, a value the remote
       * already holds is referenced by its git SHA; anything else is
       * inlined when it fits the gates, else uploaded as its own blob.
       *
       * `content` on a tree entry makes GitHub write the blob as part of
       * the tree call, so the per-key POST disappears into a request
       * that was happening anyway: the difference between N + 3 and 2
       * requests for a commit, against a budget of 500 an hour.
       */
      const build = async (
        dedup: boolean,
      ): Promise<{ entries: TreeEntry[]; placed: Map<string, BlobIds>; reused: string[] }> => {
        // Spent down as values are inlined. Every inlined value in this
        // commit ships in ONE tree request, so without a running budget
        // a set of individually-acceptable values can still build a
        // body no endpoint will take.
        let inlineBudget = this.#inlineBudget
        const placeValue = async (path: string, bytes: Uint8Array): Promise<TreeEntry> => {
          const text = inlinable(bytes, this.#inlineLimit)
          if (text !== null) {
            const cost = inlineCost(text)
            if (cost <= inlineBudget) {
              inlineBudget -= cost
              return { path, mode: '100644', type: 'blob', content: text }
            }
          }
          return { path, mode: '100644', type: 'blob', sha: await this.client.createBlob(bytes) }
        }
        const entries: TreeEntry[] = []
        const placed = new Map<string, BlobIds>()
        const reused: string[] = []
        for (const key of keys) {
          const bytes = wc.updates.get(key) as Uint8Array
          const path = paths.get(key) as string
          const hex = hexes.get(key) as string
          const remote = dedup ? known.get(hex) : undefined
          if (remote !== undefined) {
            entries.push({ path, mode: '100644', type: 'blob', sha: remote })
            placed.set(key, [hex, remote])
            reused.push(hex)
            continue
          }
          const entry = await placeValue(path, bytes)
          // An inlined value's SHA never comes back from GitHub; git's
          // blob hash of the bytes is what it stored.
          const sha = typeof entry.sha === 'string' ? entry.sha : await gitBlobSha1(bytes)
          entries.push(entry)
          placed.set(key, [hex, sha])
        }
        entries.push(...removals)
        entries.push(await placeValue(SIDECAR_PATH, sidecar))
        return { entries, placed, reused }
      }

      let built = await build(true)
      let treeSha: string
      try {
        treeSha = await this.client.createTree(built.entries, parentRender?.treeSha)
      } catch (e) {
        // A referenced blob the repo no longer has (a branch deleted
        // for good, then collected) fails the tree as invalid: forget
        // what was reused and send every value.
        if (!(e instanceof GithubError && e.kind === 'validation') || built.reused.length === 0) {
          throw e
        }
        for (const hex of built.reused) known.delete(hex)
        built = await build(false)
        treeSha = await this.client.createTree(built.entries, parentRender?.treeSha)
      }
      for (const [key, ids] of built.placed) {
        values.set(key, ids)
        known.set(ids[0], ids[1])
      }

      const parentShas: string[] = []
      for (const p of wc.parents) {
        parentShas.push(await this.#gitShaOf(p, renders))
      }
      const date = isoSeconds(wc.time.value)
      const title = commitTitle(wc)
      const gitSha = await this.client.createCommit({
        message: `${title}\n\nKvgit-Hash: ${wc.hash}\nKvgit-Format: ${SIDECAR_FORMAT}`,
        tree: treeSha,
        parents: parentShas,
        author: { ...this.#author, date },
        committer: { ...this.#author, date },
      })

      const render: CommitRender = { gitSha, treeSha, planner, values }
      renders.set(wc.hash, render)
      this.#kvgitBySha.set(gitSha, wc.hash)
      head = render
      headHash = wc.hash
    }

    if (head === null || headHash !== newHead) {
      throw new Error(
        `GithubRemote.push: stream ended at ${headHash?.slice(0, 7) ?? '∅'}, expected ${newHead.slice(0, 7)}`,
      )
    }

    // The one authoritative CAS.
    const ok =
      expectedOld === null
        ? await this.client.createRef(branch, head.gitSha)
        : await this.client.updateRef(branch, head.gitSha)
    if (!ok) return false

    await this.#saveState(branch, {
      format: STATE_FORMAT,
      kvgitHead: newHead,
      gitHead: head.gitSha,
      treeSha: head.treeSha,
      assignments: [...head.planner.entries()],
      values: valueRows(head.values),
    })
    return true
  }

  /** Every value the saved states for this repo say its trees hold:
   *  value SHA-256 hex → git blob SHA. */
  async #knownBlobs(): Promise<Map<string, string>> {
    const known = new Map<string, string>()
    const prefix = stateKey(this.client.repo, '')
    for await (const [, raw] of this.#store.items(prefix)) {
      const state = safeLoads(raw) as TransportState | null
      if (state === null || state.format !== STATE_FORMAT) continue
      for (const [hex, sha] of valuesOf(state).values()) known.set(hex, sha)
    }
    return known
  }

  /** git SHA for a kvgit parent: in-stream renders, then the trailer
   *  cache, then a bounded walk back through the remote commits list
   *  (covers merge parents below the push frontier). */
  async #gitShaOf(kvgitHash: string, renders: ReadonlyMap<string, CommitRender>): Promise<string> {
    const render = renders.get(kvgitHash)
    if (render !== undefined) return render.gitSha
    for (const [gitSha, kv] of this.#kvgitBySha) {
      if (kv === kvgitHash) return gitSha
    }
    // Walk back from the frontier's git head through history pages.
    const frontier = renders.values().next().value
    if (frontier !== undefined) {
      for (let page = 1; page <= 50; page++) {
        const commits = await this.client.listCommits({ sha: frontier.gitSha, perPage: 100, page })
        for (const c of commits) {
          const match = TRAILER.exec(c.message)
          if (match !== null) {
            this.#kvgitBySha.set(c.sha, match[1] as string)
            if (match[1] === kvgitHash) return c.sha
          }
        }
        if (commits.length < 100) break
      }
    }
    throw new Error(
      `GithubRemote.push: no git commit found for kvgit parent ${kvgitHash.slice(0, 7)}`,
    )
  }

  // -------------------------------------------------------------------------
  // Transport state persistence
  // -------------------------------------------------------------------------

  async #loadState(branch: string): Promise<TransportState | null> {
    const raw = await this.#store.get(stateKey(this.client.repo, branch))
    if (raw === null) return null
    const parsed = safeLoads(raw) as TransportState | null
    if (parsed === null || parsed.format !== STATE_FORMAT) return null
    return parsed
  }

  async #saveState(branch: string, state: TransportState): Promise<void> {
    await this.#store.set(stateKey(this.client.repo, branch), dumps(state))
  }
}

/** A saved state's values, keyed by key; malformed rows are dropped. */
function valuesOf(state: TransportState): Map<string, BlobIds> {
  const out = new Map<string, BlobIds>()
  for (const row of state.values ?? []) {
    if (Array.isArray(row) && row.length === 3 && row.every((x) => typeof x === 'string')) {
      out.set(row[0], [row[1], row[2]])
    }
  }
  return out
}

function valueRows(values: ReadonlyMap<string, BlobIds>): Array<[string, string, string]> {
  return [...values].map(([key, [hex, sha]]) => [key, hex, sha])
}

/** Expose a PathPlanner as the ReadonlyMap encodeSidecar expects. */
function plannerView(planner: PathPlanner): ReadonlyMap<string, string> {
  return new Map(planner.entries())
}

/** Seconds-resolution ISO 8601 from kvgit's time in seconds — the
 *  exact time lives in the sidecar; git dates only need determinism. */
function isoSeconds(seconds: number): string {
  return new Date(Math.floor(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** A commit's git message title: its info's `title` when it has one. */
function commitTitle(wc: WireCommit): string {
  const info = wc.info
  if (info !== null && typeof info === 'object' && 'title' in info) {
    const title = (info as { title: unknown }).title
    if (typeof title === 'string') return title
  }
  return `kvgit ${wc.hash.slice(0, 7)}`
}

/** Parse a commit message's `Kvgit-Hash:` trailer (exported for the
 *  fetch side and tests). */
export function kvgitHashFromMessage(message: string): string | null {
  const match = TRAILER.exec(message)
  return match === null ? null : (match[1] as string)
}
