/**
 * The host side of code's `fs`: a call on the workspace's filesystem,
 * with what code expects of a file API on top of termish's
 * `FileSystem`.
 *
 * - `write` creates the directories the file needs, as `file_write`
 *   does.
 * - `mkdir` takes Node's `{ recursive: true }` (missing parents made, an
 *   existing directory fine) besides `parents` and `existOk`.
 * - `remove` takes `fs.rm`'s `{ recursive, force }`: a directory with
 *   everything under it, and a missing path fine; `rmdir` takes
 *   `recursive` too.
 * - A method that takes options refuses one it doesn't know, rather
 *   than ignore it.
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
  remove: ['recursive', 'force'],
  rmdir: ['recursive'],
  list: ['recursive'],
  listDetailed: ['recursive'],
}

interface MkdirOptions {
  parents?: boolean
  existOk?: boolean
  recursive?: boolean
}

interface RemoveOptions {
  recursive?: boolean
  force?: boolean
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
    if (method === 'remove' || method === 'rmdir') {
      const { recursive = false, force = false } = (args[1] ?? {}) as RemoveOptions
      return await remove(fs, method, args[0] as string, recursive === true, force === true)
    }
    const fn = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    return await (fn as (...a: unknown[]) => unknown).apply(fs, [...args])
  } catch (e) {
    throw e instanceof FsError ? located(e, cwd) : e
  }
}

/** `fs.rm`'s semantics over termish's `remove` and `rmdir`. */
async function remove(
  fs: FileSystem,
  method: 'remove' | 'rmdir',
  path: string,
  recursive: boolean,
  force: boolean,
): Promise<void> {
  if (!(await fs.exists(path))) {
    if (force) return
    throw new FsError('ENOENT', path)
  }
  if (!recursive || !(await fs.isDir(path))) {
    return method === 'remove' ? fs.remove(path) : fs.rmdir(path)
  }
  if (resolve(path, fs.getcwd()) === '/')
    throw new FsError('EINVAL', path, 'Cannot remove the root')
  await removeTree(fs, path.replace(/\/+$/, ''))
}

async function removeTree(fs: FileSystem, dir: string): Promise<void> {
  for (const item of await fs.listDetailed(dir)) {
    const child = `${dir}/${item.path.replace(/\/+$/, '').split('/').pop()}`
    if (item.isDir) await removeTree(fs, child)
    else await fs.remove(child)
  }
  await fs.rmdir(dir)
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
