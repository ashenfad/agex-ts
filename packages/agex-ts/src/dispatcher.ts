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

/** Count non-overlapping occurrences of `needle` in `haystack`.
 *  `needle` is assumed non-empty (callers guard against the empty
 *  search). Used to report match counts in the not-unique error. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count++
  }
  return count
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
  let next: string
  if (matchAll) {
    next = text.split(search).join(emission.content)
  } else {
    const idx = text.indexOf(search)
    if (idx === -1) {
      throw new Error(
        `fileEdit: ${emission.path}: search string not found${nearMissHint(text, search)}`,
      )
    }
    // Enforce the uniqueness the tool schema promises: a non-matchAll
    // edit must match exactly once. Silently taking the first of
    // several matches is how an edit lands on the wrong occurrence and
    // looks, to the agent, like it "deleted lines I didn't target".
    // Make the model disambiguate (widen the search with surrounding
    // context) or opt into matchAll instead.
    if (text.indexOf(search, idx + search.length) !== -1) {
      const count = countOccurrences(text, search)
      throw new Error(
        `fileEdit: ${emission.path}: search string is not unique (${count} matches); add surrounding context to target a single occurrence, or set matchAll=true`,
      )
    }
    next = text.slice(0, idx) + emission.content + text.slice(idx + search.length)
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
