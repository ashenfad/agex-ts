import type { KVStore } from '@agex-ts/kvgit'
import { IndexedDB } from '@agex-ts/kvgit/backends/idb'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '../src/index'

let dbCount = 0

const ALL: ReadonlyArray<readonly [string, () => Promise<KVStore>]> = [
  ['memory', async () => new Memory()],
  ['idb', async () => IndexedDB.open({ dbName: `world-test-${++dbCount}-${Date.now()}` })],
]

/** The backend this run is on (`WORLD_BACKEND`: `memory`, the default,
 *  or `idb`). `vitest.workspace.ts` runs the suite once on each. */
export const BACKEND = process.env.WORLD_BACKEND ?? 'memory'

if (!ALL.some(([name]) => name === BACKEND)) {
  throw new Error(`WORLD_BACKEND=${BACKEND}: the suite runs on memory or idb`)
}

/** The backends this run covers, for a test written over them: a fresh,
 *  empty KV store per call. */
export const BACKENDS = ALL.filter(([name]) => name === BACKEND)

/** A fresh, empty KV store on this run's backend. */
export function newKV(): Promise<KVStore> {
  return (BACKENDS[0] as (typeof ALL)[number])[1]()
}

export const enc = new TextEncoder()
export const dec = new TextDecoder()
export const text = (b: Uint8Array): string => dec.decode(b)

export async function newStore(make: () => Promise<KVStore>): Promise<Store> {
  return Store.open(await make())
}
