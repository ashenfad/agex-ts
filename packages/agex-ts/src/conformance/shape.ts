/**
 * The shape corpus's format: agex's scenarios, exported as JSON
 * (`agex/conformance/json/`), field for field. See the schemas beside
 * this file (`task_scenario.schema.json`, `code_scenario.schema.json`).
 *
 * A task is written as JSON Schemas so any language can build it: each
 * parameter's type, the return type, and the record and live classes
 * they name under `defs`. Kinds JSON has no type for are marked
 * `x-kind` (`table`, `array`, `bytes`, and `live` for a class whose
 * methods agent code calls on the host). The model's script is neutral:
 * a task step says what agent code does (`task_success`, `task_fail`,
 * `task_needs_input`), and each harness writes that in its own language
 * as one call of its code tool.
 */

import type { ModelStep } from '@agex-ts/world/conformance'

/** What a scenario may need beyond the base API. */
export const CAPABILITIES: Readonly<Record<string, string>> = {
  tables: "carries tables (Arrow), as a task's inputs and its value",
  arrays: "carries arrays (numpy's), as a task's inputs and its value",
}

/** Where a scenario runs: every rung, or only in the process, or only
 *  off it. agex-ts's code always runs off the process (a worker). */
export type Where = 'anywhere' | 'in-process' | 'off-in-process'

export type Status = 'success' | 'failed' | 'needs_input' | 'interrupted' | 'refused'

/** One input of the task: its name, and its type as a JSON Schema. */
export interface Param {
  readonly name: string
  /** null: no annotation (a code scenario's refusal). */
  readonly type: unknown
}

/** The task: its name, instructions, parameters in order, return type
 *  (`{type: 'null'}` for none), and the classes those name. */
export interface TaskDef {
  readonly name: string
  readonly instructions: string
  readonly params: readonly Param[]
  readonly returns: unknown
  readonly defs: Readonly<Record<string, unknown>>
}

/** A value written out as JSON, read by the type it is given as. */
export interface Value {
  readonly kind: 'value'
  readonly value: unknown
}

/** One of the task's inputs, as agent code sees it. */
export interface Input {
  readonly kind: 'input'
  readonly name: string
}

/** What a method of a live input returns, called with `args`. */
export interface MethodCall {
  readonly kind: 'method_call'
  readonly input: string
  readonly method: string
  readonly args: readonly unknown[]
}

export type Expr = Value | Input | MethodCall

/** Agent code calls `task.success` with `value` (null: no value). */
export interface TaskSuccess {
  readonly kind: 'task_success'
  readonly value: Expr | null
}

/** Agent code calls `task.fail(reason)`. */
export interface TaskFail {
  readonly kind: 'task_fail'
  readonly reason: string
}

/** Agent code calls `task.needsInput(question)`. */
export interface TaskNeedsInput {
  readonly kind: 'task_needs_input'
  readonly question: string
}

/** One reply of the model: a task step is one call of the harness's
 *  code tool, written in its language. */
export type ShapeStep = ModelStep | TaskSuccess | TaskFail | TaskNeedsInput

/** A call of the task with `inputs` (JSON by parameter name), on a
 *  scratch world, or with `world` on a fork of the scenario's world;
 *  `keep` keeps that fork. */
export interface TaskCall {
  readonly kind: 'call'
  readonly inputs: Readonly<Record<string, unknown>>
  readonly steps: readonly ShapeStep[]
  readonly world: boolean
  readonly keep: boolean
}

/** The answer to the last outcome's question, through the outcome
 *  (`by: 'outcome'`) or the task by its world's ref (`by: 'ref'`),
 *  passing again the live inputs `live` names. */
export interface TaskResume {
  readonly kind: 'resume'
  readonly answer: string
  readonly steps: readonly ShapeStep[]
  readonly by: 'outcome' | 'ref'
  readonly live: readonly string[]
  readonly keep: boolean
}

/** A restart, as far as the task can tell: the store opened again, the
 *  task defined again, the outcomes held so far gone (their refs still
 *  known). */
export interface Restart {
  readonly kind: 'restart'
}

export type Act = TaskCall | TaskResume | Restart

/** A call agent code made on a live input. */
export interface LiveCall {
  readonly input: string
  readonly method: string
  readonly args: readonly unknown[]
}

/** The `__task__` plane of the world an outcome keeps. */
export interface PlaneExp {
  readonly status: 'running' | 'success' | 'failed' | 'needs_input'
  readonly stored: readonly string[]
  readonly value: boolean
}

/** How one call or resume came out; null leaves a part unchecked. */
export interface OutcomeExp {
  readonly status: Status
  readonly value: unknown
  readonly message: string | null
  readonly names: readonly string[]
  readonly asked: number | null
  readonly kept: boolean | null
  readonly plane: PlaneExp | null
  readonly calls: readonly LiveCall[] | null
}

/** One scenario: a task, the acts that call it, one expectation per
 *  call or resume. */
export interface TaskScenario {
  readonly name: string
  readonly summary: string
  readonly task: TaskDef
  readonly where: Where
  readonly needs: readonly string[]
  readonly world: { readonly files: Readonly<Record<string, string>> }
  readonly acts: readonly Act[]
  readonly expect: readonly OutcomeExp[]
}

/** Agent code defines the task and calls it: once with `inputs`, or
 *  given `items`, once per item at once (`.map`). `helper` is the script
 *  every helper of this act follows. */
export interface CodeCall {
  readonly kind: 'code_call'
  readonly inputs: Readonly<Record<string, unknown>>
  readonly items: readonly Readonly<Record<string, unknown>>[] | null
  readonly helper: readonly ShapeStep[]
}

/** What the calling code got: a value, or for a `.map` values in order;
 *  the error a failed or asking helper raised; or a refused definition. */
export interface CodeExp {
  readonly status: 'value' | 'failed' | 'needs_input' | 'refused'
  readonly value: unknown
  readonly values: readonly unknown[] | null
  readonly message: string | null
  readonly names: readonly string[]
}

/** One scenario of a task agent code defines. */
export interface CodeScenario {
  readonly name: string
  readonly summary: string
  readonly task: TaskDef
  readonly where: Where
  readonly needs: readonly string[]
  readonly acts: readonly CodeCall[]
  readonly expect: readonly CodeExp[]
}

/** Whether a scenario runs on agex-ts: off the process (its code runs
 *  in a worker), needing no capability it lacks. */
export function appliesToTs(
  scenario: Pick<TaskScenario, 'where' | 'needs'>,
  capabilities: ReadonlySet<string> = new Set(),
): boolean {
  return scenario.where !== 'in-process' && scenario.needs.every((n) => capabilities.has(n))
}
