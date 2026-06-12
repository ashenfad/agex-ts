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
 *   blobs (content-addressed, skipped when already uploaded)
 *     → tree (`base_tree` on the first parent's tree + delta entries)
 *       → commit (explicit dates ⇒ deterministic git SHAs)
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
 * the kvgit head it describes. A push whose `expectedOld` doesn't
 * match the persisted state fails with a "stale transport state"
 * error — rebuilding state from the remote is the fetch side's job
 * (next PR), since pulling is what makes a foreign frontier local.
 *
 * The local store also backstops merge carries: a carried key whose
 * owning commit predates the frontier needs its value's blob SHA for
 * the tree; the bytes live locally at `<owner>:<key>`, so the
 * transport hashes (and if needed re-uploads) from there.
 */

import type { Remote, RemoteRef } from '../sync/remote'
import type { KVStore, WireCommit } from '../types'
import { blobPointer, dumps, safeLoads } from '../versioned/layout'
import type { GithubClient, TreeEntry } from './client'
import { gitBlobSha1 } from './git-hash'
import { PathPlanner, SIDECAR_PATH } from './paths'
import { encodeSidecar } from './sidecar'

export interface GithubRemoteOptions {
  /** Commit author/committer identity on the sync repo. */
  author?: { name: string; email: string }
  /** Encoder discriminator recorded in sidecars. Default 'ts'. */
  kernel?: string
}

const TRAILER = /^Kvgit-Hash: ([0-9a-f]{40})$/m
const STATE_FORMAT = 1

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
}

/** Per-in-stream-commit rendering state (forked per parent, like
 *  applyWire's pointer maps — merges need the non-linear ancestor). */
interface CommitRender {
  gitSha: string
  treeSha: string
  planner: PathPlanner
}

export class GithubRemote implements Remote {
  readonly client: GithubClient
  readonly #store: KVStore
  readonly #author: { name: string; email: string }
  readonly #kernel: string
  /** git tip SHA → kvgit hash, resolved from trailers (tips only;
   *  small and long-lived). */
  readonly #kvgitBySha = new Map<string, string>()

  constructor(client: GithubClient, store: KVStore, opts: GithubRemoteOptions = {}) {
    this.client = client
    this.#store = store
    this.#author = opts.author ?? { name: 'kvgit-sync', email: 'kvgit-sync@agex.dev' }
    this.#kernel = opts.kernel ?? 'ts'
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
    // concurrently rather than serially per branch.
    const resolved = await Promise.all(
      refs
        .filter((ref) => !ref.branch.startsWith('archived/'))
        .map(async (ref) => {
          const head = await this.#kvgitHashOf(ref.sha)
          return head !== null ? { branch: ref.branch, head } : null
        }),
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
  // Remote: fetch (next PR)
  // -------------------------------------------------------------------------

  fetch(_want: string, _have: Iterable<string>): AsyncIterable<WireCommit> {
    throw new Error('GithubRemote.fetch is not implemented yet (PR 8)')
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
      })
    }

    // (owner kvgit hash, key) → uploaded blob git SHA, for carries
    // whose owner is in this stream.
    const uploadedBlobs = new Map<string, string>()

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

      const entries: TreeEntry[] = []

      // Updates: upload bytes, place at planned paths.
      for (const key of [...wc.updates.keys()].sort()) {
        const bytes = wc.updates.get(key) as Uint8Array
        const sha = await this.client.createBlob(bytes)
        uploadedBlobs.set(`${wc.hash}:${key}`, sha)
        entries.push({ path: planner.assign(key), mode: '100644', type: 'blob', sha })
      }

      // Carries: same bytes as the owning commit's write — find the
      // blob SHA without re-shipping when possible.
      for (const key of [...wc.carries.keys()].sort()) {
        const carry = wc.carries.get(key) as { owner: string }
        const sha = await this.#carryBlobSha(carry.owner, key, uploadedBlobs)
        entries.push({ path: planner.assign(key), mode: '100644', type: 'blob', sha })
      }

      // Removals: clear the key's slot in the parent's rendering.
      for (const key of [...wc.removals].sort()) {
        const path = planner.get(key)
        if (path !== undefined) {
          entries.push({ path, mode: '100644', type: 'blob', sha: null })
          planner.remove(key)
        }
      }

      // Sidecar last — its paths must reflect this commit's planning.
      const sidecar = encodeSidecar(wc, { kernel: this.#kernel, paths: plannerView(planner) })
      entries.push({
        path: SIDECAR_PATH,
        mode: '100644',
        type: 'blob',
        sha: await this.client.createBlob(sidecar),
      })

      const treeSha = await this.client.createTree(entries, parentRender?.treeSha)

      const parentShas: string[] = []
      for (const p of wc.parents) {
        parentShas.push(await this.#gitShaOf(p, renders))
      }
      const date = isoSeconds(wc.time)
      const title =
        typeof wc.info?.title === 'string' ? wc.info.title : `kvgit ${wc.hash.slice(0, 7)}`
      const gitSha = await this.client.createCommit({
        message: `${title}\n\nKvgit-Hash: ${wc.hash}\nKvgit-Format: 1`,
        tree: treeSha,
        parents: parentShas,
        author: { ...this.#author, date },
        committer: { ...this.#author, date },
      })

      const render: CommitRender = { gitSha, treeSha, planner }
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
    })
    return true
  }

  /** Blob SHA for a carried key: in-stream uploads first, then a
   *  local hash of the store's bytes (`<owner>:<key>` exists locally
   *  on any device that can construct the merge). No upload needed —
   *  an owner below the frontier was pushed previously, so its blob
   *  is already on the remote, referenced from the owner commit's
   *  tree (GC-safe). If that invariant were ever violated,
   *  `createTree` rejects the dangling SHA with a 422 — loud, not
   *  corrupting. */
  async #carryBlobSha(
    owner: string,
    key: string,
    uploadedBlobs: ReadonlyMap<string, string>,
  ): Promise<string> {
    const inStream = uploadedBlobs.get(`${owner}:${key}`)
    if (inStream !== undefined) return inStream
    const bytes = await this.#store.get(blobPointer(owner, key))
    if (bytes === null) {
      throw new Error(
        `GithubRemote.push: carried blob ${owner.slice(0, 7)}:${key} not found locally`,
      )
    }
    return gitBlobSha1(bytes)
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

/** Expose a PathPlanner as the ReadonlyMap encodeSidecar expects. */
function plannerView(planner: PathPlanner): ReadonlyMap<string, string> {
  return new Map(planner.entries())
}

/** Seconds-resolution ISO 8601 — millisecond fidelity for kvgit time
 *  lives in the sidecar; git dates only need determinism. */
function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Parse a commit message's `Kvgit-Hash:` trailer (exported for the
 *  fetch side and tests). */
export function kvgitHashFromMessage(message: string): string | null {
  const match = TRAILER.exec(message)
  return match === null ? null : (match[1] as string)
}
