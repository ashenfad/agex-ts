/**
 * @agex-ts/kvsql: SQLite on an OPFS file, with every change recorded
 * in a kvgit log for checkpoints and sync between devices.
 *
 * The database is a file in a `Directory` (OPFS in a browser worker,
 * or in memory), opened through kvsql's own SQLite VFS. Its changes are
 * recorded as changesets with SQLite's session extension, behind a
 * schema guard that refuses what the record would silently miss, and
 * flushed in batches to a log on a kvgit branch (`openLog`).
 *
 * In a browser the database runs in a dedicated worker: `serve` (or
 * the default worker, `@agex-ts/kvsql/worker`) serves it to the page's
 * clients (`@agex-ts/kvsql/client`), with one writer across tabs.
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
export {
  type FlushPolicy,
  type FlushResult,
  LoggedDatabase,
  type LogOptions,
  openLog,
  type QueryResult,
  type Recovery,
  REPLAY_CHUNK_BYTES,
  REPLAY_CHUNK_TRANSACTIONS,
} from './log'
export {
  ENTRY_FORMAT,
  ENTRY_KEY,
  type EntryInfo,
  MERGE_RATIO,
  type Params,
  type Statement,
} from './entry'
export {
  type Channel,
  type DatabaseStorage,
  type Locks,
  type MessageScope,
  type Opener,
  type Server,
  type ServeOptions,
  serve,
} from './host'
export { type DefaultConfig, openDefault } from './default'
export {
  type DatabaseConfig,
  type DatabaseInfo,
  DEFAULT_NAME,
  type DeleteOptions,
  lockName,
  type Role,
  type SerializedError,
  type Status,
  reviveError,
  serializeError,
} from './protocol'
