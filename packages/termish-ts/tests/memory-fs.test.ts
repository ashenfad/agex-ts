import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { runFsConformance } from './fs-conformance'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

runFsConformance('MemoryFS', () => new MemoryFS())

describe('MemoryFS — backend-specific', () => {
  it('returned bytes are isolated from internal storage', async () => {
    // Mutating the returned Uint8Array shouldn't corrupt the store.
    const fs = new MemoryFS()
    await fs.write('/k', bytes('hello'))
    const got = await fs.read('/k')
    got[0] = 0xff
    expect(text(await fs.read('/k'))).toBe('hello')
  })

  it('relative paths normalize . and ..', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/a/b', { parents: true })
    await fs.chdir('/a/b')
    await fs.write('../file', bytes('parent'))
    expect(text(await fs.read('/a/file'))).toBe('parent')
    await fs.write('./local', bytes('here'))
    expect(text(await fs.read('/a/b/local'))).toBe('here')
  })

  it('rmdir cannot remove root', async () => {
    const fs = new MemoryFS()
    await expect(fs.rmdir('/')).rejects.toThrow()
  })

  it('rename to itself is a no-op', async () => {
    const fs = new MemoryFS()
    await fs.write('/k', bytes('v'))
    await fs.rename('/k', '/k')
    expect(text(await fs.read('/k'))).toBe('v')
  })
})
