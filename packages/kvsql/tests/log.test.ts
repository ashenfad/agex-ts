import type { Repo } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type PendingItem,
  type Piece,
  decodeEntry,
  encodeEntry,
  encodeSqlBody,
  entryInfo,
  sha256Hex,
} from '../src/entry'
import {
  CorruptEntryError,
  ENTRY_KEY,
  KvsqlError,
  LogError,
  type LoggedDatabase,
  MemoryDirectory,
  RebaseRequiredError,
  RefusedError,
  ReplayError,
  StatementError,
  loadSqlite,
  openDatabase,
  startSession,
} from '../src/index'
import {
  BRANCH,
  CrashingStore,
  NAME,
  dump,
  integrity,
  open,
  quietSqliteWarnings,
  replica,
  repoOver,
} from './log-helpers'

const sqlite3 = await loadSqlite()

/** Every database a test opened, closed after it. */
const opened: LoggedDatabase[] = []
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close().catch(() => {})
})

async function fresh(options: Parameters<typeof open>[2] = {}) {
  const repo = await repoOver()
  const dir = new MemoryDirectory()
  const db = await open(dir, repo, options)
  opened.push(db)
  return { repo, dir, db }
}

async function track(db: Promise<LoggedDatabase>): Promise<LoggedDatabase> {
  const it = await db
  opened.push(it)
  return it
}

/** A connection to a database file's bytes, in memory. */
function openBytes(bytes: Uint8Array) {
  const db = new sqlite3.oo1.DB()
  const { capi, wasm } = sqlite3
  const p = wasm.allocFromTypedArray(bytes)
  const rc = capi.sqlite3_deserialize(
    db,
    'main',
    p,
    bytes.byteLength,
    bytes.byteLength,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  )
  if (rc !== 0) throw new Error(`sqlite3_deserialize: ${rc}`)
  return db
}

/** The log's entries, oldest first: each commit's info and decoded pieces. */
async function logEntries(repo: Repo<Uint8Array>) {
  const out: { commit: string; info: Record<string, unknown>; pieces: Piece[] }[] = []
  for await (const c of repo.log({ branch: BRANCH }, { firstParent: true })) {
    if (c.parents.length === 0) break
    const bytes = await (await repo.snapshot({ commit: c.hash })).get(ENTRY_KEY)
    out.push({ commit: c.hash, info: c.info ?? {}, pieces: decodeEntry(bytes as Uint8Array) })
  }
  return out.reverse()
}

/** Commit `bytes` to the log branch as an entry whose commit records `info`. */
async function commitEntry(repo: Repo<Uint8Array>, bytes: Uint8Array, info: object) {
  const wt = await repo.worktree(BRANCH, { create: true })
  wt.set(ENTRY_KEY, bytes)
  await wt.commit({ info: { ...info } })
  return wt.head
}

/** Append pending items to the log as a well-formed entry. */
async function appendItems(repo: Repo<Uint8Array>, items: PendingItem[]) {
  const { bytes, pieces } = encodeEntry(sqlite3, items)
  return commitEntry(repo, bytes, entryInfo(pieces, bytes, await sha256Hex(bytes)))
}

describe('transactions', () => {
  it('returns rows, changes and the last insert rowid', async () => {
    const { db } = await fresh()
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    expect(await db.query('INSERT INTO t (v) VALUES (?), (?)', ['a', 'b'])).toEqual({
      rows: [],
      changes: 2,
      lastInsertRowid: 2,
    })
    expect(await db.query('SELECT id, v FROM t WHERE v = :v', { ':v': 'b' })).toEqual({
      rows: [{ id: 2, v: 'b' }],
      changes: 0,
      lastInsertRowid: 2,
    })
    expect((await db.query("UPDATE t SET v = v || '!'")).changes).toBe(2)
    // The pending table's own insert doesn't show through.
    expect((await db.query('SELECT last_insert_rowid() AS r')).rows).toEqual([{ r: 2 }])
    await db.query('INSERT INTO t VALUES (?, ?)', [2n ** 60n, 'big'])
    expect((await db.query('SELECT last_insert_rowid() AS r')).lastInsertRowid).toBe(2n ** 60n)
  })

  it('runs a transaction as one, with a result per statement', async () => {
    const { db } = await fresh()
    await db.query('CREATE TABLE acct (id TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL)')
    await db.query("INSERT INTO acct VALUES ('a1', 100), ('a2', 0)")
    const seq = db.seq
    const results = await db.transaction([
      ['UPDATE acct SET balance = balance - ? WHERE id = ?', [10, 'a1']],
      ['UPDATE acct SET balance = balance + ? WHERE id = ?', [10, 'a2']],
      ['SELECT id, balance FROM acct ORDER BY id'],
    ])
    expect(results.map((r) => r.changes)).toEqual([1, 1, 0])
    expect(results[2]?.rows).toEqual([
      { id: 'a1', balance: 90 },
      { id: 'a2', balance: 10 },
    ])
    // One transaction, one logged item.
    expect(db.seq).toBe(seq + 1)
    expect(await db.transaction([])).toEqual([])
  })

  it('rolls the whole call back when a statement fails, naming it', async () => {
    const { db } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v INTEGER NOT NULL)')
    await db.query("INSERT INTO t VALUES ('a', 1)")
    const before = await dump(db)
    const { seq, pendingCount } = db
    const err = await db
      .transaction([
        ["INSERT INTO t VALUES ('b', 2)"],
        ["UPDATE t SET v = 5 WHERE id = 'a'"],
        ["INSERT INTO t VALUES ('c', NULL)"],
      ])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StatementError)
    expect((err as StatementError).index).toBe(2)
    expect((err as Error).message).toMatch(/^statement 2: .*NOT NULL constraint failed: t\.v/)
    expect((err as Error).cause).toBeInstanceOf(Error)
    expect(await dump(db)).toEqual(before)
    expect([db.seq, db.pendingCount]).toEqual([seq, pendingCount])

    // A single query throws SQLite's own error.
    await expect(db.query('SELECT nope FROM t')).rejects.toThrow(/no such column: nope/)
    await expect(db.query('SELECT nope FROM t')).rejects.not.toBeInstanceOf(StatementError)
    // The database carries on.
    await db.query("INSERT INTO t VALUES ('b', 2)")
    expect((await db.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: 2 }])
  })

  it('refuses transaction control, pointing at transaction([...])', async () => {
    const { db } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
    await expect(db.query('COMMIT')).rejects.toThrow(RefusedError)
    await expect(db.query('BEGIN')).rejects.toThrow(/pass them together to transaction\(\[/)
    const err = await db
      .transaction([["INSERT INTO t VALUES ('a')"], ['COMMIT'], ["INSERT INTO t VALUES ('b')"]])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StatementError)
    expect((err as StatementError).index).toBe(1)
    expect((err as Error).cause).toBeInstanceOf(RefusedError)
    expect(await dump(db)).toMatchObject({ t: [] })
    await expect(db.query("INSERT INTO t VALUES ('x'); ROLLBACK")).rejects.toThrow(RefusedError)
    expect(await dump(db)).toMatchObject({ t: [] })
  })

  it('allows savepoints inside a call, which never end it', async () => {
    const { db, repo } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
    await db.query(`SAVEPOINT a; INSERT INTO t VALUES ('a'); RELEASE a;
      SAVEPOINT b; INSERT INTO t VALUES ('b'); ROLLBACK TO b; RELEASE b;`)
    expect(await dump(db)).toMatchObject({ t: [{ id: 'a' }] })
    // A failure after a released savepoint still rolls back everything.
    await expect(
      db.transaction([
        ["SAVEPOINT s; INSERT INTO t VALUES ('c'); RELEASE s"],
        ['INSERT INTO t VALUES (NULL)'],
      ]),
    ).rejects.toThrow(StatementError)
    expect(await dump(db)).toMatchObject({ t: [{ id: 'a' }] })
    await db.flush()
    expect(await dump(await track(replica(repo)))).toEqual(await dump(db))
  })

  it('rolls back a schema change that leaves a table without a non-null key', async () => {
    const { db } = await fresh()
    await db.query('CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT)')
    const before = await dump(db)
    const { schemaVersion, seq } = db
    await expect(
      db.transaction([
        ["INSERT INTO notes VALUES ('a', 'kept?')"],
        ['CREATE TABLE tags (name TEXT)'],
      ]),
    ).rejects.toThrow(
      'Tables in agex.db need a non-null PRIMARY KEY, e.g. `id TEXT PRIMARY KEY NOT NULL`; table "tags" has none.',
    )
    await expect(db.query('CREATE TABLE loose (id TEXT PRIMARY KEY)')).rejects.toThrow(RefusedError)
    expect(await dump(db)).toEqual(before)
    expect([db.schemaVersion, db.seq]).toEqual([schemaVersion, seq])
  })

  it('refuses nondeterministic functions in a call that changes the schema, only', async () => {
    const { db } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, at TEXT)')
    await expect(
      db.transaction([['ALTER TABLE t ADD COLUMN r'], ['UPDATE t SET r = random()']]),
    ).rejects.toThrow(
      "random() can't be used in a call that changes the schema of agex.db: schema changes are replayed as SQL on every copy of the database",
    )
    await expect(
      db.transaction([
        ["INSERT INTO t VALUES ('a', datetime('now'))"],
        ['CREATE INDEX t_at ON t (at)'],
      ]),
    ).rejects.toThrow(/^datetime\(\) can't be used/)
    // Recorded as values, they're fine on their own.
    await db.query("INSERT INTO t VALUES ('a', datetime('now'))")
    await db.query('ALTER TABLE t ADD COLUMN r')
    await db.query('UPDATE t SET r = random()')
    expect((await db.query('SELECT count(*) AS n FROM t WHERE r IS NOT NULL')).rows).toEqual([
      { n: 1 },
    ])
  })

  it('refuses a schema change that depends on a TEMP object from an earlier call', async () => {
    const { db, repo } = await fresh()
    await db.query('CREATE TEMP TABLE scratch (x)')
    await db.query('INSERT INTO scratch VALUES (1), (2)')
    await db.query('CREATE TEMP VIEW doubled AS SELECT x * 2 AS y FROM scratch')
    for (const statements of [
      [['CREATE TABLE t (id INTEGER PRIMARY KEY)'], ['INSERT INTO t SELECT x FROM temp.scratch']],
      [['CREATE TABLE t (id INTEGER PRIMARY KEY)'], ['INSERT INTO t SELECT y FROM doubled']],
      [['CREATE TABLE t (id INTEGER PRIMARY KEY)'], ['DELETE FROM scratch']],
    ] as const) {
      await expect(db.transaction(statements)).rejects.toThrow(
        /can't use the TEMP table or view "(scratch|doubled)" made by an earlier call/,
      )
    }
    expect(db.schemaVersion).toBe(0)

    // A TEMP table made in the same call is replayed with it; outside a
    // schema change, rows read from TEMP tables are recorded as values.
    await db.transaction([
      ['CREATE TEMP TABLE staging (x)'],
      ['INSERT INTO staging VALUES (7)'],
      ['CREATE TABLE t (id INTEGER PRIMARY KEY)'],
      ['INSERT INTO t SELECT x FROM staging'],
    ])
    await db.query('INSERT INTO t SELECT x FROM scratch')
    await db.flush()
    const copy = await track(replica(repo))
    expect(await dump(copy)).toEqual(await dump(db))
  })

  it('logs nothing for a call that changes nothing', async () => {
    const { db } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v)')
    const { seq, pendingCount } = db
    await db.query('SELECT * FROM t')
    await db.query("UPDATE t SET v = 1 WHERE id = 'missing'")
    await db.query("INSERT INTO t VALUES ('a', 1)")
    await db.query("DELETE FROM t WHERE id = 'a'")
    expect(
      await db.transaction([["INSERT INTO t VALUES ('b', 1)"], ['DELETE FROM t']]),
    ).toHaveLength(2)
    expect([db.seq, db.pendingCount]).toEqual([seq + 2, pendingCount + 2])
  })

  it('keeps callers out of its own tables', async () => {
    const { db } = await fresh()
    await expect(db.query('SELECT * FROM _kvsql_pending')).rejects.toThrow(
      /reserved for agex\.db's own records/,
    )
    await expect(db.query('UPDATE _kvsql_meta SET schema = 9')).rejects.toThrow(RefusedError)
  })

  it('logs a migration as SQL, with user_version, and replays it', async () => {
    const { db, repo } = await fresh()
    await db.query('CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT)')
    await db.query("INSERT INTO notes VALUES ('a', 'Alpha'), ('b', 'Beta')")
    expect(db.schemaVersion).toBe(1)
    await db.transaction([
      ['ALTER TABLE notes ADD COLUMN slug TEXT'],
      ['UPDATE notes SET slug = lower(title)'],
      ['PRAGMA user_version = 2'],
    ])
    expect(db.schemaVersion).toBe(2)
    // A schema change flushes at once.
    expect(db.pendingCount).toBe(0)
    const entries = await logEntries(repo)
    const last = entries[entries.length - 1]
    expect(last?.pieces.map((p) => p.kind)).toEqual(['changeset', 'sql'])
    expect(last?.info).toMatchObject({ v: 1, schema: 2 })

    const copy = await track(replica(repo))
    expect(await integrity(copy)).toBe('ok')
    expect(copy.schemaVersion).toBe(2)
    expect(await dump(copy)).toEqual(await dump(db))
    expect(await dump(copy)).toMatchObject({
      user_version: 2,
      notes: [
        { id: 'a', title: 'Alpha', slug: 'alpha' },
        { id: 'b', title: 'Beta', slug: 'beta' },
      ],
    })
    // A user_version write alone is a schema change too.
    await db.query('PRAGMA user_version = 3')
    expect(db.schemaVersion).toBe(3)
  })

  it('logs a schema statement that changes nothing as rows, as an app reloading does', async () => {
    const { db, repo } = await fresh()
    const create = 'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY NOT NULL, title TEXT)'
    const index = 'CREATE INDEX IF NOT EXISTS notes_title ON notes (title)'
    await db.transaction([[create], [index], ['PRAGMA user_version = 1']])
    expect(db.schemaVersion).toBe(1)
    const flushed = (await logEntries(repo)).length

    // The app loads again: the same statements change nothing.
    await db.transaction([[create], [index], ['PRAGMA user_version = 1']])
    await db.query('DROP TABLE IF EXISTS gone')
    // Nor does a change undone inside the call.
    await db.transaction([
      ['SAVEPOINT s'],
      ['CREATE TABLE tried (id TEXT PRIMARY KEY NOT NULL)'],
      ['ROLLBACK TO s'],
      ['RELEASE s'],
    ])
    expect(db.schemaVersion).toBe(1)
    expect(db.pendingCount).toBe(0)
    expect(await logEntries(repo)).toHaveLength(flushed)

    // Rows written beside a no-op are logged as rows, values and all,
    // so a nondeterministic function is fine there.
    await db.transaction([[create], ["INSERT INTO notes VALUES ('a', hex(randomblob(4)))"]])
    expect([db.schemaVersion, db.pendingCount]).toEqual([1, 1])
    await db.flush()
    expect(await dump(await track(replica(repo)))).toEqual(await dump(db))
  })

  it('logs ANALYZE as SQL, though rewriting statistics changes no schema cookie', async () => {
    const { db, repo } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v)')
    await db.query('CREATE INDEX t_v ON t (v)')
    await db.query("INSERT INTO t VALUES ('a', 1), ('b', 2)")
    await db.query('ANALYZE')
    const version = db.schemaVersion
    await db.query("INSERT INTO t VALUES ('c', 3)")
    await db.query('ANALYZE')
    expect(db.schemaVersion).toBe(version + 1)
    // the app's tables' statistics; kvsql's own differ with what was pending
    const stats =
      "SELECT * FROM sqlite_stat1 WHERE substr(tbl, 1, 7) != '_kvsql_' ORDER BY tbl, idx"
    const copy = await track(replica(repo))
    expect((await copy.query(stats)).rows).toEqual((await db.query(stats)).rows)
    expect((await db.query(stats)).rows).toContainEqual({ tbl: 't', idx: 't_v', stat: '3 1' })
  })

  it('exports a standalone file: its schema and rows, pending ones too, without its own tables', async () => {
    const { db } = await fresh()
    await db.transaction([
      ['CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT, body BLOB)'],
      ['CREATE INDEX notes_title ON notes (title)'],
      ['CREATE VIEW titles AS SELECT title FROM notes'],
      ['PRAGMA user_version = 4'],
    ])
    await db.query("INSERT INTO notes VALUES ('a', 'Alpha', x'0102')")
    await db.flush()
    await db.query("INSERT INTO notes VALUES ('b', 'Beta', NULL)")
    expect(db.pendingCount).toBe(1)

    const copy = openBytes(await db.export())
    try {
      expect(copy.selectValue('PRAGMA integrity_check')).toBe('ok')
      expect(copy.selectValue('PRAGMA user_version')).toBe(4)
      expect(copy.selectValues('SELECT name FROM sqlite_schema ORDER BY name')).toEqual([
        'notes',
        'notes_title',
        'sqlite_autoindex_notes_1',
        'titles',
      ])
      expect(copy.selectObjects('SELECT * FROM notes ORDER BY id')).toEqual([
        { id: 'a', title: 'Alpha', body: new Uint8Array([1, 2]) },
        { id: 'b', title: 'Beta', body: null },
      ])
    } finally {
      copy.close()
    }
    // The database goes on as it was.
    expect(db.pendingCount).toBe(1)
    expect((await db.query('SELECT count(*) AS n FROM notes')).rows).toEqual([{ n: 2 }])
    await db.close()
    await expect(db.export()).rejects.toThrow(/closed/)
  })

  it('replays a table rebuild, the usual migration for changing a table', async () => {
    const { db, repo } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a, b)')
    await db.query("INSERT INTO t VALUES ('x', 1, 2), ('y', 3, 4)")
    await db.transaction([
      ['CREATE TABLE t_new (id TEXT PRIMARY KEY NOT NULL, a INTEGER NOT NULL, c)'],
      ['INSERT INTO t_new SELECT id, a, a + b FROM t'],
      ['DROP TABLE t'],
      ['ALTER TABLE t_new RENAME TO t'],
    ])
    await db.query("UPDATE t SET c = 0 WHERE id = 'x'")
    await db.flush()
    expect(await dump(await track(replica(repo)))).toEqual(await dump(db))
  })

  it('enforces foreign keys by default, and records the setting with schema changes', async () => {
    const schema = [
      ['CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL)'],
      [
        'CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL, parent TEXT REFERENCES parent (id) ON DELETE CASCADE)',
      ],
      ["INSERT INTO parent VALUES ('p')"],
      ["INSERT INTO child VALUES ('c', 'p')"],
    ] as const
    const on = await fresh()
    await on.db.transaction(schema)
    await expect(on.db.query("INSERT INTO child VALUES ('d', 'nope')")).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    )

    // Off, a schema-changing call deletes the parent without the cascade,
    // and a replica opened with them on replays it the same way.
    const off = await fresh({ foreignKeys: false })
    await off.db.transaction(schema)
    await off.db.transaction([
      ["DELETE FROM parent WHERE id = 'p'"],
      ['CREATE INDEX c_p ON child (parent)'],
    ])
    expect(await dump(off.db)).toMatchObject({ parent: [], child: [{ id: 'c' }] })
    const copy = await track(replica(off.repo, { foreignKeys: true }))
    expect(await dump(copy)).toEqual(await dump(off.db))
    // The replica's own connection still enforces them.
    await expect(copy.query("INSERT INTO child VALUES ('e', 'nope')")).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    )
    // A row that breaks a foreign key, logged with them off, is refused
    // by a replay that enforces them.
    await off.db.query("INSERT INTO child VALUES ('d', 'nope')")
    await off.db.flush()
    await expect(replica(off.repo, { foreignKeys: true })).rejects.toThrow(
      /conflicts with the database \(1 broken foreign key\)/,
    )
    expect(await dump(await track(replica(off.repo, { foreignKeys: false })))).toEqual(
      await dump(off.db),
    )
  })

  it('refuses calls after close', async () => {
    const { db } = await fresh()
    await db.close()
    expect(db.closed).toBe(true)
    await expect(db.query('SELECT 1')).rejects.toThrow(KvsqlError)
    await expect(db.flush()).rejects.toThrow('the database is closed')
    await db.close()
  })

  it('refuses arguments that are not statements', async () => {
    const { db } = await fresh()
    await expect(db.transaction([['SELECT 1', 5 as never]])).rejects.toThrow(TypeError)
    await expect(db.transaction(['SELECT 1' as never])).rejects.toThrow(TypeError)
  })
})

describe('opening', () => {
  it('refuses a file that already has a schema outside any log', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, NAME)
    file.db.exec('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
    file.close()
    await expect(open(dir, await repoOver())).rejects.toThrow(
      /already has a schema, but no log position/,
    )
    // And the file is released.
    ;(await openDatabase(dir, NAME)).close()
  })

  it('refuses a file of another branch', async () => {
    const { dir, repo, db } = await fresh()
    await db.close()
    await expect(open(dir, repo, { branch: 'other' })).rejects.toThrow(
      "the database file belongs to the log on branch 'db/test/0', not 'other'",
    )
  })

  it('reopens with its transactions, flushed and pending', async () => {
    const store = new CrashingStore(new Memory())
    const dir = new MemoryDirectory()
    const errors: unknown[] = []
    const db = await open(dir, await repoOver(store), { onFlushError: (e) => errors.push(e) })
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
    await db.query("INSERT INTO t VALUES ('a')")
    await db.flush()
    await db.query("INSERT INTO t VALUES ('b')")
    // Close can't flush, so it closes with the transaction pending.
    store.failNextWrite()
    await db.close()
    expect(errors).toHaveLength(1)
    const again = await track(open(dir, await repoOver(store)))
    expect(again.pendingCount).toBe(1)
    expect(again.recovery).toEqual({ ownFlush: false, entries: 0, transactions: 0 })
    expect(await dump(again)).toMatchObject({ t: [{ id: 'a' }, { id: 'b' }] })
    expect(await again.flush()).toMatchObject({ from: 3, to: 3 })
  })
})

describe('flushing', () => {
  it('flushes every N transactions', async () => {
    const { db, repo } = await fresh({ flush: { every: 3 } })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v)')
    const counts: number[] = []
    for (let i = 0; i < 7; i++) {
      await db.query('INSERT INTO t (v) VALUES (?)', [i])
      counts.push(db.pendingCount)
    }
    expect(counts).toEqual([1, 2, 0, 1, 2, 0, 1])
    const entries = await logEntries(repo)
    expect(entries.map((e) => [e.info.from, e.info.to])).toEqual([
      [1, 1],
      [2, 4],
      [5, 7],
    ])
  })

  it('flushes when the oldest pending transaction reaches the max age', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { db, repo } = await fresh({ flush: { every: 0, maxAgeMs: 1000 } })
      await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v)')
      await db.query('INSERT INTO t (v) VALUES (1)')
      await vi.advanceTimersByTimeAsync(600)
      // A later transaction doesn't restart the clock.
      await db.query('INSERT INTO t (v) VALUES (2)')
      await vi.advanceTimersByTimeAsync(300)
      expect(db.pendingCount).toBe(2)
      await vi.advanceTimersByTimeAsync(100)
      await db.query('SELECT 1') // waits for the queued flush
      expect(db.pendingCount).toBe(0)
      expect((await logEntries(repo)).at(-1)?.info).toMatchObject({ from: 2, to: 3 })
      // Nothing pending, nothing armed.
      await vi.advanceTimersByTimeAsync(5000)
      expect((await logEntries(repo)).length).toBe(2)
      await db.query('INSERT INTO t (v) VALUES (3)')
      await vi.advanceTimersByTimeAsync(1000)
      await db.query('SELECT 1')
      expect(db.pendingCount).toBe(0)
      // Closing clears the timer.
      await db.query('INSERT INTO t (v) VALUES (4)')
      await db.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes when asked, and on close', async () => {
    const { db, repo, dir } = await fresh({ flush: { every: 0 } })
    expect(await db.flush()).toBeNull()
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v)')
    await db.query('INSERT INTO t (v) VALUES (1)')
    await db.query('INSERT INTO t (v) VALUES (2)')
    const result = await db.flush()
    expect(result).toMatchObject({ from: 2, to: 3, pieces: 2 })
    expect(result?.commit).toBe(db.base)
    expect(await db.flush()).toBeNull()
    await db.query('INSERT INTO t (v) VALUES (3)')
    await db.close()
    expect((await logEntries(repo)).at(-1)?.info).toMatchObject({ from: 4, to: 4 })
    const again = await track(open(new MemoryDirectory(dir.image()), repo))
    expect(again.pendingCount).toBe(0)
  })

  it('keeps transactions pending when a flush fails, and retries', async () => {
    const store = new CrashingStore(new Memory())
    const repo = await repoOver(store)
    const errors: unknown[] = []
    const db = await track(
      open(new MemoryDirectory(), repo, {
        flush: { every: 2 },
        onFlushError: (err) => errors.push(err),
      }),
    )
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v)')
    await db.query('INSERT INTO t (v) VALUES (1)')
    store.failNextWrite()
    // The call itself succeeds; its flush fails.
    await db.query('INSERT INTO t (v) VALUES (2)')
    expect(errors).toHaveLength(1)
    expect(db.flushError).toBe(errors[0])
    expect(db.pendingCount).toBe(2)
    store.failNextWrite()
    await expect(db.flush()).rejects.toThrow(/simulated store failure/)
    expect(await db.flush()).toMatchObject({ from: 2, to: 3 })
    expect(db.flushError).toBeUndefined()
    expect(await dump(await track(replica(repo)))).toEqual(await dump(db))
  })
})

describe('a flush whose commit landed but failed', () => {
  it('is recognized by the next flush, not written twice', async () => {
    const store = new CrashingStore(new Memory())
    const repo = await repoOver(store)
    const db = await track(open(new MemoryDirectory(), repo, { flush: { every: 0 } }))
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v)')
    await db.query('INSERT INTO t (v) VALUES (1)')
    // How many writes a flush's commit makes: the last publishes it.
    const before = store.writes
    await db.flush()
    const perCommit = store.writes - before

    await db.query('INSERT INTO t (v) VALUES (2)')
    store.loseReplyAt(perCommit)
    await expect(db.flush()).rejects.toThrow(/lost reply/)
    expect(db.pendingCount).toBe(1)
    const entries = (await logEntries(repo)).length
    await db.query('INSERT INTO t (v) VALUES (3)')
    // The landed entry holds transaction 3; this flush finds it, drops
    // it, and commits transaction 4 alone.
    expect(await db.flush()).toMatchObject({ from: 4, to: 4 })
    const log = await logEntries(repo)
    expect(log.length).toBe(entries + 1)
    expect(log.map((e) => [e.info.from, e.info.to])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ])
    expect(await dump(await track(replica(repo)))).toEqual(await dump(db))
  })
})

describe('the entry format', () => {
  it('packs distinct edits and merges a run that rewrites the same rows', async () => {
    const { db, repo } = await fresh({ flush: { every: 0 } })
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v INTEGER)')
    for (let i = 0; i < 10; i++) await db.query('INSERT INTO t VALUES (?, ?)', [`k${i}`, i])
    await db.flush()
    await db.query("INSERT INTO t VALUES ('hot', 0)")
    for (let i = 0; i < 20; i++) await db.query("UPDATE t SET v = v + 1 WHERE id = 'hot'")
    await db.flush()
    const [, packed, merged] = await logEntries(repo)
    expect(packed?.pieces.map((p) => [p.from, p.to])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i + 2, i + 2]),
    )
    expect(merged?.pieces.map((p) => [p.kind, p.from, p.to])).toEqual([['changeset', 12, 32]])
    expect(merged?.info).toMatchObject({ v: 1, from: 12, to: 32, schema: 1 })
    expect(await dump(await track(replica(repo)))).toEqual(await dump(db))
  })

  it('keeps a schema change between runs, and runs of other schema versions apart', () => {
    const scratch = new sqlite3.oo1.DB(':memory:')
    try {
      scratch.exec(
        "CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v INTEGER); INSERT INTO t VALUES ('hot', 0)",
      )
      const bump = () => {
        const session = startSession(sqlite3, scratch)
        scratch.exec("UPDATE t SET v = v + 1 WHERE id = 'hot'")
        const cs = session.changeset()
        session.dispose()
        return cs
      }
      const items: PendingItem[] = []
      const run = (schema: number) => {
        for (let i = 0; i < 5; i++) {
          items.push({ seq: items.length + 1, kind: 'changeset', body: bump(), schema })
        }
      }
      run(1)
      items.push({
        seq: items.length + 1,
        kind: 'sql',
        body: encodeSqlBody({ foreignKeys: true, statements: [['CREATE INDEX i ON t (v)', null]] }),
        schema: 1,
      })
      run(2)
      run(3)
      items.push({ seq: items.length + 1, kind: 'changeset', body: bump(), schema: 3 })
      const { bytes, pieces } = encodeEntry(sqlite3, items)
      expect(pieces.map((p) => [p.kind, p.from, p.to, p.schema])).toEqual([
        ['changeset', 1, 5, 1],
        ['sql', 6, 6, 1],
        ['changeset', 7, 11, 2],
        ['changeset', 12, 17, 3],
      ])
      expect(bytes[0]).toBe(1)
      expect(decodeEntry(bytes)).toEqual(pieces)
      // The same items always encode to the same bytes.
      expect(encodeEntry(sqlite3, items).bytes).toEqual(bytes)
      expect(() =>
        encodeEntry(sqlite3, [items[0] as PendingItem, items[2] as PendingItem]),
      ).toThrow(/aren't consecutive/)
    } finally {
      scratch.close()
    }
  })

  it('records the length and digest of each entry, and refuses a mismatch', async () => {
    const { db, repo } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v)')
    await db.query("INSERT INTO t VALUES ('a', 1), ('b', 2)")
    await db.query("INSERT INTO t VALUES ('c', 3)")
    await db.flush()
    const [, entry] = await logEntries(repo)
    const bytes = (await (
      await repo.snapshot({ commit: entry?.commit as string })
    ).get(ENTRY_KEY)) as Uint8Array
    expect(entry?.info).toEqual({
      v: 1,
      from: 2,
      to: 3,
      length: bytes.byteLength,
      digest: await sha256Hex(bytes),
      schema: 1,
    })

    // Each tampered log: the entry's last commit replaced on a copy of the branch.
    const tampered = async (b: Uint8Array, info: object) => {
      const store = new Memory()
      const copy = await repoOver(store)
      const wt = await copy.worktree(BRANCH, { create: true })
      for (const e of await logEntries(repo)) {
        if (e.commit === entry?.commit) break
        const v = await (await repo.snapshot({ commit: e.commit })).get(ENTRY_KEY)
        wt.set(ENTRY_KEY, v as Uint8Array)
        await wt.commit({ info: e.info })
      }
      wt.set(ENTRY_KEY, b)
      await wt.commit({ info: { ...info } })
      return replica(copy).then(
        () => undefined,
        (err: unknown) => err,
      )
    }
    const info = entry?.info as Record<string, unknown>

    // A byte changed.
    const flipped = bytes.slice()
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1
    const err1 = await tampered(flipped, info)
    expect(err1).toBeInstanceOf(CorruptEntryError)
    expect((err1 as Error).message).toMatch(/SHA-256 doesn't match/)

    // Cut short, as a changeset cut at a change boundary still parses.
    const err2 = await tampered(bytes.subarray(0, bytes.length - 10), info)
    expect((err2 as Error).message).toMatch(
      new RegExp(`is ${bytes.length - 10} bytes long, but its commit records ${bytes.length}`),
    )

    // Cut short with a digest to match: still decoded and refused.
    const cut = bytes.subarray(0, bytes.length - 10)
    const err3 = await tampered(cut, { ...info, length: cut.length, digest: await sha256Hex(cut) })
    expect(err3).toBeInstanceOf(CorruptEntryError)

    // A format this version doesn't know.
    const future = bytes.slice()
    future[0] = 2
    const err4 = await tampered(future, { ...info, digest: await sha256Hex(future) })
    expect((err4 as Error).message).toMatch(/entry format 2, which this version doesn't read/)

    // A commit that isn't an entry at all.
    const err5 = await tampered(bytes, { note: 'hello' })
    expect(err5).toBeInstanceOf(LogError)
    expect((err5 as Error).message).toMatch(/isn't a kvsql log entry/)

    // A range that doesn't follow the one before.
    const err6 = await tampered(bytes, { ...info, from: 5, to: 6 })
    expect((err6 as Error).message).toMatch(/starts at transaction 5, not 2/)

    // The untampered log replays.
    expect(await dump(await track(replica(repo)))).toEqual(await dump(db))
  })
})

describe('replay refuses what SQLite would skip', () => {
  quietSqliteWarnings()

  /** A log of one table, `t (id, a, b)`, with one row. */
  async function base() {
    const { db, repo } = await fresh()
    await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a, b)')
    await db.query("INSERT INTO t VALUES ('x', 1, 2)")
    await db.flush()
    return { db, repo }
  }

  /** A changeset recorded on a scratch database built by `schema`. */
  function recorded(schema: string, change: string): Uint8Array {
    const scratch = new sqlite3.oo1.DB(':memory:')
    try {
      scratch.exec(schema)
      const session = startSession(sqlite3, scratch)
      scratch.exec(change)
      const cs = session.changeset()
      session.dispose()
      return cs
    } finally {
      scratch.close()
    }
  }

  it('a changeset whose column count differs from the table', async () => {
    const { db, repo } = await base()
    const wide = recorded(
      'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a, b, c)',
      "INSERT INTO t VALUES ('y', 1, 2, 3)",
    )
    await appendItems(repo, [{ seq: db.seq + 1, kind: 'changeset', body: wide, schema: 1 }])
    const err = await replica(repo).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplayError)
    expect((err as Error).message).toMatch(
      /at transaction 3: it records 4 columns for table "t", which has 3: SQLite would skip those changes/,
    )
  })

  it('a changeset for a table that does not exist', async () => {
    const { db, repo } = await base()
    const other = recorded(
      'CREATE TABLE u (id TEXT PRIMARY KEY NOT NULL)',
      "INSERT INTO u VALUES ('y')",
    )
    await appendItems(repo, [{ seq: db.seq + 1, kind: 'changeset', body: other, schema: 1 }])
    await expect(replica(repo)).rejects.toThrow(/it changes table "u", which doesn't exist/)
  })

  it('a changeset written under another schema version', async () => {
    const { db, repo } = await base()
    const fine = recorded(
      'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a, b)',
      "INSERT INTO t VALUES ('y', 1, 2)",
    )
    await appendItems(repo, [{ seq: db.seq + 1, kind: 'changeset', body: fine, schema: 7 }])
    await expect(replica(repo)).rejects.toThrow(
      /it was written under schema version 7, but the database is at version 1/,
    )
  })

  it('a schema change written under another schema version', async () => {
    const { db, repo } = await base()
    const body = encodeSqlBody({
      foreignKeys: true,
      statements: [['CREATE TABLE u (id TEXT PRIMARY KEY NOT NULL)', null]],
    })
    await appendItems(repo, [{ seq: db.seq + 1, kind: 'sql', body, schema: 0 }])
    await expect(replica(repo)).rejects.toThrow(
      /its schema change was written under schema version 0, but the database is at version 1/,
    )
  })

  it('a conflict with the database, which means the log and the database diverged', async () => {
    const { db, repo } = await base()
    const dir = new MemoryDirectory()
    await (await open(dir, repo)).close()
    const dup = recorded(
      'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a, b)',
      "INSERT INTO t VALUES ('x', 9, 9)",
    )
    await appendItems(repo, [{ seq: db.seq + 1, kind: 'changeset', body: dup, schema: 1 }])
    const err = await open(dir, repo).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplayError)
    expect((err as Error).message).toMatch(
      /it conflicts with the database \(CONFLICT on INSERT of "t" key \["x"\]\)/,
    )
  })

  it('stops where it failed, keeping what it applied, and resumes there', async () => {
    const { db, repo } = await base()
    await db.query("INSERT INTO t VALUES ('y', 3, 4)")
    await db.flush()
    const next = recorded(
      'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, a, b)',
      "INSERT INTO t VALUES ('z', 0, 0)",
    )
    await appendItems(repo, [{ seq: db.seq + 1, kind: 'changeset', body: next, schema: 9 }])
    const dir = new MemoryDirectory()
    const err = await open(dir, repo).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'ReplayError', seq: 4 })
    // The entries before it are in the file.
    const file = await openDatabase(dir, NAME)
    try {
      expect(file.db.selectValue('SELECT applied_seq FROM _kvsql_meta')).toBe(3)
      expect(file.db.selectValues('SELECT id FROM t ORDER BY id')).toEqual(['x', 'y'])
    } finally {
      file.close()
    }
    await expect(open(dir, repo)).rejects.toMatchObject({ name: 'ReplayError', seq: 4 })
  })
})

describe('another copy flushing to the same branch', () => {
  it('needs a rebase, which throws its own error', async () => {
    const repo = await repoOver()
    const a = await track(open(new MemoryDirectory(), repo))
    await a.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v)')
    const bDir = new MemoryDirectory()
    const b = await track(open(bDir, repo, { flush: { every: 0 } }))
    expect(b.schemaVersion).toBe(1)
    await a.query("INSERT INTO t VALUES ('a', 1)")
    await a.flush()
    await b.query("INSERT INTO t VALUES ('b', 1)")
    const err = await b.flush().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RebaseRequiredError)
    expect(err).toMatchObject({ pending: 1, entries: 1 })
    expect((err as Error).message).toBe(
      "this database has 1 transaction not yet in its log, and the log has 1 entry it didn't write: they need a rebase, which isn't supported yet",
    )
    // Nothing changed: b keeps its transaction, the log a's entry.
    expect(b.pendingCount).toBe(1)
    expect(await dump(b)).toMatchObject({ t: [{ id: 'b', v: 1 }] })
    // Opening the file again refuses the same way.
    await expect(open(new MemoryDirectory(bDir.image()), repo)).rejects.toThrow(RebaseRequiredError)
    // With nothing pending, a copy just catches up.
    const c = await track(replica(repo))
    expect(await dump(c)).toMatchObject({ t: [{ id: 'a', v: 1 }] })
  })
})
