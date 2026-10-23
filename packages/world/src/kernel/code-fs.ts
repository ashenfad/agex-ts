/**
 * The host side of code's `fs`: a call on the workspace's filesystem,
 * with what code expects of a file API on top of termish's
 * `FileSystem`.
 *
 * - `write` creates the directories the file needs, as `file_write`
 *   does.
 * - `mkdir` takes Node's `{ recursive: true }` (missing parents made, an
 *   existing directory fine) besides `parents` and `existOk`.
 * - `mkdir`, `list` and `listDetailed` refuse an option they don't
 *   know, rather than ignore it.
 * - An `FsError` names its path; a relative one also says the absolute
 *   path it resolved to and the working directory it resolved against,
 *   which the terminal's `cd` may have moved.
 */

import { type FileSystem, FsError } from '@agex-ts/termish'
import { writeWithParents } from '../fs'
import { resolve } from '../path'

/** The options each method that takes them knows. */
const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  mkdir: ['parents', 'existOk', 'recursive'],
  list: ['recursive'],
  listDetailed: ['recursive'],
}

interface MkdirOptions {
  parents?: boolean
  existOk?: boolean
  recursive?: boolean
}

/** Call `method` of `fs` with the arguments code gave. */
export async function callFs(
  fs: FileSystem,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  checkOptions(method, args[1])
  const cwd = fs.getcwd()
  try {
    if (method === 'write') {
      const [path, content, mode] = args as [string, Uint8Array, 'w' | 'a' | undefined]
      return await writeWithParents(fs, path, content, mode)
    }
    if (method === 'mkdir') {
      const { recursive, ...opts } = (args[1] ?? {}) as MkdirOptions
      // Node's recursive means both, whatever else came with it
      const node = recursive === true ? { parents: true, existOk: true } : {}
      return await fs.mkdir(args[0] as string, { ...opts, ...node })
    }
    const fn = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    return await (fn as (...a: unknown[]) => unknown).apply(fs, [...args])
  } catch (e) {
    throw e instanceof FsError ? located(e, cwd) : e
  }
}

function checkOptions(method: string, opts: unknown): void {
  const known = OPTIONS[method]
  if (known === undefined || opts === undefined || opts === null) return
  const takes = `it takes ${known.join(', ')}`
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError(`fs.${method}: options must be an object (${takes})`)
  }
  const unknown = Object.keys(opts).filter((k) => !known.includes(k))
  if (unknown.length > 0) {
    const names = unknown.map((k) => `'${k}'`).join(', ')
    throw new TypeError(
      `fs.${method}: unknown option${unknown.length > 1 ? 's' : ''} ${names} (${takes})`,
    )
  }
}

/** `e` with its path in the message: as given when absolute, and when
 *  relative with the absolute path and the cwd besides. */
function located(e: FsError, cwd: string): FsError {
  if (e.path === '') return e
  const named = e.message.includes(`'${e.path}'`) ? e.message : `${e.message}: ${e.path}`
  const message = e.path.startsWith('/')
    ? named
    : `${named} (resolved to ${resolve(e.path, cwd)}; cwd ${cwd})`
  return new FsError(e.code, e.path, message)
}
