/**
 * What crosses the worker's boundary by value: typed host objects
 * (each argument checked against its schema on the host, the result
 * against its own), and live values refused where they would cross,
 * naming where. Runs the built Node worker.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type Profile,
  Store,
  Unencodable,
  type Workspace,
  hostFactory,
  typedHost,
  withCall,
} from '../src/index'
import { newKV } from './backends'

const WORKER = new URL('../dist/worker.node.js', import.meta.url)

beforeAll(() => {
  if (!existsSync(fileURLToPath(WORKER))) {
    throw new Error('build @agex-ts/world first: the kernel tests run its built Node worker')
  }
})

async function open(profile: Profile = {}): Promise<Workspace> {
  const store = await Store.open(await newKV())
  return store.open('s', {
    profile: { ...profile, code: { worker: { target: 'node', url: WORKER } } },
  })
}

/** What code saw: each line's value, or its error as `name: message`. */
async function seen(ws: Workspace, body: string): Promise<unknown[]> {
  const out = await ws.runCode(`
    const seen = []
    const attempt = async (f) => {
      try { seen.push(await f()) } catch (e) { seen.push(e.name + ': ' + e.message) }
    }
    ${body}
    return seen
  `)
  if (out.error !== null) throw new Error(`${out.error.name}: ${out.error.message}`)
  return JSON.parse(out.value as string) as unknown[]
}

const Item = z.object({ id: z.number(), tags: z.array(z.string()) })

class Catalog {
  readonly got: unknown[] = []
  search(query: string, limit = 10): { id: number; tags: string[] }[] {
    this.got.push([query, limit])
    return [{ id: 1, tags: [query] }].slice(0, limit)
  }
  add(item: unknown): number {
    this.got.push(item)
    return 1
  }
  broken(): unknown {
    return [{ id: 'one', tags: [] }]
  }
  hidden(): string {
    return 'not in the contract'
  }
}

const contract = {
  search: {
    args: { query: z.string(), limit: z.number().int().optional() },
    returns: z.array(Item),
  },
  add: { args: [Item] },
  broken: { returns: z.array(Item) },
}

describe('a typed host object', () => {
  it('checks each argument on the host, naming where it does not fit', async () => {
    const catalog = new Catalog()
    const ws = await open({ hostObjects: { catalog: typedHost(catalog, contract) } })
    expect(
      await seen(
        ws,
        `
        await attempt(() => catalog.search('a'))
        await attempt(() => catalog.search('a', 0))
        await attempt(() => catalog.search(42))
        await attempt(() => catalog.search('a', 1.5))
        await attempt(() => catalog.search('a', 1, 'extra'))
        await attempt(() => catalog.add({ id: 1, tags: ['x', 2] }))
        await attempt(() => catalog.add({ id: 2, tags: [] }))
      `,
      ),
    ).toEqual([
      [{ id: 1, tags: ['a'] }],
      [],
      expect.stringMatching(/^TypeError: catalog\.search: at query: .*string/i),
      expect.stringMatching(/^TypeError: catalog\.search: at limit: .*int/i),
      'TypeError: catalog.search takes 2 arguments, not 3',
      expect.stringMatching(/^TypeError: catalog\.add: at argument 1\.tags\[1\]: .*string/i),
      1,
    ])
    // A trailing argument left out stays out, so the method's default applies.
    expect(catalog.got).toEqual([['a', 10], ['a', 0], { id: 2, tags: [] }])
    await ws.close()
  })

  it('exposes only the methods its contract names', async () => {
    const ws = await open({ hostObjects: { catalog: typedHost(new Catalog(), contract) } })
    expect(
      await seen(
        ws,
        `
        seen.push(typeof catalog.hidden, Object.keys(catalog).sort())
        await attempt(() => host.catalog.hidden())
      `,
      ),
    ).toEqual([
      'undefined',
      ['add', 'broken', 'search'],
      'TypeError: host.catalog.hidden is not a function',
    ])
    await ws.close()
  })

  it('checks a result before it goes back to the code', async () => {
    const ws = await open({ hostObjects: { catalog: typedHost(new Catalog(), contract) } })
    expect(await seen(ws, 'await attempt(() => catalog.broken())')).toEqual([
      expect.stringMatching(
        /^TypeError: catalog\.broken returned a value that doesn't fit its declared type: at \[0\]\.id: /,
      ),
    ])
    await ws.close()
  })

  it('hands the method what the schemas give back', async () => {
    const got: unknown[] = []
    const clock = {
      after(when: Date, days: number): string {
        got.push(when instanceof Date)
        return new Date(when.getTime() + days * 86_400_000).toISOString().slice(0, 10)
      },
    }
    const ws = await open({
      hostObjects: {
        clock: typedHost(clock, {
          after: { args: [z.string().transform((s) => new Date(s)), z.number()] },
        }),
      },
    })
    expect(await seen(ws, `await attempt(() => clock.after('2026-01-30', 3))`)).toEqual([
      '2026-02-02',
    ])
    expect(got).toEqual([true])
    await ws.close()
  })

  it('works over a factory and a withCall method', async () => {
    const ws = await open({
      hostObjects: {
        notes: typedHost(
          hostFactory((world) => ({
            save: withCall(async (call, path: string, text: string) => {
              await call?.ws.files.write(path, text)
              return world.session
            }),
          })),
          { save: { args: [z.string(), z.string()], returns: z.string() } },
        ),
      },
    })
    expect(
      await seen(
        ws,
        `
        await attempt(() => notes.save('a.txt', 'hi'))
        await attempt(() => notes.save('b.txt', 3))
      `,
      ),
    ).toEqual(['s', expect.stringMatching(/^TypeError: notes\.save: at argument 2: /)])
    expect(await ws.files.readText('a.txt')).toBe('hi')
    expect(await ws.files.exists('b.txt')).toBe(false)
    await ws.close()
  })

  it('is refused when its contract names a method it lacks, or holds no schema', async () => {
    const store = await Store.open(await newKV())
    await expect(
      store.open('s', { profile: { hostObjects: { c: typedHost(new Catalog(), { nope: {} }) } } }),
    ).rejects.toThrow('host object c: its contract names nope, not among its methods')
    await expect(
      store.open('t', {
        profile: {
          hostObjects: {
            c: typedHost(
              hostFactory(() => new Catalog()),
              { nope: {} },
            ),
          },
        },
      }),
    ).rejects.toThrow('host object c: its contract names nope, not among its methods')
    expect(() => typedHost(new Catalog(), { search: { args: [String as never] } })).toThrow(
      'typedHost: search has something other than a Standard Schema',
    )
    expect(() => typedHost(new Catalog(), {})).toThrow('a contract names at least one method')
  })
})

describe('the boundary', () => {
  class Point {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
    norm(): number {
      return Math.hypot(this.x, this.y)
    }
  }

  it('refuses a live argument in the code, naming where it is', async () => {
    const ws = await open({ hostObjects: { sink: { take: (v: unknown) => v } } })
    expect(
      await seen(
        ws,
        `
        class Local { m() {} }
        await attempt(() => sink.take({ ok: 1 }))
        await attempt(() => sink.take({ cb: [() => 1] }))
        await attempt(() => sink.take(1, new Local()))
        await attempt(() => cache.set('k', { when: Promise.resolve(1) }))
      `,
      ),
    ).toEqual([
      { ok: 1 },
      "DataCloneError: sink.take: an argument can't be sent to the host (argument 1 can't be sent by value: at cb[0]: a live function)",
      "DataCloneError: sink.take: an argument can't be sent to the host (argument 2 can't be sent by value: a live Local)",
      "DataCloneError: cache.set: an argument can't be sent to the host (argument 2 can't be sent by value: at when: a live Promise)",
    ])
    await ws.close()
  })

  it("refuses a result holding a class's instance, rather than send it changed", async () => {
    const ws = await open({
      hostObjects: { geo: { origin: () => ({ at: [new Point(3, 4)] }), plain: () => ({ x: 3 }) } },
    })
    expect(
      await seen(
        ws,
        `
        await attempt(() => geo.origin())
        await attempt(() => geo.plain())
      `,
      ),
    ).toEqual([
      "DataCloneError: geo.origin returned a value that can't be sent to code by value (at at[0]: a live Point)",
      { x: 3 },
    ])
    await ws.close()
  })

  it('keeps out of the cache what it could not store as itself', async () => {
    const ws = await open()
    expect(() => ws.cache.set('p', { p: new Point(1, 2) })).toThrow(Unencodable)
    expect(() => ws.cache.set('b', new ArrayBuffer(2))).toThrow(
      "can't be stored: an ArrayBuffer, which isn't stored as itself (store a Uint8Array)",
    )
    ws.cache.set('ok', new Map([['k', new Uint8Array([1])]]))
    expect(await ws.cache.get('ok')).toEqual(new Map([['k', new Uint8Array([1])]]))
    await ws.close()
  })
})
