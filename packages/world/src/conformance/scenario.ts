/**
 * The harness corpus's format: nontainer's scenarios, exported as JSON
 * (`nontainer/conformance/harness/json/`), field for field. See
 * `scenario.schema.json` beside this file.
 */

import type { RunStatus } from '../turns'

export interface ToolCall {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

/** One model reply: text, reasoning, tool calls; or a failure
 *  (`provider`: one a harness may resume from; `error`: any other). */
export interface ModelStep {
  readonly kind: 'model'
  readonly text: string
  readonly thinking: string
  readonly tool_calls: readonly ToolCall[]
  readonly fail: '' | 'provider' | 'error'
  /** Tokens the request reported; 0 for none. */
  readonly input_tokens: number
}

/** Something that happens between model calls. */
export interface EventStep {
  readonly kind: 'event'
  readonly what: 'cancel' | 'queue_note' | 'delegate_answers'
  readonly text: string
}

export type Step = ModelStep | EventStep

export interface TurnAct {
  readonly kind: 'turn'
  readonly prompt: string
  readonly resume: boolean
  readonly steps: readonly Step[]
}

export interface CheckoutAct {
  readonly kind: 'checkout'
  /** The turn to check out the end of, counting from 1. */
  readonly after_turn: number
}

export interface ForkAct {
  readonly kind: 'fork'
  readonly name: string
  readonly inherit: 'full' | 'fresh'
}

export type Act = TurnAct | CheckoutAct | ForkAct

export interface TurnExp {
  readonly status: RunStatus
  readonly events: readonly string[] | null
  readonly folded: boolean | null
}

export interface RunExp {
  readonly closing_note: boolean
  readonly tool_results: number | null
}

export interface CommitExp {
  readonly tool: string
  readonly runs: readonly RunStatus[]
}

export interface Expect {
  readonly turns: readonly TurnExp[]
  readonly files: Readonly<Record<string, string>>
  readonly absent: readonly string[]
  readonly runs: readonly RunExp[] | null
  readonly commits: readonly CommitExp[] | null
  readonly inbox: { readonly pending: number; readonly delivered: number } | null
  readonly folds: readonly unknown[] | null
  readonly delegates: Readonly<Record<string, unknown>> | null
}

export interface Scenario {
  readonly name: string
  readonly summary: string
  readonly tiers: readonly number[]
  /** Capabilities a harness needs for the scenario to apply. */
  readonly needs: readonly string[]
  readonly world: { readonly files: Readonly<Record<string, string>> }
  readonly budget: number | null
  readonly delegates: Readonly<Record<string, unknown>>
  readonly acts: readonly Act[]
  readonly expect: Expect
}

/** What a harness can declare, after nontainer's `CAPABILITIES`. */
export const CAPABILITIES: Readonly<Record<string, string>> = {
  resume: 'continues an interrupted run in place, keeping what it holds',
  'keeps-aborted-runs':
    'stores a cancelled or failed run with the messages it had, so it can be kept with a closing note',
  compaction:
    'past a token budget, folds earlier turns into a summary in what the model is sent, recording each fold in __compaction__/',
  delegation:
    "exposes the sessions tool over a helper the runner builds, delivers a delegate's answer on the next tool result, and runs a woken turn that opens with what is waiting",
}
