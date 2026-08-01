/**
 * `paramsSchema` enforcement.
 *
 * The schema validates the agent's call args before a host-bound fn
 * runs. Enforcement lives host-side in `enforceParamsSchema` and is
 * applied at both runtimes' dispatch sites; these tests cover the
 * helper directly plus its wiring through `evalRuntime` (including the
 * helper-module path, where registered names flow into agent-authored
 * `/helpers/*.ts` via `__registered`).
 *
 * The worker runtime shares the same helper at its RPC dispatch site;
 * see `packages/agex-runtime-worker`.
 */
import { MemoryFS } from '@agex-ts/termish/fs/memory'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, it } from 'vitest'
import { CacheImpl } from '../src/cache'
import { SchemaError } from '../src/errors'
import { enforceParamsSchema } from '../src/policy'
import { evalRuntime } from '../src/runtime/eval'
import { Live } from '../src/state'
import type { ExecuteContext, Policy, RegisteredFn } from '../src/types'

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

/** Args-array validator: every arg must be a number. */
function numbersSchema(opts: { async?: boolean; double?: boolean } = {}): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => {
        const args = value as unknown[]
        const bad = args.findIndex((a) => typeof a !== 'number')
        const result =
          bad >= 0
            ? { issues: [{ message: `arg ${bad} must be a number`, path: [bad] }] }
            : { value: opts.double === true ? args.map((a) => (a as number) * 2) : args }
        return opts.async === true ? Promise.resolve(result) : result
      },
    },
  } as StandardSchemaV1
}

function fnPolicy(reg: Partial<RegisteredFn> & { fn: RegisteredFn['fn'] }): Policy {
  return {
    ...emptyPolicy,
    fns: new Map([['compute', { kind: 'fn' as const, name: 'compute', ...reg } as RegisteredFn]]),
  }
}

describe('enforceParamsSchema — helper', () => {
  const add = (...args: unknown[]): unknown => (args[0] as number) + (args[1] as number)

  it('returns the fn unchanged when no schema is registered', () => {
    expect(enforceParamsSchema(add, undefined, 'add')).toBe(add)
  })

  it('passes valid args through', () => {
    const guarded = enforceParamsSchema(add, numbersSchema(), 'add')
    expect(guarded(2, 3)).toBe(5)
  })

  it('throws SchemaError naming the fn and the offending arg', () => {
    const guarded = enforceParamsSchema(add, numbersSchema(), 'add')
    expect(() => guarded(2, 'three')).toThrow(SchemaError)
    expect(() => guarded(2, 'three')).toThrow(/fn 'add': params validation failed/)
    expect(() => guarded(2, 'three')).toThrow(/arg 1 must be a number/)
  })

  it('stays synchronous when the validator is synchronous', () => {
    // Load-bearing: the eval runtime injects bindings raw, so wrapping
    // a sync registered fn must not silently make it promise-returning.
    const guarded = enforceParamsSchema(add, numbersSchema(), 'add')
    expect(guarded(2, 3)).not.toBeInstanceOf(Promise)
  })

  it('supports async validators', async () => {
    const guarded = enforceParamsSchema(add, numbersSchema({ async: true }), 'add')
    await expect(guarded(2, 3) as Promise<unknown>).resolves.toBe(5)
  })

  it('rejects via the async path when an async validator finds issues', async () => {
    const guarded = enforceParamsSchema(add, numbersSchema({ async: true }), 'add')
    await expect(guarded(2, 'three') as Promise<unknown>).rejects.toThrow(SchemaError)
  })

  it('passes a transformed (coerced) arg array through to the fn', () => {
    const guarded = enforceParamsSchema(add, numbersSchema({ double: true }), 'add')
    expect(guarded(2, 3)).toBe(10)
  })

  it('falls back to the original args when the validator returns a non-array', () => {
    // Spreading a non-array would silently mangle the call, so the
    // original args win.
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => ({ value: { not: 'an array' } }),
      },
    } as StandardSchemaV1
    expect(enforceParamsSchema(add, schema, 'add')(2, 3)).toBe(5)
  })

  it('preserves `this` binding', () => {
    const obj = {
      factor: 3,
      scale(...args: unknown[]): number {
        return (args[0] as number) * this.factor
      },
    }
    const guarded = enforceParamsSchema(obj.scale, numbersSchema(), 'scale')
    expect(guarded.call(obj, 5)).toBe(15)
  })
})

describe('paramsSchema — evalRuntime wiring', () => {
  it('valid args reach the fn', async () => {
    const r = evalRuntime()
    await r.init(
      fnPolicy({
        fn: (...args: unknown[]) => (args[0] as number) + (args[1] as number),
        paramsSchema: numbersSchema(),
      }),
    )
    const result = await r.execute('taskSuccess(compute(2, 3))', makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: 5 })
  })

  it('invalid args surface to the agent as a runtime error, fn never runs', async () => {
    let called = false
    const r = evalRuntime()
    await r.init(
      fnPolicy({
        fn: (...args: unknown[]) => {
          called = true
          return args[0]
        },
        paramsSchema: numbersSchema(),
      }),
    )
    const result = await r.execute('taskSuccess(compute("nope"))', makeContext())
    // Docs promise this reads as an ordinary runtime error the agent
    // can adjust to — not a thrown-through host crash.
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.message).toMatch(/params validation failed/)
    expect(called).toBe(false)
  })

  it('validates args before appending ctx for wantsContext fns', async () => {
    // The schema describes the agent-facing parameter list; the host
    // ctx is appended after validation and must not trip it.
    let sawCtx = false
    const r = evalRuntime()
    await r.init(
      fnPolicy({
        fn: (...args: unknown[]) => {
          sawCtx = args.length === 2 && typeof args[1] === 'object'
          return (args[0] as number) * 2
        },
        wantsContext: true,
        paramsSchema: numbersSchema(),
      }),
    )
    const result = await r.execute('taskSuccess(compute(21))', makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: 42 })
    expect(sawCtx).toBe(true)
  })

  it('enforces the schema when a helper module calls the fn', async () => {
    // Registered names flow into agent-authored helpers via
    // `__registered` — that path has to hit the same check as the
    // agent's own code, not the raw fn.
    const ctx = makeContext()
    await ctx.fs.mkdir('/helpers', { parents: true, existOk: true })
    await ctx.fs.write(
      '/helpers/util.ts',
      new TextEncoder().encode(
        "import { compute } from 'compute'\nexport function run() { return compute('nope') }\n",
      ),
    )
    const r = evalRuntime()
    await r.init(
      fnPolicy({
        fn: (...args: unknown[]) => args[0],
        paramsSchema: numbersSchema(),
      }),
    )
    const result = await r.execute("import { run } from '/helpers/util'\ntaskSuccess(run())", ctx)
    expect(result.error?.message).toMatch(/params validation failed/)
  })

  it('leaves fns without a schema untouched', async () => {
    const r = evalRuntime()
    await r.init(fnPolicy({ fn: (...args: unknown[]) => String(args[0]) }))
    const result = await r.execute('taskSuccess(compute({ any: "thing" }))', makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: '[object Object]' })
  })
})
