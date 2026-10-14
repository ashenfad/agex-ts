/**
 * Agent-defined tasks: tasks agent code defines, each call run by a
 * helper agent, after Python agex's `agex.code_tasks`.
 *
 * An embedder grants `agex` as a host object:
 *
 *     profile: { hostObjects: { agex: agentTasks(agent) } }
 *
 * and agent code defines tasks with it, typed by JSON Schema literals
 * (or a Standard Schema of its own, zod say, whose library makes JSON
 * Schema):
 *
 *     const corners = agex.task({
 *       name: 'corners',
 *       instructions: 'The corner points of the named shape, counterclockwise.',
 *       params: { shape: { type: 'string' } },
 *       returns: { type: 'array', items: { $ref: '#/$defs/Point' }, $defs: { Point } },
 *     })
 *     const points = await corners({ shape: 'unit square' })
 *     const many = await corners.map([{ shape: 'square' }, { shape: 'hexagon' }])
 *
 * Code holds `agex`'s stub ({@link AGEX_STUB}), which checks a
 * definition where it's written and turns each schema into JSON Schema,
 * so only data crosses. The host half ({@link AgentTasks}) reads the
 * task back, checks the inputs against it, and runs a helper per call.
 * A helper that can't do it raises `agex.TaskFailed` in the code; one
 * that asks raises `agex.TaskNeedsInput` with its question.
 *
 * **A helper is a delegate of the world that called.** It is asked
 * through the world's helper (`Sessions.of`), with an empty view forked
 * from the last commit inside the code's call, and a runner of its own
 * for the job: listed and kept with the world's other delegates, its
 * answer collected by the call and never handed to the caller's model.
 * A world with no helper open, or an embedder asking for it
 * (`scratch: true`), puts helpers on scratch worlds in memory instead.
 *
 * A helper holds what its caller holds: the caller's profile, without
 * `agex` (helpers make no helpers), with the inputs and `task` added. A
 * task's `objects` narrows it to the host objects named. A cancel of the
 * caller's turn stops the helpers it has running ({@link cancelTasks}).
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import {
  type HostCall,
  JobRunningError,
  type Profile,
  type Reply,
  type RunOptions,
  SessionExistsError,
  type SessionRunner,
  Sessions,
  SessionsError,
  Store,
  type Workspace,
  hostFactory,
  withCall,
  withStub,
} from '@agex-ts/world'
import type { Agent } from './agent'
import { defsOf, fromJsonSchema, refName } from './schema'
import {
  type Bound,
  PLANE,
  PREVIEW,
  TaskHost,
  TaskSpec,
  begin,
  bindInputs,
  brief,
  preview,
  taskHooks,
  taskOutcome,
  taskProfile,
} from './task'

/** How many helpers one `.map` runs at once, unless the embedder says. */
export const MAX_PARALLEL = 4

/** The format of a task as the stub sends it. */
export const TASK_FORMAT = 'agex-task/1'

/** Why a call a cancel stopped failed. */
export const CANCELLED = 'it was cancelled: the code that called it was stopped'

/**
 * The code's half of `agex`: the source of `(remote) => object`, run in
 * the world's worker (see the world's `withStub`). Plain JavaScript,
 * reaching nothing but `remote`.
 */
export const AGEX_STUB = String.raw`(remote) => {
  class TaskFailed extends Error {
    constructor(message) {
      super(message)
      this.name = 'TaskFailed'
    }
  }
  class TaskNeedsInput extends TaskFailed {
    constructor(task, question) {
      super("task '" + task + "' needs input: " + question)
      this.name = 'TaskNeedsInput'
      this.question = question
    }
  }
  const RESERVED = ['task', 'host', 'agex']
  const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

  function jsonSchema(schema, where) {
    if (schema === undefined || schema === null) {
      throw new TypeError(where + ' has no type: give it a JSON Schema')
    }
    const standard = isObject(schema) ? schema['~standard'] : undefined
    if (standard !== undefined) {
      const convert = standard.jsonSchema
      if (convert === undefined || typeof convert.input !== 'function') {
        throw new TypeError(where + "'s schema comes from a library that makes no JSON Schema: write it as JSON Schema")
      }
      return convert.input({ target: 'draft-2020-12' })
    }
    if (schema === true || isObject(schema)) return schema
    throw new TypeError(where + "'s type is a JSON Schema, not " + typeof schema)
  }

  function liveIn(schema, defs, seen) {
    if (Array.isArray(schema)) {
      for (const item of schema) {
        const found = liveIn(item, defs, seen)
        if (found !== null) return found
      }
      return null
    }
    if (!isObject(schema)) return null
    const ref = typeof schema.$ref === 'string' ? schema.$ref.split('/').pop() : null
    if (ref !== null && !seen.has(ref)) {
      seen.add(ref)
      const def = defs[ref]
      if (isObject(def) && def['x-kind'] === 'live') return ref
      const found = liveIn(def, defs, seen)
      if (found !== null) return found
    }
    if (schema['x-kind'] === 'live') return 'a live type'
    for (const [key, item] of Object.entries(schema)) {
      if (key === '$defs' || key === 'definitions') continue
      const found = liveIn(item, defs, seen)
      if (found !== null) return found
    }
    return null
  }

  function task(def) {
    if (!isObject(def)) throw new TypeError('agex.task takes { name, instructions, params, returns }')
    const name = def.name
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
      throw new TypeError("a task's name is an identifier, not " + JSON.stringify(name))
    }
    const instructions = typeof def.instructions === 'string' ? def.instructions.trim() : ''
    if (instructions === '') {
      throw new TypeError("task '" + name + "' has no instructions: they are the job its helper is given")
    }
    const given = def.params === undefined ? {} : def.params
    if (!isObject(given)) throw new TypeError("task '" + name + "': params is an object of types by name")
    const params = {}
    for (const [param, type] of Object.entries(given)) {
      if (!IDENTIFIER.test(param) || RESERVED.includes(param)) {
        throw new TypeError("task '" + name + "' has a parameter named '" + param + "', which its helper's world binds (" + RESERVED.join(', ') + ')')
      }
      params[param] = jsonSchema(type, "task '" + name + "': parameter '" + param + "'")
    }
    const returns = def.returns === undefined || def.returns === null ? null : jsonSchema(def.returns, "task '" + name + "''s return")
    for (const schema of [...Object.values(params), returns]) {
      const defs = isObject(schema) ? { ...schema.definitions, ...schema.$defs } : {}
      const live = liveIn(schema, defs, new Set())
      if (live !== null) {
        throw new TypeError("task '" + name + "' takes or returns " + live + ', which is live: a task takes and returns values')
      }
    }
    if (def.objects !== undefined && def.objects !== null && !(Array.isArray(def.objects) && def.objects.every((o) => typeof o === 'string'))) {
      throw new TypeError("task '" + name + "': objects is a list of host objects' names")
    }
    const spec = {
      format: '${TASK_FORMAT}',
      name,
      instructions,
      params,
      returns,
      primer: typeof def.primer === 'string' ? def.primer : '',
      objects: def.objects === undefined ? null : def.objects,
    }
    const unwrap = (reply) => {
      if (reply.status === 'success') return reply.value
      if (reply.status === 'needs_input') throw new TaskNeedsInput(name, reply.message)
      if (reply.status === 'refused') throw new TypeError(reply.message)
      throw new TaskFailed("task '" + name + "' failed: " + reply.message)
    }
    const call = async (inputs = {}) => unwrap((await remote.map(spec, [inputs]))[0])
    // every call runs to its end; then the first that failed raises
    call.map = async (items) => (await remote.map(spec, Array.from(items))).map(unwrap)
    call.spec = spec
    Object.defineProperty(call, 'name', { value: name })
    return call
  }

  return { task, TaskFailed, TaskNeedsInput }
}`

/**
 * How to use `agex`, for the model: an embedder granting it adds this
 * to the code tool's description (`toolOptions: { codePrimer }`) or the
 * primer.
 */
export const AGEX_GUIDE = `agex hands work to helper agents: define a task, then call it like a function.
  const factor = agex.task({
    name: 'factor',
    instructions: 'Factor n into its primes, smallest first.',  // the helper's whole job
    params: { n: { type: 'integer' } },                          // each a JSON Schema
    returns: { type: 'array', items: { type: 'integer' } },
  })
  const primes = await factor({ n: 391 })               // one helper
  const all = await factor.map([{ n: 391 }, { n: 403 }])  // one each, at once, in order
A helper starts fresh: it sees its inputs, not your files or conversation. One that can't do it throws agex.TaskFailed; one that asks a question throws agex.TaskNeedsInput (e.question).`

/** One reply to a call, as the stub reads it. */
export type CallReply =
  | { readonly status: 'success'; readonly value: unknown }
  | { readonly status: 'failed' | 'needs_input' | 'refused'; readonly message: string }

const refused = (e: unknown): CallReply => ({
  status: 'refused',
  message: e instanceof Error ? e.message : String(e),
})

const failed = (message: string): CallReply => ({ status: 'failed', message })

/** A task as the stub sent it, read back. */
interface Sent {
  readonly spec: TaskSpec
  readonly primer: string
  readonly objects: readonly string[] | null
}

/** The task the stub sent: checked, and its types made Standard
 *  Schemas of their JSON Schemas. Runs nothing the code sent. */
function readTask(data: unknown): Sent {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  if (d.format !== TASK_FORMAT) throw new TypeError('not an agent-defined task')
  const { name, instructions, params, returns, primer, objects } = d
  if (
    typeof name !== 'string' ||
    typeof instructions !== 'string' ||
    typeof params !== 'object' ||
    params === null ||
    (objects !== null && !(Array.isArray(objects) && objects.every((o) => typeof o === 'string')))
  ) {
    throw new TypeError('an agent-defined task that isn’t well formed')
  }
  if ('agex' in params) {
    throw new TypeError(
      `task '${name}' has a parameter named 'agex', which its helper's world binds`,
    )
  }
  const typed = (schema: unknown) => fromJsonSchema(schema as Record<string, unknown>)
  return {
    spec: new TaskSpec({
      name,
      instructions,
      params: Object.fromEntries(Object.entries(params).map(([p, s]) => [p, typed(s)])),
      ...(returns !== null && returns !== undefined && { returns: typed(returns) }),
    }),
    primer: typeof primer === 'string' ? primer : '',
    objects: objects as readonly string[] | null,
  }
}

/** One call, read back: its task, its inputs checked, and the profile
 *  its helper starts from. */
interface Called {
  readonly sent: Sent
  readonly bound: Bound
  readonly base: Profile
}

/** `agex` objects made, so a helper's world leaves them out. */
const MADE = new WeakSet<object>()

/** The caller's profile without `agex` (a helper makes no helpers),
 *  narrowed to the host objects `objects` names. */
function helperBase(profile: Profile, sent: Sent): Profile {
  const held = Object.fromEntries(
    Object.entries(profile.hostObjects ?? {}).filter(([, h]) => !MADE.has(h)),
  )
  if (sent.objects === null) return { ...profile, hostObjects: held }
  const unknown = sent.objects.filter((o) => !(o in held))
  if (unknown.length > 0) {
    throw new TypeError(
      `task '${sent.spec.name}': objects names ${unknown.join(', ')}, which its caller doesn't hold`,
    )
  }
  return {
    ...profile,
    hostObjects: Object.fromEntries(sent.objects.map((o) => [o, held[o] as object])),
  }
}

/** Run a helper on `ws`, from the task's brief, until its code settles
 *  the task; the reply for the call. */
async function runHelper(
  agent: Agent,
  ws: Workspace,
  called: Called,
  host: TaskHost,
  origin: string | null,
  signal: AbortSignal,
): Promise<CallReply> {
  const { spec } = called.sent
  const plane = ws.plane(PLANE)
  await begin(plane, spec, called.bound, origin)
  const session = agent._primed(called.sent.primer).session(ws, {
    hooks: taskHooks(host, plane),
  })
  const stop = () => session.cancel(CANCELLED)
  const running = session.stream(brief(spec, called.bound)).wait()
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  let ran: Awaited<typeof running>
  try {
    ran = await running
  } finally {
    signal.removeEventListener('abort', stop)
  }
  const out = taskOutcome(ran, host, null)
  if (out.status === 'success') return { status: 'success', value: out.value }
  if (out.status === 'needs_input') return { status: 'needs_input', message: out.message ?? '' }
  if (out.status === 'cancelled') return failed(CANCELLED)
  return failed(out.message ?? out.status)
}

/**
 * One call's job: a {@link SessionRunner} that runs a helper agent on
 * the job's world until its code settles the task. It keeps the reply
 * for the call that asked; the delegate's answer is a summary, for
 * whoever lists the world's delegates.
 */
export class TaskRun implements SessionRunner {
  reply: CallReply = failed('the helper never ran')
  readonly done: Promise<void>
  #finish: () => void = () => {}

  constructor(
    readonly agent: Agent,
    readonly called: Called,
    readonly origin: Workspace,
  ) {
    this.done = new Promise((resolve) => {
      this.#finish = resolve
    })
  }

  async run(session: string, _task: string, { signal }: RunOptions): Promise<Reply> {
    try {
      const host = new TaskHost()
      const profile = taskProfile(this.called.sent.spec, this.called.base, this.called.bound, host)
      const ws = await this.origin.store.open(session, { ...this.origin.settings, profile })
      try {
        this.reply = await runHelper(this.agent, ws, this.called, host, this.origin.session, signal)
      } finally {
        await ws.close()
      }
    } catch (e) {
      this.reply = failed(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      throw e
    } finally {
      this.#finish()
    }
    const name = this.called.sent.spec.name
    const reply = this.reply
    if (reply.status === 'success') return `${name} returned ${preview(reply.value, PREVIEW)}`
    return {
      text: `${name} ${reply.status === 'needs_input' ? 'asked' : 'failed'}: ${reply.message}`,
      status: 'failed',
    }
  }
}

/** The `agex` objects open for each world, so a cancel finds them. */
const OPEN = new WeakMap<Workspace, Set<AgentTasks>>()

/** Stop the helpers `ws`'s code has running; how many were running.
 *  A session's `cancel` calls it for its world. */
export function cancelTasks(ws: Workspace): number {
  let n = 0
  for (const tasks of OPEN.get(ws) ?? []) n += tasks.cancel()
  return n
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The host half of `agex` for one world: it runs the tasks that
 *  world's code defines, each call on a helper of its own. */
export class AgentTasks {
  readonly #agent: Agent
  readonly #ws: Workspace
  readonly #maxParallel: number
  readonly #scratch: boolean
  #count = 0
  #stopped = false
  readonly #runs = new Set<AbortController>()
  readonly #jobs = new Map<string, Sessions>()

  constructor(agent: Agent, ws: Workspace, opts: { maxParallel?: number; scratch?: boolean } = {}) {
    this.#agent = agent
    this.#ws = ws
    this.#maxParallel = opts.maxParallel ?? MAX_PARALLEL
    this.#scratch = opts.scratch ?? false
    const open = OPEN.get(ws) ?? new Set()
    open.add(this)
    OPEN.set(ws, open)
  }

  toString(): string {
    return `<agex for '${this.#ws.session}'>`
  }

  /** Stop the helpers running now; how many were running. Each call
   *  they ran for fails, cancelled. */
  cancel(): number {
    this.#stopped = true
    for (const run of this.#runs) run.abort()
    for (const [name, helper] of this.#jobs) {
      try {
        helper.cancel(name)
      } catch {
        // answered or gone meanwhile
      }
    }
    return this.#runs.size + this.#jobs.size
  }

  /** Run the task `data` once per item of `items`, up to the limit at
   *  once; the replies, in order. */
  async map(call: HostCall | undefined, data: unknown, items: unknown): Promise<CallReply[]> {
    this.#stopped = false // a cancel stops what ran then, not this
    if (!Array.isArray(items)) throw new TypeError('map takes a list of inputs')
    const replies: (CallReply | null)[] = items.map(() => null)
    const work: [number, Called][] = []
    let sent: Sent
    try {
      sent = readTask(data)
    } catch (e) {
      return items.map(() => refused(e))
    }
    for (const [i, inputs] of items.entries()) {
      try {
        const base = helperBase(this.#ws.settings.profile, sent)
        const bound = await bindInputs(sent.spec, (inputs ?? {}) as Record<string, unknown>)
        // made now, so what the helper's world can't bind is refused now
        taskProfile(sent.spec, base, bound, new TaskHost())
        work.push([i, { sent, bound, base }])
      } catch (e) {
        replies[i] = refused(e)
      }
    }
    if (work.length > 0) {
      const helper = this.#scratch ? null : Sessions.of(this.#ws)
      const called = work.map(([, c]) => c)
      const done =
        helper === null
          ? await this.#onScratch(called)
          : await this.#asDelegates(helper, called, call)
      work.forEach(([i], k) => {
        replies[i] = done[k] as CallReply
      })
    }
    return replies as CallReply[]
  }

  /** Each call as a delegate of this world, `maxParallel` running at
   *  once; the replies, in order. Each fork is made inside the code's
   *  call, and each answer collected here, so the caller's model never
   *  sees it. */
  async #asDelegates(
    helper: Sessions,
    called: Called[],
    call: HostCall | undefined,
  ): Promise<CallReply[]> {
    const runs = called.map((c) => new TaskRun(this.#agent, c, this.#ws))
    const started: [string, TaskRun][] = []
    try {
      for (const run of runs) {
        if (started.length >= this.#maxParallel) {
          await (started[started.length - this.#maxParallel] as [string, TaskRun])[1].done
        }
        if (this.#stopped) {
          run.reply = failed(CANCELLED)
          continue
        }
        const name = await this.#ask(helper, run, call)
        this.#jobs.set(name, helper)
        started.push([name, run])
      }
      for (const [name, run] of started) {
        await run.done
        // the run is over; its answer is landing
        for (;;) {
          try {
            helper.result(name)
            break
          } catch (e) {
            if (e instanceof JobRunningError) {
              await sleep(10)
              continue
            }
            if (e instanceof SessionsError) {
              run.reply = run.reply.status === 'success' ? failed(e.message) : run.reply
              break
            }
            throw e
          }
        }
      }
    } finally {
      for (const [name] of started) this.#jobs.delete(name)
    }
    return runs.map((run) => run.reply)
  }

  /** Ask `helper` for `run`'s job, a delegate branch named for the
   *  task; the job's name. */
  async #ask(helper: Sessions, run: TaskRun, call: HostCall | undefined): Promise<string> {
    const { spec } = run.called.sent
    const label = `${spec.name}(${Object.entries(run.called.bound.data)
      .map(([k, v]) => `${k}=${preview(v, 80)}`)
      .join(', ')})`
    for (let tries = 0; ; tries++) {
      this.#count += 1
      try {
        const job = await helper.ask(label, {
          name: `${spec.name}-${this.#count}`,
          paths: [],
          runner: run,
          ...(call !== undefined && { call }),
        })
        return job.name
      } catch (e) {
        if (!(e instanceof SessionExistsError) || tries >= 8) throw e
      }
    }
  }

  /** Each call on a scratch world of its own, in memory, `maxParallel`
   *  at once; the replies, in order. */
  async #onScratch(called: Called[]): Promise<CallReply[]> {
    const one = async (c: Called): Promise<CallReply> => {
      if (this.#stopped) return failed(CANCELLED)
      const stop = new AbortController()
      this.#runs.add(stop)
      try {
        const store = await Store.open(new Memory())
        const host = new TaskHost()
        const profile = taskProfile(c.sent.spec, c.base, c.bound, host)
        const ws = await store.open(`${c.sent.spec.name}-${crypto.randomUUID().slice(0, 8)}`, {
          ...this.#ws.settings,
          profile,
        })
        try {
          return await runHelper(this.#agent, ws, c, host, null, stop.signal)
        } finally {
          await ws.close()
        }
      } catch (e) {
        return failed(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      } finally {
        this.#runs.delete(stop)
      }
    }
    const replies: CallReply[] = new Array(called.length)
    let next = 0
    const worker = async () => {
      while (next < called.length) {
        const i = next++
        replies[i] = await one(called[i] as Called)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.#maxParallel, called.length) }, worker))
    return replies
  }
}

/**
 * `agex` for a world's profile: agent code defines tasks with it, and
 * `agent` runs them. `maxParallel` bounds how many helpers a `.map`
 * runs at once; `scratch: true` puts every helper on a scratch world in
 * memory rather than a delegate branch.
 */
export function agentTasks(
  agent: Agent,
  opts: { maxParallel?: number; scratch?: boolean } = {},
): object {
  const made = withStub(
    hostFactory((ws) => {
      const tasks = new AgentTasks(agent, ws, opts)
      return {
        map: withCall((call, data: unknown, items: unknown) => tasks.map(call, data, items)),
      }
    }),
    AGEX_STUB,
  )
  MADE.add(made)
  return made
}

// ---------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------

/** `answer(name, inputs)`: the value for one call of the task `name`. */
export type StandInAnswer = (name: string, inputs: Readonly<Record<string, unknown>>) => unknown

/** The simplest value of a JSON Schema's type: an empty list, `0`, `''`,
 *  `false`, `null`, the first of an enum, an object of such fields. */
export function simplest(schema: unknown, defs: Readonly<Record<string, unknown>> = {}): unknown {
  if (typeof schema !== 'object' || schema === null) return null
  const s = schema as Record<string, unknown>
  const all = { ...defs, ...defsOf(s) }
  const name = refName(s)
  if (name !== null) return simplest(all[name], all)
  if (s['x-kind'] === 'bytes') return new Uint8Array()
  if ('const' in s) return s.const
  if (Array.isArray(s.enum)) return s.enum[0] ?? null
  const members = (s.anyOf ?? s.oneOf) as unknown
  if (Array.isArray(members)) {
    const nullable = members.find((m) => (m as Record<string, unknown>)?.type === 'null')
    return simplest(nullable ?? members[0], all)
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type
  switch (type) {
    case 'string':
      return ''
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>
      const required = Array.isArray(s.required) ? (s.required as string[]) : []
      return Object.fromEntries(required.map((k) => [k, simplest(props[k], all)]))
    }
    default:
      return null
  }
}

/**
 * `agex` without a model, for a page check or a handler test: code
 * defines and calls tasks exactly as it does against {@link agentTasks},
 * and each call is answered at once, by `answer(name, inputs)` or with
 * the simplest value of the task's return type. Either way the value
 * is checked against the return type, as a helper's is.
 */
export function standInTasks(answer?: StandInAnswer): object {
  const made = withStub(
    {
      async map(data: unknown, items: unknown): Promise<CallReply[]> {
        if (!Array.isArray(items)) throw new TypeError('map takes a list of inputs')
        let sent: Sent
        try {
          sent = readTask(data)
        } catch (e) {
          return items.map(() => refused(e))
        }
        const { spec } = sent
        return Promise.all(
          items.map(async (inputs): Promise<CallReply> => {
            let bound: Bound
            try {
              bound = await bindInputs(spec, (inputs ?? {}) as Record<string, unknown>)
            } catch (e) {
              return refused(e)
            }
            try {
              const value =
                answer === undefined
                  ? simplest(spec.returnJson)
                  : await answer(spec.name, bound.data)
              if (spec.returns === null) return { status: 'success', value: null }
              const result = await spec.returns['~standard'].validate(value)
              if (result.issues !== undefined) {
                return failed(`the stand-in's value doesn't fit: ${result.issues[0]?.message}`)
              }
              return { status: 'success', value: result.value }
            } catch (e) {
              return failed(e instanceof Error ? e.message : String(e))
            }
          }),
        )
      },
    },
    AGEX_STUB,
  )
  MADE.add(made)
  return made
}
