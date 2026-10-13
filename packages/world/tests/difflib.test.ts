/**
 * The difflib port prints the hunks Python's `difflib.unified_diff`
 * prints: cases recorded from CPython (difflib-golden.json), several
 * hunks, trimmed context, a missing final newline, and line endings
 * Python splits on.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitLinesKeepEnds, unifiedDiff } from '../src/wsgit/difflib'

const cases = JSON.parse(
  readFileSync(new URL('./difflib-golden.json', import.meta.url), 'utf8'),
) as { old: string; new: string; diff: string[] }[]

describe("difflib's unified diff", () => {
  for (const [i, c] of cases.entries()) {
    it(`matches CPython, case ${i + 1}`, () => {
      expect(
        unifiedDiff(splitLinesKeepEnds(c.old), splitLinesKeepEnds(c.new), 'a/f', 'b/f'),
      ).toEqual(c.diff)
    })
  }
})
