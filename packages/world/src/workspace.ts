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
import {
  type CommandHandler,
  FsError,
  ParseError,
  TerminalError,
  describeFsError,
  execute,
} from '@agex-ts/termish'
import {
  BLOB_KEY,
  MERGE_TOOL,
  type MergeOutcome,
  PICK_TOOL,
  REVERT_TOOL,
  WorkspaceIndex,
  forkBlob,
  isAgentCommit,
  isBookkeepingCommit,
  parseBlob,
  virtualParents,
} from './agentgit'
import { WorkspaceCache } from './cache'
import {
  WorkspaceConversation,
  readIndex,
  rebindConversation,
  reclaimConversation,
  wipeConversation,
} from './conversation'
import { EditError, type EditMode, applyEdit } from './editing'
import {
  CommitConflictError,
  ReadOnlyError,
  SessionExistsError,
  UnknownRefError,
  UnknownSessionError,
  WorldError,
} from './errors'
import { type KeyReader, WorldFS } from './fs'
import { DEFAULT_MAX_OBSERVATION, Kernel } from './kernel/kernel'
import type { Image, SerializedError } from './kernel/messages'
import {
  COMPACTION_PREFIX,
  CONVERSATION_PREFIX,
  CWD_KEY,
  FILE_PREFIX,
  META_PREFIX,
  fileKey,
  metaKey,
} from './layout'
import { staleRecords, threeWay, threeWayRules } from './merging'
import { checkSessionName, checkTagName } from './names'
import { dirname, resolve, within } from './path'
import {
  type HostCall,
  type HostEntry,
  type Profile,
  makeCommands,
  makeHostObjects,
  shellEnv,
} from './profile'
import { Queue } from './queue'
import { Secrets } from './secrets'
import type { Store } from './store'
import { Turn, TurnInProgressError, type TurnOptions, statusOf } from './turns'

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
  /** What the host grants the session: host objects, variables,
   *  secrets, and how code runs. */
  readonly profile?: Profile
}

/** A workspace's settings, filled in; a fork's child gets its parent's. */
export interface WorkspaceSettings {
  readonly root: string
  readonly autocommit: boolean
  readonly cache: boolean
  readonly profile: Profile
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

/** What `runCode` gave. */
export interface CodeResult {
  /** What `console.log` and `console.info` printed, a line per call. */
  readonly stdout: string
  /** What `console.warn` and `console.error` printed. */
  readonly stderr: string
  /** Images the code showed (`console.log` of image bytes, a data URL
   *  or `{format, data}`). */
  readonly images: readonly Image[]
  /** A top-level `return`'s value, shown as text; null for none. */
  readonly value: string | null
  /** Why the code failed: what it threw, a syntax error, a missing
   *  module, `TimeoutError`, or `CancelledError` when interrupted. */
  readonly error: SerializedError | null
  /** stdout or stderr was cut to the profile's `maxObservation`. */
  readonly truncated: boolean
  /** Seconds the run took. */
  readonly duration: number
  /** The commit holding what the code changed; null when it changed
   *  nothing, with autocommit off, or on a frozen workspace. */
  readonly commit: string | null
}

/** What `terminal` gave. */
export interface TerminalResult {
  /** What the commands printed, with the diagnostics of failures the
   *  script went on past. */
  readonly stdout: string
  /** 0 on success; the failing command's code (127 for a command not
   *  found, 2 for a script that doesn't parse, 130 when interrupted). */
  readonly exitCode: number
  /** Why the script failed; empty on success. */
  readonly stderr: string
  /** stdout or stderr was cut to the profile's `maxObservation`. */
  readonly truncated: boolean
  /** The commit holding what the commands changed; null when they
   *  changed nothing, with autocommit off, or on a frozen workspace. */
  readonly commit: string | null
}

/** What `files.edit` did. */
export interface EditOutcome {
  readonly path: string
  /** Replacements made; 0 when the replacement was already there. */
  readonly count: number
  /** How the quote matched. */
  readonly mode: EditMode
  /** The commit the edit made; null when nothing changed or autocommit
   *  is off. */
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
  /** The conversation stored in the session (see `Turn`). */
  readonly conversation: WorkspaceConversation
  /** The agent's own git over the session (see `WorkspaceIndex`). */
  readonly index: WorkspaceIndex

  readonly #settings: WorkspaceSettings
  readonly #wt: Worktree<unknown> | null
  readonly #frozenAt: string | null
  readonly #fs: WorldFS
  readonly #cache: WorkspaceCache | null
  readonly #queue = new Queue()
  readonly #hostObjects: Map<string, HostEntry>
  readonly #commands: Map<string, CommandHandler>
  /** Stops the shell script running, while one is. */
  #shell: AbortController | null = null
  /** The call a shell script runs in, while one does: the commands'
   *  workspace is part of it. */
  #shellCall: symbol | null = null
  /** The turn open on this workspace, if any. */
  #turn: Turn | null = null
  readonly #secrets: Secrets
  #kernel: Kernel | null = null
  /** The call a host method made through its `HostCall` is part of,
   *  set while that method's workspace call starts. */
  #reentry: symbol | null = null
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
    this.conversation = new WorkspaceConversation(reader)
    this.index = new WorkspaceIndex({
      session,
      store,
      root: settings.root,
      fs: this.#fs,
      view: () => {
        const status = this.#wt?.status()
        return {
          reader,
          head: this.head,
          pending: new Set(status === undefined ? [] : [...status.updated, ...status.removed]),
        }
      },
      run: (op, fn) => this.#run(op, fn),
      moved: async () => {
        await this.#loadCwd()
      },
    })
    this.#secrets = new Secrets(settings.profile.secrets)
    this.#hostObjects = makeHostObjects(settings.profile, this, { secrets: this.#secrets })
    this.#commands = makeCommands(settings.profile, {
      ws: this.#asPartOf(() => this.#shellCall),
      secrets: this.#secrets,
    })
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
   * workspace's own queued calls, which would wait for `fn` to end. A
   * host method code calls gets a workspace that is part of the call
   * by declaring itself `withCall`.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      this.#checkOpen()
      return fn()
    }, this.#reentry)
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

  // ---------- code ----------

  /**
   * Run TypeScript in the session's kernel, as one call, committed as
   * `{tool: 'run_ts'}` when it changed anything. A run that fails,
   * times out or is interrupted still commits what it wrote before it
   * stopped.
   *
   * The code runs in a worker, as the body of an async function: it can
   * `await` at the top level and `return` a value to show. It has `fs`
   * (the session's files, async), `cache`, `env` (the profile's
   * variables), `console`, and the profile's host objects, by name and
   * as `host`. It can import the world's own modules by path, `'host'`,
   * URLs, and bare names the profile's `resolve` maps to URLs. Nothing
   * else carries over between runs: what should outlast one belongs in
   * the files or the cache.
   *
   * On a frozen workspace the code runs, and a write fails with
   * `EROFS`.
   */
  async runCode(code: string): Promise<CodeResult> {
    return this.#queue.run(async () => {
      this.#checkOpen()
      const active = this.#queue.active
      const call: HostCall = { ws: this.#asPartOf(() => active) }
      const out = await this.#kernelFor().run(code, {
        fs: this.#fs,
        cache: this.#cache,
        env: this.#settings.profile.variables ?? {},
        secrets: this.#secrets.names(),
        hostObjects: this.#hostObjects,
        call,
        settings: this.#settings.profile.code ?? {},
      })
      const commit = this.#wt === null ? null : await this.autoCommit({ tool: 'run_ts' })
      return { ...out, commit }
    }, this.#reentry)
  }

  /**
   * Stop the code running in the kernel, if any: its worker is
   * terminated, and `runCode` returns with a `CancelledError`, having
   * committed what the code wrote. Returns false if no code was
   * running.
   */
  interrupt(): boolean {
    if (this.#shell !== null) {
      this.#shell.abort()
      return true
    }
    return this.#kernel?.interrupt() ?? false
  }

  // ---------- turns ----------

  /** The turn open on this workspace, if any. */
  get currentTurn(): Turn | null {
    return this.#turn
  }

  /**
   * Open a turn for one run (see `Turn`). The run's id may come later
   * (`turn.bind`); resuming one names it.
   *
   * @throws TurnInProgressError while another turn is open here.
   * @throws WorldError resuming a run the conversation doesn't hold.
   * @throws ReadOnlyError on a frozen or closed workspace.
   */
  async turn(runId: string | null = null, opts: TurnOptions = {}): Promise<Turn> {
    const wt = this.#live('turn')
    if (opts.resume === true) {
      if (runId === null) throw new WorldError('resuming a run names it: runId')
      if (!(await readIndex(wt))?.runs.includes(runId)) {
        throw new WorldError(`session '${this.session}' holds no run '${runId}' to resume`)
      }
    }
    if (this.#turn !== null) {
      throw new TurnInProgressError(
        `turn ${runId ?? '(unnamed)'} is still open on session '${this.session}'; end it before beginning another`,
      )
    }
    const turn = new Turn(
      {
        session: this.session,
        run: (op, fn) => this.#run(op, fn),
        commitPending: (info) => this.#commitPending(info),
        release: (t) => {
          if (this.#turn === t) this.#turn = null
        },
      },
      runId,
      opts,
    )
    this.#turn = turn
    return turn
  }

  /**
   * Run `fn` in a turn, and end it however `fn` does, unless `fn` ended
   * it itself: completed when it returns, cancelled when it throws an
   * abort (`AbortError`, `CancelledError`), failed for any other error,
   * with the error as the message. The error is thrown on.
   */
  async runTurn<T>(
    fn: (turn: Turn) => Promise<T>,
    opts: TurnOptions & { runId?: string } = {},
  ): Promise<T> {
    const turn = await this.turn(opts.runId ?? null, opts)
    let result: T
    try {
      result = await fn(turn)
    } catch (e) {
      if (turn.open) {
        const status = statusOf(e)
        const message =
          status === 'cancelled'
            ? 'cancelled'
            : e instanceof Error
              ? `${e.name}: ${e.message}`
              : String(e)
        // The run's error is the one to throw, whatever ending did.
        await turn.end(status, { message }).catch(() => undefined)
      }
      throw e
    }
    if (turn.open) await turn.end('completed')
    return result
  }

  // ---------- the shell ----------

  /**
   * Run a shell script (termish) over the session's files, as one call,
   * committed as `{tool: 'terminal'}` when it changed anything. The
   * working directory persists between calls. `$NAME` expands the
   * profile's variables; a secret expands to a reference to itself,
   * which only a command made with `commandFactory` can fill. The
   * profile's commands sit beside termish's own.
   *
   * A failure is a result, not a throw: a non-zero `exitCode` with
   * `stderr` saying why. `interrupt()` stops a script between commands
   * (and tells a running command through its signal), exit code 130.
   */
  async terminal(command: string): Promise<TerminalResult> {
    return this.#queue.run(async () => {
      this.#checkOpen()
      const controller = new AbortController()
      this.#shell = controller
      this.#shellCall = this.#queue.active
      let stdout = ''
      let stderr = ''
      let exitCode = 0
      try {
        stdout = await execute(command, this.#fs, {
          commands: this.#commands,
          env: shellEnv(this.#settings.profile),
          signal: controller.signal,
        })
      } catch (e) {
        if (e instanceof ParseError) {
          exitCode = 2
          stderr = `parse error: ${e.message}`
        } else if (e instanceof TerminalError) {
          stdout = e.partialOutput
          exitCode = e.exitCode
          stderr = e.message
        } else {
          throw e
        }
      } finally {
        this.#shell = null
        this.#shellCall = null
      }
      const limit = this.#settings.profile.code?.maxObservation ?? DEFAULT_MAX_OBSERVATION
      const cut = stdout.length > limit || stderr.length > limit
      const commit = this.#wt === null ? null : await this.autoCommit({ tool: 'terminal' })
      return {
        stdout: stdout.slice(0, limit),
        exitCode,
        stderr: stderr.slice(0, limit),
        truncated: cut,
        commit,
      }
    }, this.#reentry)
  }

  // ---------- versioning ----------

  /**
   * Commit the pending changes, with `info` recorded on the commit.
   * Returns the new commit, or the current one when nothing was
   * pending.
   *
   * The `tool` names `ws-git` and `ws-git.*` are reserved: they're what
   * marks the agent's own commits and its git's bookkeeping.
   *
   * @throws CommitConflictError if a concurrent commit conflicts.
   */
  async commit(info: CommitInfo = { tool: 'commit' }): Promise<string> {
    const tool = info.tool
    if (typeof tool === 'string' && (tool === 'ws-git' || tool.startsWith('ws-git.'))) {
      throw new WorldError(
        `the tool '${tool}' is reserved: ws-git's commits are made by ws.index (and ws.merge, ws.revert, ws.cherryPick)`,
      )
    }
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

  /**
   * The session's commits, newest first, along the line made on the
   * session itself (first parents), back to its first. `kind` says
   * whose: `'work'` (the default) is everything but the agent's git's
   * own bookkeeping, which nobody performed; `'agent'` the agent's own
   * commits; `'all'` the history as kept. `limit` counts what comes
   * back.
   */
  async log(opts: { limit?: number; kind?: 'work' | 'agent' | 'all' } = {}): Promise<Commit[]> {
    const kind = opts.kind ?? 'work'
    if (!['work', 'agent', 'all'].includes(kind)) {
      throw new TypeError(
        `unknown log kind '${String(kind)}': 'work' (the default: everything but ws-git bookkeeping), 'agent' (the agent's own commits) or 'all' (the history as kept)`,
      )
    }
    const out: Commit[] = []
    if (opts.limit !== undefined && opts.limit <= 0) return out
    const start = this.#wt === null ? { commit: this.head } : { branch: this.session }
    for await (const c of this.store.repo.log(start, { firstParent: true })) {
      if (c.hash === ROOT_COMMIT) break
      if (kind === 'work' && isBookkeepingCommit(c.info)) continue
      if (kind === 'agent' && !isAgentCommit(c.info)) continue
      out.push(c)
      if (out.length === opts.limit) break
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

  // ---------- bringing work across ----------

  /**
   * Merge another session's committed work into this one; returns what
   * came of it.
   *
   * A merge takes only what has been committed, on both sides: this
   * session must have nothing pending and no ws-git work its agent
   * hasn't committed, and `source` is merged at its agent's last
   * commit (or its latest, if it never used ws-git), refused while its
   * agent has work past that commit or a merge of its own outstanding.
   * Nothing is merged here while a merge of this session's own is
   * outstanding.
   *
   * It brings files, and nothing else: the cache, the conversation and
   * the agent's git stay this session's. Lines both sides changed land
   * with conflict markers in the merge commit, reported in
   * `conflicts`, and stay outstanding until the markers are gone (or
   * `ws.index.abortMerge()`). Something no rule settles (a file one
   * side made a directory) isn't merged at all: `merged` is false.
   */
  async merge(source: string): Promise<MergeOutcome> {
    return this.#run('merge', async (wt) => {
      if (source === this.session) throw new WorldError('cannot merge a session into itself')
      if (!(await this.store.exists(source))) throw new UnknownSessionError(source)
      this.#requireNothingPending(wt, 'merge')
      await this.index.requireClean('merge')
      await this.index.requireUnmerged('merge')
      const repo = this.store.repo
      const agentHead = await this.index.head()
      const from = await this.index.sourceState(source, await repo.branches.get(source))
      if (from.uncommitted.length > 0) {
        throw new WorldError(
          `uncommitted ws-git work on '${source}': ${from.uncommitted.length} path(s) differ from that session's last ws-git commit, and a merge takes only what has been committed. Land it there (ws-git commit -m ... in that session) or drop it (ws-git checkout <its last commit>), then merge.`,
        )
      }
      if (from.marked.length > 0) {
        const shown = from.marked.slice(0, 3).join(', ') + (from.marked.length > 3 ? ', ...' : '')
        throw new WorldError(
          `'${source}' has an unresolved merge from ${from.mergeSource}: ${from.marked.length} path(s) still carry conflict markers (${shown}). A merge of it would bring the markers here as file content. Resolve them there (edit, then ws-git commit in that session) or abort it (ws-git merge --abort in that session), then merge.`,
        )
      }
      const before = wt.head
      const rules = await threeWayRules(repo, {
        base: await repo.mergeBase(before, from.commit),
        ours: before,
        theirs: from.commit,
      })
      const outcome = await threeWay(
        repo,
        before,
        from.commit,
        () =>
          wt.merge(
            { commit: from.commit },
            {
              ...rules,
              fastForward: false,
              info: {
                tool: MERGE_TOOL,
                source,
                virtualParents: agentHead === null ? [] : [agentHead],
              },
            },
          ),
        { held: true },
      )
      if (outcome.merged && outcome.commit !== before) {
        const commit = outcome.commit as string
        const fixes = await staleRecords(repo, commit, outcome.autoMerged.concat(outcome.conflicts))
        await this.index.recordMerge(wt, source, commit, outcome.conflicts, fixes)
      }
      await this.#loadCwd()
      return outcome
    })
  }

  /**
   * Undo one commit's change as a new commit; the commit stays where it
   * is. What's undone is the change it made, so work since, in other
   * files or elsewhere in the same one, stands. An agent commit's
   * change is measured from its parent in the agent's graph (or, for
   * its first, from where its session was forked, or from nothing); a
   * merge goes back to ours. Overlapping work lands as conflict
   * markers, as a merge's does. `merged` false with no conflicts:
   * there was nothing to undo.
   */
  async revert(commit: string): Promise<MergeOutcome> {
    return this.#run('revert', async (wt) => {
      const target = await this.store.repo.getCommit(await this.#expand(commit))
      const subject = target.info?.message
      return this.#applyChange(wt, {
        base: target.hash,
        theirs: await this.#changeBase(target),
        source: `${this.session}@${target.hash.slice(0, 7)}`,
        verb: 'revert',
        info: {
          tool: REVERT_TOOL,
          message:
            typeof subject === 'string' && subject !== ''
              ? `Revert "${subject}"`
              : `Revert ${target.hash.slice(0, 7)}`,
          reverted: target.hash,
        },
      })
    })
  }

  /**
   * Apply one commit's change from another session, as a new commit
   * here: `ref` is `session@commit` (a short id will do). The change is
   * what that commit made over the one before it in its own graph, so
   * a delegate's commit brings its own work and nothing it inherited.
   * Where it came from is recorded, but its history doesn't become
   * this session's. To bring everything a session committed, merge it.
   */
  async cherryPick(ref: string): Promise<MergeOutcome> {
    return this.#run('cherry-pick', async (wt) => {
      const at = ref.lastIndexOf('@')
      if (at <= 0) {
        throw new WorldError(
          `'${ref}' names no commit: a cherry-pick takes one, spelled 'session@commit' (ws-git log <session> lists them). To bring everything '${ref}' has committed, merge it.`,
        )
      }
      const session = ref.slice(0, at)
      if (!(await this.store.exists(session))) throw new UnknownSessionError(session)
      const target = await this.store.repo.getCommit(
        await this.#expandIn(session, ref.slice(at + 1)),
      )
      const message = target.info?.message
      return this.#applyChange(wt, {
        base: await this.#changeBase(target),
        theirs: target.hash,
        source: `${session}@${target.hash.slice(0, 7)}`,
        verb: 'cherry-pick',
        info: {
          tool: PICK_TOOL,
          message:
            typeof message === 'string' && message !== ''
              ? message
              : `Pick ${target.hash.slice(0, 7)}`,
          pickedFrom: `${session}@${target.hash}`,
        },
      })
    })
  }

  /** The commit one commit's change is measured from: its parent in
   *  the agent's graph for an agent commit (or where its session was
   *  forked, for its first; or nothing), else its first parent. */
  async #changeBase(entry: Commit): Promise<string | null> {
    if (!isAgentCommit(entry.info)) return entry.parents[0] ?? null
    const parent = virtualParents(entry.info)[0]
    if (parent !== undefined) return parent
    const snapshot = await this.store.repo.snapshot({ commit: entry.hash })
    return parseBlob(await snapshot.get(BLOB_KEY)).base
  }

  /** A commit `session`'s history holds, by id or a prefix of one. */
  async #expandIn(session: string, prefix: string): Promise<string> {
    if (/^[0-9a-f]{7,}$/.test(prefix)) {
      const found = new Set<string>()
      for await (const c of this.store.repo.log({ branch: session })) {
        if (c.hash.startsWith(prefix)) found.add(c.hash)
      }
      if (found.size === 1) return [...found][0] as string
      if (found.size > 1) throw new UnknownRefError(`${session}@${prefix}`, 'names several commits')
    }
    throw new UnknownRefError(
      `${session}@${prefix}`,
      `names no commit of session '${session}' (ws-git log ${session} lists them)`,
    )
  }

  async #applyChange(
    wt: Worktree<unknown>,
    change: {
      base: string | null
      theirs: string | null
      source: string
      verb: string
      info: CommitInfo
    },
  ): Promise<MergeOutcome> {
    this.#requireNothingPending(wt, change.verb)
    await this.index.requireClean(change.verb)
    await this.index.requireUnmerged(change.verb)
    const agentHead = await this.index.head()
    const repo = this.store.repo
    const before = wt.head
    const base = change.base ?? ROOT_COMMIT
    const theirs = change.theirs ?? ROOT_COMMIT
    const rules = await threeWayRules(repo, { base: change.base, ours: before, theirs })
    const outcome = await threeWay(repo, before, theirs, () =>
      wt.apply(base, theirs, {
        ...rules,
        info: {
          appliedFrom: change.theirs,
          appliedBase: change.base,
          ...change.info,
          virtualParents: agentHead === null ? [] : [agentHead],
        },
      }),
    )
    if (outcome.merged) {
      const commit = outcome.commit as string
      const fixes = await staleRecords(repo, commit, outcome.autoMerged.concat(outcome.conflicts))
      await this.index.recordMerge(wt, change.source, commit, outcome.conflicts, fixes)
      await this.#loadCwd()
    }
    return outcome
  }

  #requireNothingPending(wt: Worktree<unknown>, verb: string): void {
    if (wt.status().clean) return
    throw new WorldError(
      `uncommitted changes on this session; a ${verb} needs a clean tree to land against: ws.commit() them, or ws.discard() them, then ${verb}`,
    )
  }

  /** Stop: queued calls finish first; later ones throw, and the
   *  filesystem and cache turn read-only. Pending changes are dropped. */
  async close(): Promise<void> {
    await this.#queue.run(async () => {
      this.#kernel?.close()
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
    return this.#queue.run(() => fn(this.#live(op)), this.#reentry)
  }

  #kernelFor(): Kernel {
    this.#kernel ??= new Kernel(this.#settings.profile.code ?? {})
    return this.#kernel
  }

  /**
   * This workspace, with every call it starts made part of the call
   * `token()` names when it starts: run at once, not queued behind it.
   * Its `files` and `tags` too. When `token()` is null, calls queue as
   * usual.
   */
  #asPartOf(token: () => symbol | null): Workspace {
    const within = <T>(fn: () => T): T => {
      const previous = this.#reentry
      this.#reentry = token()
      try {
        return fn()
      } finally {
        this.#reentry = previous
      }
    }
    const wrap = <O extends object>(target: O): O =>
      new Proxy(target, {
        get(t, prop) {
          const value = Reflect.get(t, prop, t)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => within(() => value.apply(t, args))
        },
      })
    const files = wrap(this.files)
    const tags = wrap(this.tags)
    const ws = this
    return new Proxy(this, {
      get(t, prop) {
        if (prop === 'files') return files
        if (prop === 'tags') return tags
        const value = Reflect.get(t, prop, t)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => within(() => value.apply(ws, args))
      },
    })
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
    // A commit from before a fork holds the conversation as another
    // session's: restored here it becomes this one's again, keeping the
    // lineage this session's own conversation names.
    const current = await readIndex(wt)
    const lineage = current?.session === this.session ? current.forkedFrom : null
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
      await reclaimConversation(wt, this.session, lineage)
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
      if (inherit === 'fresh') await wipeConversation(wt)
      else await rebindConversation(wt, this.session, parent)
      // A fresh ws-git state, recording where the fork starts: what its
      // work is measured against until its first commit.
      wt.set(BLOB_KEY, forkBlob(wt.head))
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
   * Replace `oldString` with `newString` in a text file, committed as
   * `{tool: 'file_edit'}`. The quote must match once (or, with
   * `replaceAll`, everywhere); it may differ from the file by trailing
   * whitespace, or by indent (the replacement is then re-indented), and
   * an edit whose replacement is already there is a no-op. See
   * `applyEdit`.
   *
   * @throws EditError, with a message written for the agent, when
   *   nothing matches (naming the closest lines), several places do,
   *   or the file can't be read as UTF-8.
   */
  async edit(
    path: string,
    oldString: string,
    newString: string,
    opts: { replaceAll?: boolean } = {},
  ): Promise<EditOutcome> {
    return this.#inner.run('file_edit', async () => {
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await this.#fs.read(path))
      } catch (e) {
        throw new EditError(`cannot read ${path}: ${describeFsError(e)}`)
      }
      const result = applyEdit(text, oldString, newString, { ...opts, path })
      if (result.count === 0) return { path, count: 0, mode: result.mode, commit: null }
      await this.#fs.write(path, enc.encode(result.content))
      return {
        path,
        count: result.count,
        mode: result.mode,
        commit: await this.#autoCommit({ tool: 'file_edit' }),
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
