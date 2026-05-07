import { describe, expect, it } from 'vitest'
import { KvgitState, Live, connectState, isVersioned } from '../src/state'

describe('connectState — live', () => {
  it('returns a non-versioned resolver for { type: "live" }', async () => {
    const r = await connectState({ type: 'live' })
    expect(r.versioned).toBe(false)
    const s = await r.resolve('default')
    expect(s).toBeInstanceOf(Live)
    expect(isVersioned(s)).toBe(false)
  })

  it('defaults to live when no config given', async () => {
    const r = await connectState()
    const s = await r.resolve('default')
    expect(s).toBeInstanceOf(Live)
  })

  it('resolves the same instance for the same session id', async () => {
    const r = await connectState({ type: 'live' })
    const a = await r.resolve('alice')
    const b = await r.resolve('alice')
    expect(a).toBe(b)
  })

  it('resolves different instances for different sessions', async () => {
    const r = await connectState({ type: 'live' })
    const a = await r.resolve('alice')
    const b = await r.resolve('bob')
    expect(a).not.toBe(b)
  })
})

describe('connectState — versioned/memory', () => {
  it('returns a versioned resolver, KvgitState per session', async () => {
    const r = await connectState({ type: 'versioned', storage: 'memory' })
    expect(r.versioned).toBe(true)
    const s = await r.resolve('default')
    expect(s).toBeInstanceOf(KvgitState)
    expect(isVersioned(s)).toBe(true)
  })

  it('round-trips writes through commit', async () => {
    const r = await connectState({ type: 'versioned', storage: 'memory' })
    const s = (await r.resolve('default')) as KvgitState
    expect(s.currentCommit).toBeTruthy()
    const startCommit = s.currentCommit
    s.set('greeting', 'hello')
    expect(s.hasChanges).toBe(true)
    expect(await s.get('greeting')).toBe('hello')
    const newCommit = await s.commit()
    expect(s.hasChanges).toBe(false)
    expect(newCommit).not.toBe(startCommit)
    expect(s.currentCommit).toBe(newCommit)
  })

  it('commit() with no changes is a no-op', async () => {
    const r = await connectState({ type: 'versioned', storage: 'memory' })
    const s = (await r.resolve('default')) as KvgitState
    const before = s.currentCommit
    const after = await s.commit()
    expect(after).toBe(before)
  })

  it('separate sessions have independent commit chains', async () => {
    // The whole point of the per-session-substrate model: writes to
    // alice never appear in bob's commit graph.
    const r = await connectState({ type: 'versioned', storage: 'memory' })
    const alice = (await r.resolve('alice')) as KvgitState
    const bob = (await r.resolve('bob')) as KvgitState
    alice.set('owner', 'alice')
    await alice.commit({ info: { tag: 'alice-write' } })
    bob.set('owner', 'bob')
    await bob.commit({ info: { tag: 'bob-write' } })
    expect(await alice.get('owner')).toBe('alice')
    expect(await bob.get('owner')).toBe('bob')
    // The current commits are distinct heads on independent chains.
    expect(alice.currentCommit).not.toBe(bob.currentCommit)
  })
})

describe('connectState — errors', () => {
  it('rejects sqlite without a path', async () => {
    await expect(connectState({ type: 'versioned', storage: 'sqlite' })).rejects.toThrow(
      /requires a `path`/,
    )
  })
})
