import { Repo } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { expect, it } from 'vitest'
import { MemoryDirectory, openLog } from '../src/index'

it('logs, flushes and replays in a browser', async () => {
  const repo = await Repo.open(new Memory())
  const options = { name: 'app.db', repo, branch: 'db/test/0', flush: { maxAgeMs: 0 } }
  const db = await openLog({ dir: new MemoryDirectory(), ...options })
  await db.query('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v BLOB)')
  await db.transaction([
    ['INSERT INTO t VALUES (?, ?)', ['a', new Uint8Array([1, 2, 3])]],
    ['INSERT INTO t VALUES (?, ?)', ['b', null]],
  ])
  await db.close()
  const copy = await openLog({ dir: new MemoryDirectory(), ...options })
  expect(copy.recovery).toEqual({
    ownFlush: false,
    entries: 2,
    transactions: 2,
    rebased: 0,
    snapshot: false,
    stayed: null,
  })
  expect((await copy.query('SELECT id, v FROM t ORDER BY id')).rows).toEqual([
    { id: 'a', v: new Uint8Array([1, 2, 3]) },
    { id: 'b', v: null },
  ])
  await copy.close()
})

it('starts a new epoch and rebuilds from its snapshot in a browser', async () => {
  const repo = await Repo.open(new Memory())
  const options = { name: 'app.db', repo, branch: 'db/test/0', flush: { maxAgeMs: 0 } }
  const db = await openLog({ dir: new MemoryDirectory(), ...options })
  await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, v TEXT)')
  await db.query("INSERT INTO t VALUES (1, printf('%01000d', 1))")
  const result = await db.newEpoch()
  expect(result).toMatchObject({ branch: 'db/test/1', seq: 2 })
  await db.query("INSERT INTO t VALUES (2, 'two')")
  await db.close()
  const copy = await openLog({ dir: new MemoryDirectory(), ...options })
  expect(copy.branch).toBe('db/test/1')
  expect(copy.recovery).toEqual({
    ownFlush: false,
    entries: 1,
    transactions: 1,
    rebased: 0,
    snapshot: true,
    stayed: null,
  })
  expect((await copy.query('SELECT id, length(v) AS n FROM t ORDER BY id')).rows).toEqual([
    { id: 1, n: 1000 },
    { id: 2, n: 3 },
  ])
  await copy.close()
})
