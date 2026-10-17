/**
 * The worker host and its client in Node, with in-memory locks and
 * channels standing in for the browser's (`host-fakes.ts`): requests
 * and errors across the connection, forwarding between "tabs", and the
 * handoff when the holder closes, is killed, or deletes the database.
 */

import { type KVStore, Repo, UnknownBranchError } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConnectionLostError,
  type DatabaseClient,
  KvsqlError,
  RefusedError,
  StatementError,
} from '../src/client'
import { type DatabaseConfig, MemoryDirectory, lockName } from '../src/index'
import { Origin, until } from './host-fakes'
import { CrashingStore, quietSqliteWarnings } from './log-helpers'

quietSqliteWarnings()

const CONFIG: DatabaseConfig = {
  id: 'test',
  label: 'agex.db',
  // Flushes only when asked, so tests see transactions pending.
  flush: { every: 0, maxAgeMs: 0 },
}

let origin: Origin
const clients: DatabaseClient[] = []

function client(c: DatabaseClient): DatabaseClient {
  clients.push(c)
  return c
}

afterEach(async () => {
  await Promise.all(
    clients
      .splice(0)
      .map((c) =>
        Promise.race([c.close().catch(() => {}), new Promise((r) => setTimeout(r, 200))]),
      ),
  )
  origin?.dispose()
})

function setup(store: KVStore = new Memory()) {
  origin = new Origin(store)
  return origin
}

async function role(c: DatabaseClient): Promise<string> {
  return (await c.status()).role
}

describe('one tab', () => {
  it('queries, runs transactions, flushes and closes through the worker', async () => {
    const o = setup()
    const db = client(o.worker('a').connect(CONFIG))
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, n INTEGER, b BLOB)')
    const results = await db.transaction([
      ['INSERT INTO t VALUES (?, ?, ?)', ['a', 1, new Uint8Array([1, 2, 3])]],
      ['INSERT INTO t VALUES (?, ?, ?)', ['b', 2n ** 60n, null]],
    ])
    expect(results.map((r) => r.changes)).toEqual([1, 1])
    const { rows } = await db.query('SELECT id, n, b FROM t ORDER BY id')
    expect(rows).toEqual([
      { id: 'a', n: 1, b: new Uint8Array([1, 2, 3]) },
      { id: 'b', n: 2n ** 60n, b: null },
    ])
    expect((await db.status()).role).toBe('holder')
    const info = await db.info()
    expect(info).toMatchObject({ holder: 'a', name: 'db.sqlite', branch: 'kvsql/test', seq: 2 })
    // The schema change flushed at once; the insert is pending.
    expect(info.pendingCount).toBe(1)
    expect(await db.flush()).toMatchObject({ from: 2, to: 2 })
    expect(await db.flush()).toBeNull()
    await db.close()
    expect(db.closed).toBe(true)
    await expect(db.query('SELECT 1')).rejects.toThrow(/closed/)
    // Closing let the lock go.
    expect(o.locks.holder(lockName('test'))).toBeUndefined()
  })

  it('rebuilds errors as the classes they were thrown as', async () => {
    const o = setup()
    const db = client(o.worker('a').connect(CONFIG))
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')

    const refused = await db.query('BEGIN').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(RefusedError)
    expect(refused).toBeInstanceOf(KvsqlError)
    expect((refused as Error).name).toBe('RefusedError')
    expect((refused as Error).message).toMatch(/^BEGIN isn't available in agex\.db/)
    expect((refused as Error).cause).toBeInstanceOf(Error)

    const failed = await db
      .transaction([
        ["INSERT INTO t VALUES ('a')", null],
        ["INSERT INTO t VALUES ('a')", null],
      ])
      .catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(StatementError)
    expect((failed as StatementError).index).toBe(1)
    expect((failed as Error).message).toMatch(/^statement 1: .*UNIQUE constraint failed/)
    const cause = (failed as Error).cause as Error & { resultCode?: number }
    expect(cause.name).toBe('SQLite3Error')
    expect(cause.resultCode).toBe(1555)
    expect((await db.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 0 }])

    await expect(db.transaction('nope' as never)).rejects.toBeInstanceOf(TypeError)
  })

  it('reports a database that fails to open, and can still delete it', async () => {
    const o = setup()
    const broken = new MemoryDirectory()
    // A file with a schema but no log position doesn't open as a logged database.
    const raw = await (await import('../src/index')).openDatabase(broken, 'db.sqlite')
    raw.db.exec('CREATE TABLE stray (x)')
    raw.close()
    const w = o.worker('a', async () => ({ dir: broken, repo: await Repo.open(o.store) }))
    const db = client(w.connect(CONFIG))
    await until(async () => (await role(db)) === 'failed', 3_000, 'failed')
    const status = await db.status()
    expect(status.error).toBeInstanceOf(KvsqlError)
    expect((status.error as Error).message).toMatch(/already has a schema/)
    await expect(db.query('SELECT 1')).rejects.toThrow(/already has a schema/)
    await db.delete()
    expect(await broken.exists('db.sqlite')).toBe(false)
    await expect(db.query('SELECT 1')).rejects.toThrow(/agex\.db was deleted/)
  })

  it('refuses a second connect to the same id with another config', async () => {
    const o = setup()
    const w = o.worker('a')
    const db = client(w.connect(CONFIG))
    await db.query('SELECT 1')
    const other = client(w.connect({ ...CONFIG, branch: 'elsewhere' }))
    await expect(other.query('SELECT 1')).rejects.toThrow(/different config/)
    const same = client(w.connect({ ...CONFIG }))
    expect((await same.query('SELECT 2 AS x')).rows).toEqual([{ x: 2 }])
  })

  it('flushes when the page is hidden', async () => {
    const o = setup()
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const window = new EventTarget()
    const db = client(
      o.worker('a').connect(CONFIG, { flushOnHide: true, page: { document, window } }),
    )
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.query('INSERT INTO t VALUES (1)')
    expect((await db.info()).pendingCount).toBe(1)
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 20))
    expect((await db.info()).pendingCount).toBe(1)
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await until(async () => (await db.info()).pendingCount === 0, 1_000, 'flush on hide')
    await db.query('INSERT INTO t VALUES (2)')
    window.dispatchEvent(new Event('pagehide'))
    await until(async () => (await db.info()).pendingCount === 0, 1_000, 'flush on pagehide')
  })

  it('tells every tab when a flush the policy started fails', async () => {
    const store = new CrashingStore(new Memory())
    const o = setup(store)
    const errors: Error[][] = [[], []]
    const config = { ...CONFIG, flush: { every: 1, maxAgeMs: 0 } }
    const a = client(o.worker('a').connect(config, { onFlushError: (e) => errors[0]?.push(e) }))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const b = client(o.worker('b').connect(config, { onFlushError: (e) => errors[1]?.push(e) }))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    store.failNextWrite()
    await b.query('INSERT INTO t VALUES (1)')
    await until(() => errors[0]?.length === 1 && errors[1]?.length === 1, 1_000, 'flush errors')
    expect(errors[1]?.[0]?.name).toBe('StoreCrash')
    const info = await b.info()
    expect(info.pendingCount).toBe(1)
    expect((info.flushError as Error).message).toMatch(/simulated store failure/)
  })
})

describe('tabs', () => {
  it('forwards a second tab to the holder, which sees its writes', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v TEXT)')
    const b = client(o.worker('b').connect(CONFIG))
    // Calls made before the holder is known wait for it.
    expect((await b.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 0 }])
    expect(await b.status()).toMatchObject({ worker: 'b', role: 'forwarding', holder: 'a' })
    await b.query("INSERT INTO t VALUES ('from b', 'x')")
    await a.query("INSERT INTO t VALUES ('from a', 'y')")
    expect((await a.query('SELECT id FROM t ORDER BY id')).rows).toEqual([
      { id: 'from a' },
      { id: 'from b' },
    ])
    expect((await b.info()).holder).toBe('a')
    const refused = await b.query('COMMIT').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(RefusedError)
    const failed = await b.transaction([['SELEC', null]]).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(StatementError)
    expect((failed as StatementError).index).toBe(0)
  })

  it('hands over when the holder closes: its pending transactions are flushed first', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await a.query('INSERT INTO t VALUES (1)')
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    await a.close()
    await until(async () => (await role(b)) === 'holder', 3_000, 'b to hold')
    const info = await b.info()
    expect(info).toMatchObject({ holder: 'b', pendingCount: 0, seq: 2 })
    expect(info.recovery).toEqual({ ownFlush: false, entries: 0, transactions: 0 })
    expect((await b.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
  })

  it('never loses a request to a holder that closes on its own', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    const closing = a.close()
    const writes = Promise.all([1, 2, 3].map((i) => b.query('INSERT INTO t VALUES (?)', [i])))
    await closing
    await writes
    expect((await b.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 3 }])
    expect(await role(b)).toBe('holder')
  })

  it('takes over when the holder is killed, recovering its pending transactions', async () => {
    const o = setup()
    const wa = o.worker('a')
    const a = wa.connect(CONFIG)
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    for (const i of [1, 2, 3]) await a.query('INSERT INTO t VALUES (?)', [i])
    expect((await a.info()).pendingCount).toBe(3)
    const b = client(o.worker('b').connect(CONFIG))
    const c = client(o.worker('c').connect(CONFIG))
    await until(async () => (await role(c)) === 'forwarding', 3_000, 'forwarding')
    wa.kill()
    await until(async () => (await role(b)) === 'holder', 3_000, 'b to hold')
    expect(await c.status()).toMatchObject({ role: 'forwarding', holder: 'b' })
    const info = await c.info()
    expect(info).toMatchObject({ holder: 'b', pendingCount: 3, seq: 4 })
    expect(info.recovery).toEqual({ ownFlush: false, entries: 0, transactions: 0 })
    expect((await c.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 3 }])
    expect(await c.flush()).toMatchObject({ from: 2, to: 4 })
    await c.query('INSERT INTO t VALUES (4)')
    expect((await b.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 4 }])
  })

  it('fails a query in flight to a killed holder, and sends a flush again', async () => {
    const o = setup()
    const wa = o.worker('a')
    const a = wa.connect(CONFIG)
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await a.query('INSERT INTO t VALUES (1)')
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    // a dies as b's requests leave for it, before it can answer.
    let sent = 0
    o.channels.onSend = (owner, message) => {
      if (owner === 'b' && (message as { t: string }).t === 'request' && ++sent === 2) wa.kill()
    }
    const query = b.query('INSERT INTO t VALUES (2)').catch((e: unknown) => e)
    const flush = b.flush()
    const lost = await query
    expect(lost).toBeInstanceOf(ConnectionLostError)
    expect((lost as Error).message).toMatch(/may or may not have committed/)
    expect(await flush).toMatchObject({ from: 2, to: 2 })
    expect(await role(b)).toBe('holder')
    expect((await b.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 1 }])
  })
})

describe('delete', () => {
  it('deletes the file and the branch from any tab, and closes every tab', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await a.query('INSERT INTO t VALUES (1)')
    const b = client(o.worker('b').connect(CONFIG))
    const c = client(o.worker('c').connect(CONFIG))
    await until(async () => (await role(c)) === 'forwarding', 3_000, 'forwarding')
    await b.delete()
    expect(o.disk.dir.names()).toEqual([])
    const repo = await Repo.open(o.store)
    await expect(repo.branches.get('kvsql/test')).rejects.toBeInstanceOf(UnknownBranchError)
    for (const db of [a, b, c]) {
      await expect(db.query('SELECT 1')).rejects.toThrow(/agex\.db was deleted/)
    }
    // Everyone left the lock's queue, so no one opened it again.
    await until(() => o.locks.holder(lockName('test')) === undefined, 2_000, 'lock free')
    expect(o.locks.queue).toEqual([])
    expect(o.disk.dir.names()).toEqual([])
    // A new connection starts a new database.
    const d = client(o.worker('d').connect(CONFIG))
    expect(
      (await d.query("SELECT count(*) AS n FROM sqlite_schema WHERE name = 't'")).rows,
    ).toEqual([{ n: 0 }])
  })

  it('with keepLog, rebuilds the file from the log and goes on serving every tab', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await a.query('INSERT INTO t VALUES (1)')
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    await b.delete({ keepLog: true })
    const info = await b.info()
    expect(info.recovery).toEqual({ ownFlush: false, entries: 2, transactions: 2 })
    expect(info.pendingCount).toBe(0)
    expect((await b.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
    expect((await a.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
  })
})
