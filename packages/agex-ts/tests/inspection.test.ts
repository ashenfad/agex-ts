import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent } from '../src/types'

async function makeVersionedAgent() {
  const llm = new Dummy({
    responses: [{ emissions: [{ type: 'ts', code: 'taskSuccess(1)' }] }],
  })
  return createAgent({
    name: 'A',
    llm,
    runtime: evalRuntime(),
    state: { type: 'versioned', storage: 'memory' },
  })
}

describe('agent.commitInfo', () => {
  it('returns null on Live state', async () => {
    const a = await createAgent({ name: 'A' })
    expect(await a.commitInfo()).toBeNull()
  })

  it('returns commit metadata on versioned state', async () => {
    const a = await makeVersionedAgent()
    const cache = await a.cache()
    await cache.set('seed', 'value')
    const hash = await a.commit('default', { info: { reason: 'seed' } })
    expect(hash).toBeTruthy()
    const info = await a.commitInfo(hash as string)
    expect(info).toBeTruthy()
    expect((info as Record<string, unknown>).reason).toBe('seed')
  })

  it('returns null for an unknown hash', async () => {
    const a = await makeVersionedAgent()
    expect(await a.commitInfo('00deadbeef')).toBeNull()
  })
})

describe('agent.history', () => {
  it('yields nothing on Live state', async () => {
    const a = await createAgent({ name: 'A' })
    const hashes: string[] = []
    for await (const h of a.history()) hashes.push(h)
    expect(hashes).toEqual([])
  })

  it('walks backward through commits on versioned state', async () => {
    const a = await makeVersionedAgent()
    const cache = await a.cache()
    await cache.set('a', 1)
    await a.commit('default', { info: { step: 1 } })
    await cache.set('b', 2)
    await a.commit('default', { info: { step: 2 } })
    const hashes: string[] = []
    for await (const h of a.history()) hashes.push(h)
    expect(hashes.length).toBeGreaterThanOrEqual(2)
  })
})

describe('agent.eventsAt', () => {
  it('returns null on Live state', async () => {
    const a = await createAgent({ name: 'A' })
    expect(await a.eventsAt('any-hash')).toBeNull()
  })

  it('returns null for an unknown hash on versioned state', async () => {
    const a = await makeVersionedAgent()
    expect(await a.eventsAt('00deadbeef')).toBeNull()
  })

  it('returns the events as they were at a historical commit', async () => {
    const a = await makeVersionedAgent()
    const fn = a.task<undefined, number>({ description: 'X.' })
    await fn(undefined)
    const afterTaskCommit = await a.commit('default', { info: { phase: 'after-task' } })
    expect(afterTaskCommit).toBeTruthy()

    // Add another event after the snapshot
    const cache = await a.cache()
    await cache.set('post', true)
    await a.commit('default', { info: { phase: 'post' } })

    // Reading at the earlier hash sees only the events committed up to then
    const log = await a.eventsAt(afterTaskCommit as string)
    expect(log).not.toBeNull()
    const events: AgentEvent[] = []
    for await (const e of (log as { iter(): AsyncIterable<AgentEvent> }).iter()) {
      events.push(e)
    }
    // Should include the taskStart / action / success from the task run
    const types = events.map((e) => e.type)
    expect(types).toContain('taskStart')
    expect(types).toContain('action')
    expect(types).toContain('success')
  })
})
