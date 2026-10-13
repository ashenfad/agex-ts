/**
 * nontainer's harness corpus, run against the reference harness on the
 * world: every scenario its capabilities cover passes, delegation's
 * included. Compaction (tier 4) comes with its record.
 */

import { describe, expect, it } from 'vitest'
import {
  type Clock,
  EXHAUSTED,
  type ModelStep,
  SCENARIOS,
  applies,
  check,
  runScenario,
} from '../src/conformance/index'
import { Inbox, type Workspace } from '../src/index'
import { referenceHarness } from './reference-harness'

const covered = SCENARIOS.filter(
  (s) => applies(s, referenceHarness) && s.tiers.every((t) => t !== 4),
)

describe("nontainer's harness corpus on the world", () => {
  it('holds the scenarios, tiers 0 to 5', () => {
    expect(SCENARIOS).toHaveLength(21)
    expect(covered.map((s) => s.name)).toEqual([
      'a-turn-that-writes-a-file',
      'a-cancel-after-a-tool-keeps-the-run',
      'a-failure-keeps-the-run-with-a-closing-note',
      'a-provider-error-interrupts-and-resume-continues',
      'a-reply-alone-completes',
      'a-checkout-rewinds-the-conversation-with-the-files',
      'a-fresh-fork-starts-without-the-conversation',
      'a-full-fork-carries-the-conversation',
      'a-cancel-settles-what-was-delivered',
      'a-note-after-the-last-tool-waits-for-the-next-turn',
      'a-note-rides-the-next-tool-result-once',
      'a-delegate-hears-from-its-own-delegate-before-answering',
      'a-delegate-out-of-wakes-names-who-it-did-not-hear-from',
      'a-delegates-answer-is-delivered-once-on-the-next-tool-result',
      'a-note-left-for-a-delegate-is-read-before-it-answers',
    ])
  })

  for (const scenario of covered) {
    it(scenario.name, async () => {
      const failures = check(scenario, await runScenario(scenario, referenceHarness))
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
    const failures = check(scenario, await runScenario(scenario, forgetful))
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
    const failures = check(scenario, await runScenario(scenario, deaf))
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
    const failures = check(scenario, await runScenario(scenario, hasty))
    expect([...failures.keys()]).toEqual(['turn1.script'])
  })
})
