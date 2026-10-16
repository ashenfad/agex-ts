/** Test helpers: in-memory databases and whole-database row dumps. */

import type { Database, SqlValue, Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { afterEach } from 'vitest'
import { loadSqlite } from '../src/index'

export const sqlite3: Sqlite3Static = await loadSqlite()

const open: Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

/** A fresh `:memory:` database, closed after the test, with `sql` run on it. */
export function memoryDb(sql = ''): Database {
  const db = new sqlite3.oo1.DB(':memory:')
  open.push(db)
  if (sql) db.exec(sql)
  return db
}

/** Every row of `table`, in a stable order. */
export function rows(db: Database, table: string): Record<string, SqlValue>[] {
  const all = db.exec({
    sql: `SELECT * FROM "${table}"`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, SqlValue>[]
  const key = (row: Record<string, SqlValue>) => JSON.stringify(Object.values(row))
  return all.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

/** Every row of every ordinary table in `main`, by table name. */
export function dump(db: Database): Record<string, Record<string, SqlValue>[]> {
  const tables = db.exec({
    sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    rowMode: 0,
    returnValue: 'resultRows',
  }) as string[]
  return Object.fromEntries(tables.map((t) => [t, rows(db, t)]))
}
