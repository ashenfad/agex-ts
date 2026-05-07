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
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import { KvgitState } from '../src/state'
import type { AgentEvent } from '../src/types'

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

describe('session-driven API — task invocation', () => {
  it('task(input, { session }) routes the run to the named session', async () => {
    // The headline embedder pattern: run the same task in two
    // different sessions, expect two independent event logs and
    // two independent cache states. Mirrors agex-py's
    // `my_task(arg, session="alice")` shape.
    const llm = new Dummy({
      // Each task invocation consumes responses in order. Two
      // invocations × one turn each = two responses.
      responses: [
        { emissions: [{ type: 'ts', code: 'await cache.set("who", "alice"); taskSuccess(null)' }] },
        { emissions: [{ type: 'ts', code: 'await cache.set("who", "bob"); taskSuccess(null)' }] },
      ],
    })
    const agent = await createAgent({
      name: 't',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
    })
    const fn = agent.task<undefined, null>({ description: 'Stamp the session.' })

    await fn(undefined, { session: 'alice' })
    await fn(undefined, { session: 'bob' })

    // Each session's cache holds the value the task wrote inside it.
    const aliceCache = await agent.cache('alice')
    const bobCache = await agent.cache('bob')
    expect(await aliceCache.get('who')).toBe('alice')
    expect(await bobCache.get('who')).toBe('bob')
    // The default session was never touched.
    const defaultCache = await agent.cache()
    expect(await defaultCache.get('who')).toBeUndefined()

    // Each session's event log holds exactly one task run (taskStart
    // + action + success).
    const aliceLog = await agent.events('alice')
    const aliceEvents: AgentEvent[] = []
    for await (const e of aliceLog.iter()) aliceEvents.push(e)
    expect(aliceEvents.filter((e) => e.type === 'taskStart').length).toBe(1)
    expect(aliceEvents.filter((e) => e.type === 'success').length).toBe(1)

    const bobLog = await agent.events('bob')
    const bobEvents: AgentEvent[] = []
    for await (const e of bobLog.iter()) bobEvents.push(e)
    expect(bobEvents.filter((e) => e.type === 'taskStart').length).toBe(1)
    expect(bobEvents.filter((e) => e.type === 'success').length).toBe(1)
  })

  it('task() with no session writes to the default session', async () => {
    // Confirms the default-session contract: omitting options
    // routes the run to "default", not to a fresh anonymous session.
    const llm = new Dummy({
      responses: [
        { emissions: [{ type: 'ts', code: 'await cache.set("k", "v"); taskSuccess(null)' }] },
      ],
    })
    const agent = await createAgent({
      name: 't',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
    })
    await agent.task<undefined, null>({ description: 'No-session call.' })(undefined)

    // The default-session cache holds the value.
    const defaultCache = await agent.cache()
    expect(await defaultCache.get('k')).toBe('v')
    // An unrelated session does not.
    const otherCache = await agent.cache('other')
    expect(await otherCache.get('k')).toBeUndefined()
  })
})

describe('session-driven API — direct accessors', () => {
  it('events(session) writes are isolated per-session', async () => {
    // Same agent state config but: two sessions, one event added to
    // each. Each session's iter() yields only its own event.
    const agent = await createAgent({
      name: 't',
      state: { type: 'versioned', storage: 'memory' },
    })
    const aliceLog = await agent.events('alice')
    const bobLog = await agent.events('bob')
    await aliceLog.add({
      type: 'success',
      timestamp: '2026-05-06T00:00:00.000Z',
      agentName: 't',
      result: 'alice-only',
    })
    await bobLog.add({
      type: 'success',
      timestamp: '2026-05-06T00:00:01.000Z',
      agentName: 't',
      result: 'bob-only',
    })

    const aliceEvents: AgentEvent[] = []
    for await (const e of aliceLog.iter()) aliceEvents.push(e)
    const bobEvents: AgentEvent[] = []
    for await (const e of bobLog.iter()) bobEvents.push(e)

    expect(aliceEvents.length).toBe(1)
    expect(bobEvents.length).toBe(1)
    expect((aliceEvents[0] as { result: string }).result).toBe('alice-only')
    expect((bobEvents[0] as { result: string }).result).toBe('bob-only')
  })

  it('state(session) returns isolated backends per session', async () => {
    // Direct state-level access: writes on one session's backend
    // are invisible to another's. Substrate-level isolation, no
    // key prefix involved.
    const agent = await createAgent({
      name: 't',
      state: { type: 'versioned', storage: 'memory' },
    })
    const aliceState = await agent.state('alice')
    const bobState = await agent.state('bob')
    aliceState.set('key', 'alice-value')
    bobState.set('key', 'bob-value')
    expect(await aliceState.get('key')).toBe('alice-value')
    expect(await bobState.get('key')).toBe('bob-value')

    // Same-session calls return the same backend instance (cached).
    expect(await agent.state('alice')).toBe(aliceState)
    expect(await agent.state('alice')).not.toBe(await agent.state('bob'))
  })

  it("history(hash, { session }) walks the named session's commit chain", async () => {
    // Each session has its own commit chain. Walking with an
    // explicit session option should yield only that session's
    // commits, not any other's.
    const agent = await createAgent({
      name: 't',
      state: { type: 'versioned', storage: 'memory' },
    })
    const aliceCache = await agent.cache('alice')
    await aliceCache.set('a', 1)
    await agent.commit('alice', { info: { who: 'alice' } })
    await aliceCache.set('a', 2)
    await agent.commit('alice', { info: { who: 'alice' } })

    const bobCache = await agent.cache('bob')
    await bobCache.set('b', 1)
    await agent.commit('bob', { info: { who: 'bob' } })

    const aliceHashes: string[] = []
    for await (const h of agent.history(undefined, { session: 'alice' })) aliceHashes.push(h)
    const bobHashes: string[] = []
    for await (const h of agent.history(undefined, { session: 'bob' })) bobHashes.push(h)

    // Alice's chain has at least the two commits we made; Bob's has
    // at least one. Each session walks its own substrate's HEAD —
    // and since they each made distinct commits, their HEAD hashes
    // differ. (Their *root* commits may share a hash because empty-
    // root content-addresses identically; that's fine.)
    expect(aliceHashes.length).toBeGreaterThanOrEqual(2)
    expect(bobHashes.length).toBeGreaterThanOrEqual(1)
    expect(aliceHashes[0]).not.toBe(bobHashes[0])
  })
})
