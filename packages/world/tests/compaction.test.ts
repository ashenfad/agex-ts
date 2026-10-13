/**
 * Compaction's record, after nontainer's compaction tests: folds kept
 * in the session's `__compaction__/` plane, the fold in force, the
 * policy, the texts, and the shrinking a fold too large for one request
 * needs.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMPACTION_MARK,
  FOLD_PREFIX,
  type Fold,
  type Item,
  Policy,
  ReadOnlyError,
  Store,
  type Workspace,
  chunks,
  estimateTokens,
  inForce,
  isOurs,
  reduce,
  summaryMessage,
  summaryRequest,
  transcript,
} from '../src/index'

let store: Store
let ws: Workspace

beforeEach(async () => {
  store = await Store.open(new Memory())
  ws = await store.open('s')
})

const fold = (through: string, summary = 'summary', more: Partial<Fold> = {}): Fold => ({
  through,
  summary,
  runs: 0,
  tokensBefore: 0,
  tokensAfter: 0,
  model: '',
  at: 0,
  first: null,
  ...more,
})

const summaries = async (w: Workspace) => (await w.compaction.folds()).map((f) => f.summary)

describe('the record', () => {
  it('records folds in order, never rewritten, with defaults filled in', async () => {
    expect(await ws.compaction.folds()).toEqual([])
    const k1 = await ws.compaction.record({ through: 'a', summary: 'first', runs: 2 })
    const k2 = await ws.compaction.record({ through: 'b', summary: 'second' })
    expect(k1).toBe(`${FOLD_PREFIX}000001`)
    expect(k2 > k1).toBe(true)
    expect(await summaries(ws)).toEqual(['first', 'second'])
    const [first] = await ws.compaction.folds()
    expect(first).toMatchObject({ through: 'a', runs: 2, tokensBefore: 0, model: '', first: null })
    expect(first?.at).toBeGreaterThan(0)
  })

  it('takes one key per fold however many are recorded at once', async () => {
    const keys = await Promise.all(
      ['a', 'b', 'c'].map((through) => ws.compaction.record({ through, summary: through })),
    )
    expect(new Set(keys).size).toBe(3)
    expect(await summaries(ws)).toEqual(['a', 'b', 'c'])
  })

  it("a record with fields this version doesn't know still reads", async () => {
    await ws.compaction.record({ ...fold('m1'), fromTheFuture: true } as Fold)
    expect((await ws.compaction.folds())[0]?.through).toBe('m1')
  })

  it('a frozen workspace records nothing', async () => {
    await ws.files.write('a.txt', 'x')
    await ws.tags.add('v1')
    const frozen = await ws.tags.at('v1')
    await expect(frozen.compaction.record(fold('a'))).rejects.toThrow(ReadOnlyError)
  })
})

describe('the fold in force', () => {
  it('is the latest whose anchor is present', () => {
    const recorded = [fold('a', 'one'), fold('b', 'two'), fold('c', 'three')]
    expect(inForce(recorded, ['x', 'a', 'b', 'c'])?.summary).toBe('three')
    // an edit unsaid the turn the latest fold reached: the one before holds
    expect(inForce(recorded, ['x', 'a', 'b'])?.summary).toBe('two')
    expect(inForce(recorded, ['x'])).toBeNull()
    expect(inForce([], ['a'])).toBeNull()
  })

  it('reads the workspace', async () => {
    await ws.compaction.record(fold('a', 'one'))
    expect((await ws.compaction.inForce(['a']))?.summary).toBe('one')
  })
})

describe('the plane', () => {
  it('a fold rides the next commit, and a rewind takes it back', async () => {
    await ws.terminal('echo one > a.txt')
    const before = ws.head
    await ws.compaction.record(fold('a'))
    expect(ws.uncommitted).toBe(true)
    await ws.terminal('echo two > b.txt') // the turn's next commit carries it
    expect(ws.uncommitted).toBe(false)
    expect(await ws.compaction.folds()).toHaveLength(1)
    await ws.checkout(before)
    expect(await ws.compaction.folds()).toEqual([])
  })

  it('a fresh fork drops the folds and a full one keeps them', async () => {
    await ws.terminal('echo one > a.txt')
    await ws.compaction.record(fold('a', "parent's"))
    await ws.commit({ tool: 'test' })
    const fresh = await ws.fork('kid-fresh', { inherit: 'fresh' })
    const full = await ws.fork('kid-full', { inherit: 'full' })
    expect(await fresh.compaction.folds()).toEqual([])
    expect(await summaries(full)).toEqual(["parent's"])
  })

  it("a merge keeps this session's folds and takes none of the other's", async () => {
    await ws.terminal('echo one > a.txt')
    await ws.compaction.record(fold('a', 'base'))
    await ws.commit({ tool: 'test' })
    const kid = await ws.fork('worker')
    await ws.compaction.record(fold('b', 'ours'))
    await ws.commit({ tool: 'test' })
    await kid.compaction.record(fold('c', 'theirs'))
    await kid.terminal('echo two > b.txt')
    const out = await ws.merge('worker')
    expect(out.merged).toBe(true)
    expect(out.conflicts).toEqual([])
    expect(await summaries(ws)).toEqual(['base', 'ours'])
    expect(await ws.files.readText('/workspace/b.txt')).toBe('two\n')
  })
})

describe('policy and measuring', () => {
  it('says when to fold and what fits', () => {
    const p = new Policy(100, 150)
    expect(p.due(99)).toBe(false)
    expect(p.due(100)).toBe(true)
    expect(p.fits(149)).toBe(true)
    expect(p.fits(150)).toBe(false)
    expect(new Policy(100).fits(10 ** 9)).toBe(true)
  })

  it('refuses a policy that could never fold in time', () => {
    expect(() => new Policy(0)).toThrow(RangeError)
    expect(() => new Policy(200, 100)).toThrow(RangeError)
  })

  it('estimates tokens at four characters each', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('the texts', () => {
  it('the cache-friendly request asks for the summary alone', () => {
    const text = summaryRequest()
    expect(text).toContain('Do not call any tools')
    expect(text).toContain('only ever one summary')
  })

  it('the reduced request carries the transcript and the summary so far', () => {
    const text = summaryRequest('[user]\nhi', { prior: 'earlier', part: 'part 2 of 3' })
    expect(text).toContain('part 2 of 3 of a transcript')
    expect(text).toContain('<summary>\nearlier\n</summary>')
    expect(text.endsWith('<transcript>\n[user]\nhi\n</transcript>')).toBe(true)
  })

  it('the summary message says the person still sees everything', () => {
    const text = summaryMessage('we built a game')
    expect(text.endsWith('we built a game')).toBe(true)
    expect(text).toContain('The person still sees the whole conversation')
  })

  it('recognises marked ids', () => {
    expect(isOurs(`${COMPACTION_MARK}summary:m1`)).toBe(true)
    expect(isOurs('m1')).toBe(false)
    expect(isOurs(null)).toBe(false)
  })
})

describe('a fold too large for one request', () => {
  it('reducing cuts tool output and keeps what was said', () => {
    const said: Item = { role: 'user', text: 'please '.repeat(500) }
    const result: Item = { role: 'tool', text: 'x'.repeat(50_000), kind: 'tool_result' }
    const call: Item = {
      role: 'assistant',
      text: `{"content": "${'y'.repeat(9_000)}"}`,
      kind: 'tool_call',
    }
    const small: Item = { role: 'tool', text: 'ok', kind: 'tool_result' }
    const out = reduce([said, result, call, small])
    expect(out[0]).toEqual(said)
    expect(out[1]?.text.startsWith('[50,000 characters; it began:]')).toBe(true)
    expect(out[1]?.text.length).toBeLessThan(400)
    expect(out[2]?.text.endsWith('more characters]')).toBe(true)
    expect(out[2]?.text.length).toBeLessThan(2100)
    expect(out[3]).toEqual(small)
  })

  it('chunks keep order and split only between items', () => {
    const items: Item[] = Array.from({ length: 10 }, () => ({
      role: 'user',
      text: 'a'.repeat(400),
    }))
    const parts = chunks(items, 250)
    expect(parts.map((p) => p.length)).toEqual([2, 2, 2, 2, 2])
    expect(parts.flat()).toEqual(items)
  })

  it('an item too large for any chunk is cut to fit', () => {
    const huge: Item = { role: 'tool', text: 'z'.repeat(10_000), kind: 'tool_result' }
    const parts = chunks([{ role: 'user', text: 'hi' }, huge, { role: 'user', text: 'bye' }], 100)
    const flat = parts.flat()
    expect(flat.map((i) => i.text.slice(0, 2))).toEqual(['hi', 'zz', 'by'])
    expect(flat[1]?.text.endsWith('[… cut to fit]')).toBe(true)
    for (const p of parts) {
      expect(p.reduce((n, i) => n + estimateTokens(i.text) + 4, 0)).toBeLessThanOrEqual(100)
    }
  })

  it('a transcript labels each kind', () => {
    const text = transcript([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '{}', kind: 'tool_call' },
      { role: 'tool', text: 'ok', kind: 'tool_result' },
    ])
    expect(text).toBe('[user]\nhi\n\n[tool call]\n{}\n\n[tool result]\nok')
  })
})
