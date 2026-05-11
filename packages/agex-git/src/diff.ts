/**
 * Unified-diff helpers for the agent-view git CLI.
 *
 * Wraps the npm `diff` package's `structuredPatch` and formats the
 * output to match `git diff --no-color` (`--- a/path` / `+++ b/path` /
 * `@@ ... @@` headers + `+` / `-` / ` ` content lines). The npm
 * package's `createPatch` would also work but adds an `Index:` header
 * we don't want; assembling from `structuredPatch` keeps the output
 * shape git-compatible.
 *
 * Binary detection is intentionally simple: a NUL byte in the first
 * 8KB. Mirrors the agex-py `is_binary` heuristic.
 */

import { structuredPatch } from 'diff'

/**
 * Render a unified diff between two text contents. The header lines
 * use `a/<oldName>` and `b/<newName>` to match git's convention; pass
 * the file's display path (decoded from the kvgit key) for both.
 *
 * Empty diff (`oldText === newText`) returns the empty string — the
 * caller can then skip the file in the rendered output.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  oldName: string,
  newName: string,
): string {
  if (oldText === newText) return ''
  const patch = structuredPatch(`a/${oldName}`, `b/${newName}`, oldText, newText, '', '', {
    context: 3,
  })
  if (patch.hunks.length === 0) return ''
  const out: string[] = [`--- a/${oldName}\n`, `+++ b/${newName}\n`]
  for (const hunk of patch.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`)
    for (const line of hunk.lines) {
      // `diff` strips the trailing newline from each line; restore it
      // unless this is the "no newline at end of file" marker.
      if (line.startsWith('\\')) {
        out.push(`${line}\n`)
      } else {
        out.push(`${line}\n`)
      }
    }
  }
  return out.join('')
}

/**
 * Heuristic: content is binary if it contains a NUL byte in the first
 * 8KB. Returns `false` for `null` / `undefined` so the caller can
 * pass either a missing file (added/removed) or empty bytes without
 * branching.
 */
export function isBinary(data: Uint8Array | null | undefined): boolean {
  if (data === null || data === undefined) return false
  const limit = Math.min(data.byteLength, 8192)
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0) return true
  }
  return false
}
