/**
 * Replica equality: random workloads, then copies of the database built
 * from its log alone must equal it, table by table and row by row.
 */

import { cborCodec } from '@agex-ts/kvgit'
import type { BindableValue } from '@sqlite.org/sqlite-wasm'
import { describe, expect, it } from 'vitest'
import { type Piece, entryInfo, sha256Hex } from '../src/entry'
import {
  CrashingDirectory,
  type DirectoryImage,
  ENTRY_FORMAT,
  ENTRY_KEY,
  MemoryDirectory,
  type Statement,
  loadSqlite,
  openDatabase,
  startSession,
} from '../src/index'
import {
  BRANCH,
  NAME,
  dump,
  integrity,
  open,
  prng,
  quietSqliteWarnings,
  replica,
  repoOver,
} from './log-helpers'

const sqlite3 = await loadSqlite()

const SCHEMA: Statement[] = [
  ['CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT, n INTEGER, body BLOB)'],
  [
    'CREATE TABLE tags (note TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (note, tag)) WITHOUT ROWID',
  ],
  ['CREATE TABLE counters (id INTEGER PRIMARY KEY, c INTEGER NOT NULL DEFAULT 0, f REAL)'],
]

/** A random workload over notes, tags and counters, with schema changes. */
class Workload {
  extra = false
  indexed = false
  version = 0
  constructor(readonly rand: () => number) {}

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)] as T
  }

  noteId(): string {
    return `n${Math.floor(this.rand() * 40)}`
  }

  value(): BindableValue {
    const r = this.rand()
    if (r < 0.1) return null
    if (r < 0.15) return 2n ** 60n + BigInt(Math.floor(this.rand() * 1000))
    if (r < 0.3) return this.rand() * 1e6 - 5e5
    if (r < 0.6) return Math.floor(this.rand() * 1e6) - 1000
    if (r < 0.75)
      return Uint8Array.from({ length: 1 + Math.floor(this.rand() * 40) }, () =>
        Math.floor(this.rand() * 256),
      )
    return `${this.pick(['note', 'Ünïcödé ✓', 'x'.repeat(50), ''])} ${Math.floor(this.rand() * 1000)}`
  }

  /** One data-changing statement. */
  change(): Statement {
    const r = this.rand()
    if (r < 0.3) {
      return [
        'INSERT INTO notes (id, title, n, body) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title, n = excluded.n',
        [this.noteId(), this.value(), Math.floor(this.rand() * 100), this.value()],
      ]
    }
    if (r < 0.45)
      return [
        'UPDATE notes SET n = n + ? WHERE id = ?',
        [Math.floor(this.rand() * 10), this.noteId()],
      ]
    if (r < 0.55) return ['DELETE FROM notes WHERE id = ?', [this.noteId()]]
    if (r < 0.7) {
      return [
        'INSERT OR IGNORE INTO tags VALUES (?, ?)',
        [this.noteId(), this.pick(['a', 'b', 'c', 'd'])],
      ]
    }
    if (r < 0.78)
      return ['DELETE FROM tags WHERE note = ? AND tag = ?', [this.noteId(), this.pick(['a', 'b'])]]
    return [
      'INSERT INTO counters (id, c, f) VALUES (?, 1, ?) ON CONFLICT (id) DO UPDATE SET c = c + 1, f = excluded.f',
      [1 + Math.floor(this.rand() * 5), this.rand()],
    ]
  }

  /** A schema change, possibly with data changes in the same call. */
  schemaChange(): Statement[] {
    const r = this.rand()
    if (r < 0.25) {
      this.extra = !this.extra
      return this.extra
        ? [
            ['ALTER TABLE notes ADD COLUMN extra TEXT'],
            ["UPDATE notes SET extra = upper(title) || '!'"],
          ]
        : [['ALTER TABLE notes DROP COLUMN extra']]
    }
    if (r < 0.45) {
      this.indexed = !this.indexed
      return this.indexed ? [['CREATE INDEX notes_n ON notes (n)']] : [['DROP INDEX notes_n']]
    }
    if (r < 0.65) return [[`PRAGMA user_version = ${++this.version}`], this.change()]
    return [
      ['CREATE TABLE counters_new (id INTEGER PRIMARY KEY, c INTEGER NOT NULL DEFAULT 0, f REAL)'],
      ['INSERT INTO counters_new SELECT id, c * 2, f FROM counters'],
      ['DROP TABLE counters'],
      ['ALTER TABLE counters_new RENAME TO counters'],
    ]
  }
}

describe('replica equality', () => {
  quietSqliteWarnings()

  it.each(Array.from({ length: 24 }, (_, i) => i + 1))(
    'a copy built from the log equals the source (seed %i)',
    async (seed) => {
      const rand = prng(seed)
      const w = new Workload(rand)
      const repo = await repoOver()
      const dir = new MemoryDirectory()
      const every = w.pick([0, 1, 3, 10, 100])
      const reopen = () => open(dir, repo, { flush: { every } })
      let db = await reopen()
      await db.transaction(SCHEMA)
      let midway: DirectoryImage | undefined
      try {
        for (let step = 0; step < 300; step++) {
          const r = rand()
          if (r < 0.55) await db.query(...w.change())
          else if (r < 0.75) {
            await db.transaction(
              Array.from({ length: 2 + Math.floor(rand() * 4) }, () => w.change()),
            )
          } else if (r < 0.8) {
            // A call that fails leaves nothing behind.
            await expect(
              db.transaction([w.change(), ['INSERT INTO notes (id) VALUES (NULL)']]),
            ).rejects.toThrow(/NOT NULL constraint/)
          } else if (r < 0.84) {
            await db.transaction(w.schemaChange())
          } else if (r < 0.95) {
            await db.flush()
            if (midway === undefined && step > 50) midway = dir.image()
          } else {
            await db.close()
            db = await reopen()
          }
        }
        await db.flush()
        const source = await dump(db)

        const copy = await replica(repo)
        expect(await dump(copy)).toEqual(source)
        expect([copy.seq, copy.schemaVersion]).toEqual([db.seq, db.schemaVersion])
        expect(await integrity(copy)).toBe('ok')
        expect(copy.recovery.transactions).toBe(db.seq)
        await copy.close()

        // A copy taken part-way, behind the log, catches up.
        if (midway) {
          const behind = await open(new MemoryDirectory(midway), repo)
          expect(behind.recovery.entries).toBeGreaterThan(0)
          expect(await dump(behind)).toEqual(source)
          await behind.close()
        }
      } finally {
        await db.close()
      }
    },
  )

  it('replays in chunks, resuming after the last one that committed', async () => {
    // Merged pieces each covering 60,000 transactions: no two fit in one chunk.
    const repo = await repoOver()
    const db = await open(new MemoryDirectory(), repo)
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v)')
    await db.close()
    const scratch = new sqlite3.oo1.DB(':memory:')
    scratch.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v)')
    const wt = await repo.worktree(BRANCH)
    let from = 2
    for (let i = 0; i < 3; i++) {
      const session = startSession(sqlite3, scratch)
      scratch.exec({ sql: 'INSERT INTO t VALUES (?, ?)', bind: [i, `chunk ${i}`] })
      const pieces: Piece[] = [
        { kind: 'changeset', from, to: from + 59_999, schema: 1, body: session.changeset() },
      ]
      session.dispose()
      const body = cborCodec.encode(pieces.map((p) => [0, p.from, p.to, p.schema, p.body]))
      const bytes = new Uint8Array([ENTRY_FORMAT, ...body])
      wt.set(ENTRY_KEY, bytes)
      await wt.commit({ info: { ...entryInfo(pieces, bytes, await sha256Hex(bytes)) } })
      from += 60_000
    }
    scratch.close()

    // Crash at every sync of the replay: each leaves the file at a
    // chunk boundary, and the next open resumes from it.
    const dry = new CrashingDirectory(new MemoryDirectory())
    const dryRun = await open(dry, repo)
    const syncs = dry.ops.sync
    await dryRun.close()
    const resumedFrom = new Set<unknown>()
    for (let n = 1; n <= syncs; n++) {
      const mem = new MemoryDirectory()
      const crashing = new CrashingDirectory(mem)
      crashing.crashAt({ op: 'sync', n })
      await expect(open(crashing, repo)).rejects.toThrow()
      expect(crashing.crashed).not.toBeNull()
      const file = await openDatabase(new MemoryDirectory(mem.image()), NAME)
      try {
        resumedFrom.add(file.db.selectValue('SELECT applied_seq FROM _kvsql_meta'))
      } catch {
        resumedFrom.add('no tables yet')
      } finally {
        file.close()
      }
      const again = await open(new MemoryDirectory(mem.image()), repo)
      expect(again.seq).toBe(180_001)
      expect((await again.query('SELECT id, v FROM t ORDER BY id')).rows).toEqual([
        { id: 0, v: 'chunk 0' },
        { id: 1, v: 'chunk 1' },
        { id: 2, v: 'chunk 2' },
      ])
      await again.close()
    }
    // Three chunks, not one: the replay committed after each.
    for (const seq of [1, 60_001, 120_001]) expect(resumedFrom).toContain(seq)
  })
})
