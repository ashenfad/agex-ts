/**
 * Exact-string edits with agent-tolerant matching, nontainer's
 * strategy set (from agex's file editing). The contract stays "exact
 * match"; the fallbacks absorb the two misses agents make constantly,
 * without changing what they are told:
 *
 * 1. **Exact.**
 * 2. **Trailing whitespace:** the file has trailing spaces the quote
 *    left out.
 * 3. **Indent:** the quote is the file's block at another indent, by
 *    one amount, or by one amount after a first line indented on its
 *    own (a quote started partway along a line). The replacement is
 *    re-indented to the file's, in the file's indent character. Any
 *    other difference is not a match: re-indenting on a guess would
 *    silently reformat the file.
 *
 * Then two ergonomics:
 * - **Already applied:** the quote is absent but the replacement is
 *   there, so a retried edit is a no-op, not an error.
 * - **On failure,** the closest lines of the file with their numbers
 *   ("did you mean these lines?"), so the error is a prompt to correct
 *   the quote; and a note when the quote misses only by typographic
 *   look-alikes (curly quotes, dashes, odd spaces) or Unicode normal
 *   form.
 *
 * Replacement text is always inserted literally.
 */

/** A failed edit; the message is written for the agent. */
export class EditError extends Error {
  override readonly name = 'EditError'
}

/** How an edit matched. */
export type EditMode = 'exact' | 'trailing_ws' | 'indent_flexible' | 'already_applied'

export interface EditResult {
  readonly content: string
  /** Replacements made; 0 when already applied. */
  readonly count: number
  readonly mode: EditMode
}

/**
 * Replace `oldString` with `newString` in `content`, once (it must
 * match once) or everywhere with `replaceAll`.
 *
 * @param path names the file in error messages.
 * @throws EditError when nothing matches, or several places do.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean; path?: string } = {},
): EditResult {
  const replaceAll = opts.replaceAll ?? false
  const path = opts.path ?? '<file>'
  if (oldString === '') throw new EditError('old_string is empty')
  if (oldString === newString) throw new EditError('old_string and new_string are identical')

  // 1. exact
  const count = occurrences(content, oldString)
  if (count > 0) {
    if (count > 1 && !replaceAll) {
      throw new EditError(
        `old_string appears ${count} times in ${path}; include more surrounding context to make it unique, or pass replace_all`,
      )
    }
    return {
      content: replaceAll
        ? content.split(oldString).join(newString)
        : spliceAt(content, content.indexOf(oldString), oldString.length, newString),
      count: replaceAll ? count : 1,
      mode: 'exact',
    }
  }

  // 2. trailing whitespace
  const pattern = trailingWsPattern(oldString)
  const wsMatches = [...content.matchAll(pattern)]
  if (wsMatches.length > 0) {
    if (wsMatches.length > 1 && !replaceAll) {
      throw new EditError(
        `old_string matches ${wsMatches.length} places in ${path} (ignoring trailing whitespace); add context or replace_all`,
      )
    }
    const apply = replaceAll ? wsMatches : wsMatches.slice(0, 1)
    let out = content
    for (const m of [...apply].reverse()) {
      out = spliceAt(out, m.index ?? 0, m[0].length, newString)
    }
    return { content: out, count: apply.length, mode: 'trailing_ws' }
  }

  // 3. indent-flexible
  const indentMatches = indentFlexibleMatches(oldString, content)
  if (indentMatches.length > 0) {
    if (indentMatches.length > 1 && !replaceAll) {
      throw new EditError(
        `old_string matches ${indentMatches.length} places in ${path} (at different indentation); add context or replace_all`,
      )
    }
    const apply = replaceAll ? indentMatches : indentMatches.slice(0, 1)
    let out = content
    for (const { start, end, matched } of [...apply].reverse()) {
      out = out.slice(0, start) + reindent(newString, oldString, matched) + out.slice(end)
    }
    return { content: out, count: apply.length, mode: 'indent_flexible' }
  }

  // 4. already applied: an agent's retry
  if (content.includes(newString)) return { content, count: 0, mode: 'already_applied' }

  // 5. a failure that says what to do
  const parts = [`old_string not found in ${path}.`]
  const similar = findSimilarLines(oldString, content)
  if (similar !== null) {
    parts.push(`Did you mean to match these lines?\n${similar}`)
  } else {
    parts.push(`Search was:\n${oldString.slice(0, 200)}${oldString.length > 200 ? '...' : ''}`)
  }
  const hint = nearMiss(content, oldString)
  if (hint !== null) parts.push(hint)
  throw new EditError(parts.join('\n\n'))
}

function occurrences(content: string, search: string): number {
  let n = 0
  for (
    let at = content.indexOf(search);
    at !== -1;
    at = content.indexOf(search, at + search.length)
  ) {
    n++
  }
  return n
}

function spliceAt(s: string, at: number, length: number, insert: string): string {
  return s.slice(0, at) + insert + s.slice(at + length)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trailingWsPattern(search: string): RegExp {
  return new RegExp(
    search
      .split('\n')
      .map((line) => `${escapeRegExp(line.trimEnd())}[ \\t]*`)
      .join('\n'),
    'g',
  )
}

/** A line's leading whitespace. */
function leading(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

/** A line's indent, a tab counting four. */
function width(line: string): number {
  let w = 0
  for (const ch of leading(line)) {
    if (ch === '\t') w += 4
    else if (ch === ' ') w += 1
  }
  return w
}

/**
 * `[first, rest]`: how far the file's block sits from the quote, for
 * the quote's first non-blank line and for the lines after it; null
 * when the lines after it don't all sit one amount away. `first` may
 * differ from `rest`: an agent quoting a block from partway along its
 * first line indents that line as it sees fit and copies the rest as
 * they are.
 */
function shifts(search: string, matched: string): [number, number] | null {
  const quote = search.split('\n')
  const file = matched.split('\n')
  const deltas: number[] = []
  for (let i = 0; i < Math.min(quote.length, file.length); i++) {
    const q = quote[i] as string
    if (q.trim() === '') continue
    deltas.push(width(file[i] as string) - width(q))
  }
  if (deltas.length === 0) return null
  const rest = deltas.length > 1 ? deltas.slice(1) : deltas.slice(0, 1)
  if (rest.some((d) => d !== rest[0])) return null
  return [deltas[0] as number, rest[0] as number]
}

interface IndentMatch {
  readonly start: number
  readonly end: number
  readonly matched: string
}

/** Blocks equal to `search` but for their indent, differing as
 *  {@link shifts} allows. */
function indentFlexibleMatches(search: string, content: string): IndentMatch[] {
  const searchLines = search.split('\n')
  const contentLines = content.split('\n')
  const anchorIdx = searchLines.findIndex((line) => line.trim() !== '')
  if (anchorIdx === -1) return []
  const anchor = (searchLines[anchorIdx] as string).trim()
  const stripped = searchLines.map((line) => line.trim())
  const matches: IndentMatch[] = []
  for (let i = 0; i < contentLines.length; i++) {
    if ((contentLines[i] as string).trim() !== anchor) continue
    const startLine = i - anchorIdx
    const endLine = startLine + searchLines.length
    if (startLine < 0 || endLine > contentLines.length) continue
    if (!stripped.every((s, j) => s === (contentLines[startLine + j] as string).trim())) continue
    let start = 0
    for (let k = 0; k < startLine; k++) start += (contentLines[k] as string).length + 1
    const matched = contentLines.slice(startLine, endLine).join('\n')
    if (shifts(search, matched) === null) continue
    matches.push({ start, end: start + matched.length, matched })
  }
  return matches
}

/** Which replacement line stands where the quote's first line did: the
 *  one with its text, else the replacement's first line when indented
 *  as the quote's first line was. Null when neither. */
function counterpart(search: string, replLines: readonly string[]): number | null {
  const head = search.split('\n').find((line) => line.trim() !== '') ?? ''
  const same = replLines.findIndex((line) => line.trim() !== '' && line.trim() === head.trim())
  if (same !== -1) return same
  const first = replLines.findIndex((line) => line.trim() !== '')
  if (first === -1) return null
  return width(replLines[first] as string) === width(head) ? first : null
}

/** Shift `replacement`'s indent so it drops in where `matched` was, in
 *  the file's indent character. */
function reindent(replacement: string, search: string, matched: string): string {
  const baseIndent = (lines: readonly string[]): [number, string] => {
    for (const line of lines) {
      if (line.trimStart() === '') continue
      return [width(line), leading(line).includes('\t') ? '\t' : ' ']
    }
    return [0, ' ']
  }
  const [searchIndent] = baseIndent(search.split('\n'))
  const [targetIndent, targetChar] = baseIndent(matched.split('\n'))
  const replLines = replacement.split('\n')
  const [replIndent] = baseIndent(replLines)
  const delta = targetIndent - (replIndent === searchIndent ? searchIndent : replIndent)
  // A first line the quote indented on its own: its counterpart moves
  // by its own amount and every other line by the body's, so a body
  // quoted right isn't moved with it, nor a line inserted around it.
  const [first, rest] = shifts(search, matched) ?? [delta, delta]
  const head = first !== rest ? counterpart(search, replLines) : null
  return replLines
    .map((line, i) => {
      const text = line.trimStart()
      if (text === '') return ''
      const shift = first !== rest ? (i === head ? first : rest) : delta
      const w = Math.max(0, width(line) + shift)
      const indent =
        targetChar === '\t' ? '\t'.repeat(Math.floor(w / 4)) + ' '.repeat(w % 4) : ' '.repeat(w)
      return indent + text
    })
    .join('\n')
}

// ---------- the closest lines ----------

/** Python's `str.splitlines()`: every line boundary it knows, and no
 *  empty last line for a trailing break. */
function splitlines(s: string): string[] {
  if (s === '') return []
  const lines = s.split(LINE_BREAK)
  if (TRAILING_BREAK.test(s)) lines.pop()
  return lines
}

// Python's line boundaries include the file, group and record
// separators (\x1c-\x1e), control characters on purpose.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Python's splitlines set
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: Python's splitlines set
const TRAILING_BREAK = /(\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])$/

/** The window of `content` most like `search`, with line numbers and
 *  three lines around it, or null when none is at least 60% alike. */
export function findSimilarLines(search: string, content: string, threshold = 0.6): string | null {
  const searchLines = splitlines(search)
  const contentLines = splitlines(content)
  const n = searchLines.length
  if (n === 0 || contentLines.length === 0 || n > contentLines.length) return null
  let bestRatio = 0
  let bestStart = 0
  for (let i = 0; i <= contentLines.length - n; i++) {
    const r = ratio(search, contentLines.slice(i, i + n).join('\n'))
    if (r > bestRatio) {
      bestRatio = r
      bestStart = i
    }
  }
  if (bestRatio < threshold) return null
  const out: string[] = []
  const end = Math.min(contentLines.length, bestStart + n + 3)
  for (let i = Math.max(0, bestStart - 3); i < end; i++) {
    const marker = i >= bestStart && i < bestStart + n ? '>' : ' '
    out.push(`${marker} ${String(i + 1).padStart(4)} | ${contentLines[i]}`)
  }
  return out.join('\n')
}

/**
 * difflib's `SequenceMatcher(None, a, b).ratio()`: twice the characters
 * in matching blocks over the total, with its "autojunk" rule (in a
 * second sequence of 200 or more, an element making up more than 1% of
 * it is not used to start a match).
 */
export function ratio(aText: string, bText: string): number {
  const a = Array.from(aText)
  const b = Array.from(bText)
  const total = a.length + b.length
  if (total === 0) return 1

  const b2j = new Map<string, number[]>()
  b.forEach((ch, j) => {
    const at = b2j.get(ch)
    if (at === undefined) b2j.set(ch, [j])
    else at.push(j)
  })
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1
    for (const [ch, at] of [...b2j]) if (at.length > ntest) b2j.delete(ch)
  }

  const longest = (
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): [number, number, number] => {
    let [besti, bestj, bestsize] = [alo, blo, 0]
    let j2len = new Map<number, number>()
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>()
      for (const j of b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue
        if (j >= bhi) break
        const k = (j2len.get(j - 1) ?? 0) + 1
        next.set(j, k)
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k]
      }
      j2len = next
    }
    // No junk without an isjunk function: extend over popular elements.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--
      bestj--
      bestsize++
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize++
    }
    return [besti, bestj, bestsize]
  }

  let matched = 0
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number]
    const [i, j, k] = longest(alo, ahi, blo, bhi)
    if (k === 0) continue
    matched += k
    if (alo < i && blo < j) queue.push([alo, i, blo, j])
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
  }
  return (2 * matched) / total
}

// ---------- near misses ----------

/** Typographic characters agents retype as ASCII look-alikes. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '…': '...',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
}

function fold(s: string): string {
  let out = ''
  for (const ch of s) out += LOOKALIKES[ch] ?? ch
  return out
}

/** Why a quote missed when it nearly matched: look-alike characters, or
 *  another Unicode normal form. Null when neither explains it. */
function nearMiss(content: string, search: string): string | null {
  if (fold(content).includes(fold(search))) {
    return 'The file has typographic characters where the quote has plain ones (curly quotes ‘’ “”, dashes – —, or non-breaking spaces): copy them exactly.'
  }
  try {
    if (content.normalize('NFC').includes(search.normalize('NFC'))) {
      return 'The quote matches only under Unicode normalization (the file writes some characters another way, such as combining accents): copy the exact characters from the file.'
    }
  } catch {
    // Malformed text can't be normalized: no near miss to report.
  }
  return null
}
