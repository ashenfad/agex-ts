/**
 * The agent's git, as a fiction over the session's own history.
 *
 * An agent asks for git: an index it fills across several edits,
 * commits it names, a log it can read back. The session underneath
 * has its own history, a commit per tool call made for durability at
 * moments the agent never chose. The two aren't one history, so the
 * agent's git is metadata over the session's:
 *
 * - **The index and the agent's graph live in a blob** at
 *   {@link BLOB_KEY}: the agent's head (a commit of the session), the
 *   staged paths, an outstanding merge, the agent's own tags, and, for
 *   a fork, the commit it started from. The blob is an ordinary key,
 *   committed like any other; nothing is withheld from the session.
 * - **Status compares the files with the agent's head,** not the
 *   session's: commits the framework makes between the agent's leave
 *   its composition alone.
 * - **An agent commit holds exactly what the agent committed.** Paths
 *   outside the commit set are put back to the agent's head for the
 *   commit, which takes only its own keys, and their work in progress is
 *   restored right after, in a second, bookkeeping commit.
 * - **The agent's log walks its own graph** (`virtualParents` in each
 *   commit's info); the framework's commits between are plumbing.
 *
 * `ws.index` on the host and the `ws-git` command are both this, so
 * the agent and its host see one index and one graph.
 */

import {
  type Commit,
  type CommitInfo,
  ROOT_COMMIT,
  type Snapshot,
  type Worktree,
} from '@agex-ts/kvgit'
import { UnknownRefError, WorldError } from './errors'
import type { KeyReader, WorldFS } from './fs'
import { FILE_PREFIX, GIT_KEY, fileKey, metaKey } from './layout'
import { dirname, resolve } from './path'
import type { Store } from './store'

/** The key of the agent's index and graph. */
export const BLOB_KEY = GIT_KEY

/** The blob's layout version. */
export const BLOB_VERSION = 1

/** `tool` on an agent commit: what tells one from the framework's. */
export const TOOL = 'ws-git'
/** `tool` on the commits a host verb makes in the agent's graph: a
 *  merge of another session, a revert, a cherry-pick. */
export const MERGE_TOOL = 'ws-git.merge'
export const REVERT_TOOL = 'ws-git.revert'
export const PICK_TOOL = 'ws-git.cherry-pick'

/** `tool` on the fiction's own bookkeeping: the files restored after a
 *  partial commit, the tree a checkout writes, the record of a merge.
 *  Each is made by the verb that needs it, whatever autocommit says,
 *  and none is an agent commit. */
export const RESTORE_TOOL = 'ws-git.restore'
export const CHECKOUT_TOOL = 'ws-git.checkout'
export const MERGE_RECORD_TOOL = 'ws-git.merge-record'

const AGENT_TOOLS: ReadonlySet<unknown> = new Set([TOOL, MERGE_TOOL, REVERT_TOOL, PICK_TOOL])
const BOOKKEEPING_TOOLS: ReadonlySet<unknown> = new Set([
  RESTORE_TOOL,
  CHECKOUT_TOOL,
  MERGE_RECORD_TOOL,
])

/** What an agent typing a ref means by a commit: hex, long enough. */
export const HASH_RE = /^[0-9a-f]{7,}$/
const TAG_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

const MARKER = new TextEncoder().encode('<<<<<<< ')

/** Whether a commit belongs to the agent's graph: one it composed, or
 *  one a host verb made in it (a merge, a revert, a cherry-pick). */
export function isAgentCommit(info: CommitInfo | null): boolean {
  return AGENT_TOOLS.has(info?.tool)
}

/** Whether a commit is the fiction's own housekeeping, which nobody
 *  performed. */
export function isBookkeepingCommit(info: CommitInfo | null): boolean {
  return BOOKKEEPING_TOOLS.has(info?.tool)
}

/** The agent-graph parents a commit records. */
export function virtualParents(info: CommitInfo | null): string[] {
  const parents = info?.virtualParents
  return Array.isArray(parents) ? parents.filter((p): p is string => typeof p === 'string') : []
}

/** The agent's state in its blob. */
export interface GitState {
  /** The agent's head: its last commit, or null before the first. */
  head: string | null
  /** For a fork, the commit it started from: what its work is measured
   *  against until its first commit. */
  base: string | null
  staged: string[]
  /** The session (or `session@commit`) an outstanding merge came from. */
  mergeSource: string | null
  /** The paths that merge left marked. */
  unresolved: string[]
  /** The agent's head before the merge, for an abort. */
  preMerge: string | null
  /** The agent's bookmarks: name → commit. */
  tags: Record<string, string>
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** A blob's value as the agent's state, tolerant of absence. */
export function parseBlob(raw: unknown): GitState {
  const v =
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { version?: unknown }).version === BLOB_VERSION
      ? (raw as Record<string, unknown>)
      : {}
  const tags: Record<string, string> = {}
  if (typeof v.tags === 'object' && v.tags !== null) {
    for (const [name, commit] of Object.entries(v.tags)) {
      if (typeof commit === 'string') tags[name] = commit
    }
  }
  return {
    head: stringOrNull(v.head),
    base: stringOrNull(v.base),
    staged: strings(v.staged).sort(),
    mergeSource: stringOrNull(v.mergeSource),
    unresolved: strings(v.unresolved).sort(),
    preMerge: stringOrNull(v.preMerge),
    tags,
  }
}

function encodeBlob(state: GitState): Record<string, unknown> {
  return {
    version: BLOB_VERSION,
    head: state.head,
    base: state.base,
    staged: [...new Set(state.staged)].sort(),
    mergeSource: state.mergeSource,
    unresolved: [...new Set(state.unresolved)].sort(),
    preMerge: state.preMerge,
    tags: Object.fromEntries(Object.entries(state.tags).sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

function sameState(a: GitState, b: GitState): boolean {
  return JSON.stringify(encodeBlob(a)) === JSON.stringify(encodeBlob(b))
}

/** A fresh state for a fork that starts at `base`: no head, nothing
 *  staged, no merge and no tags, since an index is a composition in
 *  progress and a delegate doesn't start halfway through another's. */
export function forkBlob(base: string): Record<string, unknown> {
  return encodeBlob({ ...parseBlob(null), base })
}

/**
 * `name`, or why it can't be a tag: git's shape, and never something
 * that reads as a commit id (seven or more hex characters).
 */
export function checkTagName(name: string): string {
  if (HASH_RE.test(name)) {
    throw new WorldError(
      `'${name}' cannot be a tag name: seven or more hex characters is how a commit id is spelled here, and a word that could be read as either would be neither.`,
    )
  }
  if (!TAG_NAME_RE.test(name) || name.includes('..') || /[./]$|\.lock$/.test(name)) {
    throw new WorldError(
      `'${name}' is not a tag name: letters, digits or _ to start, then any of . - / as well; no .., and nothing trailing a . or a /.`,
    )
  }
  return name
}

/** Whether a stored file holds a conflict marker. */
export function hasMarkers(value: unknown): boolean {
  if (!(value instanceof Uint8Array)) return false
  outer: for (let i = 0; i + MARKER.length <= value.length; i++) {
    for (let j = 0; j < MARKER.length; j++) {
      if (value[i + j] !== MARKER[j]) continue outer
    }
    return true
  }
  return false
}

/** Whether two stored values are the same bytes. */
export function sameBytes(a: unknown, b: unknown): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return a === b
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** What the working tree holds against the agent's head. */
export interface GitStatus {
  /** The session. */
  readonly branch: string
  /** Modified paths the index holds. */
  readonly staged: readonly string[]
  /** Modified paths it doesn't. */
  readonly unstaged: readonly string[]
  /** Of the modified paths, those new since the head, and those gone. */
  readonly added: readonly string[]
  readonly removed: readonly string[]
  /** An outstanding merge: where it came from, and the paths still
   *  marked. */
  readonly mergeSource: string | null
  readonly mergeUnresolved: readonly string[]
}

/** A three-way verb's outcome (merge, revert, cherry-pick). */
export interface MergeOutcome {
  /** Whether it landed. False with conflicts: something no rule
   *  resolves (a file one side made a directory, say), and nothing
   *  changed. False with none: nothing to do. */
  readonly merged: boolean
  readonly commit: string | null
  /** Paths left with conflict markers in the commit (landed), or the
   *  contested paths (not landed). */
  readonly conflicts: readonly string[]
  /** Paths it brought or changed cleanly. */
  readonly autoMerged: readonly string[]
}

/** The agent's bookkeeping landed only in part: its commit is in the
 *  session, the record of it isn't. */
export class BookkeepingLostError extends WorldError {
  override readonly name: string = 'BookkeepingLostError'
}

/** What the agent's git reaches in its workspace. */
export interface GitHost {
  readonly session: string
  readonly store: Store
  readonly root: string
  /** The session's files, writing through its worktree. */
  readonly fs: WorldFS
  /** What reads see now: the live worktree, or a frozen commit. */
  view(): { reader: KeyReader; head: string; pending: ReadonlySet<string> }
  /** Run `fn` as one call of the workspace (live only). */
  run<T>(op: string, fn: (wt: Worktree<unknown>) => Promise<T>): Promise<T>
  /** The tree moved: re-read what depends on it (the cwd). */
  moved(): Promise<void>
}

/** A file path's keys. */
const keysOf = (path: string): string[] => [fileKey(path), metaKey(path)]

/** The files of a commit, by path. */
async function fileKeysAt(snapshot: Snapshot<unknown> | null): Promise<Set<string>> {
  if (snapshot === null) return new Set()
  return new Set(
    (await snapshot.keys())
      .filter((k) => k.startsWith(FILE_PREFIX))
      .map((k) => k.slice(FILE_PREFIX.length)),
  )
}

/** One path's stored content in each of several readers. */
async function contents(
  reader: KeyReader | null,
  paths: Iterable<string>,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>()
  if (reader === null) return out
  const list = [...paths]
  const got = await reader.getMany(list.map(fileKey))
  for (const p of list) {
    const v = got.get(fileKey(p))
    if (v !== undefined) out.set(p, v)
  }
  return out
}

/**
 * `ws.index`: the agent's own git over this session. Reads ({@link
 * status}, {@link log}, {@link head}) work on a frozen view too; the
 * rest are calls of the workspace.
 */
export class WorkspaceIndex {
  /** The agent's own bookmarks (not `ws.tags`, which are the store's). */
  readonly tags: WorkspaceIndexTags
  readonly #host: GitHost

  /** @internal Made by the workspace. */
  constructor(host: GitHost) {
    this.#host = host
    this.tags = new WorkspaceIndexTags(this)
  }

  // ---------- reading ----------

  async #state(reader: KeyReader = this.#host.view().reader): Promise<GitState> {
    return parseBlob(await reader.get(BLOB_KEY))
  }

  /** The agent's head: the commit its last `commit` made, or null
   *  before its first. Not the session's head. */
  async head(): Promise<string | null> {
    return (await this.#state()).head
  }

  /** For a fork, the commit it started from; null for a session that
   *  is no fork. */
  async base(): Promise<string | null> {
    return (await this.#state()).base
  }

  /** @internal The session's files that differ from `ref` (the agent's
   *  head, or a fork's base): modified, and of those added and
   *  removed. With no ref, every file is new. */
  async changes(
    state: GitState,
  ): Promise<{ modified: Set<string>; added: Set<string>; removed: Set<string> }> {
    const { reader, head, pending } = this.#host.view()
    const ref = state.head ?? state.base
    const live = async () =>
      new Set(
        (await reader.keys())
          .filter((k) => k.startsWith(FILE_PREFIX))
          .map((k) => k.slice(FILE_PREFIX.length)),
      )
    if (ref === null) {
      const all = await live()
      return { modified: new Set(all), added: all, removed: new Set() }
    }
    const pendingFiles = [...pending].filter((k) => k.startsWith(FILE_PREFIX))
    if (ref === head && pendingFiles.length === 0) {
      return { modified: new Set(), added: new Set(), removed: new Set() }
    }
    const repo = this.#host.store.repo
    const diff = ref === head ? null : await repo.diff(ref, head)
    const candidates = new Set<string>()
    for (const keys of diff === null ? [] : [diff.added, diff.removed, diff.modified]) {
      for (const k of keys)
        if (k.startsWith(FILE_PREFIX)) candidates.add(k.slice(FILE_PREFIX.length))
    }
    for (const k of pendingFiles) candidates.add(k.slice(FILE_PREFIX.length))
    const [then, now] = await Promise.all([
      contents(await repo.snapshot({ commit: ref }), candidates),
      contents(reader, candidates),
    ])
    const modified = new Set<string>()
    const added = new Set<string>()
    const removed = new Set<string>()
    for (const path of candidates) {
      const a = then.get(path)
      const b = now.get(path)
      if (a === undefined && b === undefined) continue
      if (a === undefined) added.add(path)
      else if (b === undefined) removed.add(path)
      else if (sameBytes(a, b)) continue
      modified.add(path)
    }
    return { modified, added, removed }
  }

  /** @internal An outstanding merge, while its markers are still in the
   *  tree: resolving them one at a time shows progress, and it ends
   *  when the last goes. */
  async mergeContext(state: GitState): Promise<{ source: string | null; unresolved: string[] }> {
    if (state.unresolved.length === 0) return { source: null, unresolved: [] }
    const live = await contents(this.#host.view().reader, state.unresolved)
    const unresolved = state.unresolved.filter((p) => hasMarkers(live.get(p)))
    return unresolved.length === 0
      ? { source: null, unresolved: [] }
      : { source: state.mergeSource, unresolved }
  }

  /** Staged and unstaged paths against the agent's head, and an
   *  outstanding merge. A pure read. */
  async status(): Promise<GitStatus> {
    const state = await this.#state()
    const { modified, added, removed } = await this.changes(state)
    const staged = new Set(state.staged)
    const merge = await this.mergeContext(state)
    const sorted = (s: Iterable<string>) => [...s].sort()
    return {
      branch: this.#host.session,
      staged: sorted([...modified].filter((p) => staged.has(p))),
      unstaged: sorted([...modified].filter((p) => !staged.has(p))),
      added: sorted(added),
      removed: sorted(removed),
      mergeSource: merge.source,
      mergeUnresolved: merge.unresolved,
    }
  }

  // ---------- the index ----------

  /** Add paths to the index; returns those that weren't in it. Staging
   *  is bookkeeping alone: nothing commits, and what autocommit does is
   *  unchanged. A path must name a file in the tree or at the agent's
   *  head (so a deletion can be staged). */
  async stage(paths: Iterable<string>): Promise<string[]> {
    return this.#host.run('ws-git stage', async (wt) => {
      const wanted = this.#paths(paths)
      if (wanted.length === 0) return []
      const state = await this.#state(wt)
      await this.#checkPaths(wanted, state)
      const staged = new Set(state.staged)
      const added = wanted.filter((p) => !staged.has(p))
      if (added.length === 0) return []
      this.#write(wt, state, { ...state, staged: [...staged, ...added] })
      return added
    })
  }

  /** Take paths out of the index; returns those that were in it. */
  async unstage(paths: Iterable<string>): Promise<string[]> {
    return this.#host.run('ws-git unstage', async (wt) => {
      const wanted = this.#paths(paths)
      if (wanted.length === 0) return []
      const state = await this.#state(wt)
      await this.#checkPaths(wanted, state)
      const removed = wanted.filter((p) => state.staged.includes(p))
      if (removed.length === 0) return []
      this.#write(wt, state, { ...state, staged: state.staged.filter((p) => !removed.includes(p)) })
      return removed
    })
  }

  /** Abandon the composition: clear the index, keep the files. */
  async discard(): Promise<void> {
    await this.#host.run('ws-git reset', async (wt) => {
      const state = await this.#state(wt)
      if (state.staged.length > 0) this.#write(wt, state, { ...state, staged: [] })
    })
  }

  #paths(paths: Iterable<string>): string[] {
    const list = typeof paths === 'string' ? [paths] : [...paths]
    return [...new Set(list.map((p) => resolve(p, this.#host.root)))]
  }

  async #checkPaths(paths: string[], state: GitState): Promise<void> {
    const reader = this.#host.view().reader
    const known = new Set(
      (await reader.keys())
        .filter((k) => k.startsWith(FILE_PREFIX))
        .map((k) => k.slice(FILE_PREFIX.length)),
    )
    const ref = state.head ?? state.base
    if (ref !== null) {
      for (const p of await fileKeysAt(await this.#host.store.repo.snapshot({ commit: ref })))
        known.add(p)
    }
    for (const path of paths) {
      if (known.has(path)) continue
      if (await this.#host.fs.isDir(path)) {
        throw new WorldError(`cannot stage '${path}': stage files, not directories`)
      }
      throw new WorldError(`unknown path '${path}': no such file at HEAD or in the working tree`)
    }
  }

  /** Stage the blob, unless it would change nothing. */
  #write(wt: Worktree<unknown>, before: GitState, after: GitState, force = false): void {
    if (!force && sameState(before, after)) return
    wt.set(BLOB_KEY, encodeBlob(after))
  }

  // ---------- committing ----------

  /**
   * Record an agent commit; returns its id.
   *
   * It takes the staged paths that differ from the agent's head, or
   * every modified path when nothing is staged (as `git commit -a`).
   * Its tree is exactly that: modified paths outside the set are put
   * back to the agent's head for the commit and restored after it, in
   * a bookkeeping commit of their own. A commit that fails leaves the
   * files as they were and the index open.
   *
   * @throws WorldError when nothing differs from the agent's head.
   */
  async commit(message?: string | null, opts: { info?: CommitInfo } = {}): Promise<string> {
    return (await this.commitFiles(message, opts)).commit
  }

  /** @internal {@link commit}, and the paths it took. */
  async commitFiles(
    message?: string | null,
    opts: { info?: CommitInfo } = {},
  ): Promise<{ commit: string; files: string[] }> {
    return this.#host.run('ws-git commit', async (wt) => {
      const state = await this.#state(wt)
      const { modified } = await this.changes(state)
      if (modified.size === 0) throw new WorldError('nothing to commit')
      let files: string[]
      if (state.staged.length > 0) {
        files = [...modified].filter((p) => state.staged.includes(p)).sort()
        if (files.length === 0) {
          throw new WorldError('nothing to commit (the staged paths match the last commit)')
        }
      } else {
        files = [...modified].sort()
      }
      const reverted = [...modified].filter((p) => !files.includes(p)).sort()

      const repo = this.#host.store.repo
      const restoreFrom = state.head ?? state.base
      const baseSnap = restoreFrom === null ? null : await repo.snapshot({ commit: restoreFrom })
      const live = await contents(wt, [...files, ...reverted, ...state.unresolved])
      const base = await contents(baseSnap, [...reverted, ...state.unresolved])
      // What the tree holds for the paths left out, to hold again after.
      const pending = new Map(reverted.map((p) => [p, live.get(p)] as const))

      const fs = this.#host.fs
      const landed: GitState = {
        ...state,
        staged: [],
        unresolved: state.unresolved.filter((p) =>
          hasMarkers(files.includes(p) ? live.get(p) : base.get(p)),
        ),
      }
      if (landed.unresolved.length === 0) {
        landed.mergeSource = null
        landed.preMerge = null
      }
      const info: CommitInfo = {
        ...(opts.info ?? {}),
        tool: TOOL,
        ...(message !== undefined && message !== null && { message }),
        files,
        virtualParents: state.head === null ? [] : [state.head],
      }
      let commit: string
      try {
        for (const path of reverted) {
          const was = base.get(path)
          if (was !== undefined) await put(fs, path, was)
          else if (live.has(path)) await fs.remove(path)
        }
        // Written again so the commit takes each one, row and all, even
        // where a framework commit already holds it.
        for (const path of files) {
          const value = live.get(path)
          if (value !== undefined) await put(fs, path, value)
        }
        this.#write(wt, state, landed, true)
        const keys = [
          ...[...files, ...reverted].flatMap(keysOf),
          ...pendingDirs(wt, files),
          BLOB_KEY,
        ]
        commit = (await wt.commit({ keys, info })).commit as string
      } catch (e) {
        await restore(fs, wt, pending)
        this.#write(wt, landed, state, true)
        throw e
      }
      await restore(fs, wt, pending)
      await this.#record(wt, {
        info: { tool: RESTORE_TOOL, restoreOf: commit },
        keys: [...reverted.flatMap(keysOf), BLOB_KEY],
        state: { ...landed, head: commit },
        pending,
        landed: commit,
      })
      return { commit, files }
    })
  }

  /**
   * Commit the fiction's bookkeeping, reconciling once: the blob and the
   * files the verb left, keyed so nothing else rides along. If the
   * commit is refused (another writer of the session), take the head
   * that won, put this verb's files and blob back on it, and try again.
   */
  async #record(
    wt: Worktree<unknown>,
    opts: {
      info: CommitInfo
      keys: string[]
      state: GitState
      pending: ReadonlyMap<string, unknown>
      landed?: string
      noun?: string
      recovery?: string
    },
  ): Promise<void> {
    const keys = [...opts.keys, ...pendingDirs(wt, [...opts.pending.keys()])]
    wt.set(BLOB_KEY, encodeBlob(opts.state))
    try {
      await wt.commit({ keys, info: opts.info })
      return
    } catch {
      // reconciled below
    }
    try {
      await wt.refresh()
      await restore(this.#host.fs, wt, opts.pending)
      wt.set(BLOB_KEY, encodeBlob(opts.state))
      await wt.commit({ keys, info: opts.info })
    } catch (e) {
      if (opts.landed === undefined) throw e
      try {
        wt.set(
          BLOB_KEY,
          encodeBlob(
            parseBlob(
              await (await this.#host.store.repo.snapshot({ commit: wt.head })).get(BLOB_KEY),
            ),
          ),
        )
      } catch {
        // the first failure is the news
      }
      throw new BookkeepingLostError(
        `${opts.noun ?? 'commit'} ${opts.landed} landed but its record did not (${
          e instanceof Error ? e.message : String(e)
        }): this session's ws-git head is still the commit before it. ${
          opts.recovery ?? 'Run the verb again.'
        }`,
        { cause: e },
      )
    } finally {
      await this.#host.moved()
    }
  }

  // ---------- history ----------

  /** The agent's own commits, newest first: its graph from its head,
   *  never the framework's commits between. */
  async log(opts: { limit?: number } = {}): Promise<Commit[]> {
    if (opts.limit !== undefined && opts.limit <= 0) return []
    const out: Commit[] = []
    let wanted = (await this.#state()).head
    const repo = this.#host.store.repo
    while (wanted !== null) {
      const commit = await repo.getCommit(wanted)
      if (isAgentCommit(commit.info)) {
        out.push(commit)
        if (opts.limit !== undefined && out.length >= opts.limit) break
      }
      wanted = virtualParents(commit.info)[0] ?? null
    }
    return out
  }

  /**
   * A ref the agent typed, as one of its own commits: `HEAD`, a tag of
   * its own, or a commit id (seven characters or more) in its log or,
   * failing that, the session's history. A commit of the session that
   * isn't the agent's is refused by name.
   */
  async resolve(ref: string): Promise<string> {
    const state = await this.#state()
    if (ref === 'HEAD') {
      if (state.head === null)
        throw new WorldError('HEAD is unborn: this session has no ws-git commits')
      return state.head
    }
    const tagged = state.tags[ref]
    if (tagged !== undefined) return tagged
    if (!HASH_RE.test(ref)) {
      throw new WorldError(
        `'${ref}' is not a commit: sessions are branches, and a branch does not switch here. Name a commit from ws-git log, or a tag from ws-git tag.`,
      )
    }
    const mine = (await this.log()).map((c) => c.hash)
    const found = expand(ref, mine, "in this session's ws-git log")
    if (found !== null) return found
    // The session's own line (first parents: not what a merge brought
    // in), back to where a fork started: before that, the parent's.
    const history: Commit[] = []
    const line = this.#host.store.repo.log(
      { commit: this.#host.view().head },
      { firstParent: true },
    )
    for await (const c of line) {
      if (c.hash === ROOT_COMMIT || c.hash === state.base) break
      history.push(c)
    }
    const hash = expand(
      ref,
      history.map((c) => c.hash),
      `on session '${this.#host.session}'`,
    )
    const entry = history.find((c) => c.hash === hash)
    if (entry === undefined)
      throw new UnknownRefError(ref, `names no commit of session '${this.#host.session}'`)
    if (isAgentCommit(entry.info)) return entry.hash
    throw new WorldError(notYours(entry.hash))
  }

  // ---------- tags ----------

  /** @internal The bookmark table, read. */
  async tagTable(): Promise<Record<string, string>> {
    return { ...(await this.#state()).tags }
  }

  /** @internal Set or drop one bookmark, inside a call. */
  async setTag(name: string, commit: string | null, force: boolean): Promise<string> {
    return this.#host.run('ws-git tag', async (wt) => {
      const state = await this.#state(wt)
      const tags = { ...state.tags }
      const had = tags[name]
      if (commit === null) {
        if (had === undefined) throw new WorldError(`tag '${name}' not found`)
        delete tags[name]
      } else {
        if (had !== undefined && !force) {
          throw new WorldError(`tag '${name}' already exists: ws-git tag -f ${name} moves it.`)
        }
        tags[name] = commit
      }
      this.#write(wt, state, { ...state, tags })
      return commit ?? (had as string)
    })
  }

  // ---------- checkout ----------

  /**
   * Put the files back as they were at one of the agent's commits and
   * move its head there; returns the commit. The session doesn't
   * rewind: the restore lands as a new commit. The index is cleared.
   */
  async checkout(commit: string): Promise<string> {
    const target = await this.resolve(commit)
    return this.#host.run('ws-git checkout', (wt) => this.checkoutIn(wt, target))
  }

  /** @internal {@link checkout} inside a call of the workspace. */
  async checkoutIn(wt: Worktree<unknown>, commit: string): Promise<string> {
    const repo = this.#host.store.repo
    const entry = await repo.getCommit(commit)
    if (!isAgentCommit(entry.info)) throw new WorldError(notYours(commit))
    const state = await this.#state(wt)
    const { added, modified } = await this.changes({ ...state, head: commit })
    const gone = [...added].sort()
    const changed = [...modified].filter((p) => !added.has(p)).sort()
    const live = await contents(wt, [...gone, ...changed])
    const pending = new Map([...gone, ...changed].map((p) => [p, live.get(p)] as const))
    const targetTree = await repo.snapshot({ commit })
    const target = await contents(targetTree, changed)
    const fs = this.#host.fs
    const next: GitState = {
      ...state,
      head: commit,
      staged: [],
      mergeSource: null,
      unresolved: [],
      preMerge: null,
    }
    try {
      for (const path of gone) await fs.remove(path)
      await pruneDirs(fs, gone, targetTree)
      for (const path of changed) {
        const value = target.get(path)
        if (value === undefined) await fs.remove(path)
        else await put(fs, path, value)
      }
      await this.#record(wt, {
        info: { tool: CHECKOUT_TOOL, restoreOf: commit },
        keys: [...pending.keys()].flatMap(keysOf).concat(BLOB_KEY),
        state: next,
        pending: new Map([...pending.keys()].map((p) => [p, target.get(p)] as const)),
      })
    } catch (e) {
      await restore(fs, wt, pending)
      this.#write(wt, next, state, true)
      throw e
    }
    return commit
  }

  // ---------- merges ----------

  /** @internal What a merge of `source` reads, at its head `at`: the
   *  commit to merge (its agent's last, or its head when it never used
   *  ws-git), and what it has past that commit or still marked. */
  async sourceState(source: string, at: string) {
    const repo = this.#host.store.repo
    const snapshot = await repo.snapshot({ commit: at })
    const state = parseBlob(await snapshot.get(BLOB_KEY))
    const commit = state.head ?? at
    let uncommitted: string[] = []
    if (state.head !== null && state.head !== at) {
      const d = await repo.diff(state.head, at)
      uncommitted = [...d.added, ...d.removed, ...d.modified]
        .filter((k) => k.startsWith(FILE_PREFIX))
        .map((k) => k.slice(FILE_PREFIX.length))
        .sort()
    }
    let marked: string[] = []
    if (state.unresolved.length > 0) {
      const taken = await contents(await repo.snapshot({ commit }), state.unresolved)
      marked = state.unresolved.filter((p) => hasMarkers(taken.get(p)))
    }
    return {
      commit,
      began: state.base,
      uncommitted,
      mergeSource: marked.length > 0 ? state.mergeSource : null,
      marked,
    }
  }

  /** @internal Take a landed merge, revert or cherry-pick into the
   *  agent's graph: it becomes the head, and the paths it left marked
   *  become the outstanding merge. Commits itself. */
  async recordMerge(
    wt: Worktree<unknown>,
    source: string,
    commit: string,
    conflicts: readonly string[],
    fixes: ReadonlyMap<string, unknown> = new Map(),
  ): Promise<void> {
    const state = await this.#state(wt)
    const marked = [...conflicts].sort()
    for (const [key, value] of fixes) wt.set(key, value)
    await this.#record(wt, {
      info: { tool: MERGE_RECORD_TOOL, source, merge: commit },
      keys: [...fixes.keys(), BLOB_KEY],
      state: {
        ...state,
        head: commit,
        mergeSource: marked.length > 0 ? source : null,
        unresolved: marked,
        preMerge: marked.length > 0 ? state.head : null,
      },
      pending: new Map(),
      landed: commit,
      noun: 'merge',
      recovery: `The merge itself is in the session, markers and all: ws.index.checkout('${commit}') makes it this session's ws-git head again. It doesn't bring the merge context back, so check the files it touched for conflict markers.`,
    })
  }

  /** Undo an outstanding merge: the files and the agent's head go back
   *  to where the merge landed, as a new commit, and the merge stays in
   *  the session's history. Returns the merge's source and the commit
   *  gone back to. */
  async abortMerge(): Promise<{ source: string; commit: string }> {
    return this.#host.run('ws-git merge --abort', async (wt) => {
      const state = await this.#state(wt)
      const { source } = await this.mergeContext(state)
      if (source === null) {
        throw new WorldError(
          'no merge to abort: nothing is outstanding here. A merge that conflicts stays outstanding until its markers are gone; start one with ws-git merge <session>.',
        )
      }
      if (state.preMerge === null) {
        throw new WorldError(
          `cannot abort the merge of ${source}: it landed on a session with no ws-git commit of its own, so there is no commit of yours to go back to. Edit the marked files and commit (ws-git status shows them as UU).`,
        )
      }
      return { source, commit: await this.checkoutIn(wt, state.preMerge) }
    })
  }

  /** @internal Refuse a verb that would commit over work the agent
   *  hasn't committed (or, before its first commit, an open index). */
  async requireClean(verb: string): Promise<void> {
    const state = await this.#state()
    const status = await this.status()
    if (status.staged.length === 0 && (state.head === null || status.unstaged.length === 0)) return
    const drop = state.head !== null ? `ws-git checkout ${state.head.slice(0, 7)}` : 'ws-git reset'
    throw new WorldError(
      `uncommitted ws-git work on this session: ${status.staged.length + status.unstaged.length} path(s) differ from your last ws-git commit, and a ${verb} takes only what has been committed. Land it (ws-git commit -m ...) or drop it (${drop}), then ${verb}.`,
    )
  }

  /** @internal Refuse a verb that moves the tree while a merge is
   *  outstanding: nothing else moves it until the markers are gone. */
  async requireUnmerged(verb: string): Promise<void> {
    const { source, unresolved } = await this.mergeContext(await this.#state())
    if (source === null) return
    throw new WorldError(
      `an unresolved merge from ${source} is outstanding: ${unresolved.length} path(s) still carry conflict markers, and nothing else moves this tree until they are gone. Fix them and commit (ws-git commit -m ...), or drop the merge (ws-git merge --abort), then ${verb}.`,
    )
  }
}

/**
 * `ws.index.tags`: the names the agent gives its own commits. A name
 * in the agent's blob: it belongs to this session, a fork starts
 * without it and a merge doesn't bring it, and it pins nothing (the
 * session's history reaches every commit the agent made).
 */
export class WorkspaceIndexTags {
  readonly #index: WorkspaceIndex

  /** @internal Made by the index. */
  constructor(index: WorkspaceIndex) {
    this.#index = index
  }

  /** Bookmark one of the agent's commits (any ref it can type; its
   *  head by default); returns the commit. A taken name is refused
   *  unless `force` moves it. */
  async add(name: string, opts: { at?: string; force?: boolean } = {}): Promise<string> {
    checkTagName(name)
    const commit = await this.#index.resolve(opts.at ?? 'HEAD')
    return this.#index.setTag(name, commit, opts.force === true)
  }

  /** The bookmarks, name → commit. */
  list(): Promise<Record<string, string>> {
    return this.#index.tagTable()
  }

  /** The commit a bookmark names, or undefined. */
  async get(name: string): Promise<string | undefined> {
    return (await this.#index.tagTable())[name]
  }

  /** Drop a bookmark; returns the commit it named, which stays. */
  delete(name: string): Promise<string> {
    return this.#index.setTag(name, null, false)
  }
}

function notYours(commit: string): string {
  return `${commit.slice(0, 7)} is a commit of this session but not one of yours (ws-git log lists yours): moving the whole session to any commit in its history is the host's to invoke: ws.checkout(<id>).`
}

/** The one commit `prefix` names among `hashes`; null for none; an
 *  error for several. */
function expand(prefix: string, hashes: readonly string[], where: string): string | null {
  const found = [...new Set(hashes.filter((h) => h.startsWith(prefix)))]
  if (found.length > 1) throw new UnknownRefError(prefix, `names several commits ${where}`)
  return found[0] ?? null
}

/** Write stored content back into the tree, through the filesystem so
 *  its record says what the commit will hold. */
async function put(fs: WorldFS, path: string, value: unknown): Promise<void> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value))
  // A file where a directory was (emptied by now), or under a path
  // that is a file: what's in the way goes.
  if (await fs.isDir(path)) await fs.rmdir(path)
  for (let dir = dirname(path); dir !== '/'; dir = dirname(dir)) {
    if (await fs.isFile(dir)) {
      await fs.remove(dir)
      break
    }
  }
  const parent = dirname(path)
  if (parent !== '/' && !(await fs.isDir(parent))) await fs.mkdir(parent, { parents: true })
  await fs.write(path, bytes)
}

/** Remove the directories removing `paths` left empty, where `tree`
 *  has none: a checkout leaves the directories its target has. */
async function pruneDirs(
  fs: WorldFS,
  paths: readonly string[],
  tree: Snapshot<unknown>,
): Promise<void> {
  const dirs = new Set<string>()
  for (const path of paths) {
    for (let dir = dirname(path); dir !== '/'; dir = dirname(dir)) dirs.add(dir)
  }
  const deepest = [...dirs].sort((a, b) => b.length - a.length)
  const kept = await tree.getMany(deepest.map(metaKey))
  for (const dir of deepest) {
    if (kept.has(metaKey(dir)) || !(await fs.isDir(dir))) continue
    if ((await fs.list(dir)).length === 0) await fs.rmdir(dir)
  }
}

/** Put captured content back, path by path; undefined means the path
 *  wasn't there, so it goes again. */
async function restore(
  fs: WorldFS,
  wt: Worktree<unknown>,
  pending: ReadonlyMap<string, unknown>,
): Promise<void> {
  for (const [path, value] of pending) {
    if (value === undefined) {
      if ((await wt.get(fileKey(path))) !== undefined) await fs.remove(path)
    } else {
      await put(fs, path, value)
    }
  }
}

/** The pending records of `paths`' directories, which a keyed commit of
 *  those paths takes along so its tree describes them. */
function pendingDirs(wt: Worktree<unknown>, paths: readonly string[]): string[] {
  const status = wt.status()
  const out = new Set<string>()
  for (const path of paths) {
    for (let dir = dirname(path); dir !== '/'; dir = dirname(dir)) {
      const key = metaKey(dir)
      if (status.updated.has(key) || status.removed.has(key)) out.add(key)
    }
  }
  return [...out]
}
