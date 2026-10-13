/**
 * Running nontainer's harness corpus against a harness, as nontainer's
 * `conformance/runner.py` does: a world per scenario, a scripted model
 * (the {@link Clock}), the acts in order, and the observations checked
 * against what the scenario expects.
 *
 * A harness drives its runs through the world's turn API and tools; the
 * runner sees only the events it streams, the runs it reports, and the
 * world's files and commits.
 */

import type { CommitInfo } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import type { Fold } from '../compaction'
import type { Inbox } from '../inbox'
import type { Sessions } from '../sessions'
import { Store } from '../store'
import type { TurnEvent } from '../turns'
import type { Workspace } from '../workspace'
import type { EventStep, ModelStep, Scenario, Step, TurnAct } from './scenario'

/** A stored run as the corpus checks it, in the harness's judgment. */
export interface RunView {
  /** The run ends with the note the harness keeps an aborted run with. */
  readonly closingNote: boolean
  /** Tool results stored in the run. */
  readonly toolResults: number
}

export interface HarnessSession {
  /** The session's inbox: a scenario queues notes in it, and its
   *  pending and delivered notes are checked at the end. */
  readonly inbox: Inbox
  /** Run a turn on `prompt`; its events, `RunStarted` first and
   *  `RunEnded` last. */
  turn(prompt: string): Promise<TurnEvent[]>
  /** Continue the last turn's interrupted run in place. */
  resume(): Promise<TurnEvent[]>
  /** Run a WOKEN turn: one with no prompt, which opens with what is
   *  waiting to be delivered (`turn.opening()`). Needed with
   *  `delegation`. */
  wake?(): Promise<TurnEvent[]>
  /** Stop the run in progress. Called from inside a model call. */
  cancel(): void
  /** The stored conversation's runs, oldest first, read from the
   *  workspace (so checkouts and forks show). */
  runs(): Promise<RunView[]>
  /** The run statuses a commit's info records. */
  runStatuses(info: CommitInfo | null): string[]
  close(): Promise<void>
}

/** What a session is opened with beside its workspace and clock. */
export interface OpenOptions {
  /** With `compaction`, for a scenario that sets one: the token budget
   *  past which the session folds earlier turns. */
  readonly budget?: number
  /** With `delegation`, for a scenario with delegates: the helper the
   *  session's `sessions` tool asks through, and whose answers its
   *  turns deliver. */
  readonly sessions?: Sessions
}

export interface Harness {
  readonly name: string
  /** What it can do (see `CAPABILITIES`): a scenario applies when it
   *  needs nothing else. */
  readonly capabilities: ReadonlySet<string>
  /** Checks a scenario is known to fail, with why: exactly these must
   *  fail, so a gap that closes is noticed. */
  readonly knownGaps?: Readonly<Record<string, Readonly<Record<string, string>>>>
  open(ws: Workspace, clock: Clock, opts?: OpenOptions): Promise<HarnessSession>
  /** With `delegation`: what runs a scenario's delegates. The runner
   *  can't build a helper itself; `CorpusDelegates` is the one a
   *  harness hands over. */
  delegation?(store: Store, scenario: Scenario): Delegation
}

/** One delegate as the scenario saw it: the answer its asker got
 *  (`status` empty when none came), the woken turns it took, the
 *  delegates of its own it answered without hearing from, whether its
 *  runner returned with writes uncommitted, and the steps of its
 *  script it left unused. */
export interface DelegateView {
  readonly status: string
  readonly text: string
  readonly wakes: number
  readonly unread: readonly string[]
  readonly uncommitted: boolean
  readonly unused: number
}

/** What runs a scenario's delegates: it builds the helper each session
 *  asks through, fires the events a script holds, and at the end says
 *  how each delegate came back. */
export interface Delegation {
  /** A delegate's model was asked for more than its script holds. */
  readonly exhausted: boolean
  helper(ws: Workspace): Sessions
  fire(step: EventStep, session: HarnessSession, helper: Sessions): Promise<void>
  /** Release every delegate still held, close every helper, and say
   *  how each delegate came back, by the name it was asked under. */
  finish(): Promise<Record<string, DelegateView>>
}

/** What the scripted model says when the script has run out. */
export const EXHAUSTED: ModelStep = {
  kind: 'model',
  text: '(the script ran out)',
  thinking: '',
  tool_calls: [],
  fail: '',
  input_tokens: 0,
}

/**
 * The scripted model: a harness calls {@link next} once per model call.
 * Events queued before the next model step fire inside that call
 * (`cancel` reaches the session then, so a harness checks for it after
 * `next` returns, and throws that step away).
 */
export class Clock {
  /** The texts of the last request, when the harness passed them. */
  sent: readonly string[] | null = null
  /** More model calls were made than the script holds. */
  exhausted = false
  #steps: Step[] = []
  #fire: (event: EventStep) => unknown = () => {}

  /** @internal The runner's. */
  load(steps: readonly Step[]): void {
    this.#steps = [...steps]
    this.sent = null
  }

  /** Steps the harness hasn't reached: a turn that ends with some left
   *  stopped early. */
  get left(): number {
    return this.#steps.length
  }

  /** The runner's, or a delegation's: what fires an event. A delegate
   *  answering is waited for, so the next reply comes after it. */
  onEvent(fire: (event: EventStep) => unknown): void {
    this.#fire = fire
  }

  async next(sent?: readonly string[]): Promise<ModelStep> {
    if (sent !== undefined) this.sent = [...sent]
    while (this.#steps[0]?.kind === 'event') await this.#fire(this.#steps.shift() as EventStep)
    const step = this.#steps.shift()
    if (step === undefined) {
      this.exhausted = true
      return EXHAUSTED
    }
    return step as ModelStep
  }
}

/** What a run of a scenario saw. */
export interface Observation {
  readonly turns: readonly (readonly TurnEvent[])[]
  /** Script steps each turn left unused. */
  readonly unused: readonly number[]
  readonly files: Readonly<Record<string, string | null>>
  readonly runs: readonly RunView[]
  readonly commits: readonly { readonly tool: string; readonly runs: readonly string[] }[]
  readonly inbox: { readonly pending: number; readonly delivered: number }
  readonly exhausted: boolean
  /** Every delegate asked, at any depth, by the name it was asked
   *  under. */
  readonly delegates: Readonly<Record<string, DelegateView>>
  /** Per turn, what its last model request carried, as the harness
   *  passed it to the clock (null: it passed nothing). */
  readonly sent: readonly (readonly string[] | null)[]
  /** The folds the final workspace records, oldest first. */
  readonly folds: readonly Fold[]
  /** A fold's summary found in the stored conversation, which must
   *  never hold one; null when none was. */
  readonly storedSummary: string | null
  /** Every fold summary recorded along the way, a rewind's included. */
  readonly summaries: readonly string[]
  /** Per turn, the summary of the fold in force as it ended (the
   *  latest recorded then), or null. */
  readonly inForce: readonly (string | null)[]
}

/** Whether a scenario applies to a harness: it needs nothing more than
 *  the harness can do. */
export function applies(scenario: Scenario, harness: Harness): boolean {
  return scenario.needs.every((need) => harness.capabilities.has(need))
}

/** Run a scenario against a harness, on a memory store unless one is
 *  given. */
export async function runScenario(
  scenario: Scenario,
  harness: Harness,
  opts: { store?: () => Promise<Store> } = {},
): Promise<Observation> {
  const store = await (opts.store ?? (() => Store.open(new Memory())))()
  let delegates: Delegation | null = null
  if (scenario.needs.includes('delegation')) {
    if (harness.delegation === undefined) {
      throw new Error(`${harness.name}: a scenario with delegates needs harness.delegation`)
    }
    delegates = harness.delegation(store, scenario)
  }
  let ws = await store.open('scenario')
  for (const [path, text] of Object.entries(scenario.world.files)) await ws.files.write(path, text)
  if (ws.uncommitted) await ws.commit({ tool: 'world' })
  const start = ws.head

  const clock = new Clock()
  let helper: Sessions | null = null
  const openSession = (on: Workspace) => {
    helper = delegates?.helper(on) ?? null
    return harness.open(on, clock, {
      ...(helper !== null && { sessions: helper }),
      ...(scenario.budget !== null && { budget: scenario.budget }),
    })
  }
  let session = await openSession(ws)
  clock.onEvent((event) => {
    if (delegates !== null) return delegates.fire(event, session, helper as Sessions)
    if (event.what === 'cancel') session.cancel()
    else if (event.what === 'queue_note') session.inbox.put(event.text)
    else throw new Error(`a ${event.what} event needs delegation`)
    return undefined
  })

  const turns: TurnEvent[][] = []
  const unused: number[] = []
  const endedAt: string[] = []
  const sent: (readonly string[] | null)[] = []
  const summaries: string[] = []
  const inForce: (string | null)[] = []
  let storedSummary: string | null = null
  try {
    for (const act of scenario.acts) {
      if (act.kind === 'turn') {
        clock.load(act.steps)
        turns.push(act.resume ? await session.resume() : await session.turn(act.prompt))
        unused.push(clock.left)
        endedAt.push(ws.head)
        sent.push(clock.sent)
        storedSummary ??= await summaryStored(ws)
        const recorded = await ws.compaction.folds()
        for (const fold of recorded)
          if (!summaries.includes(fold.summary)) summaries.push(fold.summary)
        inForce.push(recorded.at(-1)?.summary ?? null)
      } else if (act.kind === 'checkout') {
        await ws.checkout(endedAt[act.after_turn - 1] as string)
      } else {
        const child = await ws.fork(act.name, { inherit: act.inherit })
        await session.close()
        await ws.close()
        ws = child
        session = await openSession(ws)
      }
    }

    let delegated: Record<string, DelegateView> = {}
    let delegatesRanOut = false
    if (delegates !== null) {
      delegated = await delegates.finish()
      delegatesRanOut = delegates.exhausted
      delegates = null
    }
    const files: Record<string, string | null> = {}
    for (const path of [...Object.keys(scenario.expect.files), ...scenario.expect.absent]) {
      files[path] = (await ws.files.exists(path)) ? await ws.files.readText(path) : null
    }
    const commits: { tool: string; runs: string[] }[] = []
    for (const c of await ws.log()) {
      if (c.hash === start) break
      commits.push({ tool: String(c.info?.tool ?? ''), runs: session.runStatuses(c.info) })
    }
    return {
      turns,
      unused,
      files,
      runs: await session.runs(),
      commits: commits.reverse(),
      inbox: {
        pending: session.inbox.pending().length,
        delivered: session.inbox.delivered().length,
      },
      exhausted: clock.exhausted || delegatesRanOut,
      sent,
      folds: await ws.compaction.folds(),
      storedSummary,
      summaries,
      inForce,
      delegates: delegated,
    }
  } finally {
    try {
      // A scenario that failed midway: release the delegates and wait.
      if (delegates !== null) await delegates.finish()
    } finally {
      await session.close()
      await ws.close()
    }
  }
}

/** A summary of one of `ws`'s folds that its stored conversation holds,
 *  whatever format the harness stores runs in; null when it holds none,
 *  as it never should. */
async function summaryStored(ws: Workspace): Promise<string | null> {
  const summaries = (await ws.compaction.folds()).map((f) => f.summary).filter((s) => s !== '')
  if (summaries.length === 0) return null
  const stored = [
    await ws.conversation.index(),
    await ws.conversation.record(),
    ...(await ws.conversation.runs()).values(),
  ].map((v) => JSON.stringify(v ?? null))
  for (const summary of summaries) {
    const quoted = JSON.stringify(summary).slice(1, -1)
    if (stored.some((text) => text.includes(quoted))) return summary
  }
  return null
}

/** What's wrong with whether a turn's last request was folded: a folded
 *  one carries the summary of the fold in force and no other, in place
 *  of the first turn; one that isn't carries no summary. */
function foldProblem(
  want: boolean,
  sent: readonly string[] | null,
  summaries: readonly string[],
  current: string | null,
  first: string,
): string | null {
  if (sent === null) return "the harness didn't pass the clock what it sent"
  const text = sent.join('\n')
  const carried = summaries.filter((s) => s !== '' && text.includes(s))
  if (!want) return carried.length > 0 ? "its last request carried a fold's summary" : null
  if (current === null) return 'no fold is recorded to be in force'
  if (!carried.includes(current)) {
    return "its last request didn't carry the summary of the fold in force"
  }
  if (carried.length > 1) return "its last request carried another fold's summary too"
  if (first !== '' && text.includes(first)) {
    return `its last request still carried the first turn (${JSON.stringify(first)})`
  }
  return null
}

/** A run's events as the corpus names them: `Usage` dropped, runs of
 *  text or reasoning merged, `ToolEnded:error` for a failed tool,
 *  `RunEnded:<status>`. */
export function eventNames(events: readonly TurnEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.kind === 'Usage') continue
    const name =
      e.kind === 'ToolEnded' && e.isError
        ? 'ToolEnded:error'
        : e.kind === 'RunEnded'
          ? `RunEnded:${e.status}`
          : e.kind
    if ((name === 'TextDelta' || name === 'ThinkingDelta') && out.at(-1) === name) continue
    out.push(name)
  }
  return out
}

/** How an observation differs from what a scenario expects, by check
 *  (`turn1.status`, `files`, `commits`, …); empty when it doesn't. */
export function check(scenario: Scenario, seen: Observation): Map<string, string> {
  const failures = new Map<string, string>()
  const want = scenario.expect
  const show = (v: unknown) => JSON.stringify(v)

  const firstPrompt = scenario.acts.find((a): a is TurnAct => a.kind === 'turn')?.prompt ?? ''
  want.turns.forEach((turn, i) => {
    const events = seen.turns[i]
    const n = i + 1
    if (events === undefined) return
    if (turn.folded !== null) {
      const problem = foldProblem(
        turn.folded,
        seen.sent[i] ?? null,
        seen.summaries,
        seen.inForce[i] ?? null,
        firstPrompt,
      )
      if (problem !== null) failures.set(`turn${n}.folded`, problem)
    }
    const starts = events.filter((e) => e.kind === 'RunStarted').length
    const ends = events.filter((e) => e.kind === 'RunEnded').length
    if (
      starts !== 1 ||
      ends !== 1 ||
      events[0]?.kind !== 'RunStarted' ||
      events.at(-1)?.kind !== 'RunEnded'
    ) {
      failures.set(`turn${n}.stream`, 'one RunStarted first and one RunEnded last')
    }
    const last = [...events].reverse().find((e) => e.kind === 'RunEnded')
    const status = last?.kind === 'RunEnded' ? last.status : undefined
    if (status !== turn.status)
      failures.set(`turn${n}.status`, `want ${turn.status}, got ${status}`)
    const left = seen.unused[i] ?? 0
    if (left > 0)
      failures.set(`turn${n}.script`, `the turn ended with ${left} script step(s) unused`)
    if (turn.events !== null && show(eventNames(events)) !== show(turn.events)) {
      failures.set(`turn${n}.events`, `want ${show(turn.events)}, got ${show(eventNames(events))}`)
    }
  })
  if (seen.turns.length !== want.turns.length) {
    failures.set('turns', `want ${want.turns.length}, got ${seen.turns.length}`)
  }

  const fileProblems: string[] = []
  for (const [path, text] of Object.entries(want.files)) {
    if (seen.files[path] !== text)
      fileProblems.push(`${path}: want ${show(text)}, got ${show(seen.files[path])}`)
  }
  for (const path of want.absent) {
    if (!(path in want.files) && seen.files[path] !== null)
      fileProblems.push(`${path}: should be absent`)
  }
  if (fileProblems.length > 0) failures.set('files', fileProblems.join('; '))

  if (want.runs !== null) {
    const got = seen.runs
    const same =
      got.length === want.runs.length &&
      want.runs.every(
        (r, i) =>
          got[i]?.closingNote === r.closing_note &&
          (r.tool_results === null || got[i]?.toolResults === r.tool_results),
      )
    if (!same) failures.set('runs', `want ${show(want.runs)}, got ${show(got)}`)
  }
  if (want.commits !== null) {
    const wantCommits = want.commits.map((c) => [c.tool, [...c.runs]])
    const got = seen.commits.map((c) => [c.tool, [...c.runs]])
    if (show(got) !== show(wantCommits))
      failures.set('commits', `want ${show(wantCommits)}, got ${show(got)}`)
  }
  if (want.inbox !== null) {
    if (
      seen.inbox.pending !== want.inbox.pending ||
      seen.inbox.delivered !== want.inbox.delivered
    ) {
      failures.set('inbox', `want ${show(want.inbox)}, got ${show(seen.inbox)}`)
    }
  }
  if (want.delegates !== null) {
    for (const [name, expected] of Object.entries(want.delegates)) {
      const got = seen.delegates[name]
      if (got === undefined) {
        failures.set(`delegate.${name}`, 'it was never asked')
        continue
      }
      if (got.status !== expected.status) {
        failures.set(
          `delegate.${name}.status`,
          `${show(got.status || 'no answer')}, not ${show(expected.status)}`,
        )
      }
      const missing = expected.mentions.filter((w) => !got.text.includes(w))
      if (missing.length > 0) {
        failures.set(
          `delegate.${name}.mentions`,
          `its answer doesn't say ${show(missing)}: ${show(got.text.slice(0, 120))}`,
        )
      }
      if (expected.wakes !== null && got.wakes !== expected.wakes) {
        failures.set(`delegate.${name}.wakes`, `${got.wakes} woken turn(s), not ${expected.wakes}`)
      }
      if (show([...got.unread].sort()) !== show([...expected.unread].sort())) {
        failures.set(
          `delegate.${name}.unread`,
          `answered without ${show(got.unread)}, not ${show(expected.unread)}`,
        )
      }
    }
  }
  for (const [name, got] of Object.entries(seen.delegates)) {
    if (got.uncommitted) {
      failures.set(`delegate.${name}.uncommitted`, 'its runner returned with writes uncommitted')
    }
    if (got.unused > 0) {
      failures.set(
        `delegate.${name}.script`,
        `it answered with ${got.unused} step(s) of its script unused`,
      )
    }
  }
  if (want.folds !== null) {
    const got = seen.folds.map((f) => [f.runs, f.first !== null])
    const expected = want.folds.map((f) => [f.runs, f.ranged])
    if (show(got) !== show(expected)) {
      failures.set('folds', `(runs, ranged) ${show(got)} != ${show(expected)}`)
    }
  }
  if (seen.storedSummary !== null) {
    failures.set(
      'summary',
      `the stored conversation holds a fold's summary: ${show(seen.storedSummary.slice(0, 80))}`,
    )
  }
  if (seen.exhausted)
    failures.set('script', 'the harness asked the model more than the script holds')
  return failures
}
