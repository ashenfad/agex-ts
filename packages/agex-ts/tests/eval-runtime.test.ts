import { MemoryFS } from 'termish-ts/fs/memory'
import { describe, expect, it } from 'vitest'
import { CacheImpl } from '../src/cache'
import { evalRuntime } from '../src/runtime/eval'
import { Live } from '../src/state'
import type { ExecuteContext, Policy } from '../src/types'

const emptyPolicy: Policy = {
  fns: new Map(),
  classes: new Map(),
  namespaces: new Map(),
  skills: new Map(),
  terminals: new Map(),
}

function makeContext(): ExecuteContext {
  return {
    fs: new MemoryFS(),
    cache: new CacheImpl(new Live(), 'default'),
    signal: new AbortController().signal,
  }
}

describe('evalRuntime — task control', () => {
  it('taskSuccess returns the value as outcome.success', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute('taskSuccess({ ok: true, n: 42 })', makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: { ok: true, n: 42 } })
    expect(result.error).toBeNull()
  })

  it('taskFail returns outcome.fail with the message', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute('taskFail("nope")', makeContext())
    expect(result.outcome).toEqual({ kind: 'fail', message: 'nope' })
  })

  it('taskClarify returns outcome.clarify', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute('taskClarify("which one?")', makeContext())
    expect(result.outcome).toEqual({ kind: 'clarify', message: 'which one?' })
  })

  it('falling off the end returns outcome.continue', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute('1 + 1;', makeContext())
    expect(result.outcome).toEqual({ kind: 'continue' })
  })
})

describe('evalRuntime — registered names in scope', () => {
  it('fns are callable by name', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([
        [
          'shout',
          {
            kind: 'fn' as const,
            name: 'shout',
            fn: ((...args: unknown[]) => (args[0] as string).toUpperCase()) as (
              ...args: unknown[]
            ) => unknown,
          },
        ],
      ]),
    }
    await r.init(policy)
    const result = await r.execute('taskSuccess(shout("hello"))', makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: 'HELLO' })
  })

  it('namespaces expose member methods', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([
        [
          'math',
          {
            kind: 'namespace' as const,
            name: 'math',
            target: { add: (a: number, b: number) => a + b },
          },
        ],
      ]),
    }
    await r.init(policy)
    const result = await r.execute('taskSuccess(math.add(2, 3))', makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: 5 })
  })
})

describe('evalRuntime — captured console output', () => {
  it('console.log entries land in outputs as text parts', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'console.log("hello"); console.log("world"); taskSuccess(null)',
      makeContext(),
    )
    expect(result.outputs).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ])
  })
})

describe('evalRuntime — fs / cache injection', () => {
  it('fs writes are visible to host', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await r.execute(
      'await fs.write("/note.txt", new TextEncoder().encode("from agent")); taskSuccess(null)',
      ctx,
    )
    const bytes = await ctx.fs.read('/note.txt')
    expect(new TextDecoder().decode(bytes)).toBe('from agent')
  })

  it('cache writes are visible to host', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await r.execute('await cache.set("k", { value: 1 }); taskSuccess(null)', ctx)
    expect(await ctx.cache.get('k')).toEqual({ value: 1 })
  })
})

describe('evalRuntime — error handling', () => {
  it('user errors land in result.error, outcome stays continue', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute('throw new Error("boom")', makeContext())
    expect(result.error?.message).toBe('boom')
    expect(result.outcome).toEqual({ kind: 'continue' })
  })

  it('honors timeout', async () => {
    const r = evalRuntime({ timeoutMs: 50 })
    await r.init(emptyPolicy)
    const result = await r.execute(
      'await new Promise((res) => setTimeout(res, 5000))',
      makeContext(),
    )
    expect(result.error?.name).toBe('CancelledError')
    expect(result.elapsedMs).toBeLessThan(1000)
  })

  it('init must be called before execute', async () => {
    const r = evalRuntime()
    await expect(r.execute('null', makeContext())).rejects.toThrow(/before init/)
  })
})
