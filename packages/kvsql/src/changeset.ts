/**
 * Changesets: what a run of statements changed, as SQLite's session
 * extension records it, and the operations on them the log is made of.
 *
 * A changeset records rows by primary key: the whole row for an insert
 * or a delete, the key plus the changed columns (old and new values)
 * for an update. It records nothing for a table without a primary key,
 * for a row whose key is NULL, or for schema changes, so the schema
 * guard refuses tables like that and DDL is logged separately.
 *
 * Changesets are plain `Uint8Array`s: copies out of wasm memory, safe
 * to keep, store or send.
 */

import type { Database, SqlValue, Sqlite3Static, WasmPointer } from '@sqlite.org/sqlite-wasm'
import { KvsqlError, SqliteError } from './errors'
import { check, outBytes, outHandle, outInt, withBytes } from './wasm'

/**
 * Tables whose names start with this prefix (in any case) belong to
 * kvsql itself: sessions don't record them and the schema guard keeps
 * callers out of them. Tables named `sqlite_*` are SQLite's own and are
 * treated the same way.
 */
export const INTERNAL_TABLE_PREFIX = '_kvsql_'

/** Whether `name` is kvsql's own table or SQLite's, which sessions skip. */
export function isInternalTable(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith(INTERNAL_TABLE_PREFIX) || lower.startsWith('sqlite_')
}

/**
 * Constants the C library has but this build's JS doesn't export:
 * `SQLITE_CHANGESETAPPLY_FKNOACTION` (since 3.45) treats foreign-key
 * actions such as `ON DELETE CASCADE` as `NO ACTION` while a changeset
 * applies.
 */
const SQLITE_CHANGESETAPPLY_FKNOACTION = 8

/** An open session: records every change to the user tables of `main`. */
export interface Session {
  /**
   * Everything recorded since the session started, net: a row inserted
   * and then deleted appears in neither form. Empty if nothing changed.
   */
  changeset(): Uint8Array
  /** Whether nothing has been recorded yet. */
  readonly isEmpty: boolean
  /** Release the session. Safe to call twice; call it before closing `db`. */
  dispose(): void
}

/**
 * Start recording changes to `db`'s `main` database: every table,
 * including ones created later, except {@link isInternalTable internal}
 * ones.
 */
export function startSession(sqlite3: Sqlite3Static, db: Database): Session {
  const { capi } = sqlite3
  const pS = outHandle(sqlite3, 'sqlite3session_create', (pp) =>
    capi.sqlite3session_create(db, 'main', pp),
  )
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    // Also releases the table filter's wasm binding.
    capi.sqlite3session_delete(pS)
  }
  try {
    capi.sqlite3session_table_filter(pS, (_ctx, table) => (isInternalTable(table) ? 0 : 1), 0)
    check(sqlite3, capi.sqlite3session_attach(pS, null), 'sqlite3session_attach')
  } catch (err) {
    dispose()
    throw err
  }
  const live = () => {
    if (disposed) throw new KvsqlError('the session was disposed')
  }
  return {
    changeset() {
      live()
      return outBytes(sqlite3, 'sqlite3session_changeset', (pn, pp) =>
        capi.sqlite3session_changeset(pS, pn, pp),
      )
    },
    get isEmpty() {
      live()
      return capi.sqlite3session_isempty(pS) !== 0
    },
    dispose,
  }
}

/** The changeset that undoes `changeset`. */
export function invertChangeset(sqlite3: Sqlite3Static, changeset: Uint8Array): Uint8Array {
  if (changeset.byteLength === 0) return new Uint8Array(0)
  return withBytes(sqlite3, changeset, (p) =>
    outBytes(sqlite3, 'sqlite3changeset_invert', (pn, pp) =>
      sqlite3.capi.sqlite3changeset_invert(changeset.byteLength, p, pn, pp),
    ),
  )
}

/**
 * Combine changesets, oldest first, into one with the same net effect
 * (`sqlite3changegroup`): an insert then an update becomes one insert,
 * an insert then a delete disappears.
 */
export function combineChangesets(
  sqlite3: Sqlite3Static,
  changesets: Iterable<Uint8Array>,
): Uint8Array {
  const { capi } = sqlite3
  const pG = outHandle(sqlite3, 'sqlite3changegroup_new', (pp) => capi.sqlite3changegroup_new(pp))
  try {
    for (const cs of changesets) {
      if (cs.byteLength === 0) continue
      withBytes(sqlite3, cs, (p) =>
        check(sqlite3, capi.sqlite3changegroup_add(pG, cs.byteLength, p), 'sqlite3changegroup_add'),
      )
    }
    return outBytes(sqlite3, 'sqlite3changegroup_output', (pn, pp) =>
      capi.sqlite3changegroup_output(pG, pn, pp),
    )
  } finally {
    capi.sqlite3changegroup_delete(pG)
  }
}

/** The kind of change a changeset records for one row. */
export type ChangeOp = 'INSERT' | 'UPDATE' | 'DELETE'

/** One row's change in a changeset. */
export interface ChangesetOp {
  table: string
  op: ChangeOp
  /**
   * How many columns the table had when the change was recorded. A
   * changeset whose count differs from the table's current one is
   * skipped by SQLite without an error, so callers compare it first.
   */
  columns: number
  /** Whether the change was made indirectly (by a trigger or FK action). */
  indirect: boolean
  /** The row's primary-key values, in column order. */
  pk: SqlValue[]
  /**
   * The row's values before the change, by column (absent for an
   * insert). An update records only the key and the columns it
   * changed; the rest are `undefined`.
   */
  before?: (SqlValue | undefined)[]
  /**
   * The row's values after the change, by column (absent for a
   * delete). An update records only the columns it changed; the rest,
   * the key included, are `undefined`.
   */
  after?: (SqlValue | undefined)[]
}

/** Every change in `changeset`, in order. Decodes the whole changeset. */
export function changesetOps(sqlite3: Sqlite3Static, changeset: Uint8Array): ChangesetOp[] {
  if (changeset.byteLength === 0) return []
  const { capi } = sqlite3
  return withBytes(sqlite3, changeset, (p) => {
    const pIter = outHandle(sqlite3, 'sqlite3changeset_start', (pp) =>
      capi.sqlite3changeset_start(pp, changeset.byteLength, p),
    )
    const ops: ChangesetOp[] = []
    let failed = false
    try {
      for (;;) {
        const rc = capi.sqlite3changeset_next(pIter)
        if (rc === capi.SQLITE_DONE) break
        if (rc !== capi.SQLITE_ROW) {
          failed = true
          check(sqlite3, rc, 'sqlite3changeset_next')
        }
        ops.push(describeChange(sqlite3, pIter))
      }
    } finally {
      const rc = capi.sqlite3changeset_finalize(pIter)
      if (!failed) check(sqlite3, rc, 'sqlite3changeset_finalize')
    }
    return ops
  })
}

const OPS: Record<number, ChangeOp> = { 18: 'INSERT', 23: 'UPDATE', 9: 'DELETE' }

/** The change a changeset iterator is at (also valid inside a conflict handler). */
function describeChange(sqlite3: Sqlite3Static, pIter: WasmPointer): ChangesetOp {
  const { capi, wasm } = sqlite3
  const sp = wasm.pstack.pointer
  try {
    const pzTab = wasm.pstack.allocPtr()
    const pnCol = wasm.pstack.alloc(4)
    const pOp = wasm.pstack.alloc(4)
    const pInd = wasm.pstack.alloc(4)
    check(sqlite3, capi.sqlite3changeset_op(pIter, pzTab, pnCol, pOp, pInd), 'sqlite3changeset_op')
    const table = wasm.cstrToJs(Number(wasm.peekPtr(pzTab))) ?? ''
    const opCode = wasm.peek32(pOp)
    const op = OPS[opCode]
    if (!op) throw new KvsqlError(`unknown changeset op ${opCode}`)
    const columns = wasm.peek32(pnCol)
    const indirect = wasm.peek32(pInd) !== 0

    const ppPk = wasm.pstack.allocPtr()
    check(sqlite3, capi.sqlite3changeset_pk(pIter, ppPk, 0), 'sqlite3changeset_pk')
    const abPK = Number(wasm.peekPtr(ppPk))
    const values = (read: (pIter: WasmPointer, i: number) => SqlValue | undefined) =>
      Array.from({ length: columns }, (_, i) => read(pIter, i))
    const before = op === 'INSERT' ? undefined : values(capi.sqlite3changeset_old_js)
    const after = op === 'DELETE' ? undefined : values(capi.sqlite3changeset_new_js)
    const keyed = before ?? after ?? []
    const pk: SqlValue[] = []
    for (let i = 0; i < columns; i++) {
      if (wasm.peek8(abPK + i) !== 0) pk.push(keyed[i] ?? null)
    }
    const change: ChangesetOp = { table, op, columns, indirect, pk }
    if (before) change.before = before
    if (after) change.after = after
    return change
  } finally {
    wasm.pstack.restore(sp)
  }
}

/** The ways applying a change can conflict with the database. */
export type ConflictKind = 'DATA' | 'NOTFOUND' | 'CONFLICT' | 'CONSTRAINT' | 'FOREIGN_KEY'

/**
 * What to do about each kind of conflict while applying a changeset:
 *
 * - `DATA`: the row to update or delete exists but its current values
 *   aren't the changeset's "before" values. `omit` keeps the database's
 *   row, `replace` writes the changeset's.
 * - `NOTFOUND`: the row to update or delete is gone. `omit` skips the
 *   change. (`replace` is a misuse here, so it isn't offered.)
 * - `CONFLICT`: an inserted row's key already exists. `omit` keeps the
 *   database's row, `replace` overwrites it.
 * - `CONSTRAINT`: a change breaks a UNIQUE, CHECK or NOT NULL
 *   constraint. `omit` drops the change. (`replace` is a misuse.)
 * - `FOREIGN_KEY`: the result breaks foreign keys (only checked when
 *   `PRAGMA foreign_keys` is on). Only `abort`: omitting would commit
 *   the violation.
 *
 * `abort` stops and rolls the whole changeset back.
 */
export interface ConflictPolicy {
  DATA: 'abort' | 'omit' | 'replace'
  NOTFOUND: 'abort' | 'omit'
  CONFLICT: 'abort' | 'omit' | 'replace'
  CONSTRAINT: 'abort' | 'omit'
  FOREIGN_KEY: 'abort'
}

/** Stop at any conflict, leaving the database as it was. The default. */
export const ABORT_ON_CONFLICT: Readonly<ConflictPolicy> = Object.freeze({
  DATA: 'abort',
  NOTFOUND: 'abort',
  CONFLICT: 'abort',
  CONSTRAINT: 'abort',
  FOREIGN_KEY: 'abort',
})

/**
 * The changeset being applied wins where it can: its values overwrite
 * the database's (`DATA`, `CONFLICT`), changes to rows the database
 * deleted are dropped (`NOTFOUND`), and anything that would break a
 * constraint or foreign key still aborts.
 */
export const THIS_SIDE_WINS: Readonly<ConflictPolicy> = Object.freeze({
  DATA: 'replace',
  NOTFOUND: 'omit',
  CONFLICT: 'replace',
  CONSTRAINT: 'abort',
  FOREIGN_KEY: 'abort',
})

const ALLOWED: { [K in ConflictKind]: readonly ConflictPolicy[K][] } = {
  DATA: ['abort', 'omit', 'replace'],
  NOTFOUND: ['abort', 'omit'],
  CONFLICT: ['abort', 'omit', 'replace'],
  CONSTRAINT: ['abort', 'omit'],
  FOREIGN_KEY: ['abort'],
}

const KINDS: Record<number, ConflictKind> = {
  1: 'DATA',
  2: 'NOTFOUND',
  3: 'CONFLICT',
  4: 'CONSTRAINT',
  5: 'FOREIGN_KEY',
}

/** A conflict met while applying a changeset, and what was done about it. */
export type Conflict =
  | ({
      kind: Exclude<ConflictKind, 'FOREIGN_KEY'>
      action: 'abort' | 'omit' | 'replace'
    } & ChangesetOp)
  | {
      kind: 'FOREIGN_KEY'
      action: 'abort'
      /** How many foreign-key constraints the result would break. */
      count: number
    }

export interface ApplyOptions {
  /** What to do about conflicts. Defaults to {@link ABORT_ON_CONFLICT}. */
  policy?: Readonly<ConflictPolicy>
  /** Apply the changeset's inverse instead of the changeset. */
  invert?: boolean
}

export interface ApplyResult {
  /** False if a conflict aborted the apply; the database is then unchanged. */
  applied: boolean
  /** Every conflict met, in order, with the action taken. */
  conflicts: Conflict[]
}

/**
 * Apply `changeset` to `db`'s `main` database, in a savepoint: either
 * every change lands (some perhaps omitted or replaced by the policy)
 * or none does.
 *
 * Triggers are off while it applies, since a changeset already holds
 * what they wrote when it was recorded; their previous setting is
 * restored afterwards, even on error. Foreign-key actions are off too
 * (`ON DELETE CASCADE` behaves as `NO ACTION`), since the rows they
 * touched are in the changeset; foreign keys are still checked if
 * `PRAGMA foreign_keys` is on.
 *
 * A conflict the policy aborts on returns `applied: false`; other
 * failures throw.
 */
export function applyChangeset(
  sqlite3: Sqlite3Static,
  db: Database,
  changeset: Uint8Array,
  options: ApplyOptions = {},
): ApplyResult {
  const policy = options.policy ?? ABORT_ON_CONFLICT
  for (const kind of Object.keys(ALLOWED) as ConflictKind[]) {
    const action = policy[kind]
    if (!(ALLOWED[kind] as readonly string[]).includes(action)) {
      throw new TypeError(`conflict policy: '${action}' isn't allowed for ${kind}`)
    }
  }
  const conflicts: Conflict[] = []
  if (changeset.byteLength === 0) return { applied: true, conflicts }

  const { capi } = sqlite3
  const ACTIONS = {
    omit: capi.SQLITE_CHANGESET_OMIT,
    replace: capi.SQLITE_CHANGESET_REPLACE,
    abort: capi.SQLITE_CHANGESET_ABORT,
  } as const
  let handlerError: unknown
  let aborted = false
  const xConflict = (_ctx: WasmPointer, eConflict: number, pIter: WasmPointer) => {
    // An exception must not unwind through SQLite's C frames: record it,
    // abort, and rethrow once the apply has returned.
    try {
      const kind = KINDS[eConflict]
      if (!kind) throw new KvsqlError(`unknown conflict type ${eConflict}`)
      if (kind === 'FOREIGN_KEY') {
        const [rc, count] = outInt(sqlite3, (p) => capi.sqlite3changeset_fk_conflicts(pIter, p))
        check(sqlite3, rc, 'sqlite3changeset_fk_conflicts')
        conflicts.push({ kind, action: 'abort', count })
        aborted = true
        return ACTIONS.abort
      }
      const action = policy[kind]
      conflicts.push({ kind, action, ...describeChange(sqlite3, pIter) })
      if (action === 'abort') aborted = true
      return ACTIONS[action]
    } catch (err) {
      handlerError ??= err
      aborted = true
      return ACTIONS.abort
    }
  }

  let flags = SQLITE_CHANGESETAPPLY_FKNOACTION
  if (options.invert) flags |= capi.SQLITE_CHANGESETAPPLY_INVERT

  const rc = withTriggersOff(sqlite3, db, () =>
    withBytes(sqlite3, changeset, (p) =>
      capi.sqlite3changeset_apply_v2(
        db,
        changeset.byteLength,
        p,
        0,
        xConflict as Parameters<typeof capi.sqlite3changeset_apply_v2>[4],
        0,
        0,
        0,
        flags,
      ),
    ),
  )
  if (handlerError !== undefined) throw handlerError
  // An aborted conflict ends the apply with SQLITE_ABORT, or with
  // SQLITE_CONSTRAINT for a foreign-key conflict; either way the
  // savepoint was rolled back.
  if (aborted && rc !== 0) return { applied: false, conflicts }
  if (rc !== 0) {
    throw new SqliteError(
      'sqlite3changeset_apply_v2',
      rc,
      capi.sqlite3_js_rc_str(rc) ?? '',
      capi.sqlite3_errmsg(db),
    )
  }
  return { applied: true, conflicts }
}

/** Run `fn` with `db`'s triggers off, restoring their previous setting after. */
function withTriggersOff<T>(sqlite3: Sqlite3Static, db: Database, fn: () => T): T {
  const { capi } = sqlite3
  const op = capi.SQLITE_DBCONFIG_ENABLE_TRIGGER
  const [rc, was] = outInt(sqlite3, (p) => capi.sqlite3_db_config(db, op, -1, p))
  check(sqlite3, rc, 'sqlite3_db_config(ENABLE_TRIGGER)')
  check(sqlite3, capi.sqlite3_db_config(db, op, 0, 0), 'sqlite3_db_config(ENABLE_TRIGGER)')
  try {
    return fn()
  } finally {
    capi.sqlite3_db_config(db, op, was, 0)
  }
}
