/**
 * Pipeline executor.
 *
 * Walks a `Script` AST: runs each pipeline's commands with one stage's
 * stdout as the next one's stdin, honors redirects (`<`, `<<`, `>`,
 * `>>`, `2>`, `2>>`, `2>&1`, with `/dev/null` as a sink and an empty
 * source), expands braces, then `$NAME`, `${NAME}` and `$?`, then
 * globs, threads exit codes through `&&` / `||`, and returns the
 * transcript.
 *
 * `$PWD` is the current directory, whatever the environment says. A
 * variable that isn't set is an error that stops the script, as under
 * bash's `set -u`: with no assignment in the language, every variable
 * comes from the host, so an unset one is a mistake, and `cd $DIR`
 * or `rm -r $DIR/x` must not run as `cd` or `rm -r /x`.
 *
 * Pipes and redirects carry bytes; the transcript is decoded once, at
 * the end. It is what a terminal would have shown: stdout, plus the
 * stderr of failures execution continued past, and warnings from
 * commands that succeeded.
 *
 * Cancellation: every iteration boundary (between pipelines, between
 * commands within a pipeline) checks `signal.aborted`. Loop-heavy
 * builtins check inside their own loops.
 *
 * Error model: a failing command throws `TerminalError`. A pipeline's
 * failure is absorbed so `||` can rescue it, and its diagnostic shows
 * in the transcript once execution continues past it. If the *last*
 * pipeline failed, the script throws, carrying the transcript as
 * `partialOutput` and the failure's exit code.
 */

import type { Pipeline, Redirect, Script } from './ast'
import { expandBraces, parameterEnd } from './brace'
import { BUILTINS } from './builtins/index'
import { ByteStdin, ByteStdout, EMPTY, concat, decode, encode } from './bytes'
import type { CommandContext, CommandHandler, CommandResult } from './context'
import { TerminalError, commandFailure } from './errors'
import { describeFsError } from './fs/errors'
import { resolve } from './fs/path'
import type { FileSystem } from './fs/protocol'
import { toScript } from './parser'
import { expand as expandPathname, hasMagic } from './pathglob'
import { maskQuotes, unmaskAndUnquote } from './quote-masker'

export interface ExecuteOptions {
  /** Custom commands. Override builtins on name collision.
   *  Pass either a `Map` or a plain object; both are accepted. */
  commands?: ReadonlyMap<string, CommandHandler> | Readonly<Record<string, CommandHandler>>
  /** Environment variables for `$NAME` expansion. The object is shared
   *  with command handlers as `ctx.env`, so a change a handler makes is
   *  visible to later commands and to the caller. Default: empty. A
   *  host should set `HOME`; `$PWD` is always the current directory. */
  env?: Record<string, string>
  /** Cooperative cancellation. Default: never aborts. */
  signal?: AbortSignal
  /** Maximum characters of the transcript returned to the caller.
   *  When exceeded, output is sliced to the limit and a single-line
   *  marker is appended:
   *
   *    `\n<truncated: N more characters — use head/tail/grep/sed to read a specific range>\n`
   *
   *  Applied once, at the executeScript boundary — intra-pipeline
   *  buffers (e.g. `cat huge.json | grep key`) are not affected.
   *  Also applied to the `partialOutput` carried on a thrown
   *  `TerminalError`. Default: no cap. Embedders that hand the output
   *  to an LLM should set this to bound input-token cost. */
  maxOutputChars?: number
}

/** The redirect target that discards: written to, nothing is kept;
 *  read from, it is empty. Never a file in the filesystem. */
export const DEV_NULL = '/dev/null'

/** The exit code of a script stopped by its signal (as for SIGINT). */
const ABORTED = 130

const NEVER_ABORT = new AbortController().signal

/** `$NAME` with `NAME` unset: the command doesn't run, nor anything
 *  after it. */
class UnboundVariable extends TerminalError {
  constructor(name: string) {
    super(`${name}: unbound variable`)
  }
}

/**
 * Convenience: parse + execute. Matches termish-py's top-level
 * `execute(script_text, fs, commands=None, env=None)`.
 */
export async function execute(
  scriptText: string,
  fs: FileSystem,
  opts: ExecuteOptions = {},
): Promise<string> {
  return executeScript(toScript(scriptText), fs, opts)
}

interface Run {
  readonly fs: FileSystem
  readonly commands: ReadonlyMap<string, CommandHandler>
  readonly signal: AbortSignal
  readonly env: Record<string, string>
  /** What `$?` expands to: the last pipeline's exit code. */
  readonly lastExitCode: number
  /** The transcript so far, as the bytes the commands emitted. */
  readonly transcript: Uint8Array[]
}

/**
 * Execute a parsed `Script` against `fs`. Returns the transcript.
 *
 * Throws `TerminalError` if the *last* pipeline failed. Earlier
 * pipeline failures are absorbed into the `&&` / `||` flow, and their
 * diagnostics join the transcript.
 */
export async function executeScript(
  script: Script,
  fs: FileSystem,
  opts: ExecuteOptions = {},
): Promise<string> {
  const commands = mergeCommands(opts.commands)
  const signal = opts.signal ?? NEVER_ABORT
  const env = opts.env ?? {}
  const cap = (text: string): string => applyOutputCap(text, opts.maxOutputChars)
  const transcript: Uint8Array[] = []

  let lastSucceeded = true
  let lastError: TerminalError | null = null
  let lastExitCode = 0
  // The diagnostic of the latest failure, not yet shown. A terminal
  // prints stderr as it happens; it joins the transcript once execution
  // goes on past the failure. If nothing runs after it, the failure is
  // the script's outcome and its diagnostic travels on the thrown error
  // instead, so it is never shown twice.
  let pendingDiagnostic = ''

  for (let i = 0; i < script.pipelines.length; i++) {
    if (signal.aborted) {
      throw new TerminalError('aborted', {
        partialOutput: cap(decode(concat(transcript))),
        exitCode: ABORTED,
      })
    }

    if (i > 0) {
      const op = script.operators[i - 1]
      if (op === '&&' && !lastSucceeded) continue
      if (op === '||' && lastSucceeded) continue
    }

    if (pendingDiagnostic) transcript.push(encode(pendingDiagnostic))
    pendingDiagnostic = ''

    try {
      await executePipeline(script.pipelines[i] as Pipeline, {
        fs,
        commands,
        signal,
        env,
        lastExitCode,
        transcript,
      })
      lastSucceeded = true
      lastError = null
      lastExitCode = 0
    } catch (e) {
      if (e instanceof UnboundVariable) {
        throw new TerminalError(e.message, {
          partialOutput: cap(decode(concat(transcript))),
          exitCode: e.exitCode,
        })
      }
      const error =
        e instanceof TerminalError ? e : new TerminalError(`Unexpected error: ${describeError(e)}`)
      lastSucceeded = false
      lastError = error
      lastExitCode = error.exitCode
      pendingDiagnostic = diagnostic(error)
    }
  }

  if (lastError !== null) {
    throw new TerminalError(lastError.message, {
      partialOutput: cap(decode(concat(transcript))),
      exitCode: lastError.exitCode,
      stderr: lastError.stderr,
      displayStderr: lastError.displayStderr,
    })
  }
  return cap(decode(concat(transcript)))
}

/** A failure's terminal-visible stderr, newline-terminated; `''` for a
 *  silent one. */
function diagnostic(e: TerminalError): string {
  const text = e.stderr === undefined ? e.message : e.stderr
  return text && !text.endsWith('\n') ? `${text}\n` : text
}

/** Slice `value` to at most `limit` chars and append a hint-bearing
 *  truncation marker. Returns `value` unchanged when `limit` is
 *  undefined / non-positive / not exceeded. Surrogate-pair-safe:
 *  the slice point is nudged back one position if it would split a
 *  pair, so the marker never appears mid-codepoint. */
function applyOutputCap(value: string, limit: number | undefined): string {
  if (limit === undefined || limit <= 0 || value.length <= limit) return value
  let cut = limit
  // Don't split a surrogate pair: if the char before `cut` is a high
  // surrogate, pull `cut` back one position.
  const code = value.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  const remaining = value.length - cut
  return `${value.slice(0, cut)}\n<truncated: ${remaining} more characters — use head/tail/grep/sed to read a specific range>\n`
}

async function executePipeline(pipeline: Pipeline, run: Run): Promise<void> {
  if (pipeline.commands.length === 0) return
  const { fs, signal, env, lastExitCode, transcript } = run

  let currentInput: Uint8Array = EMPTY
  // A `2>&1` failure that let the pipeline go on; it decides the
  // pipeline's outcome only if it was the last stage's.
  let mergedFailure: TerminalError | null = null
  const lastStage = pipeline.commands.length - 1

  for (let stage = 0; stage <= lastStage; stage++) {
    const cmd = pipeline.commands[stage] as Pipeline['commands'][number]
    if (signal.aborted) throw new TerminalError('aborted', { exitCode: ABORTED })

    // The name and args expand as one word list, so a name that
    // expands to nothing shifts away (`$EMPTY echo hi` runs `echo hi`).
    // A value with spaces is never split into words: `CMD="echo hi";
    // $CMD` is "echo hi: command not found", never a silent re-parse.
    const vars = variables(env, fs)
    const words = await expandArgs([cmd.name, ...cmd.args], fs, vars, lastExitCode)
    if (words.length === 0) {
      // The whole command expanded to nothing: a silent no-op.
      // Its redirects are not processed.
      mergedFailure = null
      currentInput = EMPTY
      continue
    }
    const [name, ...args] = words as [string, ...string[]]

    // Every redirect's target is expanded and resolved before the
    // command runs, as in bash: an unset variable or an ambiguous
    // target stops it before it can do anything.
    const paths = new Map<Redirect, { target: string; path: string }>()
    for (const r of cmd.redirects) {
      if (r.type === '<<' || r.type === '2>&1') continue
      const target = expandWord(r.target, vars, lastExitCode)
      paths.set(r, { target, path: resolve(target, fs.getcwd()) })
    }
    const pathOf = (r: Redirect): { target: string; path: string } =>
      paths.get(r) as { target: string; path: string }

    // Input redirect: the last `<` or `<<` wins over the pipe.
    let stdinBytes = currentInput
    const inputRedirect = lastOf(cmd.redirects, ['<', '<<'])
    if (inputRedirect !== undefined) {
      if (inputRedirect.type === '<<') {
        // Heredoc bodies are always literal: never expanded.
        stdinBytes = encode(inputRedirect.content ?? '')
      } else {
        const { target, path } = pathOf(inputRedirect)
        if (path === DEV_NULL) {
          stdinBytes = EMPTY
        } else {
          try {
            stdinBytes = await fs.read(path)
          } catch (e) {
            throw new TerminalError(`${name}: ${target}: ${describeError(e)}`)
          }
        }
      }
    }

    // stderr routing: the last stderr redirect wins.
    const stderrRedirect = lastOf(cmd.redirects, ['2>', '2>>', '2>&1'])
    const outputRedirects = cmd.redirects.filter((r) => r.type === '>' || r.type === '>>')
    // Write `data` to each output redirect; /dev/null is discarded,
    // never written (a file of that name would turn up in every later
    // listing of the tree).
    const writeRedirects = async (data: Uint8Array): Promise<void> => {
      for (const r of outputRedirects) {
        const { path } = pathOf(r)
        if (path === DEV_NULL) continue
        try {
          await fs.write(path, data, r.type === '>>' ? 'a' : 'w')
        } catch (e) {
          throw new TerminalError(`${name}: redirect failed: ${describeError(e)}`)
        }
      }
    }
    // A failing command's own stdout still goes where it was sent: to
    // its output redirects (`cat a missing > out` writes a's content),
    // or, with none, to the transcript. The failure stays the outcome
    // even if that write fails.
    const drainPartial = async (): Promise<void> => {
      const data = stdout.value()
      if (outputRedirects.length === 0) {
        if (data.byteLength > 0) transcript.push(data)
        return
      }
      await writeRedirects(data).catch(() => undefined)
    }
    const stdout = new ByteStdout()
    const ctx: CommandContext = {
      args,
      stdin: new ByteStdin(stdinBytes),
      stdout,
      fs,
      env,
      signal,
      commands: run.commands,
      agentSink: stage === lastStage && outputRedirects.length === 0,
    }

    let failure: TerminalError | null = null
    let result: CommandResult | undefined
    try {
      const handler = run.commands.get(name)
      if (handler === undefined) {
        throw new TerminalError(`${name}: command not found`, { exitCode: 127 })
      }
      result = (await handler(ctx)) ?? undefined
      // A stage before the last that fails silently (grep that matched
      // nothing, false) hands its output on and the pipeline goes on,
      // as bash's does without pipefail: `grep x f | wc -l` prints 0.
      // A failure with a diagnostic still stops it.
      const silentMidStage = stage !== lastStage && !result?.stderr
      if (result !== undefined && result.exitCode !== 0 && !silentMidStage) {
        throw commandFailure(name, result)
      }
    } catch (e) {
      const error =
        e instanceof TerminalError
          ? e
          : new TerminalError(`${name}: execution error: ${describeError(e)}`)
      if (stderrRedirect === undefined) {
        await drainPartial()
        throw error
      }
      failure = error
    }

    // This command's stderr text ('' if none, or a silent failure).
    let stderrText = ''
    if (failure !== null) stderrText = diagnostic(failure)
    else if (result?.stderr) stderrText = withNewline(result.stderr)

    if (stderrRedirect === undefined) {
      // A warning from a command that succeeded: a terminal shows it,
      // but never feeds it to the next stage.
      if (stderrText) transcript.push(encode(stderrText))
    } else if (stderrRedirect.type === '2>&1') {
      // Merged into stdout, after what the command wrote: it joins the
      // pipe, or the transcript.
      stdout.write(stderrText)
    } else {
      // `2>file` truncates even when nothing was written, as in bash;
      // `2>>file` appends; /dev/null discards.
      const { path } = pathOf(stderrRedirect)
      if (path !== DEV_NULL) {
        try {
          await fs.write(path, encode(stderrText), stderrRedirect.type === '2>>' ? 'a' : 'w')
        } catch (e) {
          throw new TerminalError(`${name}: redirect failed: ${describeError(e)}`)
        }
      }
    }

    // A failure whose stderr went to a file still stops the pipeline,
    // silently: the redirect took its diagnostic. A `2>&1` failure lets
    // it go on, so later stages see the merged text (`cmd 2>&1 | head`);
    // as the last stage, it resurfaces after the loop.
    if (failure !== null && stderrRedirect?.type !== '2>&1') {
      await drainPartial()
      throw new TerminalError(failure.message, { exitCode: failure.exitCode, stderr: '' })
    }
    mergedFailure = failure

    const output = stdout.value()
    if (outputRedirects.length > 0) {
      await writeRedirects(output)
      currentInput = EMPTY
    } else {
      currentInput = output
    }
  }

  if (currentInput.byteLength > 0) transcript.push(currentInput)

  // A `2>&1` failure in the last stage decides the pipeline's exit; its
  // diagnostic already went with the merge, so the throw is silent.
  if (mergedFailure !== null) {
    throw new TerminalError(mergedFailure.message, {
      exitCode: mergedFailure.exitCode,
      stderr: '',
    })
  }
}

function lastOf(
  redirects: readonly Redirect[],
  types: readonly Redirect['type'][],
): Redirect | undefined {
  for (let i = redirects.length - 1; i >= 0; i--) {
    const r = redirects[i] as Redirect
    if (types.includes(r.type)) return r
  }
  return undefined
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

// -- expansion ------------------------------------------------------------------------

// The `$` forms expanded. Anything else with a `$` (`$(`, `$1`, `$$`, a
// trailing `grep foo$` anchor) stays literal: visible non-support beats
// silent mangling. The escapes follow the double-quote rule: a
// backslash is special only before `\` or `$`, so `\d` in a regex stays
// `\d`, while `\\$NAME` is a backslash followed by an expansion.
// `${NAME:-word}` and `${NAME-word}` give `word` (itself expanded) for
// a variable that's unset (`-`), or unset or empty (`:-`): the way to
// read one that may not be set. `word` runs to the `}` that closes its
// `${`, as in bash, so it may hold another (`${A:-${B}}`).
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y
const BRACED_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\}|(:?-))/y

/** A variable's value, or undefined when it isn't set. */
type Variables = (name: string) => string | undefined

/** The variables one command expands with: `env`'s, with `PWD` the
 *  current directory (asked for only when it's read). */
function variables(env: Record<string, string>, fs: FileSystem): Variables {
  return (name) => (name === 'PWD' ? fs.getcwd() : Object.hasOwn(env, name) ? env[name] : undefined)
}

/** Expand `$?`, `$NAME`, `${NAME}` and `${NAME:-word}` in `text`. An
 *  unset variable with no default throws `UnboundVariable`; `\$` is a
 *  literal `$`, and `\\` a literal backslash. */
function expandVars(text: string, vars: Variables, lastExitCode: number): string {
  if (!text.includes('$') && !text.includes('\\\\')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    const next = text[i + 1]
    if (c === '\\' && (next === '\\' || next === '$')) {
      out += next
      i += 2
    } else if (c !== '$') {
      out += c
      i++
    } else if (next === '?') {
      out += String(lastExitCode)
      i += 2
    } else if (next === '{') {
      const param = expandParameter(text, i, vars, lastExitCode)
      if (param === null) {
        out += c
        i++
      } else {
        out += param.value
        i = param.next
      }
    } else {
      NAME_RE.lastIndex = i + 1
      const name = NAME_RE.exec(text)?.[0]
      if (name === undefined) {
        out += c
        i++
      } else {
        out += lookup(name, vars)
        i += 1 + name.length
      }
    }
  }
  return out
}

/** The `${NAME}` or `${NAME:-word}` at `at` expanded, and the index
 *  after it; null for any other `${` form, which stays literal. */
function expandParameter(
  text: string,
  at: number,
  vars: Variables,
  lastExitCode: number,
): { value: string; next: number } | null {
  BRACED_RE.lastIndex = at
  const m = BRACED_RE.exec(text)
  if (m === null) return null
  const name = m[1] as string
  const op = m[2]
  if (op === undefined) return { value: lookup(name, vars), next: at + m[0].length }
  const end = parameterEnd(text, at)
  if (end < 0) return null
  const value = vars(name)
  if (value === undefined || (op === ':-' && value === '')) {
    const word = text.slice(at + m[0].length, end)
    return { value: expandVars(word, vars, lastExitCode), next: end + 1 }
  }
  return { value, next: end + 1 }
}

/** `name`'s value; `UnboundVariable` when it isn't set. */
function lookup(name: string, vars: Variables): string {
  const value = vars(name)
  if (value === undefined) throw new UnboundVariable(name)
  return value
}

/** Variable-expand a quote-masked word: the unquoted part and the
 *  inside of double quotes expand, single quotes stay literal. `map` is
 *  updated in place for the double-quoted spans. */
function expandMasked(
  masked: string,
  map: Map<string, string>,
  vars: Variables,
  lastExitCode: number,
): string {
  const expanded = expandVars(masked, vars, lastExitCode)
  for (const [token, original] of map) {
    if (original[0] === '"') {
      map.set(token, `"${expandVars(original.slice(1, -1), vars, lastExitCode)}"`)
    }
  }
  return expanded
}

/** `masked`'s brace expansion, each word with the placeholders it holds
 *  (a map of its own, as expansion rewrites the double-quoted ones). */
function braced(masked: string, map: ReadonlyMap<string, string>): [string, Map<string, string>][] {
  return expandBraces(masked).map((word) => [
    word,
    new Map([...map].filter(([token]) => word.includes(token))),
  ])
}

/** Expand braces and variables in one word (a redirect target) and
 *  strip its quotes. No globbing, no word removal; braces that make
 *  more than one word are an error, as in bash. */
function expandWord(word: string, vars: Variables, lastExitCode: number): string {
  const { masked, map } = maskQuotes(word)
  const words = braced(masked, map)
  if (words.length !== 1) throw new TerminalError(`${word}: ambiguous redirect`)
  const [only, own] = words[0] as [string, Map<string, string>]
  return unmaskAndUnquote(expandMasked(only, own, vars, lastExitCode), own)
}

/**
 * Expand braces, then variables, then glob, as bash does. Variables
 * come before globs, so `$?` never reads as a glob `?`. A fully
 * unquoted word that expands to nothing is removed (`echo a $EMPTY b`
 * has two args, not three); one with an unquoted `*`, `?` or `[...]` is
 * expanded as bash does (`./pathglob`), and stays as typed if nothing
 * matches.
 */
async function expandArgs(
  args: readonly string[],
  fs: FileSystem,
  vars: Variables,
  lastExitCode: number,
): Promise<string[]> {
  const out: string[] = []
  for (const arg of args) {
    const { masked, map: quoted } = maskQuotes(arg)
    for (const [word, map] of braced(masked, quoted)) {
      const expanded = expandMasked(word, map, vars, lastExitCode)
      if (map.size === 0) {
        if (expanded === '' && arg !== '') continue
        if (hasMagic(expanded)) {
          try {
            const matches = await expandPathname(expanded, fs)
            out.push(...(matches.length > 0 ? matches : [expanded]))
          } catch {
            out.push(expanded)
          }
          continue
        }
      }
      out.push(unmaskAndUnquote(expanded, map))
    }
  }
  return out
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

function describeError(e: unknown): string {
  return describeFsError(e)
}
