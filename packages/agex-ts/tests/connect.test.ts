import { describe, expect, it } from 'vitest'
import { KvgitState, Live, connectState, isVersioned } from '../src/state'

describe('connectState — live', () => {
  it('returns a Live instance for { type: "live" }', async () => {
    const s = await connectState({ type: 'live' })
    expect(s).toBeInstanceOf(Live)
    expect(isVersioned(s)).toBe(false)
  })

  it('defaults to live when no config given', async () => {
    const s = await connectState()
    expect(s).toBeInstanceOf(Live)
  })
})

describe('connectState — versioned/memory', () => {
  it('returns a KvgitState backed by kvgit memory store', async () => {
    const s = await connectState({ type: 'versioned', storage: 'memory' })
    expect(s).toBeInstanceOf(KvgitState)
    expect(isVersioned(s)).toBe(true)
  })

  it('round-trips writes through commit', async () => {
    const s = (await connectState({ type: 'versioned', storage: 'memory' })) as KvgitState
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
    const s = (await connectState({ type: 'versioned', storage: 'memory' })) as KvgitState
    const before = s.currentCommit
    const after = await s.commit()
    expect(after).toBe(before)
  })
})

describe('connectState — errors', () => {
  it('rejects sqlite without a path', async () => {
    await expect(connectState({ type: 'versioned', storage: 'sqlite' })).rejects.toThrow(
      /requires a `path`/,
    )
  })
})
