import type { Database } from '@sqlite.org/sqlite-wasm'
import { describe, expect, it } from 'vitest'
import {
  ABORT_ON_CONFLICT,
  type ConflictPolicy,
  type Session,
  SqliteError,
  THIS_SIDE_WINS,
  applyChangeset,
  changesetOps,
  combineChangesets,
  invertChangeset,
  startSession,
} from '../src/index'
import { dump, memoryDb, rows, sqlite3 } from './db'

const NOTES = `
  CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT, body TEXT, n INTEGER);
  INSERT INTO notes VALUES ('a', 'A', 'alpha', 1), ('b', 'B', 'beta', 2), ('c', 'C', 'gamma', 3);
`

/** Run `sql` on `db` under a fresh session and return the changeset it made. */
function record(db: Database, sql: string): Uint8Array {
  const session = startSession(sqlite3, db)
  try {
    db.exec(sql)
    return session.changeset()
  } finally {
    session.dispose()
  }
}

describe('capture', () => {
  it('records an insert as the whole row', () => {
    const db = memoryDb(NOTES)
    const cs = record(db, "INSERT INTO notes VALUES ('d', 'D', 'delta', 4)")
    expect(changesetOps(sqlite3, cs)).toEqual([
      {
        table: 'notes',
        op: 'INSERT',
        columns: 4,
        indirect: false,
        pk: ['d'],
        after: ['d', 'D', 'delta', 4],
      },
    ])
  })

  it('records an update as the key and the changed columns only', () => {
    const db = memoryDb(NOTES)
    const cs = record(db, "UPDATE notes SET title = 'A2' WHERE id = 'a'")
    expect(changesetOps(sqlite3, cs)).toEqual([
      {
        table: 'notes',
        op: 'UPDATE',
        columns: 4,
        indirect: false,
        pk: ['a'],
        before: ['a', 'A', undefined, undefined],
        after: [undefined, 'A2', undefined, undefined],
      },
    ])
  })

  it('records a delete as the whole row', () => {
    const db = memoryDb(NOTES)
    const cs = record(db, "DELETE FROM notes WHERE id = 'b'")
    expect(changesetOps(sqlite3, cs)).toEqual([
      {
        table: 'notes',
        op: 'DELETE',
        columns: 4,
        indirect: false,
        pk: ['b'],
        before: ['b', 'B', 'beta', 2],
      },
    ])
  })

  it('records the net change: an insert then a delete leaves nothing', () => {
    const db = memoryDb(NOTES)
    const session = startSession(sqlite3, db)
    try {
      expect(session.isEmpty).toBe(true)
      db.exec("INSERT INTO notes VALUES ('x', 'X', '', 0); DELETE FROM notes WHERE id = 'x'")
      expect(changesetOps(sqlite3, session.changeset())).toEqual([])
      db.exec("UPDATE notes SET n = 10 WHERE id = 'c'")
      expect(session.isEmpty).toBe(false)
    } finally {
      session.dispose()
    }
  })

  it('records tables created after the session started, and keys of every shape', () => {
    const db = memoryDb()
    const cs = record(
      db,
      `CREATE TABLE pairs (a TEXT NOT NULL, b INTEGER NOT NULL, v, PRIMARY KEY (a, b));
       CREATE TABLE counters (id INTEGER PRIMARY KEY, v);
       CREATE TABLE tags (k TEXT PRIMARY KEY, v) WITHOUT ROWID;
       INSERT INTO pairs VALUES ('x', 1, 'p');
       INSERT INTO counters (v) VALUES ('c');
       INSERT INTO tags VALUES ('t', 'v');`,
    )
    expect(changesetOps(sqlite3, cs).map(({ table, pk }) => [table, pk])).toEqual([
      ['pairs', ['x', 1]],
      ['counters', [1]],
      ['tags', ['t']],
    ])
  })

  it('skips internal tables', () => {
    const db = memoryDb(`${NOTES}; CREATE TABLE _kvsql_pending (seq INTEGER PRIMARY KEY, cs BLOB);
      CREATE TABLE _KVSQL_Other (k TEXT PRIMARY KEY NOT NULL)`)
    const cs = record(
      db,
      `INSERT INTO _kvsql_pending (cs) VALUES (x'00');
       INSERT INTO _KVSQL_Other VALUES ('k');
       ANALYZE;
       UPDATE notes SET n = 0 WHERE id = 'a';`,
    )
    expect(changesetOps(sqlite3, cs).map((op) => op.table)).toEqual(['notes'])
  })

  it('refuses a disposed session and tolerates a second dispose', () => {
    const db = memoryDb(NOTES)
    const session: Session = startSession(sqlite3, db)
    session.dispose()
    session.dispose()
    expect(() => session.changeset()).toThrow(/disposed/)
  })
})

describe('invert and combine', () => {
  const EDITS = `
    INSERT INTO notes VALUES ('d', 'D', 'delta', 4);
    UPDATE notes SET title = 'A2', n = n + 10 WHERE id = 'a';
    DELETE FROM notes WHERE id = 'b';
    UPDATE notes SET body = NULL WHERE id = 'd';
  `

  it('inverting restores the prior state exactly', () => {
    const db = memoryDb(NOTES)
    const before = dump(db)
    const cs = record(db, EDITS)
    const after = dump(db)
    expect(after).not.toEqual(before)

    expect(applyChangeset(sqlite3, db, invertChangeset(sqlite3, cs))).toEqual({
      applied: true,
      conflicts: [],
    })
    expect(dump(db)).toEqual(before)

    // Applying with `invert` is the same as applying the inverse.
    expect(applyChangeset(sqlite3, db, cs).applied).toBe(true)
    expect(dump(db)).toEqual(after)
    expect(applyChangeset(sqlite3, db, cs, { invert: true }).applied).toBe(true)
    expect(dump(db)).toEqual(before)
  })

  it('the inverse swaps inserts and deletes and before and after', () => {
    const db = memoryDb(NOTES)
    const cs = record(db, EDITS)
    const inverse = changesetOps(sqlite3, invertChangeset(sqlite3, cs))
    expect(inverse.map(({ op, pk }) => [op, pk])).toEqual(
      changesetOps(sqlite3, cs).map(({ op, pk }) => [
        op === 'INSERT' ? 'DELETE' : op === 'DELETE' ? 'INSERT' : 'UPDATE',
        pk,
      ]),
    )
  })

  it('a combined sequence applies the same as its parts one by one', () => {
    const source = memoryDb(NOTES)
    const parts = [
      record(source, "INSERT INTO notes VALUES ('d', 'D', 'delta', 4)"),
      record(
        source,
        "UPDATE notes SET title = 'D2' WHERE id = 'd'; DELETE FROM notes WHERE id = 'a'",
      ),
      record(source, "UPDATE notes SET n = n * 2; INSERT INTO notes VALUES ('a', 'A3', '', 0)"),
      record(source, "DELETE FROM notes WHERE id = 'c'"),
    ]
    const combined = combineChangesets(sqlite3, parts)

    const oneByOne = memoryDb(NOTES)
    for (const cs of parts) expect(applyChangeset(sqlite3, oneByOne, cs).applied).toBe(true)
    const grouped = memoryDb(NOTES)
    expect(applyChangeset(sqlite3, grouped, combined)).toEqual({ applied: true, conflicts: [] })

    expect(dump(oneByOne)).toEqual(dump(source))
    expect(dump(grouped)).toEqual(dump(source))
    // One change per row touched: the insert of 'd' and its update merge.
    expect(
      changesetOps(sqlite3, combined)
        .map(({ op, pk }) => `${op} ${pk}`)
        .sort(),
    ).toEqual(['DELETE c', 'INSERT d', 'UPDATE a', 'UPDATE b'])
  })

  it('handles empty changesets', () => {
    const db = memoryDb(NOTES)
    const empty = new Uint8Array(0)
    expect(invertChangeset(sqlite3, empty)).toEqual(empty)
    expect(combineChangesets(sqlite3, [])).toEqual(empty)
    expect(changesetOps(sqlite3, empty)).toEqual([])
    expect(applyChangeset(sqlite3, db, empty)).toEqual({ applied: true, conflicts: [] })
  })

  it("can't tell a changeset cut at a change boundary from a shorter one", () => {
    // Changesets carry no length or checksum: whoever stores them must.
    const db = memoryDb(NOTES)
    const cs = record(db, "UPDATE notes SET n = 6 WHERE id = 'a'; DELETE FROM notes WHERE id = 'b'")
    expect(changesetOps(sqlite3, cs)).toHaveLength(2)
    const parsesShorter = (n: number) => {
      try {
        return changesetOps(sqlite3, cs.slice(0, n)).length === 1
      } catch {
        return false
      }
    }
    const cuts = Array.from({ length: cs.byteLength - 1 }, (_, i) => i + 1).filter(parsesShorter)
    expect(cuts).toHaveLength(1)
  })

  it('throws on a corrupt changeset and frees what it allocated', () => {
    const db = memoryDb(NOTES)
    const cs = record(db, "UPDATE notes SET n = 5 WHERE id = 'a'; DELETE FROM notes WHERE id = 'b'")
    const corrupt = cs.slice(0, cs.byteLength - 3)
    const target = memoryDb(NOTES)
    const before = dump(target)
    const garbage = new Uint8Array([0x54, 0xff, 0xff, 0xff, 0x7f, 1, 2, 3])
    /** Bytes SQLite has allocated, wasm.alloc's included (it is sqlite3_malloc). */
    const used = () => {
      const { capi, wasm } = sqlite3
      const sp = wasm.pstack.pointer
      try {
        const cur = wasm.pstack.alloc(4)
        const high = wasm.pstack.alloc(4)
        expect(capi.sqlite3_status(capi.SQLITE_STATUS_MEMORY_USED, cur, high, 0)).toBe(0)
        return wasm.peek32(cur)
      } finally {
        wasm.pstack.restore(sp)
      }
    }

    const round = () => {
      for (const bad of [corrupt, garbage]) {
        expect(() => invertChangeset(sqlite3, bad)).toThrow(SqliteError)
        expect(() => changesetOps(sqlite3, bad)).toThrow(SqliteError)
        expect(() => combineChangesets(sqlite3, [cs, bad])).toThrow(SqliteError)
        expect(() => applyChangeset(sqlite3, target, bad)).toThrow(SqliteError)
      }
      const session = startSession(sqlite3, db)
      session.changeset()
      session.dispose()
      invertChangeset(sqlite3, cs)
      changesetOps(sqlite3, cs)
      combineChangesets(sqlite3, [cs, cs])
    }
    round()
    const baseline = used()
    for (let i = 0; i < 200; i++) round()
    expect(used()).toBe(baseline)
    // A changeset that fails partway leaves nothing behind.
    expect(dump(target)).toEqual(before)
  })
})

describe('applying with a conflict policy', () => {
  const BASE = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT, body TEXT);
    CREATE UNIQUE INDEX notes_title ON notes (title);
    CREATE TABLE folders (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, folder TEXT NOT NULL REFERENCES folders (id));
    INSERT INTO notes VALUES ('a', 'A', 'alpha'), ('b', 'B', 'beta');
    INSERT INTO folders VALUES ('f');
  `

  /**
   * A changes the shared base under a session, B changes it directly;
   * then A's changeset is applied to B.
   */
  function merge(a: string, b: string, policy: Readonly<ConflictPolicy>) {
    const devA = memoryDb(BASE)
    const devB = memoryDb(BASE)
    const cs = record(devA, a)
    devB.exec(b)
    const beforeApply = dump(devB)
    const result = applyChangeset(sqlite3, devB, cs, { policy })
    return { result, before: beforeApply, after: dump(devB), db: devB }
  }

  const note = (db: Database, id: string) => rows(db, 'notes').find((r) => r.id === id)

  it('disjoint rows: no conflict, both kept', () => {
    for (const policy of [ABORT_ON_CONFLICT, THIS_SIDE_WINS]) {
      const m = merge(
        "UPDATE notes SET body = 'A-edit' WHERE id = 'a'",
        "UPDATE notes SET body = 'B-edit' WHERE id = 'b'",
        policy,
      )
      expect(m.result).toEqual({ applied: true, conflicts: [] })
      expect(note(m.db, 'a')?.body).toBe('A-edit')
      expect(note(m.db, 'b')?.body).toBe('B-edit')
    }
  })

  it('same row, different columns: no conflict, both kept', () => {
    for (const policy of [ABORT_ON_CONFLICT, THIS_SIDE_WINS]) {
      const m = merge(
        "UPDATE notes SET body = 'A-edit' WHERE id = 'a'",
        "UPDATE notes SET title = 'A-by-B' WHERE id = 'a'",
        policy,
      )
      expect(m.result).toEqual({ applied: true, conflicts: [] })
      expect(note(m.db, 'a')).toEqual({ id: 'a', title: 'A-by-B', body: 'A-edit' })
    }
  })

  it('same row, same column: DATA', () => {
    const a =
      "UPDATE notes SET body = 'A-edit' WHERE id = 'a'; INSERT INTO notes VALUES ('n', 'N', '')"
    const b = "UPDATE notes SET body = 'B-edit' WHERE id = 'a'"

    const aborted = merge(a, b, ABORT_ON_CONFLICT)
    expect(aborted.result.applied).toBe(false)
    expect(aborted.result.conflicts).toMatchObject([
      { kind: 'DATA', action: 'abort', table: 'notes', op: 'UPDATE', pk: ['a'] },
    ])
    // Rolled back whole, including A's insert that applied before the conflict.
    expect(aborted.after).toEqual(aborted.before)

    const won = merge(a, b, THIS_SIDE_WINS)
    expect(won.result.applied).toBe(true)
    expect(won.result.conflicts).toMatchObject([{ kind: 'DATA', action: 'replace', pk: ['a'] }])
    expect(note(won.db, 'a')?.body).toBe('A-edit')
    expect(note(won.db, 'n')).toBeDefined()
  })

  it('A deletes, B updated: DATA', () => {
    const a = "DELETE FROM notes WHERE id = 'a'"
    const b = "UPDATE notes SET body = 'B-edit' WHERE id = 'a'"

    const aborted = merge(a, b, ABORT_ON_CONFLICT)
    expect(aborted.result).toMatchObject({
      applied: false,
      conflicts: [{ kind: 'DATA', action: 'abort', op: 'DELETE', pk: ['a'] }],
    })
    expect(aborted.after).toEqual(aborted.before)

    const won = merge(a, b, THIS_SIDE_WINS)
    expect(won.result).toMatchObject({
      applied: true,
      conflicts: [{ kind: 'DATA', action: 'replace', op: 'DELETE' }],
    })
    expect(note(won.db, 'a')).toBeUndefined()
  })

  it('A updates, B deleted: NOTFOUND', () => {
    const a = "UPDATE notes SET body = 'A-edit' WHERE id = 'a'"
    const b = "DELETE FROM notes WHERE id = 'a'"

    const aborted = merge(a, b, ABORT_ON_CONFLICT)
    expect(aborted.result).toMatchObject({
      applied: false,
      conflicts: [{ kind: 'NOTFOUND', action: 'abort', op: 'UPDATE', pk: ['a'] }],
    })
    expect(aborted.after).toEqual(aborted.before)

    const won = merge(a, b, THIS_SIDE_WINS)
    expect(won.result).toMatchObject({
      applied: true,
      conflicts: [{ kind: 'NOTFOUND', action: 'omit' }],
    })
    expect(note(won.db, 'a')).toBeUndefined()
  })

  it('same key inserted on both: CONFLICT', () => {
    const a = "INSERT INTO notes VALUES ('n', 'from A', 'a')"
    const b = "INSERT INTO notes VALUES ('n', 'from B', 'b')"

    const aborted = merge(a, b, ABORT_ON_CONFLICT)
    expect(aborted.result).toMatchObject({
      applied: false,
      conflicts: [{ kind: 'CONFLICT', action: 'abort', op: 'INSERT', pk: ['n'] }],
    })
    expect(aborted.after).toEqual(aborted.before)

    const won = merge(a, b, THIS_SIDE_WINS)
    expect(won.result).toMatchObject({
      applied: true,
      conflicts: [{ kind: 'CONFLICT', action: 'replace' }],
    })
    expect(note(won.db, 'n')).toEqual({ id: 'n', title: 'from A', body: 'a' })
  })

  it('a unique index violated: CONSTRAINT aborts under both presets', () => {
    for (const policy of [ABORT_ON_CONFLICT, THIS_SIDE_WINS]) {
      const m = merge(
        "INSERT INTO notes VALUES ('x', 'Same', 'a')",
        "INSERT INTO notes VALUES ('y', 'Same', 'b')",
        policy,
      )
      expect(m.result).toMatchObject({
        applied: false,
        conflicts: [{ kind: 'CONSTRAINT', action: 'abort', op: 'INSERT', pk: ['x'] }],
      })
      expect(m.after).toEqual(m.before)
    }
  })

  it('a foreign key broken by the combination: aborts under both presets, never committed', () => {
    for (const policy of [ABORT_ON_CONFLICT, THIS_SIDE_WINS]) {
      const m = merge(
        "INSERT INTO items VALUES ('i', 'f')",
        "DELETE FROM folders WHERE id = 'f'",
        policy,
      )
      expect(m.result).toEqual({
        applied: false,
        conflicts: [{ kind: 'FOREIGN_KEY', action: 'abort', count: 1 }],
      })
      expect(m.after).toEqual(m.before)
      expect(m.db.exec({ sql: 'PRAGMA foreign_key_check', returnValue: 'resultRows' })).toEqual([])
    }
  })

  it('refuses policies SQLite calls misuse or that would commit an FK violation', () => {
    const db = memoryDb(BASE)
    const cs = record(db, "UPDATE notes SET body = '' WHERE id = 'a'")
    const bad = [
      { ...ABORT_ON_CONFLICT, FOREIGN_KEY: 'omit' },
      { ...ABORT_ON_CONFLICT, NOTFOUND: 'replace' },
      { ...ABORT_ON_CONFLICT, CONSTRAINT: 'replace' },
    ] as unknown as ConflictPolicy[]
    for (const policy of bad) {
      expect(() => applyChangeset(sqlite3, db, cs, { policy })).toThrow(TypeError)
    }
  })
})

describe('replay', () => {
  it("doesn't fire triggers again, and restores them afterwards", () => {
    const SCHEMA = `
      CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, name TEXT);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, item TEXT);
      CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN
        INSERT INTO audit (item) VALUES (new.id);
      END;
    `
    const source = memoryDb(SCHEMA)
    const cs = record(source, "INSERT INTO items VALUES ('i', 'one')")
    expect(changesetOps(sqlite3, cs).map(({ table, indirect }) => [table, indirect])).toEqual([
      ['items', false],
      ['audit', true],
    ])

    const replica = memoryDb(SCHEMA)
    expect(applyChangeset(sqlite3, replica, cs)).toEqual({ applied: true, conflicts: [] })
    expect(dump(replica)).toEqual(dump(source))

    replica.exec("INSERT INTO items VALUES ('j', 'two')")
    expect(rows(replica, 'audit')).toEqual([
      { id: 1, item: 'i' },
      { id: 2, item: 'j' },
    ])

    // Restored after a failed apply too.
    expect(() => applyChangeset(sqlite3, replica, new Uint8Array([1, 2, 3, 4]))).toThrow(
      SqliteError,
    )
    replica.exec("INSERT INTO items VALUES ('k', 'three')")
    expect(rows(replica, 'audit')).toHaveLength(3)
  })

  it('refuses to apply on a connection with a TEMP trigger, which SQLite keeps running', () => {
    const SCHEMA =
      'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE log (id INTEGER PRIMARY KEY, v TEXT)'
    const cs = record(memoryDb(SCHEMA), "INSERT INTO t VALUES ('x')")
    const replica = memoryDb(SCHEMA)
    replica.exec(
      'CREATE TEMP TRIGGER t_log AFTER INSERT ON main.t BEGIN INSERT INTO log (v) VALUES (new.id); END',
    )
    expect(() => applyChangeset(sqlite3, replica, cs)).toThrow(/TEMP triggers/)
    expect(dump(replica)).toEqual({ log: [], t: [] })

    replica.exec('DROP TRIGGER temp.t_log')
    expect(applyChangeset(sqlite3, replica, cs).applied).toBe(true)
    expect(dump(replica)).toEqual({ log: [], t: [{ id: 'x' }] })
  })

  it('leaves triggers off if they were off', () => {
    const db = memoryDb('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
    const cs = record(db, "INSERT INTO t VALUES ('x')")
    const replica = memoryDb('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)')
    const { capi } = sqlite3
    capi.sqlite3_db_config(replica, capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, 0, 0)
    applyChangeset(sqlite3, replica, cs)
    const p = sqlite3.wasm.pstack.pointer
    try {
      const out = sqlite3.wasm.pstack.alloc(4)
      capi.sqlite3_db_config(replica, capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, -1, out)
      expect(sqlite3.wasm.peek32(out)).toBe(0)
    } finally {
      sqlite3.wasm.pstack.restore(p)
    }
  })

  it('replays ON DELETE CASCADE without running the cascade again', () => {
    const SCHEMA = `
      PRAGMA foreign_keys = ON;
      CREATE TABLE folders (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE files (
        id TEXT PRIMARY KEY NOT NULL,
        folder TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE
      );
      INSERT INTO folders VALUES ('f'), ('g');
      INSERT INTO files VALUES ('1', 'f'), ('2', 'f'), ('3', 'g');
    `
    const source = memoryDb(SCHEMA)
    const cs = record(source, "DELETE FROM folders WHERE id = 'f'")
    expect(
      changesetOps(sqlite3, cs).map(({ table, op, indirect }) => [table, op, indirect]),
    ).toEqual([
      ['folders', 'DELETE', false],
      ['files', 'DELETE', true],
      ['files', 'DELETE', true],
    ])

    const replica = memoryDb(SCHEMA)
    expect(applyChangeset(sqlite3, replica, cs)).toEqual({ applied: true, conflicts: [] })
    expect(dump(replica)).toEqual(dump(source))

    // And back: the inverse restores the folder and its files.
    expect(applyChangeset(sqlite3, replica, cs, { invert: true }).applied).toBe(true)
    expect(dump(replica)).toEqual(dump(memoryDb(SCHEMA)))
  })
})
