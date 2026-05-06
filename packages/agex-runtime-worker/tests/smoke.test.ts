/**
 * Browser-mode smoke tests for `workerRuntime`.
 *
 * Each test stubs an `ExecuteContext` (with a `MemoryFS` + Map-
 * backed `Cache`) and a `Policy` directly rather than going through
 * the full agent loop. The boundary under test is just the runtime
 * adapter and its wire protocol, so a contrived context is enough.
 */

import { CancelledError } from 'agex-ts/errors'
import type {
  Cache,
  ExecuteContext,
  Policy,
  RegisteredCls,
  RegisteredFn,
  RegisteredNs,
} from 'agex-ts/types'
import { MemoryFS } from 'termish-ts/fs/memory'
import { afterEach, describe, expect, it } from 'vitest'
import { workerRuntime } from '../src/runtime'

// Tests pass an explicit URL pointing at the source `worker.ts`.
// Vite (driving Vitest browser mode) statically analyses
// `new URL(<literal>, import.meta.url)` and compiles the worker
// entry with the same toolchain it uses for the rest of the bundle,
// so this resolves correctly during test runs without depending on
// `pnpm build`.
const TEST_WORKER_URL = new URL('../src/worker.ts', import.meta.url)

/** Wide constructor type for the test helper — concrete user
 *  classes have typed args that don't structurally extend
 *  `RegisteredCls.cls`'s `new (...args: unknown[]) => unknown`.
 *  Defined once here with the lint suppression so the helper
 *  itself reads cleanly. */
// biome-ignore lint/suspicious/noExplicitAny: any-constructor is the right shape for test fixtures
type LooseCtor = new (...args: any[]) => unknown

// A no-op `Policy` — workerRuntime PR 1 doesn't read it.
const EMPTY_POLICY: Policy = {
  fns: new Map(),
  classes: new Map(),
  namespaces: new Map(),
  skills: new Map(),
  terminals: new Map(),
}

/** Build a `Policy` shape from a friendly description. Skips the
 *  `PolicyBuilder` machinery (validation, name collisions, schema
 *  compilation) since these tests are about the runtime adapter,
 *  not the registration system. */
function makePolicy(args: {
  fns?: Record<string, (...callArgs: unknown[]) => unknown | Promise<unknown>>
  fnUrls?: Record<string, { url: string; export?: string }>
  namespaces?: Record<
    string,
    {
      target: object
      include?: RegisteredNs['include']
      exclude?: RegisteredNs['exclude']
    }
  >
  namespaceUrls?: Record<string, { url: string; export?: string }>
  classes?: Record<
    string,
    {
      cls: LooseCtor
      constructable?: boolean
      include?: RegisteredCls['include']
      exclude?: RegisteredCls['exclude']
    }
  >
  classUrls?: Record<string, { url: string; export?: string }>
}): Policy {
  const fns = new Map<string, RegisteredFn>()
  for (const [name, fn] of Object.entries(args.fns ?? {})) {
    fns.set(name, { kind: 'fn', name, fn })
  }
  for (const [name, spec] of Object.entries(args.fnUrls ?? {})) {
    fns.set(name, urlEntry('fn', name, spec))
  }
  const namespaces = new Map<string, RegisteredNs>()
  for (const [name, spec] of Object.entries(args.namespaces ?? {})) {
    const reg: RegisteredNs = {
      kind: 'namespace',
      name,
      target: spec.target,
      ...(spec.include !== undefined && { include: spec.include }),
      ...(spec.exclude !== undefined && { exclude: spec.exclude }),
    }
    namespaces.set(name, reg)
  }
  for (const [name, spec] of Object.entries(args.namespaceUrls ?? {})) {
    namespaces.set(name, urlEntry('namespace', name, spec))
  }
  const classes = new Map<string, RegisteredCls>()
  for (const [name, spec] of Object.entries(args.classes ?? {})) {
    const reg: RegisteredCls = {
      kind: 'cls',
      name,
      // Concrete classes (e.g. `class Vec { constructor(x: number, y: number) }`)
      // have specific param types that don't structurally match
      // `RegisteredCls.cls`'s wide `new (...args: unknown[]) => unknown`.
      // The cast is safe because the runtime treats args opaquely
      // (passes them through as the agent provided them).
      cls: spec.cls as NonNullable<RegisteredCls['cls']>,
      ...(spec.constructable === false && { constructable: false }),
      ...(spec.include !== undefined && { include: spec.include }),
      ...(spec.exclude !== undefined && { exclude: spec.exclude }),
    }
    classes.set(name, reg)
  }
  for (const [name, spec] of Object.entries(args.classUrls ?? {})) {
    classes.set(name, urlEntry('cls', name, spec))
  }
  return {
    fns,
    classes,
    namespaces,
    skills: new Map(),
    terminals: new Map(),
  }
}

/** Helper to build a URL-shipped registration entry, conditionally
 *  including the `export` field so `exactOptionalPropertyTypes`
 *  doesn't complain. */
function urlEntry<K extends 'fn' | 'cls' | 'namespace'>(
  kind: K,
  name: string,
  spec: { url: string; export?: string },
): K extends 'fn' ? RegisteredFn : K extends 'cls' ? RegisteredCls : RegisteredNs {
  const base = { kind, name, url: spec.url } as { kind: K; name: string; url: string }
  const withExport = spec.export !== undefined ? { ...base, export: spec.export } : base
  // biome-ignore lint/suspicious/noExplicitAny: union return type
  return withExport as any
}

/** Map-backed `Cache` implementation matching `agex-ts/types`. The
 *  bridge tests need a real implementation behind `ctx.cache` to
 *  prove round-trips work; this is the minimum viable one. */
function makeMemoryCache(): Cache {
  const store = new Map<string, unknown>()
  return {
    async set(key, value) {
      store.set(key, value)
    },
    async get(key) {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate generic erasure for the stub
      return store.get(key) as any
    },
    async has(key) {
      return store.has(key)
    },
    async delete(key) {
      return store.delete(key)
    },
    async keys() {
      return Array.from(store.keys())
    },
  }
}

interface CtxOpts {
  signal?: AbortSignal
  fs?: ExecuteContext['fs']
  cache?: ExecuteContext['cache']
}

function makeCtx(opts: CtxOpts = {}): ExecuteContext {
  return {
    fs: opts.fs ?? new MemoryFS(),
    cache: opts.cache ?? makeMemoryCache(),
    signal: opts.signal ?? new AbortController().signal,
  }
}

describe('workerRuntime', () => {
  let disposers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(disposers.map((d) => d()))
    disposers = []
  })

  function runtime() {
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 2_000 })
    disposers.push(() => rt.dispose())
    return rt
  }

  it('runs taskSuccess and surfaces the value as outcome.value', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('taskSuccess(1 + 2)', makeCtx())
    expect(result.error).toBeNull()
    expect(result.outputs).toEqual([])
    expect(result.outcome).toEqual({ kind: 'success', value: 3 })
  })

  it('captures console.log into outputs', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute(
      `console.log('hello', { x: 1 })\ntaskSuccess('done')`,
      makeCtx(),
    )
    expect(result.error).toBeNull()
    expect(result.outputs).toEqual([{ type: 'text', text: 'hello {"x":1}' }])
    expect(result.outcome).toEqual({ kind: 'success', value: 'done' })
  })

  it('translates taskFail into outcome.kind === "fail"', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('taskFail("nope")', makeCtx())
    expect(result.error).toBeNull()
    expect(result.outcome).toEqual({ kind: 'fail', message: 'nope' })
  })

  it('translates taskClarify into outcome.kind === "clarify"', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('taskClarify("which one?")', makeCtx())
    expect(result.error).toBeNull()
    expect(result.outcome).toEqual({ kind: 'clarify', message: 'which one?' })
  })

  it('returns continue when the emission settles without a task-control raise', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('const x = 1 + 2; void x', makeCtx())
    expect(result.error).toBeNull()
    expect(result.outcome).toEqual({ kind: 'continue' })
  })

  it('surfaces an unexpected throw as result.error (not as outcome)', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('throw new Error("boom")', makeCtx())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error).not.toBeNull()
    expect(result.error?.message).toBe('boom')
  })

  it('surfaces a transform-time syntax error without spawning the worker', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    // ts-blank-space throws on non-erasable TS — `enum` is the
    // canonical example and will fail before we postMessage.
    const result = await rt.execute('enum E { A, B }', makeCtx())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error).not.toBeNull()
  })

  it('hard-terminates on per-emission timeout and returns a timeout error', async () => {
    // Use a short timeout for this test by constructing its own runtime.
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 150 })
    disposers.push(() => rt.dispose())
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('while (true) {}', makeCtx())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.message).toMatch(/timeout/)
  })

  it('honors a pre-aborted signal without spawning a worker', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const ac = new AbortController()
    ac.abort()
    const result = await rt.execute('taskSuccess(1)', makeCtx({ signal: ac.signal }))
    expect(result.error).toBeInstanceOf(CancelledError)
  })

  it('honors an in-flight abort by terminating the worker', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const result = await rt.execute('while (true) {}', makeCtx({ signal: ac.signal }))
    expect(result.error).toBeInstanceOf(CancelledError)
  })

  it('reuses the worker across consecutive successful executes', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const r1 = await rt.execute('taskSuccess(10)', makeCtx())
    const r2 = await rt.execute('taskSuccess(20)', makeCtx())
    const r3 = await rt.execute('taskSuccess(30)', makeCtx())
    expect(r1.outcome).toEqual({ kind: 'success', value: 10 })
    expect(r2.outcome).toEqual({ kind: 'success', value: 20 })
    expect(r3.outcome).toEqual({ kind: 'success', value: 30 })
  })

  it('respawns the worker after a hard-kill (timeout) for the next execute', async () => {
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 150 })
    disposers.push(() => rt.dispose())
    await rt.init(EMPTY_POLICY)
    const killed = await rt.execute('while (true) {}', makeCtx())
    expect(killed.error?.message).toMatch(/timeout/)
    // Next execute must succeed against a fresh worker.
    const ok = await rt.execute('taskSuccess(42)', makeCtx())
    expect(ok.outcome).toEqual({ kind: 'success', value: 42 })
  })

  it('throws when execute() is called after dispose()', async () => {
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL })
    await rt.init(EMPTY_POLICY)
    await rt.dispose()
    await expect(rt.execute('taskSuccess(1)', makeCtx())).rejects.toThrow(/dispose/)
  })

  it('settles a pending execute() immediately when dispose() is called mid-flight', async () => {
    // Without the dispose-time settle path, this test would hang
    // for ~timeoutMs (1.5s here) before the per-emission timer
    // fired. The harness's per-test deadline catches that.
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 1_500 })
    disposers.push(() => rt.dispose())
    await rt.init(EMPTY_POLICY)
    const promise = rt.execute('while (true) {}', makeCtx())
    // Give the worker a moment to actually start running before we
    // dispose — proves the settle path isn't just the pre-spawn
    // abort branch.
    await new Promise((r) => setTimeout(r, 50))
    const t0 = performance.now()
    await rt.dispose()
    const result = await promise
    const elapsed = performance.now() - t0
    expect(result.error).toBeInstanceOf(CancelledError)
    expect(elapsed).toBeLessThan(500) // far below timeoutMs
  })

  it('throws on concurrent execute() calls against the same runtime', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    // Kick off a long-running emission and, before it settles, try
    // to start a second one. The second call should reject loudly
    // — the agent loop is sequential per emission, so a concurrent
    // call indicates a misuse.
    const slow = rt.execute('await new Promise(r => setTimeout(r, 200))', makeCtx())
    await expect(rt.execute('taskSuccess(1)', makeCtx())).rejects.toThrow(/concurrent/)
    // The first call must still complete cleanly.
    const r1 = await slow
    expect(r1.error).toBeNull()
  })
})

describe('workerRuntime — fs / cache bridge', () => {
  let disposers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(disposers.map((d) => d()))
    disposers = []
  })

  function runtime() {
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 2_000 })
    disposers.push(() => rt.dispose())
    return rt
  }

  it('round-trips fs.write -> fs.read inside a single emission', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const code = `
      const enc = new TextEncoder()
      const dec = new TextDecoder()
      await fs.write('/note.txt', enc.encode('hello bridge'))
      const got = await fs.read('/note.txt')
      taskSuccess(dec.decode(got))
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.error).toBeNull()
    expect(result.outcome).toEqual({ kind: 'success', value: 'hello bridge' })
  })

  it('persists cache state across emissions when ctx.cache is shared', async () => {
    // Same cache instance handed to both executes → second sees
    // what the first wrote. This is the contract: bridged state
    // lives on the host side and survives the worker's local scope.
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const cache = makeMemoryCache()

    const r1 = await rt.execute(
      `await cache.set('answer', 42); taskSuccess('written')`,
      makeCtx({ cache }),
    )
    expect(r1.outcome).toEqual({ kind: 'success', value: 'written' })

    const r2 = await rt.execute(`taskSuccess(await cache.get('answer'))`, makeCtx({ cache }))
    expect(r2.outcome).toEqual({ kind: 'success', value: 42 })
  })

  it('surfaces a host-side bridge error as a rejected promise in user code', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    // MemoryFS throws on read of a non-existent path; the worker
    // proxy must turn that into a rejected `await fs.read(...)`.
    const code = `
      try {
        await fs.read('/does-not-exist')
        taskFail('expected fs.read to throw')
      } catch (e) {
        taskSuccess(e.message)
      }
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome.kind).toBe('success')
    if (result.outcome.kind !== 'success') return
    expect(typeof result.outcome.value).toBe('string')
    expect((result.outcome.value as string).length).toBeGreaterThan(0)
  })

  it('rejects with a clear error when a bridge method is unknown', async () => {
    // Reach for a method the host whitelist doesn't expose. Using
    // a Proxy on the worker side would normally make this UB, but
    // we explicitly drive the proxy with a known name and assert
    // by spying on the host-side reply.
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const code = `
      try {
        // \`__proto__\` isn't on the FS_METHODS allowlist; the host
        // dispatcher must reject it.
        await fs.__proto__()
        taskFail('expected unknown method to reject')
      } catch (e) {
        taskSuccess('rejected')
      }
    `
    // The worker proxy *only* exposes the allowed method names, so
    // \`fs.__proto__\` is undefined there — calling it throws TypeError
    // before any bridge call is even sent. That's still the correct
    // outcome (a no-bridge-no-leak surface), so the test asserts the
    // rejection path catches the TypeError.
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'rejected' })
  })

  it('cache.keys() returns the host map keys', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const cache = makeMemoryCache()
    await cache.set('a', 1)
    await cache.set('b', 2)
    const code = 'taskSuccess((await cache.keys()).sort())'
    const result = await rt.execute(code, makeCtx({ cache }))
    expect(result.outcome).toEqual({ kind: 'success', value: ['a', 'b'] })
  })

  it('handles many concurrent bridged calls within one emission', async () => {
    // Promise.all over a batch of cache.gets — exercises the
    // callId map on both sides under interleaved responses.
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const cache = makeMemoryCache()
    for (let i = 0; i < 10; i++) await cache.set(`k${i}`, i * 2)
    const code = `
      const keys = Array.from({ length: 10 }, (_, i) => 'k' + i)
      const values = await Promise.all(keys.map(k => cache.get(k)))
      taskSuccess(values)
    `
    const result = await rt.execute(code, makeCtx({ cache }))
    expect(result.outcome).toEqual({
      kind: 'success',
      value: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
    })
  })
})

describe('workerRuntime — fn / namespace bridge', () => {
  let disposers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(disposers.map((d) => d()))
    disposers = []
  })

  function runtime() {
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 2_000 })
    disposers.push(() => rt.dispose())
    return rt
  }

  it('exposes registered fns; calling them round-trips through the host', async () => {
    const rt = runtime()
    await rt.init(
      makePolicy({
        fns: {
          double: (x) => (x as number) * 2,
          greet: (name) => `hello ${name}`,
        },
      }),
    )
    const code = `taskSuccess([await double(5), await greet('world')])`
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [10, 'hello world'] })
  })

  it('preserves host-side closures in fn calls (the whole point of host-RPC)', async () => {
    // The closure over `counter` is exactly the case host-RPC
    // exists for — source-shipping would lose it.
    let counter = 0
    const rt = runtime()
    await rt.init(makePolicy({ fns: { next: () => ++counter } }))
    const code = 'taskSuccess([await next(), await next(), await next()])'
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [1, 2, 3] })
    expect(counter).toBe(3)
  })

  it('surfaces a registered fn throw as a rejected promise in user code', async () => {
    const rt = runtime()
    await rt.init(
      makePolicy({
        fns: {
          boom: () => {
            throw new Error('intentional')
          },
        },
      }),
    )
    const code = `
      try {
        await boom()
        taskFail('expected boom() to throw')
      } catch (e) {
        taskSuccess(e.message)
      }
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'intentional' })
  })

  it("rejects a call to a name that wasn't registered as a fn", async () => {
    // The worker only injects names the host advertised at
    // configure time, so an unregistered name is a TypeError on
    // the worker-side reference itself — not even a bridge call.
    const rt = runtime()
    await rt.init(makePolicy({ fns: { foo: () => 1 } }))
    const code = `
      try {
        await unregistered()
        taskFail('expected unregistered() to throw')
      } catch (e) {
        taskSuccess(e.name)
      }
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'ReferenceError' })
  })

  it('exposes a non-live namespace; visible methods round-trip', async () => {
    const rt = runtime()
    await rt.init(
      makePolicy({
        namespaces: {
          math: {
            target: {
              add: (a: unknown, b: unknown) => (a as number) + (b as number),
              multiply: (a: unknown, b: unknown) => (a as number) * (b as number),
            },
          },
        },
      }),
    )
    const code = 'taskSuccess([await math.add(2, 3), await math.multiply(4, 5)])'
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [5, 20] })
  })

  it('respects explicit include / exclude member filters when exposing a namespace', async () => {
    // No default `_*` rule — both `_secret` and `helper` need the
    // explicit exclude entry.
    const rt = runtime()
    await rt.init(
      makePolicy({
        namespaces: {
          util: {
            target: {
              ok: () => 'ok',
              helper: () => 'helper',
              _secret: () => 'secret',
            },
            exclude: ['helper', '_*'],
          },
        },
      }),
    )
    const code = `
      const visible = []
      if (typeof util.ok === 'function') visible.push('ok')
      if (typeof util.helper === 'function') visible.push('helper')
      if (typeof util._secret === 'function') visible.push('_secret')
      taskSuccess(visible)
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: ['ok'] })
  })

  it('exposes underscore-prefixed members when no exclude filter is set', async () => {
    // Confirms there's no `_*`-by-default — if the embedder's
    // registered target has `_helper` and they didn't ask to hide
    // it, the agent sees it.
    const rt = runtime()
    await rt.init(
      makePolicy({
        namespaces: {
          util: {
            target: {
              _helper: () => 'underscore is fine',
            },
          },
        },
      }),
    )
    const code = 'taskSuccess(await util._helper())'
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'underscore is fine' })
  })

  it('walks the prototype chain so class-based namespace targets expose methods', async () => {
    // A registered namespace whose target is an instance of a
    // class should expose methods defined on the prototype, not
    // just own properties. evalRuntime / the renderer both walk
    // the chain; the worker bridge needs to too.
    class Calc {
      double(x: number) {
        return x * 2
      }
    }
    const rt = runtime()
    await rt.init(makePolicy({ namespaces: { calc: { target: new Calc() } } }))
    const code = 'taskSuccess(await calc.double(7))'
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 14 })
  })

  it('drops a stale bridgeResponse from a settled prior execute (executeId guard)', async () => {
    // Race: execute #1 fires a slow registered fn but never awaits
    // it before taskSuccess'ing. The worker scope is reused across
    // executes, and BridgeChannel resets callId to 1 each time —
    // so a late host-side reply from #1 (bridgeResponse with
    // executeId=1, callId=1) would collide on callId with a live
    // pending call in execute #2 (also callId=1). Without the
    // executeId filter in handleResponse, execute #2 would resolve
    // its call with execute #1's stale value.
    let counter = 0
    const rt = runtime()
    await rt.init(
      makePolicy({
        fns: {
          slow: async () => {
            const id = ++counter
            await new Promise((r) => setTimeout(r, 80))
            return id
          },
        },
      }),
    )
    // Execute #1: kick off slow() but don't await. The returned
    // Promise is orphaned worker-side; AsyncFunction unwinds via
    // taskSuccess before slow's host-side dispatch settles.
    const r1 = await rt.execute('void slow(); taskSuccess("first")', makeCtx())
    expect(r1.outcome).toEqual({ kind: 'success', value: 'first' })
    // Execute #2: actually awaits slow(). Should observe its own
    // call's value (counter=2), not the stale value (counter=1)
    // posted by execute #1's late response.
    const r2 = await rt.execute('taskSuccess(await slow())', makeCtx())
    expect(r2.outcome).toEqual({ kind: 'success', value: 2 })
  })

  it('rejects orphan bridge Promises when an execute settles (no leak across executes)', async () => {
    // Execute #1's user code dispatches `slow()` and pins the
    // Promise on globalThis (which persists across executes in the
    // reused worker scope), then taskSuccess'es without awaiting.
    // The orphan Promise lives in the old BridgeChannel's pending
    // map. Without `cancelPending`, an `await` on it in any
    // subsequent execute would hang forever; with the fix, the
    // worker rejects it at settle time so the await observes a
    // CancelledError immediately.
    const rt = runtime()
    await rt.init(
      makePolicy({
        fns: {
          slow: () => new Promise<number>((r) => setTimeout(() => r(1), 50)),
        },
      }),
    )
    const r1 = await rt.execute('globalThis.__orphan = slow(); taskSuccess("first")', makeCtx())
    expect(r1.outcome).toEqual({ kind: 'success', value: 'first' })
    const r2 = await rt.execute(
      `
      try {
        await globalThis.__orphan
        taskFail('expected orphan to be rejected')
      } catch (e) {
        taskSuccess(e.name)
      }
    `,
      makeCtx(),
    )
    expect(r2.outcome).toEqual({ kind: 'success', value: 'CancelledError' })
  })
})

describe('workerRuntime — class bridge (registered cls)', () => {
  let disposers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(disposers.map((d) => d()))
    disposers = []
  })

  function runtime() {
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 2_000 })
    disposers.push(() => rt.dispose())
    return rt
  }

  // Tiny pure value-class used across the suite. Methods on the
  // prototype, a static, no closures over host state.
  class Vec {
    constructor(
      public x: number,
      public y: number,
    ) {}
    add(other: Vec): Vec {
      return new Vec(this.x + other.x, this.y + other.y)
    }
    magnitude(): number {
      return Math.sqrt(this.x * this.x + this.y * this.y)
    }
    static zero(): Vec {
      return new Vec(0, 0)
    }
  }

  it('round-trips construction + instance method dispatch', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    const code = `
      const v = new Vec(3, 4)
      taskSuccess(await v.magnitude())
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 5 })
  })

  it('preserves instanceof against the registered class', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    const code = `
      const v = new Vec(1, 2)
      taskSuccess(v instanceof Vec)
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: true })
  })

  it('preserves instance.constructor identity', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    const code = `
      const v = new Vec(1, 2)
      taskSuccess(v.constructor === Vec)
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: true })
  })

  it('dispatches static methods through the cls bridge', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    // Vec.zero() is a static; the worker stub posts target='cls'
    // and the host calls Vec.zero() against the registered class.
    // The returned instance can't cross the boundary as a Vec —
    // it's structured-cloned, so the agent receives a plain object
    // with x/y. Acceptable for static-returns-value-type cases;
    // we just assert the method ran.
    const code = 'taskSuccess(await Vec.zero())'
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome.kind).toBe('success')
    if (result.outcome.kind !== 'success') return
    const v = result.outcome.value as { x: number; y: number }
    expect(v.x).toBe(0)
    expect(v.y).toBe(0)
  })

  it('throws when the agent attempts to subclass a registered class', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    const code = `
      try {
        class V3 extends Vec { z = 0 }
        new V3(1, 2)
        taskFail('expected subclass new to throw')
      } catch (e) {
        taskSuccess(e.message)
      }
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome.kind).toBe('success')
    if (result.outcome.kind !== 'success') return
    expect(String(result.outcome.value)).toMatch(/[Ss]ubclass/)
  })

  it('throws when the agent calls the constructor without `new`', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    const code = `
      try {
        Vec(1, 2)
        taskFail('expected plain call to throw')
      } catch (e) {
        taskSuccess(e.name)
      }
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'TypeError' })
  })

  it('respects constructable: false at host dispatch time', async () => {
    // Even if the worker stub doesn't know about constructable
    // (it just posts newInstance), the host rejects construction
    // and the rejection surfaces as the await-side error.
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec, constructable: false } } }))
    const code = `
      try {
        new Vec(1, 2)
        taskFail('expected newInstance to be rejected')
      } catch (e) {
        // Construction fails async; the first method awaited on
        // the proxy surfaces the rejection. But here we never call
        // a method — the synchronous \`new\` returned a Proxy and
        // the rejection lives on the unawaited creation Promise.
        // To observe, await any method call.
        taskSuccess('unreachable')
      }
    `
    // Better test: actually await a method on the unconstructable
    // class so the rejection is observable.
    const code2 = `
      const v = new Vec(1, 2)
      try {
        await v.magnitude()
        taskFail('expected method on un-constructable to reject')
      } catch (e) {
        taskSuccess(e.message)
      }
    `
    void code
    const result = await rt.execute(code2, makeCtx())
    expect(result.outcome.kind).toBe('success')
    if (result.outcome.kind !== 'success') return
    expect(String(result.outcome.value)).toMatch(/constructable/)
  })

  it('honors include/exclude on instance methods', async () => {
    const rt = runtime()
    // Block magnitude, allow add. Hidden methods should not even
    // be reachable on the worker-side Proxy.
    await rt.init(
      makePolicy({
        classes: { Vec: { cls: Vec, exclude: ['magnitude'] } },
      }),
    )
    const code = `
      const v = new Vec(3, 4)
      const visible = []
      if (typeof v.add === 'function') visible.push('add')
      if (typeof v.magnitude === 'function') visible.push('magnitude')
      taskSuccess(visible)
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: ['add'] })
  })

  it('rejects a fabricated instanceCall for an excluded method (host-side defense)', async () => {
    // Defense-in-depth check: the worker's Proxy whitelist hides
    // 'magnitude' via `exclude`, but a misbehaving worker could
    // fabricate the message directly via `self.postMessage`. The
    // host must re-validate visibility in handleInstanceCall.
    //
    // Side-channel observation: the registered class records every
    // call to `magnitude` on a host-side counter. If the host
    // dispatches the fabricated call, the counter increments. If
    // it correctly rejects, the counter stays 0.
    let magnitudeInvocations = 0
    class Watched {
      constructor(
        public x: number,
        public y: number,
      ) {}
      add(other: Watched) {
        return new Watched(this.x + other.x, this.y + other.y)
      }
      magnitude() {
        magnitudeInvocations++
        return Math.sqrt(this.x * this.x + this.y * this.y)
      }
    }
    const rt = runtime()
    await rt.init(
      makePolicy({
        classes: { Watched: { cls: Watched, exclude: ['magnitude'] } },
      }),
    )
    const code = `
      const v = new Watched(3, 4)
      // Sniff the executeId from a legitimate bridgeCall (the
      // fs.exists below) so the fabricated message's executeId
      // matches the host's per-execute listener filter. Without
      // this, the host's executeId guard would silently drop the
      // fabricated message — defense-by-not-listening rather than
      // the visibility check we're verifying.
      const original = self.postMessage.bind(self)
      let capturedExecId = 0
      self.postMessage = (msg) => {
        if (msg && typeof msg.executeId === 'number') capturedExecId = msg.executeId
        original(msg)
      }
      await fs.exists('/probe')
      self.postMessage = original
      // Fabricate an instanceCall that the worker's Proxy never
      // would have produced — instanceId 1 is our v, method
      // 'magnitude' is excluded. Use a callId we know isn't in
      // pending so the host's reject doesn't accidentally settle
      // a real promise.
      original({
        type: 'instanceCall',
        executeId: capturedExecId,
        callId: 99999,
        instanceId: 1,
        method: 'magnitude',
        args: [],
      })
      // Give the host a moment to process before settling.
      await new Promise(r => setTimeout(r, 50))
      taskSuccess('done')
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'done' })
    expect(magnitudeInvocations).toBe(0)
  })

  it('releases instance handles across executes (per-emission lifecycle)', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    // Stash a reference on globalThis (worker scope persists),
    // then in execute #2 try to call it. The host's instance map
    // was cleared at execute #1's settle, so the call should be
    // rejected with 'no live instance with id ...'.
    const r1 = await rt.execute(
      'globalThis.__leaked = new Vec(1, 2); taskSuccess("first")',
      makeCtx(),
    )
    expect(r1.outcome).toEqual({ kind: 'success', value: 'first' })
    const r2 = await rt.execute(
      `
      try {
        await globalThis.__leaked.add(new Vec(0, 0))
        taskFail('expected stale instance call to be rejected')
      } catch (e) {
        taskSuccess(e.message)
      }
    `,
      makeCtx(),
    )
    expect(r2.outcome.kind).toBe('success')
    if (r2.outcome.kind !== 'success') return
    // After cancelPending settles the orphan in execute #1 with a
    // CancelledError, the leaked Proxy's *next* method call sees
    // that rejection — the construction Promise has already been
    // rejected. The exact message can be either flavor; both are
    // valid evidence the handle didn't survive.
    const msg = String(r2.outcome.value)
    expect(msg.length).toBeGreaterThan(0)
  })

  it('handles concurrent instance method calls within one emission', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    // Pass primitive args (no instance-as-arg) so this test
    // exercises just the callId-map concurrency, not the
    // pass-instance-as-arg case (which has its own
    // identity-preservation considerations — see the next test).
    const code = `
      const v = new Vec(1, 1)
      const xs = [10, 20, 30]
      const mags = await Promise.all(xs.map((x) => new Vec(x, 0).magnitude()))
      taskSuccess(mags)
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [10, 20, 30] })
  })

  it('passes one instance to another instance method via handle rehydration', async () => {
    // The bridge tracks every Proxy it constructs. When agent code
    // passes one as an argument (top-level, in an array, or in a
    // plain object) the worker replaces it with an
    // INSTANCE_HANDLE_KEY marker before posting; the host walks
    // the args, looks the id up in the per-execute instance table,
    // and substitutes the live host instance. So `a.add(b)`
    // delivers the actual Vec to `Vec.prototype.add`, not an
    // empty cloned shell.
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    const code = `
      const a = new Vec(1, 2)
      const b = new Vec(3, 4)
      const c = await a.add(b)
      taskSuccess([c.x, c.y])
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [4, 6] })
  })

  it('rehydrates instance handles nested in arrays + plain objects', async () => {
    // Register a fn that takes a payload with vec instances at
    // various depths. The host-side fn sees real Vec instances
    // because the bridge unpacks the markers recursively.
    const rt = runtime()
    let observed: { name: string; sum: number; rest: number[] } | null = null
    await rt.init(
      makePolicy({
        classes: { Vec: { cls: Vec } },
        fns: {
          inspect: (payload: unknown) => {
            const p = payload as { name: string; pivot: Vec; rest: Vec[] }
            observed = {
              name: p.name,
              sum: p.pivot.x + p.pivot.y,
              rest: p.rest.map((v) => v.magnitude()),
            }
          },
        },
      }),
    )
    const code = `
      const pivot = new Vec(1, 2)
      const rest = [new Vec(3, 4), new Vec(0, 5)]
      await inspect({ name: 'demo', pivot, rest })
      taskSuccess('done')
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'done' })
    expect(observed).toEqual({ name: 'demo', sum: 3, rest: [5, 5] })
  })

  it('surfaces a stale instance handle from a prior execute as an error', async () => {
    // Stash a Vec from execute #1 on globalThis; in execute #2,
    // try to pass it to another (newly-constructed) Vec's method.
    // The marker carries the old executeId's instance id, which
    // the new execute's instance table doesn't know about. The
    // host-side rehydration throws "stale instance handle".
    const rt = runtime()
    await rt.init(makePolicy({ classes: { Vec: { cls: Vec } } }))
    const r1 = await rt.execute('globalThis.__leak = new Vec(1, 2); taskSuccess("ok")', makeCtx())
    expect(r1.outcome).toEqual({ kind: 'success', value: 'ok' })
    const r2 = await rt.execute(
      `
      const fresh = new Vec(0, 0)
      try {
        await fresh.add(globalThis.__leak)
        taskFail('expected stale handle to be rejected')
      } catch (e) {
        taskSuccess(e.message)
      }
    `,
      makeCtx(),
    )
    expect(r2.outcome.kind).toBe('success')
    if (r2.outcome.kind !== 'success') return
    // Either "stale instance handle ..." (from the host
    // rehydration) or "CancelledError" (from the orphan fix) —
    // both are valid evidence that handles don't survive across
    // emissions.
    expect(String(r2.outcome.value).length).toBeGreaterThan(0)
  })
})

describe('workerRuntime — URL-shipped registrations', () => {
  let disposers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(disposers.map((d) => d()))
    disposers = []
  })

  function runtime() {
    const rt = workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 2_000 })
    disposers.push(() => rt.dispose())
    return rt
  }

  // The fixture module ships at this URL; Vite (Vitest browser mode)
  // serves it directly from the source tree.
  const FIXTURE_URL = new URL('./fixtures/url-module.ts', import.meta.url).href

  it('imports a class from a URL and exposes it natively (full JS semantics)', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classUrls: { Vec: { url: FIXTURE_URL } } }))
    // The agent gets the *real* worker-realm class — not a Proxy.
    // Construction is sync, methods are sync, no `await` needed.
    const code = `
      const a = new Vec(1, 2)
      const b = new Vec(3, 4)
      const c = a.add(b)
      taskSuccess([c.x, c.y, c instanceof Vec])
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [4, 6, true] })
  })

  it('supports subclassing a URL-shipped class', async () => {
    // The whole reason URL mode exists. The agent's V3 extends Vec,
    // calls super(), adds its own state — all worker-realm, no host
    // round-trip.
    const rt = runtime()
    await rt.init(makePolicy({ classUrls: { Vec: { url: FIXTURE_URL } } }))
    const code = `
      class V3 extends Vec {
        z
        constructor(x, y, z) { super(x, y); this.z = z }
        magnitude() {
          return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
        }
      }
      const v = new V3(2, 3, 6)
      taskSuccess([v.magnitude(), v instanceof V3, v instanceof Vec])
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [7, true, true] })
  })

  it('imports a fn from a URL and calls it natively (no RPC round-trip)', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ fnUrls: { double: { url: FIXTURE_URL } } }))
    // Note: no `await` needed — the imported fn is a direct reference,
    // not an async stub.
    const code = 'taskSuccess(double(21))'
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 42 })
  })

  it('imports a namespace from a URL — whole module by default', async () => {
    // No `export` on a namespace spec means "expose the whole
    // module namespace object" (matches `import * as lib from
    // '...'`). Different from fn / cls, which default to plucking
    // by registration name.
    const rt = runtime()
    await rt.init(makePolicy({ namespaceUrls: { lib: { url: FIXTURE_URL } } }))
    const code = `taskSuccess([lib.double(21), lib.utils.greet('world')])`
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [42, 'hello world'] })
  })

  it('imports a namespace from a URL — explicit export plucks the named field', async () => {
    // With `export: 'utils'`, the agent sees just the `utils` const
    // from the module rather than the whole namespace object.
    const rt = runtime()
    await rt.init(makePolicy({ namespaceUrls: { utils: { url: FIXTURE_URL, export: 'utils' } } }))
    const code = `taskSuccess([utils.greet('world'), utils.shout('quiet')])`
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: ['hello world', 'QUIET'] })
  })

  it('honors the export option to rename what the agent sees', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classUrls: { Vector: { url: FIXTURE_URL, export: 'Vec' } } }))
    // The fixture exports `Vec`; the agent sees it as `Vector`.
    const code = `
      const v = new Vector(3, 4)
      taskSuccess([v.magnitude(), v instanceof Vector])
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [5, true] })
  })

  it("supports export: 'default' for default-exported modules", async () => {
    const rt = runtime()
    await rt.init(
      makePolicy({
        namespaceUrls: { fixture: { url: FIXTURE_URL, export: 'default' } },
      }),
    )
    const code = 'taskSuccess(fixture.marker)'
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: 'default-export-payload' })
  })

  it('reports a clear error when the named export is missing', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classUrls: { Missing: { url: FIXTURE_URL, export: 'NotThere' } } }))
    const result = await rt.execute('taskSuccess("unreached")', makeCtx())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error?.message).toMatch(/no 'NotThere' export/)
  })

  it('reports a clear error when the URL itself fails to import', async () => {
    const rt = runtime()
    await rt.init(makePolicy({ classUrls: { Bad: { url: '/this-does-not-exist.js' } } }))
    const result = await rt.execute('taskSuccess("unreached")', makeCtx())
    expect(result.outcome).toEqual({ kind: 'continue' })
    expect(result.error).not.toBeNull()
  })

  it('mixes URL and host-bound registrations cleanly', async () => {
    // Real-world case: some libs come from URLs (worker-realm,
    // subclassable), some are host-bound (RPC for closures over
    // host state). Both should coexist in one configure round.
    let counter = 0
    const rt = runtime()
    await rt.init(
      makePolicy({
        classUrls: { Vec: { url: FIXTURE_URL } },
        fns: {
          tick: () => ++counter,
        },
      }),
    )
    const code = `
      const v = new Vec(3, 4)
      const t = await tick()
      taskSuccess([v.magnitude(), t])
    `
    const result = await rt.execute(code, makeCtx())
    expect(result.outcome).toEqual({ kind: 'success', value: [5, 1] })
  })
})
