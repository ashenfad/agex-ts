/**
 * nontainer's harness corpus, run against the reference harness on the
 * world: every scenario its capabilities cover passes, and the rest
 * (an inbox, compaction, delegation: later steps) are listed.
 */

import { describe, expect, it } from 'vitest'
import { SCENARIOS, applies, check, runScenario } from '../src/conformance/index'
import { referenceHarness } from './reference-harness'

const covered = SCENARIOS.filter(
  (s) => applies(s, referenceHarness) && s.tiers.every((t) => t <= 2),
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
})
