/**
 * Crash tests for the logged database. A transaction and a flush run
 * once to record every file operation and store write they make, then
 * again for each, crashing there: the file's directory dies at that
 * write, truncate or sync (writes also torn), or the kvgit store at
 * that write. A crash is the process dying: every handle is dropped,
 * and the next process opens what the files and the store hold.
 *
 * After each crash the database must reopen with `integrity_check` ok,
 * hold every transaction whose call returned and either all or none of
 * the one that crashed mid-call, flush to a log that a fresh copy
 * replays to the same state, and take a further write and flush.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { describe, expect, it } from 'vitest'
import {
  type CrashOp,
  type CrashPoint,
  CrashingDirectory,
  type DirectoryImage,
  MemoryDirectory,
  type Statement,
} from '../src/index'
import {
  CrashingStore,
  copyStore,
  dump,
  integrity,
  open,
  quietSqliteWarnings,
  replica,
  repoOver,
} from './log-helpers'

/** The integers `from` to `to` as a table with one column, `value`. */
function series(from: number, to: number): string {
  return `(WITH RECURSIVE s(value) AS (SELECT ${from} UNION ALL SELECT value + 1 FROM s WHERE value < ${to}) SELECT value FROM s)`
}

/** Updates, inserts and deletes rows across many pages, deterministically. */
const TRANSACTION: Statement[] = [
  ["UPDATE t SET v = 'changed ' || id || ' ' || printf('%080d', id * 7919) WHERE id % 3 = 0"],
  [
    `INSERT INTO t SELECT value, 'new ' || value || ' ' || printf('%0100d', value) FROM ${series(201, 300)}`,
  ],
  ['DELETE FROM t WHERE id % 7 = 0'],
]

/** A directory that records the order of its operations. */
class TracingDirectory extends CrashingDirectory {
  readonly trace: { op: CrashOp; name: string }[] = []
  protected override tick(op: CrashOp, name: string): CrashPoint | undefined {
    this.trace.push({ op, name })
    return super.tick(op, name)
  }
}

type Point = { file: CrashPoint } | { store: number }

/**
 * The starting state: a table of 200 rows in the log, plus one
 * transaction pending in the file.
 */
async function start(): Promise<{ image: DirectoryImage; store: Memory }> {
  const store = new Memory()
  const kv = new CrashingStore(store)
  const dir = new MemoryDirectory()
  const db = await open(dir, await repoOver(kv), { flush: { every: 0 } })
  await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)')
  await db.query(
    `INSERT INTO t SELECT value, 'row ' || value || ' ' || printf('%0100d', value) FROM ${series(1, 200)}`,
  )
  await db.flush()
  await db.query("UPDATE t SET v = 'pending ' || id WHERE id % 10 = 0")
  // Closing can't flush it: it stays pending.
  kv.failNextWrite()
  await db.close()
  return { image: dir.image(), store }
}

describe('crash safety of the log', () => {
  quietSqliteWarnings()

  it.each([
    { pages: 'stay in the page cache until commit', cacheSize: 2000 },
    { pages: 'spill to the file mid-transaction', cacheSize: 2 },
  ])(
    'recovers from a crash anywhere in a transaction and its flush, when pages $pages',
    async ({ cacheSize }) => {
      const { image, store } = await start()

      /** Runs the transaction and the flush, crashing at `point` if given. */
      const run = async (point: Point | null) => {
        const mem = new MemoryDirectory(image)
        const dir = new TracingDirectory(mem)
        const inner = await copyStore(store)
        const kv = new CrashingStore(inner)
        const db = await open(dir, await repoOver(kv), { flush: { every: 0 } })
        expect(db.pendingCount).toBe(1)
        await db.query(`PRAGMA cache_size = ${cacheSize}`)
        dir.trace.length = 0
        const writes = kv.writes
        if (point && 'file' in point) dir.crashAt(point.file)
        if (point && 'store' in point) kv.crashAtWrite(point.store)
        let acked = 0
        let error: unknown
        let commitAt = -1
        try {
          await db.transaction(TRANSACTION)
          acked = 1
          const before = dir.trace.length
          await db.flush()
          commitAt = before
          acked = 2
        } catch (err) {
          error = err
        }
        const crashed = dir.crashed !== null || kv.crashed
        const trace = [...dir.trace]
        const storeWrites = kv.writes - writes
        // The process dies: nothing more reaches the files or the store.
        kv.kill()
        await db.close().catch(() => {})
        return { mem, inner, acked, error, crashed, trace, storeWrites, commitAt }
      }

      // The run without a crash: what it does, and the states either side.
      const dry = await run(null)
      expect(dry.acked).toBe(2)
      expect(dry.storeWrites).toBeGreaterThan(0)
      const reopen = async (mem: MemoryDirectory, inner: Memory) => {
        const repo = await repoOver(inner)
        return { repo, db: await open(new MemoryDirectory(mem.image()), repo) }
      }
      const beforeState = await (async () => {
        const db = await open(new MemoryDirectory(image), await repoOver(await copyStore(store)))
        const state = await dump(db)
        await db.close()
        return state
      })()
      const afterState = await (async () => {
        const { db } = await reopen(dry.mem, dry.inner)
        const state = await dump(db)
        expect(db.pendingCount).toBe(0)
        await db.close()
        return state
      })()
      expect(afterState).not.toEqual(beforeState)

      const points: { point: Point; at: string }[] = []
      const seen: Record<CrashOp, number> = { write: 0, truncate: 0, sync: 0 }
      dry.trace.forEach(({ op, name }, i) => {
        const n = ++seen[op]
        const stage = i < dry.commitAt ? 'transaction' : 'flush'
        const at = `${stage}: ${op} #${n} of ${name} (operation ${i + 1} of ${dry.trace.length})`
        points.push({ point: { file: { op, n } }, at })
        if (op === 'write') {
          points.push({ point: { file: { op, n, torn: 1 } }, at: `${at}, torn at 1` })
          points.push({ point: { file: { op, n, torn: 2048 } }, at: `${at}, torn at 2048` })
        }
      })
      for (let n = 1; n <= dry.storeWrites; n++) {
        points.push({ point: { store: n }, at: `flush: store write ${n} of ${dry.storeWrites}` })
      }

      const outcomes = { before: 0, after: 0, ownFlush: 0, pending: 0, flushed: 0, flushPoints: 0 }
      for (const { point, at } of points) {
        if (at.startsWith('flush')) outcomes.flushPoints++
        const got = await run(point)
        expect(got.crashed, at).toBe(true)
        const { repo, db } = await reopen(got.mem, got.inner)
        try {
          expect(await integrity(db), at).toBe('ok')
          const state = await dump(db)
          if (got.acked >= 1) expect(state, at).toEqual(afterState)
          else expect([beforeState, afterState], at).toContainEqual(state)
          if (JSON.stringify(state) === JSON.stringify(afterState)) outcomes.after++
          else outcomes.before++
          if (db.recovery.ownFlush) {
            expect(at, 'only a flush leaves its own entry behind').toMatch(/^flush/)
            outcomes.ownFlush++
          }
          if (db.pendingCount > 0) outcomes.pending++
          else outcomes.flushed++

          // The log replays to the same state on a fresh directory.
          await db.flush()
          expect(db.pendingCount, at).toBe(0)
          const copy = await replica(repo)
          expect(await dump(copy), at).toEqual(state)
          await copy.close()

          // And takes a further write and flush.
          await db.query("INSERT INTO t VALUES (100000, 'after recovery')")
          await db.flush()
          const copy2 = await replica(repo)
          expect(await dump(copy2), at).toEqual(await dump(db))
          await copy2.close()
        } finally {
          await db.close()
        }
      }
      // Every kind of outcome was reached.
      expect(outcomes.before).toBeGreaterThan(0)
      expect(outcomes.flushPoints).toBeGreaterThan(0)
      expect(outcomes.after).toBeGreaterThan(0)
      expect(outcomes.ownFlush).toBeGreaterThan(0)
      expect(outcomes.pending).toBeGreaterThan(0)
      expect(outcomes.flushed).toBeGreaterThan(0)
      console.info(`${points.length} crash points:`, outcomes)
    },
  )

  it('recovers from a crash while recovering: dropping its own flush, or replaying', async () => {
    const { image, store } = await start()
    // Flush, and crash at the delete's first write: the entry is in the
    // log, and the file still holds its transactions.
    const dry = new TracingDirectory(new MemoryDirectory(image))
    const dryDb = await open(dry, await repoOver(await copyStore(store)), { flush: { every: 0 } })
    dry.trace.length = 0
    await dryDb.flush()
    await dryDb.close()
    const deleteWrite = dry.trace.findIndex((t) => t.op === 'write')
    expect(deleteWrite).toBe(0)

    const mem = new MemoryDirectory(image)
    const crashing = new CrashingDirectory(mem)
    const inner = await copyStore(store)
    const db = await open(crashing, await repoOver(inner), { flush: { every: 0 } })
    crashing.crashAt({ op: 'write', n: 1 })
    await expect(db.flush()).rejects.toThrow()
    await db.close().catch(() => {})
    const landed = mem.image()
    const repo = await repoOver(inner)
    const expected = await (async () => {
      const db = await open(new MemoryDirectory(landed), repo)
      expect(db.recovery.ownFlush).toBe(true)
      const state = await dump(db)
      await db.close()
      return state
    })()

    /** Opens `image` crashing at every file operation, then once more. */
    const crashEverywhere = async (start: DirectoryImage) => {
      const probe = new CrashingDirectory(new MemoryDirectory(start))
      await (await open(probe, repo)).close()
      const counts = { ...probe.ops }
      let points = 0
      for (const op of ['write', 'truncate', 'sync'] as const) {
        for (let n = 1; n <= counts[op]; n++) {
          for (const torn of op === 'write' ? [undefined, 1, 2048] : [undefined]) {
            const at = `${op} #${n}${torn ? `, torn at ${torn}` : ''}`
            const mem = new MemoryDirectory(start)
            const dir = new CrashingDirectory(mem)
            dir.crashAt({ op, n, ...(torn !== undefined && { torn }) })
            const opened = await open(dir, repo).then(
              (db) => db,
              () => null,
            )
            await opened?.close().catch(() => {})
            const again = await open(new MemoryDirectory(mem.image()), repo)
            try {
              expect(await integrity(again), at).toBe('ok')
              expect(await dump(again), at).toEqual(expected)
              expect(again.pendingCount, at).toBe(0)
            } finally {
              await again.close()
            }
            points++
          }
        }
      }
      return points
    }

    const dropping = await crashEverywhere(landed)
    const replaying = await crashEverywhere(new Map())
    expect(dropping).toBeGreaterThan(0)
    expect(replaying).toBeGreaterThan(dropping)
    console.info(`${dropping} crash points dropping the own flush, ${replaying} replaying`)
  })
})
