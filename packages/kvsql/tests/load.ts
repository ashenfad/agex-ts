/**
 * Checks shared by the Node and browser runs: the pinned build loads,
 * runs SQL, and carries the session extension the log depends on.
 */

import { expect } from 'vitest'
import { loadSqlite } from '../src/index'

/** The session-extension entry points the log is built from. */
export const SESSION_EXPORTS = [
  'sqlite3session_create',
  'sqlite3session_attach',
  'sqlite3session_changeset',
  'sqlite3session_delete',
  'sqlite3changeset_invert',
  'sqlite3changeset_apply_v2',
  'sqlite3changegroup_new',
  'sqlite3changegroup_add',
  'sqlite3changegroup_output',
  'sqlite3changegroup_delete',
] as const

export async function checkLoads(): Promise<void> {
  const sqlite3 = await loadSqlite()
  expect(sqlite3.version.libVersion).toBe('3.53.4')
  expect(await loadSqlite()).toBe(sqlite3)

  const db = new sqlite3.oo1.DB(':memory:')
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, n INTEGER)')
    db.exec({ sql: 'INSERT INTO t VALUES (?, ?), (?, ?)', bind: ['a', 1, 'b', 2] })
    const rows = db.exec({
      sql: 'SELECT id, n FROM t ORDER BY id',
      rowMode: 'object',
      returnValue: 'resultRows',
    })
    expect(rows).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ])
  } finally {
    db.close()
  }

  const capi = sqlite3.capi as unknown as Record<string, unknown>
  for (const name of SESSION_EXPORTS) expect(typeof capi[name], name).toBe('function')
}
