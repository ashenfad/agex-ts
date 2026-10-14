/**
 * agex-ts under the shape corpus's code scenarios: tasks agent code
 * defines, after Python agex's `conformance/code_tasks.py`.
 *
 *     for (const s of CODE_SCENARIOS.filter((s) => appliesToTs(s)))
 *       checkCodeScenario(s, await runCodeScenario(s, { profile }))
 *
 * Each act is one turn of a lead session on a world granted `agex`
 * ({@link agentTasks}). The lead's model writes the calling code from
 * the task's schemas: `agex.task({...})` with each type a JSON Schema
 * literal carrying the task's definitions, the call (or `.map`), and a
 * line reporting what came of it: the value, or the error it raised.
 * Each helper follows the act's `helper` steps, written as a task's
 * are (`conformance/tasks.ts`).
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { type Profile, Store } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { Agent } from '../agent'
import { agentTasks } from '../code-tasks'
import { ScriptedProvider } from '../scripted'
import type { CodeCall, CodeExp, CodeScenario, ShapeStep } from './shape'
import { RAN_OUT, json, same, written } from './tasks'

type Json = Readonly<Record<string, unknown>>

/** What a lead turn's prompt opens with: how the model tells the lead's
 *  requests from a helper's. */
export const LEAD = 'LEAD'

/** What opens the line the calling code reports on. */
export const MARK = '@@agex-code@@'

/**
 * Python's words for what TS spells otherwise, in what a refusal must
 * name: a task's docstring is its `instructions`, and a parameter's
 * annotation its type.
 */
export const SPELLED: Readonly<Record<string, string>> = {
  docstring: 'instructions',
  annotation: 'type',
}

/** What the calling code reported for one act. */
export interface CodeView {
  readonly status: string
  readonly value?: unknown
  readonly values?: readonly unknown[] | null
  readonly message?: string | null
}

const step = (code: string): ModelStep => ({
  kind: 'model',
  text: '',
  thinking: '',
  tool_calls: [{ name: 'run_ts', args: { code } }],
  fail: '',
  input_tokens: 0,
})

const says = (text: string): ModelStep => ({ ...RAN_OUT, text })

/** A schema of the task's, carrying the definitions it may name. */
function withDefs(schema: unknown, defs: Json): unknown {
  if (schema === null || typeof schema !== 'object') return schema
  return Object.keys(defs).length === 0 ? schema : { ...schema, $defs: defs }
}

/** A helper's step as its model's reply. */
function helperStep(next: ShapeStep, scenario: CodeScenario): ModelStep {
  if (next.kind === 'model') return next
  if (next.kind === 'task_fail') return step(`await task.fail(${JSON.stringify(next.reason)})`)
  if (next.kind === 'task_needs_input') {
    return step(`await task.needsInput(${JSON.stringify(next.question)})`)
  }
  const value = next.value
  if (value === null) return step('await task.success()')
  if (value.kind === 'input') return step(`await task.success(${value.name})`)
  if (value.kind === 'method_call') throw new Error('a helper calls no live input')
  const { returns, defs } = scenario.task
  return step(`await task.success(${written(value.value, returns, defs as Record<string, Json>)})`)
}

/** The calling code for one act: the task, the call, and the report of
 *  what came of it. */
function leadCode(scenario: CodeScenario, act: CodeCall): string {
  const task = scenario.task
  const defs = task.defs as Json
  const params = Object.fromEntries(task.params.map((p) => [p.name, withDefs(p.type, defs)]))
  const returns = (task.returns as Json).type === 'null' ? null : withDefs(task.returns, defs)
  const definition = {
    name: task.name,
    instructions: task.instructions,
    params,
    returns,
  }
  const types = Object.fromEntries(task.params.map((p) => [p.name, p.type ?? {}]))
  const inputs = (item: Readonly<Record<string, unknown>>) =>
    `{ ${Object.entries(item)
      .map(
        ([k, v]) =>
          `${JSON.stringify(k)}: ${written(v, types[k] ?? {}, defs as Record<string, Json>)}`,
      )
      .join(', ')} }`
  const made =
    act.items === null
      ? `await ${task.name}(${inputs(act.inputs)})`
      : `await ${task.name}.map([${act.items.map(inputs).join(', ')}])`
  const reported = act.items === null ? 'value' : 'values'
  return `const report = (what) => console.log(${JSON.stringify(MARK)} + JSON.stringify(what))
let ${task.name}
try {
  ${task.name} = agex.task(${JSON.stringify(definition)})
} catch (e) {
  report({ status: 'refused', message: String(e.message) })
}
if (${task.name} !== undefined) {
  try {
    const result = ${made}
    report({ status: 'value', ${reported}: result })
  } catch (e) {
    if (e instanceof agex.TaskNeedsInput) report({ status: 'needs_input', message: e.question })
    else if (e instanceof agex.TaskFailed) report({ status: 'failed', message: e.message })
    else report({ status: 'refused', message: String(e.message) })
  }
}`
}

/** Run `scenario`: what the calling code reported, per act. */
export async function runCodeScenario(
  scenario: CodeScenario,
  opts: { profile?: Profile } = {},
): Promise<CodeView[]> {
  const lead: ModelStep[] = scenario.acts.flatMap((act) => [
    step(leadCode(scenario, act)),
    says('done'),
  ])
  let current: CodeCall = scenario.acts[0] as CodeCall
  // each helper's replies so far, by the brief its conversation opens with
  const turns = new Map<string, number>()
  const provider = new ScriptedProvider((sent) => {
    const first = sent[1] ?? ''
    if (first.startsWith(LEAD)) return lead.shift() ?? RAN_OUT
    const turn = turns.get(first) ?? 0
    turns.set(first, turn + 1)
    const next = current.helper[turn]
    return next === undefined ? RAN_OUT : helperStep(next, scenario)
  })
  const profile = opts.profile ?? {}
  const agent = new Agent({ model: provider, profile })
  const store = await Store.open(new Memory())
  const ws = await store.open('lead', {
    profile: { ...profile, hostObjects: { ...profile.hostObjects, agex: agentTasks(agent) } },
  })
  const chat = agent.session(ws, { sessions: true })
  const views: CodeView[] = []
  try {
    for (const [n, act] of scenario.acts.entries()) {
      current = act
      turns.clear()
      const outcome = await chat.say(`${LEAD} act ${n + 1}`)
      if (outcome.status !== 'completed') {
        views.push({ status: `turn ${outcome.status}`, message: outcome.message })
        continue
      }
      const run = (await chat.runs()).at(-1)
      const text = (run?.messages ?? [])
        .flatMap((m) => m.parts.map((p) => (p.kind === 'tool_result' ? p.content : '')))
        .join('\n')
      const line = text.split('\n').find((l) => l.startsWith(MARK))
      views.push(
        line === undefined
          ? { status: 'unreported', message: text.slice(-2000) }
          : JSON.parse(line.slice(MARK.length)),
      )
    }
  } finally {
    await chat.close()
    await ws.close()
  }
  return views
}

/** Every way `views` differ from what the scenario expects, by check
 *  (`act<N>.<part>`); empty when all holds. */
export function checkCodeScenario(
  scenario: CodeScenario,
  views: readonly CodeView[],
): Map<string, string> {
  const failures = new Map<string, string>()
  if (views.length !== scenario.expect.length)
    failures.set('acts', `${views.length} act(s) reported`)
  scenario.expect.forEach((want, i) => {
    const got = views[i]
    if (got === undefined) return
    for (const [part, problem] of differences(want, got))
      failures.set(`act${i + 1}.${part}`, problem)
  })
  return failures
}

function differences(want: CodeExp, got: CodeView): Map<string, string> {
  const found = new Map<string, string>()
  const show = (v: unknown) => JSON.stringify(v)
  if (got.status !== want.status) {
    found.set(
      'status',
      `'${got.status}', not '${want.status}'${got.message ? ` (${got.message})` : ''}`,
    )
    return found
  }
  if (want.status === 'value') {
    if (want.values !== null) {
      if (!same(json(got.values ?? []), want.values))
        found.set('values', `${show(got.values)} != ${show(want.values)}`)
    } else if (!same(json(got.value), want.value)) {
      found.set('value', `${show(got.value)} != ${show(want.value)}`)
    }
  }
  const message = got.message ?? ''
  if (want.message !== null && !message.includes(want.message)) {
    found.set('message', `${show(got.message)} doesn't say ${show(want.message)}`)
  }
  const missing = want.names.filter((n) => !message.includes(SPELLED[n] ?? n))
  if (missing.length > 0) found.set('names', `${show(got.message)} doesn't name ${show(missing)}`)
  return found
}
