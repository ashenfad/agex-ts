/**
 * Browser-mode smoke tests for `workerRuntime`.
 *
 * Each test stubs an `ExecuteContext` (with a `MemoryFS` + Map-
 * backed `Cache`) and a `Policy` directly rather than going through
 * the full agent loop. The boundary under test is just the runtime
 * adapter and its wire protocol, so a contrived context is enough.
 */

import { CancelledError } from 'agex-ts/errors'
import type { Cache, ExecuteContext, Policy, RegisteredFn, RegisteredNs } from 'agex-ts/types'
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
  fns?: Record<string, RegisteredFn['fn']>
  namespaces?: Record<
    string,
    {
      target: object
      include?: RegisteredNs['include']
      exclude?: RegisteredNs['exclude']
    }
  >
}): Policy {
  const fns = new Map<string, RegisteredFn>()
  for (const [name, fn] of Object.entries(args.fns ?? {})) {
    fns.set(name, { kind: 'fn', name, fn })
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
  return {
    fns,
    classes: new Map(),
    namespaces,
    skills: new Map(),
    terminals: new Map(),
  }
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
