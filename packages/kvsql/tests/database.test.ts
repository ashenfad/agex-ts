import type { Database } from '@sqlite.org/sqlite-wasm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CrashOp,
  type CrashPoint,
  CrashingDirectory,
  type DirectoryImage,
  JOURNAL_MODE,
  JOURNAL_SIZE_LIMIT,
  MemoryDirectory,
  deleteDatabase,
  journalName,
  loadSqlite,
  openDatabase,
} from '../src/index'

type Row = { id: number; v: string }

function rows(db: Database): Row[] {
  return db.selectObjects('SELECT id, v FROM t ORDER BY id') as Row[]
}

/** The integers `from` to `to` as a table with one column, `value`. */
function series(from: number, to: number): string {
  return `(WITH RECURSIVE s(value) AS (SELECT ${from} UNION ALL SELECT value + 1 FROM s WHERE value < ${to}) SELECT value FROM s)`
}

/**
 * Silences console warnings for the enclosing suite: the SQLite build
 * warns of every failed statement, and crash tests fail hundreds.
 */
function quietSqliteWarnings(): void {
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

/** Whether SQLite would roll back from this journal: its first byte is non-zero. */
function isHot(journal: Uint8Array | undefined): boolean {
  return journal !== undefined && journal.byteLength > 0 && journal[0] !== 0
}

function integrity(db: Database): unknown {
  return db.selectValue('PRAGMA integrity_check')
}

describe('openDatabase on a MemoryDirectory', () => {
  it('runs SQL', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, 'app.db')
    try {
      file.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      file.db.exec({ sql: 'INSERT INTO t VALUES (?, ?), (?, ?)', bind: [1, 'a', 2, 'b'] })
      expect(rows(file.db)).toEqual([
        { id: 1, v: 'a' },
        { id: 2, v: 'b' },
      ])
      expect(file.db.selectValue('PRAGMA journal_mode')).toBe(JOURNAL_MODE)
    } finally {
      file.close()
    }
    expect(dir.names()).toEqual(['app.db', 'app.db-journal'])
  })

  it('keeps data across close and reopen', async () => {
    const dir = new MemoryDirectory()
    const first = await openDatabase(dir, 'app.db')
    first.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')")
    first.close()
    expect(first.closed).toBe(true)
    first.close()

    const again = await openDatabase(dir, 'app.db')
    expect(rows(again.db)).toEqual([{ id: 1, v: 'a' }])
    again.close()

    // A copy of the files is the same database.
    const copy = await openDatabase(new MemoryDirectory(dir.image()), 'app.db')
    expect(rows(copy.db)).toEqual([{ id: 1, v: 'a' }])
    copy.close()
  })

  it('releases its files when the connection is closed directly', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, 'app.db')
    file.db.close()
    expect(file.closed).toBe(true)
    // The files are free again: the directory lets them be opened.
    ;(await dir.open('app.db')).close()
    ;(await dir.open('app.db-journal')).close()
  })

  it('leaves the journal cold after commit and rollback, and caps what it keeps', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, 'app.db')
    const journal = () => dir.image().get(journalName('app.db')) ?? new Uint8Array()
    file.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    file.db.exec("INSERT INTO t VALUES (1, 'a')")
    // The journal persists between transactions, with a zeroed header.
    expect(journal().byteLength).toBeGreaterThan(0)
    expect(isHot(journal())).toBe(false)

    // Once a changed page reaches the file mid-transaction, the
    // journal is hot until the transaction ends either way.
    file.db.exec('PRAGMA cache_size = 2')
    file.db.exec('BEGIN')
    file.db.exec(`UPDATE t SET v = 'b'`)
    file.db.exec(`INSERT INTO t SELECT value + 1, hex(randomblob(500)) FROM ${series(1, 200)}`)
    expect(isHot(journal())).toBe(true)
    file.db.exec('ROLLBACK')
    expect(isHot(journal())).toBe(false)
    expect(rows(file.db)).toEqual([{ id: 1, v: 'a' }])

    // A transaction that journals more than the limit leaves the limit.
    file.db.exec(`INSERT INTO t SELECT value + 1, hex(randomblob(2000)) FROM ${series(1, 1000)}`)
    file.db.exec(`UPDATE t SET v = 'x' || v`)
    expect(journal().byteLength).toBe(JOURNAL_SIZE_LIMIT)
    expect(isHot(journal())).toBe(false)
    expect(integrity(file.db)).toBe('ok')
    file.close()
  })

  it('refuses a second connection to the same database', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, 'app.db')
    await expect(openDatabase(dir, 'app.db')).rejects.toThrow(/already open/)
    // The same name in another directory is another database.
    const other = await openDatabase(new MemoryDirectory(), 'app.db')
    other.close()
    file.close()
    ;(await openDatabase(dir, 'app.db')).close()
  })

  it('refuses WAL mode, whose files it does not provide', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, 'app.db')
    try {
      file.db.exec('CREATE TABLE t (x)')
      expect(() => file.db.exec('PRAGMA journal_mode=WAL')).toThrow(/WAL mode is not supported/)
      file.db.exec('PRAGMA locking_mode=EXCLUSIVE')
      expect(() => file.db.exec("PRAGMA main.journal_mode='wal'")).toThrow(/not supported/)
      file.db.exec('INSERT INTO t VALUES (1)')
      expect(file.db.selectValue('PRAGMA journal_mode')).toBe(JOURNAL_MODE)
    } finally {
      file.close()
    }
    const again = await openDatabase(dir, 'app.db')
    expect(again.db.selectValue('SELECT count(*) FROM t')).toBe(1)
    again.close()
  })

  it('keeps temp tables and sort spills in memory, outside the directory', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, 'app.db')
    try {
      file.db.exec('PRAGMA cache_size = 2')
      file.db.exec(`CREATE TEMP TABLE scratch AS SELECT value AS n FROM ${series(1, 5000)}`)
      expect(file.db.selectValue('SELECT sum(n) FROM scratch')).toBe(12502500)
      const top = file.db.selectValue(
        'SELECT n FROM (SELECT n, hex(randomblob(100)) AS pad FROM scratch ORDER BY pad) LIMIT 1',
      )
      expect(typeof top).toBe('number')
    } finally {
      file.close()
    }
    expect(dir.names()).toEqual(['app.db', 'app.db-journal'])
  })

  it('reports a bad name', async () => {
    await expect(openDatabase(new MemoryDirectory(), 'a/b')).rejects.toThrow(/bad database name/)
  })
})

describe('deleteDatabase', () => {
  quietSqliteWarnings()

  it('deletes the database and its journal', async () => {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, 'app.db')
    file.db.exec('CREATE TABLE t (x)')
    await expect(deleteDatabase(dir, 'app.db')).rejects.toThrow(/open/)
    file.close()
    const keep = await openDatabase(dir, 'keep.db')
    keep.close()

    await deleteDatabase(dir, 'app.db')
    expect(dir.names()).toEqual(['keep.db', 'keep.db-journal'])
    const fresh = await openDatabase(dir, 'app.db')
    expect(fresh.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name = 't'")).toBe(0)
    fresh.close()
  })
  it('ignores a hot journal left beside a deleted database file', async () => {
    // A crash mid-transaction leaves a hot journal; a delete
    // interrupted after removing the database file leaves the journal.
    const mem = new MemoryDirectory()
    const file = await openDatabase(mem, 'app.db')
    file.db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
      INSERT INTO t SELECT value, hex(randomblob(500)) FROM ${series(1, 100)}`)
    file.close()
    const dir = new CrashingDirectory(mem)
    const crashing = await openDatabase(dir, 'app.db')
    crashing.db.exec('PRAGMA cache_size = 2')
    dir.crashAt({ op: 'sync', n: 3 })
    expect(() => crashing.db.exec(`UPDATE t SET v = 'x'`)).toThrow()
    crashing.close()
    const image = new Map(mem.image())
    expect(isHot(image.get(journalName('app.db')))).toBe(true)
    image.delete('app.db')

    const left = new MemoryDirectory(image)
    const fresh = await openDatabase(left, 'app.db')
    expect(fresh.db.selectValue('SELECT count(*) FROM sqlite_schema')).toBe(0)
    fresh.db.exec('CREATE TABLE u (x); INSERT INTO u VALUES (1)')
    expect(integrity(fresh.db)).toBe('ok')
    fresh.close()
    expect(isHot(left.image().get(journalName('app.db')))).toBe(false)
  })
})

/**
 * Crash tests. A transaction touching many pages runs once to record
 * its file operations in order, then again for every operation,
 * crashing there (and for writes, crashing with the write torn at
 * several lengths). Each crash's files must reopen as a sound database
 * holding exactly the state before the transaction, if the crash came
 * before the commit point, or after it, if it came later. The commit
 * point is the write that zeroes the journal's header: it commits once
 * the header's first byte is zero, so a torn commit write that lands
 * any of its bytes has committed.
 */
describe('crash safety', () => {
  const NAME = 'app.db'
  quietSqliteWarnings()

  /** A database of 300 rows across many pages. */
  async function base(): Promise<DirectoryImage> {
    const dir = new MemoryDirectory()
    const file = await openDatabase(dir, NAME)
    file.db.exec(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
      CREATE INDEX t_v ON t (v);
      INSERT INTO t SELECT value, 'row ' || value || ' ' || hex(randomblob(60))
        FROM ${series(1, 300)};
    `)
    file.close()
    return dir.image()
  }

  /**
   * Updates, inserts and deletes rows all over the table in one
   * transaction, deterministically, so every run ends in the same state.
   */
  function transaction(db: Database): void {
    db.exec(`
      BEGIN;
      UPDATE t SET v = 'updated ' || id || ' ' || printf('%080d', id * 7919) WHERE id % 3 = 0;
      INSERT INTO t SELECT value, 'new ' || value FROM ${series(301, 400)};
      DELETE FROM t WHERE id % 7 = 0;
      COMMIT;
    `)
  }

  /** A directory that records the order of its operations. */
  class TracingDirectory extends CrashingDirectory {
    readonly trace: { op: CrashOp; name: string }[] = []
    protected override tick(op: CrashOp, name: string): CrashPoint | undefined {
      this.trace.push({ op, name })
      return super.tick(op, name)
    }
  }

  async function reopen(image: DirectoryImage): Promise<{ integrity: unknown; rows: Row[] }> {
    const dir = new MemoryDirectory(image)
    const file = await openDatabase(dir, NAME)
    try {
      const state = { integrity: integrity(file.db), rows: rows(file.db) }
      // Reading rolled back any hot journal.
      expect(isHot(dir.image().get(journalName(NAME)))).toBe(false)
      // The recovered database takes the next write.
      file.db.exec("INSERT INTO t VALUES (100000, 'after recovery')")
      expect(isHot(dir.image().get(journalName(NAME)))).toBe(false)
      return state
    } finally {
      file.close()
    }
  }

  it.each([
    { pages: 'stay in the page cache until commit', cacheSize: 2000 },
    { pages: 'spill to the file mid-transaction', cacheSize: 2 },
  ])(
    'recovers to the last committed state from a crash at any write, truncate or sync, when pages $pages',
    async ({ cacheSize }) => {
      const image = await base()
      const open = async (dir: CrashingDirectory) => {
        const file = await openDatabase(dir, NAME)
        file.db.exec(`PRAGMA cache_size = ${cacheSize}`)
        return file
      }

      // The run without a crash: its operations, and the states either
      // side of the commit.
      const dry = new TracingDirectory(new MemoryDirectory(image))
      const file = await open(dry)
      const before = rows(file.db)
      dry.trace.length = 0
      transaction(file.db)
      const trace = [...dry.trace]
      const after = rows(file.db)
      file.close()
      expect(after).not.toEqual(before)

      const journalWrites = trace.flatMap((t, i) =>
        t.op === 'write' && t.name === journalName(NAME) ? [i] : [],
      )
      const commit = journalWrites[journalWrites.length - 1] ?? -1
      expect(commit).toBeGreaterThan(0)
      expect(trace.slice(commit + 1).every((t) => t.op === 'sync')).toBe(true)
      expect(trace.filter((t) => t.op === 'write').length).toBeGreaterThan(10)

      const points: CrashPoint[] = []
      const seen: Record<CrashOp, number> = { write: 0, truncate: 0, sync: 0 }
      const indexOf = new Map<CrashPoint, number>()
      trace.forEach(({ op }, i) => {
        const n = ++seen[op]
        const variants: CrashPoint[] =
          op === 'write'
            ? [
                { op, n },
                { op, n, torn: 1 },
                { op, n, torn: 512 },
                { op, n, torn: 4095 },
              ]
            : [{ op, n }]
        for (const p of variants) {
          points.push(p)
          indexOf.set(p, i)
        }
      })

      const outcomes = { before: 0, after: 0 }
      for (const point of points) {
        const mem = new MemoryDirectory(image)
        const dir = new CrashingDirectory(mem)
        const file = await open(dir)
        dir.crashAt(point)
        expect(() => transaction(file.db), JSON.stringify(point)).toThrow()
        file.close()
        expect(dir.crashed, JSON.stringify(point)).toEqual(point)

        const got = await reopen(mem.image())
        const label = `${JSON.stringify(point)} (operation ${indexOf.get(point)} of ${trace.length})`
        expect(got.integrity, label).toBe('ok')
        const at = indexOf.get(point) ?? 0
        const committed = at > commit || (at === commit && (point.torn ?? 0) > 0)
        expect(got.rows, label).toEqual(committed ? after : before)
        outcomes[committed ? 'after' : 'before']++
      }
      expect(outcomes.before).toBeGreaterThan(0)
      expect(outcomes.after).toBeGreaterThan(0)
    },
  )

  it('rolls back a hot journal on the first read after opening', async () => {
    const image = await base()
    const mem = new MemoryDirectory(image)
    const dir = new CrashingDirectory(mem)
    const file = await openDatabase(dir, NAME)
    const before = rows(file.db)
    // Crash at the database file's sync: the journal is complete and
    // the database file written.
    dir.crashAt({ op: 'sync', n: 3 })
    expect(() => transaction(file.db)).toThrow()
    file.close()
    const crashed = mem.image()
    expect(isHot(crashed.get(journalName(NAME)))).toBe(true)
    expect(crashed.get(NAME)).not.toEqual(image.get(NAME))

    const again = new MemoryDirectory(crashed)
    const reopened = await openDatabase(again, NAME)
    expect(rows(reopened.db)).toEqual(before)
    expect(isHot(again.image().get(journalName(NAME)))).toBe(false)
    expect(again.image().get(NAME)).toEqual(image.get(NAME))
    expect(integrity(reopened.db)).toBe('ok')
    reopened.close()
  })
})
