import { describe, expect, it } from 'vitest'
import { Agent, createAgent } from '../src/agent'
import { RegistrationError } from '../src/errors'
import { Live, isVersioned } from '../src/state'

describe('createAgent — defaults', () => {
  it('builds with just a name (live state, memory fs)', async () => {
    const a = await createAgent({ name: 'tiny' })
    expect(a.name).toBe('tiny')
    expect(a.maxIterations).toBe(10)
    expect(isVersioned(await a.state())).toBe(false)
  })

  it('honors explicit state config', async () => {
    const a = await createAgent({ name: 'kv', state: { type: 'versioned', storage: 'memory' } })
    expect(isVersioned(await a.state())).toBe(true)
  })
})

describe('Agent — registration delegation', () => {
  it('records fn / namespace / skill / terminal in the policy', async () => {
    const a = await createAgent({ name: 't' })
    a.fn(() => 'hi', { name: 'greet', description: 'Greet.' })
    a.namespace({ add: (x: number, y: number) => x + y }, { name: 'utils', description: 'Math.' })
    a.skill('# Basics\nDo X then Y.', { name: 'basics' })
    a.terminal(async () => undefined, { name: 'beep', description: 'Beep loudly.' })
    const p = a.policy()
    expect([...p.fns.keys()]).toEqual(['greet'])
    expect([...p.namespaces.keys()]).toEqual(['utils'])
    expect([...p.skills.keys()]).toEqual(['basics'])
    expect([...p.terminals.keys()]).toEqual(['beep'])
  })

  it('returns this for chaining', async () => {
    const a = await createAgent({ name: 't' })
    expect(a.fn(() => null, { name: 'a' })).toBe(a)
    expect(a.skill('doc', { name: 's' })).toBe(a)
  })

  it('fingerprint shifts as registrations land', async () => {
    const a = await createAgent({ name: 't' })
    const fp0 = a.fingerprint
    a.fn(() => 'hi', { name: 'greet' })
    const fp1 = a.fingerprint
    expect(fp1).not.toBe(fp0)
  })

  it('cross-kind name collision throws RegistrationError', async () => {
    const a = await createAgent({ name: 't' })
    a.fn(() => null, { name: 'shared' })
    expect(() => a.skill('doc', { name: 'shared' })).toThrow(RegistrationError)
  })

  it('infers fn name from .name when no explicit name is given', async () => {
    const a = await createAgent({ name: 't' })
    function greet() {
      return 'hi'
    }
    a.fn(greet)
    expect([...a.policy().fns.keys()]).toEqual(['greet'])
  })

  it('infers cls name from .name when no explicit name is given', async () => {
    const a = await createAgent({ name: 't' })
    class Vec {}
    a.cls(Vec)
    expect([...a.policy().classes.keys()]).toEqual(['Vec'])
  })

  it('throws a clear error when fn has no inferable name', async () => {
    const a = await createAgent({ name: 't' })
    // An anonymous arrow function has fn.name === '' — must supply
    // an explicit name.
    expect(() => a.fn(() => null)).toThrow(/no name available/)
  })
})

describe('Agent — URL-shipped registrations', () => {
  it('accepts { url, export } as the first arg of fn / cls / namespace', async () => {
    const a = await createAgent({ name: 't' })
    a.fn({ url: 'https://example.com/m.js', export: 'compute' }, { name: 'compute' })
    a.cls({ url: 'https://example.com/m.js', export: 'Vec' }, { name: 'Vec' })
    a.namespace({ url: 'https://example.com/m.js' }, { name: 'utils' })
    const p = a.policy()
    expect(p.fns.get('compute')?.url).toBe('https://example.com/m.js')
    expect(p.fns.get('compute')?.export).toBe('compute')
    expect(p.classes.get('Vec')?.url).toBe('https://example.com/m.js')
    expect(p.namespaces.get('utils')?.url).toBe('https://example.com/m.js')
  })

  it('infers name from the export when no opts.name is given', async () => {
    const a = await createAgent({ name: 't' })
    a.cls({ url: 'https://example.com/m.js', export: 'Vec' })
    expect([...a.policy().classes.keys()]).toEqual(['Vec'])
  })

  it('rejects URL combined with include/exclude/configure on cls', async () => {
    const a = await createAgent({ name: 't' })
    expect(() =>
      a.cls({ url: 'https://example.com/m.js' }, { name: 'Vec', exclude: ['secret'] }),
    ).toThrow(/can't be combined with \{ url \}/)
  })

  it('rejects URL combined with include on namespace', async () => {
    const a = await createAgent({ name: 't' })
    expect(() =>
      a.namespace({ url: 'https://example.com/m.js' }, { name: 'utils', include: ['safe*'] }),
    ).toThrow(/can't be combined with \{ url \}/)
  })

  it('rejects an empty URL string', async () => {
    const a = await createAgent({ name: 't' })
    expect(() => a.fn({ url: '' }, { name: 'broken' })).toThrow(/url must be a non-empty string/)
  })

  it('rejects URL combined with paramsSchema on fn', async () => {
    // paramsSchema runs host-side via the agent loop; a URL-shipped
    // fn is called natively in the worker, so the schema would
    // silently never fire. Reject loudly instead.
    const a = await createAgent({ name: 't' })
    const fakeSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) => ({ value: v }),
      },
    }
    expect(() =>
      a.fn({ url: 'https://example.com/m.js' }, { name: 'compute', paramsSchema: fakeSchema }),
    ).toThrow(/paramsSchema can't be combined with \{ url \}/)
  })

  it('rejects URL combined with constructable: false on cls', async () => {
    // constructable: false manifests as a primer hint, but the
    // URL-shipped class is the real constructor — the agent can
    // `new` it regardless. Reject so the primer doesn't lie.
    const a = await createAgent({ name: 't' })
    expect(() =>
      a.cls({ url: 'https://example.com/m.js' }, { name: 'Vec', constructable: false }),
    ).toThrow(/constructable: false can't be combined with \{ url \}/)
  })

  it("doesn't mistake a namespace target with a `url` member for a URL spec", async () => {
    // A real namespace target can have a `url` field — as long as
    // it has *other* properties too, the type guard treats it as a
    // host-bound target, not a URL spec.
    const a = await createAgent({ name: 't' })
    const target = { url: 'http://api.example.com', call: () => 'ok' }
    a.namespace(target, { name: 'api' })
    const reg = a.policy().namespaces.get('api')
    expect(reg?.target).toBe(target)
    expect(reg?.url).toBeUndefined()
  })
})

describe('Agent — per-session host APIs', () => {
  it('fs(session) returns the same instance across calls', async () => {
    const a = await createAgent({ name: 't' })
    expect(await a.fs('alice')).toBe(await a.fs('alice'))
    expect(await a.fs('alice')).not.toBe(await a.fs('bob'))
  })

  it('cache(session) is per-session', async () => {
    const a = await createAgent({ name: 't' })
    const alice = await a.cache('alice')
    const bob = await a.cache('bob')
    await alice.set('x', 1)
    await bob.set('x', 2)
    expect(await alice.get('x')).toBe(1)
    expect(await bob.get('x')).toBe(2)
  })

  it('events(session) returns the same EventLog per session', async () => {
    const a = await createAgent({ name: 't' })
    expect(await a.events('alice')).toBe(await a.events('alice'))
  })

  it('default session is shared across no-arg calls', async () => {
    const a = await createAgent({ name: 't' })
    expect(await a.fs()).toBe(await a.fs('default'))
    expect(await a.cache()).toBe(await a.cache('default'))
  })

  it('versioned state: separate sessions are independent commit chains', async () => {
    // Sessions = separate VersionedKV instances. Writes to one don't
    // appear in the other's commit chain.
    const a = await createAgent({
      name: 't',
      state: { type: 'versioned', storage: 'memory' },
    })
    const alice = await a.cache('alice')
    const bob = await a.cache('bob')
    await alice.set('owner', 'alice')
    await bob.set('owner', 'bob')
    await a.commit('alice')
    await a.commit('bob')
    expect(await alice.get('owner')).toBe('alice')
    expect(await bob.get('owner')).toBe('bob')
    expect(await alice.has('owner')).toBe(true)
    // Bob's session should not see alice's key.
    expect(await bob.get('owner')).not.toBe('alice')
  })
})

describe('Agent — commit', () => {
  it('returns null on Live state', async () => {
    const a = await createAgent({ name: 't' })
    expect(await a.commit()).toBeNull()
  })

  it('returns a new commit hash on versioned state with changes', async () => {
    const a = await createAgent({ name: 't', state: { type: 'versioned', storage: 'memory' } })
    const cache = await a.cache('default')
    await cache.set('k', 'v')
    const hash = await a.commit()
    expect(typeof hash).toBe('string')
    expect((hash as string).length).toBeGreaterThan(0)
  })
})

describe('Agent — direct construction', () => {
  it('accepts a pre-built StateResolver', async () => {
    // Trivial inline resolver hands every session the same Live —
    // matches the prior single-state shape for tests that don't care
    // about session isolation.
    const live = new Live()
    const resolver = {
      versioned: false,
      async resolve(): Promise<Live> {
        return live
      },
    }
    const a = new Agent({ name: 'manual' }, resolver)
    expect(a.name).toBe('manual')
  })
})

describe('Agent — reconfigure', () => {
  // Hot-swap the safe-to-mutate subset of AgentOptions on a
  // constructed Agent. Each field replaces its current value on the
  // next read; tests verify both that the read sees the new value
  // and that the readers are reading freshly per call (not cached
  // at construction time).

  it('reconfigure({ llm }) — agent.llm reflects the new client immediately', async () => {
    const llm1 = { complete: async function* () {} } as unknown as import('../src/types').LLMClient
    const llm2 = { complete: async function* () {} } as unknown as import('../src/types').LLMClient
    const a = await createAgent({ name: 'r', llm: llm1 })
    expect(a.llm).toBe(llm1)
    a.reconfigure({ llm: llm2 })
    expect(a.llm).toBe(llm2)
  })

  it('reconfigure({ primer }) — propagates to the next system message build', async () => {
    const a = await createAgent({ name: 'r', primer: 'first voice' })
    expect(a.primer).toBe('first voice')
    a.reconfigure({ primer: 'second voice' })
    expect(a.primer).toBe('second voice')
  })

  it('reconfigure({ chapteringTrigger }) — number replaces, undefined disables', async () => {
    const a = await createAgent({ name: 'r', chapteringTrigger: 1000 })
    expect(a.chapteringTrigger).toBe(1000)
    a.reconfigure({ chapteringTrigger: 2500 })
    expect(a.chapteringTrigger).toBe(2500)
    // Explicit undefined turns auto-fire off — important for the
    // settings UI use case ("user toggled off auto-chaptering").
    a.reconfigure({ chapteringTrigger: undefined })
    expect(a.chapteringTrigger).toBeUndefined()
  })

  it('reconfigure({ maxIterations }) — replaces the per-task turn cap', async () => {
    const a = await createAgent({ name: 'r' })
    expect(a.maxIterations).toBe(10) // default
    a.reconfigure({ maxIterations: 25 })
    expect(a.maxIterations).toBe(25)
  })

  it('reconfigure({ agexPrimerOverride }) and ({ capabilitiesPrimer }) — propagate to next read', async () => {
    const a = await createAgent({ name: 'r' })
    expect(a.agexPrimerOverride).toBeUndefined()
    expect(a.capabilitiesPrimer).toBeUndefined()
    a.reconfigure({
      agexPrimerOverride: 'custom env',
      capabilitiesPrimer: 'curated tools',
    })
    expect(a.agexPrimerOverride).toBe('custom env')
    expect(a.capabilitiesPrimer).toBe('curated tools')
  })

  it('reconfigure with omitted fields preserves existing values (no clobber)', async () => {
    const llm = { complete: async function* () {} } as unknown as import('../src/types').LLMClient
    const a = await createAgent({
      name: 'r',
      llm,
      primer: 'keep me',
      chapteringTrigger: 500,
      maxIterations: 7,
    })
    // Reconfigure ONLY the chapteringTrigger; everything else stays.
    a.reconfigure({ chapteringTrigger: 999 })
    expect(a.llm).toBe(llm)
    expect(a.primer).toBe('keep me')
    expect(a.chapteringTrigger).toBe(999)
    expect(a.maxIterations).toBe(7)
  })

  it('reconfigure does NOT touch identity / substrate fields', async () => {
    // The TypeScript signature already excludes name/state/runtime/fs
    // from ReconfigurableOptions, but verify at runtime that even if
    // someone forces an extra key through (`as any`), it's ignored
    // by the spread merge (the type doesn't have those fields, so
    // the spread literally can't include them — but defense is
    // cheap). Mostly this test documents the safe-set contract.
    const a = await createAgent({ name: 'fixed', maxIterations: 3 })
    expect(a.name).toBe('fixed')
    a.reconfigure({ maxIterations: 8 })
    expect(a.name).toBe('fixed') // unchanged
    expect(a.maxIterations).toBe(8) // changed
  })

  it('successive reconfigures compose; later wins on overlapping fields', async () => {
    const a = await createAgent({ name: 'r' })
    a.reconfigure({ primer: 'v1', chapteringTrigger: 100 })
    a.reconfigure({ primer: 'v2' }) // chapteringTrigger NOT touched
    expect(a.primer).toBe('v2')
    expect(a.chapteringTrigger).toBe(100)
  })

  it('end-to-end: reconfigure({llm}) routes the NEXT task through the new client', async () => {
    // The bug the studio reported: settings drawer changes the model,
    // but subsequent turns still hit the old client. This test runs
    // a task with llm1 (gets one response), reconfigures to llm2,
    // runs another task, asserts llm2 received the second call (and
    // llm1 only the first).
    const { Dummy } = await import('../src/llm/dummy')
    const { evalRuntime } = await import('../src/runtime/eval')
    const llm1 = new Dummy({
      responses: [{ emissions: [{ type: 'ts', code: 'taskSuccess(1)' }] }],
    })
    const llm2 = new Dummy({
      responses: [{ emissions: [{ type: 'ts', code: 'taskSuccess(2)' }] }],
    })
    const a = await createAgent({
      name: 'swap',
      llm: llm1,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
    })
    const t = a.task<undefined, number>({ description: 'pick a number' })

    const r1 = await t(undefined)
    expect(r1).toBe(1)
    expect(llm1.callCount).toBe(1)
    expect(llm2.callCount).toBe(0)

    a.reconfigure({ llm: llm2 })

    const r2 = await t(undefined, { session: 'fresh' })
    expect(r2).toBe(2)
    // llm2 saw the second call. llm1 still at 1 (no further hits).
    expect(llm2.callCount).toBe(1)
    expect(llm1.callCount).toBe(1)
  })
})
