import type { PatchEmission, VirtualFileSystem } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

interface HunkLine {
  readonly kind: 'context' | 'add' | 'delete'
  readonly text: string
}

interface PatchHunk {
  /** One-based line in the normalized patch where this hunk starts. */
  readonly sourceLine: number
  readonly oldStart?: number
  readonly anchor?: string
  readonly endOfFile: boolean
  readonly lines: ReadonlyArray<HunkLine>
}

type PatchChange =
  | {
      readonly kind: 'add'
      readonly path: string
      readonly content: string
      readonly sourceLine: number
    }
  | { readonly kind: 'delete'; readonly path: string; readonly sourceLine: number }
  | {
      readonly kind: 'update'
      readonly path: string
      readonly movePath?: string
      readonly hunks: ReadonlyArray<PatchHunk>
      readonly sourceLine: number
    }

interface FileSnapshot {
  readonly exists: boolean
  readonly content: string
}

interface WriteOperation {
  readonly kind: 'write'
  readonly path: string
  readonly content: string
}

interface RemoveOperation {
  readonly kind: 'remove'
  readonly path: string
}

type Operation = WriteOperation | RemoveOperation

export interface ApplyPatchResult {
  /** Logical Add/Delete/Update sections in the patch. */
  readonly changeCount: number
  /** Resolved VFS paths whose final state changed. */
  readonly paths: ReadonlyArray<string>
  /** Stable text returned to the model as the tool result. */
  readonly summary: string
}

/**
 * Apply the `*** Begin Patch` format used by Codex and OpenAI coding
 * models. The patch is fully parsed and validated against a staged
 * snapshot before any VFS mutation occurs. Commit-time I/O failures
 * trigger a best-effort rollback to the original file contents.
 */
export async function dispatchApplyPatch(
  emission: PatchEmission,
  fs: VirtualFileSystem,
): Promise<ApplyPatchResult> {
  let changes: ReadonlyArray<PatchChange>
  try {
    changes = parseApplyPatch(emission.patch)
  } catch (error) {
    throw noFilesChanged(error)
  }
  const originals = new Map<string, FileSnapshot>()
  const staged = new Map<string, string | null>()
  const operations: Operation[] = []

  const readOriginal = async (path: string): Promise<FileSnapshot> => {
    const known = originals.get(path)
    if (known !== undefined) return known
    const exists = await fs.exists(path)
    const snapshot: FileSnapshot = exists
      ? { exists: true, content: decoder.decode(await fs.read(path)) }
      : { exists: false, content: '' }
    originals.set(path, snapshot)
    return snapshot
  }

  const current = async (path: string): Promise<string | null> => {
    if (staged.has(path)) return staged.get(path) ?? null
    const original = await readOriginal(path)
    const value = original.exists ? original.content : null
    staged.set(path, value)
    return value
  }

  try {
    for (const change of changes) {
      const path = resolveVfsPath(change.path, fs.getcwd())
      if (change.kind === 'add') {
        if ((await current(path)) !== null) {
          throw new Error(
            `apply_patch: ${path}: file already exists (patch line ${change.sourceLine})`,
          )
        }
        staged.set(path, change.content)
        operations.push({ kind: 'write', path, content: change.content })
        continue
      }
      if (change.kind === 'delete') {
        if ((await current(path)) === null) {
          throw new Error(`apply_patch: ${path}: no such file (patch line ${change.sourceLine})`)
        }
        staged.set(path, null)
        operations.push({ kind: 'remove', path })
        continue
      }

      const source = await current(path)
      if (source === null) {
        throw new Error(`apply_patch: ${path}: no such file (patch line ${change.sourceLine})`)
      }
      const content = applyHunks(path, source, change.hunks)
      if (change.movePath !== undefined) {
        const movePath = resolveVfsPath(change.movePath, fs.getcwd())
        if (movePath !== path && (await current(movePath)) !== null) {
          throw new Error(
            `apply_patch: ${movePath}: move destination already exists (patch line ${change.sourceLine})`,
          )
        }
        staged.set(movePath, content)
        staged.set(path, null)
        operations.push({ kind: 'write', path: movePath, content })
        if (movePath !== path) operations.push({ kind: 'remove', path })
      } else {
        staged.set(path, content)
        operations.push({ kind: 'write', path, content })
      }
    }

    // Ensure rollback has a snapshot for every destination before the
    // first mutation. Source paths were already loaded during validation.
    for (const operation of operations) await readOriginal(operation.path)
  } catch (error) {
    throw noFilesChanged(error)
  }

  let committedOperations = 0
  try {
    for (const operation of operations) {
      if (operation.kind === 'write') {
        await ensureParentDir(operation.path, fs)
        await fs.write(operation.path, encoder.encode(operation.content), 'w')
      } else {
        await fs.remove(operation.path)
      }
      committedOperations++
    }
  } catch (error) {
    const rollbackFailures = await rollback(originals, fs)
    const cause = describeError(error)
    if (rollbackFailures.length === 0) {
      throw new Error(
        `apply_patch: commit failed after ${committedOperations} of ${operations.length} filesystem operations: ${cause}. Rollback succeeded; no files were changed.`,
      )
    }
    throw new Error(
      `apply_patch: commit failed after ${committedOperations} of ${operations.length} filesystem operations: ${cause}. Rollback was incomplete for ${formatPaths(rollbackFailures)}; the workspace may contain partial changes.`,
    )
  }

  const paths = [...staged.entries()]
    .filter(([path, value]) => {
      const original = originals.get(path)
      const originalValue = original?.exists === true ? original.content : null
      return originalValue !== value
    })
    .map(([path]) => path)
  const counts = countChanges(changes)
  const details = [
    counts.add > 0 ? `${counts.add} added` : '',
    counts.update > 0 ? `${counts.update} updated` : '',
    counts.delete > 0 ? `${counts.delete} deleted` : '',
    counts.move > 0 ? `${counts.move} moved` : '',
  ].filter(Boolean)
  const summary = `apply_patch: applied ${changes.length} ${pluralize(changes.length, 'change')} across ${paths.length} ${pluralize(paths.length, 'path')} (${details.join(', ')}); transaction committed`
  return { changeCount: changes.length, paths, summary }
}

export function parseApplyPatch(patch: string): ReadonlyArray<PatchChange> {
  const lines = normalizePatchLines(patch)
  let index = 1
  const changes: PatchChange[] = []
  while (index < lines.length) {
    const line = lines[index] as string
    const trimmed = line.trim()
    const sourceLine = index + 1
    if (trimmed === '*** End Patch') {
      if (changes.length === 0) throw new Error('apply_patch: patch contains no file changes')
      if (lines.slice(index + 1).some((trailing) => trailing.trim().length > 0)) {
        throw new Error('apply_patch: unexpected content after *** End Patch')
      }
      return changes
    }

    const add = trimmed.match(/^\*\*\* Add File: (.+)$/u)
    if (add) {
      const path = requirePath(add[1], sourceLine)
      index++
      const content: string[] = []
      while (index < lines.length && !isOuterFileHeader(lines[index] as string)) {
        const contentLine = lines[index] as string
        if (!contentLine.startsWith('+')) {
          throw invalidHunk(
            index + 1,
            `'${displayLine(contentLine)}' is not a valid added-file line for '${path}'. Every added-file line must start with '+'`,
          )
        }
        content.push(contentLine.slice(1))
        index++
      }
      changes.push({
        kind: 'add',
        path,
        content: content.length > 0 ? `${content.join('\n')}\n` : '',
        sourceLine,
      })
      continue
    }

    const deletion = trimmed.match(/^\*\*\* Delete File: (.+)$/u)
    if (deletion) {
      changes.push({
        kind: 'delete',
        path: requirePath(deletion[1], sourceLine),
        sourceLine,
      })
      index++
      continue
    }

    const update = trimmed.match(/^\*\*\* Update File: (.+)$/u)
    if (update) {
      const path = requirePath(update[1], sourceLine)
      index++
      let movePath: string | undefined
      const move = (lines[index] as string | undefined)?.trimEnd().match(/^\*\*\* Move to: (.+)$/u)
      if (move) {
        movePath = requirePath(move[1], index + 1)
        index++
      }
      const hunks: PatchHunk[] = []
      let active: MutablePatchHunk | undefined
      const finishActive = (triggerLine: number): void => {
        if (active === undefined) return
        if (active.lines.length === 0) {
          throw invalidHunk(triggerLine, `Update hunk for '${path}' does not contain any lines`)
        }
        hunks.push({
          sourceLine: active.sourceLine,
          ...(active.oldStart !== undefined && { oldStart: active.oldStart }),
          ...(active.anchor !== undefined && { anchor: active.anchor }),
          endOfFile: active.endOfFile,
          lines: active.lines,
        })
        active = undefined
      }

      while (index < lines.length && !isUpdateBoundary(lines[index] as string)) {
        const hunkLine = lines[index] as string
        const updateLine = hunkLine.trimEnd()
        const hunkSourceLine = index + 1

        if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
          finishActive(hunkSourceLine)
          active = {
            sourceLine: hunkSourceLine,
            ...parseHunkHeader(updateLine, hunkSourceLine),
            endOfFile: false,
            lines: [],
          }
          index++
          continue
        }

        if (updateLine === '*** End of File') {
          if (active === undefined || active.lines.length === 0) {
            throw invalidHunk(
              hunkSourceLine,
              `Update hunk for '${path}' does not contain any lines`,
            )
          }
          active.endOfFile = true
          index++
          continue
        }

        if (hunkLine === '\\ No newline at end of file') {
          index++
          continue
        }

        if (active?.endOfFile === true) {
          if (updateLine.length === 0) {
            index++
            continue
          }
          throw invalidHunk(
            hunkSourceLine,
            `Expected the next update hunk for '${path}' to start with a @@ context marker, got: '${displayLine(hunkLine)}'`,
          )
        }

        if (active === undefined) {
          // Codex accepts an omitted @@ marker for the first update
          // chunk. The first diff line becomes an implicit hunk.
          active = {
            sourceLine: hunkSourceLine,
            endOfFile: false,
            lines: [],
          }
        }

        if (hunkLine.length === 0) {
          // Match Codex's leniency: a bare blank line in an update
          // hunk is an empty context line, as if it were written " ".
          active.lines.push({ kind: 'context', text: '' })
          index++
          continue
        }

        const prefix = hunkLine[0]
        if (prefix === ' ' || prefix === '+' || prefix === '-') {
          active.lines.push({
            kind: prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'delete',
            text: hunkLine.slice(1),
          })
          index++
          continue
        }

        const message =
          active.lines.length > 0
            ? `Expected the next update hunk for '${path}' to start with a @@ context marker, got: '${displayLine(hunkLine)}'`
            : `Unexpected line in update hunk for '${path}': '${displayLine(hunkLine)}'. Every line must start with ' ' (context), '+' (added), or '-' (removed)`
        throw invalidHunk(hunkSourceLine, message)
      }
      finishActive(Math.min(index + 1, lines.length))
      if (hunks.length === 0) {
        throw invalidHunk(sourceLine, `Update file hunk for '${path}' is empty`)
      }
      changes.push({
        kind: 'update',
        path,
        ...(movePath !== undefined && { movePath }),
        hunks,
        sourceLine,
      })
      continue
    }

    throw invalidHunk(
      sourceLine,
      `'${displayLine(line)}' is not a valid hunk header. Expected '*** Add File: {path}', '*** Delete File: {path}', or '*** Update File: {path}'`,
    )
  }
  throw new Error('apply_patch: missing *** End Patch')
}

interface MutablePatchHunk {
  readonly sourceLine: number
  readonly oldStart?: number
  readonly anchor?: string
  endOfFile: boolean
  readonly lines: HunkLine[]
}

function normalizePatchLines(patch: string): string[] {
  let lines = patch.replace(/\r\n?/gu, '\n').trim().split('\n')
  const first = lines[0]
  const last = lines.at(-1)
  if (
    lines.length >= 4 &&
    (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
    last?.endsWith('EOF') === true
  ) {
    lines = lines.slice(1, -1)
  }
  if (lines[0]?.trim() !== '*** Begin Patch') {
    throw new Error("apply_patch: the first line must be '*** Begin Patch'")
  }
  if (lines.at(-1)?.trim() !== '*** End Patch') {
    throw new Error("apply_patch: the last line must be '*** End Patch'")
  }
  return lines
}

function parseHunkHeader(
  header: string,
  sourceLine: number,
): Pick<PatchHunk, 'oldStart' | 'anchor'> {
  const standard = header.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)$/u)
  if (standard) return { oldStart: Number(standard[1]) }
  const custom = header.match(/^@@(?: (.*))?$/u)
  if (!custom) throw invalidHunk(sourceLine, `Invalid @@ hunk header: '${displayLine(header)}'`)
  const anchor = custom[1]?.trim()
  return anchor ? { anchor } : {}
}

function applyHunks(path: string, source: string, hunks: ReadonlyArray<PatchHunk>): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replace(/\r\n/gu, '\n')
  const hadTrailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (hadTrailingNewline) lines.pop()
  let cursor = 0

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text)
    const newLines = hunk.lines.filter((line) => line.kind !== 'delete').map((line) => line.text)
    let searchStart = cursor
    if (hunk.oldStart !== undefined) searchStart = Math.max(0, hunk.oldStart - 1)
    if (hunk.anchor !== undefined) {
      const anchorIndex = lines.indexOf(hunk.anchor, cursor)
      if (anchorIndex < 0) {
        throw new Error(
          `apply_patch: ${path}: hunk starting at patch line ${hunk.sourceLine} could not find anchor '${hunk.anchor}'`,
        )
      }
      searchStart = anchorIndex + 1
    }
    const at = locateSequence(lines, oldLines, searchStart, hunk.endOfFile)
    if (at < 0) {
      const suffix = hunk.endOfFile
        ? ' at end of file'
        : ` at or after file line ${searchStart + 1}`
      throw new Error(
        `apply_patch: ${path}: hunk starting at patch line ${hunk.sourceLine} could not find the expected context${suffix}: ${formatContext(oldLines)}`,
      )
    }
    lines.splice(at, oldLines.length, ...newLines)
    cursor = at + newLines.length
  }

  const joined = lines.join(newline)
  return hadTrailingNewline ? `${joined}${newline}` : joined
}

function locateSequence(
  lines: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  start: number,
  endOfFile: boolean,
): number {
  if (expected.length === 0) return endOfFile ? lines.length : Math.min(start, lines.length)
  for (
    let index = Math.min(start, lines.length);
    index + expected.length <= lines.length;
    index++
  ) {
    if (endOfFile && index + expected.length !== lines.length) continue
    if (expected.every((line, offset) => lines[index + offset] === line)) return index
  }
  return -1
}

function isOuterFileHeader(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === '*** End Patch' ||
    trimmed.startsWith('*** Add File: ') ||
    trimmed.startsWith('*** Delete File: ') ||
    trimmed.startsWith('*** Update File: ')
  )
}

/** In an update body, leading space is a valid context prefix, so only
 * markers that begin in column 1 terminate the current file section. */
function isUpdateBoundary(line: string): boolean {
  const trimmedEnd = line.trimEnd()
  return (
    trimmedEnd === '*** End Patch' ||
    trimmedEnd.startsWith('*** Add File: ') ||
    trimmedEnd.startsWith('*** Delete File: ') ||
    trimmedEnd.startsWith('*** Update File: ')
  )
}

function requirePath(value: string | undefined, sourceLine: number): string {
  const path = value?.trim()
  if (!path) throw invalidHunk(sourceLine, 'File path cannot be empty')
  return path
}

function resolveVfsPath(path: string, cwd: string): string {
  const combined = path.startsWith('/') ? path : `${cwd.replace(/\/$/u, '')}/${path}`
  const segments: string[] = []
  for (const part of combined.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return `/${segments.join('/')}`
}

async function ensureParentDir(path: string, fs: VirtualFileSystem): Promise<void> {
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return
  await fs.mkdir(path.slice(0, slash), { parents: true, existOk: true })
}

async function rollback(
  originals: ReadonlyMap<string, FileSnapshot>,
  fs: VirtualFileSystem,
): Promise<string[]> {
  const entries = [...originals]
  const results = await Promise.allSettled(
    entries.map(async ([path, snapshot]) => {
      if (snapshot.exists) {
        await ensureParentDir(path, fs)
        await fs.write(path, encoder.encode(snapshot.content), 'w')
      } else if (await fs.exists(path)) {
        await fs.remove(path)
      }
    }),
  )
  return results.flatMap((result, index) =>
    result.status === 'rejected' ? [entries[index]?.[0] ?? '(unknown path)'] : [],
  )
}

function invalidHunk(sourceLine: number, message: string): Error {
  return new Error(`apply_patch: invalid hunk at line ${sourceLine}: ${message}`)
}

function displayLine(line: string): string {
  return line.length === 0 ? '(empty line)' : line
}

function formatContext(lines: ReadonlyArray<string>): string {
  if (lines.length === 0) return '(empty insertion context)'
  const preview = lines
    .slice(0, 3)
    .map((line) => JSON.stringify(line))
    .join(', ')
  return lines.length > 3 ? `[${preview}, …]` : `[${preview}]`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noFilesChanged(error: unknown): Error {
  const message = describeError(error)
  if (message.endsWith('No files were changed.')) return new Error(message)
  return new Error(`${message}. No files were changed.`)
}

function formatPaths(paths: ReadonlyArray<string>): string {
  return paths.map((path) => `'${path}'`).join(', ')
}

function countChanges(changes: ReadonlyArray<PatchChange>): {
  readonly add: number
  readonly update: number
  readonly delete: number
  readonly move: number
} {
  let add = 0
  let update = 0
  let deleted = 0
  let move = 0
  for (const change of changes) {
    if (change.kind === 'add') add++
    else if (change.kind === 'delete') deleted++
    else if (change.movePath !== undefined) move++
    else update++
  }
  return { add, update, delete: deleted, move }
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}
