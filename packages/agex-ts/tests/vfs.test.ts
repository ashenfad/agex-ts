import { describe, expect, it } from 'vitest'
import { VfsManager } from '../src/vfs'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('VfsManager — memory backing', () => {
  it('returns the same instance for the same session', () => {
    const m = new VfsManager({ type: 'memory' })
    const a = m.fs('alice')
    const b = m.fs('alice')
    expect(a).toBe(b)
  })

  it('isolates files between sessions', async () => {
    const m = new VfsManager({ type: 'memory' })
    const alice = m.fs('alice')
    const bob = m.fs('bob')
    await alice.write('/note.txt', enc.encode('hello from alice'))
    expect(await alice.exists('/note.txt')).toBe(true)
    expect(await bob.exists('/note.txt')).toBe(false)
  })

  it('persists writes across calls within a session', async () => {
    const m = new VfsManager({ type: 'memory' })
    await m.fs('alice').write('/scratch.txt', enc.encode('persisted'))
    const reread = await m.fs('alice').read('/scratch.txt')
    expect(dec.decode(reread)).toBe('persisted')
  })

  it('defaults to memory when no config given', () => {
    const m = new VfsManager()
    expect(m.fs('default')).toBeDefined()
  })
})

describe('VfsManager — kvgit backing', () => {
  it('throws a clear error for unimplemented kvgit type', () => {
    const m = new VfsManager({ type: 'kvgit' })
    expect(() => m.fs('any')).toThrow(/not wired in v1/)
  })
})
