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

  it('console.log of {format,data} produces an image part', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'console.log({ format: "png", data: "abc" }); taskSuccess(null)',
      makeContext(),
    )
    expect(result.outputs).toEqual([{ type: 'image', format: 'png', data: 'abc' }])
  })

  it('console.log of Uint8Array with PNG magic produces an image part', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'const bytes = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]); console.log(bytes); taskSuccess(null)',
      makeContext(),
    )
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]).toMatchObject({ type: 'image', format: 'png' })
  })

  it('mixed console.log args split into ordered parts', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute(
      'console.log("shot:", { format: "png", data: "abc" }); taskSuccess(null)',
      makeContext(),
    )
    expect(result.outputs).toEqual([
      { type: 'text', text: 'shot:' },
      { type: 'image', format: 'png', data: 'abc' },
    ])
  })
})

describe('evalRuntime — registered host fn console capture', () => {
  it('console.log inside a registered fn lands in agent outputs', async () => {
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([
        [
          'shout',
          {
            kind: 'fn',
            name: 'shout',
            fn: async (msg: unknown): Promise<string> => {
              console.log('host fn says:', msg)
              return 'ok'
            },
          },
        ],
      ]),
    }
    const r = evalRuntime()
    await r.init(policy)
    const result = await r.execute(
      'await shout("hello from agent"); taskSuccess(null)',
      makeContext(),
    )
    expect(result.outputs).toEqual([{ type: 'text', text: 'host fn says: hello from agent' }])
  })

  it('host fn console.log of image-shaped value produces an image part', async () => {
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([
        [
          'screenshot',
          {
            kind: 'fn',
            name: 'screenshot',
            fn: async (): Promise<void> => {
              console.log({ format: 'png', data: 'fakebase64' })
            },
          },
        ],
      ]),
    }
    const r = evalRuntime()
    await r.init(policy)
    const result = await r.execute('await screenshot(); taskSuccess(null)', makeContext())
    expect(result.outputs).toEqual([{ type: 'image', format: 'png', data: 'fakebase64' }])
  })
})

describe('evalRuntime — wantsContext', () => {
  it('appends ctx as trailing arg only when wantsContext: true', async () => {
    let received: unknown[] | null = null
    const captureReg = {
      kind: 'fn' as const,
      name: 'capture',
      wantsContext: true,
      fn: async (...args: unknown[]): Promise<void> => {
        received = args
      },
    }
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([['capture', captureReg]]),
    }
    const r = evalRuntime()
    await r.init(policy)
    await r.execute('await capture(1, 2); taskSuccess(null)', makeContext())
    expect(received).not.toBeNull()
    const args = received as unknown as unknown[]
    expect(args.length).toBe(3)
    expect(args[0]).toBe(1)
    expect(args[1]).toBe(2)
    expect(args[2]).toMatchObject({ console: expect.anything(), signal: expect.anything() })
  })

  it('handler without wantsContext receives only agent args', async () => {
    let received: unknown[] | null = null
    const plainReg = {
      kind: 'fn' as const,
      name: 'plain',
      fn: async (...args: unknown[]): Promise<void> => {
        received = args
      },
    }
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([['plain', plainReg]]),
    }
    const r = evalRuntime()
    await r.init(policy)
    await r.execute('await plain(1, 2); taskSuccess(null)', makeContext())
    expect(received).toEqual([1, 2])
  })

  it('ctx.console.log lands as image part for image-shaped value', async () => {
    const shootReg = {
      kind: 'fn' as const,
      name: 'shoot',
      wantsContext: true,
      fn: async (...args: unknown[]): Promise<void> => {
        const ctx = args[1] as { console: Console; signal: AbortSignal }
        ctx.console.log({ format: 'png', data: 'ctxbase64' })
      },
    }
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([['shoot', shootReg]]),
    }
    const r = evalRuntime()
    await r.init(policy)
    const result = await r.execute('await shoot(null); taskSuccess(null)', makeContext())
    expect(result.outputs).toEqual([{ type: 'image', format: 'png', data: 'ctxbase64' }])
  })

  it('ctx.signal flips when external task is cancelled mid-call', async () => {
    const ac = new AbortController()
    let observedAborted: boolean | null = null
    const waitReg = {
      kind: 'fn' as const,
      name: 'wait',
      wantsContext: true,
      fn: async (...args: unknown[]): Promise<void> => {
        const ctx = args[0] as { console: Console; signal: AbortSignal }
        expect(ctx.signal.aborted).toBe(false)
        // Trigger external abort, then yield so the linked
        // listener flips our local signal before we read it.
        ac.abort()
        await new Promise((r) => setTimeout(r, 0))
        observedAborted = ctx.signal.aborted
      },
    }
    const policy: Policy = {
      ...emptyPolicy,
      fns: new Map([['wait', waitReg]]),
    }
    const r = evalRuntime()
    await r.init(policy)
    const ctx: ExecuteContext = {
      fs: new MemoryFS(),
      cache: new CacheImpl(new Live(), 'default'),
      signal: ac.signal,
    }
    await r.execute('await wait(); taskSuccess(null)', ctx)
    expect(observedAborted).toBe(true)
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

describe('evalRuntime — fs ergonomic wrappers (Node-fs-style)', () => {
  // The agent sees `fs` through a wrapper that adds Node-fs-style
  // overloads on read / write. Bytes-form still works unchanged;
  // string-encoding overloads are the convenience that makes the
  // agent's natural `fs.read(path, 'utf8')` / `fs.write(path, str)`
  // patterns Just Work without learning agex-specific quirks.

  it('fs.read(path, "utf8") returns a string (matches Node fs.readFile)', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/data.csv', new TextEncoder().encode('a,b,c\n1,2,3\n'))
    const result = await r.execute(
      `
      const text = await fs.read('/data.csv', 'utf8')
      const lines = text.trim().split('\\n')
      taskSuccess(lines)
    `,
      ctx,
    )
    expect(result.outcome).toEqual({ kind: 'success', value: ['a,b,c', '1,2,3'] })
  })

  it('fs.read(path, "utf-8") (hyphenated alias) also works', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/x.txt', new TextEncoder().encode('hello'))
    const result = await r.execute(`taskSuccess(await fs.read('/x.txt', 'utf-8'))`, ctx)
    expect(result.outcome).toEqual({ kind: 'success', value: 'hello' })
  })

  it('fs.read(path) (no encoding) still returns Uint8Array', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/x.bin', new Uint8Array([1, 2, 3, 4]))
    const result = await r.execute(
      `
      const bytes = await fs.read('/x.bin')
      taskSuccess({ isBytes: bytes instanceof Uint8Array, length: bytes.length, first: bytes[0] })
    `,
      ctx,
    )
    expect(result.outcome).toEqual({
      kind: 'success',
      value: { isBytes: true, length: 4, first: 1 },
    })
  })

  it('fs.read with an unsupported encoding throws a clear error', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/x.txt', new TextEncoder().encode('hello'))
    const result = await r.execute(
      `
      try {
        await fs.read('/x.txt', 'base64')
        taskSuccess('unreached')
      } catch (e) {
        taskSuccess({ name: e.name, message: e.message })
      }
    `,
      ctx,
    )
    expect(result.outcome.kind).toBe('success')
    const value = (result.outcome as { kind: 'success'; value: { message: string } }).value
    expect(value.message).toMatch(/unsupported encoding 'base64'/)
    expect(value.message).toMatch(/decode manually with a TextDecoder/)
  })

  it('fs.write(path, string) encodes UTF-8 and writes bytes', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await r.execute(`await fs.write('/note.txt', 'hello world'); taskSuccess(null)`, ctx)
    const bytes = await ctx.fs.read('/note.txt')
    expect(new TextDecoder().decode(bytes)).toBe('hello world')
  })

  it('fs.write(path, Uint8Array) still writes bytes through unchanged', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await r.execute(
      `
      const bytes = new Uint8Array([72, 101, 108, 108, 111])
      await fs.write('/x.bin', bytes)
      taskSuccess(null)
    `,
      ctx,
    )
    const bytes = await ctx.fs.read('/x.bin')
    expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111])
  })

  it('fs.write append mode passes through with strings too', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/log.txt', new TextEncoder().encode('first\n'))
    await r.execute(`await fs.write('/log.txt', 'second\\n', 'a'); taskSuccess(null)`, ctx)
    const text = new TextDecoder().decode(await ctx.fs.read('/log.txt'))
    expect(text).toBe('first\nsecond\n')
  })

  it('fs.readText(path) — Deno-flavored shortcut returns string (no encoding arg)', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/x.txt', new TextEncoder().encode('hello'))
    const result = await r.execute(`taskSuccess(await fs.readText('/x.txt'))`, ctx)
    expect(result.outcome).toEqual({ kind: 'success', value: 'hello' })
  })

  it('fs.writeText(path, str) — Deno-flavored shortcut writes UTF-8', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await r.execute(`await fs.writeText('/x.txt', 'hello world'); taskSuccess(null)`, ctx)
    const text = new TextDecoder().decode(await ctx.fs.read('/x.txt'))
    expect(text).toBe('hello world')
  })

  it('fs.readFile(path, "utf8") — Node-standard alias works the same as fs.read', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/data.csv', new TextEncoder().encode('a,b\n1,2\n'))
    const result = await r.execute(
      `
      const text = await fs.readFile('/data.csv', 'utf8')
      const bytes = await fs.readFile('/data.csv')
      taskSuccess({ text, isBytes: bytes instanceof Uint8Array })
    `,
      ctx,
    )
    expect(result.outcome).toEqual({
      kind: 'success',
      value: { text: 'a,b\n1,2\n', isBytes: true },
    })
  })

  it('fs.writeFile(path, content) — Node-standard alias accepts strings and bytes', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await r.execute(
      `
      await fs.writeFile('/a.txt', 'string-form')
      await fs.writeFile('/b.bin', new Uint8Array([1, 2, 3]))
      taskSuccess(null)
    `,
      ctx,
    )
    expect(new TextDecoder().decode(await ctx.fs.read('/a.txt'))).toBe('string-form')
    expect(Array.from(await ctx.fs.read('/b.bin'))).toEqual([1, 2, 3])
  })

  it('all read aliases share the same backing implementation (no semantic drift)', async () => {
    // Sanity that aliases are not just wired but actually point at
    // the same underlying logic. If someone refactors the aliases
    // table and accidentally diverges (e.g. readFile starts
    // ignoring encoding), this test catches it.
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/x.txt', new TextEncoder().encode('shared'))
    const result = await r.execute(
      `
      const a = await fs.read('/x.txt', 'utf8')
      const b = await fs.readFile('/x.txt', 'utf8')
      const c = await fs.readText('/x.txt')
      taskSuccess({ allEqual: a === b && b === c, a })
    `,
      ctx,
    )
    expect(result.outcome).toEqual({
      kind: 'success',
      value: { allEqual: true, a: 'shared' },
    })
  })

  it('non-read/write methods still pass through (proxy delegation)', async () => {
    // The wrapper Proxy intercepts only `read` and `write`; everything
    // else (exists, mkdir, list, etc.) must delegate to the underlying
    // fs unchanged.
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.mkdir('/d')
    await ctx.fs.write('/d/a', new TextEncoder().encode('x'))
    const result = await r.execute(
      `
      const exists = await fs.exists('/d/a')
      const isDir = await fs.isDir('/d')
      const items = await fs.list('/d')
      taskSuccess({ exists, isDir, items })
    `,
      ctx,
    )
    expect(result.outcome).toEqual({
      kind: 'success',
      value: { exists: true, isDir: true, items: ['a'] },
    })
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

  it('accepts npm-style hyphenated and scoped names end-to-end', async () => {
    // Validates the rewriter handles non-identifier import specifiers
    // through the full pipeline: registration accepts the name (gated
    // by the URL-shipped name validator), the rewriter rewrites
    // `import { ... } from 'apache-arrow'` to `await __load(...)`, and
    // the named-binding destructure uses a sanitized temp variable.
    // This is the agex-studio motivating case — agents writing the
    // exact import statement they were trained on against npm names.
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([
        [
          'apache-arrow',
          {
            kind: 'namespace' as const,
            name: 'apache-arrow',
            url: FIXTURE_URL,
          },
        ],
        [
          '@scope/lib',
          {
            kind: 'namespace' as const,
            name: '@scope/lib',
            url: FIXTURE_URL,
          },
        ],
      ]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import { double } from 'apache-arrow'
      import * as scoped from '@scope/lib'
      taskSuccess([double(21), scoped.double(11)])
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: [42, 22] })
  })

  it('multiple separate imports of the same URL-shipped name do not collide (regression)', async () => {
    // Studio reported: agent code with two `import { x } from 'arquero'`
    // statements raised `SyntaxError: Identifier '__url_arquero' has
    // already been declared`. The rewriter previously emitted a temp
    // var named `__url_<name>` for each named-import — repeated for
    // the same registered name, two `const __url_<name>` lines landed
    // in the same scope. Fix: inline the await directly. The per-name
    // promise cache in __load makes the duplicate await effectively
    // free.
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([
        ['arquero', { kind: 'namespace' as const, name: 'arquero', url: FIXTURE_URL }],
      ]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import { double } from 'arquero'
      import { utils } from 'arquero'
      taskSuccess([double(7), utils.greet('world')])
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({ kind: 'success', value: [14, 'hello world'] })
  })

  it('mixed default + named imports of the same URL-shipped name do not collide', async () => {
    // Same regression class for the `mixed` emit path. The default-
    // export fixture has `marker: 'default-payload'`. Two imports of
    // the same name where one mixes default + named would have
    // collided on the same `__url_<name>` temp.
    const r = evalRuntime()
    const policy: Policy = {
      ...emptyPolicy,
      namespaces: new Map([
        [
          'fixture',
          {
            kind: 'namespace' as const,
            name: 'fixture',
            url: FIXTURE_URL,
            export: 'default',
          },
        ],
      ]),
    }
    await r.init(policy)
    const result = await r.execute(
      `
      import * as a from 'fixture'
      import * as b from 'fixture'
      taskSuccess([a.marker, b.marker, a === b])
    `,
      makeContext(),
    )
    expect(result.outcome).toEqual({
      kind: 'success',
      value: ['default-payload', 'default-payload', true],
    })
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

describe('evalRuntime — missing-await detection', () => {
  // Reported by the studio integration: an agent declared an async
  // function and called it bare at the top level, producing a
  // "no observation" turn that left the agent confused. The fix:
  // instrument task terminators to record their last call in a
  // per-execute slot before throwing. After the AsyncFunction body
  // settles cleanly, give pending async work a few microtask ticks
  // to drain — if a terminator fires from that path, surface it as a
  // wrapped `MissingAwaitError` with a clear hint to add `await`.

  it('catches taskSuccess from a non-awaited async function', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    // Studio-reported shape: declare async, call without await.
    const code = `
      async function generateReport() {
        await Promise.resolve()
        taskSuccess({ items: 3 })
      }
      generateReport()
    `
    const result = await r.execute(code, makeContext())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error).not.toBeNull()
    expect(result.error?.name).toBe('MissingAwaitError')
    expect(result.error?.message).toMatch(/taskSuccess\(\)/)
    expect(result.error?.message).toMatch(/Add \`await\`/)
  })

  it('catches taskFail from a non-awaited async function', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const code = `
      async function check() {
        await Promise.resolve()
        taskFail('nope')
      }
      check()
    `
    const result = await r.execute(code, makeContext())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.name).toBe('MissingAwaitError')
    expect(result.error?.message).toMatch(/taskFail\(\)/)
  })

  it('catches taskClarify from a non-awaited async function', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const code = `
      async function ask() {
        await Promise.resolve()
        taskClarify('which one?')
      }
      ask()
    `
    const result = await r.execute(code, makeContext())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.name).toBe('MissingAwaitError')
    expect(result.error?.message).toMatch(/taskClarify\(\)/)
  })

  it('regression: properly awaited terminators still settle the action correctly', async () => {
    // Guard rail: the late-detection path must NOT fire when the
    // agent does the right thing. The terminator throws synchronously
    // out of the awaited call → caught by the outer try → outcome is
    // set normally. No drain, no MissingAwaitError.
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const code = `
      async function generateReport() {
        await Promise.resolve()
        taskSuccess({ items: 3 })
      }
      await generateReport()
    `
    const result = await r.execute(code, makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: { items: 3 } })
    expect(result.error).toBeNull()
  })

  it('regression: regular "do-nothing" continue (no terminator) does not fire detection', async () => {
    // A continue outcome with no terminator call at all is the
    // legitimate "let the agent see results next turn" path. The
    // late-detection should not flag it.
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const code = `
      const x = 1 + 2
      void x
    `
    const result = await r.execute(code, makeContext())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error).toBeNull()
  })

  it('regression: synchronous taskSuccess still works (no false positive)', async () => {
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const result = await r.execute('taskSuccess(42)', makeContext())
    expect(result.outcome).toEqual({ kind: 'success', value: 42 })
    expect(result.error).toBeNull()
  })

  it('catches the studio repro shape with fs.read in the async function', async () => {
    // Minimal version of the studio agent's actual code: the
    // function does a real `await fs.read(...)` (against MemoryFS)
    // before calling taskSuccess. The terminator fires several
    // microtasks after the body has returned; the drain catches it.
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    await ctx.fs.write('/data.txt', new TextEncoder().encode('hello'))
    const code = `
      async function generateReport() {
        const bytes = await fs.read('/data.txt')
        const text = new TextDecoder().decode(bytes)
        taskSuccess({ length: text.length })
      }
      generateReport()
    `
    const result = await r.execute(code, ctx)
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.name).toBe('MissingAwaitError')
  })

  it('top-level return still flips bodySettled (try/finally wrap)', async () => {
    // Regression: a top-level `return` would skip an appended
    // `__agexBodyDone()` statement, leaving bodySettled false. A late
    // terminator from a non-awaited async path would then re-throw
    // (because !bodySettled) instead of being recorded as a
    // MissingAwaitError. The try/finally wrap around the body fixes
    // this — the finally clause runs through every exit path.
    const r = evalRuntime()
    await r.init(emptyPolicy)
    const ctx = makeContext()
    const code = `
      async function delayed() {
        await Promise.resolve()
        taskSuccess('late')
      }
      delayed()
      return
    `
    const result = await r.execute(code, ctx)
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.name).toBe('MissingAwaitError')
  })
})
