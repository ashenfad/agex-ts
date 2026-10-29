/**
 * Tool results as the model reads them, as nontainer renders them:
 * output first, then what went wrong, each part marked.
 */

import type { SerializedError } from '../kernel/messages'
import { artifactsNote, guardUiLines } from '../ui'
import type { CodeResult, TerminalResult } from '../workspace'

/** A terminal result: stdout, `[exit code N]`, `[stderr]`, `[output
 *  truncated]`; `(no output)` when there's nothing. */
export function renderTerminal(r: TerminalResult): string {
  const parts: string[] = []
  const stdout = r.stdout.replace(/\n+$/, '')
  if (stdout !== '') parts.push(stdout)
  if (r.exitCode !== 0) parts.push(`[exit code ${r.exitCode}]`)
  if (r.stderr.trim() !== '') parts.push(`[stderr]\n${r.stderr.trimEnd()}`)
  if (r.truncated) parts.push('[output truncated]')
  return parts.length === 0 ? '(no output)' : parts.join('\n')
}

/** A run_ts result: stdout, the returned value, `[error]` (with a
 *  `[hint: …]` when one applies), `[stderr]`, `[output truncated]`,
 *  then `[ui artifacts: …]` and a `[ui note: …]` for each value that
 *  gave none; `(no output; success)` when there's nothing. */
export function renderCode(r: CodeResult, ctx: HintContext = {}): string {
  const parts: string[] = []
  const stdout = r.stdout.replace(/\n+$/, '')
  if (stdout !== '') parts.push(stdout)
  if (r.value !== null) parts.push(`[returned]\n${r.value}`)
  if (r.error !== null) {
    parts.push(`[error]\n${errorText(r.error).trimEnd()}`)
    const hint = errorHint(r.error, ctx)
    if (hint !== null) parts.push(`[hint: ${hint}]`)
  }
  if (r.stderr.trim() !== '') parts.push(`[stderr]\n${r.stderr.trimEnd()}`)
  if (r.truncated) parts.push('[output truncated]')
  // what the code printed or returned can't pose as the ui lines
  const ui: string[] = []
  const artifacts = artifactsNote(r.artifacts ?? [])
  if (artifacts !== '') ui.push(artifacts)
  for (const note of r.uiNotes ?? []) ui.push(`[ui note: ${guardUiLines(note)}]`)
  if (parts.length === 0 && ui.length === 0) return '(no output; success)'
  return [...parts.map(guardUiLines), ...ui].join('\n')
}

/** An error as the model reads it: its stack of the code's own frames
 *  (the kernel keeps only those), or its name and message. */
export function errorText(e: SerializedError): string {
  const head = `${e.name}: ${e.message}`
  if (e.stack === undefined) return head
  return e.stack.startsWith(head) ? e.stack : `${head}\n${e.stack}`
}

export interface HintContext {
  /** Bare imports resolve (the profile has a `resolve`). */
  readonly resolver?: boolean
}

/** A pointer past an error agents hit often in this kernel; null for
 *  the rest. */
export function errorHint(e: SerializedError, ctx: HintContext = {}): string | null {
  const text = `${e.name}: ${e.message}`
  if (/\brequire is not defined\b/.test(text)) {
    return 'code here is an ES module body: import instead of require (import { x } from "pkg")'
  }
  if (/\b(process|Buffer|__dirname|__filename) is not defined\b/.test(text)) {
    return 'this is a sandboxed worker, not Node: there is no process, Buffer or __dirname; use fs, env and Uint8Array'
  }
  if (/\b(fs|cache|env) is not defined\b/.test(text)) {
    return "fs, cache and env are bound only in run_ts's code, not in a module: pass what a module needs to its functions as arguments"
  }
  const missing = /Cannot find module '([^']+)'/.exec(text)
  if (missing !== null && !/^[./]/.test(missing[1] as string)) {
    return ctx.resolver === true
      ? `no package '${missing[1]}' could be loaded: check its name`
      : 'packages are not available here: import your own modules by path (./lib/x.ts), or write what you need'
  }
  if (e.name === 'TimeoutError') {
    return 'do less in one call: split the work across calls, keeping intermediate results in files or the cache'
  }
  return null
}
