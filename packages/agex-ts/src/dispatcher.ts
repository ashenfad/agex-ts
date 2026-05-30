/**
 * Per-emission dispatchers used by the task action loop.
 *
 * Each function handles one variant:
 *   - `dispatchFileWrite`  → write/append the content into the agent's
 *                            session VFS
 *   - `dispatchFileEdit`   → search/replace inside an existing file in
 *                            the VFS, honoring `matchAll`
 *   - `dispatchTerminal`   → run the commands string through @agex-ts/termish,
 *                            with the agent's registered terminal handlers
 *                            merged on top of @agex-ts/termish's builtins
 *
 * `dispatchTs` lives in `task.ts` because it threads through the
 * runtime adapter and produces the `TaskOutcome` that drives the loop.
 *
 * Errors thrown by a dispatcher surface as runtime failures — the
 * action loop converts them into a `FailEvent` so the task doesn't
 * silently spin on broken emissions.
 *
 * `dispatchFileEdit` matching is best-effort, not a parser. After an
 * exact match it falls back to two heuristics: a generated regex that
 * tolerates trailing whitespace (`trailingWsMatches`), and a
 * line-based indent-flexible match (`indentFlexibleMatches`). Both are
 * intentionally syntax-agnostic — they don't understand the language,
 * so a search that's ambiguous at the token level can still match. The
 * uniqueness guard catches the multi-match case; anything subtler is
 * the agent's responsibility to disambiguate with more context. Line
 * endings: matching tolerates LF or CRLF, and a fuzzy replacement is
 * normalized to the file's existing endings before it's spliced in.
 */

import type { CommandHandler } from '@agex-ts/termish'
import { execute } from '@agex-ts/termish'
import type { FileEditEmission, FileWriteEmission, Policy, VirtualFileSystem } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

export async function dispatchFileWrite(
  emission: FileWriteEmission,
  fs: VirtualFileSystem,
): Promise<void> {
  // Auto-create the parent directory (mkdir -p semantics). The
  // primer points the agent at /helpers/ for reusable code, so it
  // routinely writes the first file under a directory that doesn't
  // exist yet — making the agent run an explicit `mkdir` first
  // would be busywork.
  await ensureParentDir(emission.path, fs)
  const bytes = encoder.encode(emission.content)
  const mode = emission.mode === 'append' ? 'a' : 'w'
  await fs.write(emission.path, bytes, mode)
}

async function ensureParentDir(path: string, fs: VirtualFileSystem): Promise<void> {
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return // root-level file; nothing to create
  const parent = path.slice(0, slash)
  await fs.mkdir(parent, { parents: true, existOk: true })
}

// Typographic characters the model routinely retypes as their ASCII
// look-alikes when reconstructing a `search` string from memory — the
// commonest cause of a silent search miss on prose-in-code (button
// labels, comments). Folding both sides to the ASCII form lets the
// not-found path detect "you meant this, but typed the straight
// version" and say so, without changing match semantics on success.
const LOOKALIKES: Readonly<Record<string, string>> = {
  '‘': "'", // ‘  left single quote
  '’': "'", // ’  right single quote / apostrophe
  '‚': "'", // ‚  single low quote
  '‛': "'", // ‛  single high-reversed quote
  '“': '"', // “  left double quote
  '”': '"', // ”  right double quote
  '„': '"', // „  double low quote
  '–': '-', // –  en dash
  '—': '-', // —  em dash
  '―': '-', // ―  horizontal bar
  '−': '-', // −  minus sign
  '…': '...', // …  horizontal ellipsis
  ' ': ' ', //    non-breaking space
  ' ': ' ', //    narrow no-break space
  ' ': ' ', //    thin space
}

function foldLookalikes(s: string): string {
  let out = ''
  for (const ch of s) out += LOOKALIKES[ch] ?? ch
  return out
}

/** Diagnose a not-found search. Returns a hint suffix (or '') when a
 *  folded comparison *would* have matched — the model almost certainly
 *  retyped typographic characters as ASCII look-alikes, or copied text
 *  in a different Unicode normal form. We don't normalize on the happy
 *  path (the tool's contract is exact, whitespace-significant match,
 *  and the slice-based splice indexes the original string); we only
 *  turn the silent miss into actionable feedback. */
function nearMissHint(text: string, search: string): string {
  if (foldLookalikes(text).includes(foldLookalikes(search))) {
    return ' — the file contains typographic characters (e.g. curly quotes ‘’ “”, en/em dashes – —, or non-breaking spaces); copy them exactly rather than retyping ASCII quotes/hyphens/spaces'
  }
  try {
    if (text.normalize('NFC').includes(search.normalize('NFC'))) {
      return ' — the text matches under Unicode NFC normalization but not byte-for-byte (the file uses a different normal form, e.g. combining accents); copy the exact characters from the file'
    }
  } catch {
    // String.prototype.normalize can throw RangeError on malformed
    // input — treat as "no near miss" rather than masking the real
    // not-found error.
  }
  return ''
}

interface EditMatch {
  readonly start: number
  readonly end: number
  /** The exact slice of the file the match covers. Needed to re-indent
   *  the replacement under the indent-flexible strategy. */
  readonly matched: string
}

interface LocatedEdit {
  readonly mode: 'exact' | 'trailingWs' | 'indent'
  /** Ascending by `start`. */
  readonly matches: EditMatch[]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Locate every place `search` applies, trying three strategies in
 *  order and returning the first that finds anything: exact, then
 *  trailing-whitespace-flexible, then indent-flexible. Mirrors agex
 *  (Python) `apply_file_edit`'s matching ladder — the strict exact
 *  path hard-fails the two commonest near-misses (file carrying
 *  trailing whitespace the agent omitted; a block at a different
 *  absolute indent than the search), which the fallbacks recover. */
function locateMatches(text: string, search: string): LocatedEdit {
  const exact: EditMatch[] = []
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + search.length)) {
    exact.push({ start: i, end: i + search.length, matched: search })
  }
  if (exact.length > 0) return { mode: 'exact', matches: exact }

  const trailing = trailingWsMatches(text, search)
  if (trailing.length > 0) return { mode: 'trailingWs', matches: trailing }

  const indent = indentFlexibleMatches(text, search)
  if (indent.length > 0) return { mode: 'indent', matches: indent }

  return { mode: 'exact', matches: [] }
}

/** Match `search` allowing the file to carry trailing whitespace at
 *  line ends that the agent's search omitted (a frequent paste
 *  artifact). Internal indentation stays significant. */
function trailingWsMatches(text: string, search: string): EditMatch[] {
  // Join with `\r?\n` (not a literal newline) so the pattern matches a
  // block whether the file uses LF or CRLF line endings.
  const pattern = search
    .split(/\r?\n/)
    .map((line) => `${escapeRegExp(line.replace(/\s+$/, ''))}[ \\t]*`)
    .join('\\r?\\n')
  let re: RegExp
  try {
    re = new RegExp(pattern, 'g')
  } catch {
    return []
  }
  const out: EditMatch[] = []
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue
    const start = m.index ?? 0
    out.push({ start, end: start + m[0].length, matched: m[0] })
  }
  return out
}

/** Match `search` against a block with the same structure but a
 *  different absolute indent (e.g. a 2-space search against 4-space
 *  or tab-indented code). Anchors on the first non-empty search line
 *  (trimmed), then validates the block line-by-line after trimming. */
function indentFlexibleMatches(text: string, search: string): EditMatch[] {
  const searchLines = search.split('\n')
  // Split on either ending so a CRLF file's lines don't retain a
  // trailing '\r' (which would skew trimming and slice boundaries).
  const contentLines = text.split(/\r?\n/)

  let anchor: string | null = null
  let anchorIdx = 0
  for (let idx = 0; idx < searchLines.length; idx++) {
    const trimmed = (searchLines[idx] as string).trim()
    if (trimmed.length > 0) {
      anchor = trimmed
      anchorIdx = idx
      break
    }
  }
  if (anchor === null) return []

  const searchTrim = searchLines.map((l) => l.trim())
  // Byte offset where each line's content begins: the char just after
  // every '\n'. CRLF-safe — a '\r' sits at the end of the prior line,
  // so offsets and the `text.slice` below stay exact for LF or CRLF.
  const lineStart: number[] = [0]
  for (let idx = 0; idx < text.length; idx++) {
    if (text.charCodeAt(idx) === 10) lineStart.push(idx + 1)
  }

  const out: EditMatch[] = []
  for (let i = 0; i < contentLines.length; i++) {
    if ((contentLines[i] as string).trim() !== anchor) continue
    const startLine = i - anchorIdx
    if (startLine < 0) continue
    const endLine = startLine + searchLines.length
    if (endLine > contentLines.length) continue

    let ok = true
    for (let j = 0; j < searchTrim.length; j++) {
      if (searchTrim[j] !== (contentLines[startLine + j] as string).trim()) {
        ok = false
        break
      }
    }
    if (!ok) continue

    const start = lineStart[startLine] as number
    // End at the last matched line's content — excluding its trailing
    // separator — by slicing the original text rather than re-joining
    // (which would drop a CRLF's '\r' or force an ending choice).
    const end = (lineStart[endLine - 1] as number) + (contentLines[endLine - 1] as string).length
    const matched = text.slice(start, end)
    out.push({ start, end, matched })
    // Skip past this block so a repeated anchor line inside it can't
    // produce an overlapping second match — overlaps would either trip
    // a spurious not-unique error or corrupt the file when spliced
    // under matchAll. Keeps this strategy non-overlapping like the
    // exact and trailing-ws ones.
    i = endLine - 1
  }
  return out
}

/** Re-indent `replacement` to sit where an indent-flexible match was
 *  found: shift every line by the delta between the file's indent and
 *  the search's baseline, rendered with the file's indent character.
 *  Paired with `indentFlexibleMatches`. */
function adjustReplacementIndent(replacement: string, search: string, matched: string): string {
  const searchBase = baseIndentInfo(search.split('\n')).spaces
  const target = baseIndentInfo(matched.split('\n'))
  const replacementLines = replacement.split('\n')
  const replacementBase = baseIndentInfo(replacementLines).spaces

  // Prefer the search baseline as the reference; fall back to the
  // replacement's own baseline when the agent indented them differently.
  const delta =
    replacementBase === searchBase ? target.spaces - searchBase : target.spaces - replacementBase

  return replacementLines
    .map((line) => {
      const lstripped = line.replace(/^\s+/, '')
      if (lstripped.length === 0) return ''
      const leading = line.slice(0, line.length - lstripped.length)
      const width = Math.max(0, indentWidth(leading) + delta)
      const newLeading =
        target.char === '\t'
          ? '\t'.repeat(Math.floor(width / 4)) + ' '.repeat(width % 4)
          : ' '.repeat(width)
      // `lstripped` retains the line's own trailing whitespace.
      return newLeading + lstripped
    })
    .join('\n')
}

/** Indent width and dominant char of the first non-blank line. */
function baseIndentInfo(lines: string[]): { spaces: number; char: string } {
  for (const line of lines) {
    const lstripped = line.replace(/^\s+/, '')
    if (lstripped.length > 0) {
      const leading = line.slice(0, line.length - lstripped.length)
      return { spaces: indentWidth(leading), char: leading.includes('\t') ? '\t' : ' ' }
    }
  }
  return { spaces: 0, char: ' ' }
}

/** A tab counts as 4 columns, matching agex (Python). */
function indentWidth(leading: string): number {
  let width = 0
  for (const ch of leading) {
    if (ch === '\t') width += 4
    else if (ch === ' ') width += 1
  }
  return width
}

export async function dispatchFileEdit(
  emission: FileEditEmission,
  fs: VirtualFileSystem,
): Promise<void> {
  if (!(await fs.exists(emission.path))) {
    throw new Error(`fileEdit: ${emission.path}: no such file`)
  }
  // Don't catch here — IO / permission errors should surface unmasked.
  const existing = await fs.read(emission.path)
  const text = decoder.decode(existing)
  const search = emission.search
  if (search.length === 0) {
    throw new Error('fileEdit: empty search string')
  }
  const matchAll = emission.matchAll === true
  const located = locateMatches(text, search)
  if (located.matches.length === 0) {
    throw new Error(
      `fileEdit: ${emission.path}: search string not found${nearMissHint(text, search)}`,
    )
  }
  // Enforce the uniqueness the tool schema promises: a non-matchAll
  // edit must match exactly once. Silently taking the first of several
  // matches is how an edit lands on the wrong occurrence and looks, to
  // the agent, like it "deleted lines I didn't target". Make the model
  // disambiguate (widen the search) or opt into matchAll instead.
  if (located.matches.length > 1 && !matchAll) {
    throw new Error(
      `fileEdit: ${emission.path}: search string is not unique (${located.matches.length} matches); add surrounding context to target a single occurrence, or set matchAll=true`,
    )
  }

  // A fuzzy match can cover a CRLF region while the agent authored the
  // replacement with LF; splicing LF in verbatim would leave mixed
  // endings. Normalize fuzzy replacements to the file's endings. Exact
  // matches are left untouched — they matched verbatim, endings included.
  const fileUsesCrlf = text.includes('\r\n')
  const toApply = matchAll ? located.matches : located.matches.slice(0, 1)
  // Splice right-to-left so each replacement leaves the earlier
  // matches' offsets valid.
  let next = text
  for (let k = toApply.length - 1; k >= 0; k--) {
    const m = toApply[k] as EditMatch
    let replacement =
      located.mode === 'indent'
        ? adjustReplacementIndent(emission.content, search, m.matched)
        : emission.content
    if (located.mode !== 'exact' && fileUsesCrlf) {
      replacement = replacement.replace(/\r?\n/g, '\r\n')
    }
    next = next.slice(0, m.start) + replacement + next.slice(m.end)
  }
  await fs.write(emission.path, encoder.encode(next))
}

/** Default max-chars cap on terminal output handed back to the agent.
 *  A multi-MB blob (e.g. `cat` against a file with an embedded base64
 *  image) can otherwise blow the next turn's input window. ~200K chars
 *  is roughly 50K tokens — leaves room for normal source-file reads
 *  while bounding the worst case. @agex-ts/termish appends a marker pointing
 *  the agent at `head/tail/grep/sed` when it trips. */
const DEFAULT_TERMINAL_OUTPUT_CAP = 200_000

export async function dispatchTerminal(
  commands: string,
  fs: VirtualFileSystem,
  policy: Policy,
  signal: AbortSignal,
): Promise<string> {
  // Build the host-injected commands map from the policy's terminals.
  // @agex-ts/termish merges these on top of its own builtins.
  const hostCommands = new Map<string, CommandHandler>()
  for (const [name, reg] of policy.terminals) {
    // The agent's TerminalCommandHandler is shape-compatible with
    // @agex-ts/termish's CommandHandler; cast through unknown is safe.
    hostCommands.set(name, reg.handler as unknown as CommandHandler)
  }
  return execute(commands, fs, {
    commands: hostCommands,
    signal,
    maxOutputChars: DEFAULT_TERMINAL_OUTPUT_CAP,
  })
}
