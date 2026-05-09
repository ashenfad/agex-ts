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

describe('evalRuntime — `inputs` binding', () => {
  it('binds `inputs` from ctx into the agent scope', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx: ExecuteContext = {
      ...makeContext(),
      inputs: { name: 'foo', value: 21 },
    }
    const result = await r.execute(
      'taskSuccess({ name: inputs.name, doubled: inputs.value * 2 })',
      ctx,
    )
    expect(result.outcome).toEqual({ kind: 'success', value: { name: 'foo', doubled: 42 } })
  })

  it('binds `inputs` to undefined (not unbound) when ctx has no inputs', async () => {
    // Regression: `const value = inputs` must not throw a
    // ReferenceError just because the task takes no inputs. The
    // binding is always present; its value may be undefined.
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'const value = inputs; taskSuccess({ wasUndef: value === undefined })',
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: { wasUndef: true } })
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

describe('evalRuntime — TypeScript syntax (ts-blank-space)', () => {
  it('strips parameter type annotations', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'function add(a: number, b: number): number { return a + b }; taskSuccess(add(2, 3))',
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 5 })
  })

  it('strips variable declaration types and arrow function types', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'const xs: number[] = [1, 2, 3]; const sum = (a: number, b: number): number => a + b; taskSuccess(xs.reduce(sum, 0))',
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 6 })
  })

  it('strips interface and type alias declarations', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      `
      interface Point { x: number; y: number }
      type Pair = [number, number]
      const p: Point = { x: 1, y: 2 }
      const pair: Pair = [3, 4]
      taskSuccess({ p, pair })
      `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: { p: { x: 1, y: 2 }, pair: [3, 4] } })
  })

  it('strips generic type parameters and `as` casts', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      `
      function first<T>(xs: T[]): T | undefined { return xs[0] }
      const v = first<number>([10, 20, 30])
      const s = '42' as unknown as string
      taskSuccess({ v, s })
      `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: { v: 10, s: '42' } })
  })

  it('throws a clear error for non-erasable TS (enum)', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'enum Color { Red, Green } taskSuccess(Color.Red)',
      makeContext(),
    )
    // ts-blank-space refuses non-erasable TS; the agent sees the error
    // and can rewrite using `as const` or modules.
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error).not.toBeNull()
  })
})

describe('evalRuntime — URL-shipped registrations (lazy)', () => {
  // Plain JS fixture so Node's native dynamic `import()` can load
  // it without a TS loader. Vitest's Node mode doesn't transform
  // dynamic imports — they pass through to the runtime.
  const FIXTURE_URL = new URL('./fixtures/url-runtime-fixture.js', import.meta.url).href

  // URL-shipped registrations are lazy: `init()` records specs but
  // does NOT import. The dynamic `import()` fires on the agent's
  // first `import { ... } from 'name'`, which the rewriter expands
  // to `await __load('name')`. URL-shipped names are NOT injected as
  // top-level scope bindings — the agent must use an import statement
  // to reach them.

  it('imports a class from a URL — agent uses `import` to reach it', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      classes: new Map([['Vec', { kind: 'cls' as const, name: 'Vec', url: FIXTURE_URL }]]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import { Vec } from 'Vec'
      taskSuccess([new Vec(3, 4).magnitude(), new Vec(1, 2) instanceof Vec])
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: [5, true] })
  })

  it('imports a fn from a URL', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([['double', { kind: 'fn' as const, name: 'double', url: FIXTURE_URL }]]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import { double } from 'double'
      taskSuccess(double(21))
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 42 })
  })

  it('imports a namespace from a URL — whole module by default', async () => {
    // No `export` on a namespace spec means "expose the whole
    // module namespace object" — different from fn / cls which
    // pluck by registration name.
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([['lib', { kind: 'namespace' as const, name: 'lib', url: FIXTURE_URL }]]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import * as lib from 'lib'
      taskSuccess([lib.double(21), lib.utils.greet("world")])
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: [42, 'hello world'] })
  })

  it('imports a namespace from a URL — explicit export plucks the named field', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([
        ['utils', { kind: 'namespace' as const, name: 'utils', url: FIXTURE_URL, export: 'utils' }],
      ]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import * as utils from 'utils'
      taskSuccess(utils.greet("world"))
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 'hello world' })
  })

  it("supports export: 'default' for default-exported modules", async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([
        [
          'fixture',
          { kind: 'namespace' as const, name: 'fixture', url: FIXTURE_URL, export: 'default' },
        ],
      ]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import * as fixture from 'fixture'
      taskSuccess(fixture.marker)
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 'default-payload' })
  })

  it('init() does NOT import — bad URL only surfaces on first agent import (wrapped ImportError)', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      classes: new Map([
        [
          'Missing',
          { kind: 'cls' as const, name: 'Missing', url: FIXTURE_URL, export: 'NotThere' },
        ],
      ]),
    }
    // init() succeeds — no eager import.
    await r.init(policy)
    // First agent reference triggers the import; the missing export
    // surfaces as a wrapped ImportError on `result.error`, with the
    // outcome staying in 'continue' so the agent loop can route it
    // through the recoverable-errors path.
    const result = await r.execute(
      `
      import { Missing } from 'Missing'
      taskSuccess(new Missing())
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.name).toBe('ImportError')
    expect(result.error?.message).toMatch(/Could not load registered module 'Missing'/)
    expect(result.error?.message).toMatch(/no 'NotThere' export/)
  })

  it('caches per-name — second import in the same execute is the same module instance', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([['lib', { kind: 'namespace' as const, name: 'lib', url: FIXTURE_URL }]]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import * as a from 'lib'
      import * as b from 'lib'
      taskSuccess(a === b)
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: true })
  })

  it('caches per-name — second execute() reuses the first execute()s loaded module', async () => {
    // Per-runtime-instance cache survives across executes. Two
    // executes that both import 'lib' both observe the same value;
    // a fresh runtime would re-import.
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([['lib', { kind: 'namespace' as const, name: 'lib', url: FIXTURE_URL }]]),
    }
    await r.init(policy)
    const r1 = await r.execute(
      `import * as lib from 'lib'\ntaskSuccess(lib.double(5))`,
      makeContext(),
    )
    const r2 = await r.execute(
      `import * as lib from 'lib'\ntaskSuccess(lib.double(5))`,
      makeContext(),
    )
    expect(r1.outcome).toEqual({ kind: 'success', value: 10 })
    expect(r2.outcome).toEqual({ kind: 'success', value: 10 })
  })

  it('supports subclassing a URL-shipped class (full JS semantics)', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      classes: new Map([['Vec', { kind: 'cls' as const, name: 'Vec', url: FIXTURE_URL }]]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import { Vec } from 'Vec'
      class V3 extends Vec {
        constructor(x, y, z) { super(x, y); this.z = z }
        magnitude() {
          return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
        }
      }
      const v = new V3(2, 3, 6)
      taskSuccess([v.magnitude(), v instanceof V3, v instanceof Vec])
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: [7, true, true] })
  })

  it('lazy load works inside a helper module too', async () => {
    // Helpers receive `__load` as a 4th parameter so the same
    // rewrite shape applies in helper context. Verifies the wiring
    // through prepareScript's helper-body construction.
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([['lib', { kind: 'namespace' as const, name: 'lib', url: FIXTURE_URL }]]),
    }
    await r.init(policy)
    const ctx = makeContext()
    const enc = new TextEncoder()
    await ctx.fs.mkdir('/helpers')
    await ctx.fs.write(
      '/helpers/use-lib.ts',
      enc.encode(
        `import * as lib from 'lib'
       export function tripled(x) { return lib.double(x) + x }
      `,
      ),
    )
    const result = await r.execute(
      `
      import { tripled } from '/helpers/use-lib'
      taskSuccess(tripled(7))
    `,
      ctx,
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 21 })
  })
})

describe('evalRuntime — import syntax for registered names', () => {
  // Mirrors the workerRuntime block of the same name. The same code
  // path runs in evalRuntime via prepareScript(..., registeredValues);
  // these tests guard against same-realm vs wire drift.

  it("accepts `import * as X from 'name'` for a registered namespace", async () => {
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
    const result = await r.execute(
      `
      import * as math from 'math'
      taskSuccess(math.add(2, 3))
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 5 })
  })

  it("accepts `import { method } from 'name'` and pulls the namespace member", async () => {
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
    const result = await r.execute(
      `
      import { add } from 'math'
      taskSuccess(add(7, 8))
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 15 })
  })

  it("`import { Vec } from 'Vec'` (self-named) elides — Vec already in scope", async () => {
    class Vec {
      constructor(
        public x: number,
        public y: number,
      ) {}
      magnitude() {
        return Math.sqrt(this.x * this.x + this.y * this.y)
      }
    }
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      classes: new Map([
        [
          'Vec',
          {
            kind: 'cls' as const,
            name: 'Vec',
            cls: Vec as unknown as new (...args: unknown[]) => unknown,
          },
        ],
      ]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import { Vec } from 'Vec'
      taskSuccess(new Vec(3, 4).magnitude())
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 5 })
  })

  it('helpers can also import registered names via __registered injection', async () => {
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([
        [
          'triple',
          {
            kind: 'fn' as const,
            name: 'triple',
            fn: ((...args: unknown[]) => (args[0] as number) * 3) as (
              ...args: unknown[]
            ) => unknown,
          },
        ],
      ]),
    }
    await r.init(policy)
    const ctx = makeContext()
    await ctx.fs.mkdir('/helpers', { parents: true, existOk: true })
    await ctx.fs.write(
      '/helpers/calc.ts',
      new TextEncoder().encode(`
        import { triple } from 'triple'
        export function tripleAndAddOne(value: number): number {
          return triple(value) + 1
        }
      `),
    )
    const result = await r.execute(
      `
      import { tripleAndAddOne } from '/helpers/calc'
      taskSuccess(tripleAndAddOne(7))
    `,
      ctx,
    )
    expect(result.outcome).toEqual({ kind: 'success', value: 22 })
  })

  it('passes through (and breaks) imports of unregistered specifiers', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      `
      import * as react from 'react'
      taskSuccess(react)
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.message).toMatch(/import statement/)
  })
})
