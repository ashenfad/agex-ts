/**
 * Epochs across devices, through kvgit's MemoryRemote: a device with
 * changes of its own on an epoch another device replaced rebases them
 * onto the new one (or keeps a side), opening never drops them, and
 * the device that started an epoch takes in entries pushed to the old
 * one meanwhile. A rebase onto a new epoch cut short by a crash
 * finishes or leaves the database as it was.
 */

import {
  type KVStore,
  MemoryRemote,
  type Repo,
  deleteRemoteBranch,
  getSyncHead,
  pullBranch,
  pushBranch,
} from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabaseFile } from '../src/database'
import { finished } from '../src/epoch'
import {
  type CrashOp,
  CrashingDirectory,
  type Directory,
  DivergedError,
  LogError,
  type LoggedDatabase,
  MemoryDirectory,
  type Statement,
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

quietSqliteWarnings()

const NEXT = 'db/test/1'
const THIRD = 'db/test/2'

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

async function device(
  remote: MemoryRemote,
  store: KVStore = new Memory(),
  dir: Directory = new MemoryDirectory(),
): Promise<Device> {
  await pullBranch(store, remote, BRANCH)
  const repo = await repoOver(store)
  const db = await track(open(dir, repo, { flush: { every: 0 }, epochs: false }))
  return { store, repo, dir, db }
}

async function run(db: LoggedDatabase, ...statements: Statement[]): Promise<void> {
  for (const statement of statements) await db.transaction([statement])
}

/** Flush, then push the database's branch; its status. */
async function push(d: Device, remote: MemoryRemote): Promise<string> {
  await d.db.flush()
  return (await pushBranch(d.store, remote, d.db.branch)).status
}

/**
 * Two devices level on epoch 0; then b makes changes of its own (one
 * flushed, one pending) while a, with one of its own, starts epoch 1,
 * pushes it and deletes epoch 0 from the remote. `synced` is the commit
 * of epoch 0 b last synced.
 */
async function replaced(store: KVStore = new Memory(), dir: Directory = new MemoryDirectory()) {
  const remote = new MemoryRemote(new Memory())
  const a = await device(remote)
  await run(
    a.db,
    ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'],
    ["INSERT INTO t VALUES (1, 'x1', 'y1'), (2, 'x2', 'y2')"],
  )
  expect(await push(a, remote)).toBe('created')
  const b = await device(remote, store, dir)
  const synced = (await getSyncHead(b.store, BRANCH)) as string
  await run(b.db, ["UPDATE t SET y = 'b' WHERE id = 1"])
  await b.db.flush()
  await run(b.db, ["INSERT INTO t VALUES (3, 'b', 'b')"])
  // a's own change is in its log, but never synced
  await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"])
  await a.db.flush()
  await a.db.newEpoch()
  expect(a.db.branch).toBe(NEXT)
  expect(await push(a, remote)).toBe('created')
  expect((await deleteRemoteBranch(a.store, remote, BRANCH)).status).toBe('deleted')
  expect((await pullBranch(b.store, remote, NEXT)).status).toBe('created')
  return { remote, a, b, synced }
}

const MINE = [
  { id: 1, x: 'x1', y: 'b' },
  { id: 2, x: 'x2', y: 'y2' },
  { id: 3, x: 'b', y: 'b' },
]
const BOTH = [{ id: 1, x: 'a', y: 'b' }, MINE[1], MINE[2]]

async function rows(db: LoggedDatabase) {
  return (await db.query('SELECT * FROM t ORDER BY id')).rows
}

describe('a rebase onto another device’s new epoch', () => {
  it('moves the database there with its own changes, numbered after the epoch’s', async () => {
    const { remote, a, b, synced } = await replaced()
    expect(b.db.branch).toBe(BRANCH)
    const result = await b.db.rebase(undefined, { synced })
    expect(result).toMatchObject({ status: 'rebased', mine: 2, theirs: 1 })
    expect(b.db.branch).toBe(NEXT)
    expect(b.db.pendingCount).toBe(0)
    expect(b.db.seq).toBe(5)
    expect(await rows(b.db)).toEqual(BOTH)
    expect(await integrity(b.db)).toBe('ok')
    // its own epoch, the rebase's file, branch and tag all gone
    expect(await b.repo.branches.list()).toEqual([NEXT])
    expect(await b.repo.tags.list()).toEqual([])
    expect(await (b.dir as MemoryDirectory).exists(`${NAME}-rebase`)).toBe(false)

    expect(await push(b, remote)).toBe('pushed')
    expect((await pullBranch(a.store, remote, NEXT)).status).toBe('fast-forwarded')
    expect((await a.db.rebase()).status).toBe('fast-forwarded')
    expect(await dump(a.db)).toEqual(await dump(b.db))
    expect(await dump(await track(replica(b.repo, { branch: NEXT })))).toEqual(await dump(b.db))
  })

  it('stays on its own epoch at open rather than drop its changes, and rebases from there', async () => {
    const { b, synced } = await replaced()
    await b.db.close()
    const again = await track(open(b.dir, b.repo, { epochs: false }))
    expect(again.branch).toBe(BRANCH)
    expect(again.recovery.stayed).toBe(NEXT)
    expect(await rows(again)).toEqual(MINE)
    expect(await again.rebase(undefined, { synced })).toMatchObject({ status: 'rebased' })
    expect(await rows(again)).toEqual(BOTH)
  })

  it('takes where the snapshot was taken as what the new epoch holds, if it has it', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'])
    await run(a.db, ["INSERT INTO t VALUES (1, 'x1', 'y1')"])
    await push(a, remote)
    const b = await device(remote)
    await run(b.db, ["INSERT INTO t VALUES (2, 'b', 'b')"])
    await a.db.newEpoch()
    await push(a, remote)
    await pullBranch(b.store, remote, NEXT)
    expect(await b.db.rebase()).toMatchObject({ status: 'rebased', mine: 1 })
    expect((await rows(b.db)).map((r) => r.id)).toEqual([1, 2])
  })

  it('needs `synced` when it can’t tell what the new epoch holds', async () => {
    const { b } = await replaced()
    await expect(b.db.rebase()).rejects.toThrow(/rebase with `synced`/)
    expect(b.db.branch).toBe(BRANCH)
  })

  it('just moves with nothing of its own', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT)'])
    await push(a, remote)
    const b = await device(remote)
    const synced = await b.repo.branches.get(BRANCH)
    await run(a.db, ["INSERT INTO t VALUES (1, 'a')"])
    await a.db.flush()
    await a.db.newEpoch()
    await push(a, remote)
    await pullBranch(b.store, remote, NEXT)
    expect(await b.db.rebase(undefined, { synced })).toMatchObject({
      status: 'fast-forwarded',
      mine: 0,
    })
    expect(b.db.branch).toBe(NEXT)
    expect(await dump(b.db)).toEqual(await dump(a.db))
    expect(await b.repo.branches.list()).toEqual([NEXT])
  })

  it('follows the snapshots back across an epoch between', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'])
    await run(a.db, ["INSERT INTO t VALUES (1, 'x1', 'y1')"])
    await push(a, remote)
    const b = await device(remote)
    await run(b.db, ["INSERT INTO t VALUES (2, 'b', 'b')"])
    await a.db.newEpoch()
    await push(a, remote)
    await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"])
    await a.db.newEpoch()
    expect(a.db.branch).toBe(THIRD)
    await push(a, remote)
    await pullBranch(b.store, remote, NEXT)
    await pullBranch(b.store, remote, THIRD)
    expect(await b.db.rebase()).toMatchObject({ status: 'rebased', mine: 1 })
    expect(b.db.branch).toBe(THIRD)
    expect(await rows(b.db)).toEqual([
      { id: 1, x: 'a', y: 'y1' },
      { id: 2, x: 'b', y: 'b' },
    ])
  })

  it('moves a copy with nothing on its epoch, however far on, the epochs before gone', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'])
    await run(a.db, ["INSERT INTO t VALUES (1, 'x1', 'y1')"])
    await push(a, remote)
    await a.db.newEpoch()
    await a.db.newEpoch()
    await push(a, remote)
    expect((await deleteRemoteBranch(a.store, remote, BRANCH)).status).toBe('deleted')
    // a new device: its own epoch 0 is empty, and not in the remote
    const store = new Memory()
    const c = await track(open(new MemoryDirectory(), await repoOver(store), { epochs: false }))
    await pullBranch(store, remote, THIRD)
    expect(await c.rebase()).toMatchObject({ status: 'fast-forwarded', mine: 0 })
    expect(c.branch).toBe(THIRD)
    expect(await dump(c)).toEqual(await dump(a.db))
  })

  it('takes every change on its epoch as its own with `synced` null', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'])
    await a.db.newEpoch()
    await push(a, remote)
    // a new device that wrote before it ever synced
    const store = new Memory()
    const c = await track(open(new MemoryDirectory(), await repoOver(store), { epochs: false }))
    await run(c, ['CREATE TABLE u (id INTEGER PRIMARY KEY NOT NULL)'])
    await pullBranch(store, remote, NEXT)
    await expect(c.rebase()).rejects.toThrow(/rebase with `synced`/)
    expect(await c.rebase(undefined, { synced: null })).toMatchObject({
      status: 'conflict',
      mine: 1,
      schemaChange: 'mine',
    })
    expect(await c.rebase(undefined, { synced: null, keep: 'theirs' })).toMatchObject({
      status: 'kept',
      kept: 'theirs',
    })
    expect(c.branch).toBe(NEXT)
    expect(await dump(c)).toEqual(await dump(a.db))
  })

  it('stops at a conflict with nothing changed', async () => {
    const { b, synced } = await replaced()
    await run(b.db, ["UPDATE t SET x = 'mine' WHERE id = 1"])
    const before = await dump(b.db)
    const result = await b.db.rebase(undefined, { synced })
    expect(result).toMatchObject({ status: 'conflict', mine: 3, schemaChange: null })
    expect(result.conflicts.map((c) => c.kind)).toContain('DATA')
    expect(b.db.branch).toBe(BRANCH)
    expect(b.db.pendingCount).toBe(2)
    expect(await dump(b.db)).toEqual(before)
    expect((await b.repo.branches.list()).sort()).toEqual([BRANCH, NEXT])
    expect(await b.repo.tags.list()).toEqual([])
    expect(await (b.dir as MemoryDirectory).exists(`${NAME}-rebase`)).toBe(false)
  })

  it("keeps the new epoch's side, this device's a checkpoint", async () => {
    const { a, b, synced } = await replaced()
    await run(b.db, ["UPDATE t SET x = 'mine' WHERE id = 1"])
    const mine = await dump(b.db)
    const kept = await b.db.rebase(undefined, { synced, keep: 'theirs' })
    expect(kept).toMatchObject({ status: 'kept', kept: 'theirs' })
    expect(b.db.branch).toBe(NEXT)
    expect(await dump(b.db)).toEqual(await dump(a.db))
    expect(await b.repo.branches.list()).toEqual([NEXT])
    await b.db.restore(kept.checkpoint?.id as string)
    expect(await dump(b.db)).toEqual(mine)
  })

  it("keeps this device's side as a newer epoch, which the other device follows", async () => {
    const { remote, a, b, synced } = await replaced()
    await run(b.db, ["UPDATE t SET x = 'mine' WHERE id = 1"])
    const mine = await dump(b.db)
    const kept = await b.db.rebase(undefined, { synced, keep: 'mine' })
    expect(kept).toMatchObject({ status: 'kept', kept: 'mine' })
    expect(b.db.branch).toBe('db/test/2')
    expect(await dump(b.db)).toEqual(mine)
    expect(await b.repo.branches.list()).toEqual(['db/test/2'])
    expect((await pushBranch(b.store, remote, 'db/test/2')).status).toBe('created')

    const aSynced = await a.repo.branches.get(NEXT)
    await pullBranch(a.store, remote, 'db/test/2')
    expect(await a.db.rebase(undefined, { synced: aSynced })).toMatchObject({
      status: 'fast-forwarded',
    })
    expect(a.db.branch).toBe('db/test/2')
    expect(await dump(a.db)).toEqual(mine)
    // the checkpoint, b's own, holds the epoch it replaced
    expect(kept.checkpoint?.commit).toBe(aSynced)
  })

  it('stops at a schema change on either side', async () => {
    const mineChange = await replaced()
    await run(mineChange.b.db, ['ALTER TABLE t ADD COLUMN z TEXT'])
    expect(await mineChange.b.db.rebase(undefined, { synced: mineChange.synced })).toMatchObject({
      status: 'conflict',
      schemaChange: 'mine',
    })

    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT)'])
    await push(a, remote)
    const b = await device(remote)
    const synced = await b.repo.branches.get(BRANCH)
    await run(b.db, ["INSERT INTO t VALUES (1, 'b')"])
    await run(a.db, ['ALTER TABLE t ADD COLUMN z TEXT'])
    await a.db.newEpoch()
    await push(a, remote)
    await pullBranch(b.store, remote, NEXT)
    expect(await b.db.rebase(undefined, { synced })).toMatchObject({
      status: 'conflict',
      schemaChange: 'theirs',
    })
  })

  it('refuses a commit of the new epoch that isn’t its tip', async () => {
    const { b, synced } = await replaced()
    const tip = await b.repo.branches.get(NEXT)
    const parent = (await b.repo.getCommit(tip)).parents[0] as string
    await expect(b.db.rebase(parent, { synced })).rejects.toThrow(LogError)
  })
})

describe('a device at the point a snapshot was taken, with nothing of its own', () => {
  it('moves to the epoch if it holds the same, and stays otherwise', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT)'])
    await run(a.db, ["INSERT INTO t VALUES (1, 'a')"])
    await push(a, remote)
    const b = await device(remote)
    await b.db.close()
    await a.db.newEpoch()
    await push(a, remote)
    await pullBranch(b.store, remote, NEXT)

    const tampered = new MemoryDirectory((b.dir as MemoryDirectory).image())
    const file = await openDatabaseFile(tampered, NAME)
    file.db.exec("UPDATE t SET x = 'other' WHERE id = 1")
    file.close()
    await expect(open(tampered, b.repo)).rejects.toBeInstanceOf(DivergedError)

    const again = await track(open(b.dir, b.repo))
    expect(again.branch).toBe(NEXT)
    expect(await dump(again)).toEqual(await dump(a.db))
  })

  it('refuses a rebase onto the epoch if it holds something else', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT)'])
    await run(a.db, ["INSERT INTO t VALUES (1, 'a')"])
    await push(a, remote)
    const b = await device(remote)
    await b.db.close()
    // changed outside the log, and open before the epoch starts
    const file = await openDatabaseFile(b.dir, NAME)
    file.db.exec("UPDATE t SET x = 'other' WHERE id = 1")
    file.close()
    const again = await track(open(b.dir, b.repo, { epochs: false }))
    await a.db.newEpoch()
    await push(a, remote)
    await pullBranch(b.store, remote, NEXT)
    const err = await again.rebase().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DivergedError)
    expect(err).toMatchObject({ branch: BRANCH, expected: await a.db.contentHash() })
    expect(again.branch).toBe(BRANCH)
  })
})

describe('entries pushed to an epoch while another device started the next', () => {
  /** a starts epoch 1 while b pushes to epoch 0; a's delete of 0 finds it moved. */
  async function crossed() {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(
      a.db,
      ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)'],
      ["INSERT INTO t VALUES (1, 'x1', 'y1'), (2, 'x2', 'y2')"],
    )
    await push(a, remote)
    const b = await device(remote)
    await run(b.db, ["UPDATE t SET y = 'b' WHERE id = 1"])
    expect(await push(b, remote)).toBe('pushed')
    await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"])
    await a.db.newEpoch()
    expect(await push(a, remote)).toBe('created')
    expect((await deleteRemoteBranch(a.store, remote, BRANCH)).status).toBe('moved')
    const old = await pullBranch(a.store, remote, BRANCH)
    return { remote, a, b, tip: old.remoteHead as string }
  }

  it('are taken into the new epoch, after which the old one goes and the other device follows', async () => {
    const { remote, a, b, tip } = await crossed()
    const result = await a.db.adopt(tip)
    expect(result).toMatchObject({ status: 'rebased', theirs: 1 })
    expect(await rows(a.db)).toEqual([
      { id: 1, x: 'a', y: 'b' },
      { id: 2, x: 'x2', y: 'y2' },
    ])
    expect(await a.repo.branches.list()).toContain(NEXT)
    expect(await push(a, remote)).toBe('pushed')
    expect((await deleteRemoteBranch(a.store, remote, BRANCH, { expected: tip })).status).toBe(
      'deleted',
    )

    // b pushed all it had: the new epoch holds it, so b just moves
    const synced = (await getSyncHead(b.store, BRANCH)) as string
    await pullBranch(b.store, remote, NEXT)
    expect(await b.db.rebase(undefined, { synced })).toMatchObject({ status: 'fast-forwarded' })
    expect(await dump(b.db)).toEqual(await dump(a.db))
    // taken already
    expect(await a.db.adopt(tip)).toMatchObject({ status: 'up-to-date', theirs: 0 })
  })

  it('are taken from an epoch two back, and an epoch with nothing new takes nothing', async () => {
    const { remote, a, tip } = await crossed()
    const between = await a.repo.branches.get(NEXT)
    await a.db.newEpoch()
    expect(a.db.branch).toBe(THIRD)
    await push(a, remote)
    expect(await a.db.adopt(between)).toMatchObject({ status: 'up-to-date', theirs: 0 })
    expect(await a.db.adopt(tip)).toMatchObject({ status: 'rebased', theirs: 1 })
    expect(await rows(a.db)).toEqual([
      { id: 1, x: 'a', y: 'b' },
      { id: 2, x: 'x2', y: 'y2' },
    ])
  })

  it('are taken once, and later ones after them', async () => {
    const { remote, a, b, tip } = await crossed()
    await a.db.adopt(tip)
    // b pushes again to the old epoch, still there
    await run(b.db, ["INSERT INTO t VALUES (3, 'b', 'b')"])
    expect(await push(b, remote)).toBe('pushed')
    const later = (await pullBranch(a.store, remote, BRANCH)).remoteHead as string
    expect(await a.db.adopt(later)).toMatchObject({ status: 'rebased', theirs: 1 })
    expect((await rows(a.db)).map((r) => r.id)).toEqual([1, 2, 3])
    expect((await a.db.adopt(later)).status).toBe('up-to-date')
  })

  it('stop at a conflict, and can be left out, kept as a checkpoint', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(a.db, ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT)'])
    await run(a.db, ["INSERT INTO t VALUES (1, 'x1')"])
    await push(a, remote)
    const b = await device(remote)
    await run(b.db, ["UPDATE t SET x = 'b' WHERE id = 1"])
    await push(b, remote)
    await run(a.db, ["UPDATE t SET x = 'a' WHERE id = 1"])
    await a.db.newEpoch()
    await push(a, remote)
    const tip = (await pullBranch(a.store, remote, BRANCH)).remoteHead as string
    const before = await dump(a.db)
    const result = await a.db.adopt(tip)
    expect(result.status).toBe('conflict')
    expect(result.conflicts.map((c) => c.kind)).toContain('DATA')
    expect(await dump(a.db)).toEqual(before)
    const kept = await a.db.adopt(tip, { keep: 'mine' })
    expect(kept).toMatchObject({ status: 'kept', kept: 'mine' })
    expect(kept.checkpoint?.commit).toBe(tip)
    expect(await dump(a.db)).toEqual(before)
    // run again, the same checkpoint
    const again = await a.db.adopt(tip, { keep: 'mine' })
    expect(again.checkpoint?.id).toBe(kept.checkpoint?.id)
    expect((await a.db.checkpoints()).filter((c) => c.commit === tip)).toHaveLength(1)
  })
})

describe('a rebase onto a new epoch cut short', () => {
  /** Opened again after the crash: as before or after, and it can rebase from there. */
  async function survives(store: KVStore, dir: Directory, synced: string, at: string) {
    const repo = await repoOver(store)
    const again = await track(open(dir, repo, { epochs: false }))
    expect(await integrity(again), at).toBe('ok')
    const now = await rows(again)
    expect([MINE, BOTH], at).toContainEqual(now)
    expect(again.branch, at).toBe(now === MINE || again.branch === BRANCH ? BRANCH : NEXT)
    const result = await again.rebase(undefined, { synced })
    expect(['rebased', 'up-to-date'], at).toContain(result.status)
    expect(await rows(again), at).toEqual(BOTH)
    expect(again.branch, at).toBe(NEXT)
    expect(await repo.branches.list(), at).toEqual([NEXT])
    expect(await repo.tags.list(), at).toEqual([])
  }

  it('at every store write', async () => {
    const counting = new CrashingStore(new Memory())
    const { b, synced } = await replaced(counting)
    const start = counting.writes
    await b.db.rebase(undefined, { synced })
    const writes = counting.writes - start
    expect(writes).toBeGreaterThan(3)
    for (let n = 1; n <= writes; n++) {
      const inner = new Memory()
      const crashing = new CrashingStore(inner)
      const dir = new MemoryDirectory()
      const victim = await replaced(crashing, dir)
      crashing.crashAtWrite(n)
      await victim.b.db.rebase(undefined, { synced: victim.synced }).catch(() => {})
      expect(crashing.crashed, `write ${n}`).toBe(true)
      await survives(inner, new MemoryDirectory(dir.image()), victim.synced, `write ${n}`)
    }
  }, 180_000)

  it('at every file write and sync', async () => {
    const counting = new CrashingDirectory(new MemoryDirectory())
    const { b, synced } = await replaced(new Memory(), counting)
    const before = { ...counting.ops }
    await b.db.rebase(undefined, { synced })
    const ops = Object.fromEntries(
      (['write', 'sync', 'truncate'] as CrashOp[]).map((op) => [op, counting.ops[op] - before[op]]),
    ) as Record<CrashOp, number>
    expect(ops.write).toBeGreaterThan(3)
    for (const op of ['write', 'sync', 'truncate'] as CrashOp[]) {
      for (let n = 1; n <= ops[op]; n++) {
        const store = new Memory()
        const inner = new MemoryDirectory()
        const dir = new CrashingDirectory(inner)
        const victim = await replaced(store, dir)
        dir.crashAt({ op, n, ...(op === 'write' && { torn: 100 }) })
        await victim.b.db.rebase(undefined, { synced: victim.synced }).catch(() => {})
        expect(dir.crashed, `${op} ${n}`).not.toBeNull()
        await survives(store, new MemoryDirectory(inner.image()), victim.synced, `${op} ${n}`)
      }
    }
  }, 180_000)
})

describe("keeping this device's side over a synced schema change, cut short", () => {
  /** b with a pending change, its branch pulled ahead to a's schema change. */
  async function advanced(store: KVStore, dir: Directory) {
    const remote = new MemoryRemote(new Memory())
    const a = await device(remote)
    await run(
      a.db,
      ['CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT)'],
      ["INSERT INTO t VALUES (1, 'x1')"],
    )
    await push(a, remote)
    const b = await device(remote, store, dir)
    await run(a.db, ['ALTER TABLE t ADD COLUMN z TEXT'])
    await push(a, remote)
    await run(b.db, ["UPDATE t SET x = 'b' WHERE id = 1"])
    expect((await pullBranch(b.store, remote, BRANCH)).status).toBe('fast-forwarded')
    return { b, head: await b.repo.branches.get(BRANCH) }
  }

  it('leaves the branch at the synced head, or the database on the new epoch', async () => {
    const counting = new CrashingStore(new Memory())
    const { b } = await advanced(counting, new MemoryDirectory())
    const start = counting.writes
    expect(await b.db.rebase(undefined, { keep: 'mine' })).toMatchObject({ status: 'kept' })
    expect(b.db.branch).toBe(NEXT)
    expect(await rows(b.db)).toEqual([{ id: 1, x: 'b' }])
    const writes = counting.writes - start

    for (let n = 1; n <= writes; n++) {
      const inner = new Memory()
      const crashing = new CrashingStore(inner)
      const dir = new MemoryDirectory()
      const victim = await advanced(crashing, dir)
      crashing.crashAtWrite(n)
      await victim.b.db.rebase(undefined, { keep: 'mine' }).catch(() => {})
      const repo = await repoOver(inner)
      const opened = await open(new MemoryDirectory(dir.image()), repo).catch((e: unknown) => e)
      if (opened instanceof Error) {
        // as before: the pending change still can't follow the schema change
        expect(opened, `write ${n}`).toMatchObject({ name: 'RebaseRequiredError' })
        expect(await repo.branches.get(BRANCH), `write ${n}`).toBe(victim.head)
        expect(await finished(repo, NEXT), `write ${n}`).toBe(false)
      } else {
        const db = await track(Promise.resolve(opened as LoggedDatabase))
        expect(db.branch, `write ${n}`).toBe(NEXT)
        expect(await rows(db), `write ${n}`).toEqual([{ id: 1, x: 'b' }])
        expect(await integrity(db), `write ${n}`).toBe('ok')
      }
    }
  }, 120_000)

  it('at every file write and sync, finishes the move from a snapshot numbered past the file', async () => {
    const counting = new CrashingDirectory(new MemoryDirectory())
    const { b } = await advanced(new Memory(), counting)
    const before = { ...counting.ops }
    await b.db.rebase(undefined, { keep: 'mine' })
    const ops = Object.fromEntries(
      (['write', 'sync', 'truncate'] as CrashOp[]).map((op) => [op, counting.ops[op] - before[op]]),
    ) as Record<CrashOp, number>
    let moved = 0
    for (const op of ['write', 'sync', 'truncate'] as CrashOp[]) {
      for (let n = 1; n <= ops[op]; n++) {
        const store = new Memory()
        const inner = new MemoryDirectory()
        const dir = new CrashingDirectory(inner)
        const victim = await advanced(store, dir)
        dir.crashAt({ op, n, ...(op === 'write' && { torn: 100 }) })
        await victim.b.db.rebase(undefined, { keep: 'mine' }).catch(() => {})
        const repo = await repoOver(store)
        const at = `${op} ${n}`
        const opened = await open(new MemoryDirectory(inner.image()), repo).catch((e: unknown) => e)
        if (opened instanceof Error) {
          expect(opened, at).toMatchObject({ name: 'RebaseRequiredError' })
          expect(await repo.branches.get(BRANCH), at).toBe(victim.head)
          // only if the new epoch never finished
          expect(await finished(repo, NEXT), at).toBe(false)
        } else {
          const db = await track(Promise.resolve(opened as LoggedDatabase))
          expect(db.branch, at).toBe(NEXT)
          expect(await rows(db), at).toEqual([{ id: 1, x: 'b' }])
          expect(await integrity(db), at).toBe('ok')
          // numbered past both sides, and the schema change counted
          expect(db.seq, at).toBe(4)
          expect(db.schemaVersion, at).toBe(3)
          moved++
        }
      }
    }
    expect(moved).toBeGreaterThan(0)
  }, 120_000)
})
