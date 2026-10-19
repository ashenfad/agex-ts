/**
 * Rebase: two devices that both wrote to one database since they last
 * synced, through kvgit's MemoryRemote. The device that syncs second
 * rebases its own changes onto the other's, renumbered after them, or
 * meets a conflict and keeps one side, the other a checkpoint; and a
 * rebase cut short by a crash finishes or leaves things as they were.
 */

import {
  type KVStore,
  MemoryRemote,
  type Repo,
  publishHead,
  pullBranch,
  pushBranch,
} from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeEntry } from '../src/entry'
import {
  type CrashOp,
  CrashingDirectory,
  type Directory,
  ENTRY_KEY,
  LogError,
  type LoggedDatabase,
  MemoryDirectory,
  RebaseRequiredError,
  type Statement,
} from '../src/index'
import {
  BRANCH,
  CrashingStore,
  dump,
  integrity,
  open,
  quietSqliteWarnings,
  replica,
  repoOver,
} from './log-helpers'

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

interface Device {
  store: KVStore
  repo: Repo<Uint8Array>
  dir: Directory
  db: LoggedDatabase
}

/** A device with its own store, its database synced from `remote` (or new). */
async function device(
  remote: MemoryRemote,
  store: KVStore = new Memory(),
  dir: Directory = new MemoryDirectory(),
): Promise<Device> {
  await pullBranch(store, remote, BRANCH)
  const repo = await repoOver(store)
  const db = await track(open(dir, repo, { flush: { every: 0 } }))
  return { store, repo, dir, db }
}

/** Flush, then push; true if the push landed. */
async function push(d: Device, remote: MemoryRemote): Promise<boolean> {
  await d.db.flush()
  const pushed = await pushBranch(d.store, remote, BRANCH)
  return pushed.status === 'pushed' || pushed.status === 'created'
}

/** Pull what the remote has; its head, which the device may not have taken. */
async function fetchHead(d: Device, remote: MemoryRemote): Promise<string> {
  const pulled = await pullBranch(d.store, remote, BRANCH)
  return pulled.remoteHead as string
}

async function run(db: LoggedDatabase, ...statements: Statement[]): Promise<void> {
  for (const statement of statements) await db.transaction([statement])
}

/** Two devices on one database, a table `t` of three rows, synced. */
async function pair(): Promise<{ remote: MemoryRemote; a: Device; b: Device }> {
  const remote = new MemoryRemote(new Memory())
  const a = await device(remote)
  await run(
    a.db,
    ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'],
    ["INSERT INTO t VALUES (1, 'x1', 'y1'), (2, 'x2', 'y2'), (3, 'x3', 'y3')"],
  )
  expect(await push(a, remote)).toBe(true)
  const b = await device(remote)
  return { remote, a, b }
}

/** The log's entries on `branch`, newest last: each one's range. */
async function ranges(repo: Repo<Uint8Array>): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = []
  let at = await repo.branches.get(BRANCH)
  for (;;) {
    const commit = await repo.getCommit(at)
    const info = commit.info as { from?: number; to?: number } | null
    if (typeof info?.from !== 'number' || typeof info.to !== 'number') break
    out.unshift([info.from, info.to])
    const parent = commit.parents[0]
    if (parent === undefined) break
    at = parent
  }
  return out
}

describe('a rebase onto another device’s entries', () => {
  it('follows changes to other rows and other columns, numbered after them', async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ["INSERT INTO t VALUES (4, 'a', 'a')"], ["UPDATE t SET x = 'ax' WHERE id = 1"])
    expect(await push(a, remote)).toBe(true)
    await run(b.db, ["INSERT INTO t VALUES (5, 'b', 'b')"], ["UPDATE t SET y = 'by' WHERE id = 1"])
    await b.db.flush()
    // and one still pending
    await run(b.db, ['DELETE FROM t WHERE id = 3'])
    expect(b.db.pendingCount).toBe(1)

    const head = await fetchHead(b, remote)
    expect(await push(b, remote)).toBe(false) // diverged
    const result = await b.db.rebase(head)
    expect(result).toMatchObject({ status: 'rebased', mine: 3, theirs: 2, conflicts: [] })
    expect(b.db.pendingCount).toBe(0)
    expect(b.db.seq).toBe(7)
    // a's schema change, its rows, a's two; then b's, renumbered
    expect(await ranges(b.repo)).toEqual([
      [1, 1],
      [2, 2],
      [3, 4],
      [5, 6],
      [7, 7],
    ])
    expect((await pushBranch(b.store, remote, BRANCH)).status).toBe('pushed')

    expect((await pullBranch(a.store, remote, BRANCH)).status).toBe('fast-forwarded')
    expect((await a.db.rebase()).status).toBe('fast-forwarded')
    const want = {
      t: [
        { id: 1, x: 'ax', y: 'by' },
        { id: 2, x: 'x2', y: 'y2' },
        { id: 4, x: 'a', y: 'a' },
        { id: 5, x: 'b', y: 'b' },
      ],
    }
    expect(await dump(a.db)).toMatchObject(want)
    expect(await dump(b.db)).toEqual(await dump(a.db))
    expect(await integrity(b.db)).toBe('ok')
    const fresh = await track(replica(b.repo))
    expect(await dump(fresh)).toEqual(await dump(b.db))
    // nothing left behind
    expect(await b.repo.branches.list()).toEqual([BRANCH])
  })

  it('is up to date with a commit its log holds, and fast-forwards with nothing of its own', async () => {
    const { remote, a, b } = await pair()
    const old = await b.repo.branches.get(BRANCH)
    expect((await b.db.rebase(old)).status).toBe('up-to-date')
    await run(a.db, ["INSERT INTO t VALUES (4, 'a', 'a')"])
    await push(a, remote)
    const head = await fetchHead(b, remote)
    const result = await b.db.rebase(head)
    expect(result).toMatchObject({ status: 'fast-forwarded', mine: 0, theirs: 1, seq: 3 })
    expect(await b.repo.branches.get(BRANCH)).toBe(head)
    expect(await dump(b.db)).toEqual(await dump(a.db))
  })

  it('keeps a merged run of changesets as it was, renumbered', async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ["INSERT INTO t VALUES (4, 'a', 'a')"])
    await push(a, remote)
    // a counter rewritten again and again merges into one piece
    for (let i = 0; i < 10; i++) await run(b.db, [`UPDATE t SET y = 'n${i}' WHERE id = 2`])
    await b.db.flush()
    expect((await ranges(b.repo)).at(-1)).toEqual([3, 12])
    const result = await b.db.rebase(await fetchHead(b, remote))
    expect(result.status).toBe('rebased')
    const tip = await b.repo.branches.get(BRANCH)
    const pieces = decodeEntry(
      (await (await b.repo.snapshot({ commit: tip })).get(ENTRY_KEY)) as Uint8Array,
    )
    expect(pieces.map((p) => [p.from, p.to])).toEqual([[4, 13]])
    const fresh = await track(replica(b.repo))
    expect(await dump(fresh)).toEqual(await dump(b.db))
  })

  it('rebases at open a file whose pending transactions the log has moved past', async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ["INSERT INTO t VALUES (4, 'a', 'a')"])
    await push(a, remote)
    await run(b.db, ["INSERT INTO t VALUES (5, 'b', 'b')"])
    // the tab dies with it pending (closing would flush it)
    const image = new MemoryDirectory((b.dir as MemoryDirectory).image())
    // with only pending transactions, the pull fast-forwards the branch
    expect((await pullBranch(b.store, remote, BRANCH)).status).toBe('fast-forwarded')
    const again = await track(open(image, await repoOver(b.store)))
    expect(again.recovery).toMatchObject({ entries: 1, transactions: 1, rebased: 1 })
    expect(again.pendingCount).toBe(0)
    expect((await again.query('SELECT id FROM t ORDER BY id')).rows).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5 },
    ])
  })

  it('refuses a commit it doesn’t have', async () => {
    const { b } = await pair()
    await expect(b.db.rebase('f'.repeat(40))).rejects.toThrow(/isn't in the repository/)
  })

  it('rebases one device’s start of a database onto another’s, which share only the root', async () => {
    // two devices first used the database apart: both made its table
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    const b = await device(remote)
    for (const d of [a, b]) {
      await run(d.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'])
    }
    await run(a.db, ["INSERT INTO t VALUES (1, 'a', 'a')"])
    expect(await push(a, remote)).toBe(true)
    await run(b.db, ["INSERT INTO t VALUES (2, 'b', 'b')"])
    const head = await fetchHead(b, remote)
    expect(await b.db.rebase(head)).toMatchObject({ status: 'conflict', schemaChange: 'mine' })
    const kept = await b.db.rebase(head, { keep: 'theirs' })
    expect(kept).toMatchObject({ status: 'kept', kept: 'theirs' })
    expect(await dump(b.db)).toEqual(await dump(a.db))
  })
})

describe('a rebase that conflicts', () => {
  const cases: Array<[string, Statement, Statement, string]> = [
    [
      'one column changed both ways',
      ["UPDATE t SET x = 'a' WHERE id = 1"],
      ["UPDATE t SET x = 'b' WHERE id = 1"],
      'DATA',
    ],
    [
      'a row deleted against a change',
      ['DELETE FROM t WHERE id = 1'],
      ["UPDATE t SET x = 'b' WHERE id = 1"],
      'NOTFOUND',
    ],
    [
      'one key inserted on both',
      ["INSERT INTO t VALUES (9, 'a', 'a')"],
      ["INSERT INTO t VALUES (9, 'b', 'b')"],
      'CONFLICT',
    ],
  ]
  for (const [what, theirs, mine, kind] of cases) {
    it(`stops, changing nothing, at ${what}`, async () => {
      const { remote, a, b } = await pair()
      await run(a.db, theirs)
      await push(a, remote)
      await run(b.db, ["INSERT INTO t VALUES (7, 'b', 'b')"], mine)
      await b.db.flush()
      await run(b.db, ["INSERT INTO t VALUES (8, 'b', 'b')"])
      const before = await dump(b.db)
      const branch = await b.repo.branches.get(BRANCH)
      const result = await b.db.rebase(await fetchHead(b, remote))
      expect(result).toMatchObject({ status: 'conflict', schemaChange: null, mine: 3, theirs: 1 })
      expect(result.conflicts.map((c) => c.kind)).toContain(kind)
      expect(await dump(b.db)).toEqual(before)
      expect(b.db.pendingCount).toBe(1)
      expect(b.db.seq).toBe(5)
      expect(await b.repo.branches.get(BRANCH)).toBe(branch)
      expect(await b.repo.branches.list()).toEqual([BRANCH])
    })
  }

  it("keeps the log's side, this device's a checkpoint to restore", async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"])
    await push(a, remote)
    await run(b.db, ["UPDATE t SET x = 'b' WHERE id = 1"], ["INSERT INTO t VALUES (7, 'b', 'b')"])
    await b.db.flush()
    await run(b.db, ["INSERT INTO t VALUES (8, 'b', 'b')"])
    const mine = await dump(b.db)
    const head = await fetchHead(b, remote)
    expect((await b.db.rebase(head)).status).toBe('conflict')

    const result = await b.db.rebase(head, { keep: 'theirs' })
    expect(result).toMatchObject({ status: 'kept', kept: 'theirs', mine: 3, theirs: 1, seq: 3 })
    expect(result.checkpoint).toMatchObject({
      seq: 5,
      label: "this copy's changes, replaced by sync",
    })
    expect(await dump(b.db)).toEqual(await dump(a.db))
    expect(await b.repo.branches.get(BRANCH)).toBe(head)
    expect(b.db.pendingCount).toBe(0)
    // the push has nothing to send
    expect((await pushBranch(b.store, remote, BRANCH)).status).toBe('up-to-date')

    const restored = await b.db.restore(result.checkpoint?.id as string)
    expect(restored.how).toBe('epoch')
    expect(await dump(b.db)).toEqual(mine)
  })

  it("keeps this device's side, the log's a checkpoint, and the other device follows", async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"], ["INSERT INTO t VALUES (6, 'a', 'a')"])
    await push(a, remote)
    const theirs = await dump(a.db)
    await run(b.db, ["UPDATE t SET x = 'b' WHERE id = 1"])
    await b.db.flush()
    await run(b.db, ["INSERT INTO t VALUES (8, 'b', 'b')"])
    const mine = await dump(b.db)

    const result = await b.db.rebase(await fetchHead(b, remote), { keep: 'mine' })
    expect(result).toMatchObject({ status: 'kept', kept: 'mine', mine: 2, theirs: 2 })
    // the log's two, an entry undoing them, then b's two
    expect(result.seq).toBe(7)
    expect(result.checkpoint).toMatchObject({
      seq: 4,
      label: "the synced changes, replaced by this copy's",
    })
    expect(await dump(b.db)).toEqual(mine)
    expect((await pushBranch(b.store, remote, BRANCH)).status).toBe('pushed')

    expect((await pullBranch(a.store, remote, BRANCH)).status).toBe('fast-forwarded')
    expect((await a.db.rebase()).status).toBe('fast-forwarded')
    expect(await dump(a.db)).toEqual(mine)
    // the checkpoint, b's own, is on the line: undone by a transaction
    const restored = await b.db.restore(result.checkpoint?.id as string)
    expect(restored.how).toBe('undo')
    expect(await dump(b.db)).toEqual(theirs)
  })
})

describe('a rebase across a schema change', () => {
  it("stops at this device's own, and keeping the log's rebuilds the file", async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"])
    await push(a, remote)
    await run(b.db, ['ALTER TABLE t ADD COLUMN z TEXT'], ["UPDATE t SET z = 'z' WHERE id = 2"])
    const mine = await dump(b.db)
    const head = await fetchHead(b, remote)
    const result = await b.db.rebase(head)
    expect(result).toMatchObject({ status: 'conflict', schemaChange: 'mine', conflicts: [] })
    expect(await dump(b.db)).toEqual(mine)

    const kept = await b.db.rebase(head, { keep: 'theirs' })
    expect(kept).toMatchObject({ status: 'kept', kept: 'theirs', seq: 3 })
    expect(await dump(b.db)).toEqual(await dump(a.db))
    expect(await integrity(b.db)).toBe('ok')
    await b.db.restore(kept.checkpoint?.id as string)
    expect(await dump(b.db)).toEqual(mine)
  })

  it("stops at the log's, and keeping this device's side starts a new epoch", async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ['ALTER TABLE t ADD COLUMN z TEXT'])
    await push(a, remote)
    await run(b.db, ["UPDATE t SET x = 'b' WHERE id = 1"])
    const mine = await dump(b.db)
    const head = await fetchHead(b, remote)
    expect(await b.db.rebase(head)).toMatchObject({ status: 'conflict', schemaChange: 'theirs' })

    const kept = await b.db.rebase(head, { keep: 'mine' })
    expect(kept).toMatchObject({ status: 'kept', kept: 'mine' })
    expect(b.db.branch).toBe('db/test/1')
    expect(await dump(b.db)).toEqual(mine)
    // after every transaction of both sides, and a schema change
    expect(b.db.seq).toBe(4)
    expect(b.db.schemaVersion).toBe(3)
    // its old epoch synced, so it stays until the sync deletes it
    expect(await b.repo.branches.list()).toEqual([BRANCH, 'db/test/1'])
    expect((await pushBranch(b.store, remote, 'db/test/1')).status).toBe('created')

    // the other device, with nothing of its own, follows to the new epoch
    const synced = await a.repo.branches.get(BRANCH)
    expect((await pullBranch(a.store, remote, 'db/test/1')).status).toBe('created')
    expect(await a.db.rebase(undefined, { synced })).toMatchObject({ status: 'fast-forwarded' })
    expect(a.db.branch).toBe('db/test/1')
    expect(await dump(a.db)).toEqual(mine)
  })

  it("refuses at open a pending change the log's schema change stops", async () => {
    const { remote, a, b } = await pair()
    await run(a.db, ['ALTER TABLE t ADD COLUMN z TEXT'])
    await push(a, remote)
    await run(b.db, ["UPDATE t SET x = 'b' WHERE id = 1"])
    const image = new MemoryDirectory((b.dir as MemoryDirectory).image())
    expect((await pullBranch(b.store, remote, BRANCH)).status).toBe('fast-forwarded')
    const err = await open(image, await repoOver(b.store)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RebaseRequiredError)
    expect(err).toMatchObject({ schemaChange: 'theirs' })
  })
})

describe('a rebase cut short', () => {
  /** b with changes of its own, and the head of a's it rebases onto. */
  async function diverged(store: KVStore, dir: Directory) {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(
      a.db,
      ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'],
      ["INSERT INTO t VALUES (1, 'x1', 'y1'), (2, 'x2', 'y2')"],
    )
    await push(a, remote)
    const b = await device(remote, store, dir)
    await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"])
    await push(a, remote)
    await run(b.db, ["UPDATE t SET y = 'b' WHERE id = 1"])
    await b.db.flush()
    await run(b.db, ["INSERT INTO t VALUES (3, 'b', 'b')"])
    const head = await fetchHead(b, remote)
    return { b, head }
  }

  const BEFORE = [
    { id: 1, x: 'x1', y: 'b' },
    { id: 2, x: 'x2', y: 'y2' },
    { id: 3, x: 'b', y: 'b' },
  ]
  const AFTER = [{ id: 1, x: 'a', y: 'b' }, BEFORE[1], BEFORE[2]]

  /** Opened again after the crash: as before the rebase, or as after; and it can rebase. */
  async function survives(store: KVStore, dir: Directory, head: string, at: string) {
    const repo = await repoOver(store)
    const again = await track(open(dir, repo))
    expect(await integrity(again), at).toBe('ok')
    const rows = (await again.query('SELECT * FROM t ORDER BY id')).rows
    expect([BEFORE, AFTER], at).toContainEqual(rows)
    // a rebase's branch and tag are finished or dropped
    expect(await repo.branches.list(), at).toEqual([BRANCH])
    expect(await repo.tags.list(), at).toEqual([])
    const result = await again.rebase(head)
    expect(['rebased', 'up-to-date'], at).toContain(result.status)
    expect((await again.query('SELECT * FROM t ORDER BY id')).rows, at).toEqual(AFTER)
    const fresh = await track(replica(await repoOver(store)))
    expect(await dump(fresh), at).toEqual(await dump(again))
  }

  it('at every store write', async () => {
    const counting = new CrashingStore(new Memory())
    const { b, head } = await diverged(counting, new MemoryDirectory())
    const start = counting.writes
    await b.db.rebase(head)
    const writes = counting.writes - start
    expect(writes).toBeGreaterThan(3)

    for (let n = 1; n <= writes; n++) {
      const inner = new Memory()
      const crashing = new CrashingStore(inner)
      const dir = new MemoryDirectory()
      const victim = await diverged(crashing, dir)
      crashing.crashAtWrite(n)
      await victim.b.db.rebase(victim.head).catch(() => {})
      expect(crashing.crashed, `write ${n}`).toBe(true)
      await survives(inner, new MemoryDirectory(dir.image()), victim.head, `write ${n}`)
    }
  }, 120_000)

  it('after the file took it, refuses to move a branch that moved since', async () => {
    const counting = new CrashingStore(new Memory())
    const { b, head } = await diverged(counting, new MemoryDirectory())
    const start = counting.writes
    await b.db.rebase(head)
    // the last writes: the branch's move, then dropping the branch and tag
    const move = counting.writes - start - 2

    const inner = new Memory()
    const crashing = new CrashingStore(inner)
    const dir = new MemoryDirectory()
    const victim = await diverged(crashing, dir)
    const before = await (await repoOver(inner)).branches.get(BRANCH)
    crashing.crashAtWrite(move)
    await victim.b.db.rebase(victim.head).catch(() => {})
    const repo = await repoOver(inner)
    expect(await repo.branches.get(BRANCH)).toBe(before)
    expect(await repo.branches.list()).toContain('db/test/rebase')
    // the branch moves on meanwhile, to the other device's head
    expect(await publishHead(inner, BRANCH, before, victim.head)).toBe(true)
    await expect(open(new MemoryDirectory(dir.image()), repo)).rejects.toThrow(/has moved since/)
    expect(await repo.branches.get(BRANCH)).toBe(victim.head)
    expect(await repo.branches.list()).toContain('db/test/rebase')
    expect(await repo.tags.list()).toEqual(['kvsql/rebase/db/test'])
  })

  it('at every file write and sync', async () => {
    const counting = new CrashingDirectory(new MemoryDirectory())
    const { b, head } = await diverged(new Memory(), counting)
    const before = { ...counting.ops }
    await b.db.rebase(head)
    const ops = Object.fromEntries(
      (['write', 'sync', 'truncate'] as CrashOp[]).map((op) => [op, counting.ops[op] - before[op]]),
    ) as Record<CrashOp, number>
    expect(ops.write).toBeGreaterThan(1)

    for (const op of ['write', 'sync', 'truncate'] as CrashOp[]) {
      for (let n = 1; n <= ops[op]; n++) {
        const store = new Memory()
        const inner = new MemoryDirectory()
        const dir = new CrashingDirectory(inner)
        const victim = await diverged(store, dir)
        dir.crashAt({ op, n, ...(op === 'write' && { torn: 100 }) })
        await victim.b.db.rebase(victim.head).catch(() => {})
        expect(dir.crashed, `${op} ${n}`).not.toBeNull()
        await survives(store, new MemoryDirectory(inner.image()), victim.head, `${op} ${n}`)
      }
    }
  }, 120_000)
})
