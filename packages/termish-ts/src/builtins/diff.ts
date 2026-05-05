/**
 * `diff` — line-by-line file comparison.
 *
 * Direct port of termish-py's `diff.py`. The hard part — Python's
 * `difflib.unified_diff` / `difflib.context_diff` — gets a hand-rolled
 * LCS-based replacement here (no external deps).
 *
 * Algorithm:
 *   1. Read both files, split into lines (terminators preserved).
 *   2. Compute an LCS-backed edit script: a sequence of
 *      `equal | insert | delete` operations.
 *   3. Group ops into hunks bounded by `N` lines of context around
 *      each non-equal run.
 *   4. Format as unified diff (default) or context diff (`-c`).
 *
 * For typical file sizes (hundreds of lines) the LCS DP is fine —
 * O(mn) time and space. Switch to Myers' O(ND) if a real consumer
 * starts diffing megabytes.
 */

import type { CommandHandler } from '../context'
import { TerminalError } from '../errors'
import type { FileInfo, FileSystem } from '../fs/protocol'
import { parseArgs } from './_argparse'

const decoder = new TextDecoder('utf-8', { fatal: false })

interface DiffOptions {
  brief: boolean
  context: boolean // -c context format (old style)
  unifiedContext: number // N lines around each hunk
  ignoreBlankLines: boolean
  ignoreAllSpace: boolean
  ignoreSpaceChange: boolean
  ignoreCase: boolean
}

export const diff: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        unified: { aliases: ['-u', '--unified'] },
        unifiedContext: { aliases: ['-U', '--unified-context'], takesValue: true },
        context: { aliases: ['-c', '--context'] },
        brief: { aliases: ['-q', '--brief'] },
        ignoreBlankLines: { aliases: ['-B', '--ignore-blank-lines'] },
        ignoreAllSpace: { aliases: ['-w', '--ignore-all-space'] },
        ignoreSpaceChange: { aliases: ['-b', '--ignore-space-change'] },
        ignoreCase: { aliases: ['-i', '--ignore-case'] },
        recursive: { aliases: ['-r', '--recursive'] },
      },
      maxPositional: 2,
    },
    'diff',
  )

  if (parsed.positional.length < 2) {
    throw new TerminalError('diff: requires two file arguments (e.g., diff file1.txt file2.txt)')
  }
  const [file1, file2] = parsed.positional as [string, string]

  const opts: DiffOptions = {
    brief: parsed.flags.brief === true,
    context: parsed.flags.context === true,
    unifiedContext: numericFlag(parsed.flags.unifiedContext, 3),
    ignoreBlankLines: parsed.flags.ignoreBlankLines === true,
    ignoreAllSpace: parsed.flags.ignoreAllSpace === true,
    ignoreSpaceChange: parsed.flags.ignoreSpaceChange === true,
    ignoreCase: parsed.flags.ignoreCase === true,
  }

  if (
    parsed.flags.recursive === true &&
    (await ctx.fs.isDir(file1)) &&
    (await ctx.fs.isDir(file2))
  ) {
    await diffRecursive(file1, file2, opts, ctx.fs, ctx.stdout)
    return
  }

  await diffPair(file1, file2, opts, ctx.fs, ctx.stdout)
}

// ---------------------------------------------------------------------------
// Single-file pair
// ---------------------------------------------------------------------------

async function diffPair(
  path1: string,
  path2: string,
  opts: DiffOptions,
  fs: FileSystem,
  stdout: { write: (s: string) => void },
): Promise<void> {
  const file1Lines = await readLines(path1, fs)
  const file2Lines = await readLines(path2, fs)

  const needsPreprocess =
    opts.ignoreBlankLines || opts.ignoreAllSpace || opts.ignoreSpaceChange || opts.ignoreCase

  const cmp1 = needsPreprocess ? preprocess(file1Lines, opts) : file1Lines
  const cmp2 = needsPreprocess ? preprocess(file2Lines, opts) : file2Lines

  if (opts.brief) {
    if (!arraysEqual(cmp1, cmp2)) {
      stdout.write(`Files ${path1} and ${path2} differ\n`)
    }
    return
  }

  const ops = computeEditScript(cmp1, cmp2)
  if (ops.every((op) => op.type === 'equal')) return

  const hunks = groupIntoHunks(ops, opts.unifiedContext)

  // If preprocess transformed lines, rewrite each diff line back to the
  // original (preserving the prefix). Match Python's `cmp_map` trick.
  let displayCmp1 = cmp1
  let displayCmp2 = cmp2
  if (needsPreprocess) {
    displayCmp1 = file1Lines
    displayCmp2 = file2Lines
  }

  if (opts.context) {
    formatContextDiff(hunks, ops, displayCmp1, displayCmp2, path1, path2, stdout)
  } else {
    formatUnifiedDiff(hunks, ops, displayCmp1, displayCmp2, path1, path2, stdout)
  }
}

async function readLines(path: string, fs: FileSystem): Promise<string[]> {
  let bytes: Uint8Array
  try {
    bytes = await fs.read(path)
  } catch (e) {
    throw new TerminalError(`diff: ${path}: ${describeError(e)}`)
  }
  return splitLinesKeepEnds(decoder.decode(bytes))
}

function preprocess(lines: readonly string[], opts: DiffOptions): string[] {
  let out = [...lines]
  if (opts.ignoreBlankLines) {
    out = out.filter((line) => line.trim().length > 0)
  }
  if (opts.ignoreAllSpace) {
    out = out.map((line) => line.replaceAll(' ', '').replaceAll('\t', ''))
  } else if (opts.ignoreSpaceChange) {
    out = out.map((line) => {
      const hasNl = line.endsWith('\n')
      const stripped = line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, '')
      return hasNl ? `${stripped}\n` : stripped
    })
  }
  if (opts.ignoreCase) {
    out = out.map((line) => line.toLowerCase())
  }
  return out
}

// ---------------------------------------------------------------------------
// Recursive directory diff
// ---------------------------------------------------------------------------

async function diffRecursive(
  dir1: string,
  dir2: string,
  opts: DiffOptions,
  fs: FileSystem,
  stdout: { write: (s: string) => void },
): Promise<void> {
  const d1 = dir1.replace(/\/$/, '')
  const d2 = dir2.replace(/\/$/, '')
  const files1 = await collectFilesRel(fs, d1)
  const files2 = await collectFilesRel(fs, d2)

  const all = new Set<string>([...files1, ...files2])
  for (const rel of [...all].sort()) {
    const p1 = `${d1}/${rel}`
    const p2 = `${d2}/${rel}`
    if (!files1.has(rel)) {
      stdout.write(`Only in ${d2}: ${rel}\n`)
    } else if (!files2.has(rel)) {
      stdout.write(`Only in ${d1}: ${rel}\n`)
    } else {
      await diffPair(p1, p2, opts, fs, stdout)
    }
  }
}

async function collectFilesRel(fs: FileSystem, root: string): Promise<Set<string>> {
  const result = new Set<string>()
  let items: FileInfo[]
  try {
    items = await fs.listDetailed(root, { recursive: true })
  } catch {
    return result
  }
  const stripped = root === '/' ? '' : root.replace(/\/$/, '')
  for (const item of items) {
    if (!item.isDir) {
      let rel = item.path
      if (rel.startsWith(`${stripped}/`)) rel = rel.slice(stripped.length + 1)
      result.add(rel)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Edit script computation
// ---------------------------------------------------------------------------

interface EditOp {
  type: 'equal' | 'insert' | 'delete'
  /** Index into the original `a` array (for `equal` and `delete`). */
  i?: number
  /** Index into the original `b` array (for `equal` and `insert`). */
  j?: number
}

/**
 * Compute an LCS-backed edit script: the sequence of `equal`,
 * `insert`, `delete` ops that transforms `a` into `b`.
 *
 * Uses dynamic programming over the LCS table — O(mn) time and space.
 */
function computeEditScript(a: readonly string[], b: readonly string[]): EditOp[] {
  const m = a.length
  const n = b.length

  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = []
  for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        ;(dp[i] as number[])[j] = ((dp[i - 1] as number[])[j - 1] as number) + 1
      } else {
        ;(dp[i] as number[])[j] = Math.max(
          (dp[i - 1] as number[])[j] as number,
          (dp[i] as number[])[j - 1] as number,
        )
      }
    }
  }

  // Backtrack from (m, n) to (0, 0) collecting ops.
  const ops: EditOp[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: 'equal', i: i - 1, j: j - 1 })
      i--
      j--
    } else if (
      j > 0 &&
      (i === 0 || ((dp[i] as number[])[j - 1] as number) >= ((dp[i - 1] as number[])[j] as number))
    ) {
      ops.push({ type: 'insert', j: j - 1 })
      j--
    } else {
      ops.push({ type: 'delete', i: i - 1 })
      i--
    }
  }
  ops.reverse()
  return ops
}

// ---------------------------------------------------------------------------
// Hunk grouping
// ---------------------------------------------------------------------------

interface Hunk {
  /** First op index in this hunk. */
  startOp: number
  /** Last op index (inclusive). */
  endOp: number
  /** Source-side start line (0-based). */
  aStart: number
  /** Source-side line count. */
  aCount: number
  /** Target-side start line (0-based). */
  bStart: number
  /** Target-side line count. */
  bCount: number
}

function groupIntoHunks(ops: readonly EditOp[], contextN: number): Hunk[] {
  // Find op-index ranges for each non-equal "change cluster" with
  // up to contextN equal ops on either side. Adjacent clusters that
  // overlap (their context boundaries touch) are merged.
  const hunks: Hunk[] = []
  const n = ops.length
  let i = 0
  while (i < n) {
    if (ops[i]?.type === 'equal') {
      i++
      continue
    }
    // Found a change. Walk back up to contextN equals.
    let start = i
    let backCtx = 0
    while (start > 0 && ops[start - 1]?.type === 'equal' && backCtx < contextN) {
      start--
      backCtx++
    }
    // Walk forward through changes + interior equals (up to 2*contextN
    // equals between two changes still merge into one hunk).
    let end = i
    while (end < n) {
      if (ops[end]?.type !== 'equal') {
        end++
        continue
      }
      // Consecutive equals — count and decide whether to break.
      let runEnd = end
      while (runEnd < n && ops[runEnd]?.type === 'equal') runEnd++
      const runLen = runEnd - end
      const hasMoreChanges = runEnd < n
      if (hasMoreChanges && runLen <= 2 * contextN) {
        end = runEnd
        continue
      }
      // Take up to contextN trailing equals as context, stop.
      const take = Math.min(contextN, runLen)
      end = end + take
      break
    }
    if (end > n) end = n

    // Compute aStart/aCount/bStart/bCount from the ops slice.
    let aStart = -1
    let bStart = -1
    let aCount = 0
    let bCount = 0
    for (let k = start; k < end; k++) {
      const op = ops[k] as EditOp
      if (op.type === 'equal') {
        if (aStart < 0 && op.i !== undefined) aStart = op.i
        if (bStart < 0 && op.j !== undefined) bStart = op.j
        aCount++
        bCount++
      } else if (op.type === 'delete') {
        if (aStart < 0 && op.i !== undefined) aStart = op.i
        aCount++
      } else {
        if (bStart < 0 && op.j !== undefined) bStart = op.j
        bCount++
      }
    }

    hunks.push({
      startOp: start,
      endOp: end - 1,
      aStart: Math.max(0, aStart),
      aCount,
      bStart: Math.max(0, bStart),
      bCount,
    })
    i = end
  }
  return hunks
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatUnifiedDiff(
  hunks: readonly Hunk[],
  ops: readonly EditOp[],
  a: readonly string[],
  b: readonly string[],
  pathA: string,
  pathB: string,
  stdout: { write: (s: string) => void },
): void {
  if (hunks.length === 0) return
  stdout.write(`--- ${pathA}\n`)
  stdout.write(`+++ ${pathB}\n`)
  for (const h of hunks) {
    // Unified hunk header: 1-based line numbers, count omitted if 1.
    const aHdr = h.aCount === 1 ? `${h.aStart + 1}` : `${h.aStart + 1},${h.aCount}`
    const bHdr = h.bCount === 1 ? `${h.bStart + 1}` : `${h.bStart + 1},${h.bCount}`
    stdout.write(`@@ -${aHdr} +${bHdr} @@\n`)
    for (let k = h.startOp; k <= h.endOp; k++) {
      const op = ops[k] as EditOp
      const line =
        op.type === 'insert' ? (b[op.j as number] as string) : (a[op.i as number] as string)
      const prefix = op.type === 'equal' ? ' ' : op.type === 'insert' ? '+' : '-'
      stdout.write(`${prefix}${ensureNewline(line)}`)
    }
  }
}

function formatContextDiff(
  hunks: readonly Hunk[],
  ops: readonly EditOp[],
  a: readonly string[],
  b: readonly string[],
  pathA: string,
  pathB: string,
  stdout: { write: (s: string) => void },
): void {
  if (hunks.length === 0) return
  stdout.write(`*** ${pathA}\n`)
  stdout.write(`--- ${pathB}\n`)
  for (const h of hunks) {
    stdout.write('***************\n')
    // Source side
    const aFrom = h.aStart + 1
    const aTo = h.aStart + h.aCount
    stdout.write(`*** ${aFrom},${aTo} ****\n`)
    for (let k = h.startOp; k <= h.endOp; k++) {
      const op = ops[k] as EditOp
      if (op.type === 'insert') continue
      const prefix = op.type === 'equal' ? '  ' : '- '
      stdout.write(`${prefix}${ensureNewline(a[op.i as number] as string)}`)
    }
    // Target side
    const bFrom = h.bStart + 1
    const bTo = h.bStart + h.bCount
    stdout.write(`--- ${bFrom},${bTo} ----\n`)
    for (let k = h.startOp; k <= h.endOp; k++) {
      const op = ops[k] as EditOp
      if (op.type === 'delete') continue
      const prefix = op.type === 'equal' ? '  ' : '+ '
      stdout.write(`${prefix}${ensureNewline(b[op.j as number] as string)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitLinesKeepEnds(text: string): string[] {
  if (text.length === 0) return []
  const lines: string[] = []
  let i = 0
  let lineStart = 0
  while (i < text.length) {
    const c = text[i] as string
    if (c === '\n') {
      lines.push(text.slice(lineStart, i + 1))
      i++
      lineStart = i
    } else if (c === '\r') {
      const end = text[i + 1] === '\n' ? i + 2 : i + 1
      lines.push(text.slice(lineStart, end))
      i = end
      lineStart = end
    } else {
      i++
    }
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart))
  return lines
}

function ensureNewline(line: string): string {
  return line.endsWith('\n') ? line : `${line}\n`
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function numericFlag(raw: string | boolean | string[] | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? fallback : n
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
