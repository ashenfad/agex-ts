/**
 * Checkpoints and restore: taking, listing and deleting checkpoints;
 * the database's own before each schema change; restoring by undoing
 * the changes since, and by a new epoch (across a schema change, or to
 * an earlier epoch); and crashes at every write of a restore.
 */

import type { KVStore } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { describe, expect, it } from 'vitest'
import {
  type CrashOp,
  CrashingDirectory,
  type Directory,
  LogError,
  MemoryDirectory,
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

type Repo = Awaited<ReturnType<typeof repoOver>>

/** A database of notes, with some flushed and the last pending. */
async function notes(dir: Directory, repo: Repo, options: Parameters<typeof open>[2] = {}) {
  const db = await open(dir, repo, { flush: { every: 0 }, ...options })
  await db.query('CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)')
  await db.query("INSERT INTO notes (id, body) VALUES (1, 'one'), (2, 'two'), (3, 'three')")
  await db.flush()
  await db.query("UPDATE notes SET body = 'TWO' WHERE id = 2")
  return db
}

/** Changes after a checkpoint: an insert, an update, a delete, some pending. */
async function scribble(db: Awaited<ReturnType<typeof open>>) {
  await db.query("INSERT INTO notes (id, body) VALUES (4, 'four')")
  await db.query("UPDATE notes SET body = 'uno' WHERE id = 1")
  await db.flush()
  await db.query('DELETE FROM notes WHERE id = 3')
}

describe('checkpoints', () => {
  it('are taken, listed oldest first, and deleted', async () => {
    const repo = await repoOver()
    const empty = await open(new MemoryDirectory(), repo, { branch: 'db/empty/0' })
    await expect(empty.checkpoint()).rejects.toThrow(/no transactions yet/)
    await empty.close()

    const db = await notes(new MemoryDirectory(), repo)
    const a = await db.checkpoint('before import')
    expect(a).toMatchObject({ label: 'before import', auto: false, seq: 3, schema: 1 })
    expect(a.id).toMatch(/^kvsql\/checkpoint\/db\/test\/3-[0-9a-z]+$/)
    // it flushed first, and names that commit
    expect(db.pendingCount).toBe(0)
    expect(a.commit).toBe(db.base)
    await scribble(db)
    const b = await db.checkpoint()
    expect((await db.checkpoints()).map((c) => c.id)).toEqual([a.id, b.id])
    expect(await repo.tags.list()).toEqual([a.id, b.id].sort())

    await db.deleteCheckpoint(a.id)
    await db.deleteCheckpoint(a.id)
    expect((await db.checkpoints()).map((c) => c.id)).toEqual([b.id])
    await expect(db.deleteCheckpoint('kvsql/checkpoint/db/other/1-x')).rejects.toThrow(
      /isn't a checkpoint of this database/,
    )
    await expect(db.restore(a.id)).rejects.toThrow(/no checkpoint/)
    await db.close()
  })

  it('are taken by the database before each schema change, keeping the last few', async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo, { autoCheckpoints: 2 })
    const mine = await db.checkpoint('mine')
    for (const column of ['a', 'b', 'c']) {
      await db.query(`ALTER TABLE notes ADD COLUMN ${column} TEXT`)
      await db.query(`UPDATE notes SET ${column} = 'x'`)
    }
    const all = await db.checkpoints()
    expect(all.map((c) => [c.auto, c.label])).toEqual([
      [false, 'mine'],
      [true, 'before ALTER TABLE notes ADD COLUMN b TEXT'],
      [true, 'before ALTER TABLE notes ADD COLUMN c TEXT'],
    ])
    expect(all[0]?.id).toBe(mine.id)
    // the state before the last change, its update included
    expect(all[2]).toMatchObject({ seq: 7, schema: 3 })
    await db.close()

    const none = await notes(new MemoryDirectory(), repo, {
      branch: 'db/none/0',
      autoCheckpoints: 0,
    })
    await none.query('ALTER TABLE notes ADD COLUMN a TEXT')
    expect(await none.checkpoints()).toEqual([])
    await none.close()
  })

  it('outlive the epoch they were taken on, keeping its data from being collected', async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo)
    const before = await dump(db)
    const cp = await db.checkpoint()
    await scribble(db)
    await db.newEpoch()
    await db.newEpoch()
    expect(await repo.branches.list()).toEqual(['db/test/2'])
    await repo.gc({ minAge: 0, deep: true })
    expect((await db.checkpoints()).map((c) => c.id)).toEqual([cp.id])
    const result = await db.restore(cp.id)
    expect(result).toMatchObject({ how: 'epoch', branch: 'db/test/3' })
    expect(await dump(db)).toEqual(before)
    await db.close()
  })

  it('go with the database: deleting its log deletes them', async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo)
    await db.checkpoint()
    const other = await notes(new MemoryDirectory(), repo, { branch: 'db/test2/0' })
    const kept = await other.checkpoint()
    await db.close()
    await other.close()
    await deleteLog(repo, BRANCH)
    expect(await repo.tags.list()).toEqual([kept.id])
  })

  it("can't be taken of a detached copy", async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo)
    const dir = new MemoryDirectory()
    await db.copy({ dir, name: NAME })
    await db.close()
    const copy = await openDetached({ dir, name: NAME })
    await expect(copy.checkpoint()).rejects.toBeInstanceOf(LogError)
    await copy.close()
  })
})

describe('restoring', () => {
  it('undoes the changes since, in one logged transaction, when no schema change came after', async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo)
    const before = await dump(db)
    const cp = await db.checkpoint()
    await scribble(db)
    const after = await dump(db)
    const later = await db.checkpoint('later')
    const seq = db.seq

    const result = await db.restore(cp.id)
    expect(result).toMatchObject({ how: 'undo', undone: 3, seq: seq + 1, branch: BRANCH })
    expect(await dump(db)).toEqual(before)
    // logged as a transaction: a fresh copy follows
    expect(db.pendingCount).toBe(0)
    const copy = await replica(repo)
    expect(await dump(copy)).toEqual(before)
    await copy.close()

    // and undone in turn: back to the later checkpoint
    expect(await db.restore(later.id)).toMatchObject({ how: 'undo', undone: 1 })
    expect(await dump(db)).toEqual(after)
    // a checkpoint of the database as it stands needs nothing done
    const now = await db.checkpoint()
    expect(await db.restore(now.id)).toMatchObject({ how: 'none', undone: 0 })
    expect(await integrity(db)).toBe('ok')
    await db.close()
  })

  it('starts a new epoch from the database rebuilt at the checkpoint, across a schema change', async () => {
    const repo = await repoOver()
    const dir = new MemoryDirectory()
    const db = await notes(dir, repo)
    const before = await dump(db)
    const cp = await db.checkpoint()
    await db.query('ALTER TABLE notes ADD COLUMN done INTEGER')
    await scribble(db)
    const schema = db.schemaVersion
    const seq = db.seq

    const result = await db.restore(cp.id)
    expect(result).toMatchObject({
      how: 'epoch',
      undone: seq - cp.seq,
      seq: seq + 1,
      branch: 'db/test/1',
    })
    expect(await dump(db)).toEqual(before)
    // a restore across a schema change is one
    expect(db.schemaVersion).toBe(schema + 1)
    expect(await repo.branches.list()).toEqual(['db/test/1'])
    expect(dir.names()).toEqual([NAME, `${NAME}-journal`])

    // it goes on from there
    await db.query("INSERT INTO notes (id, body) VALUES (9, 'nine')")
    await db.flush()
    const copy = await replica(repo)
    expect(copy.recovery.snapshot).toBe(true)
    expect(await dump(copy)).toEqual(await dump(db))
    await copy.close()
    // the checkpoint the database took before the change is there too
    const auto = (await db.checkpoints()).find((c) => c.auto)
    // before the ALTER, at the checkpoint's own position
    expect(auto?.seq).toBe(3)
    expect(await db.restore(auto?.id as string)).toMatchObject({
      how: 'epoch',
      branch: 'db/test/2',
    })
    expect(await integrity(db)).toBe('ok')
    await db.close()
  })

  it('reaches a checkpoint on an earlier epoch through a new one', async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo)
    const before = await dump(db)
    const cp = await db.checkpoint()
    await scribble(db)
    await db.newEpoch()
    await db.query("INSERT INTO notes (id, body) VALUES (5, 'five')")
    expect(await db.restore(cp.id)).toMatchObject({ how: 'epoch', branch: 'db/test/2' })
    expect(await dump(db)).toEqual(before)
    await db.close()
  })

  it('is refused across a schema change on a branch not named for epochs', async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo, { branch: 'main' })
    const cp = await db.checkpoint()
    await db.query('ALTER TABLE notes ADD COLUMN done INTEGER')
    await expect(db.restore(cp.id)).rejects.toThrow(/isn't named for epochs/)
    await db.close()
  })

  it('holds calls made meanwhile until it is done', async () => {
    const repo = await repoOver()
    const db = await notes(new MemoryDirectory(), repo)
    const cp = await db.checkpoint()
    await db.query('ALTER TABLE notes ADD COLUMN done INTEGER')
    const restoring = db.restore(cp.id)
    const written = db.query("INSERT INTO notes (id, body) VALUES (7, 'seven')")
    await restoring
    await written
    expect((await db.query('SELECT id FROM notes ORDER BY id')).rows).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 7 },
    ])
    await db.close()
  })
})

describe('crashes while restoring', () => {
  quietSqliteWarnings()

  /** A database with a checkpoint, then a schema change and more rows. */
  async function staged(dir: Directory, repo: Repo, schemaChange: boolean) {
    const db = await notes(dir, repo)
    const before = await dump(db)
    const cp = await db.checkpoint()
    if (schemaChange) await db.query('ALTER TABLE notes ADD COLUMN done INTEGER')
    await scribble(db)
    await db.flush()
    return { db, cp, before, after: await dump(db) }
  }

  /**
   * After a crash the database reopens either as it was or restored,
   * with `integrity_check` ok, takes a write, and matches a fresh copy.
   */
  async function survives(
    store: KVStore,
    image: ReadonlyMap<string, Uint8Array>,
    states: unknown[],
    where: string,
  ) {
    const repo = await repoOver(await copyStore(store))
    const again = await open(new MemoryDirectory(image), repo)
    expect(await integrity(again), where).toBe('ok')
    expect(states, where).toContainEqual(await dump(again))
    await again.query("INSERT INTO notes (id, body) VALUES (100, 'after')")
    await again.flush()
    const copy = await replica(repo)
    expect(await dump(copy), where).toEqual(await dump(again))
    await copy.close()
    await again.close()
  }

  for (const schemaChange of [false, true]) {
    const path = schemaChange ? 'a new epoch' : 'an undo'

    it(`by ${path}, at every store write`, async () => {
      const counting = new CrashingStore(new Memory())
      const { db, cp, before, after } = await staged(
        new MemoryDirectory(),
        await repoOver(counting),
        schemaChange,
      )
      const start = counting.writes
      await db.restore(cp.id)
      const writes = counting.writes - start
      await db.close()
      expect(writes).toBeGreaterThan(1)

      for (let n = 1; n <= writes; n++) {
        const inner = new Memory()
        const crashing = new CrashingStore(inner)
        const dir = new MemoryDirectory()
        const victim = await staged(dir, await repoOver(crashing), schemaChange)
        crashing.crashAtWrite(n)
        await victim.db.restore(victim.cp.id).catch(() => {})
        expect(crashing.crashed, `write ${n}`).toBe(true)
        await survives(inner, dir.image(), [before, after], `${path}, store write ${n}`)
      }
    })

    it(`by ${path}, at every file write and sync`, async () => {
      const counting = new CrashingDirectory(new MemoryDirectory())
      const { db, cp, before, after } = await staged(counting, await repoOver(), schemaChange)
      const from = { ...counting.ops }
      await db.restore(cp.id)
      const ops = Object.fromEntries(
        (['write', 'sync', 'truncate'] as CrashOp[]).map((op) => [op, counting.ops[op] - from[op]]),
      ) as Record<CrashOp, number>
      await db.close()
      expect(ops.write).toBeGreaterThan(1)

      for (const op of ['write', 'sync', 'truncate'] as CrashOp[]) {
        for (let n = 1; n <= ops[op]; n++) {
          const store = new Memory()
          const inner = new MemoryDirectory()
          const dir = new CrashingDirectory(inner)
          const victim = await staged(dir, await repoOver(store), schemaChange)
          dir.crashAt({ op, n, ...(op === 'write' && { torn: 100 }) })
          await victim.db.restore(victim.cp.id).catch(() => {})
          expect(dir.crashed, `${op} ${n}`).not.toBeNull()
          await survives(store, inner.image(), [before, after], `${path}, ${op} ${n}`)
        }
      }
    }, 120_000)
  }
})
