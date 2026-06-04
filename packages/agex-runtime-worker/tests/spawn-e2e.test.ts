/**
 * Browser-mode end-to-end tests for `spawn` under the *worker* runtime.
 *
 * Unlike `smoke.test.ts` (which stubs `ExecuteContext` and a fake
 * `ctx.spawn`), these drive the full stack: a real `createAgent` whose
 * `runtime` is the `workerRuntime`, a real `spawn` call from agent code,
 * the host's real `createSpawn` running the clone, and the clone's
 * emissions executing as *concurrent* executes on the same worker while
 * the parent emission is parked at `await spawn(...)`. This is the seam
 * PR 6b introduces — and nothing else exercises it whole.
 */

import { createAgent } from 'agex-ts'
import { Dummy } from 'agex-ts/llm-dummy'
import type { Emission, LLMRequest, LLMResponse, TokenChunk } from 'agex-ts/types'
import { afterEach, describe, expect, it } from 'vitest'
import { workerRuntime } from '../src/runtime'

const TEST_WORKER_URL = new URL('../src/worker.ts', import.meta.url)
const ts = (code: string): LLMResponse => ({ emissions: [{ type: 'ts', code }] })

async function* toTokens(resp: LLMResponse): AsyncIterable<TokenChunk> {
  for (let i = 0; i < resp.emissions.length; i++) {
    yield {
      type: 'emission',
      content: '',
      done: true,
      emissionIndex: i,
      emission: resp.emissions[i] as Emission,
    }
  }
  yield { type: 'emission', content: '', done: true, emissionIndex: resp.emissions.length }
}

/** Routes responses by request, so the parent and its (concurrent)
 *  clones — all drawing from one shared LLM — are served deterministically
 *  regardless of interleaving. The parent's system prompt carries the
 *  spawn section; a clone's never does. */
class RouterLLM extends Dummy {
  constructor(private readonly pick: (req: LLMRequest) => LLMResponse) {
    super()
  }
  override complete(req: LLMRequest): AsyncIterable<TokenChunk> {
    return toTokens(this.pick(req))
  }
}

const isParent = (req: LLMRequest): boolean => req.system.includes('## Spawn (sub-tasks)')

describe('workerRuntime — spawn end-to-end (real agent loop)', () => {
  let agents: Awaited<ReturnType<typeof createAgent>>[] = []
  afterEach(async () => {
    await Promise.all(agents.map((a) => a.dispose()))
    agents = []
  })

  async function makeAgent(pick: (req: LLMRequest) => LLMResponse) {
    const agent = await createAgent({
      name: 'T',
      llm: new RouterLLM(pick),
      runtime: workerRuntime({ workerUrl: TEST_WORKER_URL, timeoutMs: 10_000 }),
    })
    agents.push(agent)
    return agent
  }

  it('a top-level task spawns a clone and gets its result', async () => {
    const agent = await makeAgent((req) =>
      isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("clone-result")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('clone-result')
  })

  it('fans out clones with Promise.all (parent parked, clones run concurrently on the worker)', async () => {
    const agent = await makeAgent((req) =>
      isParent(req)
        ? ts(
            'taskSuccess(await Promise.all([1, 2, 3].map((n) => spawn({ task: "echo", input: n }))))',
          )
        : ts('taskSuccess(inputs)'),
    )
    const fn = agent.task<undefined, number[]>({ description: 'Parent.' })
    expect(await fn(undefined)).toEqual([1, 2, 3])
  })

  it('a clone failure surfaces as a catchable rejection to the parent', async () => {
    const agent = await makeAgent((req) =>
      isParent(req)
        ? ts('try { await spawn("boom") } catch (e) { taskSuccess("caught: " + e.message) }')
        : ts('taskFail("nope")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('caught: spawned sub-task failed: nope')
  })

  it('exposes a read-only view of the parent VFS to the clone through the bridge', async () => {
    // The view is a host-side fs composition; this confirms it survives
    // the worker boundary — the clone's bridged fs.read of a view path
    // routes to the host ReadOnlyView → parent backing.
    const agent = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "read", view: "/data" }))')
        : ts('taskSuccess(await fs.read("/data/x.txt", "utf8"))'),
    )
    const pfs = await agent.fs()
    await pfs.mkdir('/data', { parents: true })
    await pfs.write('/data/x.txt', new TextEncoder().encode('via-worker'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('via-worker')
  })
})
