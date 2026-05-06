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
import { RegistrationError } from './errors'
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
  /** Replace the agex-ts `BUILTIN_PRIMER` entirely. Use only if
   *  you really mean to override agex's environment description —
   *  the agent loses the conventions explanation and best
   *  practices. Most users want `primer` (their own voice) or
   *  `capabilitiesPrimer` (curated tools list) instead. */
  readonly agexPrimerOverride?: string
  /** Replace the auto-rendered "Registered Resources" section with
   *  curated prose. Useful when you want to organize tools
   *  thematically or surface only some of them. The auto-renderer
   *  still runs against the policy table (so the runtime adapter
   *  injects everything that's registered) — this only affects
   *  what the agent SEES in the system prompt. */
  readonly capabilitiesPrimer?: string
}

/** Async factory — handles the awaitable parts of state setup. */
export async function createAgent(opts: AgentOptions): Promise<Agent> {
  const state = await connectState(opts.state ?? { type: 'live' })
  return new Agent(opts, state)
}

/** Options accepted by `agent.fn()`. The function is the first
 *  positional arg; everything below is metadata. `name` defaults to
 *  the function's `.name` property — supply explicitly when
 *  registering an arrow / anonymous / bound function (whose `.name`
 *  is empty or non-identifier-shaped). */
export interface FnRegistration {
  readonly name?: string
  readonly description?: string
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
  readonly paramsSchema?: import('@standard-schema/spec').StandardSchemaV1
}

/** Options accepted by `agent.cls()`. The class is the first
 *  positional arg; `name` defaults to `cls.name` (override for
 *  anonymous classes or when re-naming the agent-facing identifier). */
export interface ClsRegistration {
  readonly name?: string
  readonly description?: string
  readonly constructable?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}

/** Options accepted by `agent.namespace()`. The target object is
 *  the first positional arg; `name` is required because plain
 *  objects don't carry a useful name property. */
export interface NsRegistration {
  readonly name: string
  readonly description?: string
  readonly recursive?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}

/** Options accepted by `agent.terminal()`. The handler is the
 *  first positional arg; `name` and `description` are required
 *  (the agent surfaces these in the rendered tool list). */
export interface TerminalRegistration {
  readonly name: string
  readonly description: string
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}

/** Options accepted by `agent.skill()`. The markdown content is
 *  the first positional arg; `name` is required (it's the
 *  identifier the agent uses to look the skill up). */
export interface SkillRegistration {
  readonly name: string
}

const DEFAULT_SESSION = 'default'
const DEFAULT_MAX_ITERATIONS = 10

/** Resolve a registration's identifier: prefer the explicit
 *  `opts.name`, fall back to the value's intrinsic name (e.g.
 *  `fn.name` / `cls.name`), throw a helpful error when neither
 *  yields a non-empty identifier. The full validity check (must
 *  match the `[A-Za-z_][A-Za-z0-9_]*` identifier shape) lives in
 *  `PolicyBuilder` — we only catch the empty-name case here so the
 *  embedder gets a message that points at the registration call
 *  site rather than a generic "name must be a non-empty string". */
function resolveName(
  explicit: string | undefined,
  intrinsic: string | undefined,
  kind: string,
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  if (intrinsic !== undefined && intrinsic.length > 0) return intrinsic
  throw new RegistrationError(
    `agent.${kind}(): no name available — the value has no usable .name property (anonymous / arrow / bound function?). Pass \`{ name: '...' }\` explicitly.`,
  )
}

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

  /** Override for the BUILTIN_PRIMER. Undefined uses the default. */
  get agexPrimerOverride(): string | undefined {
    return this.#opts.agexPrimerOverride
  }

  /** Curated capabilities primer used in place of the auto-rendered
   *  registrations section. Undefined falls back to auto-rendering. */
  get capabilitiesPrimer(): string | undefined {
    return this.#opts.capabilitiesPrimer
  }

  /** Read-only snapshot of the registration policy. */
  policy(): Policy {
    return this.#policy.snapshot()
  }

  // -- Registration -------------------------------------------------------
  //
  // All registration methods follow the same shape: the *thing being
  // registered* is the first positional arg, and a single options
  // object holds everything else (name override, description,
  // visibility filters, etc.). Mirrors agex-py's
  // `agent.cls(MyClass, name="...")` style. Where a name can be
  // inferred from the value (`fn.name`, `cls.name`) it's optional;
  // namespace / skill / terminal require explicit `name` since
  // plain objects, markdown blobs, and handlers don't carry a
  // useful identifier.

  fn(fn: (...args: unknown[]) => unknown | Promise<unknown>, opts: FnRegistration = {}): this {
    const name = resolveName(opts.name, fn.name, 'fn')
    const { name: _drop, ...rest } = opts
    this.#policy.registerFn(name, { fn, ...rest })
    return this
  }

  cls(cls: new (...args: unknown[]) => unknown, opts: ClsRegistration = {}): this {
    const name = resolveName(opts.name, cls.name, 'cls')
    const { name: _drop, ...rest } = opts
    this.#policy.registerCls(name, { cls, ...rest })
    return this
  }

  namespace(target: object, opts: NsRegistration): this {
    const { name, ...rest } = opts
    this.#policy.registerNamespace(name, { target, ...rest })
    return this
  }

  skill(content: string, opts: SkillRegistration): this {
    this.#policy.registerSkill(opts.name, content)
    return this
  }

  terminal(handler: TerminalCommandHandler, opts: TerminalRegistration): this {
    const { name, ...rest } = opts
    this.#policy.registerTerminal(name, { handler, ...rest })
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

  /** Framework-internal: rebuild the `/skills/` overlay for `session`
   *  from the current registered skills. Called by the action loop
   *  on every task start so newly-registered skills become
   *  browseable. */
  refreshSkillsOverlay(session: string = DEFAULT_SESSION): void {
    // Touch fs(session) first to ensure the session entry exists,
    // otherwise refresh is a no-op.
    this.fs(session)
    this.#vfs.refreshSkillsOverlay(session, this.policy().skills)
  }

  /** Framework-internal: rebuild the `/chapters/` overlay for
   *  `session` from the current event log + state, so a chapter that
   *  just landed becomes browseable on the next read. The chaptering
   *  machinery calls this after `replaceRange`. */
  async refreshChaptersOverlay(session: string = DEFAULT_SESSION): Promise<void> {
    const log = this.events(session)
    await this.#vfs.refreshChaptersOverlay(
      session,
      log.iter(),
      (ref) => this.#state.get(ref) as Promise<import('./types').AgentEvent | undefined>,
    )
  }

  /** Per-session typed cache. */
  cache(session: string = DEFAULT_SESSION): Cache {
    return this.#caches.cache(session)
  }

  /** Per-session event log. Same instance for the same session id.
   *
   *  Returns the concrete `EventLogImpl` rather than just the public
   *  `EventLog` interface, because framework-internal callers (the
   *  task lifecycle, chaptering machinery) need extra methods like
   *  `refs()` and `replaceRange()`. The public surface is the same;
   *  end-user code generally interacts via the `EventLog` interface. */
  events(session: string = DEFAULT_SESSION): EventLogImpl {
    const cached = this.#eventLogs.get(session)
    if (cached !== undefined) return cached
    const fresh = new EventLogImpl(this.#state, session)
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

  /** Release runtime resources. Must be called when the agent is no
   *  longer needed — a worker-based `RuntimeAdapter` (the production
   *  default) holds onto a Worker / `worker_threads` instance that
   *  won't get GC'd otherwise. No-op if no runtime is configured.
   *
   *  After `dispose()`, calling `task()` will fail because the runtime
   *  is gone. Don't reuse the agent. */
  async dispose(): Promise<void> {
    const runtime = this.#opts.runtime
    if (runtime !== undefined) await runtime.dispose()
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
    // adapter wraps the Versioned's reads directly. Pass `session`
    // so the historical EventLog reads from the right per-session
    // index (not the default).
    const { Staged } = await import('kvgit-ts')
    const historicalStaged = new Staged(view)
    const historicalState = new KvgitState(historicalStaged)
    return new EventLogImpl(historicalState, session)
  }

  // -- Internals exposed for the action loop / runtime adapter ----------

  /** Test-shaped check that a member name passes the include/exclude
   *  filter pair. Exposed for adapters that need to mirror the agent's
   *  filter rules. */
  static memberAllowed = memberAllowed
}
