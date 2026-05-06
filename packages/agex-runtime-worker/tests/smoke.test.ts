/**
 * Browser-mode smoke tests for `workerRuntime`.
 *
 * Each test stubs an `ExecuteContext` directly rather than going
 * through the full agent loop — PR 1 doesn't bridge `fs` / `cache`
 * yet, so a contrived in-memory context is enough to exercise the
 * worker's execute / output / result protocol.
 */

import { CancelledError } from 'agex-ts/errors'
import type { ExecuteContext, Policy } from 'agex-ts/types'
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

function makeCtx(opts: { signal?: AbortSignal } = {}): ExecuteContext {
  const signal = opts.signal ?? new AbortController().signal
  // PR 1's worker doesn't expose fs / cache / inputs, so a stub
  // that throws on access is the right shape — any unexpected use
  // would surface loudly in tests.
  const stub = new Proxy(
    {},
    {
      get(_t, p) {
        throw new Error(`fs/cache not bridged in PR 1 (accessed: ${String(p)})`)
      },
    },
  )
  return {
    fs: stub as ExecuteContext['fs'],
    cache: stub as ExecuteContext['cache'],
    signal,
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
