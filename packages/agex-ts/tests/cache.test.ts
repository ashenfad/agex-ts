import { describe, expect, it } from 'vitest'
import { CacheManager } from '../src/cache'
import { Live } from '../src/state'

describe('Cache — round-trip', () => {
  it('set / get / has / delete', async () => {
    const c = new CacheManager(new Live()).cache('default')
    expect(await c.has('k')).toBe(false)
    await c.set('k', 42)
    expect(await c.has('k')).toBe(true)
    expect(await c.get<number>('k')).toBe(42)
    expect(await c.delete('k')).toBe(true)
    expect(await c.has('k')).toBe(false)
  })

  it('delete returns false for missing keys', async () => {
    const c = new CacheManager(new Live()).cache('default')
    expect(await c.delete('nope')).toBe(false)
  })

  it('keys() returns user keys, sorted', async () => {
    const c = new CacheManager(new Live()).cache('default')
    await c.set('beta', 1)
    await c.set('alpha', 2)
    await c.set('gamma', 3)
    expect(await c.keys()).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('Cache — session isolation', () => {
  it('different sessions see different keyspaces', async () => {
    const m = new CacheManager(new Live())
    await m.cache('alice').set('greeting', 'hi alice')
    await m.cache('bob').set('greeting', 'hi bob')
    expect(await m.cache('alice').get('greeting')).toBe('hi alice')
    expect(await m.cache('bob').get('greeting')).toBe('hi bob')
    expect(await m.cache('alice').keys()).toEqual(['greeting'])
    expect(await m.cache('bob').keys()).toEqual(['greeting'])
  })

  it('cache() returns the same instance per session', () => {
    const m = new CacheManager(new Live())
    expect(m.cache('a')).toBe(m.cache('a'))
    expect(m.cache('a')).not.toBe(m.cache('b'))
  })
})

describe('Cache — coexists with other state-keyed data', () => {
  it('does not surface events or unrelated keys via keys()', async () => {
    const live = new Live()
    live.set('evt/foo', { type: 'fake' })
    live.set('vfs/bar', 'unrelated')
    const c = new CacheManager(live).cache('default')
    await c.set('mine', 1)
    expect(await c.keys()).toEqual(['mine'])
  })
})
