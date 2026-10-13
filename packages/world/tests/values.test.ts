/**
 * Values: what can be carried by value, the stored encoding, and
 * checks against a declared type (a Standard Schema; zod here).
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Malformed,
  Mismatch,
  Store,
  TooLarge,
  Unencodable,
  VALUE_FORMAT,
  check,
  copy,
  decode,
  encode,
  findLive,
  isSchema,
  jsonSchemaOf,
} from '../src/index'

class Client {
  ping(): string {
    return 'pong'
  }
}

describe('findLive', () => {
  it('finds nothing in data', () => {
    const data = {
      n: 1,
      s: 'x',
      big: 2n,
      none: null,
      gone: undefined,
      list: [1, [2, { deep: true }]],
      bytes: new Uint8Array([1, 2]),
      floats: new Float64Array([1.5]),
      buffer: new ArrayBuffer(2),
      when: new Date(0),
      re: /a+/g,
      map: new Map<unknown, unknown>([[{ k: 1 }, 'v']]),
      set: new Set([1, 'a']),
      err: new TypeError('x'),
      bare: Object.assign(Object.create(null), { a: 1 }),
    }
    expect(findLive(data)).toBeNull()
  })

  it('names where a live part is', () => {
    expect(findLive(() => 1)).toBe('a live function')
    expect(findLive({ a: [1, { cb: () => 1 }] })).toBe('at a[1].cb: a live function')
    expect(findLive([new Client()])).toBe('at [0]: a live Client')
    expect(findLive({ 'a key': Promise.resolve(1) })).toBe('at ["a key"]: a live Promise')
    expect(findLive(new Map([['k', new WeakMap()]]))).toBe('at ["k"]: a live WeakMap')
    expect(findLive(new Set([1, Symbol('s')]))).toBe('at <item 1>: a symbol')
    expect(findLive({ [Symbol('t')]: 1 })).toBe("a symbol key (Symbol(t)), which doesn't cross")
    expect(
      findLive({
        get x() {
          return 1
        },
      }),
    ).toBe('at x: a live getter')
    class Rows extends Map {}
    expect(findLive({ rows: new Rows() })).toBe('at rows: a live Rows')
  })

  it('refuses shared memory, which would cross as the same memory', () => {
    const shared = new SharedArrayBuffer(4)
    expect(findLive({ buf: shared })).toBe(
      'at buf: a SharedArrayBuffer: shared memory, not sent by value',
    )
    expect(findLive([new Int32Array(shared)])).toBe(
      'at [0]: a Int32Array over a SharedArrayBuffer: shared memory, not sent by value',
    )
    expect(findLive(new DataView(shared))).toBe(
      'a DataView over a SharedArrayBuffer: shared memory, not sent by value',
    )
    expect(() => encode({ buf: shared })).toThrow(Unencodable)
  })

  it("looks at an array's other properties, which structured clone carries", () => {
    const items: unknown[] & { client?: Client } = [1, 2]
    items.client = new Client()
    expect(findLive({ items })).toBe('at items.client: a live Client')
    const tagged: unknown[] & { note?: string } = [1]
    tagged.note = 'ok'
    expect(findLive(tagged)).toBeNull()
    const gotten: unknown[] = [1]
    Object.defineProperty(gotten, 0, { get: () => 1, enumerable: true })
    expect(findLive(gotten)).toBe('at [0]: a live getter')
    expect(() => encode(tagged)).toThrow(
      'can\'t be stored: an array with a property "note", which isn\'t stored',
    )
    const holey: number[] = []
    holey[0] = 1
    holey[2] = 3
    expect(decode(encode(holey))).toEqual([1, undefined, 3])
  })

  it('lets a value hold itself, which structured clone carries', () => {
    const loop: Record<string, unknown> = { n: 1 }
    loop.self = loop
    expect(findLive(loop)).toBeNull()
  })
})

describe('encode and decode', () => {
  it('round-trip data with its types', () => {
    const value = {
      n: 1.5,
      big: 2n ** 70n,
      list: [1, undefined, 'x'],
      bytes: new Uint8Array([1, 2, 3]),
      ints: new Int16Array([-1, 2]),
      when: new Date(5),
      re: /a+/gi,
      map: new Map<unknown, unknown>([
        [1, 'one'],
        [{ k: 1 }, [2]],
      ]),
      set: new Set(['a', 'b']),
      nan: Number.NaN,
    }
    const blob = encode(value)
    expect(new TextDecoder().decode(blob.subarray(0, VALUE_FORMAT.length))).toBe(VALUE_FORMAT)
    expect(decode(blob)).toEqual(value)
  })

  it('refuse a live part, and what the encoding would change', () => {
    const refused = (v: unknown) => {
      try {
        encode(v)
      } catch (e) {
        expect(e).toBeInstanceOf(Unencodable)
        return (e as Error).message
      }
      throw new Error('encoded')
    }
    expect(refused({ c: new Client() })).toBe("can't be stored: at c: a live Client")
    expect(refused([new ArrayBuffer(1)])).toBe(
      "can't be stored: at [0]: an ArrayBuffer, which isn't stored as itself (store a Uint8Array)",
    )
    expect(refused({ e: new Error('x') })).toBe(
      "can't be stored: at e: an Error, which isn't stored as itself",
    )
    const loop: unknown[] = []
    loop.push(loop)
    expect(refused(loop)).toBe("can't be stored: at [0]: the value again: a value holding itself")
    expect(refused(JSON.parse('{"__proto__": 1}'))).toBe(
      "can't be stored: a key named __proto__, which isn't stored as itself",
    )
  })

  it('keep a value shared in two places, as two copies', () => {
    const shared = { a: 1 }
    const out = decode(encode([shared, shared])) as unknown[]
    expect(out).toEqual([{ a: 1 }, { a: 1 }])
  })

  it('refuse a value over its limit, and bytes that are not a value', () => {
    expect(() => encode('x'.repeat(100), { limit: 50 })).toThrow(TooLarge)
    expect(() => decode(new TextEncoder().encode('{"a":1}'))).toThrow(Malformed)
    const blob = encode({ a: [1, 2, 3] })
    expect(() => decode(blob.subarray(0, blob.length - 2))).toThrow(Malformed)
  })

  it('store a value in a session as bytes', async () => {
    const ws = await (await Store.open(new Memory())).open('s')
    await ws.files.write('value.bin', encode(new Map([['k', new Set([1])]])))
    expect(decode(await ws.files.read('value.bin'))).toEqual(new Map([['k', new Set([1])]]))
    await ws.close()
  })
})

describe('copy', () => {
  it('is deep, and refuses what encode refuses', () => {
    const value = { list: [1, { n: 2 }], bytes: new Uint8Array([1]) }
    const out = copy(value)
    expect(out).toEqual(value)
    out.list.push(3)
    ;(out.list[1] as { n: number }).n = 9
    out.bytes[0] = 7
    expect(value).toEqual({ list: [1, { n: 2 }], bytes: new Uint8Array([1]) })
    expect(() => copy({ c: new Client() })).toThrow(Unencodable)
  })
})

describe('check', () => {
  const Score = z.object({ name: z.string(), total: z.number() })

  it('gives back what the schema gives', async () => {
    expect(await check({ name: 'a', total: 3 }, Score)).toEqual({ name: 'a', total: 3 })
    const Day = z.string().transform((s) => new Date(s))
    expect(await check('2026-01-02', Day)).toEqual(new Date('2026-01-02'))
  })

  it('names where a value does not fit, without coercing', async () => {
    const scores = z.object({ scores: z.array(Score) })
    const bad = {
      scores: [
        { name: 'a', total: 1 },
        { name: 'b', total: '2' },
      ],
    }
    const e = await check(bad, scores).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Mismatch)
    expect(e).toBeInstanceOf(TypeError)
    expect((e as Mismatch).where).toBe('scores[1].total')
    expect((e as Mismatch).message).toMatch(/^at scores\[1\]\.total: .*number/i)
    expect((e as Mismatch).issues).toHaveLength(1)
    await expect(check(42, z.string())).rejects.toThrow(/^(?!at ).*string/i)
  })

  it('reports how many more issues there are', async () => {
    const e = (await check({}, Score).catch((x: unknown) => x)) as Mismatch
    expect(e.issues).toHaveLength(2)
    expect(e.message).toMatch(/\(and 1 more\)$/)
  })

  it('refuses what is not a Standard Schema', async () => {
    expect(isSchema(Score)).toBe(true)
    expect(isSchema({ parse: () => 1 })).toBe(false)
    await expect(check(1, { parse: () => 1 } as never)).rejects.toThrow(/Standard Schema/)
  })
})

describe('jsonSchemaOf', () => {
  it("is the library's own JSON Schema, or null without one", () => {
    const schema = jsonSchemaOf(z.object({ q: z.string(), limit: z.number().optional() }))
    expect(schema).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'number' } },
      required: ['q'],
    })
    const bare = {
      '~standard': { version: 1, vendor: 'x', validate: (v: unknown) => ({ value: v }) },
    }
    expect(jsonSchemaOf(bare as never)).toBeNull()
  })
})
