import { describe, expect, it } from 'vitest'
import { type JsonStringDelta, JsonStringExtractor } from '../src/json-stream'

function feedAll(json: string, chunkSize?: number): JsonStringDelta[] {
  const ex = new JsonStringExtractor()
  const out: JsonStringDelta[] = []
  if (chunkSize === undefined) {
    out.push(...ex.feed(json))
    return out
  }
  for (let i = 0; i < json.length; i += chunkSize) {
    out.push(...ex.feed(json.slice(i, i + chunkSize)))
  }
  return out
}

function reassemble(deltas: ReadonlyArray<JsonStringDelta>): Map<string, string> {
  const acc = new Map<string, string>()
  for (const d of deltas) {
    if (d.done) continue
    acc.set(d.key, (acc.get(d.key) ?? '') + d.content)
  }
  return acc
}

function closedKeys(deltas: ReadonlyArray<JsonStringDelta>): string[] {
  return deltas.filter((d) => d.done).map((d) => d.key)
}

describe('JsonStringExtractor — happy path', () => {
  it('extracts top-level string values from a single feed', () => {
    const deltas = feedAll('{"a":"hello","b":"world"}')
    expect(reassemble(deltas)).toEqual(
      new Map([
        ['a', 'hello'],
        ['b', 'world'],
      ]),
    )
    expect(closedKeys(deltas)).toEqual(['a', 'b'])
  })

  it('handles arbitrary chunk-boundary splits', () => {
    const json = '{"code":"function f() { return 1 }","title":"t"}'
    for (const chunkSize of [1, 2, 3, 5, 7, 11]) {
      const deltas = feedAll(json, chunkSize)
      expect(reassemble(deltas)).toEqual(
        new Map([
          ['code', 'function f() { return 1 }'],
          ['title', 't'],
        ]),
      )
      expect(closedKeys(deltas)).toEqual(['code', 'title'])
    }
  })

  it('skips non-string values without emitting deltas for them', () => {
    const deltas = feedAll(
      '{"flag":true,"n":42,"s":"hi","null_val":null,"obj":{"k":"v"},"arr":[1,2]}',
    )
    // Only `s` is a top-level string value.
    expect(reassemble(deltas)).toEqual(new Map([['s', 'hi']]))
    expect(closedKeys(deltas)).toEqual(['s'])
  })

  it('handles whitespace between tokens', () => {
    const deltas = feedAll('  {  "a"  :  "x"  ,  "b"  :  "y"  }  ')
    expect(reassemble(deltas)).toEqual(
      new Map([
        ['a', 'x'],
        ['b', 'y'],
      ]),
    )
  })
})

describe('JsonStringExtractor — escapes', () => {
  it('decodes simple escapes: \\\\, \\", \\n, \\t, \\r, \\b, \\f, \\/', () => {
    const deltas = feedAll('{"s":"a\\"b\\\\c\\nd\\te\\rf\\bg\\fh\\/i"}')
    expect(reassemble(deltas).get('s')).toBe('a"b\\c\nd\te\rf\bg\fh/i')
  })

  it('decodes \\uXXXX escapes, even when split across chunks', () => {
    // U+00E9 = é (Latin small letter e with acute)
    const json = '{"s":"caf\\u00e9!"}'
    // Split right in the middle of é
    for (const chunkSize of [1, 2, 3, 4, 5, 6, 7]) {
      const deltas = feedAll(json, chunkSize)
      expect(reassemble(deltas).get('s')).toBe('café!')
    }
  })

  it('decodes \\u for a 4-byte BMP character (smiley needs surrogate pair)', () => {
    // U+1F600 grinning face — JSON encodes it as a UTF-16 surrogate pair: 😀
    const json = '{"s":"\\uD83D\\uDE00"}'
    const deltas = feedAll(json)
    // We just emit each \u as its code point and let surrogate pairs
    // recombine via String.fromCodePoint when concatenated.
    const got = reassemble(deltas).get('s') ?? ''
    expect(got).toBe('😀')
  })

  it('emits replacement char for malformed \\uXXXX', () => {
    const deltas = feedAll('{"s":"\\uZZZZ"}')
    expect(reassemble(deltas).get('s')).toBe('�')
  })
})

describe('JsonStringExtractor — partial / open-ended streams', () => {
  it('emits an interim delta when the chunk ends mid-string', () => {
    const ex = new JsonStringExtractor()
    const part1 = ex.feed('{"code":"hello, ')
    expect(part1).toEqual([{ key: 'code', content: 'hello, ', done: false }])
    expect(part1.some((d) => d.done)).toBe(false)
    const part2 = ex.feed('world"}')
    expect(part2).toEqual([
      { key: 'code', content: 'world', done: false },
      { key: 'code', content: '', done: true },
    ])
  })

  it('does not emit done before the closing quote', () => {
    const ex = new JsonStringExtractor()
    const deltas = ex.feed('{"s":"abc')
    expect(deltas).toEqual([{ key: 's', content: 'abc', done: false }])
    // No done yet.
    expect(deltas.some((d) => d.done)).toBe(false)
  })
})

describe('JsonStringExtractor — robustness', () => {
  it('tolerates an empty object', () => {
    expect(feedAll('{}')).toEqual([])
  })

  it('handles keys with escapes', () => {
    const deltas = feedAll('{"a\\"b":"v"}')
    expect(reassemble(deltas).get('a"b')).toBe('v')
  })
})
