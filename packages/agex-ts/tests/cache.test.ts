import { describe, expect, it } from 'vitest'
import { CacheImpl } from '../src/cache'
import { Live } from '../src/state'

describe('Cache — round-trip', () => {
  it('set / get / has / delete', async () => {
    const c = new CacheImpl(new Live(), 'default')
    expect(await c.has('k')).toBe(false)
    await c.set('k', 42)
    expect(await c.has('k')).toBe(true)
    expect(await c.get<number>('k')).toBe(42)
    expect(await c.delete('k')).toBe(true)
    expect(await c.has('k')).toBe(false)
  })

  it('delete returns false for missing keys', async () => {
    const c = new CacheImpl(new Live(), 'default')
    expect(await c.delete('nope')).toBe(false)
  })

  it('keys() returns user keys, sorted', async () => {
    const c = new CacheImpl(new Live(), 'default')
    await c.set('beta', 1)
    await c.set('alpha', 2)
    await c.set('gamma', 3)
    expect(await c.keys()).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('Cache — session isolation', () => {
  it('two CacheImpls over different state backends do not share keys', async () => {
    // After the per-session-substrate restructure, isolation lives at
    // the StateBackend layer: each session has its own backend. The
    // cache itself is just a thin keyed view.
    const aliceState = new Live()
    const bobState = new Live()
    const alice = new CacheImpl(aliceState, 'alice')
    const bob = new CacheImpl(bobState, 'bob')
    await alice.set('greeting', 'hi alice')
    await bob.set('greeting', 'hi bob')
    expect(await alice.get('greeting')).toBe('hi alice')
    expect(await bob.get('greeting')).toBe('hi bob')
    expect(await alice.keys()).toEqual(['greeting'])
    expect(await bob.keys()).toEqual(['greeting'])
  })
})

describe('Cache — coexists with other state-keyed data', () => {
  it('does not surface events or unrelated keys via keys()', async () => {
    const live = new Live()
    live.set('evt/foo', { type: 'fake' })
    live.set('__event_log__', [])
    const c = new CacheImpl(live, 'default')
    await c.set('mine', 1)
    expect(await c.keys()).toEqual(['mine'])
  })
})
