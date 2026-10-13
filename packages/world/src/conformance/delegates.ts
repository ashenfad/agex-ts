/**
 * What runs a corpus scenario's delegates, after nontainer's
 * `adapters/corpus_delegates.py`. A harness with `delegation` hands the
 * runner one of these (`harness.delegation(store, scenario)`):
 *
 *     delegation(store, scenario) {
 *       return new CorpusDelegates(this, store, scenario)
 *     }
 *
 * Each delegate runs as a session of that same harness, opened on the
 * delegate's branch with its script as its clock, and driven through
 * {@link untilSettled}. A delegate is held until a `delegate_answers`
 * event releases it, so where its answer lands is fixed by the script;
 * at the end every one still held is released.
 */

import { SEPARATOR, type SessionRunner, Sessions, untilSettled } from '../sessions'
import type { Store } from '../store'
import type { TurnEvent } from '../turns'
import type { Workspace } from '../workspace'
import {
  Clock,
  type DelegateView,
  type Delegation,
  type Harness,
  type HarnessSession,
} from './runner'
import type { EventStep, Scenario } from './scenario'

/** How long a scenario waits for a delegate, in milliseconds, before
 *  calling it stuck. */
export const PATIENCE = 30_000

/** The name a delegate was asked under: its session's last part. */
function short(session: string): string {
  return session.slice(session.lastIndexOf(SEPARATOR) + 1)
}

function reply(events: readonly TurnEvent[]): string {
  return events.map((e) => (e.kind === 'TextDelta' ? e.text : '')).join('')
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A gate a delegate waits at until it's opened, or `PATIENCE` passes. */
class Gate {
  #open = false
  readonly #waiters: (() => void)[] = []

  open(): void {
    this.#open = true
    for (const wake of this.#waiters.splice(0)) wake()
  }

  wait(ms: number): Promise<void> {
    if (this.#open) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.#waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

export class CorpusDelegates implements Delegation, SessionRunner {
  readonly helpers: Sessions[] = []
  readonly views: Record<string, DelegateView> = {}
  exhausted = false
  readonly #harness: Harness
  readonly #store: Store
  readonly #scenario: Scenario
  readonly #gates = new Map<string, Gate>()
  #finishing = false

  constructor(harness: Harness, store: Store, scenario: Scenario) {
    this.#harness = harness
    this.#store = store
    this.#scenario = scenario
  }

  /** A helper over `ws` whose delegates run here. */
  helper(ws: Workspace): Sessions {
    const helper = new Sessions(ws, this)
    this.helpers.push(helper)
    return helper
  }

  /** The gate a delegate waits at. Once finishing has begun a new one
   *  starts open: a run that begins as the scenario ends mustn't wait
   *  for a release nothing will send. */
  #gate(name: string): Gate {
    const gate = this.#gates.get(name) ?? new Gate()
    this.#gates.set(name, gate)
    if (this.#finishing) gate.open()
    return gate
  }

  async run(session: string, task: string): Promise<string> {
    const name = short(session)
    await this.#gate(name).wait(PATIENCE)
    const script = this.#scenario.delegates[name] ?? { steps: [], wakes: 3 }
    const child = await this.#store.open(session)
    const helper = this.helper(child)
    const clock = new Clock()
    let opened: HarnessSession | null = null
    clock.onEvent((step) => this.fire(step, opened as HarnessSession, helper))
    clock.load(script.steps)
    opened = await this.#harness.open(child, clock, { sessions: helper })
    const live = opened
    let settled: Awaited<ReturnType<typeof untilSettled>>
    let uncommitted: boolean
    try {
      settled = await untilSettled(
        async (prompt) => reply(prompt !== null ? await live.turn(prompt) : await wake(live)),
        helper,
        live.inbox,
        { prompt: task, maxWakes: script.wakes, poll: 50 },
      )
      uncommitted = child.uncommitted
    } finally {
      await live.close()
      await child.close()
    }
    this.exhausted ||= clock.exhausted
    this.views[name] = {
      status: '',
      text: '',
      wakes: settled.wakes,
      unread: settled.unread.map(short),
      uncommitted,
      unused: clock.left,
    }
    return settled.text
  }

  /** An outside event, for a session whose helper is `helper`. */
  async fire(step: EventStep, session: HarnessSession, helper: Sessions): Promise<void> {
    if (step.what === 'cancel') session.cancel()
    else if (step.what === 'queue_note') session.inbox.put(step.text)
    else if (step.what === 'delegate_answers') await this.answer(helper, step.text)
    else throw new Error(`unknown event ${String(step.what)}`)
  }

  /** Release the delegate `name` and wait for its answer to land in
   *  `helper`. */
  async answer(helper: Sessions, name: string): Promise<void> {
    this.#gate(name).open()
    const deadline = Date.now() + PATIENCE
    while (Date.now() < deadline) {
      const jobs = helper.list().filter((j) => short(j.name) === name)
      if (jobs.length > 0 && jobs.every((j) => j.status !== 'running')) return
      // Another job's answer waiting ends a wait at once: give the runs
      // a moment rather than spin.
      if ((await helper.wait(50)).length > 0) await sleep(10)
    }
    throw new Error(`delegate ${JSON.stringify(name)} did not answer in ${PATIENCE}ms`)
  }

  async finish(): Promise<Record<string, DelegateView>> {
    this.#finishing = true
    for (const gate of this.#gates.values()) gate.open()
    const answers: Record<string, [string, string]> = {}
    for (const helper of [...this.helpers]) {
      await helper.close()
      for (const job of helper.list()) {
        const answered = !['running', 'cancelled', 'expired'].includes(job.status)
        answers[short(job.name)] = [job.status, answered ? helper.result(job.name).text : '']
      }
    }
    const views: Record<string, DelegateView> = { ...this.views }
    for (const [name, [status, text]] of Object.entries(answers)) {
      const seen = views[name]
      views[name] = {
        status,
        text,
        wakes: seen?.wakes ?? 0,
        unread: seen?.unread ?? [],
        uncommitted: seen?.uncommitted ?? false,
        unused: seen?.unused ?? 0,
      }
    }
    return views
  }
}

function wake(session: HarnessSession): Promise<TurnEvent[]> {
  if (session.wake === undefined) throw new Error('a delegate needs a harness session with wake()')
  return session.wake()
}
