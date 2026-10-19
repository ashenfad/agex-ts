/**
 * Opening a SQLite database on a file of a `Directory`.
 */

import type { Database } from '@sqlite.org/sqlite-wasm'
import type { Directory, SyncFile } from './files'
import { loadSqlite } from './sqlite'
import { type KvsqlVfs, kvsqlVfs } from './vfs'

/**
 * The journal mode every database runs in: a rollback journal on a
 * real file of the directory, which makes the database file crash-safe
 * by itself.
 *
 * PERSIST commits by zeroing the journal's header (a 28-byte write in
 * place, then a sync), and the journal file stays allocated for the
 * next transaction. TRUNCATE commits by cutting the journal to zero
 * bytes and syncing that, so every transaction grows the file again.
 * Both make the same number of syncs; on OPFS a one-row transaction
 * measured up to ~20% cheaper in PERSIST in Chromium, Firefox and
 * WebKit, and never clearly dearer. DELETE would have the VFS empty
 * the journal in place (removing an OPFS file is asynchronous, and
 * SQLite's delete call is not), and SQLite doesn't sync that commit
 * unless asked to.
 *
 * PERSIST alone would leave the journal at the size of the largest
 * transaction ever (after a bulk import, as large as the database), so
 * `JOURNAL_SIZE_LIMIT` caps what it keeps.
 */
export const JOURNAL_MODE = 'persist'

/**
 * The most bytes a journal keeps between transactions: after a commit
 * SQLite truncates a longer one to this. 1 MiB holds the journal of a
 * transaction touching ~120 pages, so ordinary transactions reuse the
 * file and only bulk ones pay for the truncate.
 */
export const JOURNAL_SIZE_LIMIT = 1 << 20

/**
 * The fewest free bytes a file gives back (`reclaimPages`): fewer, the
 * next writes reuse them.
 */
export const RECLAIM_MIN_BYTES = 1 << 20

/**
 * The least share of a file its free pages must be before they're
 * given back: a file whose writes keep reusing them doesn't shrink only
 * to grow again.
 */
export const RECLAIM_SHARE = 0.25

/**
 * The length of SQLite's magic string, `SQLite format 3\0`, which every
 * database file starts with: SQLite reads a file that doesn't start
 * with it as no database at all (`SQLITE_NOTADB`). So kvsql writes a
 * file whole with these bytes last, after the rest is synced: one cut
 * short, even mid-way through them, reads as no database, never as a
 * corrupt one, and is written again. Writing the whole first page last
 * wouldn't do: a write torn after its header leaves a header on a
 * zeroed page, which SQLite reads as corrupt.
 */
export const MAGIC_BYTES = 16

/** The suffix of a database's rollback journal, beside it in its directory. */
const JOURNAL_SUFFIX = '-journal'

/** The name of a database's rollback journal in its directory. */
export function journalName(name: string): string {
  return `${name}${JOURNAL_SUFFIX}`
}

/** The suffix of the snapshot a database makes beside it for a new epoch. */
const SNAPSHOT_SUFFIX = '-snapshot'

/** The name of database `name`'s snapshot file, beside it in its directory. */
export function snapshotName(name: string): string {
  return `${name}${SNAPSHOT_SUFFIX}`
}

/** The suffix of the database a restore rebuilds beside a database, at a checkpoint. */
const RESTORE_SUFFIX = '-restore'

/** The name of database `name`'s restore file, beside it in its directory. */
export function restoreName(name: string): string {
  return `${name}${RESTORE_SUFFIX}`
}

/** The suffix of the database a rebase onto a new epoch builds beside a database. */
const REBASE_SUFFIX = '-rebase'

/** The name of database `name`'s rebase file, beside it in its directory. */
export function rebaseName(name: string): string {
  return `${name}${REBASE_SUFFIX}`
}

const directoryIds = new WeakMap<Directory, number>()
let nextDirectoryId = 0

/** The path SQLite knows a directory's database by: unique per directory object and name. */
function vfsPath(dir: Directory, name: string): string {
  let id = directoryIds.get(dir)
  if (id === undefined) {
    id = nextDirectoryId++
    directoryIds.set(dir, id)
  }
  return `/${id}/${name}`
}

/**
 * A database name is one path segment, and doesn't end in the suffix
 * of a file kvsql keeps beside a database: database `x-journal` would
 * share its file with database `x`'s journal, `x-snapshot` with the
 * snapshot `x` makes for a new epoch, `x-restore` with the copy a
 * restore of `x` rebuilds, and `x-rebase` with the copy a rebase of `x`
 * onto a new epoch builds, so one would overwrite or delete the other.
 */
export function checkDatabaseName(name: string): void {
  if (name === '' || name.includes('/'))
    throw new Error(`bad database name: ${JSON.stringify(name)}`)
  for (const [suffix, what] of [
    [JOURNAL_SUFFIX, 'database journals'],
    [SNAPSHOT_SUFFIX, 'the snapshots databases make for new epochs'],
    [RESTORE_SUFFIX, 'the databases restores rebuild'],
    [REBASE_SUFFIX, 'the databases rebases build'],
  ] as const) {
    if (name.endsWith(suffix)) {
      throw new Error(
        `bad database name: ${JSON.stringify(name)} ends in ${suffix}, the suffix of ${what}`,
      )
    }
  }
}

/**
 * An open database: a SQLite connection (`db`) on the file `name` of a
 * directory, with its journal beside it as `<name>-journal`.
 *
 * Close it with `close()` (closing `db` directly does the same), which
 * closes the connection, then releases both files. Finalize statements
 * prepared outside `db`'s own API before closing: SQLite keeps a
 * connection with live statements open, and its files would be
 * released under it.
 */
export class DatabaseFile {
  private released = false

  /** @internal Use `openDatabase`. */
  constructor(
    readonly db: Database,
    readonly directory: Directory,
    readonly name: string,
    private readonly vfs: KvsqlVfs,
    private readonly path: string,
    private readonly files: readonly SyncFile[],
  ) {
    db.onclose = { after: () => this.release() }
  }

  /** Whether the database has been closed. */
  get closed(): boolean {
    return this.released
  }

  /**
   * Writes the database file's bytes into `into`, a file of another
   * database, replacing what it held, and syncs it: the database as of
   * its last commit, so call it with no transaction open. The magic
   * string goes last ({@link MAGIC_BYTES}), so a copy cut short reads as
   * no database at all. Returns the bytes copied.
   */
  copyInto(into: SyncFile): number {
    if (this.released) throw new Error(`database is closed: ${this.name}`)
    const from = this.files[0] as SyncFile
    const size = from.size()
    const chunk = new Uint8Array(Math.min(COPY_CHUNK, size))
    into.truncate(0)
    const head = Math.min(MAGIC_BYTES, size)
    for (let at = head; at < size; at += chunk.byteLength) {
      const part = chunk.subarray(0, Math.min(chunk.byteLength, size - at))
      readFully(from, part, at)
      into.write(part, at)
    }
    into.sync()
    const first = new Uint8Array(head)
    readFully(from, first, 0)
    into.write(first, 0)
    into.sync()
    return size
  }

  /** Closes the connection and releases its files. Closing twice does nothing. */
  close(): void {
    if (this.db.pointer !== undefined) this.db.close()
    this.release()
  }

  private release(): void {
    if (this.released) return
    this.released = true
    releaseFiles(this.vfs, this.path, this.files)
  }
}

/** How many bytes `copyInto` reads and writes at a time. */
const COPY_CHUNK = 1 << 20

function readFully(file: SyncFile, into: Uint8Array, at: number): void {
  if (file.read(into, at) !== into.byteLength) {
    throw new Error('the database file ended while it was being copied')
  }
}

function releaseFiles(vfs: KvsqlVfs, path: string, files: readonly SyncFile[]): void {
  for (const p of [path, journalName(path)]) {
    if (vfs.isOpen(p)) continue
    vfs.unregister(p)
  }
  let first: unknown = null
  for (const file of files) {
    try {
      file.close()
    } catch (err) {
      first ??= err
    }
  }
  if (first !== null) throw first
}

/**
 * Opens (creating if needed) the database `name` in `dir`.
 *
 * SQLite opens files synchronously, while a directory opens them
 * asynchronously (OPFS hands out its access handles from a promise).
 * So this opens the two files a database in rollback-journal mode can
 * need, the database file and its journal, before SQLite starts, and
 * registers them with the VFS under the paths SQLite will ask for. The
 * journal is opened even when empty, so a transaction never waits on
 * it; a hot journal left by a crash is rolled back by SQLite on first
 * access.
 *
 * A new file is in incremental auto-vacuum mode, so the pages a large
 * delete frees can be given back (`reclaimPages`); an existing one keeps
 * its mode, and a copy `VACUUM INTO` makes of one without it (NONE) is
 * in incremental mode.
 *
 * One connection per database: opening a database already open in
 * this realm fails, and in a browser so does opening one that another
 * worker or tab has open (its files' access handles are exclusive).
 */
export async function openDatabase(dir: Directory, name: string): Promise<DatabaseFile> {
  checkDatabaseName(name)
  return openDatabaseFile(dir, name)
}

/**
 * {@link openDatabase} without checking the name: for kvsql's own
 * files beside a database, and names checked already.
 */
export async function openDatabaseFile(dir: Directory, name: string): Promise<DatabaseFile> {
  const sqlite3 = await loadSqlite()
  const vfs = kvsqlVfs(sqlite3)
  const path = vfsPath(dir, name)
  if (vfs.has(path)) throw new Error(`database is already open: ${name}`)

  const files: SyncFile[] = []
  const registered: string[] = []
  let db: Database | undefined
  try {
    files.push(await dir.open(name))
    files.push(await dir.open(journalName(name)))
    if (vfs.has(path)) throw new Error(`database is already open: ${name}`)
    for (const [p, file] of [
      [path, files[0]],
      [journalName(path), files[1]],
    ] as const) {
      vfs.register(p, file as SyncFile)
      registered.push(p)
    }
    db = new sqlite3.oo1.DB({ filename: path, flags: 'c', vfs: vfs.name })
    db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT}`)
    const mode = db.selectValue(`PRAGMA journal_mode=${JOURNAL_MODE}`)
    if (mode !== JOURNAL_MODE)
      throw new Error(`journal mode is ${String(mode)}, not ${JOURNAL_MODE}`)
    // takes on a file with no tables yet, and for a `VACUUM INTO`; only
    // from NONE: on a file in FULL or INCREMENTAL it would rewrite the
    // header, and turn FULL's truncation at each commit off
    if (db.selectValue('PRAGMA auto_vacuum') === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    return new DatabaseFile(db, dir, name, vfs, path, files)
  } catch (err) {
    vfs.takeError()
    try {
      db?.close()
    } catch {}
    for (const p of registered) if (!vfs.isOpen(p)) vfs.unregister(p)
    for (const file of files) {
      try {
        file.close()
      } catch {}
    }
    throw err
  }
}

/**
 * Give `db`'s free pages back to the file system, shrinking its file,
 * once they are at least {@link RECLAIM_MIN_BYTES} and
 * {@link RECLAIM_SHARE} of it, in a file in incremental auto-vacuum
 * mode; returns how many went. Outside a transaction: it runs one of its
 * own. Each of its calls on `db` runs through `run` (a schema guard's
 * `trusted`).
 */
export function reclaimPages(db: Database, run: <T>(fn: () => T) => T = (fn) => fn()): number {
  return run(() => {
    if (db.selectValue('PRAGMA auto_vacuum') !== 2) return 0
    const free = Number(db.selectValue('PRAGMA freelist_count'))
    const pages = Number(db.selectValue('PRAGMA page_count'))
    const size = Number(db.selectValue('PRAGMA page_size'))
    if (free * size < RECLAIM_MIN_BYTES || free < pages * RECLAIM_SHARE) return 0
    // a page a step
    const step = db.prepare('PRAGMA incremental_vacuum')
    try {
      while (step.step()) {
        // freeing
      }
    } finally {
      step.finalize()
    }
    return free - Number(db.selectValue('PRAGMA freelist_count'))
  })
}

/**
 * Deletes the database `name` and its journal from `dir`. It must not
 * be open. The database file goes first: a journal left behind by an
 * interrupted delete is ignored by SQLite beside an empty database,
 * while a database left without its hot journal could be corrupt.
 */
export async function deleteDatabase(dir: Directory, name: string): Promise<void> {
  checkDatabaseName(name)
  await deleteDatabaseFiles(dir, name)
}

/** {@link deleteDatabase} without checking the name, as {@link openDatabaseFile}. */
export async function deleteDatabaseFiles(dir: Directory, name: string): Promise<void> {
  const vfs = kvsqlVfs(await loadSqlite())
  if (vfs.has(vfsPath(dir, name))) throw new Error(`database is open: ${name}`)
  await dir.delete(name)
  await dir.delete(journalName(name))
}

/**
 * Copies the open database `source` to the database `name` in `dir`,
 * replacing any there, which must not be open: `source` as of its last
 * commit, so with no transaction open. Returns the copy's size in
 * bytes.
 */
export async function copyDatabase(
  source: DatabaseFile,
  dir: Directory,
  name: string,
): Promise<number> {
  checkDatabaseName(name)
  // The old journal goes too: one left hot beside the copy would be
  // rolled back into it.
  await deleteDatabase(dir, name)
  const into = await dir.open(name)
  try {
    return source.copyInto(into)
  } finally {
    into.close()
  }
}

/**
 * Writes a compacted copy of the open database `source` (`VACUUM
 * INTO`) to the database `name` in `dir`, replacing any there, which
 * must not be open: `source` as of its last commit, so with no
 * transaction open, without its free pages. `exec` runs the statement
 * on `source`'s connection (one with an authorizer passes its own).
 * Returns the copy's size in bytes.
 */
export async function vacuumDatabase(
  source: DatabaseFile,
  dir: Directory,
  name: string,
  exec: (sql: string) => void = (sql) => source.db.exec(sql),
): Promise<number> {
  checkDatabaseName(name)
  return vacuumInto(source, dir, name, exec)
}

/** {@link vacuumDatabase} without checking the name, as {@link openDatabaseFile}. */
export async function vacuumInto(
  source: DatabaseFile,
  dir: Directory,
  name: string,
  exec: (sql: string) => void,
): Promise<number> {
  const vfs = kvsqlVfs(await loadSqlite())
  await deleteDatabaseFiles(dir, name)
  const path = vfsPath(dir, name)
  const files: SyncFile[] = []
  const registered: string[] = []
  try {
    files.push(await dir.open(name))
    // SQLite writes a VACUUM INTO target without a journal; one is
    // registered anyway, so nothing it opens lands outside `dir`.
    files.push(await dir.open(journalName(name)))
    for (const [p, file] of [
      [path, files[0]],
      [journalName(path), files[1]],
    ] as const) {
      vfs.register(p, file as SyncFile)
      registered.push(p)
    }
    // the path's segments URI-encoded (SQLite decodes them), then
    // quoted as a SQL string
    const uri = `file:${path.split('/').map(encodeURIComponent).join('/')}?vfs=${encodeURIComponent(vfs.name)}`
    exec(`VACUUM INTO '${uri.replaceAll("'", "''")}'`)
    const copy = files[0] as SyncFile
    copy.sync()
    return copy.size()
  } catch (err) {
    vfs.takeError()
    throw err
  } finally {
    for (const p of registered) if (!vfs.isOpen(p)) vfs.unregister(p)
    for (const file of files) {
      try {
        file.close()
      } catch {}
    }
  }
}
