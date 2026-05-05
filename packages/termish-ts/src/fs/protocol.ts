/**
 * `FileSystem` protocol for termish-ts.
 *
 * Async, structurally-typed interface that every adapter (MemoryFS,
 * RealFS, KvgitFS, host-defined) implements. We define our own
 * protocol rather than reusing `node:fs/promises` directly because:
 *
 * - An interactive shell needs **cwd state** (the `cd` command
 *   has to live somewhere), and `process.cwd()` / `process.chdir()`
 *   are global — not per-FS.
 * - `node:fs/promises` lacks ergonomic `isFile` / `isDir` /
 *   `exists` checks; you'd have to wrap `stat()` and catch errors.
 * - Backends like `MemoryFS` and `KvgitFS` don't naturally satisfy
 *   the full Node fs surface — defining a smaller interface keeps
 *   adapters straightforward.
 *
 * Naming and shape follow termish-py's `FileSystem` protocol;
 * everything's promised because storage is async.
 */

/** Per-path metadata returned by `stat()`. */
export interface FileMetadata {
  /** Size in bytes. 0 for directories. */
  readonly size: number
  /** ISO 8601 UTC timestamp when the file was created. */
  readonly createdAt: string
  /** ISO 8601 UTC timestamp when the file was last modified. */
  readonly modifiedAt: string
  /** True for directories, false for regular files. */
  readonly isDir: boolean
}

/** A single entry returned by `listDetailed()`. */
export interface FileInfo {
  /** Basename (no directory components). */
  readonly name: string
  /** Full path as resolved against the queried directory. For
   *  `listDetailed('src')`, an entry might be `'src/lib/util.ts'`. */
  readonly path: string
  readonly size: number
  readonly createdAt: string
  readonly modifiedAt: string
  readonly isDir: boolean
}

/**
 * Async filesystem interface. Used by termish builtins, the
 * interpreter, and the standalone `glob()` helper.
 *
 * Adapters do not need to implement glob — that's done as a
 * standalone helper over `list()` / `listDetailed()`.
 */
export interface FileSystem {
  /** Return the current working directory. */
  getcwd(): string
  /** Change the current working directory. May throw if the path
   *  doesn't exist or isn't a directory. */
  chdir(path: string): Promise<void>

  /** Read entire file contents as bytes. */
  read(path: string): Promise<Uint8Array>
  /** Write bytes to a file. `mode: 'w'` overwrites; `mode: 'a'` appends. */
  write(path: string, content: Uint8Array, mode?: 'w' | 'a'): Promise<void>

  exists(path: string): Promise<boolean>
  isFile(path: string): Promise<boolean>
  isDir(path: string): Promise<boolean>
  stat(path: string): Promise<FileMetadata>

  /** Create a directory. `parents: true` is `mkdir -p` semantics
   *  (create missing intermediates); `existOk: true` suppresses the
   *  error if the target already exists. */
  mkdir(path: string, opts?: { parents?: boolean; existOk?: boolean }): Promise<void>
  /** Remove a regular file. Throws if missing or a directory. */
  remove(path: string): Promise<void>
  /** Remove an empty directory. Throws if the directory has entries. */
  rmdir(path: string): Promise<void>
  /** Move or rename. */
  rename(src: string, dst: string): Promise<void>

  /** List directory entries as paths (basenames if non-recursive,
   *  full paths if recursive). */
  list(path?: string, opts?: { recursive?: boolean }): Promise<string[]>
  /** Same as `list()` but with full metadata per entry. */
  listDetailed(path?: string, opts?: { recursive?: boolean }): Promise<FileInfo[]>
}
