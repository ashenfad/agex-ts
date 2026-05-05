import { describe, expect, it } from 'vitest'
import { Agent, createAgent } from '../src/agent'
import { RegistrationError } from '../src/errors'
import { Live, isVersioned } from '../src/state'

describe('createAgent — defaults', () => {
  it('builds with just a name (live state, memory fs)', async () => {
    const a = await createAgent({ name: 'tiny' })
    expect(a.name).toBe('tiny')
    expect(a.maxIterations).toBe(10)
    expect(isVersioned(a.state())).toBe(false)
  })

  it('honors explicit state config', async () => {
    const a = await createAgent({ name: 'kv', state: { type: 'versioned', storage: 'memory' } })
    expect(isVersioned(a.state())).toBe(true)
  })
})

describe('Agent — registration delegation', () => {
  it('records fn / namespace / skill / terminal in the policy', async () => {
    const a = await createAgent({ name: 't' })
    a.fn('greet', () => 'hi', { description: 'Greet.' })
    a.namespace('utils', { add: (x: number, y: number) => x + y }, { description: 'Math.' })
    a.skill('basics', '# Basics\nDo X then Y.')
    a.terminal('beep', { description: 'Beep loudly.', handler: async () => undefined })
    const p = a.policy()
    expect([...p.fns.keys()]).toEqual(['greet'])
    expect([...p.namespaces.keys()]).toEqual(['utils'])
    expect([...p.skills.keys()]).toEqual(['basics'])
    expect([...p.terminals.keys()]).toEqual(['beep'])
  })

  it('returns this for chaining', async () => {
    const a = await createAgent({ name: 't' })
    expect(a.fn('a', () => null)).toBe(a)
    expect(a.skill('s', 'doc')).toBe(a)
  })

  it('fingerprint shifts as registrations land', async () => {
    const a = await createAgent({ name: 't' })
    const fp0 = a.fingerprint
    a.fn('greet', () => 'hi')
    const fp1 = a.fingerprint
    expect(fp1).not.toBe(fp0)
  })

  it('cross-kind name collision throws RegistrationError', async () => {
    const a = await createAgent({ name: 't' })
    a.fn('shared', () => null)
    expect(() => a.skill('shared', 'doc')).toThrow(RegistrationError)
  })
})

describe('Agent — per-session host APIs', () => {
  it('fs(session) returns the same instance across calls', async () => {
    const a = await createAgent({ name: 't' })
    expect(a.fs('alice')).toBe(a.fs('alice'))
    expect(a.fs('alice')).not.toBe(a.fs('bob'))
  })

  it('cache(session) is per-session', async () => {
    const a = await createAgent({ name: 't' })
    await a.cache('alice').set('x', 1)
    await a.cache('bob').set('x', 2)
    expect(await a.cache('alice').get('x')).toBe(1)
    expect(await a.cache('bob').get('x')).toBe(2)
  })

  it('events(session) returns the same EventLog per session', async () => {
    const a = await createAgent({ name: 't' })
    expect(a.events('alice')).toBe(a.events('alice'))
  })

  it('default session is shared across no-arg calls', async () => {
    const a = await createAgent({ name: 't' })
    expect(a.fs()).toBe(a.fs('default'))
    expect(a.cache()).toBe(a.cache('default'))
  })
})

describe('Agent — commit', () => {
  it('returns null on Live state', async () => {
    const a = await createAgent({ name: 't' })
    expect(await a.commit()).toBeNull()
  })

  it('returns a new commit hash on versioned state with changes', async () => {
    const a = await createAgent({ name: 't', state: { type: 'versioned', storage: 'memory' } })
    await a.cache('default').set('k', 'v')
    const hash = await a.commit()
    expect(typeof hash).toBe('string')
    expect((hash as string).length).toBeGreaterThan(0)
  })
})

describe('Agent — direct construction', () => {
  it('accepts a pre-built StateBackend', () => {
    const a = new Agent({ name: 'manual' }, new Live())
    expect(a.name).toBe('manual')
  })
})
