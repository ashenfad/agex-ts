/**
 * agex-ts under the shape corpus, after Python agex's
 * `conformance/tasks.py` and `conformance/runner.py`: a scenario's task
 * run as an agex-ts task, and what came of it checked.
 *
 *     const harness = new AgexTasks({ profile })
 *     for (const s of TASK_SCENARIOS.filter((s) => appliesToTs(s)))
 *       check(s, await runTaskScenario(s, harness))
 *
 * **The task is built from the scenario's schemas:** each data type a
 * Standard Schema of its JSON Schema ({@link fromJsonSchema}), a live
 * one a {@link live} input whose methods answer from the scenario's
 * replies, recording each call. **A task step is one `run_ts` call**
 * that does what it says: `await task.success(...)` with the value
 * written as TypeScript, `task.fail` or `task.needsInput`.
 *
 * The runner owns the script: the model asks it for each reply, so it
 * counts what the model was asked for, and catches a harness asking for
 * more than the script holds.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { type Profile, Store, type Workspace } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { Agent } from '../agent'
import { fromJsonSchema, refName } from '../schema'
import { ScriptedProvider } from '../scripted'
import { KEPT, type LiveMethod, PLANE, type Task, type TaskOutcome, live } from '../task'
import type {
  LiveCall,
  OutcomeExp,
  PlaneExp,
  ShapeStep,
  TaskCall,
  TaskResume,
  TaskScenario,
} from './shape'

type Json = Readonly<Record<string, unknown>>

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** The reply past the end of a script: text with no call, which a task
 *  takes for a model that stopped without finishing. */
export const RAN_OUT: ModelStep = {
  kind: 'model',
  text: '(the script has nothing more)',
  thinking: '',
  tool_calls: [],
  fail: '',
  input_tokens: 0,
}

/** The model's replies for the act being run, in order. */
export class Script {
  asked = 0
  exhausted = false
  #steps: ShapeStep[] = []

  load(steps: readonly ShapeStep[]): void {
    this.#steps = [...steps]
    this.asked = 0
  }

  /** The script's next step, or {@link RAN_OUT} past its end. */
  next(): ShapeStep {
    this.asked += 1
    const step = this.#steps.shift()
    if (step === undefined) {
      this.exhausted = true
      return RAN_OUT
    }
    return step
  }
}

/** What a kept world's `__task__` plane holds. */
export interface PlaneView {
  readonly status: string
  readonly stored: readonly string[]
  readonly value: boolean
}

/** How a call or resume came out, as the harness saw it. */
export interface OutcomeView {
  readonly status: string
  readonly value?: unknown
  readonly message?: string | null
  /** A refusal's error. */
  readonly error?: string | null
  readonly kept?: boolean
  readonly plane?: PlaneView | null
  readonly calls?: readonly LiveCall[]
}

/** What came of a scenario: an outcome per call and resume, the replies
 *  the model was asked for in each, and whether it asked past the end
 *  of a script. */
export interface Observed {
  readonly outcomes: readonly OutcomeView[]
  readonly asked: readonly number[]
  readonly exhausted: boolean
}

/** Run `scenario` on `harness`. */
export async function runTaskScenario(
  scenario: TaskScenario,
  harness: AgexTasks,
): Promise<Observed> {
  const script = new Script()
  const opened = await harness.open(scenario, script)
  const outcomes: OutcomeView[] = []
  const asked: number[] = []
  let exhausted = false
  try {
    for (const act of scenario.acts) {
      if (act.kind === 'restart') {
        await opened.restart()
        continue
      }
      script.load(act.steps)
      outcomes.push(act.kind === 'call' ? await opened.call(act) : await opened.resume(act))
      asked.push(script.asked)
      exhausted ||= script.exhausted
    }
  } finally {
    await opened.close()
  }
  return { outcomes, asked, exhausted }
}

/** Every way `observed` differs from what the scenario expects, by
 *  check (`outcome<N>.<part>`, `outcomes`, `script`); empty when all
 *  holds. */
export function checkTaskScenario(scenario: TaskScenario, observed: Observed): Map<string, string> {
  const failures = new Map<string, string>()
  if (observed.outcomes.length !== scenario.expect.length) {
    failures.set('outcomes', `${observed.outcomes.length} outcome(s) came`)
  }
  scenario.expect.forEach((want, i) => {
    const got = observed.outcomes[i]
    if (got === undefined) return
    for (const [part, problem] of differences(want, got, observed.asked[i] ?? 0)) {
      failures.set(`outcome${i + 1}.${part}`, problem)
    }
  })
  if (observed.exhausted) {
    failures.set('script', 'the harness asked the model for more than the script holds')
  }
  return failures
}

function differences(want: OutcomeExp, got: OutcomeView, asked: number): Map<string, string> {
  const found = new Map<string, string>()
  const show = (v: unknown) => JSON.stringify(v)
  if (got.status !== want.status) {
    const why = got.error ?? got.message
    found.set('status', `'${got.status}', not '${want.status}'${why ? ` (${why})` : ''}`)
    return found
  }
  if (want.status === 'success' && !same(got.value, want.value)) {
    found.set('value', `${show(got.value)} != ${show(want.value)}`)
  }
  if (want.message !== null && got.message !== want.message) {
    found.set('message', `${show(got.message)} != ${show(want.message)}`)
  }
  const missing = want.names.filter((name) => !(got.error ?? '').includes(name))
  if (missing.length > 0) found.set('names', `${show(got.error)} doesn't name ${show(missing)}`)
  if (want.asked !== null && asked !== want.asked) {
    found.set('asked', `the model was asked ${asked} time(s), not ${want.asked}`)
  }
  if (want.kept !== null && (got.kept ?? false) !== want.kept) {
    found.set('kept', `${got.kept ? 'kept' : 'kept nothing'}, not as expected`)
  }
  if (want.plane !== null && !planeFits(got.plane ?? null, want.plane)) {
    found.set('plane', `${show(got.plane)} != ${show(want.plane)}`)
  }
  if (want.calls !== null && !same(got.calls ?? [], want.calls)) {
    found.set('calls', `${show(got.calls)} != ${show(want.calls)}`)
  }
  return found
}

function planeFits(got: PlaneView | null, want: PlaneExp): boolean {
  return (
    got !== null &&
    same([got.status, got.stored, got.value], [want.status, want.stored, want.value])
  )
}

/** JSON equality: a boolean is no number. */
/** @internal */
export function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    )
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    return same(ka, kb) && ka.every((k) => same((a as Json)[k], (b as Json)[k]))
  }
  return a === b
}

// ---------------------------------------------------------------------------
// Values to and from JSON
// ---------------------------------------------------------------------------

const toBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const fromBytes = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/** The definition `schema` names, or `schema` itself. */
function resolved(schema: unknown, defs: Readonly<Record<string, Json>>): Json {
  const name = refName(schema)
  return name !== null ? (defs[name] ?? {}) : ((schema ?? {}) as Json)
}

/** A JSON value as `schema` reads it: bytes from base64, and a live
 *  object made for a live type. */
function build(
  value: unknown,
  schema: unknown,
  defs: Readonly<Record<string, Json>>,
  makeLive: (kind: string) => object,
): unknown {
  const name = refName(schema)
  const s = resolved(schema, defs)
  if (s['x-kind'] === 'live') return makeLive(name ?? 'object')
  if (s['x-kind'] === 'bytes' && typeof value === 'string') return toBytes(value)
  if (Array.isArray(s.anyOf)) {
    for (const member of s.anyOf) {
      const m = resolved(member, defs)
      if (value === null ? m.type === 'null' : m.type !== 'null')
        return build(value, member, defs, makeLive)
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => build(v, s.items, defs, makeLive))
  if (typeof value === 'object' && value !== null) {
    const props = (s.properties ?? {}) as Json
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        build(v, props[k] ?? s.additionalProperties, defs, makeLive),
      ]),
    )
  }
  return value
}

/** A JSON value written as TypeScript that builds it as `schema`'s
 *  type. */
/** @internal */
export function written(
  value: unknown,
  schema: unknown,
  defs: Readonly<Record<string, Json>>,
): string {
  const s = resolved(schema, defs)
  if (s['x-kind'] === 'bytes' && typeof value === 'string') {
    return `new Uint8Array([${[...toBytes(value)].join(', ')}])`
  }
  if (Array.isArray(value)) return `[${value.map((v) => written(v, s.items, defs)).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    const props = (s.properties ?? {}) as Json
    const pairs = Object.entries(value).map(
      ([k, v]) => `${JSON.stringify(k)}: ${written(v, props[k] ?? s.additionalProperties, defs)}`,
    )
    return `{ ${pairs.join(', ')} }`
  }
  return JSON.stringify(value)
}

/** A value as JSON: bytes as base64. */
/** @internal */
export function json(value: unknown): unknown {
  if (value instanceof Uint8Array) return fromBytes(value)
  if (Array.isArray(value)) return value.map(json)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]))
  }
  return value
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

const step = (code: string): ModelStep => ({
  kind: 'model',
  text: '',
  thinking: '',
  tool_calls: [{ name: 'run_ts', args: { code } }],
  fail: '',
  input_tokens: 0,
})

/** agex-ts as a shape-corpus harness. `profile` is what its worlds are
 *  opened with (where the kernel's worker runs, say). */
export class AgexTasks {
  readonly name = 'agex-ts'
  readonly profile: Profile

  constructor(opts: { profile?: Profile } = {}) {
    this.profile = opts.profile ?? {}
  }

  async open(scenario: TaskScenario, script: Script): Promise<OpenedScenario> {
    const opened = new OpenedScenario(scenario, this.profile, script)
    await opened.start(true)
    return opened
  }
}

/** A scenario, open: its store and world, the agent and task, and the
 *  last outcome. */
export class OpenedScenario {
  readonly #scenario: TaskScenario
  readonly #profile: Profile
  readonly #script: Script
  readonly #defs: Readonly<Record<string, Json>>
  readonly #kv = new Memory()
  readonly #calls: LiveCall[] = []
  readonly #scratch = new Set<string>()
  #store!: Store
  #ws!: Workspace
  #task: Task | null = null
  #refused: Error | null = null
  #outcome: TaskOutcome | null = null
  #ref: string | null = null
  #onWorld = false

  constructor(scenario: TaskScenario, profile: Profile, script: Script) {
    this.#scenario = scenario
    this.#profile = profile
    this.#script = script
    this.#defs = scenario.task.defs as Readonly<Record<string, Json>>
  }

  /** @internal Open the store and the world, seeding it the first time,
   *  and define the task. */
  async start(seed: boolean): Promise<void> {
    this.#store = await Store.open(this.#kv)
    this.#ws = await this.#store.open('main', { profile: this.#profile })
    if (seed) {
      for (const [path, text] of Object.entries(this.#scenario.world.files)) {
        await this.#ws.files.write(path, text)
      }
    }
    const agent = new Agent({
      model: new ScriptedProvider(() => this.#reply()),
      profile: this.#profile,
    })
    try {
      this.#task = agent.task(this.#definition()) as unknown as Task
    } catch (e) {
      this.#refused = e as Error
    }
  }

  /** The task's definition, from the scenario's schemas. */
  #definition() {
    const task = this.#scenario.task
    const defs = this.#defs
    const typed = (schema: unknown) => fromJsonSchema(schema as Json, defs)
    const asLive = (schema: unknown) => {
      const name = refName(schema)
      const def = name === null ? null : defs[name]
      if (def?.['x-kind'] !== 'live') return null
      const methods = (def.methods ?? {}) as Record<string, Json>
      return live({
        name: name as string,
        ...(typeof def.description === 'string' && { description: def.description }),
        methods: Object.fromEntries(
          Object.entries(methods).map(([m, spec]): [string, LiveMethod] => [
            m,
            {
              args: Object.fromEntries(
                ((spec.params ?? []) as { name: string; type: unknown }[]).map((p) => [
                  p.name,
                  typed(p.type),
                ]),
              ),
              returns: typed(spec.returns ?? {}),
              ...(typeof spec.description === 'string' && { description: spec.description }),
            },
          ]),
        ),
      })
    }
    const returns = task.returns as Json
    return {
      name: task.name,
      instructions: task.instructions,
      params: Object.fromEntries(task.params.map((p) => [p.name, asLive(p.type) ?? typed(p.type)])),
      ...(returns.type !== 'null' && { returns: asLive(returns) ?? typed(returns) }),
    } as Parameters<Agent['task']>[0]
  }

  // -- the model --

  #reply(): ModelStep {
    const next = this.#script.next()
    return next.kind === 'model' ? next : step(this.#code(next))
  }

  #code(next: Exclude<ShapeStep, ModelStep>): string {
    if (next.kind === 'task_fail') return `await task.fail(${JSON.stringify(next.reason)})`
    if (next.kind === 'task_needs_input') {
      return `await task.needsInput(${JSON.stringify(next.question)})`
    }
    const value = next.value
    if (value === null) return 'await task.success()'
    if (value.kind === 'input') return `await task.success(${value.name})`
    if (value.kind === 'method_call') {
      const args = value.args.map((a) => JSON.stringify(a)).join(', ')
      return `await task.success(await ${value.input}.${value.method}(${args}))`
    }
    return `await task.success(${written(value.value, this.#scenario.task.returns, this.#defs)})`
  }

  // -- the acts --

  /** A live object for input `input`: each method answers from the
   *  scenario's replies, and its call is recorded. */
  #live(input: string, kind: string): object {
    const def = this.#defs[kind] ?? {}
    const methods = (def.methods ?? {}) as Record<
      string,
      { replies?: { args: unknown[]; returns: unknown }[] }
    >
    const calls = this.#calls
    return Object.fromEntries(
      Object.entries(methods).map(([method, spec]) => [
        method,
        (...args: unknown[]) => {
          calls.push({ input, method, args })
          const reply = (spec.replies ?? []).find((r) => same(r.args, args))
          if (reply === undefined)
            throw new Error(`${kind}.${method} has no reply for ${JSON.stringify(args)}`)
          return reply.returns
        },
      ]),
    )
  }

  #input(name: string, value: unknown): unknown {
    const param = this.#scenario.task.params.find((p) => p.name === name)
    if (param === undefined) return value // the call refuses it
    return build(value, param.type, this.#defs, (kind) => this.#live(name, kind))
  }

  #inputs(given: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(given).map(([n, v]) => [n, this.#input(n, v)]))
  }

  async call(act: TaskCall): Promise<OutcomeView> {
    this.#calls.length = 0
    let out: TaskOutcome
    try {
      if (this.#task === null) throw this.#refused
      out = await this.#task.run(this.#inputs(act.inputs) as never, {
        ...(act.world && { world: this.#ws }),
        keep: act.keep,
      })
    } catch (e) {
      return { status: 'refused', error: errorText(e) }
    }
    this.#outcome = out
    this.#ref = out.ref
    this.#onWorld = act.world
    return this.#view(out)
  }

  async resume(act: TaskResume): Promise<OutcomeView> {
    this.#calls.length = 0
    let out: TaskOutcome
    try {
      const lives = Object.fromEntries(act.live.map((n) => [n, this.#input(n, {}) as object]))
      if (act.by === 'outcome') {
        if (this.#outcome?.resume === undefined) throw new Error('no outcome to resume')
        out = await this.#outcome.resume(act.answer, { live: lives })
      } else {
        if (this.#task === null) throw this.#refused
        if (this.#ref === null) throw new Error('no task world to resume')
        out = await this.#task.resume(this.#ref, act.answer, {
          ...(this.#onWorld && { world: this.#ws }),
          keep: act.keep,
          live: lives,
        })
      }
    } catch (e) {
      return { status: 'refused', error: errorText(e) }
    }
    this.#outcome = out
    this.#ref = out.ref ?? this.#ref
    return this.#view(out)
  }

  /** A restart, as far as the task can tell: the store opened again,
   *  the task defined again, the outcomes held so far gone. */
  async restart(): Promise<void> {
    await this.#ws.close()
    this.#outcome = null
    await this.start(false)
  }

  async close(): Promise<void> {
    await this.#ws.close()
    for (const ref of this.#scratch) KEPT.delete(ref)
  }

  // -- what came of it --

  async #view(out: TaskOutcome): Promise<OutcomeView> {
    if (out.ref !== null && !(await this.#store.exists(out.ref))) this.#scratch.add(out.ref)
    return {
      status: out.status,
      value: out.status === 'success' ? json(out.value) : null,
      message: out.message,
      kept: out.ref !== null,
      plane: out.ref === null ? null : await this.#plane(out.ref),
      calls: [...this.#calls],
    }
  }

  async #plane(ref: string): Promise<PlaneView | null> {
    const store = (await this.#store.exists(ref)) ? this.#store : (KEPT.get(ref)?.store ?? null)
    if (store === null) return null
    const kept = await store.open(ref)
    try {
      const plane = kept.plane(PLANE)
      const keys = await plane.keys()
      const state = (await plane.get('state')) as { status?: unknown } | null
      return {
        status: String(state?.status),
        stored: keys.filter((k) => k.startsWith('inputs/')).map((k) => k.slice('inputs/'.length)),
        value: keys.includes('value'),
      }
    } finally {
      await kept.close()
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
