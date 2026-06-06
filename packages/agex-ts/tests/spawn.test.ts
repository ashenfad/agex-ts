import { describe, expect, it } from 'vitest'
import { type AgentOptions, createAgent } from '../src/agent'
import { CancelledError } from '../src/errors'
import { Dummy } from '../src/llm/dummy'
import { renderEvents } from '../src/render'
import { evalRuntime } from '../src/runtime/eval'
import type {
  AgentEvent,
  CancelledEvent,
  Emission,
  FailEvent,
  LLMRequest,
  LLMResponse,
  SuccessEvent,
  TokenChunk,
} from '../src/types'

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

async function collectLog(
  agent: Awaited<ReturnType<typeof makeAgent>>['agent'],
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of (await agent.events('default')).iter()) out.push(e)
  return out
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

  it('recursive listing through a view is single-prefixed (no /data/data)', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "ls", view: "/data" }))')
        : ts(
            'const d = await fs.listDetailed("/", { recursive: true }); const l = await fs.list("/", { recursive: true }); taskSuccess(JSON.stringify({ detailed: d.map((f) => f.path), list: l }))',
          ),
    )
    const pfs = await agent.fs()
    await pfs.mkdir('/data/sub', { parents: true })
    await pfs.write('/data/a.txt', new TextEncoder().encode('A'))
    await pfs.write('/data/sub/b.txt', new TextEncoder().encode('B'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    const { detailed, list } = JSON.parse(await fn(undefined)) as {
      detailed: string[]
      list: string[]
    }
    // listDetailed re-anchors correctly: the parent's files appear once
    // under /data, never double-prefixed.
    expect(detailed).toContain('/data/a.txt')
    expect(detailed).toContain('/data/sub/b.txt')
    expect(detailed.some((p) => p.includes('/data/data'))).toBe(false)
    // list (relative, no leading slash) composes correctly too.
    expect(list).toContain('data/a.txt')
    expect(list.some((p) => p.includes('data/data'))).toBe(false)
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

describe('spawn — host-facing invoke', () => {
  // No parent task runs here, so the LLM only ever serves the clone.
  it('runs a clone cold and round-trips its result', async () => {
    const { agent } = await makeAgent(() => ts('taskSuccess("clone-result")'))
    expect(await agent.spawn('do the thing')).toBe('clone-result')
  })

  it('passes input via SpawnSpec and enforces the output schema', async () => {
    const { agent } = await makeAgent(() => ts('taskSuccess({ echoed: inputs.n })'))
    const out = await agent.spawn({
      task: 'echo',
      input: { n: 7 },
      output: {
        type: 'object',
        properties: { echoed: { type: 'number' } },
        required: ['echoed'],
      },
    })
    expect(out).toEqual({ echoed: 7 })
  })

  it('aborts when the supplied signal is already aborted', async () => {
    const { agent } = await makeAgent(() => ts('taskSuccess("unreached")'))
    const controller = new AbortController()
    controller.abort()
    await expect(agent.spawn('x', { signal: controller.signal })).rejects.toThrow(CancelledError)
  })

  it('forwards clone events to onEvent, tagged with the spawn label', async () => {
    const { agent } = await makeAgent(() => ts('taskSuccess("ok")'))
    const seen: AgentEvent[] = []
    await agent.spawn('inner', { onEvent: (e) => void seen.push(e) })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some((e) => e.agentName === 'T:spawn#0')).toBe(true)
    // Cold invoke leaves the parent's durable log untouched.
    const log: AgentEvent[] = []
    for await (const e of (await agent.events('default')).iter()) log.push(e)
    expect(log).toHaveLength(0)
  })

  it('a clone failure rejects the returned promise as a plain Error', async () => {
    const { agent } = await makeAgent(() => ts('taskFail("nope")'))
    await expect(agent.spawn('boom')).rejects.toThrow('spawned sub-task failed: nope')
  })
})

describe('spawn — view follow-ups', () => {
  // Clone turns (system + user task message) for the calls that are NOT
  // the parent — keyed off the spawn primer the parent alone carries.
  const cloneTurnText = (llm: { allSystems: string[]; allTurns: unknown[] }): string =>
    JSON.stringify(
      llm.allTurns.filter((_, i) => !(llm.allSystems[i] ?? '').includes('## Spawn (sub-tasks)')),
    )

  it('resolves a relative view against the parent session cwd (Gap 2)', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "read", view: "notes.md" }))')
        : ts('taskSuccess(await fs.read("/work/notes.md", "utf8"))'),
    )
    const pfs = await agent.fs()
    await pfs.mkdir('/work', { parents: true })
    await pfs.chdir('/work')
    // Written relative → lands at /work/notes.md (the parent's cwd). A
    // root-anchored view would have mounted an empty /notes.md.
    await pfs.write('notes.md', new TextEncoder().encode('cwd-relative'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toBe('cwd-relative')
  })

  it('throws a clear error when a view path resolves to nothing (Gap 2)', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req)
        ? ts(
            'try { await spawn({ task: "x", view: "/nope.txt" }) } catch (e) { taskSuccess("caught: " + e.message) }',
          )
        : ts('taskSuccess("unreached")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    expect(await fn(undefined)).toContain('spawn view path not found')
  })

  it('announces a directory view in the clone task message (Gap 1)', async () => {
    const { agent, llm } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "read", view: "/data" }))')
        : ts('taskSuccess("ok")'),
    )
    const pfs = await agent.fs()
    await pfs.mkdir('/data', { parents: true })
    await pfs.write('/data/a.txt', new TextEncoder().encode('A'))
    await pfs.write('/data/b.txt', new TextEncoder().encode('B'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined)
    const text = cloneTurnText(llm)
    // The clone is told what's mounted without having to `list("/")`.
    expect(text).toContain('Read-only files have been mounted')
    expect(text).toContain('/data/ — read-only directory')
    expect(text).toContain('a.txt')
    expect(text).toContain('b.txt')
  })

  it('announces a single-file view in the clone task message (Gap 1)', async () => {
    const { agent, llm } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "read", view: "/notes.md" }))')
        : ts('taskSuccess("ok")'),
    )
    const pfs = await agent.fs()
    await pfs.write('/notes.md', new TextEncoder().encode('hello'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined)
    expect(cloneTurnText(llm)).toContain('/notes.md — read-only file')
  })

  it('dedupes view paths that resolve to the same prefix (Gap 1)', async () => {
    const { agent, llm } = await makeAgent((req) =>
      isParent(req)
        ? ts('taskSuccess(await spawn({ task: "read", view: ["/notes.md", "/notes.md"] }))')
        : ts('taskSuccess("ok")'),
    )
    const pfs = await agent.fs()
    await pfs.write('/notes.md', new TextEncoder().encode('hi'))
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined)
    const text = cloneTurnText(llm)
    // Announced once, not once per duplicate.
    const occurrences = text.split('/notes.md — read-only file').length - 1
    expect(occurrences).toBe(1)
  })

  it('tags clone events with a structured spawnIndex, not just agentName', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("ok")'),
    )
    const seen: AgentEvent[] = []
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined, { onEvent: (e) => void seen.push(e) })
    const cloneEvents = seen.filter((e) => e.agentName === 'T:spawn#0')
    expect(cloneEvents.length).toBeGreaterThan(0)
    expect(cloneEvents.every((e) => e.spawnIndex === 0)).toBe(true)
    // The parent's own events carry no spawnIndex.
    expect(seen.filter((e) => e.agentName === 'T').every((e) => e.spawnIndex === undefined)).toBe(
      true,
    )
  })
})

describe('spawn — event capture (captureSpawnEvents)', () => {
  it('off by default: terminal events carry no spawnEvents', async () => {
    const { agent } = await makeAgent((req) =>
      isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("ok")'),
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined)
    const success = (await collectLog(agent)).find((e) => e.type === 'success') as SuccessEvent
    expect(success).toBeDefined()
    expect(success.spawnEvents).toBeUndefined()
  })

  it('on: captures the full clone timeline onto the success event, keyed by spawnIndex', async () => {
    const { agent } = await makeAgent(
      (req) => (isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("ok")')),
      { captureSpawnEvents: true },
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined)
    const success = (await collectLog(agent)).find((e) => e.type === 'success') as SuccessEvent
    expect(success.spawnEvents).toHaveLength(1)
    const entry = success.spawnEvents?.[0]
    expect(entry?.spawnIndex).toBe(0)
    // The whole sub-task timeline, start to finish.
    expect(entry?.events.some((e) => e.type === 'taskStart')).toBe(true)
    expect(entry?.events.some((e) => e.type === 'success')).toBe(true)
    // Every captured event is tagged for its clone.
    expect(entry?.events.every((e) => e.spawnIndex === 0 && e.agentName === 'T:spawn#0')).toBe(true)
  })

  it('fan-out: one entry per clone, keyed and sorted by spawnIndex', async () => {
    const { agent } = await makeAgent(
      (req) =>
        isParent(req)
          ? ts(
              'taskSuccess(await Promise.all([0,1,2].map((n) => spawn({ task: "echo", input: n }))))',
            )
          : ts('taskSuccess(inputs)'),
      { captureSpawnEvents: true },
    )
    const fn = agent.task<undefined, number[]>({ description: 'Parent.' })
    await fn(undefined)
    const success = (await collectLog(agent)).find((e) => e.type === 'success') as SuccessEvent
    expect(success.spawnEvents?.map((s) => s.spawnIndex)).toEqual([0, 1, 2])
    expect(success.spawnEvents?.every((s) => s.events.length > 0)).toBe(true)
  })

  it('captures even with no onEvent handler attached', async () => {
    const { agent } = await makeAgent(
      (req) => (isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("ok")')),
      { captureSpawnEvents: true },
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined) // deliberately no { onEvent }
    const success = (await collectLog(agent)).find((e) => e.type === 'success') as SuccessEvent
    expect(success.spawnEvents).toHaveLength(1)
  })

  it('captures onto a fail event when the parent taskFails', async () => {
    const { agent } = await makeAgent(
      (req) =>
        isParent(req)
          ? ts('await spawn("inner"); taskFail("parent gives up")')
          : ts('taskSuccess("ok")'),
      { captureSpawnEvents: true },
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await expect(fn(undefined)).rejects.toThrow('parent gives up')
    const fail = (await collectLog(agent)).find((e) => e.type === 'fail') as FailEvent
    expect(fail.spawnEvents).toHaveLength(1)
    expect(fail.spawnEvents?.[0]?.spawnIndex).toBe(0)
  })

  it('captures clones that ran before a parent cancellation onto the cancelled event', async () => {
    const controller = new AbortController()
    // Abort from inside the clone, then hang — so the clone is genuinely
    // cancelled (not racing to success) and the parent unwinds cancelled.
    const abortAndHang = async (): Promise<void> => {
      controller.abort()
      await new Promise<void>(() => {})
    }
    const { agent } = await makeAgent(
      (req) =>
        isParent(req)
          ? ts('await spawn("g"); taskSuccess("unreached")')
          : ts('await abortAndHang(); taskSuccess("unreached")'),
      { captureSpawnEvents: true },
    )
    agent.fn(abortAndHang, { name: 'abortAndHang' })
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await expect(fn(undefined, { signal: controller.signal })).rejects.toThrow(CancelledError)
    const cancelled = (await collectLog(agent)).find(
      (e) => e.type === 'cancelled',
    ) as CancelledEvent
    expect(cancelled).toBeDefined()
    expect(cancelled.spawnEvents?.[0]?.spawnIndex).toBe(0)
    // At least the clone's opening event made it into the record.
    expect(cancelled.spawnEvents?.[0]?.events.some((e) => e.type === 'taskStart')).toBe(true)
  })

  it('the captured payload is invisible to the parent LLM (render is byte-identical)', async () => {
    const { agent } = await makeAgent(
      (req) => (isParent(req) ? ts('taskSuccess(await spawn("inner"))') : ts('taskSuccess("ok")')),
      { captureSpawnEvents: true },
    )
    const fn = agent.task<undefined, string>({ description: 'Parent.' })
    await fn(undefined)
    const log = await collectLog(agent)
    // Sanity: the payload really is present on the durable success event.
    expect((log.find((e) => e.type === 'success') as SuccessEvent).spawnEvents).toBeDefined()
    // Rendering the log with vs. without the payload yields identical turns.
    const stripped = log.map((e) => {
      if (e.type !== 'success') return e
      const { spawnEvents: _omit, ...rest } = e
      return rest
    })
    expect(renderEvents(log)).toEqual(renderEvents(stripped))
  })
})
