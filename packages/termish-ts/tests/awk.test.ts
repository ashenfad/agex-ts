/**
 * awk beyond the shared cases in `cases/awk.json`, which run with the
 * others in `cases.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

describe('awk', () => {
  it('stops a runaway loop when the signal aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await expect(
      execute("awk 'BEGIN { while (1) x++ }'", new MemoryFS(), { signal: controller.signal }),
    ).rejects.toThrow(/aborted/)
  })
})
