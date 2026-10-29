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
  type FileSystem,
  FsError,
  ParseError,
  TerminalError,
  describeFsError,
  execute,
} from '@agex-ts/termish'
import {
  BLOB_KEY,
  HASH_RE,
  MERGE_TOOL,
  type MergeOutcome,
  PICK_TOOL,
  REVERT_TOOL,
  WorkspaceIndex,
  changeBase,
  forkBlob,
  isAgentCommit,
  isBookkeepingCommit,
  parseBlob,
  virtualParents,
} from './agentgit'
import { AttachFS, SubtreeFS } from './attach'
import { WorkspaceCache } from './cache'
import { WorkspaceCompaction } from './compaction'
import {
  WorkspaceConversation,
  readIndex,
  readRuns,
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
import { type KeyReader, WorldFS, writeWithParents } from './fs'
import { Patterns, whyIgnored } from './ignore'
import { DEFAULT_MAX_OBSERVATION, Kernel } from './kernel/kernel'
import type { Image, SerializedError } from './kernel/messages'
import {
  COMPACTION_PREFIX,
  CONVERSATION_PREFIX,
  CWD_KEY,
  FILE_PREFIX,
  META_PREFIX,
  fileKey,
  isFileRecord,
  metaKey,
} from './layout'
import { staleRecords, threeWay, threeWayRules } from './merging'
import { checkSessionName, checkTagName } from './names'
import { dirname, normalize, resolve, within } from './path'
import { WorkspacePlane } from './planes'
import {
  type HostCall,
  type HostEntry,
  type Profile,
  makeCommands,
  makeHostObjects,
  secretSpecs,
  shellEnv,
  variablesNow,
} from './profile'
import { Queue } from './queue'
import { repr } from './repr'
import { Secrets } from './secrets'
import { skillFS, skillName, skillsRoot } from './skills'
import type { Store } from './store'
import {
  type LoadedTrace,
  Trace,
  type TraceCommit,
  TraceFS,
  type TraceRun,
  runRanges,
} from './traces'
import { Turn, TurnInProgressError, type TurnOptions, statusOf } from './turns'
import { type Artifact, writeUi } from './ui'
import { VIEW_KEY, ViewFS, encodeView, normalizeView, parseView } from './views'

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
  /** Paths that are never the session's work (`.gitignore` patterns,
   *  relative to the root): ws-git, diffs and merges leave them out.
   *  Anything outside the root is never work either. Forks inherit it. */
  readonly ignore?: string | readonly string[]
}

/** A workspace's settings, filled in; a fork's child gets its parent's. */
export interface WorkspaceSettings {
  readonly root: string
  readonly autocommit: boolean
  readonly cache: boolean
  readonly profile: Profile
  readonly ignore: readonly string[]
}

/** What a fork's child starts with: everything (`'full'`), or the
 *  files without the conversation and compaction's record
 *  (`'fresh'`). */
export type Inherit = 'full' | 'fresh'

export interface ForkOptions {
  /** Fork from this commit (a hash, a unique prefix of one, or a tag
   *  of this session; or a whole commit id from anywhere in the store)
   *  instead of the current one. */
  readonly at?: string
  readonly inherit?: Inherit
  /** Narrow the child's view to these paths (directories or files,
   *  absolute or relative to the root): its branch holds everything,
   *  its files show only these, and what it creates. `[]` is an empty
   *  view, forked from the last commit without committing what's
   *  pending. Left out, the child sees the whole tree. */
  readonly paths?: readonly string[]
}

/** The files two commits differ in, as absolute paths, sorted. A file
 *  whose content is unchanged is not modified, whatever its times
 *  say; directories don't count. */
export interface WorkspaceDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly modified: readonly string[]
  /** What the session the diff ends at was given, when it's a narrowed
   *  fork; empty otherwise. */
  readonly seed: readonly string[]
  /** The changed paths inside the seed (all of them, with no seed). */
  readonly inSeed: readonly string[]
  /** The changed paths outside it: what a narrowed delegate touched
   *  beyond what it was given. */
  readonly elsewhere: readonly string[]
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
  /** The `ui` artifacts the run wrote (with `profile.code.ui` on). */
  readonly artifacts: readonly Artifact[]
  /** Why a `ui` value gave no artifact, or not the one meant. */
  readonly uiNotes: readonly string[]
}

/** What `terminal` gave. */
export interface TerminalResult {
  /** What the commands printed, with the diagnostics of failures the
   *  script went on past. */
  readonly stdout: string
  /** 0 on success; the failing command's code (127 for a command not
   *  found, 2 for a script that doesn't parse, 130 when interrupted). */
  readonly exitCode: number
  /** What the failing final command wrote to stderr, named once (`ls:
   *  cannot access ...`), or `parse error: ...`; empty on success, and
   *  when the command failed silently (`grep` with no match) or its
   *  stderr was redirected (`2>&1`, `2>/dev/null`, `2>file`). */
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
  attach(ref: string, at: string, opts: AttachOptions): Promise<string>
  detach(at: string): Promise<void>
  attachments(): Record<string, string>
  held(at: string): Attachment | undefined
}

/** One state attached in a session's tree, as `ws-git worktree`
 *  reports it. */
export interface Attachment {
  /** What was attached, as `attach` returned it. */
  readonly ref: string
  /** The conversation mounted at `.trace`, or null when none was asked
   *  for: how many runs it holds, how many are new since the `since`
   *  ref (null without one), and whether it hides a `.trace` the tree
   *  holds of its own. */
  readonly trace: {
    readonly runs: number
    readonly new: number | null
    readonly shadowed: boolean
  } | null
}

export interface AttachOptions {
  /** The source's root, for a session from elsewhere (default this
   *  session's). */
  readonly root?: string
  /** An attachment is read-only; `false` is refused. */
  readonly readonly?: boolean
  /**
   * Mount the conversation stored at that commit beside the files, at
   * `<at>/.trace`, rendered as a {@link Trace} and read-only; it hides
   * any `.trace` the tree holds of its own. The store reads it with the
   * trace source for the harness that wrote it (`Store.open(kv, {
   * traces })`). Refused for a state with no conversation, or one
   * written by a harness the store has no source for.
   */
  readonly trace?: boolean
  /** With `trace`: mark the runs new since this state with `+` in
   *  `index.md`. Any ref `attach` takes, or a bare commit of the session
   *  traced. A run that landed before it and again after is new. */
  readonly since?: string
}

/** A ref as a message names it: a store tag's name, or the session and
 *  seven characters of the commit. */
function shownRef(label: string): string {
  const at = label.lastIndexOf('@')
  if (at < 0) return label.slice(0, 7)
  const who = label.slice(0, at)
  if (who.startsWith('@store/tag/')) return who.slice('@store/tag/'.length)
  return `${who}@${label.slice(at + 1, at + 8)}`
}

/** The store tag a label names, or null. */
function tagOf(label: string): string | null {
  const at = label.lastIndexOf('@')
  const who = at < 0 ? '' : label.slice(0, at)
  return who.startsWith('@store/tag/') ? who.slice('@store/tag/'.length) : null
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
  /** Compaction's record: the folds a loop made of the conversation. */
  readonly compaction: WorkspaceCompaction
  /** Plane `name`: a harness's own records in the session, which code
   *  and tools never see (see `planes.ts`). */
  plane(name: string): WorkspacePlane {
    return new WorkspacePlane(name, this.#reader, () => !this.#closed)
  }
  /** The agent's own git over the session (see `WorkspaceIndex`). */
  readonly index: WorkspaceIndex

  readonly #settings: WorkspaceSettings
  readonly #wt: Worktree<unknown> | null
  readonly #frozenAt: string | null
  /** The session's own files, unnarrowed: the workspace's verbs. */
  readonly #fs: WorldFS
  /** A narrowed session's view over them (live sessions). */
  readonly #view: ViewFS | null
  /** What the agent and the host see: the view, and attachments. */
  readonly #top: AttachFS
  readonly #attached = new Map<string, Attachment & { ws: Workspace }>()
  readonly #patterns: Patterns
  readonly #cache: WorkspaceCache | null
  readonly #queue = new Queue()
  readonly #hostObjects: Map<string, HostEntry>
  readonly #reader: KeyReader
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
    const wt = this.#wt
    this.#view =
      wt === null
        ? null
        : new ViewFS(this.#fs, settings.root, (record) =>
            wt.set(VIEW_KEY, encodeView(record.paths, record.seed)),
          )
    this.#top = new AttachFS(this.#view ?? this.#fs, settings.root)
    this.#patterns = new Patterns(settings.ignore)
    this.#cache = settings.cache ? new WorkspaceCache(reader, open) : null

    const inner: Inner = {
      session,
      store,
      run: (op, fn) => this.#run(op, fn),
      commitPending: (info) => this.#commitPending(info),
      expand: (ref) => this.#expand(ref),
      frozenView: (commit) => Workspace._frozen(store, session, settings, commit),
      attach: (ref, at, opts) => this.#attach(ref, at, opts),
      detach: (at) => this.#detach(at),
      attachments: () => Object.fromEntries([...this.#attached].map(([at, { ref }]) => [at, ref])),
      held: (at) => {
        const found = this.#attached.get(normalize(resolve(at, this.root)))
        return found === undefined ? undefined : { ref: found.ref, trace: found.trace }
      },
    }
    this.files = new WorkspaceFiles(inner, this.#top, (info) => this.autoCommit(info))
    this.tags = new WorkspaceTags(inner)
    this.conversation = new WorkspaceConversation(reader)
    this.compaction = new WorkspaceCompaction(reader, open)
    this.#reader = reader
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
        await this.#loadState()
      },
      sees: (path) => this.#view?.sees(path) ?? true,
      whyIgnored: (path) => whyIgnored(path, this.root, this.#patterns),
    })
    const { secrets, variables } = settings.profile
    // read live while either is a function: a variable given later is
    // checked against them
    this.#secrets = new Secrets(
      typeof secrets === 'function' || typeof variables === 'function'
        ? () => secretSpecs(settings.profile)
        : secrets,
    )
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
    await ws.#mountSkills()
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
    await ws.#mountSkills()
    await ws.#loadState()
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

  /** The session's ignore patterns. */
  get ignore(): readonly string[] {
    return this.#patterns.source
  }

  /** A narrowed session's view (what it sees now), or null for the
   *  whole tree. */
  get view(): readonly string[] | null {
    return this.#view?.view ?? null
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
   * With `profile.code.ui` on, it also has `ui`: the values it leaves
   * there that render are written under `<root>/ui` before the commit,
   * and named in `artifacts` (see `ui.ts`).
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
        fs: this.#top,
        cache: this.#cache,
        env: { ...variablesNow(this.#settings.profile) },
        secrets: this.#secrets.names(),
        hostObjects: this.#hostObjects,
        values: this.#settings.profile.values ?? {},
        call,
        settings: this.#settings.profile.code ?? {},
      })
      const { ui, ...rest } = out
      const { artifacts, notes } =
        ui === null ? { artifacts: [], notes: [] } : await writeUi(this.#top, this.root, ui)
      const commit = this.#wt === null ? null : await this.autoCommit({ tool: 'run_ts' })
      return { ...rest, commit, artifacts, uiNotes: notes }
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
        stdout = await execute(command, this.#top, {
          commands: this.#commands,
          env: shellEnv(this.#settings.profile, this.root),
          signal: controller.signal,
        })
      } catch (e) {
        if (e instanceof ParseError) {
          exitCode = 2
          stderr = `parse error: ${e.message}`
        } else if (e instanceof TerminalError) {
          // Only what reached the screen: the failing command's own
          // diagnostic, named once, or '' when it failed silently or its
          // stderr was redirected (2>&1 put it in stdout already).
          // Earlier failures the script ran past are in stdout.
          stdout = e.partialOutput
          exitCode = e.exitCode
          stderr = e.displayStderr
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
      await this.#loadState()
    })
  }

  /** Drop the pending changes and move to the session's latest commit,
   *  which another workspace on the session may have made. */
  async refresh(): Promise<void> {
    await this.#run('refresh', async (wt) => {
      await wt.refresh()
      await this.#loadState()
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
      this.#resolveAny(a),
      b === undefined ? { commit: this.head } : this.#resolveAny(b),
    ])
    const repo = this.store.repo
    const d = await repo.diff(from.commit, to.commit)
    // Paths that are never work don't count as changes.
    const paths = (keys: ReadonlySet<string>) =>
      [...keys]
        .filter((k) => k.startsWith(FILE_PREFIX))
        .map((k) => k.slice(FILE_PREFIX.length))
        .filter((p) => whyIgnored(p, this.root, this.#patterns) === null)
        .sort()
    const added = paths(d.added)
    const removed = paths(d.removed)
    const modified = paths(d.modified)
    const view = parseView(await (await repo.snapshot({ commit: to.commit })).get(VIEW_KEY))
    const seed = view?.seed ?? []
    const all = [...added, ...removed, ...modified].sort()
    // No view: everything is the session's. An empty one was given
    // nothing, so all it changed is elsewhere.
    const inSeed = view === null ? all : all.filter((p) => seed.some((entry) => within(p, entry)))
    return {
      added,
      removed,
      modified,
      seed: [...seed],
      inSeed,
      elsewhere: all.filter((p) => !inSeed.includes(p)),
    }
  }

  /**
   * A ref from anywhere in the store, as a commit and the name to record
   * it by: this session's own (a hash, a prefix, a tag), `session@commit`,
   * a store tag, another session by name (its agent's last commit, or
   * its latest if it never used ws-git, as a merge reads it), or a whole
   * commit id.
   */
  async #resolveAny(ref: string): Promise<{ commit: string; label: string }> {
    const repo = this.store.repo
    const at = ref.lastIndexOf('@')
    if (at > 0) {
      const session = ref.slice(0, at)
      const rest = ref.slice(at + 1)
      if (!(await this.store.exists(session))) throw new UnknownSessionError(session)
      const commit =
        session === this.session ? await this.#expand(rest) : await this.#expandIn(session, rest)
      return { commit, label: `${session}@${commit}` }
    }
    try {
      const commit = await this.#expand(ref)
      return { commit, label: `${this.session}@${commit}` }
    } catch (e) {
      if (!(e instanceof UnknownRefError)) throw e
    }
    if (!ref.startsWith('@') && (await repo.tags.has(`@store/${ref}`))) {
      const commit = await repo.tags.get(`@store/${ref}`)
      return { commit, label: `@store/tag/${ref}@${commit}` }
    }
    if (ref !== this.session && (await this.store.exists(ref))) {
      const head = await repo.branches.get(ref)
      const commit = (await this.index.sourceState(ref, head)).commit
      return { commit, label: `${ref}@${commit}` }
    }
    if (/^[0-9a-f]{40}$/.test(ref)) {
      try {
        await repo.getCommit(ref)
        return { commit: ref, label: ref }
      } catch {
        // falls through to the refusal
      }
    }
    throw new UnknownRefError(ref)
  }

  /**
   * A ref from anywhere in the store, as the commit it names and the
   * name to record it by (`session@commit`, or a store tag's): what
   * `diff` and `checkout(ref, {paths})` take. See {@link expandRef}
   * for this session's own refs alone.
   *
   * @throws UnknownRefError if it names no commit the store holds.
   * @throws UnknownSessionError for `session@commit` with no such
   *   session.
   */
  async resolveRef(ref: string): Promise<{ commit: string; label: string }> {
    return this.#resolveAny(ref)
  }

  /** A fork's starting commit: this session's ref, or a whole commit id
   *  the store holds on another session's line. */
  async #forkPoint(ref: string): Promise<string> {
    try {
      return await this.#expand(ref)
    } catch (e) {
      if (!(e instanceof UnknownRefError) || !/^[0-9a-f]{40}$/.test(ref)) throw e
      try {
        await this.store.repo.getCommit(ref)
      } catch {
        throw e
      }
      return ref
    }
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
   * With `paths`, only those are taken, on top of the pending changes,
   * and committed (`{tool: 'checkout', target, takenFrom, paths,
   * removed}`), as git's `restore --source`: `ref` may then be any
   * ref the store holds (another session's commit, a session by name at
   * its agent's last commit, a store tag). A path naming a file takes
   * that file; one naming a directory mirrors it, so a file this side
   * holds there and `ref` doesn't is removed. Ignored files are left
   * alone in a directory, but taken when named. A narrowed session's
   * view applies: a take that would change a path it can't see is
   * refused whole, before anything changes.
   */
  async checkout(ref: string, opts: { paths?: readonly string[] } = {}): Promise<string> {
    return this.#run('checkout', async (wt) => {
      if (opts.paths !== undefined) {
        const paths = opts.paths.map((p) => normalize(resolve(p, this.root)))
        return this.#take(wt, await this.#resolveAny(ref), paths)
      }
      return this.#restore(wt, await this.#expand(ref))
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
      const paths = opts.paths === undefined ? null : normalizeView(opts.paths, this.root)
      if (await this.store.exists(name)) throw new SessionExistsError(name)
      let at: string
      if (opts.at !== undefined) {
        // The agent's own bookmarks name its commits too.
        at = (await this.index.tags.get(opts.at)) ?? (await this.#forkPoint(opts.at))
      } else if (paths !== null && paths.length === 0) {
        // An empty view needs none of what's pending here.
        at = wt.head
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
      await child.#seedFork(this.session, inherit, paths)
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
      const base = await repo.mergeBase(before, from.commit)
      const rules = await threeWayRules(repo, { base, ours: before, theirs: from.commit }, (p) =>
        this.#ignored(p),
      )
      const outcome = await threeWay(
        repo,
        { base, before, theirs: from.commit },
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
      await this.#loadState()
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
  #changeBase(entry: Commit): Promise<string | null> {
    return changeBase(this.store, entry)
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
    const rules = await threeWayRules(repo, { base: change.base, ours: before, theirs }, (p) =>
      this.#ignored(p),
    )
    const outcome = await threeWay(repo, { base: change.base, before, theirs }, () =>
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
      await this.#loadState()
    }
    return outcome
  }

  /** Whether `path` is never work: outside the root, or ignored. A
   *  directory's own record follows the files: only the root's way
   *  down counts as work. */
  #ignored(path: string): boolean {
    return whyIgnored(path, this.root, this.#patterns) !== null && !within(this.root, path)
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
    // Attachments go with the session.
    this.#top.clear()
    for (const { ws } of this.#attached.values()) await ws.close()
    this.#attached.clear()
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
    const indexTags = wrap(this.index.tags)
    const index = new Proxy(wrap(this.index), {
      get(t, prop) {
        return prop === 'tags' ? indexTags : Reflect.get(t, prop)
      },
    })
    const ws = this
    return new Proxy(this, {
      get(t, prop) {
        if (prop === 'files') return files
        if (prop === 'tags') return tags
        if (prop === 'index') return index
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

  /** The profile's skills, each mounted read-only at
   *  `<root>/skills/<name>`. */
  async #mountSkills(): Promise<void> {
    for (const skill of this.#settings.profile.skills ?? []) {
      this.#top.attach(`${skillsRoot(this)}/${skillName(skill)}`, await skillFS(skill))
    }
  }

  /** The names of the skills the profile mounts. */
  get mountedSkills(): string[] {
    return (this.#settings.profile.skills ?? []).map(skillName).sort()
  }

  async #init(): Promise<void> {
    const wt = this.#wt as Worktree<unknown>
    if (!(await this.#fs.isDir(this.root))) await this.#fs.mkdir(this.root, { parents: true })
    if (!(await this.#loadState())) await this.#fs.chdir(this.root)
    if (!wt.status().clean) await this.#commitPending({ tool: 'init' })
  }

  /** Take the working directory from the session; false if it holds
   *  none usable, and the root (or `/`) was taken instead. */
  /** Take what the session holds about where it stands: its view (a
   *  narrowed fork's) and its working directory. After anything that
   *  moves the tree. False if it holds no usable working directory,
   *  and the root (or `/`) was taken instead. */
  async #loadState(): Promise<boolean> {
    if (this.#wt !== null) this.#view?.setView(parseView(await this.#wt.get(VIEW_KEY)))
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
        await this.#loadState()
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
          await this.#loadState()
          return result.commit as string
        }
      } catch (e) {
        if (!(e instanceof MergeConflict)) throw e
      }
    }
    await wt.refresh()
    await this.#loadState()
    throw new WorldError(`checkout of ${target}: other commits kept landing; try again`)
  }

  async #take(
    wt: Worktree<unknown>,
    from: { commit: string; label: string },
    named: readonly string[],
  ): Promise<string> {
    const snapshot = await this.store.repo.snapshot({ commit: from.commit })
    const filesOf = async (keys: Promise<string[]>) =>
      new Set(
        (await keys)
          .filter((k) => k.startsWith(FILE_PREFIX))
          .map((k) => k.slice(FILE_PREFIX.length)),
      )
    const [ours, theirs] = await Promise.all([filesOf(wt.keys()), filesOf(snapshot.keys())])
    const work = (p: string) => whyIgnored(p, this.root, this.#patterns) === null
    const take = new Set<string>()
    const drop = new Set<string>()
    for (const path of named) {
      if (theirs.has(path)) {
        take.add(path)
        continue
      }
      const under = (p: string) => within(p, path) && p !== path
      const inside = [...theirs].filter(under)
      if (inside.length === 0 && !isFileRecord(await snapshot.get(metaKey(path)))) {
        throw new UnknownRefError(
          from.label,
          '',
          `nothing at ${repr(path)} in ${from.label} — a take makes a path match the ref, and that ref holds no such file or directory.`,
        )
      }
      for (const p of inside) if (work(p)) take.add(p)
      for (const p of ours) if (under(p) && !theirs.has(p) && work(p)) drop.add(p)
    }
    // The view is asked first: a take is one change, done whole or not.
    if (this.#view !== null) {
      for (const p of take) {
        const refused = await this.#view.refused(p, 'write')
        if (refused !== null) throw refused
      }
      for (const p of drop) {
        const refused = await this.#view.refused(p, 'remove')
        if (refused !== null) throw refused
      }
    }
    const keys = [...take].flatMap((p) => [fileKey(p), metaKey(p)])
    for (const p of [...take, ...named]) {
      for (let dir = dirname(p); dir !== '/'; dir = dirname(dir)) keys.push(metaKey(dir))
    }
    // A named directory's own records come along, and those under it.
    for (const path of named) {
      for (const k of await snapshot.keys()) {
        if (k.startsWith(META_PREFIX) && within(k.slice(META_PREFIX.length), path)) keys.push(k)
      }
    }
    const [mine, wanted] = await Promise.all([wt.getMany(keys), snapshot.getMany(keys)])
    for (const key of new Set(keys)) {
      const want = wanted.get(key)
      const have = mine.get(key)
      if (want === undefined) continue
      const isFile = key.startsWith(FILE_PREFIX) || take.has(key.slice(META_PREFIX.length))
      // Besides the files taken, only directories come along.
      if (!isFile && !(isFileRecord(want) && want.isDir)) continue
      if (have === undefined || (isFile && !sameValue(have, want))) wt.set(key, want)
    }
    for (const p of drop) {
      await wt.delete(fileKey(p))
      await wt.delete(metaKey(p))
    }
    for (const p of take) this.#view?.include(p)
    const info: CommitInfo = {
      tool: 'checkout',
      target: from.commit,
      takenFrom: from.label,
      paths: [...take].sort(),
      ...(drop.size > 0 && { removed: [...drop].sort() }),
    }
    const commit = await this.#commitPending(info)
    await this.#loadState()
    return commit ?? wt.head
  }

  // ---------- attachments ----------

  async #attach(ref: string, at: string, opts: AttachOptions): Promise<string> {
    if (opts.since !== undefined && opts.trace !== true) {
      throw new WorldError("since marks a trace's runs that are new: pass trace: true with it")
    }
    if (opts.readonly === false) {
      throw new WorldError(
        'an attachment is a frozen state, and accepts no writes: readonly: false is refused',
      )
    }
    this.#checkOpen()
    const point = normalize(resolve(at, this.root))
    if (this.#attached.has(point)) {
      throw new WorldError(`'${point}' is already taken by an attachment; detach it first`)
    }
    // A new or empty directory: the mount covers it, and nothing in it.
    if (
      (await this.#fs.exists(point)) &&
      (!(await this.#fs.isDir(point)) || (await this.#fs.list(point)).length > 0)
    ) {
      throw new WorldError(
        `'${point}' is a path of this session: attach somewhere new, or at an empty directory`,
      )
    }
    const from = await this.#resolveAny(ref)
    const root = normalize(opts.root ?? this.root)
    let traced: Awaited<ReturnType<Workspace['_traceOf']>> = null
    if (opts.trace === true) {
      const since = opts.since === undefined ? null : await this.#sinceRef(opts.since, from)
      traced = await this._traceOf(from, root, since)
      if (traced === null) {
        throw new WorldError(
          `${shownRef(from.label)} holds no conversation to trace: no agent's runs are stored at that commit`,
        )
      }
    }
    const frozen = await this.store._frozenView(from.label, from.commit, { root })
    let trace: Attachment['trace'] = null
    if (traced !== null) {
      const shadowed = await frozen.files.fs.exists(`${root}/.trace`).catch(() => false)
      trace = { runs: traced.runs, new: traced.new, shadowed }
    }
    this.#top.attach(point, new SubtreeFS(frozen.files.fs, root))
    // One attachment: the tree and its conversation, pinned together and
    // taken down together.
    if (traced !== null) this.#top.attach(`${point}/.trace`, traced.fs)
    this.#attached.set(point, { ref: from.label, ws: frozen, trace })
    return from.label
  }

  async #detach(at: string): Promise<void> {
    const point = normalize(resolve(at, this.root))
    const found = this.#attached.get(point)
    if (found === undefined) throw new WorldError(`nothing attached at '${point}'`)
    this.#attached.delete(point)
    if (found.trace !== null) await this.#top.detach(`${point}/.trace`)
    await this.#top.detach(point)
    await found.ws.close()
  }

  /** The state `since` names, for a trace of `from`: any ref `attach`
   *  takes, or a bare commit of the session being traced. */
  async #sinceRef(
    since: string,
    from: { label: string },
  ): Promise<{ commit: string; label: string }> {
    const text = since.trim()
    const at = from.label.lastIndexOf('@')
    if (at > 0 && tagOf(from.label) === null && HASH_RE.test(text)) {
      return this.#resolveAny(`${from.label.slice(0, at)}@${text}`)
    }
    return this.#resolveAny(since)
  }

  /**
   * @internal The conversation stored at a state, as a filesystem: its
   * runs rendered by the store's trace source for the harness that
   * wrote them, how many runs it holds and, with `since`, how many are
   * new since that state. Null for a state with no conversation.
   *
   * Nothing is read but the index until the trace is, unless `since`
   * asks which runs are new: that walks both histories now. The trace
   * reads every run at that commit, which the source parses (a body it
   * can't read is left out), and the branch's history, for what each
   * run changed.
   *
   * @throws WorldError for a conversation written by a harness the
   *   store has no trace source for.
   */
  async _traceOf(
    from: { commit: string; label: string },
    root: string,
    since: { commit: string; label: string } | null = null,
  ): Promise<{ fs: TraceFS; runs: number; new: number | null } | null> {
    const repo = this.store.repo
    const snapshot = await repo.snapshot({ commit: from.commit })
    const index = await readIndex(snapshot)
    if (index === null) return null
    const source = this.store.traces.get(index.harness)
    if (source === undefined) {
      throw new WorldError(
        `${shownRef(from.label)} holds a conversation written by ${repr(index.harness)}, which this store cannot read, so it has no trace`,
      )
    }
    const tag = tagOf(from.label)
    const session =
      tag !== null ? index.session || tag : from.label.slice(0, from.label.lastIndexOf('@'))
    const walked = since === null ? null : await this.#oldestFirst(from.commit)
    const fresh =
      walked === null || since === null
        ? new Set<string>()
        : await this.#newSince(index.runs, walked, since)
    const load = async (): Promise<LoadedTrace> => {
      const commits = walked ?? (await this.#oldestFirst(from.commit))
      const bodies = await readRuns(snapshot, index.runs)
      const runs: TraceRun[] = []
      for (const id of index.runs) {
        if (!bodies.has(id)) continue // named by the index, never stored
        try {
          runs.push(source.read(bodies.get(id)))
        } catch {
          // a body its source can't read
        }
      }
      const changes = new Map<string, TraceCommit[]>()
      for (const [id, span] of runRanges(
        index.runs,
        commits.map((c) => c.info),
      )) {
        changes.set(id, await this.#changes(commits, span, root))
      }
      const trace = await Trace.create(runs, {
        session: session ?? '',
        commit: from.commit.slice(0, 7),
        harness: index.harness,
        changes,
        since: since === null ? null : shownRef(since.label),
        new: fresh,
      })
      return { trace, time: commits.at(-1)?.time ?? null }
    }
    return {
      fs: new TraceFS(load),
      runs: index.runs.length,
      new: since === null ? null : fresh.size,
    }
  }

  /** A commit's line of history (first parents), oldest first. */
  async #oldestFirst(commit: string): Promise<Commit[]> {
    const out: Commit[] = []
    for await (const c of this.store.repo.log({ commit }, { firstParent: true })) out.push(c)
    return out.reverse()
  }

  /** The runs new since `since`: those whose last landing isn't in its
   *  history (a run that landed before it and again after is new), or,
   *  for a run with no landing in `walked`, that its conversation
   *  doesn't name. */
  async #newSince(
    runs: readonly string[],
    walked: readonly Commit[],
    since: { commit: string },
  ): Promise<Set<string>> {
    const seen = new Set((await this.#oldestFirst(since.commit)).map((c) => c.hash))
    const known = await readIndex(await this.store.repo.snapshot({ commit: since.commit }))
    const named = new Set(known?.runs ?? [])
    const ranges = runRanges(
      runs,
      walked.map((c) => c.info),
    )
    const out = new Set<string>()
    for (const id of runs) {
      const span = ranges.get(id)
      if (span !== undefined) {
        if (!seen.has((walked[span[1] - 1] as Commit).hash)) out.add(id)
      } else if (!named.has(id)) out.add(id)
    }
    return out
  }

  /** The commits at `span` in `commits` that changed a file, each
   *  against the commit before it, with paths relative to `root`. */
  async #changes(
    commits: readonly Commit[],
    [start, end]: readonly [number, number],
    root: string,
  ): Promise<TraceCommit[]> {
    const repo = this.store.repo
    const base = root.replace(/\/+$/, '')
    const rel = (key: string) => {
      const path = key.slice(FILE_PREFIX.length)
      return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
    }
    const files = (keys: Iterable<string>) =>
      [...keys].filter((k) => k.startsWith(FILE_PREFIX)).map(rel)
    const out: TraceCommit[] = []
    for (let i = start; i < end; i++) {
      const commit = commits[i] as Commit
      const before = i > 0 ? (commits[i - 1] as Commit).hash : (commit.parents[0] ?? null)
      let added: string[]
      let modified: string[] = []
      let removed: string[] = []
      if (before === null) {
        // a root commit: everything in it is added
        added = files(await (await repo.snapshot({ commit: commit.hash })).keys())
      } else {
        const d = await repo.diff(before, commit.hash)
        added = files(d.added)
        modified = files(d.modified)
        removed = files(d.removed)
      }
      if (added.length + modified.length + removed.length === 0) continue
      const tool = commit.info?.tool
      out.push({
        id: commit.hash.slice(0, 7),
        tool: typeof tool === 'string' ? tool : null,
        added,
        modified,
        removed,
      })
    }
    return out
  }

  async #seedFork(
    parent: string,
    inherit: Inherit,
    paths: readonly string[] | null,
  ): Promise<void> {
    await this.#run('fork', async (wt) => {
      if (inherit === 'fresh') await wipeConversation(wt)
      else await rebindConversation(wt, this.session, parent)
      // A view is the child's own: one given the whole tree doesn't
      // inherit its parent's.
      if (paths !== null) wt.set(VIEW_KEY, encodeView(paths))
      else if ((await wt.get(VIEW_KEY)) !== undefined) await wt.delete(VIEW_KEY)
      this.#view?.setView(paths === null ? null : { paths, seed: paths })
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
  readonly #fs: FileSystem
  readonly #autoCommit: (info: CommitInfo) => Promise<string | null>

  /** @internal Made by the workspace. */
  constructor(
    inner: Inner,
    fs: FileSystem,
    autoCommit: (info: CommitInfo) => Promise<string | null>,
  ) {
    this.#inner = inner
    this.#fs = fs
    this.#autoCommit = autoCommit
  }

  /** The session's filesystem, with its working directory: narrowed to
   *  a fork's view, with whatever is attached mounted in it. */
  get fs(): FileSystem {
    return this.#fs
  }

  /**
   * Mount another session's tree, frozen at a commit, read-only at
   * `at` (absolute, or relative to the root): a session by name (at its
   * agent's last commit), `session@commit`, or a store tag. Its
   * workspace root lands at `at`, so its `auth.py` reads as
   * `<at>/auth.py`; `root` names another root, for a session from
   * elsewhere. Not versioned, not carried by a fork, gone when the
   * session closes. Returns the ref it attached, as `session@commit`.
   */
  attach(ref: string, at: string, opts: AttachOptions = {}): Promise<string> {
    return this.#inner.attach(ref, at, opts)
  }

  /** Unmount what `attach` mounted at `at`. */
  detach(at: string): Promise<void> {
    return this.#inner.detach(at)
  }

  /** What's attached: mount point → ref. */
  attachments(): Record<string, string> {
    return this.#inner.attachments()
  }

  /** @internal The attachment at `at`, with its trace's counts. */
  _held(at: string): Attachment | undefined {
    return this.#inner.held(at)
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
      await writeWithParents(this.#fs, path, data)
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
