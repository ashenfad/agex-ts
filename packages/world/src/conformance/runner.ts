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
import { Store } from '../store'
import type { TurnEvent } from '../turns'
import type { Workspace } from '../workspace'
import type { EventStep, ModelStep, Scenario, Step } from './scenario'

/** A stored run as the corpus checks it, in the harness's judgment. */
export interface RunView {
  /** The run ends with the note the harness keeps an aborted run with. */
  readonly closingNote: boolean
  /** Tool results stored in the run. */
  readonly toolResults: number
}

export interface HarnessSession {
  /** Run a turn on `prompt`; its events, `RunStarted` first and
   *  `RunEnded` last. */
  turn(prompt: string): Promise<TurnEvent[]>
  /** Continue the last turn's interrupted run in place. */
  resume(): Promise<TurnEvent[]>
  /** Stop the run in progress. Called from inside a model call. */
  cancel(): void
  /** The stored conversation's runs, oldest first, read from the
   *  workspace (so checkouts and forks show). */
  runs(): Promise<RunView[]>
  /** The run statuses a commit's info records. */
  runStatuses(info: CommitInfo | null): string[]
  /** Pending and delivered inbox notes, for a harness with an inbox. */
  inbox?(): { pending: number; delivered: number }
  close(): Promise<void>
}

export interface Harness {
  readonly name: string
  /** What it can do (see `CAPABILITIES`): a scenario applies when it
   *  needs nothing else. */
  readonly capabilities: ReadonlySet<string>
  /** Checks a scenario is known to fail, with why: exactly these must
   *  fail, so a gap that closes is noticed. */
  readonly knownGaps?: Readonly<Record<string, Readonly<Record<string, string>>>>
  open(ws: Workspace, clock: Clock): Promise<HarnessSession>
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
  #fire: (event: EventStep) => void = () => {}

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

  /** @internal The runner's. */
  onEvent(fire: (event: EventStep) => void): void {
    this.#fire = fire
  }

  next(sent?: readonly string[]): ModelStep {
    if (sent !== undefined) this.sent = [...sent]
    while (this.#steps[0]?.kind === 'event') this.#fire(this.#steps.shift() as EventStep)
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
  let ws = await store.open('scenario')
  for (const [path, text] of Object.entries(scenario.world.files)) await ws.files.write(path, text)
  if (ws.uncommitted) await ws.commit({ tool: 'world' })
  const start = ws.head

  const clock = new Clock()
  let session = await harness.open(ws, clock)
  clock.onEvent((event) => {
    if (event.what === 'cancel') session.cancel()
    else throw new Error(`the runner can't deliver a ${event.what} event yet`)
  })

  const turns: TurnEvent[][] = []
  const unused: number[] = []
  const endedAt: string[] = []
  try {
    for (const act of scenario.acts) {
      if (act.kind === 'turn') {
        clock.load(act.steps)
        turns.push(act.resume ? await session.resume() : await session.turn(act.prompt))
        unused.push(clock.left)
        endedAt.push(ws.head)
      } else if (act.kind === 'checkout') {
        await ws.checkout(endedAt[act.after_turn - 1] as string)
      } else {
        const child = await ws.fork(act.name, { inherit: act.inherit })
        await session.close()
        await ws.close()
        ws = child
        session = await harness.open(ws, clock)
      }
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
      inbox: session.inbox?.() ?? { pending: 0, delivered: 0 },
      exhausted: clock.exhausted,
    }
  } finally {
    await session.close()
    await ws.close()
  }
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

  want.turns.forEach((turn, i) => {
    const events = seen.turns[i]
    const n = i + 1
    if (events === undefined) return
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
  if (seen.exhausted)
    failures.set('script', 'the harness asked the model more than the script holds')
  return failures
}
