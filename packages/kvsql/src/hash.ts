/**
 * The content hash: a SHA-256 of what a database holds, the same for
 * two copies holding the same rows however they came by them, so a
 * device can check that its copy hasn't drifted from another's.
 *
 * It covers the schema (each table, index, view and trigger's SQL, in
 * name order), `user_version` and `application_id`, and every row of
 * every table, in primary-key order. kvsql's own tables and SQLite's
 * are left out, as the log leaves them out. Each row is its columns'
 * `quote()`, SQL literals that tell `1` from `1.0` from `x'31'`, so two
 * copies agree only on values of the same type; text goes as `T` and
 * the hex of its bytes instead, since `quote()` stops at a NUL in it.
 *
 * The text is hashed in blocks of {@link HASH_BLOCK_ROWS} lines, and
 * the hash is the SHA-256 of their hashes: a database of any size is
 * hashed without holding its text whole.
 */

import type { Database } from '@sqlite.org/sqlite-wasm'
import { isInternalTable } from './changeset'
import { sha256Hex } from './entry'

/** How many lines of the canonical text each block hashes. */
export const HASH_BLOCK_ROWS = 10_000

const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`

/**
 * The content hash of `db`'s `main` database, as lowercase hex. Each of
 * its calls on `db` runs through `run` (a schema guard's `trusted`).
 */
export async function contentHash(
  db: Database,
  run: <T>(fn: () => T) => T = (fn) => fn(),
): Promise<string> {
  const blocks: string[] = []
  let lines: string[] = []
  const line = async (text: string) => {
    lines.push(text)
    if (lines.length === HASH_BLOCK_ROWS) await endBlock()
  }
  const endBlock = async () => {
    if (lines.length === 0) return
    blocks.push(await sha256Hex(new TextEncoder().encode(`${lines.join('\n')}\n`)))
    lines = []
  }

  const header = run(() =>
    db.selectArray(
      'SELECT u.user_version, a.application_id FROM pragma_user_version u, pragma_application_id a',
    ),
  )
  await line(`header ${JSON.stringify(header)}`)
  const objects = run(() =>
    db.exec({
      sql: 'SELECT type, name, sql FROM main.sqlite_schema WHERE sql IS NOT NULL ORDER BY name, type',
      rowMode: 'array',
      returnValue: 'resultRows',
    }),
  ) as [string, string, string][]
  const tables: string[] = []
  for (const [type, name, sql] of objects) {
    if (isInternalTable(name)) continue
    await line(`${type} ${JSON.stringify(name)} ${JSON.stringify(sql)}`)
    if (type === 'table') tables.push(name)
  }
  for (const table of tables) {
    const columns = run(() =>
      db.exec({
        sql: "SELECT name, pk FROM pragma_table_info(?, 'main') ORDER BY cid",
        bind: [table],
        rowMode: 'array',
        returnValue: 'resultRows',
      }),
    ) as [string, number][]
    if (columns.length === 0) continue
    const keys = columns
      .filter(([, pk]) => pk > 0)
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => quoteName(name))
    const order = keys.length > 0 ? keys.join(', ') : 'rowid'
    const row = columns
      .map(([name]) => {
        const c = quoteName(name)
        return `CASE typeof(${c}) WHEN 'text' THEN 'T' || hex(${c}) ELSE quote(${c}) END`
      })
      .join(" || ',' || ")
    await line(`rows ${JSON.stringify(table)}`)
    // one statement per table, stepped row by row
    const stmt = run(() =>
      db.prepare(`SELECT ${row} FROM main.${quoteName(table)} ORDER BY ${order}`),
    )
    try {
      while (run(() => stmt.step())) await line(stmt.getString(0) ?? 'NULL')
    } finally {
      stmt.finalize()
    }
  }
  await endBlock()
  return sha256Hex(new TextEncoder().encode(blocks.join('\n')))
}
