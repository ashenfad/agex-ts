/**
 * A dedicated worker that runs the OPFS scenarios for
 * `opfs.browser.test.ts` (synchronous access handles exist only in
 * dedicated workers). Each message `{ id, scenario }` is answered with
 * `{ id, result }` or `{ id, error }`. Every scenario works in its own
 * OPFS directory and removes it when done.
 */

import {
  type CrashPoint,
  CrashingDirectory,
  OpfsDirectory,
  deleteDatabase,
  journalName,
  openDatabase,
} from '../src/index'

const ROOT = 'kvsql-tests'

type Row = { id: number; v: string }

async function withDirectory<T>(fn: (dir: OpfsDirectory, path: string) => Promise<T>): Promise<T> {
  const name = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const dir = await OpfsDirectory.at(ROOT, name)
  try {
    return await fn(dir, name)
  } finally {
    const root = await OpfsDirectory.at(ROOT)
    await root.handle.removeEntry(name, { recursive: true })
  }
}

async function fileSize(dir: OpfsDirectory, name: string): Promise<number> {
  const handle = await dir.handle.getFileHandle(name)
  return (await handle.getFile()).size
}

/** Whether SQLite would roll back from the journal: its first byte is non-zero. */
async function journalIsHot(dir: OpfsDirectory, name: string): Promise<boolean> {
  const file = await (await dir.handle.getFileHandle(journalName(name))).getFile()
  const first = new Uint8Array(await file.slice(0, 1).arrayBuffer())
  return first.length > 0 && first[0] !== 0
}

function errorName(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

const scenarios: Record<string, () => Promise<unknown>> = {
  /** Create, write, close, reopen, read back, delete. */
  roundtrip: () =>
    withDirectory(async (dir) => {
      const first = await openDatabase(dir, 'app.db')
      first.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      first.db.exec({ sql: 'INSERT INTO t VALUES (?, ?), (?, ?)', bind: [1, 'a', 2, 'b'] })
      first.close()

      const again = await openDatabase(dir, 'app.db')
      const rows = again.db.selectObjects('SELECT id, v FROM t ORDER BY id') as Row[]
      const journalMode = again.db.selectValue('PRAGMA journal_mode')
      const integrity = again.db.selectValue('PRAGMA integrity_check')
      again.close()

      const dbSize = await fileSize(dir, 'app.db')
      const journalHot = await journalIsHot(dir, 'app.db')
      await deleteDatabase(dir, 'app.db')
      const existsAfterDelete = {
        db: await dir.exists('app.db'),
        journal: await dir.exists(journalName('app.db')),
      }
      return { rows, journalMode, integrity, dbSize, journalHot, existsAfterDelete }
    }),

  /** What a second connection, or a delete, does while a database is open. */
  exclusive: () =>
    withDirectory(async (dir, path) => {
      const file = await openDatabase(dir, 'app.db')
      const attempt = async (fn: () => Promise<unknown>) => {
        try {
          await fn()
          return 'succeeded'
        } catch (err) {
          return errorName(err)
        }
      }
      const sameDirectory = await attempt(() => openDatabase(dir, 'app.db'))
      const otherHandle = await attempt(async () => {
        const other = await OpfsDirectory.at(ROOT, path)
        const db = await openDatabase(other, 'app.db')
        db.close()
      })
      file.db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('before delete')")
      const deleteWhileOpen = await attempt(() => dir.delete('app.db'))
      // Where a browser lets the file go, see what the open database
      // makes of it: whether it still works, and what is left after.
      const writeAfterDelete = await attempt(async () => {
        file.db.exec("INSERT INTO t VALUES ('after delete')")
      })
      const rowsBeforeClose = file.db.selectValue('SELECT count(*) FROM t')
      file.close()
      const existsAfterClose = await dir.exists('app.db')
      let rowsAfterReopen: unknown = null
      const reopen = await attempt(async () => {
        const again = await openDatabase(dir, 'app.db')
        rowsAfterReopen = again.db.selectValue(
          "SELECT count(*) FROM sqlite_schema WHERE name = 't'",
        )
          ? again.db.selectValue('SELECT count(*) FROM t')
          : 'no table'
        again.close()
      })
      return {
        sameDirectory,
        otherHandle,
        deleteWhileOpen,
        writeAfterDelete,
        rowsBeforeClose,
        existsAfterClose,
        reopen,
        rowsAfterReopen,
      }
    }),

  /**
   * Crash a transaction at several points on real OPFS files, then
   * reopen: the files must hold the last committed state, with the
   * journal rolled back and emptied.
   */
  recovery: async () => {
    const points: CrashPoint[] = [
      { op: 'write', n: 1 },
      { op: 'write', n: 3, torn: 100 },
      { op: 'sync', n: 1 },
      { op: 'sync', n: 2 },
      { op: 'sync', n: 3 },
      { op: 'sync', n: 4 },
    ]
    const out = []
    for (const point of points) {
      out.push(
        await withDirectory(async (dir) => {
          const base = await openDatabase(dir, 'app.db')
          base.db.exec(`
            CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
            WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 300)
            INSERT INTO t SELECT n, printf('row %d %0100d', n, n) FROM s;
          `)
          base.close()

          const crashing = new CrashingDirectory(dir)
          const file = await openDatabase(crashing, 'app.db')
          crashing.crashAt(point)
          let threw = false
          try {
            file.db.exec(`
              BEGIN;
              UPDATE t SET v = 'updated' WHERE id % 2 = 0;
              DELETE FROM t WHERE id % 5 = 0;
              COMMIT;
            `)
          } catch {
            threw = true
          }
          file.close()
          const hotAfterCrash = await journalIsHot(dir, 'app.db')

          const again = await openDatabase(dir, 'app.db')
          const state = again.db.selectValue(
            "SELECT count(*) || '/' || sum(v = 'updated') FROM t",
          ) as string
          const integrity = again.db.selectValue('PRAGMA integrity_check')
          again.close()
          return {
            point,
            threw,
            crashed: crashing.crashed !== null,
            hotAfterCrash,
            hotAfterReopen: await journalIsHot(dir, 'app.db'),
            state,
            integrity,
          }
        }),
      )
    }
    return out
  },

  /**
   * Rough timings: open, 1,000 one-row transactions, a 10k-row read and
   * a reopen; and, per journal mode, the cost and file operations of a
   * one-row transaction.
   */
  timings: () =>
    withDirectory(async (dir) => {
      const ms = (t0: number) => Math.round((performance.now() - t0) * 100) / 100
      const perMode: Record<string, unknown> = {}
      for (const mode of ['truncate', 'persist', 'delete']) {
        const counting = new CrashingDirectory(dir)
        const name = `${mode}.db`
        const file = await openDatabase(counting, name)
        file.db.exec(`PRAGMA journal_mode=${mode}`)
        file.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
        const insert = file.db.prepare('INSERT INTO t (v) VALUES (?)')
        const ops = { ...counting.ops }
        const t0 = performance.now()
        for (let i = 0; i < 1000; i++) insert.bind([`row ${i}`]).stepReset()
        const total = ms(t0)
        insert.finalize()
        const count = file.db.selectValue('SELECT count(*) FROM t')
        perMode[mode] = {
          msPerTransaction: Math.round(total) / 1000,
          rows: count,
          writes: (counting.ops.write - ops.write) / 1000,
          truncates: (counting.ops.truncate - ops.truncate) / 1000,
          syncs: (counting.ops.sync - ops.sync) / 1000,
        }
        file.close()
      }

      let t0 = performance.now()
      const file = await openDatabase(dir, 'app.db')
      const open = ms(t0)
      const { db } = file
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
      t0 = performance.now()
      for (let i = 0; i < 1000; i++) insert.bind([`row ${i}`]).stepReset()
      const inserts1000 = ms(t0)
      db.exec('BEGIN')
      for (let i = 0; i < 9000; i++) insert.bind([`bulk ${i} ${'x'.repeat(50)}`]).stepReset()
      db.exec('COMMIT')
      insert.finalize()
      t0 = performance.now()
      const read = db.selectArrays('SELECT id, v FROM t')
      const read10k = ms(t0)
      file.close()

      t0 = performance.now()
      const again = await openDatabase(dir, 'app.db')
      const reopen = ms(t0)
      again.close()
      return { open, inserts1000, read10k, rowsRead: read.length, reopen, perMode }
    }),
}

self.onmessage = async (event: MessageEvent<{ id: number; scenario: string }>) => {
  const { id, scenario } = event.data
  try {
    const run = scenarios[scenario]
    if (!run) throw new Error(`no scenario ${scenario}`)
    postMessage({ id, result: await run() })
  } catch (err) {
    postMessage({ id, error: errorName(err) + (err instanceof Error ? `\n${err.stack}` : '') })
  }
}
