/**
 * The worker host in a real browser. Each "tab" is a dedicated worker
 * started from this page: Web Locks and BroadcastChannel are
 * origin-wide, so workers of one page stand in for the workers of
 * several tabs, and terminating one does to its locks and file handles
 * what closing a tab does.
 *
 * Every test works on a database of its own id, and removes its OPFS
 * directory and IndexedDB databases afterwards.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  ConnectionLostError,
  type DatabaseClient,
  type DatabaseConfig,
  KvsqlError,
  RefusedError,
  StatementError,
  connect,
} from '../src/client'

const DEFAULT_WORKER = new URL('../src/worker.ts', import.meta.url)
const CUSTOM_WORKER = new URL('./custom.worker.ts', import.meta.url)
const SHARED_REPO_DB = 'kvsql-tests-shared-repo'

/** Runners are several times slower than a laptop. */
const SLOW = 60_000

const UA = navigator.userAgent
const ENGINE = /Firefox\//.test(UA) ? 'firefox' : /Chrome\//.test(UA) ? 'chromium' : 'webkit'

let workers: Worker[] = []
let ids: string[] = []
let clients: DatabaseClient[] = []
const allIds: string[] = []

function newId(): string {
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  ids.push(id)
  allIds.push(id)
  return id
}

function config(id: string): DatabaseConfig {
  // Flush only when asked, so the tests see transactions pending.
  return { id, label: 'agex.db', flush: { every: 0, maxAgeMs: 0 } }
}

function tab(url: URL = DEFAULT_WORKER): Worker {
  const worker = new Worker(url, { type: 'module' })
  workers.push(worker)
  return worker
}

function open(worker: Worker, cfg: DatabaseConfig): DatabaseClient {
  const client = connect(worker, cfg, { flushOnHide: false })
  clients.push(client)
  return client
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 20_000,
): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

async function role(client: DatabaseClient): Promise<string> {
  return (await client.status()).role
}

/** The worker holding a lock, as the Web Locks API reports it. */
async function lockHolder(name: string): Promise<string | undefined> {
  const snapshot = await navigator.locks.query()
  return snapshot.held?.find((lock) => lock.name === name)?.clientId
}

async function lockPending(name: string): Promise<number> {
  const snapshot = await navigator.locks.query()
  return (snapshot.pending ?? []).filter((lock) => lock.name === name).length
}

async function opfsDir(...path: string[]): Promise<FileSystemDirectoryHandle | null> {
  let dir = await navigator.storage.getDirectory()
  try {
    for (const name of path) dir = await dir.getDirectoryHandle(name)
    return dir
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null
    throw err
  }
}

async function entries(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = []
  for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
    names.push(name)
  }
  return names.sort()
}

async function idbNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((db) => db.name ?? '').sort()
}

function deleteIdb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/** Remove a directory, retrying while a terminated worker's handles are let go. */
async function removeDir(parent: string, name: string): Promise<void> {
  for (let i = 0; ; i++) {
    const dir = await opfsDir(parent)
    if (!dir) return
    try {
      await dir.removeEntry(name, { recursive: true })
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return
      if (i > 100) throw err
      await sleep(50)
    }
  }
}

afterEach(async () => {
  await Promise.all(clients.map((c) => Promise.race([c.close().catch(() => {}), sleep(1_000)])))
  clients = []
  for (const worker of workers) worker.terminate()
  workers = []
  for (const id of ids) {
    await removeDir('kvsql', id)
    await removeDir('kvsql-tests', id)
    await deleteIdb(`kvsql:${id}`)
  }
  ids = []
  await deleteIdb(SHARED_REPO_DB)
}, SLOW)

afterAll(async () => {
  // Nothing the tests made is left.
  for (const id of allIds) {
    expect(await opfsDir('kvsql', id), id).toBeNull()
    expect(await opfsDir('kvsql-tests', id), id).toBeNull()
  }
  expect((await idbNames()).filter((n) => n.startsWith('kvsql'))).toEqual([])
  // Remove what an interrupted earlier run left behind (WebKit's OPFS
  // can outlive the test profile).
  for (const parent of ['kvsql', 'kvsql-tests']) {
    const dir = await opfsDir(parent)
    for (const name of dir ? await entries(dir) : []) await removeDir(parent, name)
  }
})

describe('the worker host', () => {
  it(
    'serves one tab: query, transaction, flush, info, export, close',
    async () => {
      const id = newId()
      const db = open(tab(), config(id))
      await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, n INTEGER, b BLOB)')
      const results = await db.transaction([
        ['INSERT INTO t VALUES (?, ?, ?)', ['a', 1, new Uint8Array([1, 2, 3])]],
        ['INSERT INTO t VALUES (?, ?, ?)', ['b', 2n ** 60n, null]],
      ])
      expect(results.map((r) => r.changes)).toEqual([1, 1])
      expect((await db.query('SELECT id, n, b FROM t ORDER BY id')).rows).toEqual([
        { id: 'a', n: 1, b: new Uint8Array([1, 2, 3]) },
        { id: 'b', n: 2n ** 60n, b: null },
      ])
      expect(await role(db)).toBe('holder')
      expect(await db.info()).toMatchObject({ seq: 2, pendingCount: 1, branch: `kvsql/${id}/0` })
      expect(await db.flush()).toMatchObject({ from: 2, to: 2 })
      // The file in OPFS, copied out as one SQLite file.
      const file = await db.export()
      expect(new TextDecoder().decode(file.subarray(0, 15))).toBe('SQLite format 3')
      expect(file.byteLength % 4096).toBe(0)
      expect(await lockHolder(`kvsql:${id}`)).toBeDefined()
      await db.close()
      await expect(db.query('SELECT 1')).rejects.toThrow(/closed/)
      expect(await lockHolder(`kvsql:${id}`)).toBeUndefined()

      // Reopened in a new worker, from the file and the log on disk.
      const again = open(tab(), config(id))
      expect((await again.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 2 }])
      expect((await again.info()).pendingCount).toBe(0)
    },
    SLOW,
  )

  it(
    'rebuilds errors as their classes on the page',
    async () => {
      const db = open(tab(), config(newId()))
      await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
      const refused = await db.query('PRAGMA recursive_triggers = ON').catch((e: unknown) => e)
      expect(refused).toBeInstanceOf(RefusedError)
      expect(refused).toBeInstanceOf(KvsqlError)
      expect((refused as Error).message).toMatch(/^Setting PRAGMA recursive_triggers/)
      const failed = await db
        .transaction([
          ["INSERT INTO t VALUES ('a')", null],
          ['BEGIN', null],
        ])
        .catch((e: unknown) => e)
      expect(failed).toBeInstanceOf(StatementError)
      expect((failed as StatementError).index).toBe(1)
      expect((failed as Error).cause).toBeInstanceOf(RefusedError)
      expect((failed as Error).message).toMatch(/^statement 1: BEGIN isn't available/)
      await expect(db.transaction('nope' as never)).rejects.toBeInstanceOf(TypeError)
    },
    SLOW,
  )

  it(
    'forwards a second tab to the holder, which sees its writes',
    async () => {
      const id = newId()
      const a = open(tab(), config(id))
      await a.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
      const b = open(tab(), config(id))
      await b.query("INSERT INTO t VALUES ('from b')")
      await a.query("INSERT INTO t VALUES ('from a')")
      const [sa, sb] = [await a.status(), await b.status()]
      expect(sa.role).toBe('holder')
      expect(sb).toMatchObject({ role: 'forwarding', holder: sa.worker })
      expect((await b.query('SELECT id FROM t ORDER BY id')).rows).toEqual([
        { id: 'from a' },
        { id: 'from b' },
      ])
      expect((await b.info()).holder).toBe(sa.worker)
      const failed = await b.transaction([['SELEC', null]]).catch((e: unknown) => e)
      expect(failed).toBeInstanceOf(StatementError)
    },
    SLOW,
  )

  it(
    'releases a terminated worker’s lock',
    async () => {
      const id = newId()
      const worker = tab()
      const db = open(worker, config(id))
      await db.query('SELECT 1')
      expect(await lockHolder(`kvsql:${id}`)).toBeDefined()
      const t0 = performance.now()
      worker.terminate()
      await until(async () => (await lockHolder(`kvsql:${id}`)) === undefined, 'lock release')
      console.log(`kvsql lock release ${ENGINE}: ${Math.round(performance.now() - t0)} ms`)
      const got = await navigator.locks.request(`kvsql:${id}`, { ifAvailable: true }, (lock) =>
        Promise.resolve(lock !== null),
      )
      expect(got).toBe(true)
    },
    SLOW,
  )

  it(
    'takes over when the holder is terminated, recovering its pending transactions',
    async () => {
      const id = newId()
      const wa = tab()
      const a = open(wa, config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      for (const i of [1, 2, 3]) await a.query('INSERT INTO t VALUES (?)', [i])
      expect((await a.info()).pendingCount).toBe(3)
      const b = open(tab(), config(id))
      const c = open(tab(), config(id))
      await until(async () => (await role(c)) === 'forwarding', 'c forwarding')
      await until(async () => (await role(b)) === 'forwarding', 'b forwarding')
      const before = await lockHolder(`kvsql:${id}`)
      wa.terminate()
      await until(
        async () => (await role(b)) === 'holder' || (await role(c)) === 'holder',
        'a new holder',
      )
      const after = await lockHolder(`kvsql:${id}`)
      expect(after).toBeDefined()
      expect(after).not.toBe(before)
      const [holder, other] = (await role(b)) === 'holder' ? [b, c] : [c, b]
      const status = await holder.status()
      console.log(`kvsql takeover ${ENGINE}: ${JSON.stringify(status)}`)
      await until(async () => (await other.status()).holder === status.worker, 'other follows')
      const info = await other.info()
      expect(info).toMatchObject({ holder: status.worker, pendingCount: 3, seq: 4 })
      expect(info.recovery).toEqual({
        ownFlush: false,
        entries: 0,
        transactions: 0,
        rebased: 0,
        snapshot: false,
      })
      expect((await other.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 3 }])
      expect((await other.query('PRAGMA integrity_check')).rows).toEqual([
        { integrity_check: 'ok' },
      ])
      expect(await other.flush()).toMatchObject({ from: 2, to: 4 })
      await other.query('INSERT INTO t VALUES (4)')
      expect((await holder.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 4 }])
    },
    SLOW,
  )

  it(
    'fails a query in flight to a terminated holder, and sends a flush again',
    async () => {
      const id = newId()
      const wa = tab()
      const a = open(wa, config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      await a.query('INSERT INTO t VALUES (1)')
      const b = open(tab(), config(id))
      await until(async () => (await role(b)) === 'forwarding', 'b forwarding')
      // A long query keeps the holder busy, and the flush waits behind
      // it. It ends: WebKit can't stop a worker inside a WebAssembly
      // call, so there a terminated worker stops (and lets its lock go)
      // only once the statement returns, and never answers it.
      const query = b
        .query(
          'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000000) SELECT count(*) FROM c',
        )
        .catch((e: unknown) => e)
      const flush = b.flush()
      await sleep(300)
      const t0 = performance.now()
      wa.terminate()
      const lost = await query
      console.log(`kvsql lost after ${ENGINE}: ${Math.round(performance.now() - t0)} ms`)
      expect(lost).toBeInstanceOf(ConnectionLostError)
      expect((lost as Error).message).toMatch(/may or may not have committed/)
      expect(await flush).toMatchObject({ from: 2, to: 2 })
      expect(await role(b)).toBe('holder')
      expect((await b.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 1 }])
    },
    SLOW,
  )

  it(
    'deletes under the lock from a forwarding tab, closing every tab',
    async () => {
      const id = newId()
      const a = open(tab(), config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      await a.query('INSERT INTO t VALUES (1)')
      const b = open(tab(), config(id))
      const c = open(tab(), config(id))
      await until(async () => (await role(c)) === 'forwarding', 'c forwarding')
      expect(await entries((await opfsDir('kvsql', id)) as FileSystemDirectoryHandle)).toEqual([
        'db.sqlite',
        'db.sqlite-journal',
      ])
      expect(await idbNames()).toContain(`kvsql:${id}`)
      await b.delete()
      // The default storage goes with it: the directory, the IndexedDB database.
      expect(await opfsDir('kvsql', id)).toBeNull()
      expect(await idbNames()).not.toContain(`kvsql:${id}`)
      for (const db of [a, b, c]) {
        await expect(db.query('SELECT 1')).rejects.toThrow(/agex\.db was deleted/)
      }
      await until(
        async () =>
          (await lockHolder(`kvsql:${id}`)) === undefined &&
          (await lockPending(`kvsql:${id}`)) === 0,
        'lock free',
      )
      // No worker took the lock and made the database again.
      expect(await opfsDir('kvsql', id)).toBeNull()
    },
    SLOW,
  )

  it(
    'with keepLog, rebuilds the file from the log for every tab',
    async () => {
      const id = newId()
      const a = open(tab(), config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      await a.query('INSERT INTO t VALUES (1)')
      const b = open(tab(), config(id))
      await until(async () => (await role(b)) === 'forwarding', 'b forwarding')
      await b.delete({ keepLog: true })
      const info = await b.info()
      expect(info.recovery).toEqual({
        ownFlush: false,
        entries: 2,
        transactions: 2,
        rebased: 0,
        snapshot: false,
      })
      expect((await a.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
    },
    SLOW,
  )

  it(
    'restores a checkpoint on OPFS, undoing changes and across a schema change',
    async () => {
      const id = newId()
      const a = open(tab(), config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB)')
      await a.query('INSERT INTO t VALUES (1, randomblob(50000))')
      const before = (await a.query('SELECT id, hex(v) AS v FROM t')).rows
      const cp = await a.checkpoint('before')
      const b = open(tab(), config(id))
      await until(async () => (await role(b)) === 'forwarding', 'b forwarding')
      await b.query('INSERT INTO t VALUES (2, NULL)')
      expect(await b.restore(cp.id)).toMatchObject({ how: 'undo', undone: 1 })
      expect((await a.query('SELECT id, hex(v) AS v FROM t')).rows).toEqual(before)
      await a.query('ALTER TABLE t ADD COLUMN w TEXT')
      await a.query("INSERT INTO t VALUES (3, NULL, 'w')")
      expect(await b.restore(cp.id)).toMatchObject({ how: 'epoch' })
      expect((await a.query('SELECT id, hex(v) AS v FROM t')).rows).toEqual(before)
      expect((await a.query("SELECT count(*) AS n FROM pragma_table_info('t')")).rows).toEqual([
        { n: 2 },
      ])
    },
    SLOW,
  )

  it(
    'starts a new epoch on OPFS, and rebuilds the file from its snapshot',
    async () => {
      const id = newId()
      const a = open(tab(), config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB)')
      await a.query('INSERT INTO t VALUES (1, randomblob(100000))')
      const b = open(tab(), config(id))
      await until(async () => (await role(b)) === 'forwarding', 'b forwarding')
      const result = await b.newEpoch()
      expect(result).toMatchObject({ seq: 2, chunks: 1 })
      expect(result.branch).toMatch(/\/1$/)
      await a.query('INSERT INTO t VALUES (2, NULL)')
      const before = (await a.query('SELECT id, hex(v) AS v FROM t ORDER BY id')).rows
      await b.delete({ keepLog: true })
      const info = await b.info()
      expect(info).toMatchObject({ branch: result.branch, pendingCount: 0 })
      expect(info.recovery).toEqual({
        ownFlush: false,
        entries: 1,
        transactions: 1,
        rebased: 0,
        snapshot: true,
      })
      expect((await a.query('SELECT id, hex(v) AS v FROM t ORDER BY id')).rows).toEqual(before)
    },
    SLOW,
  )

  it(
    'runs a custom worker with its own repository',
    async () => {
      const id = newId()
      const a = open(tab(CUSTOM_WORKER), config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      const b = open(tab(CUSTOM_WORKER), config(id))
      await b.query('INSERT INTO t VALUES (1)')
      expect(await b.flush()).toMatchObject({ from: 2, to: 2 })
      expect(await opfsDir('kvsql-tests', id)).not.toBeNull()
      await a.delete()
      // The file is gone; the shared repository stays, for other databases.
      expect(
        await entries((await opfsDir('kvsql-tests', id)) as FileSystemDirectoryHandle),
      ).toEqual([])
      expect(await idbNames()).toContain(SHARED_REPO_DB)
    },
    SLOW,
  )

  it(
    'copies a database for another tab: detached, and logged in the same repository',
    async () => {
      const id = newId()
      const a = open(tab(CUSTOM_WORKER), config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)')
      await a.query('INSERT INTO t VALUES (1, randomblob(3000000))')
      const other = tab(CUSTOM_WORKER)
      const b = open(other, config(id))
      await until(async () => (await role(b)) === 'forwarding', 'b forwarding')
      const sample = 'SELECT id, length(b) AS n, hex(substr(b, 2000000, 8)) AS h FROM t'
      const rows = (await a.query(sample)).rows

      // The holder copies its file in OPFS; the asking tab opens it.
      const copyId = newId()
      const detached = { id: copyId, label: 'agex.db', detached: true }
      expect(await b.copy(detached)).toMatchObject({ seq: 2, schema: 1 })
      const copy = open(other, detached)
      expect((await copy.query(sample)).rows).toEqual(rows)
      await copy.query('DELETE FROM t')
      expect((await a.query(sample)).rows).toEqual(rows)
      expect(await copy.info()).toMatchObject({ detached: true, pendingCount: 0 })
      await copy.delete()

      const forkId = newId()
      const { base } = await b.copy(config(forkId))
      const fork = open(other, config(forkId))
      const info = await fork.info()
      expect(info).toMatchObject({ base, seq: 2, pendingCount: 0 })
      expect(info.recovery.entries).toBe(0)
      expect((await fork.query(sample)).rows).toEqual(rows)
      await fork.delete()
    },
    SLOW,
  )

  it(
    'keeps a detached copy without a log in the default worker',
    async () => {
      const id = newId()
      const worker = tab()
      const a = open(worker, config(id))
      await a.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      await a.query('INSERT INTO t VALUES (1)')
      const copyId = newId()
      const detached = { id: copyId, detached: true }
      await a.copy(detached)
      const copy = open(worker, detached)
      expect((await copy.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
      expect(await idbNames()).not.toContain(`kvsql:${copyId}`)
      await copy.delete()
      expect(await opfsDir('kvsql', copyId)).toBeNull()
    },
    SLOW,
  )
})
