import {
  type Commit,
  type CommitInfo,
  MergeConflict,
  ROOT_COMMIT,
  type Snapshot,
  TagExistsError,
  type TagInfo,
  UnknownTagError,
  type Worktree,
  cborCodec,
} from '@agex-ts/kvgit'
import { FsError } from '@agex-ts/termish'
import { WorkspaceCache } from './cache'
import {
  CommitConflictError,
  ReadOnlyError,
  SessionExistsError,
  UnknownRefError,
  WorldError,
} from './errors'
import { type KeyReader, WorldFS } from './fs'
import {
  COMPACTION_PREFIX,
  CONVERSATION_PREFIX,
  CWD_KEY,
  FILE_PREFIX,
  META_PREFIX,
  fileKey,
  metaKey,
} from './layout'
import { checkSessionName, checkTagName } from './names'
import { dirname, resolve, within } from './path'
import { Queue } from './queue'
import type { Store } from './store'

/** How a workspace is opened. */
export interface WorkspaceOptions {
  /** The directory the session's files live under, and where a new
   *  session starts. Default `/workspace`. */
  readonly root?: string
  /** Commit after every mutating call (default true). False leaves
   *  changes pending until `commit()`. */
  readonly autocommit?: boolean
  /** Whether `ws.cache` is available (default true). */
  readonly cache?: boolean
}

/** A workspace's settings, filled in; a fork's child gets its parent's. */
export interface WorkspaceSettings {
  readonly root: string
  readonly autocommit: boolean
  readonly cache: boolean
}

/** What a fork's child starts with: everything (`'full'`), or the
 *  files without the conversation and compaction's record
 *  (`'fresh'`). */
export type Inherit = 'full' | 'fresh'

export interface ForkOptions {
  /** Fork from this commit (a hash, a unique prefix of one, or a tag
   *  of this session) instead of the current one. */
  readonly at?: string
  readonly inherit?: Inherit
}

/** The files two commits differ in, as absolute paths, sorted. A file
 *  whose content is unchanged is not modified, whatever its times
 *  say; directories don't count. */
export interface WorkspaceDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly modified: readonly string[]
}

export interface WriteOutcome {
  readonly path: string
  readonly size: number
  /** The file didn't exist before. */
  readonly created: boolean
  /** The commit the write made; null with autocommit off. */
  readonly commit: string | null
}

export interface RemoveOutcome {
  readonly path: string
  readonly size: number
  /** The commit the removal made; null with autocommit off. */
  readonly commit: string | null
}

/** What the facades reach inside their workspace. */
interface Inner {
  readonly session: string
  readonly store: Store
  /** Queue `fn` as one call that changes the session. */
  run<T>(op: string, fn: (wt: Worktree<unknown>) => Promise<T>): Promise<T>
  /** Commit pending changes, if any, whatever autocommit says. */
  commitPending(info: CommitInfo): Promise<string | null>
  expand(ref: string): Promise<string>
  frozenView(commit: string): Promise<Workspace>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * One session: a branch of the store's repository, with its files, its
 * cache and its working directory, and the history of all three.
 *
 * Calls that change the session run one at a time, in the order they
 * were made, and each commits what it changed when it ends (with
 * autocommit on): `files.write` and `files.remove`, `commit`,
 * `checkout`, `fork`, the tag calls, `refresh`, `discard` and `close`.
 * Code that needs several changes to land as one call runs them
 * through {@link exclusive}. Reads, `files.fs` and `cache` don't
 * queue: what they write is pending until the next commit.
 *
 * Several workspaces may hold one session (two tabs, say). Each
 * commits on its own; one that loses a race merges onto the other's
 * commit, and throws `CommitConflictError` only when the two changed
 * something in ways no rule settles.
 *
 * A workspace opened on a commit rather than a session's tip
 * (`store.resolve`, `tags.at`) is frozen: it reads that commit, and
 * every change throws `ReadOnlyError` (`EROFS` from its filesystem).
 *
 * Open one with `store.open(session)`.
 */
export class Workspace {
  readonly store: Store
  readonly session: string
  readonly root: string
  /** Commit after every mutating call. */
  autocommit: boolean
  readonly files: WorkspaceFiles
  readonly tags: WorkspaceTags

  readonly #settings: WorkspaceSettings
  readonly #wt: Worktree<unknown> | null
  readonly #frozenAt: string | null
  readonly #fs: WorldFS
  readonly #cache: WorkspaceCache | null
  readonly #queue = new Queue()
  #closed = false

  private constructor(
    store: Store,
    session: string,
    settings: WorkspaceSettings,
    source: { wt: Worktree<unknown> } | { snapshot: Snapshot<unknown> },
  ) {
    this.store = store
    this.session = session
    this.root = settings.root
    this.autocommit = settings.autocommit
    this.#settings = settings
    const reader: KeyReader = 'wt' in source ? source.wt : source.snapshot
    this.#wt = 'wt' in source ? source.wt : null
    this.#frozenAt = 'snapshot' in source ? source.snapshot.commit : null
    const open = () => !this.#closed
    this.#fs = new WorldFS(reader, { persistCwd: true, writable: open })
    this.#cache = settings.cache ? new WorkspaceCache(reader, open) : null

    const inner: Inner = {
      session,
      store,
      run: (op, fn) => this.#run(op, fn),
      commitPending: (info) => this.#commitPending(info),
      expand: (ref) => this.#expand(ref),
      frozenView: (commit) => Workspace._frozen(store, session, settings, commit),
    }
    this.files = new WorkspaceFiles(inner, this.#fs, (info) => this.autoCommit(info))
    this.tags = new WorkspaceTags(inner)
  }

  /** @internal Opens a session's tip; used by `Store.open`. */
  static async _live(
    store: Store,
    session: string,
    settings: WorkspaceSettings,
    wt: Worktree<unknown>,
  ): Promise<Workspace> {
    const ws = new Workspace(store, session, settings, { wt })
    await ws.#init()
    return ws
  }

  /** @internal A frozen view of one commit. */
  static async _frozen(
    store: Store,
    session: string,
    settings: WorkspaceSettings,
    commit: string,
  ): Promise<Workspace> {
    const snapshot = await store.repo.snapshot({ commit })
    const ws = new Workspace(store, session, settings, { snapshot })
    await ws.#loadCwd()
    return ws
  }

  // ---------- state ----------

  /** The commit this workspace is at: the one its reads see, under any
   *  pending changes. */
  get head(): string {
    return this.#wt?.head ?? (this.#frozenAt as string)
  }

  /** `session@commit`, which `store.resolve` opens again (frozen). */
  get ref(): string {
    return `${this.session}@${this.head}`
  }

  /** A view of one commit, which can't change. */
  get frozen(): boolean {
    return this.#frozenAt !== null
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Changes are pending: written, not yet committed. */
  get uncommitted(): boolean {
    return this.#wt !== null && !this.#wt.status().clean
  }

  /** The session's settings as they are now, which a fork's child
   *  inherits. */
  get settings(): WorkspaceSettings {
    return { ...this.#settings, autocommit: this.autocommit }
  }

  /**
   * The session's cache.
   *
   * @throws WorldError if the workspace was opened with `cache: false`.
   */
  get cache(): WorkspaceCache {
    if (this.#cache === null) throw new WorldError(`session '${this.session}' has no cache`)
    return this.#cache
  }

  // ---------- one call at a time ----------

  /**
   * Run `fn` as one call: after every call queued before it, before
   * every call queued after. For a host operation made of several
   * steps whose changes must not interleave with another call's (a tool
   * call that writes, then commits with {@link autoCommit}).
   *
   * Not re-entrant: inside `fn`, use `files.fs` and `cache`, not the
   * workspace's own queued calls, which would wait for `fn` to end.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      this.#checkOpen()
      return fn()
    })
  }

  /**
   * Commit the pending changes stamped with `info`, if autocommit is on
   * and there are any; how each call ends. Returns the new commit, or
   * null if nothing was committed. Meant for a call already inside
   * {@link exclusive}.
   */
  async autoCommit(info: CommitInfo): Promise<string | null> {
    if (!this.autocommit) return null
    return this.#commitPending(info)
  }

  // ---------- versioning ----------

  /**
   * Commit the pending changes, with `info` recorded on the commit.
   * Returns the new commit, or the current one when nothing was
   * pending.
   *
   * @throws CommitConflictError if a concurrent commit conflicts.
   */
  async commit(info: CommitInfo = { tool: 'commit' }): Promise<string> {
    return this.#run('commit', async (wt) => (await this.#commitPending(info)) ?? wt.head)
  }

  /** Drop the pending changes. */
  async discard(): Promise<void> {
    await this.#run('discard', async (wt) => {
      wt.discard()
      await this.#loadCwd()
    })
  }

  /** Drop the pending changes and move to the session's latest commit,
   *  which another workspace on the session may have made. */
  async refresh(): Promise<void> {
    await this.#run('refresh', async (wt) => {
      await wt.refresh()
      await this.#loadCwd()
    })
  }

  /** The session's commits, newest first, along the line made on the
   *  session itself (first parents), back to its first. */
  async log(opts: { limit?: number } = {}): Promise<Commit[]> {
    const out: Commit[] = []
    const start = this.#wt === null ? { commit: this.head } : { branch: this.session }
    for await (const c of this.store.repo.log(start, { firstParent: true })) {
      if (c.hash === ROOT_COMMIT || out.length === opts.limit) break
      out.push(c)
    }
    return out
  }

  /** The files that differ from `a` to `b` (refs as `checkout` takes
   *  them; `b` defaults to the current commit). */
  async diff(a: string, b?: string): Promise<WorkspaceDiff> {
    const [from, to] = await Promise.all([
      this.#expand(a),
      b === undefined ? this.head : this.#expand(b),
    ])
    const d = await this.store.repo.diff(from, to)
    const paths = (keys: ReadonlySet<string>) =>
      [...keys]
        .filter((k) => k.startsWith(FILE_PREFIX))
        .map((k) => k.slice(FILE_PREFIX.length))
        .sort()
    return { added: paths(d.added), removed: paths(d.removed), modified: paths(d.modified) }
  }

  /**
   * The commit a ref names: a commit hash, a unique prefix of one (7
   * characters or more) in this session's history, or one of the
   * session's tags.
   *
   * @throws UnknownRefError if it names none, or several.
   */
  async expandRef(ref: string): Promise<string> {
    return this.#expand(ref)
  }

  /**
   * Make the session as it was at `ref`, as a new commit
   * (`{tool: 'checkout', target}`): files, cache, working directory and
   * everything else the session holds. History is kept: the commits
   * after `ref` stay in the log, and checking out one of them comes
   * back. Pending changes are dropped. Returns the commit that holds
   * the restored state; when nothing differs, the current one.
   *
   * With `paths`, only those files and directories (and everything
   * under them) are taken from `ref`, on top of the pending changes,
   * and committed: a path `ref` doesn't have is removed.
   */
  async checkout(ref: string, opts: { paths?: readonly string[] } = {}): Promise<string> {
    return this.#run('checkout', async (wt) => {
      const target = await this.#expand(ref)
      if (opts.paths !== undefined) {
        const paths = opts.paths.map((p) => resolve(p, this.root))
        return this.#take(wt, target, paths)
      }
      return this.#restore(wt, target)
    })
  }

  /**
   * A new session that starts where this one is, as a branch: O(1),
   * sharing everything stored. Pending changes are committed here
   * first (`{tool: 'fork', child, inherit}`), unless `at` names the
   * commit to fork from. Returns the child, open with this
   * workspace's settings.
   *
   * @throws SessionExistsError if a session by that name exists.
   */
  async fork(name: string, opts: ForkOptions = {}): Promise<Workspace> {
    return this.#run('fork', async (wt) => {
      checkSessionName(name)
      const inherit = opts.inherit ?? 'full'
      if (await this.store.exists(name)) throw new SessionExistsError(name)
      let at: string
      if (opts.at !== undefined) {
        at = await this.#expand(opts.at)
      } else {
        await this.#commitPending({ tool: 'fork', child: name, inherit })
        at = wt.head
      }
      try {
        await this.store.repo.branches.create(name, at)
      } catch (e) {
        if (await this.store.exists(name)) throw new SessionExistsError(name)
        throw e
      }
      const child = await this.store.open(name, this.settings)
      await child.#seedFork(this.session, inherit)
      return child
    })
  }

  /** Stop: queued calls finish first; later ones throw, and the
   *  filesystem and cache turn read-only. Pending changes are dropped. */
  async close(): Promise<void> {
    await this.#queue.run(async () => {
      this.#wt?.discard()
      this.#closed = true
    })
  }

  // ---------- internals ----------

  #checkOpen(): void {
    if (this.#closed) throw new ReadOnlyError(`workspace '${this.session}' is closed`)
  }

  #live(op: string): Worktree<unknown> {
    this.#checkOpen()
    if (this.#wt === null) {
      throw new ReadOnlyError(
        `${op}: this workspace is a frozen view of commit ${this.#frozenAt as string}`,
      )
    }
    return this.#wt
  }

  #run<T>(op: string, fn: (wt: Worktree<unknown>) => Promise<T>): Promise<T> {
    return this.#queue.run(() => fn(this.#live(op)))
  }

  async #commitPending(info: CommitInfo): Promise<string | null> {
    const wt = this.#live('commit')
    if (wt.status().clean) return null
    try {
      return (await wt.commit({ info })).commit
    } catch (e) {
      if (e instanceof MergeConflict)
        throw new CommitConflictError(this.session, e.keys, { cause: e })
      throw e
    }
  }

  async #init(): Promise<void> {
    const wt = this.#wt as Worktree<unknown>
    if (!(await this.#fs.isDir(this.root))) await this.#fs.mkdir(this.root, { parents: true })
    if (!(await this.#loadCwd())) await this.#fs.chdir(this.root)
    if (!wt.status().clean) await this.#commitPending({ tool: 'init' })
  }

  /** Take the working directory from the session; false if it holds
   *  none usable, and the root (or `/`) was taken instead. */
  async #loadCwd(): Promise<boolean> {
    const reader = this.#wt ?? null
    const stored = reader === null ? await this.#frozenCwd() : await reader.get(CWD_KEY)
    if (typeof stored === 'string' && (await this.#fs.isDir(stored))) {
      this.#fs.resetCwd(stored)
      return true
    }
    this.#fs.resetCwd((await this.#fs.isDir(this.root)) ? this.root : '/')
    return false
  }

  async #frozenCwd(): Promise<unknown> {
    const snapshot = await this.store.repo.snapshot({ commit: this.#frozenAt as string })
    return snapshot.get(CWD_KEY)
  }

  async #expand(ref: string): Promise<string> {
    const repo = this.store.repo
    if (ref !== '' && !ref.startsWith('@') && !ref.includes('%')) {
      const tag = `${this.session}/${ref}`
      if (await repo.tags.has(tag)) return repo.tags.get(tag)
    }
    if (/^[0-9a-f]{7,}$/.test(ref)) {
      const start = this.#wt === null ? { commit: this.head } : { branch: this.session }
      const matches: string[] = []
      for await (const c of repo.log(start)) {
        if (c.hash === ref) return ref
        if (c.hash.startsWith(ref)) matches.push(c.hash)
      }
      if (matches.length === 1) return matches[0] as string
      if (matches.length > 1) throw new UnknownRefError(ref, 'names several commits')
    }
    throw new UnknownRefError(ref)
  }

  async #restore(wt: Worktree<unknown>, target: string): Promise<string> {
    const repo = this.store.repo
    const info = { tool: 'checkout', target }
    // Another workspace's commit can land between the diff and ours,
    // and merge into the restore; diff again until nothing differs.
    for (let attempt = 0; attempt < 5; attempt++) {
      await wt.refresh()
      const d = await repo.diff(wt.head, target)
      const differing = [...d.added, ...d.removed, ...d.modified]
      if (differing.length === 0) {
        await this.#loadCwd()
        return wt.head
      }
      const values = await (await repo.snapshot({ commit: target })).getMany(differing)
      for (const key of differing) {
        const value = values.get(key)
        if (value === undefined) await wt.delete(key)
        else wt.set(key, value)
      }
      try {
        const result = await wt.commit({ info })
        if (result.strategy !== 'three_way') {
          await this.#loadCwd()
          return result.commit as string
        }
      } catch (e) {
        if (!(e instanceof MergeConflict)) throw e
      }
    }
    await wt.refresh()
    await this.#loadCwd()
    throw new WorldError(`checkout of ${target}: other commits kept landing; try again`)
  }

  async #take(wt: Worktree<unknown>, target: string, paths: readonly string[]): Promise<string> {
    const snapshot = await this.store.repo.snapshot({ commit: target })
    const under = (key: string): boolean => {
      const path = key.startsWith(FILE_PREFIX)
        ? key.slice(FILE_PREFIX.length)
        : key.startsWith(META_PREFIX)
          ? key.slice(META_PREFIX.length)
          : null
      return path !== null && paths.some((p) => within(path, p))
    }
    const keys = new Set([...(await wt.keys()), ...(await snapshot.keys())].filter(under))
    // A taken path's directories come along when this side lacks them.
    for (const p of paths) {
      for (let dir = dirname(p); dir !== '/'; dir = dirname(dir)) keys.add(metaKey(dir))
    }
    const [ours, theirs] = await Promise.all([wt.getMany(keys), snapshot.getMany(keys)])
    for (const key of keys) {
      const want = theirs.get(key)
      const have = ours.get(key)
      if (want === undefined) {
        if (have !== undefined && under(key)) await wt.delete(key)
      } else if (have === undefined || (under(key) && !sameValue(have, want))) {
        wt.set(key, want)
      }
    }
    const commit = await this.#commitPending({ tool: 'checkout', target, paths: [...paths] })
    await this.#loadCwd()
    return commit ?? wt.head
  }

  async #seedFork(parent: string, inherit: Inherit): Promise<void> {
    await this.#run('fork', async (wt) => {
      if (inherit === 'fresh') {
        for (const key of await wt.keys()) {
          if (key.startsWith(CONVERSATION_PREFIX) || key.startsWith(COMPACTION_PREFIX)) {
            await wt.delete(key)
          }
        }
      }
      await this.#commitPending({ tool: 'fork', parent, inherit })
    })
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  const x = cborCodec.encode(a)
  const y = cborCodec.encode(b)
  return x.byteLength === y.byteLength && x.every((byte, i) => byte === y[i])
}

/**
 * A workspace's files. Reads go straight to the session; `write` and
 * `remove` are calls of their own, each committed (`file_write`,
 * `file_remove`) with autocommit on. {@link fs} is the whole
 * filesystem, for the shell and the kernel: its writes stay pending
 * until something commits.
 */
export class WorkspaceFiles {
  readonly #inner: Inner
  readonly #fs: WorldFS
  readonly #autoCommit: (info: CommitInfo) => Promise<string | null>

  /** @internal Made by the workspace. */
  constructor(inner: Inner, fs: WorldFS, autoCommit: (info: CommitInfo) => Promise<string | null>) {
    this.#inner = inner
    this.#fs = fs
    this.#autoCommit = autoCommit
  }

  /** The session's filesystem, with its working directory. */
  get fs(): WorldFS {
    return this.#fs
  }

  /** A file's bytes, or `size` bytes of it from `offset`. */
  async read(path: string, opts: { offset?: number; size?: number } = {}): Promise<Uint8Array> {
    const bytes = await this.#fs.read(path)
    const start = opts.offset ?? 0
    return opts.size === undefined ? bytes.slice(start) : bytes.slice(start, start + opts.size)
  }

  /** A file as UTF-8 text. */
  async readText(path: string): Promise<string> {
    return dec.decode(await this.#fs.read(path))
  }

  async exists(path: string): Promise<boolean> {
    return this.#fs.exists(path)
  }

  /** A directory's entries (names, or with `recursive` paths relative
   *  to it), sorted. */
  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    return this.#fs.list(path, opts)
  }

  /** Write a file, creating its directories and replacing what was
   *  there. Committed as `{tool: 'file_write'}`. */
  async write(path: string, content: string | Uint8Array): Promise<WriteOutcome> {
    const data = typeof content === 'string' ? enc.encode(content) : content
    return this.#inner.run('file_write', async () => {
      const created = !(await this.#fs.exists(path))
      const parent = dirname(resolve(path, this.#fs.getcwd()))
      if (parent !== '/') await this.#fs.mkdir(parent, { parents: true, existOk: true })
      await this.#fs.write(path, data)
      return {
        path,
        size: data.byteLength,
        created,
        commit: await this.#autoCommit({ tool: 'file_write' }),
      }
    })
  }

  /**
   * Remove one file. Committed as `{tool: 'file_remove'}`.
   *
   * @throws FsError `EISDIR` for a directory (`rm -r` in the terminal,
   *   or `checkout(ref, {paths})`, empties one), `ENOENT` for nothing.
   */
  async remove(path: string): Promise<RemoveOutcome> {
    return this.#inner.run('file_remove', async () => {
      const stat = await this.#fs.stat(path)
      if (stat.isDir) throw new FsError('EISDIR', path)
      await this.#fs.remove(path)
      return { path, size: stat.size, commit: await this.#autoCommit({ tool: 'file_remove' }) }
    })
  }
}

/**
 * A session's tags: names for its commits, kept as the repository tag
 * `<session>/<name>`. Tags never move, and keep what they name from
 * garbage collection.
 */
export class WorkspaceTags {
  readonly #inner: Inner

  /** @internal Made by the workspace. */
  constructor(inner: Inner) {
    this.#inner = inner
  }

  /**
   * Tag a commit (default: the current one, committing pending changes
   * first as `{tool: 'tag', name}`). Returns the commit tagged.
   *
   * @throws TagExistsError if the session has a tag by that name.
   */
  async add(name: string, opts: { at?: string; info?: CommitInfo } = {}): Promise<string> {
    checkTagName(name)
    return this.#inner.run('tag', async (wt) => {
      const stored = this.#stored(name)
      const repo = this.#inner.store.repo
      if (await repo.tags.has(stored)) throw new TagExistsError(name)
      let target: string
      if (opts.at !== undefined) {
        target = await this.#inner.expand(opts.at)
      } else {
        await this.#inner.commitPending({ tool: 'tag', name })
        target = wt.head
      }
      await repo.tags.create(stored, target, opts.info === undefined ? {} : { info: opts.info })
      return target
    })
  }

  /** Every tag of the session: name → commit. */
  async list(): Promise<Map<string, string>> {
    const prefix = this.#stored('')
    const out = new Map<string, string>()
    for (const [name, commit] of await this.#inner.store.repo.tags.entries()) {
      if (name.startsWith(prefix)) out.set(name.slice(prefix.length), commit)
    }
    return out
  }

  /** A tag's commit, time and info; undefined if there's no such tag. */
  async info(name: string): Promise<TagInfo | undefined> {
    try {
      const found = await this.#inner.store.repo.tags.info(this.#stored(checkTagName(name)))
      return { ...found, name }
    } catch (e) {
      if (e instanceof UnknownTagError) return undefined
      throw e
    }
  }

  /**
   * Delete a tag, and collect what only it kept.
   *
   * @throws UnknownTagError if there's no such tag.
   */
  async delete(name: string): Promise<void> {
    checkTagName(name)
    await this.#inner.run('tag', async () => {
      await this.#inner.store.repo.tags.delete(this.#stored(name))
    })
    await this.#inner.store.repo.gc()
  }

  /**
   * A frozen workspace at a tag's commit.
   *
   * @throws UnknownTagError if there's no such tag.
   */
  async at(name: string): Promise<Workspace> {
    const commit = await this.#inner.store.repo.tags.get(this.#stored(checkTagName(name)))
    return this.#inner.frozenView(commit)
  }

  #stored(name: string): string {
    return `${this.#inner.session}/${name}`
  }
}
