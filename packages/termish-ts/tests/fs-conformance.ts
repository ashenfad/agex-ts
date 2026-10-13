/**
 * Registers the exported `FileSystem` conformance cases with vitest, one
 * `it` per case under a `describe` per group.
 *
 * `makeFs` must return a *fresh* `FileSystem` on each call; every case
 * gets its own.
 */

import { describe, it } from 'vitest'
import { type FsConformanceCase, type FsFactory, fsConformanceCases } from '../src/conformance'

export function runFsConformance(name: string, makeFs: FsFactory): void {
  describe(`${name} — FileSystem conformance`, () => {
    const groups = new Map<string, FsConformanceCase[]>()
    for (const c of fsConformanceCases) {
      const cases = groups.get(c.group) ?? []
      cases.push(c)
      groups.set(c.group, cases)
    }
    for (const [group, cases] of groups) {
      describe(group, () => {
        for (const c of cases) {
          it(c.name, async () => c.run(await makeFs()))
        }
      })
    }
  })
}
