/**
 * Pipeline executor.
 *
 * Walks a `Script` AST, runs each pipeline through the chain of its
 * commands (stdout → stdin), honors redirects (`<`, `>`, `>>`),
 * threads exit codes through `&&` / `||`, and accumulates stdout
 * into a single returned string.
 *
 * Cancellation: every iteration boundary (between pipelines, between
 * commands within a pipeline, before each redirect read) checks
 * `signal.aborted`. Loop-heavy builtins are responsible for
 * checking inside their own loops.
 *
 * Error model: command failures throw `TerminalError`. The script-
 * level catch swallows the failure of an individual pipeline (so
 * `||` can still rescue it), but re-throws at the end with the
 * accumulated `partialOutput` if the *last* pipeline failed.
 */

import type { Pipeline, Script } from './ast'
import { BUILTINS } from './builtins/index'
import type { CommandContext, CommandHandler } from './context'
import { TerminalError } from './errors'
import type { FileSystem } from './fs/protocol'
import { glob } from './glob'
import { toScript } from './parser'
import { maskQuotes, unmaskAndUnquote } from './quote-masker'

export interface ExecuteOptions {
  /** Custom commands. Override builtins on name collision.
   *  Pass either a `Map` or a plain object; both are accepted. */
  commands?: ReadonlyMap<string, CommandHandler> | Readonly<Record<string, CommandHandler>>
  /** Cooperative cancellation. Default: never aborts. */
  signal?: AbortSignal
}

const NEVER_ABORT = new AbortController().signal
const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

/**
 * Convenience: parse + execute. Matches termish-py's top-level
 * `execute(script_text, fs, commands=None)`.
 */
export async function execute(
  scriptText: string,
  fs: FileSystem,
  opts: ExecuteOptions = {},
): Promise<string> {
  return executeScript(toScript(scriptText), fs, opts)
}

/**
 * Execute a parsed `Script` against `fs`. Returns accumulated stdout.
 *
 * Throws `TerminalError` if the *last* pipeline failed. Earlier
 * pipeline failures are absorbed into the `&&` / `||` flow and the
 * partial output continues accumulating.
 */
export async function executeScript(
  script: Script,
  fs: FileSystem,
  opts: ExecuteOptions = {},
): Promise<string> {
  const commands = mergeCommands(opts.commands)
  const signal = opts.signal ?? NEVER_ABORT
  const out: { value: string } = { value: '' }

  let lastSucceeded = true
  let lastError: TerminalError | null = null

  for (let i = 0; i < script.pipelines.length; i++) {
    if (signal.aborted) throw new TerminalError('aborted', out.value)

    if (i > 0) {
      const op = script.operators[i - 1]
      if (op === '&&' && !lastSucceeded) continue
      if (op === '||' && lastSucceeded) continue
    }

    try {
      await executePipeline(script.pipelines[i] as Pipeline, fs, commands, signal, out)
      lastSucceeded = true
      lastError = null
    } catch (e) {
      lastSucceeded = false
      lastError =
        e instanceof TerminalError ? e : new TerminalError(`Unexpected error: ${describeError(e)}`)
    }
  }

  if (lastError !== null) {
    throw new TerminalError(lastError.message, out.value)
  }
  return out.value
}

async function executePipeline(
  pipeline: Pipeline,
  fs: FileSystem,
  commands: ReadonlyMap<string, CommandHandler>,
  signal: AbortSignal,
  out: { value: string },
): Promise<void> {
  if (pipeline.commands.length === 0) return

  let pipedInput = ''

  for (const cmd of pipeline.commands) {
    if (signal.aborted) throw new TerminalError('aborted')

    // Input redirect overrides piped stdin.
    let stdin = pipedInput
    const inputRedirect = cmd.redirects.find((r) => r.type === '<')
    if (inputRedirect) {
      const target = expandPath(inputRedirect.target)
      try {
        const bytes = await fs.read(target)
        stdin = decoder.decode(bytes)
      } catch (e) {
        throw new TerminalError(`${cmd.name}: ${target}: ${describeError(e)}`)
      }
    }

    const expandedArgs = await expandArgs(cmd.args, fs)
    const handler = commands.get(cmd.name)
    if (handler === undefined) {
      throw new TerminalError(`${cmd.name}: command not found`)
    }

    const captured = new StringStdout()
    const ctx: CommandContext = {
      args: expandedArgs,
      stdin,
      stdout: captured,
      fs,
      env: {},
      signal,
      commands,
    }

    let result: Awaited<ReturnType<CommandHandler>>
    try {
      result = await handler(ctx)
    } catch (e) {
      if (e instanceof TerminalError) throw e
      throw new TerminalError(`${cmd.name}: execution error: ${describeError(e)}`)
    }

    if (result !== undefined && result.exitCode !== 0) {
      const msg = result.stderr
        ? `${cmd.name}: ${result.stderr}`
        : `${cmd.name}: exited with code ${result.exitCode}`
      throw new TerminalError(msg)
    }

    const captureValue = captured.value()

    // Output redirects shunt stdout to file; the pipeline gets nothing.
    const outputRedirects = cmd.redirects.filter((r) => r.type === '>' || r.type === '>>')
    if (outputRedirects.length > 0) {
      for (const r of outputRedirects) {
        const target = expandPath(r.target)
        try {
          await fs.write(target, encoder.encode(captureValue), r.type === '>>' ? 'a' : 'w')
        } catch (e) {
          throw new TerminalError(`${cmd.name}: redirect failed: ${describeError(e)}`)
        }
      }
      pipedInput = ''
    } else {
      pipedInput = captureValue
    }
  }

  if (pipedInput.length > 0) out.value += pipedInput
}

/**
 * Expand each arg through the same masker the parser uses, then
 * either glob-expand (unquoted, contains `*` or `?`) or strip
 * outer quotes (anything else). Matches termish-py's `_expand_args`.
 */
async function expandArgs(args: readonly string[], fs: FileSystem): Promise<string[]> {
  const out: string[] = []
  for (const arg of args) {
    const { masked, map } = maskQuotes(arg)
    const hasUnquotedGlob = (masked.includes('*') || masked.includes('?')) && map.size === 0
    if (hasUnquotedGlob) {
      try {
        const matches = await glob(arg, fs)
        if (matches.length > 0) out.push(...matches)
        else out.push(arg)
      } catch {
        out.push(arg)
      }
    } else {
      out.push(unmaskAndUnquote(masked, map))
    }
  }
  return out
}

/** Strip outer quotes from a redirect target. Glob expansion does
 *  NOT apply to redirect targets — bash allows it but the semantics
 *  are confusing; matching termish-py here. */
function expandPath(target: string): string {
  const { masked, map } = maskQuotes(target)
  return unmaskAndUnquote(masked, map)
}

/** Merge host-injected commands on top of BUILTINS into a single
 *  read-only registry. Host entries override builtins by name. The
 *  merged map becomes `ctx.commands`, so builtins like xargs and
 *  `find -exec` see the same surface the top-level pipeline does. */
function mergeCommands(commands: ExecuteOptions['commands']): ReadonlyMap<string, CommandHandler> {
  if (commands === undefined) return BUILTINS
  const host = commands instanceof Map ? commands : new Map(Object.entries(commands))
  if (host.size === 0) return BUILTINS
  const merged = new Map<string, CommandHandler>(BUILTINS)
  for (const [name, handler] of host) merged.set(name, handler)
  return merged
}

class StringStdout {
  readonly #parts: string[] = []
  write(s: string): void {
    this.#parts.push(s)
  }
  value(): string {
    return this.#parts.join('')
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
