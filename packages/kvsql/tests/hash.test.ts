/**
 * The content hash: the same for copies holding the same, whatever
 * their history, different for anything else they hold; recorded with
 * each snapshot, and compared by a copy moving to a new epoch from the
 * point its snapshot was taken.
 */

import type { Repo } from '@agex-ts/kvgit'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabaseFile } from '../src/database'
import { readSnapshot } from '../src/epoch'
import { DivergedError, HASH_BLOCK_ROWS, type LoggedDatabase, MemoryDirectory } from '../src/index'
import { BRANCH, NAME, open, quietSqliteWarnings, replica, repoOver } from './log-helpers'

quietSqliteWarnings()

const opened: LoggedDatabase[] = []
afterEach(async () => {
  for (const db of opened.splice(0)) if (!db.closed) await db.close().catch(() => {})
})
async function track(db: Promise<LoggedDatabase>): Promise<LoggedDatabase> {
  const it = await db
  opened.push(it)
  return it
}

async function fresh(repo?: Repo<Uint8Array>): Promise<LoggedDatabase> {
  return track(open(new MemoryDirectory(), repo ?? (await repoOver()), { flush: { every: 0 } }))
}

async function table(db: LoggedDatabase): Promise<void> {
  await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v)')
}

describe('the content hash', () => {
  it('is the same for the same rows, however they came to be', async () => {
    const repo = await repoOver()
    const a = await fresh(repo)
    const b = await fresh()
    await table(a)
    await table(b)
    await a.query("INSERT INTO t VALUES (1, 'one'), (2, 'two'), (3, 'three')")
    await b.query("INSERT INTO t VALUES (3, 'three'), (9, 'nine'), (1, 'uno')")
    await b.query("UPDATE t SET v = 'one' WHERE id = 1")
    await b.query('DELETE FROM t WHERE id = 9')
    await b.query("INSERT INTO t VALUES (2, 'two')")
    const hash = await a.contentHash()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await b.contentHash()).toBe(hash)
    // flushed or pending, the same; and a copy rebuilt from the log alone
    await a.flush()
    expect(await a.contentHash()).toBe(hash)
    expect(await (await track(replica(repo))).contentHash()).toBe(hash)
  })

  it('tells values of different types apart, and every change', async () => {
    const hashes = new Set<string>()
    for (const value of ['1', '1.0', "'1'", "x'31'", 'NULL']) {
      const db = await fresh()
      await table(db)
      await db.query(`INSERT INTO t VALUES (1, ${value})`)
      hashes.add(await db.contentHash())
    }
    expect(hashes.size).toBe(5)

    const db = await fresh()
    await table(db)
    const seen = [await db.contentHash()]
    for (const sql of [
      "INSERT INTO t VALUES (1, 'a')",
      "UPDATE t SET v = 'b' WHERE id = 1",
      'CREATE INDEX t_v ON t (v)',
      'PRAGMA user_version = 3',
      'CREATE TABLE u (id TEXT PRIMARY KEY NOT NULL)',
    ]) {
      await db.query(sql)
      seen.push(await db.contentHash())
    }
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('takes rows in key order across blocks', async () => {
    const a = await fresh()
    const b = await fresh()
    for (const db of [a, b]) {
      await db.query('CREATE TABLE t (k TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, n))')
    }
    const rows = HASH_BLOCK_ROWS + 500
    const series = (order: string) =>
      `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${rows}) SELECT 'k' || (i % 7), i FROM s ORDER BY i ${order}`
    await a.query(`INSERT INTO t ${series('ASC')}`)
    await b.query(`INSERT INTO t ${series('DESC')}`)
    expect(await a.contentHash()).toBe(await b.contentHash())
    await b.query('DELETE FROM t WHERE n = 1')
    expect(await a.contentHash()).not.toBe(await b.contentHash())
  })

  it('is recorded with a snapshot', async () => {
    const repo = await repoOver()
    const db = await fresh(repo)
    await table(db)
    await db.query("INSERT INTO t VALUES (1, 'a')")
    await db.flush()
    await db.query("INSERT INTO t VALUES (2, 'pending')")
    const hash = await db.contentHash()
    const epoch = await db.newEpoch()
    expect((await readSnapshot(repo, epoch.commit))?.hash).toBe(hash)
  })
})

describe('a copy at the point a snapshot was taken', () => {
  /** Two copies of a database on one repository, level, with nothing pending. */
  async function level() {
    const repo = await repoOver()
    const a = await fresh(repo)
    await table(a)
    await a.query("INSERT INTO t VALUES (1, 'a'), (2, 'b')")
    await a.flush()
    const bDir = new MemoryDirectory()
    const b = await track(open(bDir, repo))
    await b.close()
    return { repo, a, bDir }
  }

  it('moves to the new epoch when it holds what the snapshot does', async () => {
    const { repo, a, bDir } = await level()
    await a.newEpoch()
    const b = await track(open(bDir, repo))
    expect(b.branch).toBe('db/test/1')
    expect(await b.contentHash()).toBe(await a.contentHash())
  })

  it('stays where it is when it holds something else', async () => {
    const { repo, a, bDir } = await level()
    // changed outside the log
    const file = await openDatabaseFile(bDir, NAME)
    file.db.exec("UPDATE t SET v = 'tampered' WHERE id = 2")
    file.close()
    await a.newEpoch()
    const err = await open(bDir, repo).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DivergedError)
    expect(err).toMatchObject({ branch: BRANCH, expected: await a.contentHash() })
    expect((err as DivergedError).actual).not.toBe((err as DivergedError).expected)
    // the file is still on its epoch
    const again = await openDatabaseFile(bDir, NAME)
    expect(again.db.selectValue('SELECT branch FROM _kvsql_meta')).toBe(BRANCH)
    again.close()
  })
})
