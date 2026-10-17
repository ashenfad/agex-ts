/**
 * Epochs: a new epoch's snapshot, the move onto it, opening on the
 * newest epoch (rebuilding a file from its snapshot), the policy that
 * starts epochs by itself, and crashes at every write of a move.
 */

import { type KVStore, ROOT_COMMIT } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { describe, expect, it, vi } from 'vitest'
import {
  CorruptSnapshotError,
  type CrashOp,
  CrashingDirectory,
  type Directory,
  EPOCH_KEY,
  LogError,
  type LoggedDatabase,
  MemoryDirectory,
  SNAPSHOT_CHUNK,
  deleteLog,
  openDetached,
} from '../src/index'
import {
  BRANCH,
  CrashingStore,
  NAME,
  copyStore,
  dump,
  integrity,
  open,
  quietSqliteWarnings,
  replica,
  repoOver,
} from './log-helpers'

const NEXT = 'db/test/1'

/** The integers `from` to `to` as a table with one column, `value`. */
function series(from: number, to: number): string {
  return `(WITH RECURSIVE s(value) AS (SELECT ${from} UNION ALL SELECT value + 1 FROM s WHERE value < ${to}) SELECT value FROM s)`
}

/** A database with rows flushed to the log and two transactions pending. */
async function seeded(dir: Directory, repo: Awaited<ReturnType<typeof repoOver>>) {
  const db = await open(dir, repo, { flush: { every: 0 } })
  await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v TEXT)')
  await db.query(`INSERT INTO t SELECT value, printf('%0200d', value) FROM ${series(1, 300)}`)
  await db.flush()
  await db.query("INSERT INTO t VALUES (1000, 'pending')")
  await db.query('DELETE FROM t WHERE id % 5 = 0')
  return db
}

describe('a new epoch', () => {
  it('starts from a snapshot, holding what was pending, and the old epoch goes', async () => {
    const repo = await repoOver()
    const db = await seeded(new MemoryDirectory(), repo)
    expect(db.pendingCount).toBe(2)
    const before = await dump(db)

    const result = await db.newEpoch()
    expect(result).toMatchObject({
      branch: NEXT,
      previous: BRANCH,
      seq: 4,
      schema: 1,
      chunks: 1,
      commit: db.base,
    })
    expect(result.gzipped).toBeLessThan(result.bytes)
    expect(db.branch).toBe(NEXT)
    // the pending transactions are in the snapshot, not in any log
    expect(db.pendingCount).toBe(0)
    expect(db.seq).toBe(4)
    expect(await repo.branches.list()).toEqual([NEXT])
    expect(await repo.branches.get(NEXT)).toBe(result.commit)

    // the log goes on from the snapshot
    await db.query("INSERT INTO t VALUES (2000, 'after')")
    expect(await db.flush()).toMatchObject({ from: 5, to: 5 })
    const fresh = await replica(repo)
    expect(fresh.branch).toBe(NEXT)
    expect(fresh.recovery).toEqual({ ownFlush: false, entries: 1, transactions: 1, snapshot: true })
    expect(await dump(fresh)).toEqual(await dump(db))
    expect(await dump(fresh)).not.toEqual(before)
    expect(await integrity(fresh)).toBe('ok')
    await fresh.close()
    await db.close()
  })

  it('takes calls while the snapshot is committed, and flushes them to the new epoch', async () => {
    const repo = await repoOver()
    const db = await seeded(new MemoryDirectory(), repo)
    const epoch = db.newEpoch()
    // made while the snapshot is being committed
    const calls = [
      db.query("INSERT INTO t VALUES (3000, 'meanwhile')"),
      db.query('ALTER TABLE t ADD COLUMN w INTEGER'),
      db.query('UPDATE t SET w = 1 WHERE id = 3000'),
    ]
    const flushed = db.flush()
    const result = await epoch
    await Promise.all(calls)
    // the explicit flush waited for the move, and went to the new epoch
    expect(await flushed).toMatchObject({ from: result.seq + 1, to: db.seq })
    expect(result.seq).toBeLessThan(db.seq)
    expect(db.schemaVersion).toBe(2)
    const fresh = await replica(repo)
    expect(await dump(fresh)).toEqual(await dump(db))
    await fresh.close()
    await db.close()
  })

  it('waits for an epoch being started before closing', async () => {
    const repo = await repoOver()
    const dir = new MemoryDirectory()
    const db = await seeded(dir, repo)
    const epoch = db.newEpoch()
    await db.close()
    expect((await epoch).branch).toBe(NEXT)
    expect(db.closed).toBe(true)
    const again = await open(dir, repo)
    expect(again.branch).toBe(NEXT)
    expect(again.recovery.snapshot).toBe(false)
    await again.close()
  })

  it('is one at a time: a second call while one is started gets it', async () => {
    const repo = await repoOver()
    const db = await seeded(new MemoryDirectory(), repo)
    const [a, b] = await Promise.all([db.newEpoch(), db.newEpoch()])
    expect(a).toEqual(b)
    expect((await db.newEpoch()).branch).toBe('db/test/2')
    expect(await repo.branches.list()).toEqual(['db/test/2'])
    await db.close()
  })

  it('stores a snapshot in chunks, two to a commit', async () => {
    const repo = await repoOver()
    const db = await open(new MemoryDirectory(), repo)
    await db.query('CREATE TABLE b (id INTEGER PRIMARY KEY NOT NULL, v BLOB)')
    // random bytes don't compress: about 2.5 chunks gzipped
    for (let i = 0; i < 5; i++) {
      await db.query('INSERT INTO b VALUES (?, randomblob(?))', [i, SNAPSHOT_CHUNK / 2])
    }
    const result = await db.newEpoch()
    expect(result.chunks).toBe(3)
    const commits: unknown[] = []
    for (let c = result.commit; c !== ROOT_COMMIT; ) {
      const record = await repo.getCommit(c)
      commits.push(record.info)
      c = record.parents[0] ?? ROOT_COMMIT
    }
    expect(commits).toEqual([
      { v: 1, snapshot: { seq: 6, schema: 1, last: true } },
      { v: 1, snapshot: { seq: 6, schema: 1, last: false } },
    ])
    const fresh = await replica(repo)
    expect(
      (await fresh.query('SELECT count(*) AS n, sum(length(v)) AS bytes FROM b')).rows,
    ).toEqual([{ n: 5, bytes: (5 * SNAPSHOT_CHUNK) / 2 }])
    await fresh.close()
    await db.close()
  }, 60_000)

  it('works for a database whose name SQL or a URI would read as syntax', async () => {
    const repo = await repoOver()
    const dir = new MemoryDirectory()
    const name = "it's #1?.db"
    const db = await open(dir, repo, { name })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL)')
    await db.query('INSERT INTO t VALUES (1)')
    expect((await db.newEpoch()).branch).toBe(NEXT)
    await db.close()
    expect(dir.names()).toEqual([name, `${name}-journal`])
    const fresh = await open(new MemoryDirectory(), repo, { name })
    expect((await fresh.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }])
    await fresh.close()
  })

  it("leaves a database alone that a snapshot's name would clash with: such names are refused", async () => {
    const repo = await repoOver()
    await expect(open(new MemoryDirectory(), repo, { name: `${NAME}-snapshot` })).rejects.toThrow(
      /ends in -snapshot/,
    )
  })

  it('is refused past the last epoch number there is', async () => {
    const repo = await repoOver()
    const last = `db/test/${Number.MAX_SAFE_INTEGER}`
    const db = await open(new MemoryDirectory(), repo, { branch: last })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL)')
    await expect(db.newEpoch()).rejects.toThrow(/can't be counted past/)
    expect(await repo.branches.list()).toEqual([last])
    await db.close()
    // epochs with more digits than any before are still the log's
    const wide = await open(new MemoryDirectory(), repo, { branch: 'db/wide/999999999' })
    await wide.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL)')
    expect((await wide.newEpoch()).branch).toBe('db/wide/1000000000')
    await wide.close()
    const again = await open(new MemoryDirectory(), repo, { branch: 'db/wide/999999999' })
    expect(again.branch).toBe('db/wide/1000000000')
    await again.close()
  })

  it('is refused on a branch not named for epochs, and by a detached copy', async () => {
    const repo = await repoOver()
    const db = await open(new MemoryDirectory(), repo, { branch: 'main' })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL)')
    await expect(db.newEpoch()).rejects.toThrow(/isn't named for epochs/)
    expect(await repo.branches.list()).toEqual(['main'])
    const copyDir = new MemoryDirectory()
    await db.copy({ dir: copyDir, name: NAME })
    await db.close()
    const copy = await openDetached({ dir: copyDir, name: NAME })
    await expect(copy.newEpoch()).rejects.toBeInstanceOf(LogError)
    await copy.close()
  })
})

describe('opening on an epoch', () => {
  it('follows the log to its newest epoch, whichever branch it is asked for by', async () => {
    const repo = await repoOver()
    const dir = new MemoryDirectory()
    const db = await seeded(dir, repo)
    await db.newEpoch()
    await db.newEpoch()
    await db.close()
    for (const branch of [BRANCH, NEXT, 'db/test/2']) {
      const again = await open(dir, repo, { branch })
      expect(again.branch).toBe('db/test/2')
      await again.close()
    }
  })

  it('rebuilds a file behind on an older epoch with nothing pending, and refuses one with', async () => {
    const repo = await repoOver()
    const db = await seeded(new MemoryDirectory(), repo)
    await db.flush()
    // two files on the first epoch, one of which writes on its own
    const behindDir = new MemoryDirectory()
    const behind = await open(behindDir, repo)
    await behind.close()
    const strayDir = new MemoryDirectory()
    const stray = await open(strayDir, repo, { flush: { every: 0 } })
    await stray.query("INSERT INTO t VALUES (5000, 'stray')")
    // as a process that died with it pending leaves it (a close would flush it)
    const strayImage = strayDir.image()
    await db.query("INSERT INTO t VALUES (4000, 'later')")
    await db.newEpoch()

    const again = await open(behindDir, repo)
    expect(again.recovery.snapshot).toBe(true)
    expect(await dump(again)).toEqual(await dump(db))
    await again.close()
    await expect(open(new MemoryDirectory(strayImage), repo)).rejects.toThrow(/no log has/)
    await db.close()
  })

  it('passes over an epoch that never finished, which the next one replaces', async () => {
    const repo = await repoOver()
    const dir = new MemoryDirectory()
    const db = await seeded(dir, repo)
    await db.close()
    // a snapshot's first commit, and nothing after it
    const wt = await repo.worktree(NEXT, { create: true })
    wt.set('snapshot/0', new Uint8Array([1, 2, 3]))
    await wt.commit({ info: { v: 1, snapshot: { seq: 4, schema: 1, last: false } } })

    const again = await open(dir, repo)
    expect(again.branch).toBe(BRANCH)
    expect((await again.newEpoch()).branch).toBe(NEXT)
    const fresh = await replica(repo)
    expect(await dump(fresh)).toEqual(await dump(again))
    await fresh.close()
    await again.close()
  })

  it('refuses a snapshot that was altered', async () => {
    const store = new Memory()
    const repo = await repoOver(store)
    const db = await seeded(new MemoryDirectory(), repo)
    const { commit } = await db.newEpoch()
    await db.close()
    const chunk = (await (await repo.snapshot({ commit })).get('snapshot/0')) as Uint8Array
    let altered = 0
    for await (const [key, value] of store.items()) {
      if (value.byteLength === chunk.byteLength && value.every((b, i) => b === chunk[i])) {
        const copy = value.slice()
        const at = copy.byteLength >> 1
        copy[at] = (copy[at] ?? 0) ^ 0xff
        await store.set(key, copy)
        altered++
      }
    }
    expect(altered).toBe(1)
    await expect(replica(repo)).rejects.toBeInstanceOf(CorruptSnapshotError)
  })

  it("rebuilds a logged copy taken on a later epoch from the epoch's snapshot", async () => {
    const repo = await repoOver()
    const db = await seeded(new MemoryDirectory(), repo)
    await db.newEpoch()
    await db.query("INSERT INTO t VALUES (6000, 'after')")
    await db.copy({ dir: new MemoryDirectory(), name: NAME, repo, branch: 'db/copy/0' })
    const fresh = await open(new MemoryDirectory(), repo, { branch: 'db/copy/0' })
    expect(fresh.recovery).toMatchObject({ snapshot: true, entries: 1 })
    expect(await dump(fresh)).toEqual(await dump(db))
    // its epochs are its own
    expect((await fresh.newEpoch()).branch).toBe('db/copy/1')
    expect(await repo.branches.list()).toEqual(['db/copy/1', NEXT])
    await fresh.close()
    await db.close()
  })

  it('deletes every epoch of a log', async () => {
    const repo = await repoOver()
    const db = await seeded(new MemoryDirectory(), repo)
    await db.newEpoch()
    await db.close()
    // one left by an epoch that didn't finish, too
    await repo.branches.create('db/test/7')
    await repo.branches.create('db/other/0')
    await deleteLog(repo, BRANCH)
    expect(await repo.branches.list()).toEqual(['db/other/0'])
  })
})

describe('the epoch policy', () => {
  it('starts an epoch once the log is large next to the snapshot', async () => {
    const repo = await repoOver()
    const db = await open(new MemoryDirectory(), repo, {
      flush: { every: 1 },
      epochs: { minBytes: 3000 },
    })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v TEXT)')
    for (let i = 0; db.branch === BRANCH && i < 100; i++) {
      await db.query('INSERT INTO t VALUES (?, ?)', [i, `${i}`.repeat(50)])
      await vi.waitFor(() => expect(db.pendingCount).toBe(0))
    }
    await vi.waitFor(() => expect(db.branch).toBe(NEXT))
    const fresh = await replica(repo)
    expect(await dump(fresh)).toEqual(await dump(db))
    await fresh.close()
    await db.close()
  })

  it('takes a transaction large next to the snapshot into a new epoch, not the log', async () => {
    const repo = await repoOver()
    const db = await open(new MemoryDirectory(), repo, { epochs: { minBytes: 4096 } })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v BLOB)')
    await db.query('INSERT INTO t VALUES (1, randomblob(10000))')
    await vi.waitFor(() => expect(db.branch).toBe(NEXT))
    // no entry after the snapshot: the import is in it
    expect(await repo.branches.get(NEXT)).toBe(db.base)
    expect(db.pendingCount).toBe(0)
    const fresh = await replica(repo)
    expect(await dump(fresh)).toEqual(await dump(db))
    await fresh.close()
    await db.close()
  })

  it('starts none with the policy off', async () => {
    const repo = await repoOver()
    const db = await open(new MemoryDirectory(), repo, { epochs: false })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v BLOB)')
    await db.query('INSERT INTO t VALUES (1, randomblob(?))', [9 << 20])
    await db.flush()
    expect(db.branch).toBe(BRANCH)
    await db.close()
  })

  it('records the size of the epoch’s log, so a reopened database keeps count', async () => {
    const repo = await repoOver()
    const dir = new MemoryDirectory()
    const db = await open(dir, repo, { epochs: { minBytes: 4000 } })
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v TEXT)')
    await db.query("INSERT INTO t VALUES (1, printf('%02500d', 1))")
    await db.close()
    // the same again, after a reopen, reaches the size
    const again = await open(dir, repo, { epochs: { minBytes: 4000 } })
    await again.query("INSERT INTO t VALUES (2, printf('%02500d', 2))")
    await again.flush()
    await vi.waitFor(() => expect(again.branch).toBe(NEXT))
    await again.close()
  })
})

describe('crashes while moving to a new epoch', () => {
  quietSqliteWarnings()

  /**
   * After a crash, the database reopens on one epoch or the other with
   * every transaction, takes a write, and starts another epoch; a fresh
   * copy built from the log matches it.
   */
  async function survives(
    store: KVStore,
    image: Map<string, Uint8Array> | ReadonlyMap<string, Uint8Array>,
    expected: unknown,
  ) {
    const repo = await repoOver(await copyStore(store))
    const again = await open(new MemoryDirectory(image), repo)
    expect([BRANCH, NEXT]).toContain(again.branch)
    expect(await integrity(again)).toBe('ok')
    expect(await dump(again)).toEqual(expected)
    await again.query("INSERT INTO t VALUES (9000, 'after')")
    await again.flush()
    await again.newEpoch()
    expect((await repo.branches.list()).length).toBe(1)
    const fresh = await replica(repo)
    expect(await dump(fresh)).toEqual(await dump(again))
    await fresh.close()
    await again.close()
  }

  it('at every store write', async () => {
    // a run without a crash, to count the writes
    const counting = new CrashingStore(new Memory())
    const db = await seeded(new MemoryDirectory(), await repoOver(counting))
    const expected = await dump(db)
    const start = counting.writes
    await db.newEpoch()
    const writes = counting.writes - start
    await db.close()
    expect(writes).toBeGreaterThan(3)

    for (let n = 1; n <= writes; n++) {
      const inner = new Memory()
      const crashing = new CrashingStore(inner)
      const dir = new MemoryDirectory()
      const victim = await seeded(dir, await repoOver(crashing))
      crashing.crashAtWrite(n)
      await victim.newEpoch().catch(() => {})
      expect(crashing.crashed, `write ${n}`).toBe(true)
      await survives(inner, dir.image(), expected)
    }
  })

  it('at every file write and sync', async () => {
    const counting = new CrashingDirectory(new MemoryDirectory())
    const db = await seeded(counting, await repoOver())
    const expected = await dump(db)
    const before = { ...counting.ops }
    await db.newEpoch()
    const ops = Object.fromEntries(
      (['write', 'sync', 'truncate'] as CrashOp[]).map((op) => [op, counting.ops[op] - before[op]]),
    ) as Record<CrashOp, number>
    await db.close()
    expect(ops.write).toBeGreaterThan(3)

    for (const op of ['write', 'sync', 'truncate'] as CrashOp[]) {
      for (let n = 1; n <= ops[op]; n++) {
        const store = new Memory()
        const inner = new MemoryDirectory()
        const dir = new CrashingDirectory(inner)
        const victim: LoggedDatabase = await seeded(dir, await repoOver(store))
        dir.crashAt({ op, n, ...(op === 'write' && { torn: 100 }) })
        await victim.newEpoch().catch(() => {})
        expect(dir.crashed, `${op} ${n}`).not.toBeNull()
        await survives(store, inner.image(), expected)
      }
    }
  })
})

describe('the snapshot record', () => {
  it('is in the epoch’s tree from its snapshot on', async () => {
    const repo = await repoOver()
    const db = await seeded(new MemoryDirectory(), repo)
    const { commit } = await db.newEpoch()
    await db.query("INSERT INTO t VALUES (7000, 'x')")
    await db.flush()
    const at = (c: string) => repo.snapshot({ commit: c }).then((s) => s.get(EPOCH_KEY))
    expect(await at(commit)).toEqual(await at(db.base))
    expect(db.base).not.toBe(commit)
    await db.close()
  })
})
