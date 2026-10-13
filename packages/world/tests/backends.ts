import type { KVStore } from '@agex-ts/kvgit'
import { IndexedDB } from '@agex-ts/kvgit/backends/idb'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '../src/index'

let dbCount = 0

/** Each backend the suite runs on: a fresh, empty KV store per call. */
export const BACKENDS: ReadonlyArray<readonly [string, () => Promise<KVStore>]> = [
  ['memory', async () => new Memory()],
  ['idb', async () => IndexedDB.open({ dbName: `world-test-${++dbCount}-${Date.now()}` })],
]

export const enc = new TextEncoder()
export const dec = new TextDecoder()
export const text = (b: Uint8Array): string => dec.decode(b)

export async function newStore(make: () => Promise<KVStore>): Promise<Store> {
  return Store.open(await make())
}
