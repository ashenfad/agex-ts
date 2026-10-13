/** agex's shape corpus, vendored: what applies to agex-ts. Running it
 *  comes with tasks (A6) and agent-defined tasks (A7). */

import { describe, expect, it } from 'vitest'
import { AGEX_COMMIT, CODE_SCENARIOS, TASK_SCENARIOS, appliesToTs } from '../src/conformance/index'

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
