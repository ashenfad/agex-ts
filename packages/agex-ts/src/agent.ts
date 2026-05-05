/**
 * `Agent` — the host-facing surface that ties registration, state,
 * and (eventually) tasks together.
 *
 * Constructed via `createAgent(opts)` because state setup is async
 * (kvgit-backed configs need to open the underlying KV store). The
 * class itself is synchronous: registration is in-memory, host APIs
 * (`fs`, `cache`, `events`) lazily build per-session views.
 *
 * v1 surface: registration + per-session host APIs + manual commit
 * + fingerprint inspection. The `task()` factory and the action
 * loop land in the next commits — the Agent is the scaffolding
 * those will hook into.
 */

import type { CommitInfo } from 'kvgit-ts'
import { CacheManager } from './cache'
import { EventLogImpl } from './event-log'
import { PolicyBuilder, memberAllowed } from './policy'
import { KvgitState, type StateBackend, connectState, isVersioned } from './state'
import { type TaskDefinition, makeTask } from './task'
import type {
  Cache,
  Chapter,
  EventLog,
  FSConfig,
  LLMClient,
  MemberConfig,
  MemberFilter,
  Policy,
  RuntimeAdapter,
  StateConfig,
  TaskCallOptions,
  TaskFn,
  TerminalCommandHandler,
  VirtualFileSystem,
} from './types'
import { VfsManager } from './vfs'

export interface AgentOptions {
  /** Display name. Used in event logs and error messages. */
  readonly name: string
  /** System-prompt addendum (the "agent's voice"). Optional. */
  readonly primer?: string
  /** LLM driver. Required for any task that calls the model. v1 ships
   *  the `Dummy` client for tests; production agents bring their own. */
  readonly llm?: LLMClient
  /** Runtime that executes `ts` emissions. The default v1 runtime
   *  ships separately as `@agex-ts/runtime-worker`; tests can use the
   *  in-process eval runtime in `agex-ts/runtime-eval`. */
  readonly runtime?: RuntimeAdapter
  /** Persistent state. Defaults to in-process `Live`. */
  readonly state?: StateConfig
  /** Virtual filesystem. Defaults to per-session in-memory. */
  readonly fs?: FSConfig
  /** Max iterations per task (turn cap). Default `10`. */
  readonly maxIterations?: number
  /** Threshold (in input tokens, as reported by the latest
   *  `ActionEvent`) at which chaptering fires. Pair with a
   *  registered `agent.chapterTask({ ... })` — without one the
   *  trigger is a no-op. */
  readonly chapteringTrigger?: number
}

/** Async factory — handles the awaitable parts of state setup. */
export async function createAgent(opts: AgentOptions): Promise<Agent> {
  const state = await connectState(opts.state ?? { type: 'live' })
  return new Agent(opts, state)
}

/** Options accepted by `agent.fn()`. */
export interface FnRegistration {
  readonly description?: string
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
  readonly paramsSchema?: import('@standard-schema/spec').StandardSchemaV1
}

/** Options accepted by `agent.cls()`. */
export interface ClsRegistration {
  readonly description?: string
  readonly constructable?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}

/** Options accepted by `agent.namespace()`. */
export interface NsRegistration {
  readonly description?: string
  readonly recursive?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
  /** True if the target is a live host instance whose state can't
   *  cross the worker boundary; the runtime adapter will expose it
   *  as a Proxy that round-trips method calls back to the host. */
  readonly live?: boolean
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}

/** Options accepted by `agent.terminal()`. */
export interface TerminalRegistration {
  readonly description: string
  readonly handler: TerminalCommandHandler
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}

const DEFAULT_SESSION = 'default'
const DEFAULT_MAX_ITERATIONS = 10

/** Options accepted by `agent.chapterTask()`. The chapter task uses
 *  fixed input/output shapes (numbered event index → `Chapter[]`)
 *  set by the framework, so the user only supplies the prose. */
export interface ChapterTaskDefinition {
  /** Surfaced in the system prompt for the chapter task. Should
   *  describe the chaptering goal in the agent's voice. */
  readonly description: string
  /** Optional task-specific addendum. */
  readonly primer?: string
}

export class Agent {
  readonly #opts: AgentOptions
  readonly #state: StateBackend
  readonly #policy = new PolicyBuilder()
  readonly #vfs: VfsManager
  readonly #caches: CacheManager
  readonly #eventLogs = new Map<string, EventLogImpl>()
  #chapterTask: TaskFn<string, ReadonlyArray<Chapter>> | undefined

  constructor(opts: AgentOptions, state: StateBackend) {
    this.#opts = opts
    this.#state = state
    this.#vfs = new VfsManager(opts.fs ?? { type: 'memory' })
    this.#caches = new CacheManager(state)
  }

  // -- Identity -----------------------------------------------------------

  get name(): string {
    return this.#opts.name
  }

  get maxIterations(): number {
    return this.#opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
  }

  /** Stable identifier for the agent's current registration shape.
   *  Changes whenever a registration mutation lands. */
  get fingerprint(): string {
    return this.#policy.fingerprint()
  }

  /** The agent's primer prose, if any. Surfaced as part of the
   *  system prompt during task runs. */
  get primer(): string | undefined {
    return this.#opts.primer
  }

  /** The configured LLM driver, if any. Tasks throw at call time
   *  if this isn't set. */
  get llm(): LLMClient | undefined {
    return this.#opts.llm
  }

  /** The configured runtime, if any. Tasks throw at call time if
   *  this isn't set. */
  get runtime(): RuntimeAdapter | undefined {
    return this.#opts.runtime
  }

  /** The token threshold above which chaptering fires (if a chapter
   *  task is registered). Undefined disables chaptering. */
  get chapteringTrigger(): number | undefined {
    return this.#opts.chapteringTrigger
  }

  /** Read-only snapshot of the registration policy. */
  policy(): Policy {
    return this.#policy.snapshot()
  }

  // -- Registration -------------------------------------------------------

  fn(
    name: string,
    fn: (...args: unknown[]) => unknown | Promise<unknown>,
    opts: FnRegistration = {},
  ): this {
    this.#policy.registerFn(name, { fn, ...opts })
    return this
  }

  cls(name: string, cls: new (...args: unknown[]) => unknown, opts: ClsRegistration = {}): this {
    this.#policy.registerCls(name, { cls, ...opts })
    return this
  }

  namespace(name: string, target: object, opts: NsRegistration = {}): this {
    this.#policy.registerNamespace(name, { target, ...opts })
    return this
  }

  skill(name: string, content: string): this {
    this.#policy.registerSkill(name, content)
    return this
  }

  terminal(name: string, opts: TerminalRegistration): this {
    this.#policy.registerTerminal(name, opts)
    return this
  }

  // -- Task lifecycle ----------------------------------------------------

  /** Define a typed callable that drives the action loop. The
   *  returned function is awaitable: `const result = await task(input)`. */
  task<I, O>(def: TaskDefinition<I, O>): (input: I, options?: TaskCallOptions) => Promise<O> {
    return makeTask(this, def)
  }

  /** Register the agent's `__chapter__` task — runs through the
   *  same task() machinery, with the agent's LLM and registered
   *  fns/namespaces in scope, when the chaptering trigger fires.
   *
   *  Contract: input is a numbered event index (string) the
   *  framework constructs from the parent task's log. Output is
   *  `readonly Chapter[]`, returned via `taskSuccess(chapters)`.
   *
   *  Skipping this method disables chaptering even when
   *  `chapteringTrigger` is set. */
  chapterTask(def: ChapterTaskDefinition): this {
    this.#chapterTask = makeTask<string, ReadonlyArray<Chapter>>(this, {
      description: def.description,
      ...(def.primer !== undefined && { primer: def.primer }),
    })
    return this
  }

  /** Framework-internal accessor — chaptering machinery looks the
   *  registered chapter task up through here. Public so the
   *  chaptering module (which lives outside Agent) can reach it;
   *  not part of the user-facing surface. */
  getChapterTask(): TaskFn<string, ReadonlyArray<Chapter>> | undefined {
    return this.#chapterTask
  }

  // -- Per-session host APIs ---------------------------------------------

  /** Per-session VFS. Same instance for the same session id; writes
   *  persist across calls within the agent's lifetime. */
  fs(session: string = DEFAULT_SESSION): VirtualFileSystem {
    return this.#vfs.fs(session)
  }

  /** Per-session typed cache. */
  cache(session: string = DEFAULT_SESSION): Cache {
    return this.#caches.cache(session)
  }

  /** Per-session event log. Same instance for the same session id. */
  events(session: string = DEFAULT_SESSION): EventLog {
    const cached = this.#eventLogs.get(session)
    if (cached !== undefined) return cached
    const fresh = new EventLogImpl(this.#state)
    this.#eventLogs.set(session, fresh)
    return fresh
  }

  /** The shared underlying StateBackend. Useful for inspection /
   *  manual commit / time travel via kvgit. Returns the raw backend
   *  so consumers can use the `isVersioned` predicate. */
  state(): StateBackend {
    return this.#state
  }

  /** Flush pending writes if the backend is versioned. No-op for Live. */
  async commit(opts: { info?: Readonly<Record<string, unknown>> } = {}): Promise<string | null> {
    if (!isVersioned(this.#state)) return null
    return this.#state.commit(opts)
  }

  // -- Inspection / time-travel ------------------------------------------

  /** Commit metadata at `hash` (or current HEAD if omitted). Null
   *  on non-versioned state or if the commit doesn't exist. */
  async commitInfo(hash?: string): Promise<CommitInfo | null> {
    if (!(this.#state instanceof KvgitState)) return null
    return this.#state.commitInfo(hash)
  }

  /** Walk commit hashes backward through the history. Yields
   *  nothing on non-versioned state. */
  async *history(hash?: string, opts: { allParents?: boolean } = {}): AsyncIterable<string> {
    if (!(this.#state instanceof KvgitState)) return
    for await (const h of this.#state.history(hash, opts)) yield h
  }

  /** Read the events as they were at a historical commit, for the
   *  given session. Returns `null` if the backend isn't versioned
   *  or the commit doesn't exist. */
  async eventsAt(commitHash: string, session: string = DEFAULT_SESSION): Promise<EventLog | null> {
    if (!(this.#state instanceof KvgitState)) return null
    const view = await this.#state.checkoutAt(commitHash)
    if (view === null) return null
    // Build a thin StateBackend over the historical Versioned. We
    // don't need writes — just iter() and get() — so a minimal
    // adapter wraps the Versioned's reads directly.
    void session
    const { Staged } = await import('kvgit-ts')
    const historicalStaged = new Staged(view)
    const historicalState = new KvgitState(historicalStaged)
    return new EventLogImpl(historicalState)
  }

  // -- Internals exposed for the action loop / runtime adapter ----------

  /** Test-shaped check that a member name passes the include/exclude
   *  filter pair. Exposed for adapters that need to mirror the agent's
   *  filter rules. */
  static memberAllowed = memberAllowed
}
