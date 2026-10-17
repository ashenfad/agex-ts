/**
 * Copies of a logged database: detached ones (a file with no log) and
 * logged ones (a new branch starting from the source's log).
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CrashingDirectory,
  LogError,
  type LoggedDatabase,
  MemoryDirectory,
  RefusedError,
  SimulatedCrash,
  loadSqlite,
  openDatabase,
  openDetached,
} from '../src/index'
import {
  BRANCH,
  CrashingStore,
  NAME,
  StoreCrash,
  dump,
  integrity,
  open,
  quietSqliteWarnings,
  repoOver,
} from './log-helpers'

quietSqliteWarnings()
await loadSqlite()

const COPY = 'copy.db'

/** Every database a test opened, closed after it. */
const opened: LoggedDatabase[] = []
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close().catch(() => {})
})

async function track(db: Promise<LoggedDatabase>): Promise<LoggedDatabase> {
  const it = await db
  opened.push(it)
  return it
}

/** A logged database with a table and two rows, the second pending. */
async function source(branch = BRANCH) {
  const repo = await repoOver()
  const dir = new MemoryDirectory()
  const db = await track(open(dir, repo, { branch, flush: { every: 0 } }))
  await db.query('CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT)')
  await db.query("INSERT INTO notes VALUES ('a', 'first')")
  await db.flush()
  await db.query("INSERT INTO notes VALUES ('b', 'second')")
  return { repo, dir, db }
}

function detached(dir: MemoryDirectory): Promise<LoggedDatabase> {
  return track(openDetached({ dir, name: COPY, label: 'agex.db' }))
}

describe('a detached copy', () => {
  it('holds every committed transaction, and records nothing it does', async () => {
    const { repo, db } = await source()
    const head = await repo.branches.get(BRANCH)
    const to = new MemoryDirectory()
    const result = await db.copy({ dir: to, name: COPY })
    expect(result).toMatchObject({ seq: 3, schema: 1, base: head })
    expect(result.bytes).toBeGreaterThan(0)
    // Copying didn't flush the source.
    expect(db.pendingCount).toBe(1)

    const copy = await detached(to)
    expect(copy.detached).toBe(true)
    expect(copy.branch).toBe('')
    expect(await dump(copy)).toEqual(await dump(db))
    await copy.query("UPDATE notes SET body = 'changed' WHERE id = 'a'")
    await copy.query('CREATE TABLE more (id INTEGER PRIMARY KEY, v TEXT)')
    expect(copy.pendingCount).toBe(0)
    expect(await copy.flush()).toBeNull()
    expect(copy.seq).toBe(3)
    expect(copy.schemaVersion).toBe(1)

    // The source and its log never saw the copy's writes.
    expect((await db.query("SELECT body FROM notes WHERE id = 'a'")).rows).toEqual([
      { body: 'first' },
    ])
    expect(await repo.branches.get(BRANCH)).toBe(head)

    // Its writes are in its file, for the next open.
    await copy.close()
    const again = await detached(to)
    expect((await again.query("SELECT body FROM notes WHERE id = 'a'")).rows).toEqual([
      { body: 'changed' },
    ])
    expect(await integrity(again)).toBe('ok')
  })

  it('refuses and checks what the logged database would', async () => {
    const { db } = await source()
    const to = new MemoryDirectory()
    await db.copy({ dir: to, name: COPY })
    const copy = await detached(to)
    await expect(copy.query('CREATE TABLE loose (v TEXT)')).rejects.toThrow(RefusedError)
    await expect(copy.query('CREATE TABLE r AS SELECT random() AS id')).rejects.toThrow(
      RefusedError,
    )
    await expect(copy.query('SELECT * FROM _kvsql_meta')).rejects.toThrow(RefusedError)
    await expect(copy.query('BEGIN')).rejects.toThrow(RefusedError)
  })

  it('starts empty from an empty file', async () => {
    const copy = await detached(new MemoryDirectory())
    await copy.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await copy.query('INSERT INTO t VALUES (1)')
    expect((await copy.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 1 }])
    expect(copy.seq).toBe(0)
  })

  it("can't be opened on a log, nor a logged file as a detached copy", async () => {
    const { repo, dir, db } = await source()
    const to = new MemoryDirectory()
    await db.copy({ dir: to, name: COPY })
    await expect(open(to, repo, { name: COPY })).rejects.toThrow(/detached copy, with no log/)
    await db.close()
    await expect(openDetached({ dir, name: NAME })).rejects.toThrow(/isn't a detached copy/)
  })

  it('copies a file of many chunks', async () => {
    const { db } = await source()
    await db.query('CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB)')
    for (let i = 0; i < 3; i++) {
      await db.query('INSERT INTO blobs (b) VALUES (randomblob(1500000))')
    }
    const to = new MemoryDirectory()
    const { bytes } = await db.copy({ dir: to, name: COPY })
    expect(bytes).toBeGreaterThan(4 << 20)
    const copy = await detached(to)
    const sample = 'SELECT id, length(b) AS n, hex(substr(b, 1000000, 16)) AS h FROM blobs'
    expect((await copy.query(sample)).rows).toEqual((await db.query(sample)).rows)
    expect(await integrity(copy)).toBe('ok')
  })

  it('can be copied again, as a detached copy', async () => {
    const { db } = await source()
    const to = new MemoryDirectory()
    await db.copy({ dir: to, name: COPY })
    const copy = await detached(to)
    await copy.query("INSERT INTO notes VALUES ('c', 'third')")
    const next = new MemoryDirectory()
    await copy.copy({ dir: next, name: COPY })
    const second = await detached(next)
    expect(await dump(second)).toEqual(await dump(copy))
    await expect(
      copy.copy({ dir: new MemoryDirectory(), name: COPY, repo: await repoOver(), branch: 'x' }),
    ).rejects.toThrow(/its changes are in no log/)
  })
})

describe('the target', () => {
  it('replaces a detached copy, and a copy cut short', async () => {
    const { db } = await source()
    const to = new MemoryDirectory()
    await db.copy({ dir: to, name: COPY })
    await db.query("INSERT INTO notes VALUES ('c', 'third')")
    await db.copy({ dir: to, name: COPY })
    const copy = await detached(to)
    expect(await dump(copy)).toEqual(await dump(db))
    await copy.close()

    // A copy that dies part-way, before its first page (written last),
    // leaves a file that starts with zeros.
    const crashing = new CrashingDirectory(to)
    crashing.crashAt({ op: 'write', n: 2 })
    await expect(db.copy({ dir: crashing, name: COPY })).rejects.toThrow(SimulatedCrash)
    await expect(detached(to)).rejects.toThrow(/not a database/)
    await db.copy({ dir: to, name: COPY })
    expect(await dump(await detached(to))).toEqual(await dump(db))
  })

  it("refuses a logged database's file, or any other database", async () => {
    const a = await source()
    const b = await source('db/other/0')
    await b.db.close()
    await expect(a.db.copy({ dir: b.dir, name: NAME })).rejects.toThrow(
      /holds the database on branch 'db\/other\/0'/,
    )

    // Even a replica on the source's own branch, which may hold
    // transactions no log has.
    const replica = new MemoryDirectory()
    await (await open(replica, a.repo)).close()
    await expect(a.db.copy({ dir: replica, name: NAME })).rejects.toThrow(
      /holds the database on branch 'db\/test\/0'/,
    )

    const plain = new MemoryDirectory()
    const file = await openDatabase(plain, COPY)
    file.db.exec('CREATE TABLE t (v)')
    file.close()
    await expect(a.db.copy({ dir: plain, name: COPY })).rejects.toThrow(/isn't a copy/)
  })

  it('refuses an open file', async () => {
    const { db } = await source()
    const to = new MemoryDirectory()
    await db.copy({ dir: to, name: COPY })
    await detached(to)
    await expect(db.copy({ dir: to, name: COPY })).rejects.toThrow()
  })
})

describe('a logged copy', () => {
  it("flushes, then starts a branch from the source's log", async () => {
    const { repo, db } = await source()
    const to = new MemoryDirectory()
    const result = await db.copy({ dir: to, name: COPY, repo, branch: 'db/copy/0' })
    expect(db.pendingCount).toBe(0)
    const head = await repo.branches.get(BRANCH)
    expect(result.base).toBe(head)
    expect(await repo.branches.get('db/copy/0')).toBe(head)

    const copy = await track(open(to, repo, { name: COPY, branch: 'db/copy/0' }))
    expect(copy.recovery).toEqual({ ownFlush: false, entries: 0, transactions: 0, snapshot: false })
    expect(await dump(copy)).toEqual(await dump(db))
    await copy.query("UPDATE notes SET body = 'mine' WHERE id = 'b'")
    await copy.flush()
    expect(await repo.branches.get(BRANCH)).toBe(head)
    expect((await db.query("SELECT body FROM notes WHERE id = 'b'")).rows).toEqual([
      { body: 'second' },
    ])

    // Its log alone rebuilds it: the source's three entries, then its own.
    const rebuilt = await track(
      open(new MemoryDirectory(), repo, { name: COPY, branch: 'db/copy/0' }),
    )
    expect(rebuilt.recovery.entries).toBe(4)
    expect(await dump(rebuilt)).toEqual(await dump(copy))
  })

  it('cut short before its branch exists, is replaced by the next try', async () => {
    const store = new CrashingStore(new Memory())
    const repo = await repoOver(store)
    const db = await track(open(new MemoryDirectory(), repo))
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.query('INSERT INTO t VALUES (1)')
    await db.flush()
    const to = new MemoryDirectory()
    store.failNextWrite()
    await expect(db.copy({ dir: to, name: COPY, repo, branch: 'db/copy/0' })).rejects.toThrow(
      StoreCrash,
    )
    expect(await repo.branches.has('db/copy/0')).toBe(false)
    await db.copy({ dir: to, name: COPY, repo, branch: 'db/copy/0' })
    const copy = await track(open(to, repo, { name: COPY, branch: 'db/copy/0' }))
    expect((await copy.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
  })

  it('refuses a branch that exists, or a repository without the log', async () => {
    const { repo, db } = await source()
    await expect(
      db.copy({ dir: new MemoryDirectory(), name: COPY, repo, branch: BRANCH }),
    ).rejects.toThrow(LogError)
    await expect(
      db.copy({ dir: new MemoryDirectory(), name: COPY, repo: await repoOver(), branch: 'b' }),
    ).rejects.toThrow(/doesn't hold this database's log/)
    await expect(db.copy({ dir: new MemoryDirectory(), name: COPY, branch: 'b' })).rejects.toThrow(
      /both repo and branch/,
    )
  })
})
