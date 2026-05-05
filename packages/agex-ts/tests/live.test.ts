import { describe, expect, it } from 'vitest'
import { Live, isVersioned } from '../src/state'

describe('Live — basic Map surface', () => {
  it('round-trips values', async () => {
    const s = new Live()
    s.set('a', 1)
    s.set('b', { nested: true })
    expect(await s.get('a')).toBe(1)
    expect(await s.get('b')).toEqual({ nested: true })
  })

  it('returns undefined for missing keys', async () => {
    const s = new Live()
    expect(await s.get('nope')).toBeUndefined()
  })

  it('has() reflects key presence', async () => {
    const s = new Live()
    s.set('k', 'v')
    expect(await s.has('k')).toBe(true)
    expect(await s.has('missing')).toBe(false)
  })

  it('delete removes keys', async () => {
    const s = new Live()
    s.set('k', 'v')
    s.delete('k')
    expect(await s.has('k')).toBe(false)
  })

  it('typed get<T>() narrows the return', async () => {
    const s = new Live()
    s.set<{ x: number }>('obj', { x: 42 })
    const got = await s.get<{ x: number }>('obj')
    expect(got?.x).toBe(42)
  })
})

describe('Live — keys()', () => {
  it('iterates current keys', async () => {
    const s = new Live()
    s.set('a', 1)
    s.set('b', 2)
    s.set('c', 3)
    const out: string[] = []
    for await (const k of s.keys()) out.push(k)
    expect(out.sort()).toEqual(['a', 'b', 'c'])
  })

  it('snapshots the key set so mid-iteration writes do not affect it', async () => {
    const s = new Live()
    s.set('a', 1)
    s.set('b', 2)
    const seen: string[] = []
    for await (const k of s.keys()) {
      seen.push(k)
      // mutation mid-iteration shouldn't change what we yield
      s.set('z', 99)
    }
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  it('size reflects underlying Map', () => {
    const s = new Live()
    s.set('a', 1)
    s.set('b', 2)
    expect(s.size).toBe(2)
    s.delete('a')
    expect(s.size).toBe(1)
  })
})

describe('Live — versioning predicate', () => {
  it('isVersioned returns false for Live', () => {
    expect(isVersioned(new Live())).toBe(false)
  })
})
