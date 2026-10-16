/**
 * Redirect targets under the silent-failure rules. The shared cases in
 * `cases/silent-failures.json` run with the others in `cases.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/index'

describe('redirect targets expand before the command runs', () => {
  it.each(['>', '>>', '2>', '2>>'])(
    'an unset variable after %s leaves nothing done',
    async (op) => {
      const fs = new MemoryFS()
      await fs.write('/victim', new TextEncoder().encode('x'))
      await expect(execute(`rm /victim ${op} $NOPE`, fs)).rejects.toThrow('NOPE: unbound variable')
      await expect(execute(`touch /made ${op} $NOPE`, fs)).rejects.toThrow('NOPE: unbound variable')
      expect(await fs.exists('/victim')).toBe(true)
      expect(await fs.exists('/made')).toBe(false)
    },
  )

  it('a target resolves in the directory the command starts in', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/sub')
    await execute('cd sub > log', fs)
    expect(await fs.exists('/log')).toBe(true)
    expect(await fs.exists('/sub/log')).toBe(false)
  })
})
