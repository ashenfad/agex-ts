/**
 * Standalone glob helper over a `FileSystem`.
 *
 * Supports four pattern primitives — same surface as Python's `fnmatch`
 * with the `**` extension:
 *
 * | Pattern | Meaning |
 * |---|---|
 * | `*`  | any sequence of characters except `/` |
 * | `?`  | any single character except `/` |
 * | `[abc]` | any character in the bracket set |
 * | `**` | any sequence of characters including `/` |
 *
 * Backends do not implement `glob()` themselves — this helper walks
 * the FS via `list()`. Trades some efficiency (always lists from the
 * longest non-glob prefix recursively) for simplicity and adapter
 * portability.
 */

import { joinPath, normalize, resolve } from './fs/path'
import type { FileSystem } from './fs/protocol'

/** Returns true if `pattern` contains any glob metacharacters. */
export function hasGlobChars(pattern: string): boolean {
  return /[*?[]/.test(pattern)
}

/**
 * Compile a glob pattern into an anchored regex. The regex matches a
 * full path *relative to* the longest non-glob prefix.
 */
export function compileGlob(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i] as string

    // `**` matches anything including slashes.
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 2
      // Consume an optional trailing `/` so `**/foo` matches both
      // `foo` (zero segments) and `a/b/foo` (multiple segments).
      if (pattern[i] === '/') i++
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }
    if (c === '[') {
      // Lift the bracket expression verbatim (including any `!`/`^`
      // negation and the closing `]`). Behaviour matches POSIX glob
      // brackets: classes are literal char sets.
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) {
        // Unterminated bracket — treat literally.
        re += '\\['
        i++
        continue
      }
      const cls = pattern.slice(i + 1, end)
      // Translate leading `!` to regex `^`.
      const translated = cls.startsWith('!') ? `^${cls.slice(1)}` : cls
      re += `[${translated}]`
      i = end + 1
      continue
    }
    // Escape regex metacharacters in literals.
    re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    i++
  }
  return new RegExp(`^${re}$`)
}

/** Pure pattern match — true iff `path` matches `pattern`. */
export function globMatch(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path)
}

/**
 * Resolve a glob pattern against a `FileSystem`, returning matching
 * paths sorted lexicographically.
 *
 * Patterns may be absolute (`/etc/**\/*.conf`) or relative (`*.ts`,
 * `src/lib/*.ts`). Relative patterns resolve against `fs.getcwd()`.
 *
 * If the pattern has no glob characters, returns `[pattern]` if the
 * path exists or `[]` otherwise — matches shell semantics.
 */
export async function glob(pattern: string, fs: FileSystem): Promise<string[]> {
  if (!hasGlobChars(pattern)) {
    return (await fs.exists(pattern)) ? [pattern] : []
  }

  const isAbsolute = pattern.startsWith('/')
  const cwd = fs.getcwd()

  // Find the longest leading prefix that has no glob metacharacters —
  // listing only that subtree avoids walking the whole filesystem.
  const segments = pattern.split('/')
  const baseSegments: string[] = []
  let firstGlobIdx = 0
  for (; firstGlobIdx < segments.length; firstGlobIdx++) {
    if (hasGlobChars(segments[firstGlobIdx] as string)) break
    baseSegments.push(segments[firstGlobIdx] as string)
  }
  const baseRel = baseSegments.join('/')
  const baseAbs = isAbsolute
    ? normalize(baseRel.length > 0 ? baseRel : '/')
    : resolve(baseRel.length > 0 ? baseRel : '.', cwd)
  const relPattern = segments.slice(firstGlobIdx).join('/')

  let entries: string[]
  try {
    entries = await fs.list(baseAbs, { recursive: true })
  } catch {
    return []
  }

  const regex = compileGlob(relPattern)
  const matches: string[] = []
  for (const entry of entries) {
    if (regex.test(entry)) {
      // Reassemble in the same shape the user passed in: absolute
      // patterns return absolute matches, relative patterns return
      // base-relative matches.
      if (isAbsolute) {
        matches.push(joinPath(baseAbs, entry))
      } else {
        matches.push(baseRel.length > 0 ? joinPath(baseRel, entry) : entry)
      }
    }
  }
  return matches.sort()
}
