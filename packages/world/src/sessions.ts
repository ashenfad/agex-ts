/**
 * Delegation, host-side: fork a session, hand it to a runner, keep the
 * job table. After nontainer's `sessions` module.
 *
 * A subagent is a branch. Everything delegation needs already exists:
 * `fork` gives the child the whole world at a real commit, `merge` and
 * `checkout(ref, {paths})` bring its work back, `diff` says what it
 * touched. What this adds is the calling convention over them: who
 * mints the child's name, who hands it to the loop, who collects the
 * answer, and who makes the child's work mergeable.
 *
 * {@link Sessions} is built by the embedder over a parent workspace and
 * a {@link SessionRunner}, and {@link sessionsTool} exposes it to a
 * model as the `sessions` tool. Two rules earn their place here rather
 * than in the runner:
 *
 * - **The fork point is a commit, and the helper takes it.** `fork`
 *   lands the parent's pending writes first, so the child's base is a
 *   state that existed. The runner is handed that commit (`forkedAt`)
 *   before the first turn, because the provenance header a delegate
 *   arrives with names it.
 * - **Everything a delegate wrote is its answer.** A delegate that
 *   never used ws-git answers at its branch head, where autocommit put
 *   every write. One that committed and then wrote more would answer
 *   with less than it did, so when it answers, the remainder is
 *   committed for it, and the answer names that commit.
 *
 * Delivery is pull: {@link Sessions.ask} returns a {@link Job} and the
 * answer is collected later with {@link Sessions.result}.
 * {@link Sessions.take} is the collection point for an embedder that
 * pushes ({@link answerNotes} hands answers to a turn's inbox), and
 * neither hands over the same answer twice.
 *
 * The job table lives as long as the helper: nothing about a job is
 * written to the store. What survives a restart is the child's branch.
 */

import { SessionExistsError, WorldError } from './errors'
import { type Inbox, type Note, warn } from './inbox'
import { SESSION_ID_RE } from './names'
import type { HostCall } from './profile'
import { repr } from './repr'
import type { Store } from './store'
import { SESSIONS_DESCRIPTION } from './tools/descriptions'
import type { Tool, ToolOutput } from './tools/tools'
import type { Inherit, Workspace } from './workspace'

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

/** What a delegated job can be. `running` until the runner returns;
 *  `answered`, `declined` and `capped` are the runner's own verdicts;
 *  `cancelled` is the caller's; `failed` means the runner threw (or the
 *  answer couldn't be landed); `expired`, that the retention sweep took
 *  its branch. */
export type JobStatus =
  | 'running'
  | 'answered'
  | 'declined'
  | 'capped'
  | 'cancelled'
  | 'failed'
  | 'expired'

/** What a delegate's answer can be: fewer words than a job's, since an
 *  answer exists only once the run is over. */
export type AnswerStatus = 'answered' | 'declined' | 'capped' | 'failed'

/** The paths a delegate changed, grouped as `WorkspaceDiff` groups
 *  them: under what it was seeded with, and everywhere else. A delegate
 *  asked without `paths` was seeded with the whole tree, so `seed`
 *  holds every path it touched. */
export interface Changed {
  readonly seed: readonly string[]
  readonly elsewhere: readonly string[]
}

/** One delegation, as the caller sees it. Pure data: `name` names the
 *  child's branch and is what every later verb takes. Times are
 *  milliseconds since the epoch. */
export interface Job {
  readonly name: string
  /** The task the runner was given, verbatim. */
  readonly task: string
  readonly status: JobStatus
  /** `session@commit` the answer came from; null while it runs. */
  readonly ref: string | null
  /** When the fork was taken, or the task given to a resumed child. */
  readonly started: number
  /** When the answer landed (or the job was cancelled); null while it
   *  runs. An expired job keeps it. */
  readonly finished: number | null
  /** When the caller last dealt with the job: the ask, then `result`,
   *  `take` and `keep`. What {@link Sessions.sweep} measures. */
  readonly touched: number
  /** What the child changed, once it has answered. */
  readonly changed: Changed
  /** Out of the retention sweep for good. */
  readonly kept: boolean
  /** The delegate left work its own ws-git head doesn't hold. */
  readonly uncommitted: boolean
  /** Where the child was forked from when that wasn't the asking
   *  session: the fork point as spelled, and its commit. */
  readonly origin: readonly [string, string] | null
}

/** What a delegate says back, and where to find what it did. Pure
 *  data, and evidence rather than instruction. */
export interface Answer {
  /** The reply, as markdown. */
  readonly text: string
  readonly status: AnswerStatus
  /** `session@commit`: the child at the commit this answer describes. */
  readonly ref: string | null
  /** The child session: the handle for `ws-git merge` / `diff`. */
  readonly branch: string | null
  readonly changed: Changed
  /** `[name, workspace path]` pairs for what the delegate rendered. */
  readonly artifacts: readonly (readonly [string, string])[]
  /** Where the answer came from: the child session and commit, when the
   *  work started and finished, and `chain`, every hop behind it, so an
   *  answer can't launder its sources. A runner's own entries (model,
   *  tokens) are kept. JSON values. */
  readonly provenance: Readonly<Record<string, unknown>>
  /** The delegate left work its last ws-git commit doesn't hold (its
   *  remainder couldn't be committed for it), so a merge of it is
   *  refused. */
  readonly uncommitted: boolean
}

/** What a runner returns: the reply's text, or the parts of an answer
 *  only the runner knows. The host fills in the rest (ref, branch,
 *  changed paths, its share of the provenance). */
export type Reply =
  | string
  | {
      readonly text: string
      readonly status?: AnswerStatus
      readonly artifacts?: readonly (readonly [string, string])[]
      readonly provenance?: Readonly<Record<string, unknown>>
    }

/** What a runner is given beside the session and the task. */
export interface RunOptions {
  /** The ask's budget, or the helper's; the runner interprets it. */
  readonly budget: unknown
  /** The commit the child was forked from: a runner needs it before
   *  the child's first turn, for the header that says who asked. */
  readonly forkedAt: string | null
  /** Aborted when the job is cancelled. */
  readonly signal: AbortSignal
}

/**
 * The loop seam: run this session with this task, and answer. The
 * embedder's, since the world has no model. A runner that throws
 * doesn't lose the job: it resolves as `failed` with the error's text.
 *
 * A reply is the answer only when the child has nothing outstanding: a
 * delegate that ends its turn to wait for its own delegates, or with a
 * note from its caller unread, replies with that waiting. A runner runs
 * the child's turns through {@link untilSettled}, which wakes it until
 * nothing is outstanding.
 */
export interface SessionRunner {
  run(session: string, task: string, opts: RunOptions): Promise<Reply> | Reply
}

/** A refusal: no such job, or an ask the helper won't take. */
export class SessionsError extends WorldError {
  override readonly name: string = 'SessionsError'
}

/** The job has no answer yet: delivery is pull, so this gives the turn
 *  back rather than waiting. */
export class JobRunningError extends SessionsError {
  override readonly name: string = 'JobRunningError'
}

/** The retention sweep took the job's branch. */
export class BranchExpiredError extends SessionsError {
  override readonly name: string = 'BranchExpiredError'
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** What joins a parent's name to a child's: a session id holds no
 *  separator, and a dot keeps the scope visible. */
export const SEPARATOR = '.'

/** How many minted names to try; each miss adds a numeric suffix. */
const MINT_TRIES = 8

const ADJECTIVES = (
  'amber brave brisk calm clever curious dapper eager fond gentle glad ' +
  'keen lucky merry mild noble patient plucky quiet rapid ready sleepy ' +
  'snug solemn spry steady sunny swift tidy vivid warm wise'
).split(' ')
const ANIMALS = (
  'badger bison crane cricket dingo falcon ferret finch gecko heron ibis ' +
  'jackal koala lemur lynx magpie marten mole narwhal otter owl panda ' +
  'puffin quail raven seal shrew stoat tapir tiger walrus wombat'
).split(' ')

/** Two words, hyphenated: a child's name as a person types it. */
export function petName(random: () => number = Math.random): string {
  const pick = (words: readonly string[]) => words[Math.floor(random() * words.length)] as string
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`
}

/** The first non-empty line of a text, without a heading's `#`s, at
 *  most 72 characters. */
function firstLine(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = line
      .trim()
      .replace(/^[# ]+/, '')
      .trim()
    if (stripped !== '') return Array.from(stripped).slice(0, 72).join('')
  }
  return 'delegated work'
}

/** A runner's failure as the caller reads it: the error, named, and no
 *  stack (the frames are the embedder's loop). */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message === '' ? e.name : `${e.name}: ${e.message}`
  return String(e)
}

const NOTHING_CHANGED: Changed = { seed: [], elsewhere: [] }

function answerOf(reply: Reply): Answer {
  const r = typeof reply === 'string' ? { text: reply } : reply
  return {
    text: typeof r.text === 'string' ? r.text : String(r.text),
    status: r.status ?? 'answered',
    ref: null,
    branch: null,
    changed: NOTHING_CHANGED,
    artifacts: r.artifacts ?? [],
    provenance: r.provenance ?? {},
    uncommitted: false,
  }
}

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

export interface SessionsOptions {
  /** Handed to the runner when an ask names none. */
  readonly budget?: unknown
  /** How many runs go at once (default 4); the rest wait their turn. */
  readonly maxWorkers?: number
  /** The provenance this session's own work descends from: a runner
   *  that builds a helper for a delegate passes the delegate's, so an
   *  answer three hops down names every source. */
  readonly chain?: readonly string[]
  /** Called once for every answer recorded, after its job has settled
   *  (collectable, its branch free for a resume). Not for a cancelled
   *  job. One that throws is reported and the job is unaffected. */
  readonly onAnswer?: (name: string, answer: Answer) => unknown
  /** The clock, in milliseconds since the epoch. */
  readonly now?: () => number
}

export interface AskOptions {
  /** A name for the child (scoped as `<session>.<name>`); one already
   *  taken is refused. Left out, a pet name is minted. */
  readonly name?: string
  /** Narrow what the child sees (see `ForkOptions.paths`); `[]` is an
   *  empty view. */
  readonly paths?: readonly string[] | string | null
  /** Whether the conversation at the fork point comes along. Left out:
   *  `'fresh'` from this session, `'full'` from `forkFrom`. */
  readonly inherit?: Inherit
  /** Fork elsewhere: a session as it is now (its bare name), a store
   *  tag, or `session@commit`. A store tag wins over a session of the
   *  same name. */
  readonly forkFrom?: string
  /** Give a new task to a child this session already has: its branch
   *  and conversation kept, no second fork. */
  readonly resume?: string
  /** Wait for the answer and return it, rather than the job. */
  readonly wait?: boolean
  /** This ask's budget, over the helper's. */
  readonly budget?: unknown
  /** Run this job on another runner. */
  readonly runner?: SessionRunner
  /** The code call the ask is made from, for a host method declared
   *  `withCall`: the fork then runs as part of that call, rather than
   *  queueing behind it. */
  readonly call?: HostCall
}

/** The helpers open over each session of each store, oldest first. */
const OPEN = new WeakMap<Store, Map<string, Sessions[]>>()

/**
 * Delegation over one parent workspace: {@link ask}, {@link list},
 * {@link result}, {@link cancel}, {@link keep}, and the push side
 * ({@link take}, {@link wait}, {@link answers}, `onAnswer`).
 *
 * Build it over the parent and close it when the session ends. Closing
 * waits for the runs in flight; the branches stay. While open it is the
 * session's helper, which {@link Sessions.of} finds.
 */
export class Sessions {
  onAnswer: ((name: string, answer: Answer) => unknown) | undefined
  readonly #ws: Workspace
  readonly #runner: SessionRunner
  readonly #budget: unknown
  readonly #maxWorkers: number
  readonly #chain: readonly string[]
  readonly #now: () => number
  readonly #jobs = new Map<string, Job>()
  readonly #answers = new Map<string, Answer>()
  readonly #base = new Map<string, string | null>()
  /** child -> the ref its answer descends from, settled when the ask
   *  resolved the fork point. */
  readonly #sources = new Map<string, string>()
  /** Jobs whose answer landed and hasn't been collected. One mark for
   *  `result` and `take`, so an answer is handed over once. */
  readonly #uncollected = new Set<string>()
  /** Branches with a run in flight, each held by the run (its token)
   *  that reserved it, so a run that ends after a resume took its
   *  branch over doesn't hand that branch away. */
  readonly #busy = new Map<string, number>()
  #token = 0
  /** Runs whose answer was recorded, until `onAnswer` is told. */
  readonly #recorded = new Set<number>()
  readonly #aborts = new Map<number, AbortController>()
  /** Every run not yet settled, each until its own end (its
   *  `onAnswer` included): a resume may start on the branch before an
   *  earlier run has finished announcing. */
  readonly #runs = new Set<Promise<Answer>>()
  /** Branches whose remainder is being committed: past the last check
   *  for a cancel, so a cancel finds the job answering. */
  readonly #landing = new Set<string>()
  readonly #waiters = new Set<() => void>()
  #running = 0
  readonly #slots: (() => void)[] = []
  #closed = false

  constructor(ws: Workspace, runner: SessionRunner, opts: SessionsOptions = {}) {
    this.#ws = ws
    this.#runner = runner
    this.#budget = opts.budget
    this.#maxWorkers = opts.maxWorkers ?? 4
    this.#chain = [...(opts.chain ?? [])]
    this.onAnswer = opts.onAnswer
    this.#now = opts.now ?? Date.now
    const sessions = OPEN.get(ws.store) ?? new Map<string, Sessions[]>()
    OPEN.set(ws.store, sessions)
    sessions.set(ws.session, [...(sessions.get(ws.session) ?? []), this])
  }

  /**
   * The helper delegating for `ws`'s session: the one built last over
   * it that isn't closed, or null. A host object built for a world
   * finds it at the call, so its jobs are the world's delegates.
   */
  static of(ws: Workspace): Sessions | null {
    const helpers = OPEN.get(ws.store)?.get(ws.session) ?? []
    for (const helper of [...helpers].reverse()) if (!helper.closed) return helper
    return null
  }

  /** The session this helper delegates for. */
  get session(): string {
    return this.#ws.session
  }

  /** Whether {@link close} has begun: a closed helper asks nothing more,
   *  and a wait on it ends at once. */
  get closed(): boolean {
    return this.#closed
  }

  toString(): string {
    const jobs = [...this.#jobs.values()]
    const running = jobs.filter((j) => j.status === 'running').length
    return `<sessions of ${repr(this.#ws.session)}: ${jobs.length} job(s), ${running} running>`
  }

  // -- the verbs ------------------------------------------------------------

  /**
   * Delegate `task` to a fork of this session: the {@link Job} at once,
   * or with `wait`, the {@link Answer} once the runner is done.
   *
   * The child is a fork under a name scoped to this session
   * (`parent.sleepy-otter`), taken at a real commit: pending writes
   * here land first, and that commit is the merge base. An empty
   * `paths` forks from the last commit, landing nothing. Whatever the
   * child does stays on its branch: merging it, taking files from it
   * or leaving it is the caller's step.
   */
  ask(task: string, opts: AskOptions & { readonly wait: true }): Promise<Answer>
  ask(task: string, opts?: AskOptions & { readonly wait?: false }): Promise<Job>
  ask(task: string, opts?: AskOptions): Promise<Job | Answer>
  async ask(task: string, opts: AskOptions = {}): Promise<Job | Answer> {
    this.#checkOpen()
    const runner = opts.runner ?? this.#runner
    const started = this.#now()
    const inherit =
      opts.inherit ?? (opts.forkFrom !== undefined && opts.resume === undefined ? 'full' : 'fresh')
    if (inherit !== 'fresh' && opts.resume !== undefined) {
      throw new SessionsError(
        "inherit must be 'fresh' when resuming: a child resumed keeps the conversation it already has, and there is no second fork to seed. A brief is content the task carries",
      )
    }
    let name: string
    let base: string | null
    let origin: readonly [string, string] | null
    if (opts.resume !== undefined) {
      const previous = this.#resumed(opts.resume, opts.forkFrom)
      name = previous.name
      base = null
      origin = previous.origin
    } else {
      let source: string | null = null
      origin = null
      if (opts.forkFrom !== undefined) {
        const [given, commit, from] = await this.#origin(opts.forkFrom)
        origin = [given, commit]
        source = from
      }
      ;[name, base] = await this.#fork(opts.name, {
        paths: opts.paths,
        inherit,
        at: origin?.[1],
        call: opts.call,
      })
      if (source !== null) this.#sources.set(name, source)
    }
    const job: Job = {
      name,
      task,
      status: 'running',
      ref: null,
      started,
      finished: null,
      touched: started,
      changed: NOTHING_CHANGED,
      kept: false,
      uncommitted: false,
      origin,
    }
    const [installed, run] = this.#submit(job, base, opts.budget ?? this.#budget, {
      resuming: opts.resume !== undefined,
      runner,
    })
    if (opts.wait === true) {
      await run
      return this.result(name)
    }
    return installed
  }

  /** Every job this session has asked for, oldest first. */
  list(): Job[] {
    return [...this.#jobs.values()].sort(
      (a, b) => a.started - b.started || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
  }

  /**
   * The answer for job `name` (or the child scoped under it). Reading
   * it touches the job: a delegate whose answer is read every turn is
   * in use, however long ago its run ended.
   *
   * @throws JobRunningError while it runs.
   * @throws BranchExpiredError once the sweep has taken its branch.
   * @throws SessionsError for no such job, or a cancelled one.
   */
  result(asked: string): Answer {
    const name = this.#resolve(asked)
    const job = this.#jobs.get(name)
    if (job === undefined) throw new SessionsError(this.#unknown(name))
    if (job.status === 'running') {
      throw new JobRunningError(
        `job ${repr(name)} is still running; ask again on a later turn (sessions list shows what is outstanding)`,
      )
    }
    if (job.status === 'expired') {
      throw new BranchExpiredError(
        `job ${repr(name)} expired: its branch was swept after going unread long enough for the retention sweep to take it, so there is nothing left to read. Ask again (sessions ask), and keep the next one (sessions keep) if it should outlive that.`,
      )
    }
    const answer = this.#answers.get(name)
    if (answer === undefined) {
      throw new SessionsError(
        `job ${repr(name)} was cancelled, so its answer was discarded. The branch is still there as the delegate left it: ws-git diff ${name} shows what it had done.`,
      )
    }
    this.#uncollected.delete(name)
    this.#jobs.set(name, { ...job, touched: this.#now() })
    return answer
  }

  /**
   * Every answer that landed and hasn't been collected, as `[name,
   * answer]` pairs in landing order, each touched and marked collected
   * as {@link result} marks it. Never waits.
   */
  take(): [string, Answer][] {
    const now = this.#now()
    const taken: [string, Answer][] = []
    for (const name of this.#landingOrder([...this.#uncollected])) {
      this.#uncollected.delete(name)
      const job = this.#jobs.get(name)
      const answer = this.#answers.get(name)
      if (job === undefined || answer === undefined || job.status === 'expired') continue
      this.#jobs.set(name, { ...job, touched: now })
      taken.push([name, answer])
    }
    return taken
  }

  /** The jobs not heard the end of: running, or answered and not
   *  collected. Oldest ask first. */
  outstanding(): string[] {
    return this.list()
      .filter(
        (job) =>
          job.status === 'running' || (this.#uncollected.has(job.name) && job.status !== 'expired'),
      )
      .map((job) => job.name)
  }

  /**
   * Wait until an answer is waiting to be collected, or no job is
   * running; the names with an answer waiting, in landing order. Collects
   * nothing. Empty when there was nothing to wait for, `timeout`
   * milliseconds passed, or the helper closed.
   */
  async wait(timeout?: number): Promise<string[]> {
    const deadline = timeout === undefined ? null : Date.now() + timeout
    for (;;) {
      const ready = this.#ready()
      if (ready.length > 0 || !this.#waiting()) return ready
      const left = deadline === null ? null : deadline - Date.now()
      if (left !== null && left <= 0) return []
      await this.#news(left)
    }
  }

  /** Every answer as it lands, as `[name, answer]` pairs, for as long as
   *  the helper is open; each collected as {@link take} collects it. */
  async *answers(): AsyncGenerator<[string, Answer]> {
    for (;;) {
      const closed = this.#closed
      const news = this.#news(null)
      for (const pair of this.take()) yield pair
      if (closed) return
      await news
    }
  }

  /** The commit job `name` was forked from: the merge base for its
   *  work. Recorded here, so an expired job still answers. */
  base(name: string): string | null {
    if (!this.#jobs.has(name)) throw new SessionsError(this.#unknown(name))
    return this.#base.get(name) ?? null
  }

  /**
   * Stop caring about job `name`; returns the job. Its answer is
   * discarded, and its run's signal aborted: the branch is free once
   * the runner has stopped. Nothing is committed for it and nothing
   * deleted. A job that has already answered comes back unchanged, and
   * so does one whose answer is being landed, its remainder already
   * being committed: still `running`, about to answer. A cancel either
   * wins outright or finds the job answering.
   */
  cancel(asked: string): Job {
    const name = this.#resolve(asked)
    let job = this.#jobs.get(name)
    if (job === undefined) throw new SessionsError(this.#unknown(name))
    if (job.status !== 'running' || this.#landing.has(name)) return job
    job = { ...job, status: 'cancelled', finished: this.#now() }
    this.#jobs.set(name, job)
    const token = this.#busy.get(name)
    if (token !== undefined) this.#aborts.get(token)?.abort()
    this.#notify()
    return job
  }

  /**
   * Exempt job `name` from the retention sweep, for good; returns it.
   *
   * @throws BranchExpiredError once the sweep has taken its branch.
   */
  keep(asked: string): Job {
    const name = this.#resolve(asked)
    const job = this.#jobs.get(name)
    if (job === undefined) throw new SessionsError(this.#unknown(name))
    if (job.status === 'expired') {
      throw new BranchExpiredError(
        `job ${repr(name)} expired: its branch was already swept, so there is nothing to keep. Ask again (sessions ask) and keep the new job while its answer is fresh.`,
      )
    }
    const kept = { ...job, kept: true, touched: this.#now() }
    this.#jobs.set(name, kept)
    return kept
  }

  /**
   * Delete the branches of jobs left untouched for `idle` seconds; the
   * names swept, sorted. The embedder schedules it (beside
   * `store.clean()`); nothing calls it on the way past.
   *
   * A branch goes when its job has finished, no run holds it, it isn't
   * kept, and the job was last touched `idle` seconds ago or more. The
   * job's row stays, `expired`, and its answer goes. Only this
   * helper's own jobs: a delegate's delegates are its helper's.
   *
   * @param opts.minAge `store.delete`'s grace for orphan commits, in
   *   seconds.
   */
  async sweep(idle: number, opts: { minAge?: number } = {}): Promise<string[]> {
    const cutoff = this.#now() - idle * 1000
    const names = [...this.#jobs.values()]
      .filter(
        (job) =>
          job.status !== 'running' &&
          job.status !== 'expired' &&
          !this.#busy.has(job.name) &&
          !job.kept &&
          job.touched <= cutoff,
      )
      .map((job) => job.name)
      .sort()
    if (names.length === 0) return []
    // Marked before the delete, in one step, so a resume can't start
    // on a branch being deleted; put back if the delete fails.
    const before = names.map(
      (name) =>
        [
          name,
          this.#jobs.get(name) as Job,
          this.#answers.get(name),
          this.#uncollected.has(name),
        ] as const,
    )
    for (const name of names) {
      this.#answers.delete(name)
      this.#uncollected.delete(name)
      this.#jobs.set(name, { ...(this.#jobs.get(name) as Job), status: 'expired' })
    }
    try {
      await this.#ws.store.delete(names, opts.minAge === undefined ? {} : { minAge: opts.minAge })
    } catch (e) {
      for (const [name, job, answer, uncollected] of before) {
        this.#jobs.set(name, job)
        if (answer !== undefined) this.#answers.set(name, answer)
        if (uncollected) this.#uncollected.add(name)
      }
      throw e
    }
    return names
  }

  /** Stop taking asks and wait for the runs in flight. The branches
   *  stay. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#notify()
    const helpers = OPEN.get(this.#ws.store)
    const left = (helpers?.get(this.#ws.session) ?? []).filter((h) => h !== this)
    if (left.length > 0) helpers?.set(this.#ws.session, left)
    else helpers?.delete(this.#ws.session)
    await Promise.allSettled([...this.#runs])
  }

  // -- internals ------------------------------------------------------------

  #checkOpen(): void {
    if (this.#closed) {
      throw new SessionsError(
        `the sessions helper for ${repr(this.#ws.session)} is closed; no new job can be asked`,
      )
    }
  }

  /** The job `name` means: itself, or the child scoped under it. */
  #resolve(asked: string): string {
    const name = String(asked).trim()
    if (this.#jobs.has(name)) return name
    const scoped = `${this.#ws.session}${SEPARATOR}${name}`
    return this.#jobs.has(scoped) ? scoped : name
  }

  #unknown(name: string): string {
    const known = [...this.#jobs.keys()].sort().join(', ') || 'none'
    return `no job named ${repr(name)} on session ${repr(this.#ws.session)} (have: ${known})`
  }

  #landingOrder(names: string[]): string[] {
    const finished = (n: string) => this.#jobs.get(n)?.finished ?? 0
    return names.sort((a, b) => finished(a) - finished(b) || (a < b ? -1 : a > b ? 1 : 0))
  }

  #ready(): string[] {
    return this.#landingOrder(
      [...this.#uncollected].filter(
        (n) => this.#jobs.get(n)?.status !== 'expired' && this.#answers.has(n),
      ),
    )
  }

  /** Whether there's anything to wait for: a job running, on a helper
   *  still open. */
  #waiting(): boolean {
    return !this.#closed && [...this.#jobs.values()].some((j) => j.status === 'running')
  }

  /** Settles on the next news (an answer, a cancel, a close), or after
   *  `ms` milliseconds. */
  #news(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = () => {
        if (timer !== undefined) clearTimeout(timer)
        this.#waiters.delete(wake)
        resolve()
      }
      this.#waiters.add(wake)
      if (ms !== null) timer = setTimeout(wake, ms)
    })
  }

  #notify(): void {
    for (const wake of [...this.#waiters]) wake()
  }

  /**
   * `[the child's name, the fork point]`. The fork is the authority on
   * collision, since a branch may exist that no job here remembers. A
   * name the caller gave is refused when taken, not suffixed: every
   * later verb spelled with it would go to the wrong child.
   */
  async #fork(
    name: string | undefined,
    opts: {
      paths: AskOptions['paths']
      inherit: Inherit
      at: string | undefined
      call: HostCall | undefined
    },
  ): Promise<[string, string | null]> {
    const minted = name === undefined
    const wanted = name ?? petName()
    const parent = opts.call?.ws ?? this.#ws
    const paths =
      opts.paths === undefined || opts.paths === null
        ? undefined
        : typeof opts.paths === 'string'
          ? [opts.paths]
          : opts.paths
    let candidate = ''
    for (let attempt = 0; attempt < (minted ? MINT_TRIES : 1); attempt++) {
      candidate = this.#scoped(wanted, attempt)
      try {
        const child = await parent.fork(candidate, {
          inherit: opts.inherit,
          ...(opts.at !== undefined && { at: opts.at }),
          ...(paths !== undefined && { paths }),
        })
        await child.close()
        return [candidate, opts.at ?? parent.head]
      } catch (e) {
        if (!(e instanceof SessionExistsError)) throw e
        if (!minted) {
          throw new SessionsError(
            `session ${repr(candidate)} already exists, so name=${repr(wanted)} cannot start a new child there. To give that child its next task, resume=${repr(wanted)}; to start another one, ask under a different name or leave name off and take a minted one.`,
            { cause: e },
          )
        }
      }
    }
    throw new SessionsError(
      `could not mint a free name for a child of ${repr(this.#ws.session)} in ${MINT_TRIES} tries (last: ${repr(candidate)})`,
    )
  }

  /** `parent.pet`, and `.2`, `.3`… past attempt zero. */
  #scoped(wanted: string, attempt: number): string {
    let candidate = `${this.#ws.session}${SEPARATOR}${wanted}`
    if (attempt > 0) candidate = `${candidate}${SEPARATOR}${attempt + 1}`
    if (!SESSION_ID_RE.test(candidate)) {
      throw new SessionsError(
        `${repr(wanted)} cannot name a child session: ${repr(candidate)} is not a session id (letters, digits, '_', '-' and '.', and a session id is a branch name, so it holds no separators)`,
      )
    }
    return candidate
  }

  /**
   * Reserve the job's branch, install the job, and start its run, in
   * one step with no await, so two callers resuming one child can't
   * both find it free. A resumed job keeps what belongs to the child
   * (its origin, its base, whether it's kept) and replaces what belongs
   * to the run.
   */
  #submit(
    asked: Job,
    forked: string | null,
    budget: unknown,
    opts: { resuming: boolean; runner: SessionRunner },
  ): [Job, Promise<Answer>] {
    const name = asked.name
    this.#checkOpen()
    if (this.#busy.has(name)) throw new SessionsError(this.#stillRunning(name))
    let job = asked
    let base = forked
    if (opts.resuming) {
      const current = this.#jobs.get(name)
      if (current !== undefined) {
        job = { ...job, kept: current.kept, origin: job.origin ?? current.origin }
      }
      if (this.#base.has(name)) base = this.#base.get(name) ?? null
    }
    const token = ++this.#token
    this.#busy.set(name, token)
    this.#jobs.set(name, job)
    this.#answers.delete(name)
    this.#uncollected.delete(name)
    this.#base.set(name, base)
    const abort = new AbortController()
    this.#aborts.set(token, abort)
    const run = this.#work(name, job.task, budget, token, opts.runner, abort.signal)
    this.#runs.add(run)
    void run.finally(() => this.#runs.delete(run))
    return [job, run]
  }

  #stillRunning(name: string): string {
    return `a run on ${repr(name)} is still finishing; ask again on a later turn. A delegate does one task at a time (sessions list shows what is outstanding)`
  }

  /** Free a branch, if this run is the one still holding it. */
  #release(name: string, token: number): void {
    if (this.#busy.get(name) === token) this.#busy.delete(name)
  }

  /** The job a resume continues. A child carries the conversation of
   *  the state it was forked from, so it answers from there alone. */
  #resumed(asked: string, forkFrom: string | undefined): Job {
    const resume = this.#resolve(asked)
    const job = this.#jobs.get(resume)
    if (job === undefined) throw new SessionsError(this.#unknown(resume))
    if (job.status === 'expired') {
      throw new BranchExpiredError(
        `${repr(resume)} expired: its branch was swept, so there is nothing to resume — a resume continues a child, and the child is the branch. Ask afresh (sessions ask), and keep the next one (sessions keep) if it should outlive the sweep.`,
      )
    }
    // In flight, which isn't what the status says: a cancelled job's
    // run holds its branch until the runner stops.
    if (this.#busy.has(resume)) throw new SessionsError(this.#stillRunning(resume))
    if (forkFrom !== undefined) {
      const given = forkFrom.trim()
      if (job.origin === null) {
        throw new SessionsError(
          `${repr(resume)} was forked from this session, not from ${repr(given)}: leave the fork point out to continue it, or ask afresh from ${repr(given)}`,
        )
      }
      if (given !== job.origin[0]) {
        throw new SessionsError(
          `${repr(resume)} was forked from ${repr(job.origin[0])} and carries that state's conversation, so it cannot answer from ${repr(given)}: leave the fork point out to continue it, or ask afresh from ${repr(given)}`,
        )
      }
    }
    return job
  }

  /**
   * `[the fork point as spelled, its commit, the ref an answer from
   * there descends from]`. `session@commit` resolves as every
   * cross-session read does; a bare name is a store tag, else a session
   * as it is now. The third part is settled now: a tag or session made
   * or removed during the run would otherwise change it.
   */
  async #origin(forkFrom: string): Promise<[string, string, string]> {
    const given = String(forkFrom).trim()
    if (given === '') {
      throw new SessionsError(
        "a fork point must be named: a store tag, or a 'session@commit' ref. Leave it out to fork this session",
      )
    }
    const store = this.#ws.store
    const at = given.lastIndexOf('@')
    if (at > 0) {
      const { commit } = await this.#ws.resolveRef(given)
      return [given, commit, `${given.slice(0, at)}@${commit}`]
    }
    const tags = await store.tags.list()
    const tagged = tags.get(given)
    if (tagged !== undefined) return [given, tagged, tagged]
    if (await store.exists(given)) {
      const head = await store.repo.branches.get(given)
      return [given, head, `${given}@${head}`]
    }
    const known = [...tags.keys()].sort().join(', ') || 'none'
    const sessions = await store.sessions()
    const shown = sessions.slice(0, 12).join(', ') + (sessions.length > 12 ? ' …' : '')
    throw new SessionsError(
      `nothing named ${repr(given)} on this store (sessions: ${shown || 'none'}; store tags: ${known}). A fork point is a session (as it is now), a store tag, or a commit spelled 'session@commit'`,
    )
  }

  async #acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    if (this.#running < this.#maxWorkers) {
      this.#running += 1
      return true
    }
    return new Promise((resolve) => {
      const go = () => {
        signal.removeEventListener('abort', stop)
        this.#running += 1
        resolve(true)
      }
      const stop = () => {
        const i = this.#slots.indexOf(go)
        if (i >= 0) this.#slots.splice(i, 1)
        resolve(false)
      }
      this.#slots.push(go)
      signal.addEventListener('abort', stop, { once: true })
    })
  }

  #releaseSlot(): void {
    this.#running -= 1
    this.#slots.shift()?.()
  }

  /** The run, then the landing. Never throws: a job that can't resolve
   *  is one its caller waits on forever. */
  async #work(
    name: string,
    task: string,
    budget: unknown,
    token: number,
    runner: SessionRunner,
    signal: AbortSignal,
  ): Promise<Answer> {
    try {
      let answer: Answer
      const stopped = () => answerOf({ text: 'the run was stopped', status: 'failed' })
      if (!(await this.#acquire(signal))) {
        answer = stopped()
      } else {
        try {
          const forkedAt = this.#base.get(name) ?? null
          answer = answerOf(await runner.run(name, task, { budget, forkedAt, signal }))
        } catch (e) {
          answer = signal.aborted ? stopped() : answerOf({ text: errorText(e), status: 'failed' })
        } finally {
          this.#releaseSlot()
        }
      }
      return await this.#settle(name, answer, token)
    } finally {
      this.#aborts.delete(token)
      // However it went, including ways that record no answer: freed
      // only while it's still this run's to free.
      this.#release(name, token)
    }
  }

  /** Land the answer and announce it. A failure to land is the answer
   *  plus what went wrong. */
  async #settle(name: string, answer: Answer, token: number): Promise<Answer> {
    let settled: Answer
    try {
      settled = await this.#land(name, answer, token)
    } catch (e) {
      settled = {
        ...answer,
        status: 'failed',
        text: `${answer.text}\n\n[the delegate answered, and its work could not be landed: ${errorText(e)}]`,
        branch: name,
      }
      this.#record(name, settled, token)
    }
    await this.#announce(name, settled, token)
    return settled
  }

  async #announce(name: string, answer: Answer, token: number): Promise<void> {
    if (!this.#recorded.delete(token)) return
    if (this.onAnswer === undefined) return
    try {
      await this.onAnswer(name, answer)
    } catch (e) {
      warn(`sessions: onAnswer threw for ${name}`, e)
    }
  }

  /**
   * Say what the delegate did, and record the answer. The runner drove
   * the child through a handle of its own, so the branch is opened
   * afresh here; nothing is committed for the child but its remainder.
   */
  async #land(name: string, answer: Answer, token: number): Promise<Answer> {
    if (this.#jobs.get(name)?.status === 'cancelled') return answer
    const store = this.#ws.store
    if (!(await store.exists(name))) {
      throw new SessionsError(`the branch ${repr(name)} is gone`)
    }
    // The parent's root and ignore patterns: what counts as work is
    // judged by them.
    const child = await store.open(name, { root: this.#ws.root, ignore: this.#ws.ignore })
    try {
      await this.#commitRemainder(name, child)
      const commit = (await child.index.head()) ?? child.head
      const base = this.#base.get(name) ?? null
      const landed: Answer = {
        ...answer,
        ref: `${child.session}@${commit}`,
        branch: child.session,
        changed: await this.#changed(base, child),
        uncommitted:
          (await child.index.sourceState(child.session, child.head)).uncommitted.length > 0,
        provenance: await this.#provenance(answer, child, name, base, commit),
      }
      this.#record(name, landed, token)
      return landed
    } finally {
      await child.close()
    }
  }

  /**
   * Commit what the delegate wrote past its own last ws-git commit, so
   * its answer is everything it did. Only a delegate that used ws-git
   * has a remainder. Not while a merge of its own is unresolved: its
   * markers would reach the caller unannounced. That remainder, or one
   * that fails to commit, is left, and the answer says so.
   */
  async #commitRemainder(name: string, child: Workspace): Promise<void> {
    if ((await child.index.head()) === null) return
    try {
      const status = await child.index.status()
      if (status.staged.length === 0 && status.unstaged.length === 0) return
      if (status.mergeUnresolved.length > 0) return
      // The last check for a cancel, and the guard against one, in one
      // step: a cancel that came while the branch was being read wins,
      // and one that comes from here on finds the job answering.
      if (this.#jobs.get(name)?.status === 'cancelled') return
      this.#landing.add(name)
      try {
        if (status.unstaged.length > 0) await child.index.stage(status.unstaged)
        await child.index.commit(
          'Work the delegate had not committed when it answered, committed by the delegation mechanism',
          { info: { committedFor: name } },
        )
      } finally {
        this.#landing.delete(name)
      }
    } catch (e) {
      warn(`sessions: could not commit what ${name} left uncommitted`, e)
    }
  }

  /**
   * The child's changed paths, grouped seed vs elsewhere: from where the
   * two last met (the fork point, until the parent merges the child)
   * to the child's head. A meeting point that isn't past the fork (a
   * child forked from elsewhere) leaves the fork point.
   */
  async #changed(base: string | null, child: Workspace): Promise<Changed> {
    if (base === null) return NOTHING_CHANGED
    const repo = this.#ws.store.repo
    const head = child.head
    let start = base
    const ours = await this.#parentHead()
    if (ours !== null) {
      const met = await repo.mergeBase(ours, head)
      if (met !== null && met !== base && (await repo.mergeBase(base, met)) === base) start = met
    }
    const diff = await child.diff(start, head)
    return { seed: diff.inSeed, elsewhere: diff.elsewhere }
  }

  /** This session's commit as the store has it now. */
  async #parentHead(): Promise<string | null> {
    const repo = this.#ws.store.repo
    return (await repo.branches.has(this.#ws.session))
      ? await repo.branches.get(this.#ws.session)
      : null
  }

  /**
   * Where the answer came from; the runner's own entries are kept.
   * `chain` is every hop: where the child came from (this session at
   * the fork, or the fork point it was given), then the child at its
   * answer, behind the chain this session's own work carries.
   */
  async #provenance(
    answer: Answer,
    child: Workspace,
    name: string,
    base: string | null,
    commit: string,
  ): Promise<Record<string, unknown>> {
    const job = this.#jobs.get(name) as Job
    const source =
      job.origin !== null
        ? (this.#sources.get(name) ?? job.origin[1])
        : base !== null
          ? `${this.#ws.session}@${base}`
          : null
    const hop = [...(source !== null ? [source] : []), `${child.session}@${commit}`]
    const extra: Record<string, unknown> = {}
    if (job.origin !== null) {
      extra.from = job.origin[0]
      // A fork point outside this session's history: a merge would
      // bring that state's files too.
      const ours = await this.#parentHead()
      const holds =
        ours !== null &&
        (await this.#ws.store.repo.mergeBase(job.origin[1], ours)) === job.origin[1]
      if (!holds) extra.outside = true
    }
    return {
      ...answer.provenance,
      session: child.session,
      commit,
      started: job.started,
      finished: this.#now(),
      chain: [...this.#chain, ...hop],
      ...extra,
    }
  }

  /** Store the answer and close the job out, unless it was cancelled
   *  first: the check and the write are one step. */
  #record(name: string, answer: Answer, token: number): void {
    const job = this.#jobs.get(name)
    if (job === undefined || job.status === 'cancelled') return
    // Freed with the answer: a caller that reads a finished status can
    // give the child its next task at once.
    this.#release(name, token)
    this.#answers.set(name, answer)
    this.#uncollected.add(name)
    this.#recorded.add(token)
    this.#jobs.set(name, {
      ...job,
      status: answer.status,
      ref: answer.ref,
      finished: this.#now(),
      changed: answer.changed,
      uncommitted: answer.uncommitted,
    })
    this.#notify()
  }
}

// ---------------------------------------------------------------------------
// Settling: a delegate answers once nothing it waits on is outstanding
// ---------------------------------------------------------------------------

/** How often a settling loop looks at the inbox while it waits, in
 *  milliseconds: notes have no wait of their own. */
export const POLL = 500

/** How a delegate's turns ended. */
export interface Settled {
  /** Its last reply. */
  readonly reply: string
  /** The woken turns it took. */
  readonly wakes: number
  /** The delegates of its own it hadn't heard back from. */
  readonly unread: readonly string[]
  /** Notes left undelivered. */
  readonly notes: number
  /** The reply as an answer: as it is, or saying which delegates it
   *  answered without. */
  readonly text: string
}

function settled(reply: string, wakes: number, unread: readonly string[], notes: number): Settled {
  const text =
    unread.length === 0
      ? reply
      : `${reply}\n\n[answered before hearing back from ${unread.join(', ')}, whose work is on their own branches]`
  return { reply, wakes, unread, notes, text }
}

/**
 * Run a delegate's turns until nothing it waits on is outstanding.
 *
 * `runTurn(prompt)` runs one turn and returns its reply; `runTurn(null)`
 * is a woken turn, which opens with what is waiting to be delivered
 * (`turn.opening()`). After each reply the delegate is settled when its
 * own delegates have nothing outstanding and its inbox holds no note: a
 * reply given while either is pending is the delegate waiting. While
 * its delegates run, it waits for an answer, looking at the inbox every
 * `poll` milliseconds; then it wakes the delegate to read what came.
 * `maxWakes` bounds the woken turns, and a closed helper ends the wait
 * the same way: the last reply, naming what was left outstanding.
 */
export async function untilSettled(
  runTurn: (prompt: string | null) => Promise<string>,
  sessions: Sessions | null,
  inbox: Inbox | null,
  opts: { readonly prompt: string; readonly maxWakes?: number; readonly poll?: number },
): Promise<Settled> {
  const maxWakes = opts.maxWakes ?? 10
  const poll = opts.poll ?? POLL
  const spent = (reply: string, wakes: number, outstanding: string[]) =>
    settled(reply, wakes, outstanding, inbox?.pending().length ?? 0)
  let reply = await runTurn(opts.prompt)
  let wakes = 0
  for (;;) {
    const pending = inbox !== null && inbox.pending().length > 0
    const outstanding = sessions?.outstanding() ?? []
    if (!pending && outstanding.length === 0) return settled(reply, wakes, [], 0)
    if (wakes >= maxWakes) return spent(reply, wakes, outstanding)
    const ready = sessions === null ? [] : await sessions.wait(0)
    if (!pending && ready.length === 0) {
      if (sessions === null || sessions.closed) return spent(reply, wakes, outstanding)
      await sessions.wait(poll)
      continue
    }
    reply = await runTurn(null)
    wakes += 1
  }
}

// ---------------------------------------------------------------------------
// The tool half: what a model sends, and what it reads back
// ---------------------------------------------------------------------------

/**
 * A loosely typed `paths` argument, normalized: models send a list as a
 * JSON string often, and one path as a bare string.
 *
 * @throws SessionsError for anything else, in words a model can act on.
 */
export function coercePaths(paths: unknown): string[] | null {
  if (paths === null || paths === undefined || paths === '') return null
  let value = paths
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('[')) return [text]
    try {
      value = JSON.parse(text)
    } catch (e) {
      throw new SessionsError(`paths must be a JSON list of paths (${errorText(e)})`)
    }
  }
  if (Array.isArray(value) && value.every((p) => typeof p === 'string')) {
    return value.filter((p) => p !== '')
  }
  throw new SessionsError(
    `paths must be a list of workspace paths like ["report.md", "src/"] — got ${Array.isArray(value) ? 'a list with non-strings' : typeof value}`,
  )
}

/** The line a caller reads when a delegate is sent off. */
export function renderJob(job: Job): string {
  const where = job.origin !== null ? `, forked from ${job.origin[0]}` : ''
  return `delegated to ${job.name}${where}: ${firstLine(job.task)}\nthe answer arrives on a later turn; \`sessions list\` shows progress and \`sessions result ${job.name}\` collects it.`
}

/** Every job, one per line. */
export function renderJobs(jobs: readonly Job[]): string {
  if (jobs.length === 0) {
    return 'no delegated jobs yet. `sessions ask` with a task forks this session and puts an agent on it.'
  }
  const lines = [`${jobs.length} job(s):`]
  for (const job of jobs) {
    let line = `  ${job.name}  ${job.status}  ${firstLine(job.task)}`
    if (job.status === 'running') line += '  (no answer yet)'
    else if (job.status === 'expired') line += '  (branch swept; sessions ask to run it again)'
    else {
      const paths = job.changed.seed.length + job.changed.elsewhere.length
      line += `  (${paths} path(s); sessions result ${job.name})`
      if (job.uncommitted) line += ' [left work uncommitted]'
    }
    if (job.origin !== null) line += ` [from ${job.origin[0]}]`
    if (job.kept) line += ' [kept]'
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * The delegate's reply, then what it changed, then the terminal verb
 * that brings the work back: the order the decision is made in.
 */
export function renderAnswer(answer: Answer): string {
  const name = answer.branch ?? 'the delegate'
  const { seed, elsewhere } = answer.changed
  const at = answer.ref === null ? '' : ` at ${answer.ref}`
  const lines = [answer.text.trimEnd(), '', `-- ${name} ${answer.status}${at}`]
  if (seed.length === 0 && elsewhere.length === 0) {
    lines.push('it changed no files; its answer is the whole result.')
    return lines.join('\n')
  }
  if (seed.length > 0) lines.push(`changed, in what you sent it to do: ${seed.join(', ')}`)
  if (elsewhere.length > 0) lines.push(`changed, elsewhere: ${elsewhere.join(', ')}`)
  if (answer.uncommitted) {
    lines.push(
      `${name} left work uncommitted, so what it committed is not everything it did; ws-git merge will refuse it — take paths with ws-git checkout ${name} -- <paths>, or ask again.`,
    )
  } else if (answer.provenance.outside === true) {
    const source = String(answer.provenance.from ?? 'another session')
    lines.push(
      `next, in the terminal: ws-git diff ${name} --stat (what it touched), then ws-git diff ${name} -- <paths> (read it) | ws-git checkout ${name} -- <paths> (take it). It began at ${source}, which your history does not hold: ws-git merge ${name} would bring ${source}'s files too`,
    )
  } else {
    lines.push(
      `next, in the terminal: ws-git diff ${name} --stat (what it touched), then ws-git diff ${name} -- <paths> (read it) | ws-git merge ${name} (take all of it) | ws-git checkout ${name} -- <paths> (take some)`,
    )
  }
  return lines.join('\n')
}

/**
 * Every delegate answer landed since the last collection, as notes
 * being delivered (`inbox.deliverNow`), in landing order: framed as the
 * mechanism, since an answer is prose another model wrote. A turn takes
 * it as a source: `ws.turn(id, {inbox, sources: [(inbox) =>
 * answerNotes(sessions, inbox)]})`.
 */
export function answerNotes(sessions: Pick<Sessions, 'take'>, inbox: Inbox): Note[] {
  return sessions.take().map(([name, answer]) =>
    inbox.deliverNow(renderAnswer(answer), {
      kind: 'mechanism',
      label: `delegate ${name}`,
      job: name,
      answer,
    }),
  )
}

/** One `sessions` tool call's arguments, as the model sends them. */
export interface SessionsArgs {
  readonly action: string
  readonly task?: string
  readonly name?: string
  readonly paths?: unknown
  readonly inherit?: string
  readonly fork_from?: string
  readonly resume?: string
  readonly wait?: boolean
}

/**
 * Dispatch one `sessions` tool call and render its result. Every
 * refusal is text rather than an error: "no job named x" is something
 * a model can act on.
 */
export async function runAction(sessions: Sessions, args: SessionsArgs): Promise<string> {
  return (await act(sessions, args)).text
}

/** {@link runAction}, saying whether the call was refused. A job with
 *  no answer yet isn't a refusal: it says when to ask again. */
async function act(
  sessions: Sessions,
  args: SessionsArgs,
): Promise<{ text: string; isError: boolean }> {
  const ok = (text: string) => ({ text, isError: false })
  const refused = (text: string) => ({ text, isError: true })
  let action = String(args.action ?? '')
  let name = String(args.name ?? '')
  let resume = String(args.resume ?? '')
  const task = String(args.task ?? '')
  const inherit = String(args.inherit ?? '')
  const forkFrom = String(args.fork_from ?? '')
  try {
    if (action === 'resume') {
      // What the description's `resume=<name>` reads as to a model that
      // has an action to fill in.
      resume = resume || name
      if (resume.trim() === '') {
        return refused(
          'sessions resume needs the delegate\'s name: action="ask", resume="<name>", task="..."',
        )
      }
      action = 'ask'
      name = ''
    }
    if (action === 'ask') {
      if (task.trim() === '')
        return refused('sessions ask needs a task: what should the delegate do?')
      if (inherit !== '' && inherit !== 'full' && inherit !== 'fresh') {
        throw new SessionsError(`inherit is 'full' or 'fresh', not ${repr(inherit)}`)
      }
      const paths = coercePaths(args.paths)
      const out = await sessions.ask(task, {
        ...(name !== '' && { name }),
        ...(paths !== null && { paths }),
        ...(inherit !== '' && { inherit: inherit as Inherit }),
        ...(forkFrom !== '' && { forkFrom }),
        ...(resume !== '' && { resume }),
        wait: args.wait === true,
      })
      return ok('task' in out ? renderJob(out) : renderAnswer(out))
    }
    if (action === 'list') return ok(renderJobs(sessions.list()))
    if (action === 'result' || action === 'cancel' || action === 'keep') {
      if (name.trim() === '') {
        return refused(`sessions ${action} needs a name (\`sessions list\` has them).`)
      }
      if (action === 'result') return ok(renderAnswer(sessions.result(name)))
      // The job's own name in what follows: ws-git knows no short one.
      if (action === 'cancel') {
        const job = sessions.cancel(name)
        if (job.status === 'running') {
          return ok(
            `${job.name} is already answering: its work is being landed, so there is nothing to stop.`,
          )
        }
        if (job.status !== 'cancelled') {
          return ok(`${job.name} had already finished (${job.status}); nothing to stop.`)
        }
        return ok(
          `${job.name} cancelled: its answer will be discarded, and its run stopped. Its branch is left as it is (ws-git diff ${job.name}).`,
        )
      }
      const job = sessions.keep(name)
      return ok(`${job.name} kept: the retention sweep will leave its branch alone from now on.`)
    }
    return refused(
      `unknown action ${repr(action)} — sessions takes ask, list, result, cancel or keep. A delegate you already have gets its next task with action="ask", resume="<name>".`,
    )
  } catch (e) {
    if (e instanceof JobRunningError) return ok(e.message)
    if (e instanceof WorldError) return refused(`sessions ${action} failed: ${e.message}`)
    throw e
  }
}

/** The `sessions` tool over a helper: one tool with an `action`, as
 *  nontainer's adapters expose it. */
export function sessionsTool(sessions: Sessions): Tool {
  const string = { type: 'string' }
  return {
    name: 'sessions',
    description: SESSIONS_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: string,
        task: string,
        name: string,
        paths: { anyOf: [{ type: 'array', items: string }, string, { type: 'null' }] },
        inherit: string,
        fork_from: string,
        resume: string,
        wait: { type: 'boolean' },
      },
      required: ['action'],
    },
    async call(args): Promise<ToolOutput> {
      return { ...(await act(sessions, args as unknown as SessionsArgs)), images: [] }
    },
  }
}
