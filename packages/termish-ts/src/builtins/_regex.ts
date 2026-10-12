/**
 * POSIX basic regular expressions (BRE), read into JavaScript `RegExp`
 * syntax. Ported from termish-py's `_regex`.
 *
 * `grep` and `sed` without `-E` take BRE, the syntax agents write when
 * they write GNU commands, and its escaping is roughly the reverse of
 * JavaScript's: `\(`, `\{`, `\|`, `\+` and `\?` are operators while their
 * bare forms are literal characters. Handed to `RegExp` unchanged, the
 * operators read as literals, so `s/a\+/X/` matched nothing, and a bare
 * `(` was a syntax error rather than a parenthesis.
 *
 * With `-E` a pattern is already in the syntax `RegExp` speaks and is
 * passed through untouched; this module is for the other case.
 */

/** Escaped in BRE they are operators; bare, they are literal characters. */
const SWAPPED = '(){}|+?'

/**
 * Translate a POSIX BRE `pattern` into a JavaScript regex source.
 *
 * Outside a bracket expression:
 * - `\( \) \{ \} \| \+ \?` become `( ) { } | + ?`, and their bare forms
 *   become escaped literals;
 * - `*` is literal where nothing precedes it: at the start of the
 *   pattern, of a group, or of an alternative (and after a leading `^`);
 * - `^` anchors only at those same starting points, and `$` only at the
 *   end of the pattern, of a group or of an alternative; anywhere else
 *   each is a literal character;
 * - `\<` and `\>` (GNU's start and end of a word) become `\b(?=\w)` and
 *   `\b(?<=\w)`: a bare `\b` would match either edge;
 * - every other escape (`\1`-`\9`, `\.`, `\*`, `\w`) is kept as it is,
 *   since it means the same to `RegExp`.
 *
 * Inside `[...]` a backslash is a literal character, as in BRE, and a
 * `]` right after `[` or `[^` is a member rather than the end.
 */
export function breToJs(pattern: string): string {
  const out: string[] = []
  const n = pattern.length
  let i = 0
  // True where nothing precedes this position in the current
  // alternative: `*` is literal here and `^` anchors.
  let atStart = true
  while (i < n) {
    const ch = pattern[i] as string
    if (ch === '[') {
      i = bracket(pattern, i, out)
      atStart = false
      continue
    }
    if (ch === '\\') {
      if (i + 1 >= n) {
        out.push('\\\\') // a trailing backslash is literal
        i++
        continue
      }
      const next = pattern[i + 1] as string
      i += 2
      if (SWAPPED.includes(next)) {
        out.push(next)
        atStart = next === '(' || next === '|'
      } else if (next === '<') {
        out.push('\\b(?=\\w)') // the start of a word
        atStart = false
      } else if (next === '>') {
        out.push('\\b(?<=\\w)') // the end of a word
        atStart = false
      } else {
        out.push(`\\${next}`)
        atStart = false
      }
      continue
    }
    i++
    if (SWAPPED.includes(ch)) {
      out.push(`\\${ch}`)
      atStart = false
    } else if (ch === '*' && atStart) {
      out.push('\\*')
      atStart = false
    } else if (ch === '^') {
      // An anchor leaves the position a start: `^*` is a literal `*`.
      out.push(atStart ? '^' : '\\^')
    } else if (ch === '$') {
      const rest = pattern.slice(i)
      const ends = rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')
      out.push(ends ? '$' : '\\$')
      atStart = false
    } else {
      out.push(ch)
      atStart = false
    }
  }
  return out.join('')
}

/** Copy the bracket expression at `start` into `out`, with its
 *  backslashes made literal; return the position after it. An
 *  unterminated bracket is copied as far as it goes, for `RegExp` to
 *  refuse in its own words. */
function bracket(pattern: string, start: number, out: string[]): number {
  const n = pattern.length
  out.push('[')
  let i = start + 1
  if (i < n && pattern[i] === '^') {
    out.push('^')
    i++
  }
  if (i < n && pattern[i] === ']') {
    out.push('\\]')
    i++
  }
  while (i < n) {
    const ch = pattern[i] as string
    i++
    if (ch === ']') {
      out.push(']')
      return i
    }
    out.push(ch === '\\' ? '\\\\' : ch)
  }
  return i
}
