/**
 * @agex-ts/kvsql: SQLite on an OPFS file, with every change recorded
 * in a kvgit log for checkpoints and sync between devices.
 *
 * So far it loads the SQLite build the rest is built on: the official
 * `@sqlite.org/sqlite-wasm`, pinned, because it carries the session
 * extension the log is made of.
 */

import init, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm'

export type { Sqlite3Static }

let loading: Promise<Sqlite3Static> | null = null

/**
 * The SQLite build, loaded once and shared by every caller in this
 * realm (a page or a worker). A load that fails is retried by the next
 * call.
 */
export function loadSqlite(): Promise<Sqlite3Static> {
  loading ??= init().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

export * from './changeset'
export * from './errors'
export * from './guard'
export type { Directory, SyncFile } from './files'
export { type DirectoryImage, MemoryDirectory, MemoryFile } from './memory'
export {
  type CrashOp,
  type CrashPoint,
  CrashingDirectory,
  SimulatedCrash,
} from './crash'
export { OpfsDirectory, OpfsFile } from './opfs'
export { KvsqlVfs, kvsqlVfs, SECTOR_SIZE, VFS_NAME } from './vfs'
export {
  DatabaseFile,
  deleteDatabase,
  JOURNAL_MODE,
  JOURNAL_SIZE_LIMIT,
  journalName,
  openDatabase,
} from './database'
