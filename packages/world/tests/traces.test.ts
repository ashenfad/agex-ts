/**
 * The trace renderer: a port of nontainer's `nontainer.traces`, checked
 * against its trace corpus (tests/traces-corpus/, synced by
 * scripts/sync-corpus.mjs) byte for byte, with the shape's rules and
 * the run ranges besides.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { FsError } from '@agex-ts/termish'
import { describe, expect, it } from 'vitest'
import {
  FORK_TOOL,
  NeutralTraces,
  Trace,
  type TraceCommit,
  type TraceEvent,
  type TraceRun,
  commitFromBody,
  neutralBody,
  runFromBody,
  runRanges,
  traceRun,
} from '../src/traces'

interface Case {
  readonly name: string
  readonly session: string
  readonly commit: string
  readonly harness: string
  readonly runs: readonly unknown[]
  readonly changes: Readonly<Record<string, readonly unknown[]>>
  readonly since: string | null
  readonly new: readonly string[]
  readonly files: Readonly<Record<string, string>>
}

const dir = new URL('./traces-corpus/', import.meta.url)
const cases: Case[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Case)

const run = (over: Partial<TraceRun> = {}): TraceRun =>
  traceRun({ id: 'r1', status: 'completed', ...over })

const trace = (...runs: TraceRun[]) =>
  Trace.create(runs, { session: 's', commit: 'c', harness: 'h' })

describe("nontainer's trace corpus", () => {
  it('has the corpus', () => {
    expect(cases.length).toBeGreaterThan(5)
  })

  for (const c of cases) {
    it(c.name, async () => {
      const runs = c.runs.map((body) => new NeutralTraces().read(body))
      const t = await Trace.create(runs, {
        session: c.session,
        commit: c.commit,
        harness: c.harness,
        changes: new Map(
          Object.entries(c.changes).map(([id, commits]) => [id, commits.map(commitFromBody)]),
        ),
        since: c.since,
        new: c.new,
      })
      expect(t.paths()).toEqual(Object.keys(c.files))
      for (const [path, text] of Object.entries(c.files))
        expect([path, t.read(path)]).toEqual([path, text])
      // and what it renders from goes back to the body it came from
      expect(runs.map(neutralBody)).toEqual(c.runs)
    })
  }
})

describe('the neutral shape', () => {
  it('takes times from year 1 through 9999', async () => {
    const t = await Trace.create(
      [runFromBody({ id: 'r', status: 'x', started: -62135596800, ended: 253402300799.5 })],
      { session: 's', commit: 'c', harness: 'h' },
    )
    expect(t.read('runs/001-r/run.md')).toContain(
      '- started: 0001-01-01T00:00:00Z\n- ended: 9999-12-31T23:59:59Z\n',
    )
  })

  it('leaves unrecorded counts out of the body', () => {
    const r = runFromBody({ id: 'r', status: 'completed', tokens: { input: 5 } })
    expect(r.tokens).toEqual({
      input: 5,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    })
    expect(neutralBody(r)).toEqual({
      id: 'r',
      status: 'completed',
      tokens: { input: 5 },
      events: [],
    })
  })

  it.each([
    [{ status: 'completed' }, 'run id'],
    [{ id: 'r', status: null }, 'run status'],
    [{ id: 'r', status: 'x', events: [{ kind: 'system' }] }, 'event kind'],
    [{ id: 'r', status: 'x', tokens: { input: '5' } }, 'tokens.input'],
    [{ id: 'r', status: 'x', tokens: { input: true } }, 'tokens.input'],
    [{ id: 'r', status: 'x', tokens: { input: 1.5 } }, 'tokens.input'],
    [{ id: 'r', status: 'x', started: 'noon' }, 'run started'],
    [{ id: 'r', status: 'x', started: Number.NaN }, 'run started'],
    [{ id: 'r', status: 'x', ended: Number.POSITIVE_INFINITY }, 'run ended'],
    [{ id: 'r', status: 'x', started: 253402300800 }, 'run started'],
    [{ id: 'r', status: 'x', started: -62135596801 }, 'run started'],
    [{ id: 'r', status: 'x', events: [{ kind: 'tool', error: 'false' }] }, 'event error'],
    [{ id: 'r', status: 'x', events: [{ kind: 'tool', error: null }] }, 'event error'],
    [{ id: 'r', status: 'x', events: [{ kind: 'tool', args: [1] }] }, 'args'],
    [{ id: 'r', status: 'x', events: {} }, 'run events'],
    [[], 'object'],
    ['a run', 'object'],
  ])('refuses a malformed body, saying where: %j', (body, says) => {
    expect(() => new NeutralTraces().read(body)).toThrow(says)
  })
})

describe('the rendered tree', () => {
  it('lists its paths sorted, and reads them with or without slashes', async () => {
    const t = await trace(
      run({
        events: [
          { kind: 'user', text: 'hi' },
          { kind: 'tool', text: 'x', tool: 't' },
        ],
        system: 'p',
      }),
      run({ id: 'r2', system: 'p' }),
    )
    const paths = t.paths()
    expect(paths).toEqual([...paths].sort())
    expect(paths.filter((p) => p.startsWith('system/'))).toHaveLength(1)
    expect(paths).toContain('runs/001-r1/events/002-tool-t.md')
    expect(t.read('/index.md')).toBe(t.read('index.md'))
    expect(() => t.read('runs/009-nope/run.md')).toThrow(FsError)
  })

  it('keeps a shared system prompt once', async () => {
    const t = await trace(
      run({ system: 'p' }),
      run({ id: 'r2', system: 'p' }),
      run({ id: 'r3', system: 'q' }),
    )
    expect(t.paths().filter((p) => p.startsWith('system/'))).toHaveLength(2)
  })

  it('fences a result holding fences with a longer one', async () => {
    const t = await trace(run({ events: [{ kind: 'tool', text: 'a ````` b', tool: 't' }] }))
    expect(t.read('runs/001-r1/events/001-tool-t.md')).toContain('``````\na ````` b\n``````')
  })

  it('cuts the index by code point', async () => {
    const t = await trace(run({ events: [{ kind: 'user', text: '🙂'.repeat(100) }] }))
    const line = t.read('index.md').trimEnd().split('\n').at(-1)
    expect(line?.endsWith(`${'🙂'.repeat(80)}…`)).toBe(true)
  })

  it('makes names path segments', async () => {
    const t = await trace(
      run({ id: '../../etc', events: [{ kind: 'tool', text: 'x', tool: '../a b' }] }),
    )
    expect(t.paths()).toContain('runs/001-______et/events/001-tool-___a_b.md')
  })

  it('writes arguments as JSON.stringify does, keys by UTF-16 code units', async () => {
    const args = {
      n: [1e-7, 1e-6, 1e21, 1e20, -2.5e-8, 2, -0, 1 / 3, Number.NaN],
      keys: { Ａ: 1, '😀': 2, b: 3, '10': 4, '9': 5 },
    }
    const event: TraceEvent = { kind: 'tool', text: 'ok', tool: 't', args }
    const text = (await trace(run({ events: [event] }))).read('runs/001-r1/events/001-tool-t.md')
    expect(text).toContain('- keys: {"10":4,"9":5,"b":3,"😀":2,"Ａ":1}\n')
    expect(text).toContain(
      '- n: [1e-7,0.000001,1e+21,100000000000000000000,-2.5e-8,2,0,0.3333333333333333,null]\n',
    )
  })

  it('wants a since for new runs', async () => {
    await expect(
      Trace.create([], { session: 's', commit: 'c', harness: 'h', new: ['r'] }),
    ).rejects.toThrow('pass since')
  })

  it("says a run with no known changes isn't known", async () => {
    const t = await trace(run())
    expect(t.read('index.md')).toContain('files:-')
    expect(t.read('runs/001-r1/changed.md')).toContain('Not known')
  })
})

describe('commits', () => {
  it('read from their corpus form', () => {
    const commit: TraceCommit = commitFromBody({
      id: 'abc1234',
      tool: 'terminal',
      added: ['b', 'a'],
    })
    expect(commit).toEqual({
      id: 'abc1234',
      tool: 'terminal',
      added: ['b', 'a'],
      modified: [],
      removed: [],
    })
  })

  it.each(['foo.py', 3, ['a', 1]])('want a list of paths, not %j', (paths) => {
    expect(() => commitFromBody({ id: 'abc1234', added: paths })).toThrow('list of paths')
  })
})

const turn = (...ids: string[]) => ({
  tool: 'turn',
  runs: Object.fromEntries(ids.map((i) => [i, 'completed'])),
})
const ranges = (runs: string[], infos: Record<string, unknown>[]) =>
  Object.fromEntries(runRanges(runs, infos))

describe('run ranges', () => {
  it('are what came after the run before, through the run’s landing', () => {
    const infos = [{}, { tool: 'put' }, turn('a'), { tool: 'terminal' }, turn('b')]
    expect(ranges(['a', 'b'], infos)).toEqual({ a: [0, 3], b: [3, 5] })
  })

  it('end at the last landing', () => {
    // a checkpoint, then the end: the work between them is the run's
    const infos = [turn('a'), { tool: 'terminal' }, turn('a'), turn('b')]
    expect(ranges(['a', 'b'], infos)).toEqual({ a: [0, 3], b: [3, 4] })
  })

  it('count only turns as landings', () => {
    const infos = [
      { tool: 'fold', folded: 3 },
      { tool: 'fold', runs: 3 },
      { tool: 'x', runs: { a: 'done' } },
    ]
    expect(ranges(['a'], infos)).toEqual({})
    expect(ranges(['a'], [{ tool: 'turn', runs: ['a'] }])).toEqual({ a: [0, 1] })
  })

  it('leave a run that never landed out, taking nothing', () => {
    const infos = [turn('a'), { tool: 'terminal' }, turn('c')]
    expect(ranges(['a', 'b', 'c'], infos)).toEqual({ a: [0, 1], c: [1, 3] })
  })

  it("start a child's first run at its fork", () => {
    const parent = { tool: 'fork', child: 'c', inherit: 'fresh' }
    const child = { tool: 'fork', parent: 'p', inherit: 'fresh' }
    // the parent's own commit before the fork is no boundary
    const infos = [{ tool: 'terminal' }, parent, child, { tool: 'x' }, turn('c')]
    expect(ranges(['c'], infos)).toEqual({ c: [3, 5] })
    // nor is anything after the fork, and nontainer's marker is one too
    const theirs = [{ tool: 'terminal' }, { tool: FORK_TOOL }, { tool: 'x' }, turn('c')]
    expect(ranges(['c'], theirs)).toEqual({ c: [2, 4] })
  })

  it("leave the parent's runs their ranges past a fork", () => {
    const infos = [
      { tool: 'x' },
      turn('p'),
      { tool: 'put' },
      { tool: 'fork', parent: 'parent', inherit: 'full' },
      { tool: 'y' },
      turn('c'),
    ]
    expect(ranges(['p', 'c'], infos)).toEqual({ p: [0, 2], c: [4, 6] })
  })

  it('are empty for a run landing before the run before it', () => {
    const [start, end] = runRanges(['a', 'b'], [turn('b'), turn('a')]).get('b') ?? []
    expect((start as number) >= (end as number)).toBe(true)
  })
})
