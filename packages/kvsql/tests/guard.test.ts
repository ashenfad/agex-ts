import type { Database } from '@sqlite.org/sqlite-wasm'
import { describe, expect, it } from 'vitest'
import {
  RefusedError,
  type SchemaGuard,
  type SchemaViolation,
  changesetOps,
  checkSchema,
  installGuard,
  startSession,
} from '../src/index'
import { dump, memoryDb, sqlite3 } from './db'

function guarded(sql = ''): { db: Database; guard: SchemaGuard } {
  const db = memoryDb(sql)
  return { db, guard: installGuard(sqlite3, db, { label: 'agex.db' }) }
}

/** The error `fn` throws, run through the guard. */
function refusal(guard: SchemaGuard, fn: () => unknown): RefusedError {
  try {
    guard.run(fn)
  } catch (err) {
    expect(err).toBeInstanceOf(RefusedError)
    expect((err as Error).cause).toBeInstanceOf(Error)
    return err as RefusedError
  }
  throw new Error('expected a refusal')
}

describe('refusals', () => {
  it('ATTACH', () => {
    const { db, guard } = guarded()
    const err = refusal(guard, () => db.exec("ATTACH ':memory:' AS other"))
    expect(err.message).toBe(
      "ATTACH and VACUUM INTO aren't available in agex.db: it is a single database, and its copies and snapshots are managed for you. Keep every table in it.",
    )
    expect(refusal(guard, () => db.exec("ATTACH '' AS other")).message).toMatch(
      /^ATTACH and VACUUM aren't available in agex\.db/,
    )
  })

  it('DETACH', () => {
    const { db, guard } = guarded()
    guard.trusted(() => db.exec("ATTACH ':memory:' AS other"))
    expect(refusal(guard, () => db.exec('DETACH other')).message).toBe(
      "DETACH isn't available in agex.db: no other database can be attached.",
    )
  })

  it('virtual tables, pointing at LIKE for text search', () => {
    const { db, guard } = guarded()
    const fts = refusal(guard, () => db.exec('CREATE VIRTUAL TABLE docs USING fts5(body)'))
    expect(fts.message).toBe(
      "Virtual tables (CREATE VIRTUAL TABLE ... USING fts5) aren't supported in agex.db yet. For text search use LIKE (or instr) on an ordinary table; for ranges use an ordinary table with an index.",
    )
    expect(
      refusal(guard, () => db.exec('CREATE VIRTUAL TABLE boxes USING rtree(id, x0, x1)')).message,
    ).toMatch(/USING rtree\) aren't supported/)
    // Nothing was created, shadow tables included.
    expect(dump(db)).toEqual({})
  })

  it('loading extensions', () => {
    const { db, guard } = guarded()
    // This build has no load_extension(); stand one in, to show the
    // guard refuses the call before it could run.
    let called = false
    db.createFunction('load_extension', (_ctx: number, _file: unknown) => {
      called = true
      return null
    })
    expect(refusal(guard, () => db.exec("SELECT load_extension('x.so')")).message).toBe(
      "Loading extensions isn't available in agex.db: use SQLite's built-in functions.",
    )
    expect(called).toBe(false)
  })

  it('VACUUM INTO and VACUUM, which reach the authorizer as an ATTACH at run time', () => {
    const { db, guard } = guarded(
      "CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL); INSERT INTO t VALUES ('x')",
    )
    expect(refusal(guard, () => db.exec("VACUUM INTO 'refused.db'")).message).toMatch(
      /^ATTACH and VACUUM INTO aren't available in agex\.db/,
    )
    expect(refusal(guard, () => db.exec('VACUUM')).message).toMatch(
      /^ATTACH and VACUUM aren't available in agex\.db/,
    )
  })

  it('setting pragmas that change how the file is written, in any form', () => {
    const { db, guard } = guarded()
    const managed = [
      'journal_mode',
      'locking_mode',
      'synchronous',
      'writable_schema',
      'schema_version',
      'page_size',
      'auto_vacuum',
    ]
    const values: Record<string, string> = {
      journal_mode: 'WAL',
      locking_mode: 'EXCLUSIVE',
      synchronous: 'OFF',
      writable_schema: 'ON',
      schema_version: '99',
      page_size: '8192',
      auto_vacuum: 'FULL',
    }
    for (const name of managed) {
      const v = values[name]
      for (const sql of [
        `PRAGMA ${name} = ${v}`,
        `PRAGMA main.${name} = ${v}`,
        `PRAGMA ${name.toUpperCase()}(${v})`,
        `PRAGMA temp.${name} = ${v}`,
      ]) {
        expect(refusal(guard, () => db.exec(sql)).message, sql).toBe(
          `Setting PRAGMA ${name} isn't available in agex.db: the database manages its own file (journaling, page layout) and schema. Reading the pragma is fine.`,
        )
      }
      // Reading stays allowed.
      guard.run(() => db.exec(`PRAGMA ${name}`))
      guard.run(() => db.exec(`PRAGMA main.${name}`))
    }
    expect(
      guard.trusted(() => db.exec({ sql: 'PRAGMA journal_mode = OFF', returnValue: 'resultRows' })),
    ).toEqual([['off']])
    // Per-connection pragmas are the connection owner's.
    guard.run(() =>
      db.exec('PRAGMA foreign_keys = ON; PRAGMA cache_size = -4000; PRAGMA temp_store = MEMORY'),
    )
  })

  it('names with the reserved prefix', () => {
    const { db, guard } = guarded()
    const expected =
      'Names starting with _kvsql_ are reserved for agex.db\'s own records ("_kvsql_mine"): use another name.'
    expect(
      refusal(guard, () => db.exec('CREATE TABLE _kvsql_mine (id TEXT PRIMARY KEY NOT NULL)'))
        .message,
    ).toBe(expected)

    guard.trusted(() => db.exec('CREATE TABLE _kvsql_pending (seq INTEGER PRIMARY KEY, cs BLOB)'))
    for (const sql of [
      'SELECT * FROM _kvsql_pending',
      "INSERT INTO _kvsql_pending (cs) VALUES (x'00')",
      'DELETE FROM _KVSQL_PENDING',
      'DROP TABLE _kvsql_pending',
      'ALTER TABLE _kvsql_pending ADD COLUMN x',
      'CREATE INDEX i ON _kvsql_pending (cs)',
      "PRAGMA table_info('_kvsql_pending')",
    ]) {
      expect(refusal(guard, () => db.exec(sql)).message, sql).toMatch(
        /reserved for agex\.db's own records/,
      )
    }
    // A bare ANALYZE visits every table and is allowed.
    guard.run(() => db.exec('ANALYZE'))
    expect(
      guard.trusted(() =>
        db.exec({ sql: 'SELECT count(*) FROM _kvsql_pending', returnValue: 'resultRows' }),
      ),
    ).toEqual([[0]])
  })

  it('passes other errors through, and ordinary SQL runs', () => {
    const { db, guard } = guarded('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v)')
    guard.run(() => db.exec("INSERT INTO t VALUES ('a', 1)"))
    expect(() => guard.run(() => db.exec("INSERT INTO t VALUES ('a', 2)"))).toThrow(
      /UNIQUE constraint/,
    )
    expect(() => guard.run(() => db.exec('SELECT nope FROM t'))).toThrow(/no such column/)
    // A refusal caught inside run doesn't relabel a later, unrelated error.
    expect(() =>
      guard.run(() => {
        try {
          db.exec("ATTACH ':memory:' AS x")
        } catch {}
        db.exec('SELECT nope FROM t')
      }),
    ).toThrow(/no such column/)
    expect(
      guard.run(() =>
        db.exec({ sql: "SELECT value FROM json_each('[1,2]')", returnValue: 'resultRows' }),
      ),
    ).toEqual([[1], [2]])
  })

  it('names the database generically by default', () => {
    const db = memoryDb()
    const guard = installGuard(sqlite3, db)
    expect(refusal(guard, () => db.exec("ATTACH '' AS x")).message).toMatch(/in this database:/)
  })

  it('is removed by dispose', () => {
    const { db, guard } = guarded()
    guard.dispose()
    guard.dispose()
    db.exec("ATTACH ':memory:' AS other")
  })
})

describe('trusted mode', () => {
  it('allows VACUUM INTO for snapshots', () => {
    const { db, guard } = guarded(`CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v);
      INSERT INTO t VALUES ('a', 1), ('b', 2)`)
    const file = `snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    guard.trusted(() => db.exec(`VACUUM INTO '${file}'`))
    expect(guard.schemaChanged).toBe(false)
    const copy = new sqlite3.oo1.DB(file)
    try {
      expect(dump(copy)).toEqual(dump(db))
    } finally {
      copy.close()
    }
    // And only inside it.
    expect(() => guard.run(() => db.exec(`VACUUM INTO '${file}.2'`))).toThrow(RefusedError)
  })

  it('ends when its callback throws', () => {
    const { db, guard } = guarded()
    expect(() =>
      guard.trusted(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(() => guard.run(() => db.exec("ATTACH '' AS x"))).toThrow(RefusedError)
  })
})

describe('schema-change detection', () => {
  const cases: [string, boolean][] = [
    ['CREATE TABLE u (id TEXT PRIMARY KEY NOT NULL)', true],
    ['ALTER TABLE t ADD COLUMN w', true],
    ['ALTER TABLE t RENAME TO t2', true],
    ['DROP TABLE t', true],
    ['CREATE INDEX t_v ON t (v)', true],
    ['CREATE VIEW tv AS SELECT * FROM t', true],
    ['CREATE TRIGGER tt AFTER INSERT ON t BEGIN SELECT 1; END', true],
    ['ANALYZE', true],
    ["INSERT INTO t VALUES ('b', 2)", false],
    ["UPDATE t SET v = 3 WHERE id = 'a'", false],
    ['SELECT * FROM t', false],
    ['CREATE TEMP TABLE scratch (x)', false],
    ['CREATE TEMP VIEW tv AS SELECT 1', false],
    ['PRAGMA user_version = 3', true],
    ['PRAGMA main.user_version = 4', true],
    ['PRAGMA user_version(5)', true],
    ['PRAGMA Application_ID = 7', true],
    ['PRAGMA user_version', false],
    ['SELECT * FROM pragma_user_version', false],
    ['PRAGMA application_id', false],
    ['PRAGMA temp.user_version = 1', false],
    ['PRAGMA foreign_keys = ON', false],
    ['PRAGMA cache_size = -4000', false],
    ['EXPLAIN CREATE TABLE u (id TEXT PRIMARY KEY NOT NULL)', true],
  ]
  for (const [sql, changes] of cases) {
    it(`${changes ? 'detects' : 'ignores'}: ${sql}`, () => {
      const { db, guard } = guarded(
        "CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v); INSERT INTO t VALUES ('a', 1)",
      )
      expect(guard.schemaChanged).toBe(false)
      guard.run(() => db.exec(sql))
      expect(guard.schemaChanged).toBe(changes)
    })
  }

  it('detects schema changes in trusted mode too', () => {
    const { db, guard } = guarded()
    guard.resetSchemaChanged()
    guard.trusted(() => db.exec('CREATE TABLE _kvsql_meta (k TEXT PRIMARY KEY NOT NULL, v)'))
    expect(guard.schemaChanged).toBe(true)
  })
})

describe('the schema check', () => {
  const problems = (db: Database) => checkSchema(db, { label: 'agex.db' })

  it('accepts every non-null key shape', () => {
    const db = memoryDb(`
      CREATE TABLE a (id INTEGER PRIMARY KEY, v);
      CREATE TABLE b (id TEXT PRIMARY KEY NOT NULL, v);
      CREATE TABLE c (x TEXT NOT NULL, y INTEGER NOT NULL, v, PRIMARY KEY (x, y));
      CREATE TABLE d (id TEXT PRIMARY KEY, v) WITHOUT ROWID;
      CREATE TABLE e (x TEXT, y TEXT, PRIMARY KEY (x, y)) WITHOUT ROWID;
      CREATE TABLE f (id integer primary key autoincrement, v);
      CREATE TABLE g (id INTEGER NOT NULL, v, PRIMARY KEY (id));
      CREATE TABLE h (id TEXT PRIMARY KEY NOT NULL, v ANY) STRICT;
      CREATE TABLE _kvsql_internal (anything);
    `)
    expect(problems(db)).toEqual([])
  })

  it('refuses a table without a primary key', () => {
    const db = memoryDb('CREATE TABLE notes (title TEXT, body TEXT)')
    expect(problems(db)).toEqual<SchemaViolation[]>([
      {
        table: 'notes',
        problem: 'no-primary-key',
        columns: [],
        message:
          'Tables in agex.db need a non-null PRIMARY KEY, e.g. `id TEXT PRIMARY KEY NOT NULL`; table "notes" has none.',
      },
    ])
  })

  it('refuses a key that can be NULL', () => {
    const db = memoryDb(`
      CREATE TABLE a (id TEXT PRIMARY KEY, v);
      CREATE TABLE b (x TEXT NOT NULL, y TEXT, PRIMARY KEY (x, y));
      CREATE TABLE c (id INTEGER PRIMARY KEY DESC, v);
      CREATE TABLE d (id INT PRIMARY KEY, v);
    `)
    expect(problems(db).map(({ table, problem, columns }) => [table, problem, columns])).toEqual([
      ['a', 'nullable-primary-key', ['id']],
      ['b', 'nullable-primary-key', ['y']],
      // Neither is the rowid: DESC and INT both opt out of the alias.
      ['c', 'nullable-primary-key', ['id']],
      ['d', 'nullable-primary-key', ['id']],
    ])
    expect(problems(db)[0]?.message).toBe(
      'Tables in agex.db need a non-null PRIMARY KEY, e.g. `id TEXT PRIMARY KEY NOT NULL`; in table "a" the key column "id" can be NULL: declare it NOT NULL.',
    )
  })

  it('catches the tables whose changes the session silently drops', () => {
    const db = memoryDb(`
      CREATE TABLE loose (title TEXT);
      CREATE TABLE nullable (id TEXT PRIMARY KEY, title TEXT);
    `)
    const session = startSession(sqlite3, db)
    try {
      db.exec(`INSERT INTO loose VALUES ('lost');
        INSERT INTO nullable VALUES (NULL, 'lost too'), ('k', 'kept')`)
      // Three rows written, one recorded.
      expect(
        changesetOps(sqlite3, session.changeset()).map(({ table, pk }) => [table, pk]),
      ).toEqual([['nullable', ['k']]])
    } finally {
      session.dispose()
    }
    expect(problems(db).map(({ table, problem }) => [table, problem])).toEqual([
      ['loose', 'no-primary-key'],
      ['nullable', 'nullable-primary-key'],
    ])
  })

  it('in a transaction runner: run the DDL, check, roll back on a violation', () => {
    const { db, guard } = guarded('CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT)')

    /** Run `statements` as one transaction, refusing schema the log can't record. */
    const transaction = (statements: string[]) => {
      guard.resetSchemaChanged()
      db.exec('BEGIN IMMEDIATE')
      try {
        guard.run(() => {
          for (const sql of statements) db.exec(sql)
        })
        if (guard.schemaChanged) {
          const violations = checkSchema(db, { label: 'agex.db' })
          if (violations.length > 0)
            throw new RefusedError(violations.map((v) => v.message).join('\n'))
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }

    const before = db.exec({ sql: 'SELECT sql FROM sqlite_schema', returnValue: 'resultRows' })
    expect(() =>
      transaction(["INSERT INTO notes VALUES ('a', 'kept?')", 'CREATE TABLE tags (name TEXT)']),
    ).toThrow(/table "tags" has none/)
    expect(db.exec({ sql: 'SELECT sql FROM sqlite_schema', returnValue: 'resultRows' })).toEqual(
      before,
    )
    expect(dump(db)).toEqual({ notes: [] })

    // A session recording under the guard sees the new table's rows.
    const session = startSession(sqlite3, db)
    try {
      transaction([
        'CREATE TABLE tags (name TEXT PRIMARY KEY NOT NULL)',
        "INSERT INTO tags VALUES ('x')",
      ])
      expect(
        changesetOps(sqlite3, session.changeset()).map(({ table, pk }) => [table, pk]),
      ).toEqual([['tags', ['x']]])
    } finally {
      session.dispose()
    }
    expect(dump(db)).toEqual({ notes: [], tags: [{ name: 'x' }] })
  })
})
