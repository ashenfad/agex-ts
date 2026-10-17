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

/** The suffix of a database's rollback journal, beside it in its directory. */
const JOURNAL_SUFFIX = '-journal'

/** The name of a database's rollback journal in its directory. */
export function journalName(name: string): string {
  return `${name}${JOURNAL_SUFFIX}`
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
 * A database name is one path segment, and doesn't end in the journal
 * suffix: database `x-journal` would share its file with database
 * `x`'s journal, so one would overwrite or delete the other.
 */
function checkName(name: string): void {
  if (name === '' || name.includes('/'))
    throw new Error(`bad database name: ${JSON.stringify(name)}`)
  if (name.endsWith(JOURNAL_SUFFIX)) {
    throw new Error(
      `bad database name: ${JSON.stringify(name)} ends in ${JOURNAL_SUFFIX}, the suffix of database journals`,
    )
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
   * its last commit, so call it with no transaction open. The first
   * page goes last, so a copy cut short starts with zeros, which SQLite
   * reads as no database at all. Returns the bytes copied.
   */
  copyInto(into: SyncFile): number {
    if (this.released) throw new Error(`database is closed: ${this.name}`)
    const from = this.files[0] as SyncFile
    const size = from.size()
    const chunk = new Uint8Array(Math.min(COPY_CHUNK, size))
    into.truncate(0)
    // The first page holds the header; any page is at least 512 bytes.
    const head = Math.min(512, size)
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
 * One connection per database: opening a database already open in
 * this realm fails, and in a browser so does opening one that another
 * worker or tab has open (its files' access handles are exclusive).
 */
export async function openDatabase(dir: Directory, name: string): Promise<DatabaseFile> {
  checkName(name)
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
 * Deletes the database `name` and its journal from `dir`. It must not
 * be open. The database file goes first: a journal left behind by an
 * interrupted delete is ignored by SQLite beside an empty database,
 * while a database left without its hot journal could be corrupt.
 */
export async function deleteDatabase(dir: Directory, name: string): Promise<void> {
  checkName(name)
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
  checkName(name)
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
