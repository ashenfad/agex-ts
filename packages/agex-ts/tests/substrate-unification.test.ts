/**
 * Substrate-unification integration tests.
 *
 * These guard the agex-py-style architecture the substrate work
 * landed: each framework session = its own `VersionedKV`, one
 * `Staged` per session carries both file content (FileRecord) and
 * state values (JSON) via the polymorphic encoder, and one
 * `commit(session)` atomically captures the whole world for that
 * session.
 */

import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { KvgitState } from '../src/state'

describe('substrate unification — files + state in one kvgit substrate', () => {
  it('agent.commit(session) captures both VFS writes and state writes atomically', async () => {
    const a = await createAgent({
      name: 't',
      state: { type: 'versioned', storage: 'memory' },
      fs: { type: 'kvgit' },
    })
    const fs = await a.fs('alice')
    const cache = await a.cache('alice')

    // Mix file content + state value in one buffer.
    await fs.mkdir('/notes')
    await fs.write('/notes/today.md', new TextEncoder().encode('# Today\n\nHello.'))
    await cache.set('lastEdit', { path: '/notes/today.md', tag: 'wip' })

    // One Staged for this session — pull it out to confirm the writes
    // really land in the same buffer (not two separate ones).
    const state = await a.state('alice')
    if (!(state instanceof KvgitState)) throw new Error('expected kvgit state')
    expect(state.staged.hasChanges).toBe(true)

    const hash = await a.commit('alice', { info: { reason: 'first edit' } })
    expect(typeof hash).toBe('string')
    expect(state.staged.hasChanges).toBe(false)

    // Both visible after commit through their respective surfaces.
    expect(new TextDecoder().decode(await fs.read('/notes/today.md'))).toContain('Hello.')
    expect(await cache.get('lastEdit')).toEqual({ path: '/notes/today.md', tag: 'wip' })

    // commitInfo round-trips the info dict — confirms the write
    // really crossed into kvgit-land, not just the buffer.
    const info = await a.commitInfo(hash as string, 'alice')
    expect(info).toBeTruthy()
    expect((info as Record<string, unknown>).reason).toBe('first edit')
  })

  it('separate sessions have separate VFS contents and separate commit chains', async () => {
    const a = await createAgent({
      name: 't',
      state: { type: 'versioned', storage: 'memory' },
      fs: { type: 'kvgit' },
    })
    const aliceFs = await a.fs('alice')
    const bobFs = await a.fs('bob')

    await aliceFs.write('/owner.txt', new TextEncoder().encode('alice'))
    await bobFs.write('/owner.txt', new TextEncoder().encode('bob'))
    await a.commit('alice')
    await a.commit('bob')

    // Each session sees its own /owner.txt.
    expect(new TextDecoder().decode(await aliceFs.read('/owner.txt'))).toBe('alice')
    expect(new TextDecoder().decode(await bobFs.read('/owner.txt'))).toBe('bob')

    // Independent commit chains — each session has its own current head.
    const aliceState = (await a.state('alice')) as KvgitState
    const bobState = (await a.state('bob')) as KvgitState
    expect(aliceState.currentCommit).not.toBe(bobState.currentCommit)
  })

  it('rejects { fs: kvgit } against a Live (non-versioned) state', async () => {
    // Eager-rejection at agent construction makes the misconfiguration
    // obvious instead of waiting for the first fs() call.
    await expect(
      createAgent({
        name: 't',
        state: { type: 'live' },
        fs: { type: 'kvgit' },
      }),
    ).rejects.toThrow(/requires.*versioned/)
  })
})
