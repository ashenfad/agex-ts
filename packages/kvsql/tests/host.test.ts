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
import { type DatabaseConfig, MemoryDirectory, type Opener, lockName, openLog } from '../src/index'
import { Disk, type FakeWorker, Origin, until } from './host-fakes'
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
    expect(info).toMatchObject({ holder: 'a', name: 'db.sqlite', branch: 'kvsql/test/0', seq: 2 })
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
    // An export from a forwarding tab is the holder's file.
    const exported = await b.export()
    expect(new TextDecoder().decode(exported.subarray(0, 15))).toBe('SQLite format 3')
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
    expect(info.recovery).toEqual({
      ownFlush: false,
      entries: 0,
      transactions: 0,
      rebased: 0,
      snapshot: false,
      stayed: null,
    })
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
    expect(info.recovery).toEqual({
      ownFlush: false,
      entries: 0,
      transactions: 0,
      rebased: 0,
      snapshot: false,
      stayed: null,
    })
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

describe('announcements out of order', () => {
  type Message = { t: string }
  const t = (m: unknown) => (m as Message).t

  /** Three tabs: o holds, n waits, and f's hello is answered by o late, after o lets go. */
  async function staleAnnouncement(
    o: Origin,
    letGo: (wo: FakeWorker, a: DatabaseClient) => unknown,
  ) {
    const wo = o.worker('o')
    const a = wo.connect(CONFIG)
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const n = client(o.worker('n').connect(CONFIG))
    await until(async () => (await role(n)) === 'forwarding', 3_000, 'n forwarding')
    o.channels.route = (from, to, m) => (from === 'o' && to === 'f' && t(m) === 'holder' ? 300 : 0)
    const mark = o.channels.sent.length
    const f = client(o.worker('f').connect(CONFIG))
    await until(
      () => o.channels.sent.slice(mark).some((s) => s.owner === 'o' && t(s.message) === 'holder'),
      1_000,
      "o's answer to f",
    )
    await letGo(wo, a)
    await until(async () => (await role(n)) === 'holder', 3_000, 'n to hold')
    // o's announcement lands now, after n's.
    await new Promise((r) => setTimeout(r, 400))
    expect(await f.status()).toMatchObject({ role: 'forwarding', holder: 'n' })
    const answer = await Promise.race([
      f.query('INSERT INTO t VALUES (1)'),
      new Promise((r) => setTimeout(() => r('no answer'), 2_000)),
    ])
    expect(answer).toMatchObject({ changes: 1 })
    expect((await n.query('SELECT count(*) AS c FROM t')).rows).toEqual([{ c: 1 }])
  }

  it('ignores a late announcement from a holder that released the lock', async () => {
    await staleAnnouncement(setup(), (_wo, a) => a.close())
  })

  it('ignores a late announcement from a holder that was killed', async () => {
    await staleAnnouncement(setup(), (wo) => wo.kill())
  })

  it('asks for the holder again when it misses the announcement', async () => {
    const o = setup()
    const a = client(o.worker('o').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const n = client(o.worker('n').connect(CONFIG))
    await until(async () => (await role(n)) === 'forwarding', 3_000, 'n forwarding')
    const f = client(o.worker('f').connect(CONFIG))
    await until(async () => (await role(f)) === 'forwarding', 3_000, 'f forwarding')
    // n's announcement on taking the lock never reaches f.
    let dropped = 0
    o.channels.route = (from, to, m) =>
      from === 'n' && to === 'f' && t(m) === 'holder' && dropped++ === 0 ? 'drop' : 0
    const mark = o.channels.sent.length
    await a.close()
    expect((await f.query('INSERT INTO t VALUES (1)')).changes).toBe(1)
    expect(dropped).toBeGreaterThanOrEqual(2)
    expect(await f.status()).toMatchObject({ holder: 'n' })
    const hellos = o.channels.sent
      .slice(mark)
      .filter((s) => s.owner === 'f' && t(s.message) === 'hello')
    expect(hellos.length).toBeGreaterThanOrEqual(1)
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
    await expect(repo.branches.get('kvsql/test/0')).rejects.toBeInstanceOf(UnknownBranchError)
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

  /** Delete through `deleter`'s worker and connect again through it at once, the broadcast late. */
  async function deleteAndReconnect(o: Origin, deleter: 'h' | 'f') {
    const wh = o.worker('h')
    const h = client(wh.connect(CONFIG))
    await h.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await h.query('INSERT INTO t VALUES (1)')
    const wf = o.worker('f')
    const f = client(wf.connect(CONFIG))
    const g = client(o.worker('g').connect(CONFIG))
    await until(async () => (await role(g)) === 'forwarding', 3_000, 'g forwarding')
    // Every `deleted` message takes 300 ms to arrive, within a worker too.
    o.channels.route = (_from, _to, m) => ((m as { t: string }).t === 'deleted' ? 300 : 0)
    const [db, worker] = deleter === 'h' ? [h, wh] : [f, wf]
    await db.delete()
    const again = client(worker.connect(CONFIG))
    const fresh = await again.query("SELECT count(*) AS n FROM sqlite_schema WHERE name = 't'")
    expect(fresh.rows).toEqual([{ n: 0 }])
    await new Promise((r) => setTimeout(r, 400))
    // The late broadcast closed the third tab's old connection, not the new one.
    await expect(g.query('SELECT 1')).rejects.toThrow(/agex\.db was deleted/)
    expect((await again.query('SELECT 1 AS x')).rows).toEqual([{ x: 1 }])
    expect(await again.status()).toMatchObject({ role: 'holder', deleted: false })
  }

  it('lets a forwarding tab connect again right after its delete', async () => {
    await deleteAndReconnect(setup(), 'f')
  })

  it("lets the holder's own tab connect again right after its delete", async () => {
    await deleteAndReconnect(setup(), 'h')
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
    expect(info.recovery).toEqual({
      ownFlush: false,
      entries: 2,
      transactions: 2,
      rebased: 0,
      snapshot: false,
      stayed: null,
    })
    expect(info.pendingCount).toBe(0)
    expect((await b.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
    expect((await a.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
  })
})

describe('copies', () => {
  /** An opener with a disk per database, logs in the origin's store. */
  function disks(o: Origin): Opener {
    const byId = new Map<string, Disk>()
    return async (config) => {
      const disk = byId.get(config.id) ?? new Disk()
      byId.set(config.id, disk)
      return {
        dir: disk.open(),
        ...(config.detached !== true && { repo: await Repo.open(o.store) }),
      }
    }
  }

  const COPY: DatabaseConfig = { id: 'copy', label: 'agex.db', detached: true }

  async function seeded(c: DatabaseClient) {
    await c.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    await c.query("INSERT INTO t VALUES (1, 'one')")
  }

  it('makes a detached copy, which writes nothing to the log', async () => {
    const o = setup()
    const w = o.worker('a', disks(o))
    const db = client(w.connect(CONFIG))
    await seeded(db)
    const result = await db.copy(COPY)
    expect(result).toMatchObject({ seq: 2, schema: 1 })
    // Copying didn't flush.
    expect((await db.info()).pendingCount).toBe(1)

    const copy = client(w.connect(COPY))
    expect(await copy.info()).toMatchObject({ detached: true, branch: '', seq: 2 })
    await copy.query("UPDATE t SET v = 'changed'")
    expect((await copy.query('SELECT v FROM t')).rows).toEqual([{ v: 'changed' }])
    expect((await db.query('SELECT v FROM t')).rows).toEqual([{ v: 'one' }])
    const repo = await Repo.open(o.store)
    expect(await repo.branches.list()).toEqual(['kvsql/test/0'])

    await expect(copy.delete({ keepLog: true })).rejects.toThrow(/no log/)
    await copy.delete()
    expect(await repo.branches.list()).toEqual(['kvsql/test/0'])
  })

  it("makes a logged copy, on a branch from the source's log", async () => {
    const o = setup()
    const w = o.worker('a', disks(o))
    const db = client(w.connect(CONFIG))
    await seeded(db)
    const fork: DatabaseConfig = { id: 'fork', label: 'agex.db', branch: 'kvsql/fork' }
    const { base } = await db.copy(fork)
    const repo = await Repo.open(o.store)
    expect(await repo.branches.get('kvsql/fork')).toBe(base)
    expect(await repo.branches.get('kvsql/test/0')).toBe(base)

    const copy = client(w.connect(fork))
    const info = await copy.info()
    expect(info).toMatchObject({ detached: false, branch: 'kvsql/fork', seq: 2, pendingCount: 0 })
    expect(info.recovery.entries).toBe(0)
    expect((await copy.query('SELECT v FROM t')).rows).toEqual([{ v: 'one' }])
  })

  it('is made by the holder for a forwarding tab', async () => {
    const o = setup()
    const open = disks(o)
    const a = client(o.worker('a', open).connect(CONFIG))
    await seeded(a)
    const wb = o.worker('b', open)
    const b = client(wb.connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding')
    await b.copy(COPY)
    const copy = client(wb.connect(COPY))
    expect((await copy.query('SELECT v FROM t')).rows).toEqual([{ v: 'one' }])
    expect((await copy.status()).role).toBe('holder')
  })

  it('refuses a target that is open, or the database itself', async () => {
    const o = setup()
    const w = o.worker('a', disks(o))
    const db = client(w.connect(CONFIG))
    await seeded(db)
    const copy = client(w.connect(COPY))
    await copy.query('SELECT 1')
    await expect(db.copy(COPY)).rejects.toThrow(/is open, so a copy can't replace it/)
    await expect(db.copy({ ...CONFIG, detached: true })).rejects.toThrow(/onto itself/)
    await expect(db.copy({ id: 'x', detached: true, branch: 'b' })).rejects.toThrow(/no branch/)
  })
})

describe('epochs', () => {
  it('starts one by the holder, for a forwarding tab too, and a rebuild comes from it', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await a.query('INSERT INTO t VALUES (1)')
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    const result = await b.newEpoch()
    expect(result).toMatchObject({ branch: 'kvsql/test/1', previous: 'kvsql/test/0', seq: 2 })
    expect(await a.info()).toMatchObject({ branch: 'kvsql/test/1', pendingCount: 0 })
    await a.query('INSERT INTO t VALUES (2)')

    await b.delete({ keepLog: true })
    const info = await b.info()
    expect(info.recovery).toEqual({
      ownFlush: false,
      entries: 1,
      transactions: 1,
      rebased: 0,
      snapshot: true,
      stayed: null,
    })
    expect((await a.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('deletes every epoch of the log with the database', async () => {
    const o = setup()
    const db = client(o.worker('a').connect(CONFIG))
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.newEpoch()
    await db.newEpoch()
    const repo = await Repo.open(o.store)
    expect(await repo.branches.list()).toEqual(['kvsql/test/2'])
    await db.delete()
    expect(await repo.branches.list()).toEqual([])
  })

  it("tells the storage which of the log's epochs it deleted", async () => {
    const o = setup()
    const deleted: string[][] = []
    const w = o.worker('a', async () => ({
      dir: new MemoryDirectory(),
      repo: await Repo.open(o.store),
      epochsDeleted: (branches: string[]) => deleted.push(branches),
    }))
    const db = client(w.connect(CONFIG))
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.newEpoch()
    expect(deleted).toEqual([['kvsql/test/0']])
  })
})

describe('content hash', () => {
  it('is worked out by the holder, for a forwarding tab too', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL)')
    await a.query('INSERT INTO t VALUES (1)')
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    const hash = await a.contentHash()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await b.contentHash()).toBe(hash)
  })
})

describe('checkpoints', () => {
  it('are taken and restored by the holder, for a forwarding tab too, and every tab sees it', async () => {
    const o = setup()
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await a.query('INSERT INTO t VALUES (1)')
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    const cp = await b.checkpoint('one row')
    expect(cp).toMatchObject({ label: 'one row', seq: 2, auto: false })
    await a.query('ALTER TABLE t ADD COLUMN v TEXT')
    await a.query("INSERT INTO t VALUES (2, 'two')")
    expect((await b.checkpoints()).map((c) => c.auto)).toEqual([false, true])

    expect(await b.restore(cp.id)).toMatchObject({ how: 'epoch', branch: 'kvsql/test/1' })
    expect((await a.query('SELECT * FROM t')).rows).toEqual([{ id: 1 }])
    await a.deleteCheckpoint(cp.id)
    expect((await b.checkpoints()).map((c) => c.auto)).toEqual([true])
  })
})

describe('rebase', () => {
  it("is made by the holder, for a forwarding tab too, onto another copy's entries", async () => {
    const store = new Memory()
    const o = setup(store)
    const a = client(o.worker('a').connect(CONFIG))
    await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v TEXT)')
    await a.flush()
    const b = client(o.worker('b').connect(CONFIG))
    await until(async () => (await role(b)) === 'forwarding', 3_000, 'forwarding')
    // another copy of the database, on another device, flushed first
    const other = await openLog({
      dir: new MemoryDirectory(),
      name: 'other.db',
      repo: await Repo.open(store),
      branch: 'kvsql/test/0',
      flush: { every: 0, maxAgeMs: 0 },
    })
    await other.query("INSERT INTO t VALUES (1, 'other')")
    await other.flush()
    await other.close()
    await a.query("INSERT INTO t VALUES (2, 'a')")
    expect(await b.rebase()).toMatchObject({ status: 'rebased', mine: 1, theirs: 1, seq: 3 })
    expect((await a.query('SELECT * FROM t ORDER BY id')).rows).toEqual([
      { id: 1, v: 'other' },
      { id: 2, v: 'a' },
    ])
    expect(await b.info()).toMatchObject({ pendingCount: 0, seq: 3 })
  })
})
