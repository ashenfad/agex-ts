/**
 * KVStore conformance suite.
 *
 * Backend-agnostic tests that any `KVStore` implementation must
 * satisfy. Consumers (memory, idb, opfs, sqlite, custom) call
 * `runConformance(name, makeStore)` from a `*.test.ts` file; the
 * suite registers `describe`/`it` blocks in their test environment.
 *
 * `makeStore` should return a *fresh* store on each call. The suite
 * uses one store per top-level test for isolation.
 */

import { describe, expect, it } from 'vitest'
import type { KVStore } from '../src/types'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export type StoreFactory = () => KVStore | Promise<KVStore>

export function runConformance(name: string, makeStore: StoreFactory): void {
  describe(`${name} — KVStore conformance`, () => {
    describe('get / set / remove / has', () => {
      it('get on a missing key returns null', async () => {
        const s = await makeStore()
        expect(await s.get('absent')).toBeNull()
        expect(await s.has('absent')).toBe(false)
      })

      it('set then get round-trips bytes', async () => {
        const s = await makeStore()
        await s.set('k', bytes('v'))
        const got = await s.get('k')
        expect(got).not.toBeNull()
        expect(bytesEqual(got as Uint8Array, bytes('v'))).toBe(true)
        expect(await s.has('k')).toBe(true)
      })

      it('set overwrites a previous value', async () => {
        const s = await makeStore()
        await s.set('k', bytes('v1'))
        await s.set('k', bytes('v2'))
        expect(bytesEqual((await s.get('k')) as Uint8Array, bytes('v2'))).toBe(true)
      })

      it('remove makes a key absent', async () => {
        const s = await makeStore()
        await s.set('k', bytes('v'))
        await s.remove('k')
        expect(await s.get('k')).toBeNull()
        expect(await s.has('k')).toBe(false)
      })

      it('remove on a missing key is a no-op', async () => {
        const s = await makeStore()
        await expect(s.remove('absent')).resolves.toBeUndefined()
      })
    })

    describe('bulk methods', () => {
      it('setMany inserts multiple at once', async () => {
        const s = await makeStore()
        await s.setMany([
          ['a', bytes('1')],
          ['b', bytes('2')],
          ['c', bytes('3')],
        ])
        expect(bytesEqual((await s.get('a')) as Uint8Array, bytes('1'))).toBe(true)
        expect(bytesEqual((await s.get('b')) as Uint8Array, bytes('2'))).toBe(true)
        expect(bytesEqual((await s.get('c')) as Uint8Array, bytes('3'))).toBe(true)
      })

      it('getMany returns only present keys', async () => {
        const s = await makeStore()
        await s.set('a', bytes('1'))
        await s.set('c', bytes('3'))
        const got = await s.getMany(['a', 'b', 'c'])
        expect(got.size).toBe(2)
        expect(bytesEqual(got.get('a') as Uint8Array, bytes('1'))).toBe(true)
        expect(bytesEqual(got.get('c') as Uint8Array, bytes('3'))).toBe(true)
        expect(got.has('b')).toBe(false)
      })

      it('getMany on an empty key set returns an empty Map', async () => {
        const s = await makeStore()
        await s.set('a', bytes('1'))
        const got = await s.getMany([])
        expect(got.size).toBe(0)
      })

      it('removeMany deletes multiple at once', async () => {
        const s = await makeStore()
        await s.setMany([
          ['a', bytes('1')],
          ['b', bytes('2')],
          ['c', bytes('3')],
        ])
        await s.removeMany(['a', 'c'])
        expect(await s.get('a')).toBeNull()
        expect(bytesEqual((await s.get('b')) as Uint8Array, bytes('2'))).toBe(true)
        expect(await s.get('c')).toBeNull()
      })

      it('removeMany ignores absent keys', async () => {
        const s = await makeStore()
        await s.set('a', bytes('1'))
        await expect(s.removeMany(['a', 'absent'])).resolves.toBeUndefined()
        expect(await s.get('a')).toBeNull()
      })
    })

    describe('cas', () => {
      it('succeeds when expected matches current', async () => {
        const s = await makeStore()
        await s.set('k', bytes('v1'))
        const ok = await s.cas('k', bytes('v2'), bytes('v1'))
        expect(ok).toBe(true)
        expect(bytesEqual((await s.get('k')) as Uint8Array, bytes('v2'))).toBe(true)
      })

      it('fails when expected does not match current', async () => {
        const s = await makeStore()
        await s.set('k', bytes('v1'))
        const ok = await s.cas('k', bytes('v2'), bytes('different'))
        expect(ok).toBe(false)
        expect(bytesEqual((await s.get('k')) as Uint8Array, bytes('v1'))).toBe(true)
      })

      it("succeeds with expected=null when key doesn't exist", async () => {
        const s = await makeStore()
        const ok = await s.cas('k', bytes('v'), null)
        expect(ok).toBe(true)
        expect(bytesEqual((await s.get('k')) as Uint8Array, bytes('v'))).toBe(true)
      })

      it('fails with expected=null when key already exists', async () => {
        const s = await makeStore()
        await s.set('k', bytes('existing'))
        const ok = await s.cas('k', bytes('v'), null)
        expect(ok).toBe(false)
        expect(bytesEqual((await s.get('k')) as Uint8Array, bytes('existing'))).toBe(true)
      })

      it('fails when key is absent and expected is non-null', async () => {
        const s = await makeStore()
        const ok = await s.cas('k', bytes('v'), bytes('expected-something'))
        expect(ok).toBe(false)
        expect(await s.get('k')).toBeNull()
      })
    })

    describe('iteration', () => {
      it('keys() yields all stored keys', async () => {
        const s = await makeStore()
        await s.setMany([
          ['a', bytes('1')],
          ['b', bytes('2')],
          ['c', bytes('3')],
        ])
        const got = new Set<string>()
        for await (const k of s.keys()) got.add(k)
        expect(got).toEqual(new Set(['a', 'b', 'c']))
      })

      it('keys() on an empty store yields nothing', async () => {
        const s = await makeStore()
        const got: string[] = []
        for await (const k of s.keys()) got.push(k)
        expect(got).toEqual([])
      })

      it('items() yields all (key, value) pairs', async () => {
        const s = await makeStore()
        await s.setMany([
          ['a', bytes('1')],
          ['b', bytes('2')],
        ])
        const got = new Map<string, Uint8Array>()
        for await (const [k, v] of s.items()) got.set(k, v)
        expect(got.size).toBe(2)
        expect(bytesEqual(got.get('a') as Uint8Array, bytes('1'))).toBe(true)
        expect(bytesEqual(got.get('b') as Uint8Array, bytes('2'))).toBe(true)
      })
    })

    describe('clear', () => {
      it('removes everything', async () => {
        const s = await makeStore()
        await s.setMany([
          ['a', bytes('1')],
          ['b', bytes('2')],
        ])
        await s.clear()
        expect(await s.get('a')).toBeNull()
        expect(await s.get('b')).toBeNull()
        const remaining: string[] = []
        for await (const k of s.keys()) remaining.push(k)
        expect(remaining).toEqual([])
      })
    })

    describe('byte fidelity', () => {
      it('round-trips arbitrary byte sequences including nulls and high bytes', async () => {
        const s = await makeStore()
        const payload = new Uint8Array([0, 1, 2, 254, 255, 0, 128])
        await s.set('k', payload)
        const got = (await s.get('k')) as Uint8Array
        expect(got.length).toBe(payload.length)
        for (let i = 0; i < payload.length; i++) {
          expect(got[i]).toBe(payload[i])
        }
      })

      it('handles a large payload (1 MiB)', async () => {
        const s = await makeStore()
        const big = new Uint8Array(1024 * 1024)
        for (let i = 0; i < big.length; i++) big[i] = i & 0xff
        await s.set('big', big)
        const got = (await s.get('big')) as Uint8Array
        expect(got.length).toBe(big.length)
        // Spot-check a few positions; full byte-by-byte would be slow
        // and isn't more informative.
        expect(got[0]).toBe(0)
        expect(got[255]).toBe(255)
        expect(got[1000]).toBe(1000 & 0xff)
        expect(got[big.length - 1]).toBe((big.length - 1) & 0xff)
      })
    })
  })
}
