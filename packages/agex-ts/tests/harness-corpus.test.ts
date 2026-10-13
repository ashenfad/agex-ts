/**
 * nontainer's harness corpus, run against agex-ts's session loop: every
 * scenario its capabilities cover passes. Compaction (tier 4) and
 * delegation (tier 5) come with folding and the sessions tool.
 */

import { SCENARIOS, applies, check, runScenario } from '@agex-ts/world/conformance'
import { describe, expect, it } from 'vitest'
import { agexHarness } from '../src/conformance/index'

const covered = SCENARIOS.filter((s) => applies(s, agexHarness))

describe("nontainer's harness corpus on agex-ts", () => {
  it('covers tiers 0 to 3', () => {
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
    ])
  })

  for (const scenario of covered) {
    it(scenario.name, async () => {
      const failures = check(scenario, await runScenario(scenario, agexHarness))
      expect(Object.fromEntries(failures)).toEqual({})
    })
  }
})
