/**
 * A session's conversation mounted beside its files: `attach(ref, at,
 * { trace: true })`, the host's spelling of `ws-git worktree add
 * --trace`. What ws-git prints is pinned by the corpus; this is the
 * host's side, and what the corpus doesn't reach.
 */

import { describe, expect, it } from 'vitest'
import {
  NeutralTraces,
  Store,
  type TraceRun,
  type TraceSource,
  type Workspace,
  neutralBody,
  traceRun,
} from '../src/index'
import { newKV } from './backends'

const run = (id: string, input: string, over: Partial<TraceRun> = {}): TraceRun =>
  traceRun({
    id,
    status: 'completed',
    started: 1792065600,
    events: [{ kind: 'user', text: input }],
    ...over,
  })

/** Store a run the way a harness's turn does. */
async function converse(ws: Workspace, r: TraceRun, harness = 'neutral'): Promise<void> {
  const turn = await ws.turn(r.id, { harness })
  await turn.end('completed', { body: neutralBody(r) })
}

/** A source that counts what it reads, and can't read `bad`. */
class Counting implements TraceSource {
  reads = 0
  read(body: unknown): TraceRun {
    this.reads++
    const r = new NeutralTraces().read(body)
    if (r.id === 'bad') throw new Error('unreadable')
    return r
  }
}

async function analyst(store: Store): Promise<Workspace> {
  const ws = await store.open('analyst')
  await ws.terminal("echo 'q1,4' > sales.csv")
  await converse(ws, run('r-one', 'Total the sales.'))
  await ws.terminal("echo 'q2,6' >> sales.csv")
  await converse(ws, run('r-two', 'Add q2.'))
  return ws
}

describe('a trace attached beside the files', () => {
  it('mounts at .trace, counts its runs, and goes with the files', async () => {
    const store = await Store.open(await newKV(), { traces: { neutral: new NeutralTraces() } })
    await (await analyst(store)).close()
    const ws = await store.open('main')
    const ref = await ws.files.attach('analyst', 'an', { trace: true })
    expect(ws.files._held('an')).toEqual({
      ref,
      trace: { runs: 2, new: null, shadowed: false },
    })
    expect((await ws.terminal('ls -a an')).stdout).toBe('.trace\nsales.csv\n')
    expect(await ws.files.readText('an/.trace/index.md')).toContain('Total the sales.')
    expect(await ws.files.readText('an/.trace/runs/002-r-two/changed.md')).toContain(
      '- M sales.csv',
    )
    await expect(ws.files.write('an/.trace/x', 'x')).rejects.toThrow('read-only')
    expect(ws.uncommitted).toBe(false)
    await ws.files.detach('an')
    expect(await ws.files.fs.exists('an')).toBe(false)
    expect(await ws.files.fs.exists('an/.trace/index.md')).toBe(false)
    await ws.close()
  })

  it("reads nothing but the index until it's read, and leaves out a run it can't read", async () => {
    const source = new Counting()
    const store = await Store.open(await newKV(), { traces: { neutral: source } })
    const other = await analyst(store)
    await converse(other, run('bad', 'unreadable'))
    await other.close()
    const ws = await store.open('main')
    await ws.files.attach('analyst', 'an', { trace: true })
    expect(source.reads).toBe(0)
    expect(ws.files._held('an')?.trace?.runs).toBe(3)
    const index = await ws.files.readText('an/.trace/index.md')
    expect(source.reads).toBe(3)
    expect(index).toContain('001-r-one')
    expect(index).not.toContain('bad')
    await ws.files.readText('an/.trace/README.md')
    expect(source.reads).toBe(3)
    await ws.close()
  })

  it('refuses since without trace, a state with no conversation, and a harness it cannot read', async () => {
    const store = await Store.open(await newKV(), { traces: { neutral: new NeutralTraces() } })
    const plain = await store.open('plain')
    await plain.files.write('a.txt', 'a')
    await plain.close()
    const other = await store.open('other')
    await converse(other, run('r1', 'hi'), 'elsewhere')
    await other.close()
    const ws = await store.open('main')
    await expect(ws.files.attach('plain', 'p', { since: 'plain' })).rejects.toThrow(
      'pass trace: true',
    )
    await expect(ws.files.attach('plain', 'p', { trace: true })).rejects.toThrow(
      'holds no conversation to trace',
    )
    await expect(ws.files.attach('other', 'o', { trace: true })).rejects.toThrow(
      "written by 'elsewhere', which this store cannot read",
    )
    // nothing was left mounted
    expect(ws.files.attachments()).toEqual({})
    // and with no sources at all, no conversation has a trace
    const bare = await (await Store.open(await newKV())).open('x')
    await converse(bare, run('r1', 'hi'))
    expect(bare.store.traces.size).toBe(0)
    await bare.close()
    await ws.close()
  })

  it('marks the runs new since a bare commit of the session traced', async () => {
    const store = await Store.open(await newKV(), { traces: { neutral: new NeutralTraces() } })
    const other = await store.open('analyst')
    await converse(other, run('r-one', 'first'))
    const seen = other.head
    await other.terminal('echo b > b.txt')
    await converse(other, run('r-two', 'second'))
    await other.close()
    const ws = await store.open('main')
    await ws.files.attach('analyst', 'an', { trace: true, since: seen.slice(0, 7) })
    expect(ws.files._held('an')?.trace?.new).toBe(1)
    const index = await ws.files.readText('an/.trace/index.md')
    expect(index).toContain(`Runs marked + are new since analyst@${seen.slice(0, 7)}.`)
    expect(index).toMatch(/\n {2}001-r-one .*\n\+ 002-r-two /)
    await ws.close()
  })

  it("names a store tag's session from its conversation", async () => {
    const store = await Store.open(await newKV(), { traces: { neutral: new NeutralTraces() } })
    const other = await analyst(store)
    await store.tags.add(other, 'v1')
    await other.close()
    await store.delete('analyst', { minAge: 0 })
    const ws = await store.open('main')
    await ws.files.attach('v1', 'v', { trace: true })
    expect(await ws.files.readText('v/.trace/README.md')).toMatch(
      /^# Trace of analyst at [0-9a-f]{7}\n/,
    )
    await ws.close()
  })

  it("gives a full fork's first run only its own work", async () => {
    const store = await Store.open(await newKV(), { traces: { neutral: new NeutralTraces() } })
    const parent = await store.open('parent')
    await parent.terminal('echo p > p.txt')
    await converse(parent, run('r-p', 'parent'))
    await parent.terminal('echo later > later.txt')
    const child = await parent.fork('child')
    await child.terminal('echo c > c.txt')
    await converse(child, run('r-c', 'child'))
    await child.close()
    await parent.close()
    const ws = await store.open('main')
    await ws.files.attach('child', 'k', { trace: true })
    expect(await ws.files.readText('k/.trace/index.md')).toMatch(
      /001-r-p .* files:1 .*\n002-r-c .* files:1 /,
    )
    const changed = await ws.files.readText('k/.trace/runs/002-r-c/changed.md')
    expect(changed).toContain('- A c.txt')
    expect(changed).not.toContain('later.txt')
    await ws.close()
  })
})
