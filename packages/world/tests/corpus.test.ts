/**
 * nontainer's harness corpus, run against the reference harness on the
 * world: every scenario, tiers 0 to 5, passes.
 */

import { describe, expect, it } from 'vitest'
import {
  type Clock,
  EXHAUSTED,
  type ModelStep,
  type OpenOptions,
  SCENARIOS,
  type Scenario,
  applies,
  check,
  runScenario,
} from '../src/conformance/index'
import { Inbox, Store, type TurnEvent, type Workspace, summaryMessage } from '../src/index'
import { newKV } from './backends'
import { type Message, ReferenceSession, referenceHarness } from './reference-harness'

const covered = SCENARIOS.filter((s) => applies(s, referenceHarness))

/** Each scenario's store, on this run's backend. */
const onBackend = { store: async () => Store.open(await newKV()) }

function byName(name: string): Scenario {
  const scenario = SCENARIOS.find((s) => s.name === name)
  if (scenario === undefined) throw new Error(`no scenario ${name}`)
  return scenario
}

describe("nontainer's harness corpus on the world", () => {
  it('holds the scenarios, tiers 0 to 5, and covers every one', () => {
    expect(SCENARIOS).toHaveLength(22)
    expect(new Set(SCENARIOS.flatMap((s) => s.tiers))).toEqual(new Set([0, 1, 2, 3, 4, 5]))
    expect(covered).toEqual(SCENARIOS)
  })

  for (const scenario of covered) {
    it(scenario.name, async () => {
      const failures = check(scenario, await runScenario(scenario, referenceHarness, onBackend))
      expect(Object.fromEntries(failures)).toEqual({})
    })
  }
})

describe('the checks', () => {
  it('catch a harness that drops aborted runs and stamps no status', async () => {
    const forgetful = {
      ...referenceHarness,
      async open(...args: Parameters<typeof referenceHarness.open>) {
        const session = await referenceHarness.open(...args)
        return {
          inbox: session.inbox,
          turn: (p: string) => session.turn(p),
          resume: () => session.resume(),
          cancel: () => session.cancel(),
          close: () => session.close(),
          runs: async () => [],
          runStatuses: () => [],
        }
      },
    }
    const scenario = SCENARIOS.find((s) => s.name === 'a-cancel-after-a-tool-keeps-the-run')
    if (scenario === undefined) throw new Error('missing scenario')
    const failures = check(scenario, await runScenario(scenario, forgetful, onBackend))
    expect([...failures.keys()].sort()).toEqual(['commits', 'runs'])
  })

  it("catch a harness whose turns don't deliver the inbox", async () => {
    const deaf = {
      ...referenceHarness,
      async open(...args: Parameters<typeof referenceHarness.open>) {
        const session = await referenceHarness.open(...args)
        return {
          inbox: new Inbox(),
          turn: (p: string) => session.turn(p),
          resume: () => session.resume(),
          cancel: () => session.cancel(),
          close: () => session.close(),
          runs: () => session.runs(),
          runStatuses: (info: Parameters<typeof session.runStatuses>[0]) =>
            session.runStatuses(info),
        }
      },
    }
    const scenario = SCENARIOS.find((s) => s.name === 'a-note-rides-the-next-tool-result-once')
    if (scenario === undefined) throw new Error('missing scenario')
    const failures = check(scenario, await runScenario(scenario, deaf, onBackend))
    expect([...failures.keys()].sort()).toEqual(['inbox', 'turn1.events'])
  })

  it('catch a harness that stops after its tools, without the last reply', async () => {
    const hasty = {
      ...referenceHarness,
      open(ws: Workspace, clock: Clock) {
        let stop = false
        const early = {
          async next(sent?: readonly string[]): Promise<ModelStep> {
            if (stop) return { ...EXHAUSTED, text: '' }
            const step = await clock.next(sent)
            stop = step.tool_calls.length > 0
            return step
          },
        }
        return referenceHarness.open(ws, early as Clock)
      },
    }
    const scenario = SCENARIOS.find((s) => s.name === 'a-full-fork-carries-the-conversation')
    if (scenario === undefined) throw new Error('missing scenario')
    const failures = check(scenario, await runScenario(scenario, hasty, onBackend))
    expect([...failures.keys()]).toEqual(['turn1.script'])
  })

  it('catch a harness that stores a fold’s summary', async () => {
    class Storing extends ReferenceSession {
      protected override async request(current: Message[], events: TurnEvent[]) {
        const request = await super.request(current, events)
        current.push(...request.filter((m) => m.summary === true && !current.includes(m)))
        return request
      }
    }
    const storing = {
      ...referenceHarness,
      async open(ws: Workspace, clock: Clock, opts?: OpenOptions) {
        return new Storing(ws, clock, opts)
      },
    }
    const scenario = byName('a-request-over-budget-folds-the-earlier-turns')
    expect(check(scenario, await runScenario(scenario, storing, onBackend)).has('summary')).toBe(
      true,
    )
  })

  it("can't check a fold when the harness passes nothing it sent", async () => {
    const silent = {
      ...referenceHarness,
      open(ws: Workspace, clock: Clock, opts?: OpenOptions) {
        const quiet = { next: () => clock.next() }
        return referenceHarness.open(ws, quiet as Clock, opts)
      },
    }
    const scenario = byName('a-request-over-budget-folds-the-earlier-turns')
    const failures = check(scenario, await runScenario(scenario, silent, onBackend))
    expect([...failures.keys()].sort()).toEqual(['turn1.folded', 'turn2.folded'])
    expect(failures.get('turn2.folded')).toMatch(/didn't pass/)
  })

  it('catch a harness that sends a stale summary', async () => {
    class Stale extends ReferenceSession {
      readonly #ws: Workspace
      constructor(ws: Workspace, clock: Clock, opts?: OpenOptions) {
        super(ws, clock, opts)
        this.#ws = ws
      }
      protected override async spliced(earlier: Message[]) {
        const recorded = await this.#ws.compaction.folds()
        const first = recorded[0]
        if (recorded.length < 2 || first === undefined) return super.spliced(earlier)
        const end = earlier.findIndex((m) => m.id === first.through)
        const stale: Message = { role: 'user', text: summaryMessage(first.summary), summary: true }
        return [stale, ...earlier.slice(end + 1)]
      }
    }
    const stale = {
      ...referenceHarness,
      async open(ws: Workspace, clock: Clock, opts?: OpenOptions) {
        return new Stale(ws, clock, opts)
      },
    }
    const scenario = byName('a-second-fold-takes-in-the-first')
    const failures = check(scenario, await runScenario(scenario, stale, onBackend))
    expect([...failures.keys()]).toEqual(['turn3.folded'])
    expect(failures.get('turn3.folded')).toMatch(/fold in force/)
  })
})
