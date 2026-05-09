import { describe, expect, it } from 'vitest'
import { EventLogImpl } from '../src/event-log'
import { type KvgitState, Live, connectState } from '../src/state'
import type { AgentEvent, ChapterEvent } from '../src/types'

const evt = (overrides: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent =>
  ({
    timestamp: '2026-05-05T00:00:00.000Z',
    agentName: 'test',
    ...overrides,
  }) as AgentEvent

describe('EventLog — add + iter', () => {
  it('returns events in insertion order', async () => {
    const log = new EventLogImpl(new Live())
    await log.add(evt({ type: 'taskStart', taskName: 't', inputs: null }))
    await log.add(evt({ type: 'success', result: 'r' }))
    await log.add(evt({ type: 'fail', message: 'm' }))
    const out: string[] = []
    for await (const e of log.iter()) out.push(e.type)
    expect(out).toEqual(['taskStart', 'success', 'fail'])
  })

  it('returns the storage key from add()', async () => {
    const log = new EventLogImpl(new Live())
    const key = await log.add(evt({ type: 'success', result: 1 }))
    // Per-session isolation now lives at the StateBackend layer, so
    // event keys live at a clean `evt/` prefix without a session
    // segment.
    expect(key.startsWith('evt/')).toBe(true)
  })

  it('handles same-millisecond collisions with sequence suffix', async () => {
    const log = new EventLogImpl(new Live())
    const sameTs = '2026-05-05T00:00:00.000Z'
    const k1 = await log.add(evt({ type: 'success', timestamp: sameTs, result: 1 }))
    const k2 = await log.add(evt({ type: 'success', timestamp: sameTs, result: 2 }))
    expect(k1).not.toBe(k2)
    const out: unknown[] = []
    for await (const e of log.iter()) {
      if (e.type === 'success') out.push(e.result)
    }
    expect(out).toEqual([1, 2])
  })

  it('iter ignores non-event keys in the same backend', async () => {
    const live = new Live()
    live.set('cache/foo', 'unrelated')
    live.set('vfs/bar', 'unrelated')
    const log = new EventLogImpl(live)
    await log.add(evt({ type: 'success', result: 'kept' }))
    const out: AgentEvent[] = []
    for await (const e of log.iter()) out.push(e)
    expect(out.length).toBe(1)
    expect((out[0] as { type: string; result: string }).result).toBe('kept')
  })
})

describe('EventLog — at()', () => {
  it('returns null on a non-versioned backend (Live)', async () => {
    const log = new EventLogImpl(new Live())
    expect(await log.at('any-hash')).toBeNull()
  })
})

describe('EventLog — commitHash stamping', () => {
  // Mirrors agex-py's `add_event_to_log` (state/log.py:47-57): on a
  // versioned backend, every added event gets `commitHash` set to the
  // PARENT commit at add-time — i.e., "the commit you'd revert to to
  // undo this event." Live backends leave the field absent.
  //
  // Reported by the studio integration: without this, the undo-button
  // gating on EventBase.commitHash never triggered for events read
  // back from history.

  async function makeKvgitLog(): Promise<{ state: KvgitState; log: EventLogImpl }> {
    const r = await connectState({ type: 'versioned', storage: 'memory' })
    const state = (await r.resolve('default')) as KvgitState
    const log = new EventLogImpl(state)
    return { state, log }
  }

  it('Live backend: events have no commitHash', async () => {
    const log = new EventLogImpl(new Live())
    await log.add(evt({ type: 'success', result: 1 }))
    const out: AgentEvent[] = []
    for await (const e of log.iter()) out.push(e)
    expect(out[0]?.commitHash).toBeUndefined()
  })

  it('kvgit backend: events stamped with the current commit at add-time', async () => {
    const { state, log } = await makeKvgitLog()
    const beforeAdd = state.currentCommit
    expect(beforeAdd).toBeTruthy() // initial commit exists
    await log.add(evt({ type: 'taskStart', taskName: 't', inputs: null }))
    const out: AgentEvent[] = []
    for await (const e of log.iter()) out.push(e)
    // Stamped with the *parent* — the commit HEAD pointed at WHEN the
    // event was added, not the commit it'll land in after a flush.
    expect(out[0]?.commitHash).toBe(beforeAdd)
  })

  it('events added across separate commits get different stamps', async () => {
    const { state, log } = await makeKvgitLog()
    const c0 = state.currentCommit
    await log.add(evt({ type: 'success', result: 'first' }))
    const c1 = await state.commit()
    expect(c1).not.toBe(c0)
    await log.add(evt({ type: 'success', result: 'second' }))

    const out: AgentEvent[] = []
    for await (const e of log.iter()) out.push(e)
    expect(out).toHaveLength(2)
    // First event was added before any commit landed → stamped with c0.
    expect(out[0]?.commitHash).toBe(c0)
    // Second event was added after c1 landed → stamped with c1 (its
    // parent for the next commit).
    expect(out[1]?.commitHash).toBe(c1)
  })

  it('events added together share the same commitHash (same parent)', async () => {
    const { state, log } = await makeKvgitLog()
    const c0 = state.currentCommit
    await log.add(evt({ type: 'taskStart', taskName: 't', inputs: null }))
    await log.add(evt({ type: 'success', result: 'r' }))
    const out: AgentEvent[] = []
    for await (const e of log.iter()) out.push(e)
    expect(out.map((e) => e.commitHash)).toEqual([c0, c0])
  })

  it('chapter events also get stamped via replaceRange', async () => {
    const { state, log } = await makeKvgitLog()
    const c0 = state.currentCommit
    const k1 = await log.add(evt({ type: 'success', result: 1 }))
    const k2 = await log.add(evt({ type: 'success', result: 2 }))
    const chapter: ChapterEvent = {
      type: 'chapter',
      timestamp: '2026-05-09T00:00:00.000Z',
      agentName: 'test',
      name: 'first-two',
      message: 'rolled up',
      slug: 'first-two',
      eventRefs: [k1, k2],
    }
    await log.replaceRange([k1, k2], chapter)
    const out: AgentEvent[] = []
    for await (const e of log.iter()) out.push(e)
    // Chapter replaces the originals in the active index; only the
    // chapter event yields back from iter().
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('chapter')
    expect(out[0]?.commitHash).toBe(c0)
  })

  it('does NOT rewrite stamps when commit() lands later', async () => {
    // The semantics is "parent at add-time" — once stamped, the value
    // stays. A subsequent commit doesn't go back and update the events
    // that landed in it.
    const { state, log } = await makeKvgitLog()
    const c0 = state.currentCommit
    await log.add(evt({ type: 'success', result: 'r' }))
    const c1 = await state.commit()
    expect(c1).not.toBe(c0)
    const out: AgentEvent[] = []
    for await (const e of log.iter()) out.push(e)
    // commitHash is still c0 — the parent — not c1 (the commit it
    // landed in). agex-py same.
    expect(out[0]?.commitHash).toBe(c0)
  })

  it('agent.events(session).iter() preserves commitHash on full reload (regression)', async () => {
    // The studio's reported flow: write events through one EventLogImpl,
    // then walk them back through a fresh EventLog reading the same
    // state. The stamp should survive the round-trip — it's stored on
    // the persisted event, not synthesized at iter()-time.
    const { state, log } = await makeKvgitLog()
    const stamp = state.currentCommit
    await log.add(evt({ type: 'taskStart', taskName: 't', inputs: null }))
    await log.add(evt({ type: 'success', result: 'r' }))
    await state.commit()

    // Open a fresh EventLogImpl over the same state and walk.
    const reread = new EventLogImpl(state)
    const out: AgentEvent[] = []
    for await (const e of reread.iter()) out.push(e)
    expect(out).toHaveLength(2)
    expect(out.every((e) => e.commitHash === stamp)).toBe(true)
  })
})
