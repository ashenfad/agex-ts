/**
 * Filesystem errors with POSIX codes.
 *
 * Adapters throw `FsError` with a code and the standard text for it, so
 * a builtin reports `cat: /x: No such file or directory` whatever the
 * filesystem. `describeFsError` gives the same text for Node's own
 * errors (`RealFS`), which carry the same codes.
 */

/** The codes an adapter reports. */
export type FsErrorCode =
  | 'ENOENT'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'EEXIST'
  | 'ENOTEMPTY'
  | 'EINVAL'
  | 'EROFS'
  | 'EACCES'

/** The standard text for each code, as `strerror` gives it. */
export const FS_ERROR_TEXT: Readonly<Record<FsErrorCode, string>> = {
  ENOENT: 'No such file or directory',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
  EROFS: 'Read-only file system',
  EACCES: 'Permission denied',
}

export class FsError extends Error {
  override readonly name = 'FsError'
  readonly code: FsErrorCode
  /** The path the operation was given. */
  readonly path: string

  /** `message` defaults to the code's standard text. */
  constructor(code: FsErrorCode, path: string, message: string = FS_ERROR_TEXT[code]) {
    super(message)
    this.code = code
    this.path = path
  }
}

/** The error for a path whose parent `parent` is not a directory:
 *  `ENOTDIR` when the nearest ancestor that exists is a file, `ENOENT`
 *  when a directory on the way is missing. `fs` answers for absolute
 *  paths. */
export async function missingParent(
  parent: string,
  fs: { exists(path: string): Promise<boolean>; isDir(path: string): Promise<boolean> },
): Promise<FsError> {
  let path = parent
  for (;;) {
    if (await fs.exists(path)) {
      return new FsError((await fs.isDir(path)) ? 'ENOENT' : 'ENOTDIR', parent)
    }
    if (path === '/' || path === '') return new FsError('ENOENT', parent)
    const cut = path.lastIndexOf('/')
    path = cut <= 0 ? '/' : path.slice(0, cut)
  }
}

/** An error as a builtin reports it: the standard text for an error
 *  with a known code (an `FsError`, or Node's), and its message
 *  otherwise. */
export function describeFsError(e: unknown): string {
  if (e instanceof FsError) return e.message
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code in FS_ERROR_TEXT) {
    return FS_ERROR_TEXT[code as FsErrorCode]
  }
  return e instanceof Error ? e.message : String(e)
}
