/**
 * The file layer SQLite runs on: a directory of named files, each
 * opened for synchronous, exclusive use.
 *
 * SQLite's VFS calls are synchronous, so a file, once open, is read and
 * written synchronously. Opening, deleting and checking for a file may
 * be asynchronous, because in a browser they are (OPFS hands out its
 * synchronous access handles from a promise). A database therefore
 * opens every file it needs before SQLite asks for it.
 */

/**
 * One open file, owned by whoever opened it until `close()`. Offsets
 * and sizes are byte counts. Methods throw on failure; the VFS turns a
 * throw into SQLite's matching I/O error code.
 */
export interface SyncFile {
  /**
   * Reads up to `into.byteLength` bytes starting at `at` into `into`,
   * returning how many were read. Fewer than asked means the file ends
   * there; the bytes of `into` past that count are left unchanged.
   */
  read(into: Uint8Array, at: number): number
  /**
   * Writes all of `from` starting at `at`, growing the file if the
   * write ends past its end (any gap reads as zeros). Throws rather
   * than writing part of it.
   */
  write(from: Uint8Array, at: number): void
  /** Sets the file's size: cuts it short, or grows it with zeros. */
  truncate(size: number): void
  /** Makes every write and truncate so far durable. */
  sync(): void
  /** The file's size in bytes. */
  size(): number
  /** Releases the file. Any other call after this throws. */
  close(): void
}

/**
 * A flat directory of files, named by plain names (no `/`). A file can
 * be open once at a time: opening a file that is already open fails,
 * as OPFS's exclusive access handles do.
 */
export interface Directory {
  /** Opens the named file, creating it empty if it doesn't exist. */
  open(name: string): Promise<SyncFile>
  /**
   * Deletes the named file. Deleting a missing file does nothing.
   * Deleting an open one should fail; OPFS in WebKit lets it happen.
   */
  delete(name: string): Promise<void>
  /** Whether the named file exists (empty or not). */
  exists(name: string): Promise<boolean>
}
