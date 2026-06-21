/**
 * Node-target tests for `workerRuntime` (`target: 'node'`).
 *
 * These run in Vitest's default (Node) lane — see `vitest.config.ts`,
 * which globs `tests/node/**`. Unlike the browser smoke suite (which
 * points Vite at the TS worker source), `node:worker_threads` needs a
 * real on-disk JS file, so these load the *built* `dist/worker.node.js`.
 * A `pnpm build` (or the package `prepare` on install) must have run
 * first; the guard below fails loudly with that instruction if not.
 *
 * Coverage is the transport + node-specific behavior, not a re-run of
 * the full browser matrix: taskSuccess round-trip, console capture, the
 * fs / registered-fn bridges, the error path, and the clear "remote URL
 * imports are browser-only" error that distinguishes the Node target.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MemoryFS } from '@agex-ts/termish/fs/memory'
import type { Cache, ExecuteContext, Policy, RegisteredFn } from 'agex-ts/types'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { detectTarget } from '../../src/host-worker'
import { workerRuntime } from '../../src/runtime'

// Built Node worker bundle. `node:worker_threads` can't load TS, so the
// Node lane depends on `dist/` (built by `prepare` on install / `pnpm build`).
const NODE_WORKER_URL = new URL('../../dist/worker.node.js', import.meta.url)

beforeAll(() => {
  if (!existsSync(fileURLToPath(NODE_WORKER_URL))) {
    throw new Error(
      `Node worker bundle not found at ${fileURLToPath(NODE_WORKER_URL)}.\nRun \`pnpm --filter @agex-ts/runtime-worker build\` before the Node test lane.`,
    )
  }
})

const EMPTY_POLICY: Policy = {
  fns: new Map(),
  classes: new Map(),
  namespaces: new Map(),
  skills: new Map(),
  terminals: new Map(),
}

function fnPolicy(fns: Record<string, (...args: unknown[]) => unknown>): Policy {
  const map = new Map<string, RegisteredFn>()
  for (const [name, fn] of Object.entries(fns)) map.set(name, { kind: 'fn', name, fn })
  return { ...EMPTY_POLICY, fns: map }
}

function urlClassPolicy(name: string, url: string): Policy {
  return {
    ...EMPTY_POLICY,
    classes: new Map([[name, { kind: 'cls', name, url }]]),
  }
}

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

function makeCtx(opts: { fs?: ExecuteContext['fs'] } = {}): ExecuteContext {
  return {
    fs: opts.fs ?? new MemoryFS(),
    cache: makeMemoryCache(),
    signal: new AbortController().signal,
  }
}

describe('workerRuntime (node target)', () => {
  let disposers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(disposers.map((d) => d()))
    disposers = []
  })

  function runtime(opts: Partial<Parameters<typeof workerRuntime>[0]> = {}) {
    const rt = workerRuntime({
      target: 'node',
      workerUrl: NODE_WORKER_URL,
      timeoutMs: 5_000,
      ...opts,
    })
    disposers.push(() => rt.dispose())
    return rt
  }

  it('auto-detects the node target in a Node process', () => {
    expect(detectTarget()).toBe('node')
  })

  it('runs taskSuccess and surfaces the value across the worker_threads boundary', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('taskSuccess(6 * 7)', makeCtx())
    expect(result.error).toBeNull()
    expect(result.outcome).toEqual({ kind: 'success', value: 42 })
  })

  it('captures console.log into outputs', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute(
      'console.log("hello from node worker"); taskSuccess(null)',
      makeCtx(),
    )
    expect(result.error).toBeNull()
    expect(result.outputs).toContainEqual({ type: 'text', text: 'hello from node worker' })
  })

  it('bridges fs reads/writes to the host VFS', async () => {
    const fs = new MemoryFS()
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute(
      `await fs.write('/greeting.txt', 'bonjour')
       const back = await fs.read('/greeting.txt', 'utf8')
       taskSuccess(back)`,
      makeCtx({ fs }),
    )
    expect(result.error).toBeNull()
    expect(result.outcome).toEqual({ kind: 'success', value: 'bonjour' })
    // The write landed on the host-side VFS, not just worker scratch.
    // Raw host-side `read` returns bytes (the `'utf8'` ergonomic is the
    // worker-side `wrapAgentFs` sugar, exercised by the round-trip above).
    expect(new TextDecoder().decode(await fs.read('/greeting.txt'))).toBe('bonjour')
  })

  it('bridges a registered host fn call back to the host', async () => {
    const rt = runtime()
    await rt.init(fnPolicy({ double: (n) => (n as number) * 2 }))
    const result = await rt.execute('taskSuccess(await double(21))', makeCtx())
    expect(result.error).toBeNull()
    expect(result.outcome).toEqual({ kind: 'success', value: 42 })
  })

  it('surfaces an agent-thrown error as result.error', async () => {
    const rt = runtime()
    await rt.init(EMPTY_POLICY)
    const result = await rt.execute('throw new Error("boom")', makeCtx())
    expect(result.error).not.toBeNull()
    expect(result.error?.message).toContain('boom')
  })

  it('reports a clear browser-only error for a remote URL-shipped registration', async () => {
    const rt = runtime()
    await rt.init(urlClassPolicy('Graph', 'https://esm.sh/some-graph-lib'))
    const result = await rt.execute(
      `import { Graph } from 'Graph'
       taskSuccess(typeof Graph)`,
      makeCtx(),
    )
    // The dynamic import fails on the Node target; the agent loop sees a
    // recoverable ImportError naming the registration + the reason.
    expect(result.outcome.kind).not.toBe('success')
    expect(result.error?.name).toBe('ImportError')
    expect(result.error?.message).toContain('Graph')
    expect(result.error?.message).toContain("aren't supported on the Node worker target")
  })
})
