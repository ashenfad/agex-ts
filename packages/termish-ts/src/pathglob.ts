/**
 * Pathname expansion, as bash does it. Ported from termish-py's
 * `pathglob`.
 *
 * An unquoted word holding `*`, `?` or a `[...]` class is matched
 * against the filesystem one path segment at a time:
 *
 * - `*`, `?` and `[...]` match within a segment and never cross a `/`:
 *   `a/*` names the entries directly under `a`, directories included,
 *   and nothing below them;
 * - a name starting with `.` is matched only by a segment that itself
 *   starts with `.`, as with bash's `dotglob` off;
 * - `**` matches zero or more directories (bash with `globstar` on),
 *   and a final `**` everything below, files included;
 * - a trailing `/` matches directories only, and is kept;
 * - the matches keep the word's own form: a relative word expands to
 *   relative paths and an absolute one to absolute paths, sorted.
 *
 * A word that matches nothing gives an empty list; the caller keeps the
 * word as typed (`nullglob` off).
 *
 * - `**` never descends through a symbolic link to a directory (when the
 *   filesystem has `isSymlink`), as bash's globstar doesn't; the link
 *   itself still matches.
 *
 * It works through the filesystem's `list`, `isDir` and `exists`, so
 * every filesystem expands the same way.
 */

import type { FileSystem } from './fs/protocol'
import { compileGlob } from './glob'

/** Whether `word` is a pattern: it holds `*` or `?`, or a `[` closed by
 *  a later `]`. */
export function hasMagic(word: string): boolean {
  if (word.includes('*') || word.includes('?')) return true
  const start = word.indexOf('[')
  return start !== -1 && word.indexOf(']', start + 2) !== -1
}

/** The paths `pattern` matches, sorted; empty when none do. */
export async function expand(pattern: string, fs: FileSystem): Promise<string[]> {
  const absolute = pattern.startsWith('/')
  let parts = pattern.split('/')
  if (absolute) parts = parts.slice(1)
  const trailing = parts.length > 1 && parts[parts.length - 1] === ''
  if (trailing) parts = parts.slice(0, -1)
  parts = parts.filter((p) => p !== '')
  const found = new Set<string>()
  await walk(fs, absolute ? '/' : '', parts, 0, trailing, found)
  return [...found].sort()
}

function join(base: string, name: string): string {
  if (base === '') return name
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

async function names(fs: FileSystem, base: string): Promise<string[]> {
  try {
    return (await fs.list(base || '.')).map(basename)
  } catch {
    return []
  }
}

async function isDir(fs: FileSystem, path: string): Promise<boolean> {
  try {
    return await fs.isDir(path || '.')
  } catch {
    return false
  }
}

/** Whether `path` is a directory `**` may descend into: one that isn't
 *  reached through a symbolic link. */
async function descendable(fs: FileSystem, path: string): Promise<boolean> {
  if (!(await isDir(fs, path))) return false
  try {
    return !(await fs.isSymlink?.(path))
  } catch {
    return false
  }
}

async function exists(fs: FileSystem, path: string): Promise<boolean> {
  try {
    return await fs.exists(path)
  } catch {
    return false
  }
}

/** Every entry below `base` that doesn't start with a dot. */
async function everything(fs: FileSystem, base: string, found: Set<string>): Promise<void> {
  for (const name of await names(fs, base)) {
    if (name.startsWith('.')) continue
    const path = join(base, name)
    found.add(path)
    if (await descendable(fs, path)) await everything(fs, path, found)
  }
}

/** Whether `name` matches the single-segment pattern `part`, as
 *  `fnmatchcase` does. */
function matches(part: string, name: string): boolean {
  return compileGlob(part).test(name)
}

async function walk(
  fs: FileSystem,
  base: string,
  parts: readonly string[],
  i: number,
  trailing: boolean,
  found: Set<string>,
): Promise<void> {
  if (i === parts.length) {
    if (trailing) {
      // A relative `**/` reaches here with no base at all: that is the
      // working directory, which is never a match of its own.
      if (base && (await isDir(fs, base))) found.add(base.endsWith('/') ? base : `${base}/`)
    } else if (base) {
      found.add(base)
    }
    return
  }
  const part = parts[i] as string
  const last = i === parts.length - 1
  if (part === '**' && last && !trailing) {
    // A final `**` names everything below: the base as a directory, then
    // every entry at every depth, files as well as directories.
    if (base) found.add(base.endsWith('/') ? base : `${base}/`)
    await everything(fs, base, found)
    return
  }
  if (part === '**') {
    // Zero directories here, then one more level and `**` again.
    await walk(fs, base, parts, i + 1, trailing, found)
    for (const name of await names(fs, base)) {
      if (name.startsWith('.')) continue
      const path = join(base, name)
      if (await descendable(fs, path)) await walk(fs, path, parts, i, trailing, found)
    }
    return
  }
  if (!hasMagic(part)) {
    const path = join(base, part)
    if ((last && (await exists(fs, path))) || (!last && (await isDir(fs, path)))) {
      await walk(fs, path, parts, i + 1, trailing, found)
    }
    return
  }
  for (const name of await names(fs, base)) {
    if (name.startsWith('.') && !part.startsWith('.')) continue
    if (!matches(part, name)) continue
    const path = join(base, name)
    if (last || (await isDir(fs, path))) await walk(fs, path, parts, i + 1, trailing, found)
  }
}
