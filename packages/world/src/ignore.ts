/**
 * Paths that are never work.
 *
 * Two kinds, treated the same way:
 *
 * - **Outside the workspace root.** The agent's work is what sits under
 *   `ws.root`; whatever a session writes elsewhere (scratch under
 *   `/tmp`, a library's cache) is the sandbox's state.
 * - **The embedder's patterns**, `ignore` on the workspace: git's
 *   `.gitignore` for what the embedder knows its sessions write and
 *   nobody wants as work (`node_modules/`, a tool's cache).
 *
 * Everything that decides what a session's work *is* leaves them out:
 * ws-git's status, staging and commits; the check for work an agent
 * hasn't committed; diffs; and merges, cherry-picks and directory
 * takes between sessions, which keep this side's copy. They're still
 * written and kept, so the session that wrote them reads them back.
 *
 * **Patterns** are a subset of `.gitignore`'s, matched against the path
 * relative to the root: a pattern with no `/` (or only a trailing one)
 * matches a name at any depth; a leading or inner `/` anchors it to the
 * root; a trailing `/` matches only a directory, and everything below
 * it; `*` and `?` match within a segment, `**` across segments, and
 * `[abc]` is a class. Blank lines and `#` comments are skipped.
 * Negation (`!`) is refused rather than taken to mean something else.
 */

import { normalize } from './path'

/** Compiled ignore patterns. */
export class Patterns {
  /** The patterns, as given (comments and blanks dropped). */
  readonly source: readonly string[]
  readonly #rules: readonly { regex: RegExp; dirOnly: boolean }[]

  constructor(lines: string | readonly string[] = []) {
    const list = typeof lines === 'string' ? lines.split(/\r?\n/) : lines
    const source: string[] = []
    const rules: { regex: RegExp; dirOnly: boolean }[] = []
    for (const raw of list) {
      const line = String(raw).trim()
      if (line === '' || line.startsWith('#')) continue
      if (line.startsWith('!')) {
        throw new TypeError(`ignore pattern '${line}': negation ('!') is not supported`)
      }
      source.push(line)
      rules.push(compile(line))
    }
    this.source = source
    this.#rules = rules
  }

  get empty(): boolean {
    return this.#rules.length === 0
  }

  /** Whether `rel`, a path relative to the root, matches a pattern, or
   *  one of the directories above it does. */
  match(rel: string): boolean {
    if (this.#rules.length === 0 || rel === '') return false
    const parts = rel.split('/')
    for (let i = parts.length; i > 0; i--) {
      const candidate = parts.slice(0, i).join('/')
      const isDir = i < parts.length
      for (const { regex, dirOnly } of this.#rules) {
        if (dirOnly && !isDir) continue
        if (regex.test(candidate)) return true
      }
    }
    return false
  }
}

function compile(line: string): { regex: RegExp; dirOnly: boolean } {
  const dirOnly = line.endsWith('/')
  let body = line.replace(/\/+$/, '')
  const anchored = body.startsWith('/') || body.includes('/')
  body = body.replace(/^\/+/, '')
  const regex = (anchored ? '' : '(?:.*/)?') + translate(body)
  return { regex: new RegExp(`^${regex}$`), dirOnly }
}

function translate(glob: string): string {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i] as string
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 3
    } else if (glob.startsWith('**', i)) {
      out += '.*'
      i += 2
    } else if (c === '*') {
      out += '[^/]*'
      i += 1
    } else if (c === '?') {
      out += '[^/]'
      i += 1
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end === -1) {
        out += '\\['
        i += 1
      } else {
        let cls = glob.slice(i + 1, end)
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
        out += `[${cls.replace(/\\/g, '\\\\')}]`
        i = end + 1
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      i += 1
    }
  }
  return out
}

export const NO_PATTERNS = new Patterns()

/** Why `path` (absolute) is never work for a workspace rooted at
 *  `root`, in words; null when it is work. The root itself is work. */
export function whyIgnored(
  path: string,
  root: string,
  patterns: Patterns = NO_PATTERNS,
): string | null {
  const norm = normalize(path)
  const top = normalize(root === '' ? '/' : root)
  let rel: string
  if (top === '/') rel = norm.replace(/^\/+/, '')
  else if (norm === top) return null
  else if (norm.startsWith(`${top}/`)) rel = norm.slice(top.length + 1)
  else return `it is outside the workspace root (${top})`
  if (patterns.match(rel)) return "it matches the session's ignore patterns"
  return null
}

/** Whether `path` is never work: outside the root, or matched. */
export function isIgnored(path: string, root: string, patterns: Patterns = NO_PATTERNS): boolean {
  return whyIgnored(path, root, patterns) !== null
}
