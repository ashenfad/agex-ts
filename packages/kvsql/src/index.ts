/**
 * @agex-ts/kvsql: SQLite on an OPFS file, with every change recorded
 * in a kvgit log for checkpoints and sync between devices.
 *
 * The database is a file in a `Directory` (OPFS in a browser worker,
 * or in memory), opened through kvsql's own SQLite VFS. Its changes are
 * recorded as changesets with SQLite's session extension, behind a
 * schema guard that refuses what the record would silently miss.
 */

export { loadSqlite, type Sqlite3Static } from './sqlite'
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
