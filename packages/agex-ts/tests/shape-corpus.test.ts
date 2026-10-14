/** agex's shape corpus, vendored: what applies to agex-ts, its task
 *  scenarios and its code scenarios (tasks agent code defines). */

import { describe, expect, it } from 'vitest'
import {
  AGEX_COMMIT,
  AgexTasks,
  CODE_SCENARIOS,
  TASK_SCENARIOS,
  appliesToTs,
  checkCodeScenario,
  checkTaskScenario,
  runCodeScenario,
  runTaskScenario,
} from '../src/conformance/index'

const WORKER = new URL('../../world/dist/worker.node.js', import.meta.url)
const profile = { code: { worker: { target: 'node' as const, url: WORKER } } }
const harness = new AgexTasks({ profile })

describe("agex's shape corpus", () => {
  it('holds the task and code scenarios, by name', () => {
    expect(AGEX_COMMIT).toMatch(/^[0-9a-f]{7,}$/)
    expect(TASK_SCENARIOS).toHaveLength(18)
    expect(CODE_SCENARIOS).toHaveLength(10)
    for (const s of [...TASK_SCENARIOS, ...CODE_SCENARIOS]) {
      expect(s.acts.filter((a) => a.kind !== 'restart')).toHaveLength(s.expect.length)
    }
  })

  it('leaves out what only the process can carry, and tables and arrays', () => {
    const skipped = [...TASK_SCENARIOS, ...CODE_SCENARIOS]
      .filter((s) => !appliesToTs(s))
      .map((s) => `${s.name} (${s.where === 'in-process' ? 'in-process' : s.needs.join(', ')})`)
    expect(skipped.sort()).toEqual([
      'a-table-comes-back-the-same (tables)',
      'an-array-comes-back-the-same (arrays)',
      'code-gets-tables-arrays-and-bytes-back (tables, arrays)',
    ])
  })
})

describe("agex's task scenarios on agex-ts", () => {
  for (const scenario of TASK_SCENARIOS.filter((s) => appliesToTs(s))) {
    it(scenario.name, async () => {
      const failures = checkTaskScenario(scenario, await runTaskScenario(scenario, harness))
      expect(Object.fromEntries(failures)).toEqual({})
    })
  }
})

describe("agex's code scenarios on agex-ts", () => {
  for (const scenario of CODE_SCENARIOS.filter((s) => appliesToTs(s))) {
    it(scenario.name, async () => {
      const failures = checkCodeScenario(scenario, await runCodeScenario(scenario, { profile }))
      expect(Object.fromEntries(failures)).toEqual({})
    })
  }
})
