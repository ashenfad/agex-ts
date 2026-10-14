/**
 * Tasks: a typed call that runs an agent on a world of its own, after
 * Python agex's `agex.task`.
 *
 *     const grade = agent.task({
 *       name: 'grade',
 *       instructions: 'Grade the quiz.',
 *       params: { responses: z.array(Response) },
 *       returns: Report,
 *     })
 *     const report = await grade({ responses })             // the value, or TaskFailed
 *     const out = await grade.run({ responses }, { world: ws, keep: true })  // out.ref names the fork
 *
 * Calling the task runs the agent on a fresh world, a scratch one built
 * from the agent's profile or a fork of `world`, and hands back the
 * value the agent's code passed to `task.success`, checked against the
 * return type. The caller's world is never touched.
 *
 * Inside the world, agent code sees each input bound by its own name
 * and `task`: `await task.success(value)` ends the task with its value,
 * `await task.fail(reason)` ends it without one, and
 * `await task.needsInput(question)` stops it to ask something only its
 * caller can settle. A value that doesn't fit is a `TypeError` at the
 * call, so the agent fixes it in the same script; a call that settles
 * the task ends the script it is in. A model that stops without any of
 * them is sent back to finish, twice; then the task fails.
 *
 * A task that asks keeps its world, and carries on there with the
 * answer: `out.resume(answer)` in this process, or
 * `grade.resume(ref, answer, { world })` by ref, after a restart too on
 * a store that persists. The world's `__task__` plane holds what the
 * task is, its inputs and how it stands, so a resume finds its inputs
 * there; a live input can't be stored, and is passed again.
 *
 * - **Inputs are values or live.** A value is checked against its
 *   Standard Schema at the call and bound by name in the task's code, a
 *   fresh copy each run, so a task can't change what its caller passed.
 *   A {@link live} input is a host object of the task's world: code
 *   calls its methods, which run on the host.
 * - **Only data crosses.** A value with a live part is refused at the
 *   call, and a live return type when the task is defined: the code
 *   runs in a worker, and what it hands back is data.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import {
  type HostContract,
  type MethodContract,
  Mismatch,
  type Profile,
  Store,
  type Workspace,
  type WorkspacePlane,
  check,
  decode,
  encode,
  findLive,
  hostFactory,
  isSchema,
  jsonSchemaOf,
  typedHost,
} from '@agex-ts/world'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Agent, Hooks, Outcome } from './agent'
import type { Message } from './record'
import { newId } from './record'
import { declarations, defsOf, fromJsonSchema, typeText } from './schema'

/** Names a task's parameters can't take: `task` and `host` are bound in
 *  the world, and the rest are code's own. */
export const RESERVED: ReadonlySet<string> = new Set([
  'task',
  'host',
  'fs',
  'cache',
  'env',
  'console',
  'secret',
])

/** How many times a model that stops without finishing is sent back to
 *  finish, before the task fails. */
export const NUDGES = 2

/** How many characters of each input the task's brief shows. */
export const PREVIEW = 600

/** How many methods of a live input the brief lists. */
export const METHODS = 20

export const NUDGE =
  "The task isn't finished. In run_ts, call `await task.success(value)` with the result, `await task.fail(reason)` if it can't be done, or `await task.needsInput(question)` to ask something only the person who gave it can settle."

export const FINISHED = 'task.success: the task is done.'
export const GAVE_UP = 'task.fail: the task is over.'
export const ASKED = 'task.needsInput: the question is sent; the task waits for its answer.'

/** The message a resumed task's run starts from. */
export const answerText = (answer: string): string => `The answer to your question:\n${answer}`

export const INSTRUCTIONS = `You are doing a task. Its inputs are bound by name in every run_ts call, along with \`task\`:
- \`await task.success(value)\` hands back the result and ends the task. The value must have the task's return type; one that doesn't throws a TypeError right there, so fix it and call again.
- \`await task.fail(reason)\` ends the task without a result, saying why it can't be done.
- \`await task.needsInput(question)\` asks the person who gave you the task something only they can settle (a choice, a permission, a missing fact). Their answer comes back as the next message, and you carry on from there.
Each call ends the script it is in: nothing after it runs.`

/**
 * The task's own plane in its world: `spec` says what the task is and
 * which inputs are stored, `inputs/<name>` holds each input sent by
 * value, encoded, `state` how the task stands, and `value` the value it
 * handed back, encoded. A live input is not stored. Written in the
 * commits of the task's own runs, so a world at any commit says how its
 * task stood there.
 */
export const PLANE = '__task__'

// ---------------------------------------------------------------------------
// Live inputs
// ---------------------------------------------------------------------------

const LIVE = Symbol('agex.live')

/** One method of a live input: its contract, and what it does. */
export interface LiveMethod extends MethodContract {
  readonly description?: string
}

/** What a live input is: a name for its kind (`Directory`), what it is,
 *  and its methods with their contracts. Left without methods, code may
 *  call any public method the object has, unchecked. */
export interface LiveSpec {
  readonly name?: string
  readonly description?: string
  readonly methods?: Readonly<Record<string, LiveMethod>>
}

/** A live parameter: see {@link live}. */
export interface Live {
  readonly [LIVE]: LiveSpec
}

/**
 * A parameter handed over as it is: an object on the host, which the
 * task's code reaches as a host object, calling its methods. With
 * `methods`, code may call exactly those, each checked as a typed host
 * object's is.
 */
export function live(spec: LiveSpec = {}): Live {
  return { [LIVE]: spec }
}

function isLive(value: unknown): value is Live {
  return typeof value === 'object' && value !== null && LIVE in value
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export type Param = StandardSchemaV1 | Live
export type Params = Readonly<Record<string, Param>>

/** A task's inputs, as its caller passes them. */
export type Inputs<P extends Params> = {
  readonly [K in keyof P]: P[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<P[K]>
    : object
}

/** What a task hands back: its return type's output, or null. */
export type Value<R> = R extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R> : null

export interface TaskOptions<P extends Params, R extends StandardSchemaV1 | undefined> {
  /** An identifier: what the task's worlds are named after. */
  readonly name: string
  /** The job, as the model reads it. */
  readonly instructions: string
  readonly params?: P
  /** The return type; left out, the task hands back nothing. */
  readonly returns?: R
}

/** One parameter, as the task holds it. */
interface ParamSpec {
  readonly name: string
  readonly schema: StandardSchemaV1 | null
  readonly live: LiveSpec | null
  /** Its type, as the model reads it. */
  readonly type: string
  readonly json: Record<string, unknown> | null
}

/** What a task is: its name, instructions, inputs and return. */
export class TaskSpec {
  readonly name: string
  readonly instructions: string
  readonly params: readonly ParamSpec[]
  readonly returns: StandardSchemaV1 | null
  readonly returnType: string
  readonly returnJson: Record<string, unknown> | null
  /** The definitions the types name, by name. */
  readonly defs: Readonly<Record<string, Readonly<Record<string, unknown>>>>

  constructor(opts: TaskOptions<Params, StandardSchemaV1 | undefined>) {
    const name = opts.name
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`a task's name is an identifier, not ${JSON.stringify(name)}`)
    }
    this.name = name
    this.instructions = opts.instructions.trim()
    const returns = opts.returns as unknown
    if (isLive(returns)) {
      const kind = returns[LIVE].name ?? 'a live object'
      throw new TypeError(
        `task '${name}' returns ${kind}, which is live: only data crosses back from a task's code, which runs in a worker`,
      )
    }
    if (returns !== undefined && !isSchema(returns)) {
      throw new TypeError(`task '${name}': its return type is a Standard Schema (zod and the like)`)
    }
    this.returns = returns ?? null
    this.returnJson = this.returns === null ? null : jsonSchemaOf(this.returns, { io: 'output' })
    this.returnType =
      this.returns === null
        ? 'void'
        : this.returnJson === null
          ? 'unknown'
          : typeText(this.returnJson)
    const defs: Record<string, Readonly<Record<string, unknown>>> = { ...defsOf(this.returnJson) }
    const params: ParamSpec[] = []
    for (const [param, given] of Object.entries(opts.params ?? {})) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param) || RESERVED.has(param)) {
        throw new TypeError(
          `task '${name}' has a parameter named '${param}': a parameter is an identifier, and not one of ${[...RESERVED].join(', ')}`,
        )
      }
      if (isLive(given)) {
        const spec = given[LIVE]
        params.push({
          name: param,
          schema: null,
          live: spec,
          type: spec.name ?? 'object',
          json: null,
        })
        continue
      }
      if (!isSchema(given)) {
        throw new TypeError(
          `task '${name}': parameter '${param}' is a Standard Schema (zod and the like), or live()`,
        )
      }
      const json = jsonSchemaOf(given)
      for (const [def, schema] of Object.entries(defsOf(json))) defs[def] ??= schema
      params.push({
        name: param,
        schema: given,
        live: null,
        type: json === null ? 'unknown' : typeText(json),
        json,
      })
    }
    this.params = params
    this.defs = defs
  }

  /** What the task takes and returns, written as its signature: what a
   *  resume checks a world's task against. */
  get contract(): string {
    return signature(
      this.name,
      this.params.map((p) => [p.name, p.type]),
      this.returnType,
    )
  }
}

function signature(
  name: string,
  params: readonly (readonly [string, string])[],
  returns: string,
): string {
  return `${name}(${params.map(([p, t]) => `${p}: ${t}`).join(', ')}) => ${returns}`
}

/** The inputs of a call: data checked and bound by name, live objects
 *  as they are. */
/** @internal */
export interface Bound {
  readonly data: Record<string, unknown>
  readonly live: Record<string, object>
}

async function checkInput(
  spec: TaskSpec,
  param: ParamSpec,
  value: unknown,
  what: string,
): Promise<unknown> {
  let checked: unknown
  try {
    checked = await check(value, param.schema as StandardSchemaV1)
  } catch (e) {
    if (!(e instanceof Mismatch)) throw e
    throw new TypeError(`${what} must be ${param.type}: ${e.message}`)
  }
  const part = findLive(checked)
  if (part !== null) {
    throw new TypeError(
      `${what} holds a live part (${part}): only data crosses into the code of task '${spec.name}', which runs in a worker; a live object goes in a live() input of its own`,
    )
  }
  return checked
}

function checkLive(param: ParamSpec, value: unknown, what: string): object {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError(`${what} is a live input: an object whose methods the task's code calls`)
  }
  return value
}

// ---------------------------------------------------------------------------
// The brief the model starts from
// ---------------------------------------------------------------------------

/** A value as the brief previews it: JSON, with what JSON can't say
 *  named, cut to `budget` characters. */
export function preview(value: unknown, budget = PREVIEW): string {
  let text: string
  try {
    text =
      JSON.stringify(value, (_key, v: unknown) => {
        if (v instanceof Uint8Array) return `<${v.length} bytes>`
        if (typeof v === 'bigint') return `${v}n`
        if (v instanceof Map) return Object.fromEntries(v)
        if (v instanceof Set) return [...v]
        return v
      }) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > budget ? `${text.slice(0, budget)}… (${text.length} characters)` : text
}

function argsText(contract: MethodContract): string {
  const args = contract.args
  if (args === undefined) return '...args: unknown[]'
  const entries = Array.isArray(args)
    ? args.map((schema, i) => [`arg${i + 1}`, schema] as const)
    : Object.entries(args)
  return entries
    .map(([name, schema]) => {
      const json = jsonSchemaOf(schema)
      return `${name}: ${json === null ? 'unknown' : typeText(json)}`
    })
    .join(', ')
}

/** The public methods of an object, its own class's first. */
function methodsOf(obj: object): string[] {
  const found: string[] = []
  for (
    let o: object | null = obj;
    o !== null && o !== Object.prototype && o !== Function.prototype;
    o = Object.getPrototypeOf(o)
  ) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === 'constructor' || name.startsWith('_') || found.includes(name)) continue
      const d = Object.getOwnPropertyDescriptor(o, name)
      if (d !== undefined && typeof d.value === 'function') found.push(name)
    }
  }
  return found
}

/** How agent code uses a live input: its methods, each with what it
 *  takes and gives. */
function usage(name: string, spec: LiveSpec, obj: object): string {
  const lines: string[] = []
  const methods = spec.methods ?? Object.fromEntries(methodsOf(obj).map((m) => [m, {}]))
  const names = Object.keys(methods)
  for (const method of names.slice(0, METHODS)) {
    const m = methods[method] as LiveMethod
    const returns = m.returns === undefined ? null : jsonSchemaOf(m.returns, { io: 'output' })
    if (m.description !== undefined) lines.push(`  /** ${m.description} */`)
    lines.push(
      `  ${method}(${argsText(m)}): Promise<${m.returns === undefined ? 'unknown' : returns === null ? 'unknown' : typeText(returns)}>`,
    )
  }
  if (names.length > METHODS) lines.push(`  // and ${names.length - METHODS} more methods`)
  const doc = spec.description === undefined ? '' : `/** ${spec.description} */\n`
  return `${doc}const ${name}: {\n${lines.join('\n')}\n}`
}

/** The task's opening message: the job, the inputs, how to finish, the
 *  types it names, and how to use its live inputs. */
export function brief(spec: TaskSpec, bound: Bound): string {
  const parts = [spec.instructions || `Do the task '${spec.name}'.`]
  if (spec.params.length > 0) {
    const lines = spec.params.map((p) =>
      p.live !== null
        ? `- \`${p.name}\`: a live object on the host (see below)`
        : `- \`${p.name}: ${p.type}\` = ${preview(bound.data[p.name])}`,
    )
    parts.push(`Inputs, bound by name:\n${lines.join('\n')}`)
  }
  parts.push(
    spec.returns === null
      ? "When it's done, call `await task.success()`."
      : `When it's done, call \`await task.success(value)\` with a \`${spec.returnType}\`.`,
  )
  const decls = declarations([spec.returnJson, ...spec.params.map((p) => p.json)], spec.defs)
  if (decls.length > 0) {
    parts.push(
      `The types its values have; build values of these shapes:\n\`\`\`ts\n${decls.join('\n\n')}\n\`\`\``,
    )
  }
  const lives = spec.params.filter((p) => p.live !== null)
  if (lives.length > 0) {
    const text = lives
      .map((p) => usage(p.name, p.live as LiveSpec, bound.live[p.name] as object))
      .join('\n\n')
    parts.push(
      `The live inputs are objects on the host: call their methods with await, as listed here, and don't build new ones.\n\`\`\`ts\n${text}\n\`\`\``,
    )
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** @internal */
export type Result =
  | readonly ['success', unknown]
  | readonly ['failed', string]
  | readonly ['needs_input', string]

const SAID: Readonly<Record<Result[0], string>> = {
  success: FINISHED,
  failed: GAVE_UP,
  needs_input: ASKED,
}

const text = fromJsonSchema<string>({ type: 'string' })

/**
 * The host half of `task`: what agent code's calls reach, typed by the
 * task's return. It records the result and ends the script that called
 * it; the loop reads the record, never the script's error, so a script
 * that catches the stop still ends the task.
 */
export class TaskHost {
  result: Result | null = null

  /** `task` as the task's world binds it. */
  object(spec: TaskSpec): object {
    const settle = (ws: Workspace, result: Result) => {
      this.result = result
      // nothing after the call runs
      ws.interrupt()
    }
    const contract: HostContract = {
      success: { args: spec.returns === null ? [] : { value: spec.returns } },
      fail: { args: { reason: text } },
      needsInput: { args: { question: text } },
    }
    return typedHost(
      hostFactory((ws) => ({
        success: (value?: unknown) => settle(ws, ['success', spec.returns === null ? null : value]),
        fail: (reason: string) => settle(ws, ['failed', reason]),
        needsInput: (question: string) => settle(ws, ['needs_input', question]),
      })),
      contract,
    )
  }
}

/** Record how the task stands once its code has settled it. */
export function settle(plane: WorkspacePlane, result: Result): void {
  const [status, detail] = result
  plane.set('state', {
    status,
    ...(status === 'needs_input' && { question: detail }),
    ...(status === 'failed' && { reason: detail }),
  })
  if (status === 'success' && detail !== null) {
    try {
      plane.set('value', encode(detail))
    } catch {
      // a value the encoding can't keep: not stored
    }
  }
}

/** Start the plane for a task about to run: what it is, the world it
 *  was forked from (`origin`, null for a scratch world), and each input
 *  sent by value, encoded. What the world held there before goes. */
export async function begin(
  plane: WorkspacePlane,
  spec: TaskSpec,
  bound: Bound,
  origin: string | null,
): Promise<void> {
  await plane.clear()
  const params: Record<string, unknown> = {}
  for (const p of spec.params) {
    let stored = false
    if (p.live === null) {
      try {
        plane.set(`inputs/${p.name}`, encode(bound.data[p.name]))
        stored = true
      } catch {
        // one the encoding can't keep is passed again on a resume
      }
    }
    params[p.name] = { type: p.type, ...(p.json !== null && { schema: p.json }), stored }
  }
  plane.set('spec', {
    format: 1,
    name: spec.name,
    world: origin,
    instructions: spec.instructions,
    params,
    returns: {
      type: spec.returnType,
      ...(spec.returnJson !== null && { schema: spec.returnJson }),
    },
  })
  plane.set('state', { status: 'running' })
}

/** A task's world, open: its workspace, its name in its store, and how
 *  to put it away, kept or not. `keepUnsettled`: whether to keep it
 *  when its task doesn't settle (a world kept for a resume stays kept
 *  until its task settles, so a resume cut short can be made again). */
interface Opened {
  readonly ws: Workspace
  readonly name: string
  putAway(kept: boolean): Promise<void>
  readonly keepUnsettled: boolean
}

/** @internal Scratch worlds kept for a resume, by ref, when the agent
 *  has no store of its own for them: the memory store each lives in,
 *  and the profile it was built from. In this process only; one resumed
 *  to an end is dropped. */
export const KEPT = new Map<string, { readonly store: Store; readonly profile: Profile }>()

export type TaskStatus = 'success' | 'failed' | 'needs_input' | 'interrupted' | 'cancelled'

/** How a task came out: an {@link Outcome}, with the value on
 *  `success`, the ref of the world kept (`keep`, or a task that asked),
 *  and for a task waiting on an answer, `resume`. */
export interface TaskOutcome<T = unknown> extends Outcome {
  readonly value: T | null
  readonly ref: string | null
  /** Continue a task that asked, with its answer: the same world and
   *  `keep`, and the same live inputs unless others are passed. */
  readonly resume?: (
    answer: unknown,
    opts?: { live?: Readonly<Record<string, object>> },
  ) => Promise<TaskOutcome<T>>
}

/** A task that didn't hand back a value; `outcome` says how it ended. */
export class TaskError extends Error {
  override readonly name: string = 'TaskError'
  constructor(
    task: string,
    readonly outcome: TaskOutcome,
  ) {
    super(`task '${task}' ${outcome.status}${outcome.message ? `: ${outcome.message}` : ''}`)
  }
}

/** The task failed: `task.fail`, an error, or a model that never
 *  finished. */
export class TaskFailed extends TaskError {
  override readonly name: string = 'TaskFailed'
}

/** A provider error worth retrying cut the task short. */
export class TaskInterrupted extends TaskError {
  override readonly name: string = 'TaskInterrupted'
}

/** The task asked a question and waits for its answer:
 *  `outcome.resume(answer)`, or the task's `resume` with `ref`. */
export class NeedsInput extends TaskError {
  override readonly name: string = 'NeedsInput'
  get question(): string {
    return this.outcome.message ?? ''
  }
  get ref(): string | null {
    return this.outcome.ref
  }
}

function unwrap<T>(task: string, outcome: TaskOutcome<T>): T {
  if (outcome.status === 'success') return outcome.value as T
  if (outcome.status === 'failed') throw new TaskFailed(task, outcome)
  if (outcome.status === 'interrupted') throw new TaskInterrupted(task, outcome)
  if (outcome.status === 'needs_input') throw new NeedsInput(task, outcome)
  throw new TaskError(task, outcome)
}

export interface RunOptions {
  /** Run on a fork of this world's last commit, with a fresh
   *  conversation, rather than a scratch world. */
  readonly world?: Workspace
  /** Keep the fork; the outcome's `ref` names it. */
  readonly keep?: boolean
  /** Stop the task: it ends `cancelled`. */
  readonly signal?: AbortSignal
}

export interface ResumeOptions extends RunOptions {
  /** The live inputs, passed again: they aren't stored. */
  readonly live?: Readonly<Record<string, object>>
}

/** A task: call it for its value, or `run` it for its outcome. */
export interface Task<
  P extends Params = Params,
  R extends StandardSchemaV1 | undefined = undefined,
> {
  /** The value, or {@link TaskFailed}, {@link NeedsInput} or
   *  {@link TaskInterrupted} when there is none. */
  (inputs: Inputs<P>, opts?: Omit<RunOptions, 'keep'>): Promise<Value<R>>
  readonly spec: TaskSpec
  readonly agent: Agent
  /** Run the task to its end; its outcome. */
  run(inputs: Inputs<P>, opts?: RunOptions): Promise<TaskOutcome<Value<R>>>
  /**
   * Continue the task at `ref`, which asked for input, with `answer` as
   * the next message its model reads; its outcome. `world` is the world
   * it ran on, whose store keeps `ref`; without it, `ref` is a scratch
   * world: on the agent's `scratch` store, or kept in this process. The
   * inputs come back from the task's world, and a live one is passed
   * again (`live`). The world's task must be this one, by name, inputs
   * and return.
   */
  resume(ref: string, answer: unknown, opts?: ResumeOptions): Promise<TaskOutcome<Value<R>>>
}

/** @internal `agent.task(...)`'s. */
export function makeTask<P extends Params, R extends StandardSchemaV1 | undefined>(
  agent: Agent,
  opts: TaskOptions<P, R>,
): Task<P, R> {
  const runner = new TaskRunner(
    agent,
    new TaskSpec(opts as TaskOptions<Params, StandardSchemaV1 | undefined>),
  )
  const call = async (inputs: Inputs<P>, o: Omit<RunOptions, 'keep'> = {}) =>
    unwrap(runner.spec.name, await runner.run(inputs, o)) as Value<R>
  return Object.assign(call, {
    spec: runner.spec,
    agent,
    run: (inputs: Inputs<P>, o?: RunOptions) =>
      runner.run(inputs, o) as Promise<TaskOutcome<Value<R>>>,
    resume: (ref: string, answer: unknown, o?: ResumeOptions) =>
      runner.resume(ref, answer, o) as Promise<TaskOutcome<Value<R>>>,
  })
}

class TaskRunner {
  constructor(
    readonly agent: Agent,
    readonly spec: TaskSpec,
  ) {}

  async run(
    inputs: Readonly<Record<string, unknown>>,
    opts: RunOptions = {},
  ): Promise<TaskOutcome> {
    if (opts.keep === true && opts.world === undefined && this.agent.scratch === null) {
      throw new TypeError(
        'keep needs world: a scratch world lives in memory, and is gone once the task ends (or give the agent a scratch store)',
      )
    }
    const bound = await bindInputs(this.spec, inputs)
    return this.#drive(
      (host) => this.#open(opts.world ?? null, bound, host),
      brief(this.spec, bound),
      opts,
      bound.live,
    )
  }

  async resume(ref: string, answer: unknown, opts: ResumeOptions = {}): Promise<TaskOutcome> {
    const world = opts.world ?? null
    let store: Store
    let base: Profile
    if (world !== null) {
      store = world.store
      base = world.settings.profile
    } else if (this.agent.scratch !== null) {
      store = this.agent.scratch
      base = this.agent.profile
    } else {
      const kept = KEPT.get(ref)
      if (kept === undefined) {
        throw new Error(
          `no scratch world '${ref}' is kept in this process: a scratch world on no store of the agent's resumes only in the process that ran it, and one forked from a world resumes through that world (world)`,
        )
      }
      ;({ store, profile: base } = kept)
    }
    const plane = await read(store, ref)
    this.#waiting(ref, plane, world)
    const bound = await this.#restore(plane.inputs, opts.live ?? {})
    const said = typeof answer === 'string' ? answer : preview(answer)
    return this.#drive(
      (host) => this.#reopen(ref, store, world, base, bound, host),
      answerText(said),
      opts,
      bound.live,
    )
  }

  async #open(world: Workspace | null, bound: Bound, host: TaskHost): Promise<Opened> {
    const id = newId().slice(0, 8)
    if (world === null) {
      const own = this.agent.scratch
      const store = own ?? (await Store.open(new Memory()))
      const base = this.agent.profile
      const name = `${this.spec.name}-${id}`
      const ws = await store.open(name, { profile: taskProfile(this.spec, base, bound, host) })
      await begin(ws.plane(PLANE), this.spec, bound, null)
      return {
        ws,
        name,
        keepUnsettled: false,
        putAway: async (kept) => {
          await ws.close()
          if (own === null) {
            if (kept) KEPT.set(name, { store, profile: base })
          } else if (!kept) {
            await store.delete(name)
          }
        },
      }
    }
    const store = world.store
    const profile = taskProfile(this.spec, world.settings.profile, bound, host)
    const name = `${world.session}.${this.spec.name}-${id}`
    // from the last commit, so the caller's branch gains nothing, not
    // even a commit of the writes it has pending
    await (await world.fork(name, { at: world.head, inherit: 'fresh' })).close()
    let ws: Workspace
    try {
      ws = await store.open(name, { ...world.settings, profile })
      await begin(ws.plane(PLANE), this.spec, bound, world.session)
    } catch (e) {
      await store.delete(name)
      throw e
    }
    return {
      ws,
      name,
      keepUnsettled: false,
      putAway: async (kept) => {
        await ws.close()
        if (!kept) await store.delete(name)
      },
    }
  }

  async #reopen(
    ref: string,
    store: Store,
    world: Workspace | null,
    base: Profile,
    bound: Bound,
    host: TaskHost,
  ): Promise<Opened> {
    const profile = taskProfile(this.spec, base, bound, host)
    const ws = await store.open(ref, world === null ? { profile } : { ...world.settings, profile })
    const kept = world === null && this.agent.scratch === null
    return {
      ws,
      name: ref,
      keepUnsettled: true,
      putAway: async (keep) => {
        await ws.close()
        if (keep) return
        if (kept) KEPT.delete(ref)
        else await store.delete(ref)
      },
    }
  }

  /** Refuse a world that isn't this task's (the same name, inputs and
   *  return), reached through the world it ran on, and waiting for an
   *  answer. */
  #waiting(ref: string, plane: PlaneRead, world: Workspace | null): void {
    const spec = plane.spec
    if (spec === null) throw new Error(`'${ref}' isn't the world of a task`)
    const params = (spec.params ?? {}) as Record<string, { type?: unknown }>
    const held = signature(
      String(spec.name),
      Object.entries(params).map(([n, p]) => [n, String(p.type)]),
      String((spec.returns as { type?: unknown } | undefined)?.type),
    )
    if (held !== this.spec.contract) {
      throw new Error(
        `'${ref}' isn't a world of this task: it holds ${held}, and this task is ${this.spec.contract}`,
      )
    }
    // a fork is reopened with its world's settings, so it resumes
    // through that world, and a scratch world through none
    const origin = spec.world ?? null
    if (origin !== (world?.session ?? null)) {
      const ran = origin === null ? 'a scratch world' : `world '${String(origin)}'`
      const given = world === null ? 'no world' : `world '${world.session}'`
      throw new Error(
        `task '${this.spec.name}' at '${ref}' ran on ${ran}, and was given ${given}: resume it through the world it ran on`,
      )
    }
    const status = plane.state?.status
    if (status !== 'needs_input') {
      throw new Error(
        `task '${this.spec.name}' at '${ref}' isn't waiting for an answer: it is ${typeof status === 'string' ? status : 'in no known state'}`,
      )
    }
  }

  /** The inputs to resume with: each stored one decoded and checked,
   *  and each live one passed again. */
  async #restore(
    stored: ReadonlyMap<string, Uint8Array>,
    live: Readonly<Record<string, object>>,
  ): Promise<Bound> {
    const name = this.spec.name
    const known = new Set(this.spec.params.map((p) => p.name))
    const unknown = Object.keys(live).filter((k) => !known.has(k))
    if (unknown.length > 0) {
      throw new TypeError(
        `${name}.resume() got inputs the task doesn't take: ${unknown.sort().join(', ')}`,
      )
    }
    const data: Record<string, unknown> = {}
    const lives: Record<string, object> = {}
    for (const p of this.spec.params) {
      const blob = stored.get(p.name)
      if (blob !== undefined) {
        if (p.name in live) {
          throw new TypeError(
            `${name}.resume(): '${p.name}' is stored with the task; only an input that can't be stored is passed again`,
          )
        }
        data[p.name] = await checkInput(
          this.spec,
          p,
          decode(blob),
          `${name}()'s stored input '${p.name}'`,
        )
      } else if (p.name in live) {
        const what = `${name}()'s argument '${p.name}'`
        if (p.live !== null) lives[p.name] = checkLive(p, live[p.name], what)
        else data[p.name] = await checkInput(this.spec, p, live[p.name], what)
      } else {
        throw new TypeError(
          `resuming task '${name}' needs its input '${p.name}' again: it isn't stored (a live object isn't), so pass it in live: { ${p.name} }`,
        )
      }
    }
    return { data, live: lives }
  }

  /** Open the task's world, run the model there from `prompt` to an
   *  end, and put the world away: kept if `keep`, or if the task asked
   *  for input. */
  async #drive(
    open: (host: TaskHost) => Promise<Opened>,
    prompt: string,
    opts: RunOptions,
    lives: Readonly<Record<string, object>>,
  ): Promise<TaskOutcome> {
    const host = new TaskHost()
    const opened = await open(host)
    const plane = opened.ws.plane(PLANE)
    const hooks = taskHooks(host, plane)
    let ran: Outcome | null = null
    let waiting = false
    let kept = false
    const session = this.agent.session(opened.ws, { hooks })
    const stop = () => session.cancel('the task was stopped')
    try {
      // the turn is there to cancel from the moment it starts, so a
      // signal already aborted stops it before any model call
      const running = session.stream(prompt).wait()
      opts.signal?.addEventListener('abort', stop, { once: true })
      if (opts.signal?.aborted === true) stop()
      ran = await running
    } finally {
      opts.signal?.removeEventListener('abort', stop)
      const result = host.result
      const asked = result !== null && result[0] === 'needs_input'
      waiting =
        ran !== null
          ? asked || (result === null && opened.keepUnsettled)
          : opened.keepUnsettled && (result === null || asked)
      kept = opts.keep === true || waiting
      await opened.putAway(kept)
    }
    const outcome = taskOutcome(ran, host, kept ? opened.name : null)
    if (!waiting) return outcome
    const ref = opened.name
    return {
      ...outcome,
      resume: (answer, more = {}) =>
        this.resume(ref, answer, {
          ...(opts.world !== undefined && { world: opts.world }),
          ...(opts.keep !== undefined && { keep: opts.keep }),
          live: { ...lives, ...more.live },
        }),
    }
  }
}

/** @internal The inputs of a call, checked: data by its schema, live
 *  objects as objects. */
export async function bindInputs(
  spec: TaskSpec,
  inputs: Readonly<Record<string, unknown>>,
): Promise<Bound> {
  const name = spec.name
  const known = new Set(spec.params.map((p) => p.name))
  const unknown = Object.keys(inputs).filter((k) => !known.has(k))
  if (unknown.length > 0) {
    throw new TypeError(`${name}() got inputs it doesn't take: ${unknown.sort().join(', ')}`)
  }
  const data: Record<string, unknown> = {}
  const lives: Record<string, object> = {}
  for (const p of spec.params) {
    const what = `${name}()'s argument '${p.name}'`
    if (p.live !== null) lives[p.name] = checkLive(p, inputs[p.name], what)
    else data[p.name] = await checkInput(spec, p, inputs[p.name], what)
  }
  return { data, live: lives }
}

/** @internal The task world's profile: `base` with the task's inputs and
 *  `task`. */
export function taskProfile(spec: TaskSpec, base: Profile, bound: Bound, host: TaskHost): Profile {
  const taken = [...Object.keys(bound.data), ...Object.keys(bound.live), 'task'].filter(
    (n) => n in (base.hostObjects ?? {}) || n in (base.values ?? {}),
  )
  if (taken.length > 0) {
    throw new Error(
      `the world already binds ${taken.join(', ')}, which task '${spec.name}' binds too; rename the input`,
    )
  }
  const lives = Object.fromEntries(
    spec.params
      .filter((p) => p.live !== null)
      .map((p) => {
        const obj = bound.live[p.name] as object
        const methods = (p.live as LiveSpec).methods
        if (methods === undefined) return [p.name, obj]
        const contract = Object.fromEntries(
          Object.entries(methods).map(([m, { args, returns }]) => [
            m,
            { ...(args !== undefined && { args }), ...(returns !== undefined && { returns }) },
          ]),
        )
        return [p.name, typedHost(obj, contract)]
      }),
  )
  return {
    ...base,
    hostObjects: { ...base.hostObjects, ...lives, task: host.object(spec) },
    values: { ...base.values, ...bound.data },
  }
}

/** @internal How a task's loop differs from a session's: its
 *  instructions, the result of the call that settles it (recorded on
 *  its plane), the end of the run there, and the nudges. */
export function taskHooks(host: TaskHost, plane: WorkspacePlane): Hooks {
  let nudged = 0
  return {
    instructions: INSTRUCTIONS,
    afterCall: (output) => {
      const result = host.result
      if (result === null) return output
      // the turn commits at its end: the plane says how the task
      // stands in the commit of the run that settled it
      settle(plane, result)
      return { text: SAID[result[0]], images: [], isError: false }
    },
    done: () => host.result !== null,
    onStop: (): Message | string => {
      if (nudged < NUDGES) {
        nudged += 1
        return { id: newId(), role: 'user', parts: [{ kind: 'text', text: NUDGE }] }
      }
      return `the model stopped ${nudged + 1} times without calling task.success, task.fail or task.needsInput`
    },
  }
}

/** @internal How a task's run came out, by what its code settled. */
export function taskOutcome(ran: Outcome, host: TaskHost, ref: string | null): TaskOutcome {
  const result = host.result
  let status = ran.status as Outcome['status']
  let value: unknown = null
  let message = ran.message
  if (result !== null && result[0] === 'success')
    [status, value, message] = ['success', result[1], null]
  else if (result !== null && result[0] === 'needs_input')
    [status, message] = ['needs_input', result[1]]
  else if (result !== null) [status, message] = ['failed', result[1]]
  else if (status === 'completed') [status, message] = ['failed', 'the run ended without a result']
  return { ...ran, status, value, message, ref }
}

interface PlaneRead {
  readonly spec: Record<string, unknown> | null
  readonly state: Record<string, unknown> | null
  readonly inputs: ReadonlyMap<string, Uint8Array>
}

/** What the plane of the task world `ref` holds. */
async function read(store: Store, ref: string): Promise<PlaneRead> {
  if (!(await store.exists(ref))) throw new Error(`no task world '${ref}' in this store`)
  const ws = await store.open(ref)
  try {
    const plane = ws.plane(PLANE)
    const record = (v: unknown) =>
      typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
    const inputs = new Map<string, Uint8Array>()
    for (const key of await plane.keys()) {
      if (!key.startsWith('inputs/')) continue
      const blob = await plane.get(key)
      if (blob instanceof Uint8Array) inputs.set(key.slice('inputs/'.length), blob)
    }
    return {
      spec: record(await plane.get('spec')),
      state: record(await plane.get('state')),
      inputs,
    }
  } finally {
    await ws.close()
  }
}
