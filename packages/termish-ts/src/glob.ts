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
 * `compileGlob` and `globMatch` match a pattern against a string
 * (`find -name`, `grep --include`). `glob` expands a pattern against a
 * filesystem, as the shell does.
 */

import type { FileSystem } from './fs/protocol'
import { expand, hasMagic } from './pathglob'

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
 * Resolve a glob pattern against a `FileSystem`, as the shell expands
 * an unquoted word (see `./pathglob`): segment by segment, `*` never
 * crossing a `/`, dotfiles matched only by a segment starting with a
 * dot, `**` for any depth, a trailing `/` for directories only. Matches
 * are sorted and keep the pattern's form, relative or absolute.
 *
 * A pattern with no glob characters gives `[pattern]` if the path
 * exists, and `[]` otherwise.
 */
export async function glob(pattern: string, fs: FileSystem): Promise<string[]> {
  if (!hasMagic(pattern)) return (await fs.exists(pattern)) ? [pattern] : []
  return expand(pattern, fs)
}
