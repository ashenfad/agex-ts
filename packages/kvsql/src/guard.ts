/**
 * The schema guard: what callers may not do to a recorded database,
 * and the primary-key rule every table must meet.
 *
 * Changes are recorded by primary key, one database file at a time, so
 * the guard refuses what would escape the record (other databases,
 * virtual tables, extensions) and the schema check refuses tables whose
 * changes would be silently lost. Each refusal says what to do instead,
 * since the caller is often an agent writing SQL.
 */

import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { INTERNAL_TABLE_PREFIX, isInternalTable } from './changeset'
import { RefusedError } from './errors'
import { check } from './wasm'

export interface GuardOptions {
  /** How messages name the database, e.g. `'agex.db'`. Defaults to `'this database'`. */
  label?: string
}

/** The authorizer installed on a connection. */
export interface SchemaGuard {
  /**
   * Run `fn`, which prepares and runs statements on the connection. If
   * it throws because the guard refused a statement, the error is a
   * {@link RefusedError} saying what to do instead, with SQLite's
   * "not authorized" error as its `cause`.
   */
  run<T>(fn: () => T): T
  /**
   * Run `fn` with nothing refused, for kvsql's own statements (its
   * internal tables, `VACUUM INTO` for snapshots). Never pass caller
   * SQL through it. Schema changes are still detected.
   */
  trusted<T>(fn: () => T): T
  /**
   * Whether a statement that changes `main`'s schema has been prepared
   * since the guard was installed or {@link resetSchemaChanged} last
   * ran: CREATE, DROP or ALTER of a table, index, view or trigger;
   * ANALYZE (which writes `sqlite_stat1`, which sessions don't record);
   * or setting `PRAGMA user_version` or `application_id`, which apps
   * use to track migrations and sessions don't record either. TEMP
   * objects don't count: they aren't in the file.
   *
   * It is set when a statement is prepared, so a runner resets it
   * before the statements of a transaction and reads it after them.
   * It says what a statement may do, not what it did: one that turns
   * out a no-op (`CREATE TABLE IF NOT EXISTS` on a table that exists,
   * `EXPLAIN CREATE ...`, a change rolled back to a savepoint) sets it
   * too. A runner that only records real changes confirms against the
   * file: its schema cookie (`PRAGMA schema_version`), `user_version`
   * and `application_id`, and {@link analyzed}.
   */
  readonly schemaChanged: boolean
  /**
   * Whether an `ANALYZE` of `main` has been prepared since the guard
   * was installed or {@link resetSchemaChanged} last ran. Statistics
   * it rewrites change no schema cookie, so a runner can't confirm
   * them against the file.
   */
  readonly analyzed: boolean
  /**
   * The first function whose result can differ from one run to the
   * next (`random()`, the date and time functions, ...; see
   * {@link NONDETERMINISTIC_FUNCTIONS}) that a statement prepared
   * outside {@link trusted} calls, directly or through a trigger, since
   * the guard was installed or {@link resetSchemaChanged} last ran;
   * undefined if none. A runner that re-executes a call's SQL on
   * another copy of the database refuses such a call. Calls that only
   * happen inside a column's DEFAULT expression aren't seen.
   */
  readonly nondeterministic: string | undefined
  /**
   * The first TEMP table or view that a statement prepared outside
   * {@link trusted} read or wrote, but that no statement created since
   * the guard was installed or {@link resetSchemaChanged} last ran;
   * undefined if none. TEMP objects belong to the connection, not the
   * file, so a runner that re-executes a call's SQL on another copy
   * refuses a call that depends on ones made earlier.
   */
  readonly tempDependency: string | undefined
  /** Clear {@link schemaChanged}, {@link analyzed}, {@link nondeterministic} and {@link tempDependency}. */
  resetSchemaChanged(): void
  /** Remove the authorizer from the connection. Safe to call twice. */
  dispose(): void
}

// Authorizer action codes (sqlite3.h); the build exports them, but a
// table keyed by number reads more plainly here.
const CREATE_INDEX = 1
const CREATE_TABLE = 2
const CREATE_TEMP_TABLE = 4
const CREATE_TEMP_TRIGGER = 5
const CREATE_TEMP_VIEW = 6
const DELETE = 9
const INSERT = 18
const READ = 20
const UPDATE = 23
const CREATE_TRIGGER = 7
const CREATE_VIEW = 8
const DROP_INDEX = 10
const DROP_TABLE = 11
const DROP_TRIGGER = 16
const DROP_VIEW = 17
const ATTACH = 24
const DETACH = 25
const ALTER_TABLE = 26
const ANALYZE = 28
const CREATE_VTABLE = 29
const DROP_VTABLE = 30
const FUNCTION = 31
const PRAGMA = 19
const TRANSACTION = 22
const SQLITE_AUTH = 23

/** Action codes that read or write a table; the database's name is in the third argument. */
const TEMP_ACCESS = new Set([READ, INSERT, UPDATE, DELETE])

/** Action codes that change a schema; the database's name is in the third argument. */
const SCHEMA_CHANGES = new Set([
  CREATE_INDEX,
  CREATE_TABLE,
  CREATE_TRIGGER,
  CREATE_VIEW,
  DROP_INDEX,
  DROP_TABLE,
  DROP_TRIGGER,
  DROP_VIEW,
  ANALYZE,
  CREATE_VTABLE,
  DROP_VTABLE,
])

/**
 * Functions whose result can differ between two runs of the same
 * statement on the same data: random values, the clock (the date and
 * time functions read it for `'now'` or no argument, and the authorizer
 * doesn't see arguments, so all of them count), and the counters of
 * the connection's earlier statements.
 */
export const NONDETERMINISTIC_FUNCTIONS: ReadonlySet<string> = new Set([
  'random',
  'randomblob',
  'current_date',
  'current_time',
  'current_timestamp',
  'date',
  'time',
  'datetime',
  'julianday',
  'unixepoch',
  'strftime',
  'timediff',
  'changes',
  'total_changes',
  'last_insert_rowid',
])

/**
 * For each action code, which of the authorizer's arguments name a
 * table, index, view or trigger (checked against the reserved prefix).
 * ANALYZE is left out: a bare `ANALYZE` visits every table, kvsql's
 * included, and only reads them.
 */
const NAME_ARGS: Record<number, readonly number[]> = {
  1: [0, 1], // CREATE_INDEX: index, table
  2: [0], // CREATE_TABLE
  3: [0, 1], // CREATE_TEMP_INDEX
  4: [0], // CREATE_TEMP_TABLE
  5: [0, 1], // CREATE_TEMP_TRIGGER: trigger, table
  6: [0], // CREATE_TEMP_VIEW
  7: [0, 1], // CREATE_TRIGGER: trigger, table
  8: [0], // CREATE_VIEW
  9: [0], // DELETE
  10: [0, 1], // DROP_INDEX: index, table
  11: [0], // DROP_TABLE
  12: [0, 1], // DROP_TEMP_INDEX
  13: [0], // DROP_TEMP_TABLE
  14: [0, 1], // DROP_TEMP_TRIGGER
  15: [0], // DROP_TEMP_VIEW
  16: [0, 1], // DROP_TRIGGER
  17: [0], // DROP_VIEW
  18: [0], // INSERT
  19: [1], // PRAGMA: name, argument
  20: [0], // READ: table, column
  23: [0], // UPDATE: table, column
  26: [1], // ALTER_TABLE: database, table
  27: [0], // REINDEX
  29: [0], // CREATE_VTABLE: table, module
  30: [0], // DROP_VTABLE
}

/** Why a statement is refused, or undefined if it's allowed. */
function refusal(code: number, args: readonly (string | 0)[], label: string): string | undefined {
  switch (code) {
    case ATTACH:
      // VACUUM attaches its output as a database: a file name for
      // `VACUUM INTO`, an empty one for plain `VACUUM`, the same as
      // `ATTACH ''`. It reaches the authorizer as nothing else.
      return args[0]
        ? `ATTACH and VACUUM INTO aren't available in ${label}: it is a single database, and its copies and snapshots are managed for you. Keep every table in it.`
        : `ATTACH and VACUUM aren't available in ${label}: it is a single database, and its file space is managed for you. Keep every table in it.`
    case DETACH:
      return `DETACH isn't available in ${label}: no other database can be attached.`
    case TRANSACTION:
      // A transaction ended by the caller would commit changes outside
      // the runner's own transaction, unrecorded. Savepoints nest
      // inside it (RELEASE and ROLLBACK TO never end a transaction
      // opened with BEGIN), so they stay available.
      return `${args[0] || 'BEGIN'} isn't available in ${label}: each call already runs as one transaction, committed if it succeeds and rolled back if it fails. To run several statements as one, pass them together to transaction([[sql, params], ...]). SAVEPOINT, RELEASE and ROLLBACK TO work inside a call.`
    case CREATE_TEMP_TRIGGER:
      // SQLite runs TEMP triggers even when triggers are switched off,
      // so one would fire again when recorded changes are replayed.
      return `TEMP triggers aren't available in ${label}: they would run again when its changes are replayed. Use an ordinary trigger (CREATE TRIGGER), which is part of the database.`
    case CREATE_VTABLE:
      return `Virtual tables (CREATE VIRTUAL TABLE ... USING ${args[1] || 'a module'}) aren't supported in ${label} yet. For text search use LIKE (or instr) on an ordinary table; for ranges use an ordinary table with an index.`
    case PRAGMA: {
      const pragma = pragmaSet(code, args)
      if (pragma !== undefined && MANAGED_PRAGMAS.has(pragma)) {
        return `Setting PRAGMA ${pragma} isn't available in ${label}: the database manages its own file (journaling, page layout) and schema. Reading the pragma is fine.`
      }
      const hint = pragma === undefined ? undefined : REPLAY_PRAGMAS.get(pragma)
      if (hint !== undefined) {
        return `Setting PRAGMA ${pragma} isn't available in ${label}: it changes what statements do on this connection only, so the same SQL would act differently after a reopen, in another tab, or where the database's changes are replayed. ${hint}`
      }
      break
    }
    case FUNCTION:
      if (typeof args[1] === 'string' && args[1].toLowerCase() === 'load_extension') {
        return `Loading extensions isn't available in ${label}: use SQLite's built-in functions.`
      }
      return undefined
  }
  for (const i of NAME_ARGS[code] ?? []) {
    const name = args[i]
    if (typeof name === 'string' && name.toLowerCase().startsWith(INTERNAL_TABLE_PREFIX)) {
      return `Names starting with ${INTERNAL_TABLE_PREFIX} are reserved for ${label}'s own records ("${name}"): use another name.`
    }
  }
  return undefined
}

/** Whether `err` is SQLite's error for a statement the authorizer denied. */
function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const rc = (err as { resultCode?: unknown }).resultCode
  return rc === SQLITE_AUTH || err.message.includes('not authorized')
}

/** Pragmas whose value lives in the file's header, outside any table. */
const HEADER_PRAGMAS = new Set(['user_version', 'application_id'])

/**
 * Pragmas that change how the file is written, or that let a caller
 * write the schema around the record; refused when they set a value.
 */
const MANAGED_PRAGMAS = new Set([
  'journal_mode',
  'locking_mode',
  'synchronous',
  'writable_schema',
  'schema_version',
  'page_size',
  'auto_vacuum',
])

/**
 * Per-connection pragmas that change what a statement does, so a
 * schema change replayed as SQL on another copy (which runs with the
 * defaults) could give a different result; refused when they set a
 * value. `recursive_triggers` lets a trigger fire itself;
 * `case_sensitive_like` changes what LIKE matches (and has no reading
 * form). Each maps to the hint its refusal ends with.
 */
const REPLAY_PRAGMAS: ReadonlyMap<string, string> = new Map([
  [
    'recursive_triggers',
    "Triggers here don't fire themselves: do a trigger's work in one firing, or walk a hierarchy with a recursive CTE. Reading the pragma is fine.",
  ],
  [
    'case_sensitive_like',
    'LIKE here ignores ASCII case: for a case-sensitive match use GLOB, or instr().',
  ],
])

/** A PRAGMA's name, lowercased, if it sets a value (`PRAGMA x = v` or `PRAGMA x(v)`). */
function pragmaSet(code: number, args: readonly (string | 0)[]): string | undefined {
  // The authorizer gets the pragma's name, its argument (null when it
  // is only read) and the schema it was qualified with (null if none).
  if (code !== PRAGMA || typeof args[0] !== 'string' || typeof args[1] !== 'string') return
  return args[0].toLowerCase()
}

function changesMainSchema(code: number, args: readonly (string | 0)[]): boolean {
  if (code === ALTER_TABLE) return args[0] === 'main'
  const pragma = pragmaSet(code, args)
  if (pragma !== undefined) {
    const schema = typeof args[2] === 'string' ? args[2].toLowerCase() : 'main'
    return HEADER_PRAGMAS.has(pragma) && schema === 'main'
  }
  return SCHEMA_CHANGES.has(code) && args[2] === 'main'
}

/**
 * Install the schema guard as `db`'s authorizer, replacing any other.
 *
 * It refuses, outside {@link SchemaGuard.trusted}:
 * - `ATTACH`, `DETACH`, `VACUUM INTO` and plain `VACUUM` (which
 *   reaches the authorizer only as the `ATTACH` of its output);
 * - `CREATE VIRTUAL TABLE` (FTS5, R*Tree, ...): its shadow tables
 *   would be recorded as ordinary tables, and replaying them is
 *   untested;
 * - `load_extension()`;
 * - `CREATE TEMP TRIGGER`: SQLite runs TEMP triggers even with
 *   triggers switched off, so one would fire again on replay;
 * - setting `journal_mode`, `locking_mode`, `synchronous`,
 *   `writable_schema`, `schema_version`, `page_size` or `auto_vacuum`
 *   (reading them is fine), in any schema: the file's journaling and
 *   layout are kvsql's to manage, and a writable schema bypasses the
 *   record;
 * - setting `recursive_triggers` or `case_sensitive_like`: they change
 *   what statements do on this connection only, so SQL replayed on
 *   another copy, under the defaults, could act differently.
 *   Per-connection pragmas that only tune performance, such as
 *   `cache_size` and `temp_store`, are left alone, and so is
 *   `foreign_keys`, which is the connection owner's choice (foreign-key
 *   conflicts are only detected when it is on, and schema changes
 *   record the setting they ran under);
 * - `BEGIN`, `COMMIT`, `END` and `ROLLBACK`: the runner owns the
 *   transaction, and one the caller ended would commit changes without
 *   their record (`SAVEPOINT`, `RELEASE` and `ROLLBACK TO` stay
 *   allowed: inside a transaction they never end it);
 * - any use of a table, index, view or trigger whose name starts with
 *   {@link INTERNAL_TABLE_PREFIX}.
 */
export function installGuard(
  sqlite3: Sqlite3Static,
  db: Database,
  options: GuardOptions = {},
): SchemaGuard {
  const { capi } = sqlite3
  const label = options.label ?? 'this database'
  let trustedDepth = 0
  let refused: string | undefined
  let schemaChanged = false
  let analyzed = false
  let nondeterministic: string | undefined
  let tempDependency: string | undefined
  const tempCreated = new Set<string>()
  let installed = true

  const rc = capi.sqlite3_set_authorizer(
    db,
    (_ctx, code, a1, a2, a3, a4) => {
      const args = [a1, a2, a3, a4]
      if (trustedDepth === 0) {
        const why = refusal(code, args, label)
        if (why !== undefined) {
          refused ??= why
          return capi.SQLITE_DENY
        }
        if (code === FUNCTION && typeof a2 === 'string') {
          const fn = a2.toLowerCase()
          if (NONDETERMINISTIC_FUNCTIONS.has(fn)) nondeterministic ??= fn
        }
        if ((code === CREATE_TEMP_TABLE || code === CREATE_TEMP_VIEW) && typeof a1 === 'string') {
          tempCreated.add(a1.toLowerCase())
        } else if (TEMP_ACCESS.has(code) && a3 === 'temp' && typeof a1 === 'string') {
          // Reading a TEMP view reports the view itself, so views are
          // caught along with tables.
          const name = a1.toLowerCase()
          if (name !== 'sqlite_temp_master' && !tempCreated.has(name)) tempDependency ??= a1
        }
      }
      if (changesMainSchema(code, args)) schemaChanged = true
      if (code === ANALYZE && a3 === 'main') analyzed = true
      return capi.SQLITE_OK
    },
    0,
  )
  check(sqlite3, rc, 'sqlite3_set_authorizer')

  return {
    run(fn) {
      const outer = refused
      refused = undefined
      try {
        return fn()
      } catch (err) {
        if (refused !== undefined && isAuthError(err)) {
          throw new RefusedError(refused, { cause: err })
        }
        throw err
      } finally {
        refused = outer
      }
    },
    trusted(fn) {
      trustedDepth++
      try {
        return fn()
      } finally {
        trustedDepth--
      }
    },
    get schemaChanged() {
      return schemaChanged
    },
    get analyzed() {
      return analyzed
    },
    get nondeterministic() {
      return nondeterministic
    },
    get tempDependency() {
      return tempDependency
    },
    resetSchemaChanged() {
      schemaChanged = false
      analyzed = false
      nondeterministic = undefined
      tempDependency = undefined
      tempCreated.clear()
    },
    dispose() {
      if (!installed) return
      installed = false
      // A null callback removes the authorizer (the typings only admit functions).
      capi.sqlite3_set_authorizer(db, 0 as never, 0)
    },
  }
}

/** A table the schema check refuses. */
export interface SchemaViolation {
  table: string
  problem: 'no-primary-key' | 'nullable-primary-key'
  /** The primary-key columns that can be NULL (for `nullable-primary-key`). */
  columns: string[]
  /** What's wrong and how to fix it, for the caller who wrote the DDL. */
  message: string
}

/**
 * Check that every user table in `main` (not `sqlite_*`, not kvsql's
 * own) has a PRIMARY KEY whose columns can't be NULL: changes are
 * recorded by key, and SQLite silently records nothing for a table
 * without one or a row whose key is NULL.
 *
 * An `INTEGER PRIMARY KEY` (an alias for the rowid) and the key of a
 * `WITHOUT ROWID` table can't be NULL. Any other key on an ordinary
 * table can, unless its columns are declared `NOT NULL`.
 *
 * Run it after a statement changed the schema, inside the same
 * transaction, and roll back if it returns anything.
 */
export function checkSchema(db: Database, options: GuardOptions = {}): SchemaViolation[] {
  const label = options.label ?? 'this database'
  const rule = `Tables in ${label} need a non-null PRIMARY KEY, e.g. \`id TEXT PRIMARY KEY NOT NULL\``
  const tables = db.exec({
    sql: "SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' ORDER BY name",
    rowMode: 'array',
    returnValue: 'resultRows',
  }) as [string, number][]

  const violations: SchemaViolation[] = []
  for (const [table, withoutRowid] of tables) {
    if (isInternalTable(table)) continue
    const keyColumns = db.exec({
      sql: 'SELECT name, "notnull" FROM pragma_table_info(?, \'main\') WHERE pk > 0 ORDER BY pk',
      bind: [table],
      rowMode: 'array',
      returnValue: 'resultRows',
    }) as [string, number][]
    if (keyColumns.length === 0) {
      violations.push({
        table,
        problem: 'no-primary-key',
        columns: [],
        message: `${rule}; table "${table}" has none.`,
      })
      continue
    }
    if (withoutRowid) continue
    // An ordinary table's key is the rowid itself (so never NULL)
    // exactly when SQLite didn't build an index for it.
    const keyIndex = db.exec({
      sql: "SELECT 1 FROM pragma_index_list(?, 'main') WHERE origin = 'pk'",
      bind: [table],
      returnValue: 'resultRows',
    })
    if (keyIndex.length === 0) continue
    const nullable = keyColumns.filter(([, notNull]) => !notNull).map(([name]) => name)
    if (nullable.length > 0) {
      const cols = nullable.map((c) => `"${c}"`).join(', ')
      violations.push({
        table,
        problem: 'nullable-primary-key',
        columns: nullable,
        message: `${rule}; in table "${table}" the key ${nullable.length > 1 ? 'columns' : 'column'} ${cols} can be NULL: declare ${nullable.length > 1 ? 'them' : 'it'} NOT NULL.`,
      })
    }
  }
  return violations
}
