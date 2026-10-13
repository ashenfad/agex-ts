import {
  type CommitInfo,
  type KVStore,
  Repo,
  TagExistsError,
  type TagInfo,
  UnknownTagError,
} from '@agex-ts/kvgit'
import { UnknownSessionError } from './errors'
import { WORLD_MERGE_FNS, WORLD_MERGE_PREFIXES } from './layout'
import {
  STORE_TAG_SCOPE,
  checkSessionName,
  checkStoreTagName,
  isSessionName,
  normalizeRoot,
} from './names'
import { checkProfile } from './profile'
import {
  type ForkOptions,
  Workspace,
  type WorkspaceOptions,
  type WorkspaceSettings,
} from './workspace'

export interface StoreOptions {
  /** The clock commits and tags are stamped with, in seconds. Default:
   *  wall time. */
  readonly now?: () => number
}

/** How long, in seconds, deleting or cleaning leaves unreachable
 *  commits alone: work another writer may still be landing. */
export const DEFAULT_MIN_AGE = 3600

/**
 * Every session of a world, in one kvgit repository on one `KVStore`
 * (memory, IndexedDB, SQLite): each session is a branch, named by its
 * id. A session exists exactly when its branch does.
 *
 * Open one with {@link Store.open}, then a session with `store.open(id)`.
 */
export class Store {
  readonly repo: Repo<unknown>
  /** Tags of the store as a whole, kept as `@store/<name>`. */
  readonly tags: StoreTags

  private constructor(repo: Repo<unknown>) {
    this.repo = repo
    this.tags = new StoreTags(this)
  }

  static async open(kv: KVStore, opts: StoreOptions = {}): Promise<Store> {
    const repo = await Repo.open<unknown>(kv, {
      codec: 'cbor',
      mergeFns: WORLD_MERGE_FNS,
      mergePrefixes: WORLD_MERGE_PREFIXES,
      ...(opts.now !== undefined && { now: opts.now }),
    })
    return new Store(repo)
  }

  /**
   * Open a session, creating it if it doesn't exist. A new session
   * starts with its root directory and its working directory there,
   * committed as `{tool: 'init'}`.
   */
  async open(session: string, opts: WorkspaceOptions = {}): Promise<Workspace> {
    checkSessionName(session)
    const settings: WorkspaceSettings = {
      root: normalizeRoot(opts.root ?? '/workspace'),
      autocommit: opts.autocommit ?? true,
      cache: opts.cache ?? true,
      profile: checkProfile(opts.profile ?? {}),
    }
    const wt = await this.repo.worktree(session, { create: true })
    return Workspace._live(this, session, settings, wt)
  }

  /** Every session's id, sorted. */
  async sessions(): Promise<string[]> {
    return (await this.repo.branches.list()).filter(isSessionName).sort()
  }

  async exists(session: string): Promise<boolean> {
    return isSessionName(session) && this.repo.branches.has(session)
  }

  /**
   * Delete sessions with their tags, then collect what nothing else
   * keeps. A workspace still open on a deleted session fails its next
   * commit.
   *
   * @param opts.minAge Commits younger than this many seconds stay
   *   (default an hour).
   * @throws UnknownSessionError if one doesn't exist; nothing is
   *   deleted then.
   */
  async delete(sessions: string | Iterable<string>, opts: { minAge?: number } = {}): Promise<void> {
    const names = typeof sessions === 'string' ? [sessions] : [...sessions]
    for (const name of names) {
      if (!(await this.exists(name))) throw new UnknownSessionError(name)
    }
    const tags = await this.repo.tags.list()
    for (const name of names) {
      for (const tag of tags) if (tag.startsWith(`${name}/`)) await this.repo.tags.delete(tag)
      await this.repo.branches.delete(name)
    }
    await this.repo.gc({ minAge: opts.minAge ?? DEFAULT_MIN_AGE })
  }

  /** Collect what no session or tag keeps; returns how many commits
   *  went. */
  async clean(opts: { minAge?: number } = {}): Promise<number> {
    return this.repo.gc({ minAge: opts.minAge ?? DEFAULT_MIN_AGE })
  }

  /** Fork session `src` as `dst` and return `dst`, open with `opts`. */
  async fork(
    src: string,
    dst: string,
    opts: ForkOptions & WorkspaceOptions = {},
  ): Promise<Workspace> {
    if (!(await this.exists(src))) throw new UnknownSessionError(src)
    const { at, inherit, ...settings } = opts
    const parent = await this.open(src, settings)
    try {
      return await parent.fork(dst, {
        ...(at !== undefined && { at }),
        ...(inherit !== undefined && { inherit }),
      })
    } finally {
      await parent.close()
    }
  }

  /**
   * A frozen workspace at `session@ref` (a commit, a unique prefix of
   * one, or a tag of the session), or at a session's latest commit
   * given just its id.
   *
   * @throws UnknownSessionError if there's no such session.
   * @throws UnknownRefError if `ref` names no commit of it.
   */
  async resolve(ref: string, opts: WorkspaceOptions = {}): Promise<Workspace> {
    const at = ref.lastIndexOf('@')
    const session = at > 0 ? ref.slice(0, at) : ref
    const rest = at > 0 ? ref.slice(at + 1) : null
    checkSessionName(session)
    const settings = this.#frozenSettings(opts)
    if (!(await this.exists(session))) {
      // A deleted session's commit can live on, kept by a tag: its
      // full hash still opens it.
      if (rest !== null && (await this.#hasCommit(rest))) {
        return Workspace._frozen(this, session, settings, rest)
      }
      throw new UnknownSessionError(session)
    }
    const tip = await Workspace._frozen(
      this,
      session,
      settings,
      await this.repo.branches.get(session),
    )
    if (rest === null) return tip
    return Workspace._frozen(this, session, settings, await tip.expandRef(rest))
  }

  /** @internal */
  _frozenView(label: string, commit: string, opts: WorkspaceOptions = {}): Promise<Workspace> {
    return Workspace._frozen(this, label, this.#frozenSettings(opts), commit)
  }

  #frozenSettings(opts: WorkspaceOptions): WorkspaceSettings {
    return {
      root: normalizeRoot(opts.root ?? '/workspace'),
      autocommit: false,
      cache: opts.cache ?? true,
      profile: checkProfile(opts.profile ?? {}),
    }
  }

  async #hasCommit(commit: string): Promise<boolean> {
    if (!/^[0-9a-f]+$/.test(commit)) return false
    try {
      await this.repo.getCommit(commit)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Tags of the store as a whole: names for commits of any session,
 * outliving the session (a release, a publication). Kept as the
 * repository tag `@store/<name>`; they never move.
 */
export class StoreTags {
  readonly #store: Store

  /** @internal Made by the store. */
  constructor(store: Store) {
    this.#store = store
  }

  /**
   * Tag a workspace's current commit, or the commit a ref names
   * (`session@ref`, or a session id for its latest commit). Returns
   * the commit tagged.
   *
   * @throws TagExistsError if the store has a tag by that name.
   */
  async add(
    source: Workspace | string,
    name: string,
    opts: { info?: CommitInfo } = {},
  ): Promise<string> {
    checkStoreTagName(name)
    const repo = this.#store.repo
    if (await repo.tags.has(STORE_TAG_SCOPE + name)) throw new TagExistsError(name)
    let commit: string
    if (typeof source === 'string') {
      const view = await this.#store.resolve(source)
      commit = view.head
      await view.close()
    } else {
      commit = source.head
    }
    await repo.tags.create(STORE_TAG_SCOPE + name, commit, opts.info === undefined ? {} : opts)
    return commit
  }

  /** Every store tag: name → commit. */
  async list(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const [name, commit] of await this.#store.repo.tags.entries()) {
      if (name.startsWith(STORE_TAG_SCOPE)) out.set(name.slice(STORE_TAG_SCOPE.length), commit)
    }
    return out
  }

  /** A tag's commit, time and info; undefined if there's no such tag. */
  async info(name: string): Promise<TagInfo | undefined> {
    try {
      const found = await this.#store.repo.tags.info(STORE_TAG_SCOPE + checkStoreTagName(name))
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
    await this.#store.repo.tags.delete(STORE_TAG_SCOPE + checkStoreTagName(name))
    await this.#store.repo.gc()
  }

  /**
   * A frozen workspace at a tag's commit; its `session` is the tag's
   * stored name.
   *
   * @throws UnknownTagError if there's no such tag.
   */
  async at(name: string, opts: WorkspaceOptions = {}): Promise<Workspace> {
    const stored = STORE_TAG_SCOPE + checkStoreTagName(name)
    const commit = await this.#store.repo.tags.get(stored)
    return this.#store._frozenView(stored, commit, opts)
  }
}
