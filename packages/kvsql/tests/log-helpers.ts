/** Test helpers for the logged database: stores, crashing stores, dumps. */

import { type KVStore, Repo } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import { afterEach, beforeEach } from 'vitest'
import {
  type Directory,
  type LogOptions,
  type LoggedDatabase,
  MemoryDirectory,
  loadSqlite,
  openLog,
} from '../src/index'

export const NAME = 'app.db'
export const BRANCH = 'db/test/0'

/** A kvgit repository over `store` (a new in-memory one by default). */
export function repoOver(store: KVStore = new Memory()): Promise<Repo<Uint8Array>> {
  return Repo.open(store)
}

/** A copy of an in-memory store: what survives a process. */
export async function copyStore(store: KVStore): Promise<Memory> {
  const copy = new Memory()
  const items: [string, Uint8Array][] = []
  for await (const [k, v] of store.items()) items.push([k, v])
  await copy.setMany(items)
  return copy
}

/** Opens a logged database with no age trigger, unless asked. */
export function open(
  dir: Directory,
  repo: Repo<Uint8Array>,
  options: Partial<LogOptions> = {},
): Promise<LoggedDatabase> {
  return openLog({
    dir,
    name: NAME,
    repo,
    branch: BRANCH,
    label: 'agex.db',
    ...options,
    flush: { maxAgeMs: 0, ...options.flush },
  })
}

/** Opens a fresh copy of the database from its log alone. */
export async function replica(
  repo: Repo<Uint8Array>,
  options: Partial<LogOptions> = {},
): Promise<LoggedDatabase> {
  return open(new MemoryDirectory(), repo, options)
}

/**
 * The database as it stands: its schema (but not where objects are
 * stored), its header and every row of every table, kvsql's own
 * excepted.
 */
export async function dump(log: LoggedDatabase): Promise<unknown> {
  const { rows: schema } = await log.query(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, 7) != '_kvsql_' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name",
  )
  const tables = schema.filter((o) => o.type === 'table' && !String(o.name).startsWith('sqlite_'))
  const out: Record<string, unknown> = {
    schema,
    user_version: (await log.query('PRAGMA user_version')).rows[0]?.user_version,
  }
  for (const { name } of tables) {
    const { rows } = await log.query(`SELECT * FROM "${String(name)}"`)
    const key = (row: Record<string, SqlValue>) =>
      JSON.stringify(Object.values(row), (_k, v) =>
        typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v,
      )
    out[String(name)] = rows.map((r) => ({ ...r })).sort((a, b) => (key(a) < key(b) ? -1 : 1))
  }
  return out
}

/** `PRAGMA integrity_check`'s verdict. */
export async function integrity(log: LoggedDatabase): Promise<unknown> {
  return (await log.query('PRAGMA integrity_check')).rows[0]?.integrity_check
}

/** Thrown by every call of a store that has crashed. */
export class StoreCrash extends Error {
  override readonly name = 'StoreCrash'
}

/**
 * A `KVStore` that passes everything to another until its `n`th write
 * (any of `set`, `setMany`, `cas`, `casMany`, `remove`, `removeMany`,
 * `clear`), which fails without happening, as a process dying there
 * would leave it; every call after throws. `kill()` makes it dead
 * without a crash point. `writes` counts the writes passed through.
 */
export class CrashingStore implements KVStore {
  writes = 0
  readonly trace: string[] = []
  private crashAt: number | null = null
  private dead = false
  private failNext = false
  private loseReply: number | null = null

  constructor(readonly inner: KVStore) {}

  crashAtWrite(n: number): void {
    this.crashAt = this.writes + n
  }

  kill(): void {
    this.dead = true
  }

  /**
   * Lets the `n`th write from now happen, then fails it, as if its
   * reply were lost; the store stays alive.
   */
  loseReplyAt(n: number): void {
    this.loseReply = this.writes + n
  }

  /** Fails the next write without it happening, and stays alive. */
  failNextWrite(): void {
    this.failNext = true
  }

  get crashed(): boolean {
    return this.dead
  }

  private alive(): void {
    if (this.dead) throw new StoreCrash('the store has crashed')
  }

  private write(op: string): void {
    this.alive()
    if (this.failNext) {
      this.failNext = false
      throw new StoreCrash(`simulated store failure (${op})`)
    }
    this.writes++
    this.trace.push(op)
    if (this.crashAt !== null && this.writes === this.crashAt) {
      this.dead = true
      throw new StoreCrash(`simulated store crash at write ${this.writes} (${op})`)
    }
  }

  private landed<T>(result: T): T {
    if (this.loseReply !== null && this.writes === this.loseReply) {
      this.loseReply = null
      throw new StoreCrash(`simulated lost reply after write ${this.writes}`)
    }
    return result
  }

  async get(key: string) {
    this.alive()
    return this.inner.get(key)
  }
  async has(key: string) {
    this.alive()
    return this.inner.has(key)
  }
  async getMany(keys: Iterable<string>) {
    this.alive()
    return this.inner.getMany(keys)
  }
  async *keys(prefix?: string) {
    this.alive()
    yield* this.inner.keys(prefix)
  }
  async *items(prefix?: string) {
    this.alive()
    yield* this.inner.items(prefix)
  }
  async set(key: string, value: Uint8Array) {
    this.write('set')
    return this.landed(await this.inner.set(key, value))
  }
  async remove(key: string) {
    this.write('remove')
    return this.landed(await this.inner.remove(key))
  }
  async setMany(items: Iterable<readonly [string, Uint8Array]>) {
    this.write('setMany')
    return this.landed(await this.inner.setMany(items))
  }
  async removeMany(keys: Iterable<string>) {
    this.write('removeMany')
    return this.landed(await this.inner.removeMany(keys))
  }
  async cas(key: string, value: Uint8Array, expected: Uint8Array | null) {
    this.write('cas')
    return this.landed(await this.inner.cas(key, value, expected))
  }
  async casMany(
    expected: ReadonlyMap<string, Uint8Array | null>,
    writes: ReadonlyMap<string, Uint8Array>,
    removes?: Iterable<string>,
  ) {
    this.write('casMany')
    return this.landed(await this.inner.casMany(expected, writes, removes))
  }
  async clear() {
    this.write('clear')
    return this.landed(await this.inner.clear())
  }
}

/**
 * Silences the SQLite build's console warnings for the enclosing
 * suite: it warns of every failed statement, and crash tests fail many.
 */
export function quietSqliteWarnings(): void {
  let warn: ((...args: unknown[]) => void) | undefined
  beforeEach(async () => {
    const { config } = await loadSqlite()
    warn = config.warn
    config.warn = () => {}
  })
  afterEach(async () => {
    const { config } = await loadSqlite()
    if (warn) config.warn = warn
  })
}

/** A seeded pseudo-random generator (mulberry32), for repeatable workloads. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
