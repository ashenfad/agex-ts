import { describe, expect, it } from 'vitest'
import { EventLogImpl } from '../src/event-log'
import { Live } from '../src/state'
import type { AgentEvent } from '../src/types'

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
