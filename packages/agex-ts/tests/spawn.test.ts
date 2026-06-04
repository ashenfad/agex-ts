import { describe, expect, it } from 'vitest'
import { type AgentOptions, createAgent } from '../src/agent'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, Emission, LLMRequest, LLMResponse, TokenChunk } from '../src/types'

const ts = (code: string): LLMResponse => ({ emissions: [{ type: 'ts', code }] })

async function* toTokens(resp: LLMResponse): AsyncIterable<TokenChunk> {
  for (let i = 0; i < resp.emissions.length; i++) {
    const emission = resp.emissions[i] as Emission
    yield { type: 'emission', content: '', done: true, emissionIndex: i, emission }
  }
  yield { type: 'emission', content: '', done: true, emissionIndex: resp.emissions.length }
}

/** A shared LLM that routes responses by inspecting the request, so the
 *  parent and its (possibly concurrent) clones — which all draw from the
 *  same client — are served deterministically regardless of interleaving.
 *  The parent's system prompt carries the spawn primer; a clone's never
 *  does (depth-1), which `isParent` keys off. */
class RouterLLM extends Dummy {
  constructor(private readonly pick: (req: LLMRequest, call: number) => LLMResponse) {
    super()
  }
  override complete(req: LLMRequest): AsyncIterable<TokenChunk> {
    const call = this.callCount
    this.allSystems.push(req.system)
    this.allTurns.push([...req.turns])
    this.callCount++
    return toTokens(this.pick(req, call))
  }
}

const isParent = (req: LLMRequest): boolean => req.system.includes('## Spawn (sub-tasks)')

async function makeAgent(
  pick: (req: LLMRequest, call: number) => LLMResponse,
  opts: Partial<AgentOptions> = {},
) {
  const llm = new RouterLLM(pick)
  const agent = await createAgent({ name: 'T', llm, runtime: evalRuntime(), ...opts })
  return { agent, llm }
}

describe('spawn — agent-authored sub-tasks', () => {
  it('runs a clone and returns its result', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn("do the thing"))')
        : ts('taskSuccess("clone-result")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('clone-result')
  })

  it('passes input to the clone (bound as `inputs`)', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "echo", input: { n: 7 } }))')
        : ts('taskSuccess(inputs)'),
    )
    const fn = agent.task<undefined, { n: number }>({ description: 'Parent.' })
    expect(await fn(undefined)).toEqual({ n: 7 })
  })

  it('fans out with Promise.all, preserving order', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts(
            'taskSuccess(await Promise.all([1, 2, 3].map((n) => spawn({ task: "echo", input: n }))))',
          )
        : ts('taskSuccess(inputs)'),
    )
    const fn = agent.task<undefined, number[]>({ description: 'Parent.' })
    expect(await fn(undefined)).toEqual([1, 2, 3])
  })

  it('clones are depth-1: `spawn` is not injected into a clone', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess(typeof spawn)'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('undefined')
  })

  it('shows the clone the sub-task primer note, not the spawn section', async () => {
    const { agent, llm } = await makeAgent((req) =>
      isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("ok")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined)
    // The parent was taught spawn; the clone got the sub-task note and
    // NOT the spawn section (depth-1).
    const cloneSystems = llm.allSystems.filter((s) => s.includes('## Sub-task'))
    expect(llm.allSystems.some((s) => s.includes('## Spawn (sub-tasks)'))).toBe(true)
    expect(cloneSystems.length).toBeGreaterThan(0)
    expect(cloneSystems.every((s) => !s.includes('## Spawn (sub-tasks)'))).toBe(true)
  })

  it('a clone failure rejects the spawn — catchable, not a parent taskFail', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('try { await spawn("boom") } catch (e) { taskSuccess("caught: " + e.message) }')
        : ts('taskFail("nope")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('caught: spawned sub-task failed: nope')
  })

  it('an uncaught clone failure is recoverable, not fatal to the parent', async () => {
    let parentTurn = 0
    const { agent } = await makeAgent((req) => {
      if (!isParent(req)) return ts('taskFail("nope")')
      parentTurn++
      return parentTurn === 1
        ? ts('await spawn("boom"); taskSuccess("unreached")') // throws → recoverable
        : ts('taskSuccess("recovered")')
    })
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('recovered')
  })

  it('enforces the clone output schema, and the clone retries on a mismatch', async () => {
    let cloneTurn = 0
    const { agent } = await makeAgent((req) => {
      if (isParent(req)) {
        return ts(
          'taskSuccess(await spawn({ task: "make", output: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }))',
        )
      }
      cloneTurn++
      return cloneTurn === 1 ? ts('taskSuccess({})') : ts('taskSuccess({ name: "ada" })')
    })
    const fn = agent.task<undefined, { name: string }>({ description: 'Parent.' })
    expect(await fn(undefined)).toEqual({ name: 'ada' })
    expect(cloneTurn).toBe(2) // it really retried
  })

  it('maxSpawns: 0 disables spawn — not injected, not taught', async () => {
    const { agent, llm } = await makeAgent(() => ts('taskSuccess(typeof spawn)'), { maxSpawns: 0 })
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('undefined')
    expect(llm.allSystems[0]).not.toContain('## Spawn (sub-tasks)')
  })

  it('forwards clone events tagged, without polluting the parent log', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("ok")'),
    )
    const seen: AgentEvent[] = []
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined, { onEvent: (e) => void seen.push(e) })

    // Clone events reach the stream, tagged with the spawn label.
    expect(seen.some((e) => e.agentName === 'T:spawn#0')).toBe(true)
    // But the parent's durable log holds only the parent's own events.
    const log: AgentEvent[] = []
    for await (const e of (await agent.events('default')).iter()) log.push(e)
    expect(log.length).toBeGreaterThan(0)
    expect(log.every((e) => e.agentName === 'T')).toBe(true)
  })

  it('clone file writes stay in the clone, not the parent VFS', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn("w"))')
        : ts('await fs.write("/clone.txt", "x"); taskSuccess("done")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('done')
    expect(await (await agent.fs('default')).exists('/clone.txt')).toBe(false)
  })

  it('mounts the parent /skills overlay into the clone', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn("read"))')
        : ts(
            'const c = await fs.read("/skills/demo/SKILL.md", "utf8"); taskSuccess(c.includes("hello"))',
          ),
    )
    agent.skill('hello world skill body', { name: 'demo' })
    const fn = agent.task<undefined, boolean>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe(true)
  })

  it('view exposes parent files read-only at the same path', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "read", view: "/data" }))')
        : ts('taskSuccess(await fs.read("/data/x.txt", "utf8"))'),
    )
    const pfs = await agent.fs()
    await pfs.mkdir('/data', { parents: true })
    await pfs.write('/data/x.txt', new TextEncoder().encode('hello-parent'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('hello-parent')
  })

  it('clone writes to a view path are rejected (read-only)', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "w", view: "/data" }))')
        : ts(
            'try { await fs.write("/data/y.txt", "x"); taskSuccess("wrote") } catch { taskSuccess("blocked") }',
          ),
    )
    const pfs = await agent.fs()
    await pfs.mkdir('/data', { parents: true })
    await pfs.write('/data/x.txt', new TextEncoder().encode('seed'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('blocked')
    // The parent's /data is untouched — the clone's write never landed.
    expect(await pfs.exists('/data/y.txt')).toBe(false)
  })

  it('paths outside view are not visible to the clone', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "peek", view: "/data" }))')
        : ts('taskSuccess(await fs.exists("/secret.txt"))'),
    )
    const pfs = await agent.fs()
    await pfs.mkdir('/data', { parents: true })
    await pfs.write('/data/x.txt', new TextEncoder().encode('seed'))
    await pfs.write('/secret.txt', new TextEncoder().encode('classified'))
    const fn = agent.task<undefined, boolean>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe(false) // outside the /data view → clone can't see it
  })

  it('bounds concurrency to maxSpawns', async () => {
    let active = 0
    let maxActive = 0
    const gate = async (): Promise<void> => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    }
    const { agent } = await makeAgent(
      (req) =>
        isParent(req)
          ? ts(
              'taskSuccess(await Promise.all([1,2,3,4,5].map((n) => spawn({ task: "g", input: n }))))',
            )
          : ts('await gate(); taskSuccess(inputs)'),
      { maxSpawns: 2 },
    )
    agent.fn(gate, { name: 'gate' })
    const fn = agent.task<undefined, number[]>({ description: 'Parent.' })
    expect(await fn(undefined)).toEqual([1, 2, 3, 4, 5])
    expect(maxActive).toBeLessThanOrEqual(2) // the bound holds
    expect(maxActive).toBeGreaterThan(1) // and clones really ran in parallel
  })
})
