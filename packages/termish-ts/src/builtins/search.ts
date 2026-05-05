/**
 * Search builtins: `grep` and `find`.
 *
 * Direct port of termish-py's `search.py`. Full flag coverage on
 * both sides; the find predicate language matches GNU find:
 *
 *   find [path] [global-options] [expression]
 *
 * with predicates `-name`, `-iname`, `-path`, `-type`, `-size`,
 * `-empty`, `-print`, `-delete`, `-exec`, joined by `-and` / `-or`
 * (or implicit AND), `-not` / `!`, with `(` `)` for grouping.
 *
 * `-exec` runs back through the interpreter to execute the command —
 * we use a dynamic import to break the otherwise-circular dep
 * (`search.ts → interpreter.ts → BUILTINS → search.ts`).
 */

import type { CommandContext, CommandHandler } from '../context'
import { TerminalError } from '../errors'
import type { FileInfo, FileSystem } from '../fs/protocol'
import { globMatch } from '../glob'
import { parseArgs } from './_argparse'

const decoder = new TextDecoder('utf-8', { fatal: false })

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

/** Escape regex metacharacters for `-F` fixed-string mode. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Convert BRE `\|` alternation into ERE `|`. Inside `[...]`, double
 * backslashes so JS `RegExp` treats them as literal (matches GNU
 * grep BRE, where `\` is literal inside a character class).
 *
 * Without this, agents who type `grep "a\|b"` (BRE alternation) get
 * a surprising literal-pipe match. With it, `grep "a\|b"` and
 * `grep -E "a|b"` are equivalent.
 */
function breAlternationToEre(pattern: string): string {
  let out = ''
  let i = 0
  let inClass = false
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (inClass) {
      if (ch === '\\') {
        out += '\\\\'
        i++
      } else if (ch === ']') {
        inClass = false
        out += ch
        i++
      } else {
        out += ch
        i++
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1] as string
      if (next === '|') {
        out += '|'
        i += 2
      } else {
        out += pattern.slice(i, i + 2)
        i += 2
      }
    } else if (ch === '[') {
      inClass = true
      out += '['
      i++
      if (pattern[i] === '^') {
        out += '^'
        i++
      }
      // `]` immediately after `[` or `[^` is a literal `]`
      if (pattern[i] === ']') {
        out += ']'
        i++
      }
    } else {
      out += ch
      i++
    }
  }
  return out
}

async function collectFiles(userDir: string, fs: FileSystem): Promise<string[]> {
  let entries: FileInfo[]
  try {
    entries = await fs.listDetailed(userDir, { recursive: true })
  } catch (e) {
    throw new TerminalError(`grep: ${userDir}: ${describeError(e)}`)
  }
  // FileInfo.path is already prefixed with the queried dir, so we
  // can just filter and project — no manual prefix join needed.
  return entries.filter((e) => !e.isDir).map((e) => e.path)
}

export const grep: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        ignoreCase: { aliases: ['-i', '--ignore-case'] },
        lineNumber: { aliases: ['-n', '--line-number'] },
        recursive: { aliases: ['-r', '-R', '--recursive'] },
        filesWithMatches: { aliases: ['-l', '--files-with-matches'] },
        filesWithoutMatch: { aliases: ['-L', '--files-without-match'] },
        invert: { aliases: ['-v', '--invert-match'] },
        fixed: { aliases: ['-F', '--fixed-strings'] },
        extended: { aliases: ['-E', '--extended-regexp'] },
        after: { aliases: ['-A', '--after-context'], takesValue: true },
        before: { aliases: ['-B', '--before-context'], takesValue: true },
        context: { aliases: ['-C', '--context'], takesValue: true },
        count: { aliases: ['-c', '--count'] },
        word: { aliases: ['-w', '--word-regexp'] },
        only: { aliases: ['-o', '--only-matching'] },
        quiet: { aliases: ['-q', '--quiet', '--silent'] },
        maxCount: { aliases: ['-m', '--max-count'], takesValue: true },
        include: { aliases: ['--include'], takesValue: true },
        exclude: { aliases: ['--exclude'], takesValue: true },
        excludeDir: { aliases: ['--exclude-dir'], takesValue: true },
        withFilename: { aliases: ['-H', '--with-filename'] },
        noFilename: { aliases: ['-h', '--no-filename'] },
        // -e PATTERN can repeat
        patterns: { aliases: ['-e'], multi: true },
      },
    },
    'grep',
  )

  const explicitPatterns = parsed.flags.patterns as string[]
  let patternsRaw: string[]
  let files: string[]
  if (explicitPatterns.length > 0) {
    patternsRaw = explicitPatterns
    files = [...parsed.positional]
  } else {
    if (parsed.positional.length === 0) {
      throw new TerminalError('grep: no pattern given')
    }
    patternsRaw = [parsed.positional[0] as string]
    files = parsed.positional.slice(1)
  }

  const beforeRaw = numericFlag(parsed.flags.before, 0)
  const afterRaw = numericFlag(parsed.flags.after, 0)
  const ctxN = numericFlag(parsed.flags.context, 0)
  const before = ctxN > 0 ? Math.max(beforeRaw, ctxN) : beforeRaw
  const after = ctxN > 0 ? Math.max(afterRaw, ctxN) : afterRaw
  const hasContext = before > 0 || after > 0

  // Build combined regex.
  const pieces: string[] = []
  for (const raw of patternsRaw) {
    let p = raw
    if (parsed.flags.fixed === true) {
      p = escapeRegex(p)
    } else if (parsed.flags.extended !== true) {
      p = breAlternationToEre(p)
    }
    if (parsed.flags.word === true) p = `\\b${p}\\b`
    pieces.push(`(?:${p})`)
  }
  const combined = pieces.join('|')
  const flagsStr = parsed.flags.ignoreCase === true ? 'i' : ''
  let regex: RegExp
  let regexGlobal: RegExp
  try {
    regex = new RegExp(combined, flagsStr)
    regexGlobal = new RegExp(combined, `${flagsStr}g`)
  } catch (e) {
    throw new TerminalError(`grep: invalid regex: ${describeError(e)}`)
  }

  const quiet = parsed.flags.quiet === true
  const maxCountRaw = numericFlag(parsed.flags.maxCount, 0)
  const maxCount = quiet && maxCountRaw === 0 ? 1 : maxCountRaw
  const onlyMatching = parsed.flags.only === true
  const filesWithMatches = parsed.flags.filesWithMatches === true
  const filesWithoutMatch = parsed.flags.filesWithoutMatch === true
  const noFilename = parsed.flags.noFilename === true
  const withFilename = parsed.flags.withFilename === true
  const lineNumber = parsed.flags.lineNumber === true
  const invert = parsed.flags.invert === true
  const countMode = parsed.flags.count === true

  // For -q / -L we suppress per-line output — capture into a sink.
  const realStdout = ctx.stdout
  const sinkStdout: { write: (s: string) => void } = { write: () => undefined }
  const stdout = quiet || filesWithoutMatch ? sinkStdout : realStdout

  const processContent = (content: string, label: string | null): number => {
    const lines = splitLines(content)
    let fileMatches = 0

    if (countMode) {
      let n = 0
      for (const line of lines) {
        const isMatch = regex.test(line) !== invert
        if (isMatch) n++
      }
      stdout.write(`${label !== null ? `${label}:` : ''}${n}\n`)
      return n
    }

    if (onlyMatching) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        regexGlobal.lastIndex = 0
        let m: RegExpExecArray | null
        // biome-ignore lint/suspicious/noAssignInExpressions: cleanest exec loop
        while ((m = regexGlobal.exec(line)) !== null) {
          fileMatches++
          if (filesWithMatches) {
            if (label !== null) stdout.write(`${label}\n`)
            return fileMatches
          }
          let prefix = ''
          if (label !== null) prefix += `${label}:`
          if (lineNumber) prefix += `${i + 1}:`
          stdout.write(`${prefix}${m[0]}\n`)
          if (maxCount > 0 && fileMatches >= maxCount) return fileMatches
          // Avoid infinite loop on zero-width matches.
          if (m.index === regexGlobal.lastIndex) regexGlobal.lastIndex++
        }
      }
      return fileMatches
    }

    if (hasContext) {
      const matchingLines = new Set<number>()
      for (let i = 0; i < lines.length; i++) {
        const isMatch = regex.test(lines[i] as string) !== invert
        if (isMatch) {
          matchingLines.add(i)
          if (filesWithMatches) {
            if (label !== null) stdout.write(`${label}\n`)
            return matchingLines.size
          }
          if (maxCount > 0 && matchingLines.size >= maxCount) break
        }
      }
      const contextLines = new Set<number>()
      for (const idx of matchingLines) {
        const lo = Math.max(0, idx - before)
        const hi = Math.min(lines.length - 1, idx + after)
        for (let j = lo; j <= hi; j++) {
          if (!matchingLines.has(j)) contextLines.add(j)
        }
      }
      const all = [...matchingLines, ...contextLines].sort((a, b) => a - b)
      let prevIdx = -2
      for (const idx of all) {
        if (prevIdx >= 0 && idx > prevIdx + 1) stdout.write('--\n')
        prevIdx = idx
        const isMatch = matchingLines.has(idx)
        const sep = isMatch ? ':' : '-'
        let prefix = ''
        if (label !== null) prefix += `${label}${sep}`
        if (lineNumber) prefix += `${idx + 1}${sep}`
        stdout.write(`${prefix}${lines[idx] as string}\n`)
      }
      return matchingLines.size
    }

    // Plain mode.
    for (let i = 0; i < lines.length; i++) {
      const isMatch = regex.test(lines[i] as string) !== invert
      if (!isMatch) continue
      fileMatches++
      if (filesWithMatches) {
        if (label !== null) stdout.write(`${label}\n`)
        return fileMatches
      }
      let prefix = ''
      if (label !== null) prefix += `${label}:`
      if (lineNumber) prefix += `${i + 1}:`
      stdout.write(`${prefix}${lines[i] as string}\n`)
      if (maxCount > 0 && fileMatches >= maxCount) return fileMatches
    }
    return fileMatches
  }

  // Resolve the file list.
  let filesToSearch: string[]
  if (files.length === 0 && parsed.flags.recursive !== true) {
    processContent(ctx.stdin, null)
    return
  }
  if (files.length === 0) {
    filesToSearch = await collectFiles('.', ctx.fs)
  } else {
    filesToSearch = []
    for (const path of files) {
      if (await ctx.fs.isDir(path)) {
        // Auto-recurse into directories (matches modern grep).
        const collected = await collectFiles(path, ctx.fs)
        filesToSearch.push(...collected)
      } else {
        filesToSearch.push(path)
      }
    }
  }

  // Filter by --include / --exclude / --exclude-dir.
  if (typeof parsed.flags.include === 'string') {
    const pat = parsed.flags.include
    filesToSearch = filesToSearch.filter((f) => globMatch(pat, basename(f)))
  }
  if (typeof parsed.flags.exclude === 'string') {
    const pat = parsed.flags.exclude
    filesToSearch = filesToSearch.filter((f) => !globMatch(pat, basename(f)))
  }
  if (typeof parsed.flags.excludeDir === 'string') {
    const pat = parsed.flags.excludeDir
    filesToSearch = filesToSearch.filter((f) => {
      const parts = f.split('/').slice(0, -1)
      return !parts.some((p) => globMatch(pat, p))
    })
  }

  const multipleFiles = filesToSearch.length > 1 || parsed.flags.recursive === true

  for (const filepath of filesToSearch) {
    let content: string
    try {
      const bytes = await ctx.fs.read(filepath)
      content = decoder.decode(bytes)
    } catch (e) {
      throw new TerminalError(`grep: ${filepath}: ${describeError(e)}`)
    }
    let label: string | null
    if (noFilename) label = null
    else if (withFilename) label = filepath
    else if (multipleFiles || filesWithMatches || filesWithoutMatch) label = filepath
    else label = null

    const m = processContent(content, label)
    if (filesWithoutMatch && m === 0) realStdout.write(`${filepath}\n`)
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

function splitLines(text: string): string[] {
  // Matches Python's str.splitlines() — strips the trailing terminator
  // from each line and drops a trailing empty line caused by a final \n.
  if (text.length === 0) return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function numericFlag(raw: string | boolean | string[] | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? fallback : n
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

interface FindPredicate {
  matches(item: FileInfo, fs: FileSystem): Promise<boolean>
}

class NamePred implements FindPredicate {
  constructor(private readonly pattern: string) {}
  async matches(item: FileInfo): Promise<boolean> {
    return globMatch(this.pattern, item.name)
  }
}

class INamePred implements FindPredicate {
  private readonly pattern: string
  constructor(pattern: string) {
    this.pattern = pattern.toLowerCase()
  }
  async matches(item: FileInfo): Promise<boolean> {
    return globMatch(this.pattern, item.name.toLowerCase())
  }
}

class PathPred implements FindPredicate {
  constructor(private readonly pattern: string) {}
  async matches(item: FileInfo): Promise<boolean> {
    return globMatch(this.pattern, item.path)
  }
}

class TypePred implements FindPredicate {
  constructor(private readonly kind: 'f' | 'd') {}
  async matches(item: FileInfo): Promise<boolean> {
    return this.kind === 'f' ? !item.isDir : item.isDir
  }
}

class EmptyPred implements FindPredicate {
  async matches(item: FileInfo, fs: FileSystem): Promise<boolean> {
    if (item.isDir) {
      try {
        const entries = await fs.list(item.path)
        return entries.length === 0
      } catch {
        return false
      }
    }
    return item.size === 0
  }
}

class SizePred implements FindPredicate {
  private readonly threshold: number
  private readonly compare: 'gt' | 'lt' | 'eq'
  constructor(spec: string) {
    if (spec.length === 0) throw new TerminalError('find: -size requires an argument')
    let s = spec
    let cmp: 'gt' | 'lt' | 'eq' = 'eq'
    if (s.startsWith('+')) {
      cmp = 'gt'
      s = s.slice(1)
    } else if (s.startsWith('-')) {
      cmp = 'lt'
      s = s.slice(1)
    }
    const multipliers: Record<string, number> = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }
    let mult = 512 // default: 512-byte blocks
    const last = s[s.length - 1]
    if (last !== undefined && last in multipliers) {
      mult = multipliers[last] as number
      s = s.slice(0, -1)
    }
    const n = Number.parseInt(s, 10)
    if (Number.isNaN(n)) throw new TerminalError(`find: invalid size: ${spec}`)
    this.threshold = n * mult
    this.compare = cmp
  }
  async matches(item: FileInfo): Promise<boolean> {
    if (this.compare === 'gt') return item.size > this.threshold
    if (this.compare === 'lt') return item.size < this.threshold
    return item.size === this.threshold
  }
}

class PrintPred implements FindPredicate {
  constructor(private readonly stdout: { write: (s: string) => void }) {}
  async matches(item: FileInfo): Promise<boolean> {
    this.stdout.write(`${item.path}\n`)
    return true
  }
}

class DeletePred implements FindPredicate {
  async matches(item: FileInfo, fs: FileSystem): Promise<boolean> {
    try {
      if (item.isDir) await fs.rmdir(item.path)
      else await fs.remove(item.path)
    } catch {
      return false
    }
    return true
  }
}

class ExecPred implements FindPredicate {
  constructor(
    private readonly cmdTokens: readonly string[],
    private readonly stdout: { write: (s: string) => void },
    private readonly executor: (cmd: string, fs: FileSystem) => Promise<string>,
  ) {}
  async matches(item: FileInfo, fs: FileSystem): Promise<boolean> {
    const expanded = this.cmdTokens.map((t) => t.replaceAll('{}', item.path))
    const cmdStr = shellJoin(expanded)
    try {
      const output = await this.executor(cmdStr, fs)
      if (output.length > 0) this.stdout.write(output)
    } catch {
      return false
    }
    return true
  }
}

class ExecBatchPred implements FindPredicate {
  readonly collected: string[] = []
  constructor(
    private readonly cmdTokens: readonly string[],
    private readonly stdout: { write: (s: string) => void },
    private readonly executor: (cmd: string, fs: FileSystem) => Promise<string>,
  ) {}
  async matches(item: FileInfo): Promise<boolean> {
    this.collected.push(item.path)
    return true
  }
  async finalize(fs: FileSystem): Promise<void> {
    if (this.collected.length === 0) return
    const expanded: string[] = []
    for (const t of this.cmdTokens) {
      if (t === '{}') expanded.push(...this.collected)
      else expanded.push(t)
    }
    const cmdStr = shellJoin(expanded)
    try {
      const output = await this.executor(cmdStr, fs)
      if (output.length > 0) this.stdout.write(output)
    } catch {
      // best-effort; matches Python's silent swallow
    }
  }
}

class AndPred implements FindPredicate {
  constructor(
    readonly left: FindPredicate,
    readonly right: FindPredicate,
  ) {}
  async matches(item: FileInfo, fs: FileSystem): Promise<boolean> {
    if (!(await this.left.matches(item, fs))) return false
    return this.right.matches(item, fs)
  }
}

class OrPred implements FindPredicate {
  constructor(
    readonly left: FindPredicate,
    readonly right: FindPredicate,
  ) {}
  async matches(item: FileInfo, fs: FileSystem): Promise<boolean> {
    if (await this.left.matches(item, fs)) return true
    return this.right.matches(item, fs)
  }
}

class NotPred implements FindPredicate {
  constructor(readonly child: FindPredicate) {}
  async matches(item: FileInfo, fs: FileSystem): Promise<boolean> {
    return !(await this.child.matches(item, fs))
  }
}

class TruePred implements FindPredicate {
  async matches(): Promise<boolean> {
    return true
  }
}

function shellJoin(tokens: readonly string[]): string {
  return tokens
    .map((t) => {
      if (t.includes(' ') || t.includes('\t')) {
        return `'${t.replaceAll("'", "'\\''")}'`
      }
      return t
    })
    .join(' ')
}

function hasAction(p: FindPredicate): boolean {
  if (p instanceof PrintPred || p instanceof DeletePred) return true
  if (p instanceof ExecPred || p instanceof ExecBatchPred) return true
  if (p instanceof AndPred || p instanceof OrPred) return hasAction(p.left) || hasAction(p.right)
  if (p instanceof NotPred) return hasAction(p.child)
  return false
}

async function finalizeBatch(p: FindPredicate, fs: FileSystem): Promise<void> {
  if (p instanceof ExecBatchPred) {
    await p.finalize(fs)
  } else if (p instanceof AndPred || p instanceof OrPred) {
    await finalizeBatch(p.left, fs)
    await finalizeBatch(p.right, fs)
  } else if (p instanceof NotPred) {
    await finalizeBatch(p.child, fs)
  }
}

interface ParseFindCtx {
  stdout: { write: (s: string) => void }
  executor: (cmd: string, fs: FileSystem) => Promise<string>
}

function parseFindPredicates(tokens: readonly string[], parseCtx: ParseFindCtx): FindPredicate {
  if (tokens.length === 0) return new TruePred()
  let pos = 0

  const parsePrimary = (): FindPredicate => {
    if (pos >= tokens.length) throw new TerminalError('find: expected expression')
    const tok = tokens[pos] as string

    if (tok === '(') {
      pos++
      const node = parseOr()
      if (pos >= tokens.length || tokens[pos] !== ')') {
        throw new TerminalError("find: missing closing ')'")
      }
      pos++
      return node
    }
    if (tok === '-name') {
      pos++
      if (pos >= tokens.length) throw new TerminalError('find: -name requires a pattern')
      return new NamePred(tokens[pos++] as string)
    }
    if (tok === '-iname') {
      pos++
      if (pos >= tokens.length) throw new TerminalError('find: -iname requires a pattern')
      return new INamePred(tokens[pos++] as string)
    }
    if (tok === '-path') {
      pos++
      if (pos >= tokens.length) throw new TerminalError('find: -path requires a pattern')
      return new PathPred(tokens[pos++] as string)
    }
    if (tok === '-print') {
      pos++
      return new PrintPred(parseCtx.stdout)
    }
    if (tok === '-delete') {
      pos++
      return new DeletePred()
    }
    if (tok === '-type') {
      pos++
      if (pos >= tokens.length) throw new TerminalError('find: -type requires an argument')
      const kind = tokens[pos++] as string
      if (kind !== 'f' && kind !== 'd') {
        throw new TerminalError(`find: unknown type '${kind}' (use 'f' or 'd')`)
      }
      return new TypePred(kind)
    }
    if (tok === '-empty') {
      pos++
      return new EmptyPred()
    }
    if (tok === '-size') {
      pos++
      if (pos >= tokens.length) throw new TerminalError('find: -size requires an argument')
      let spec = tokens[pos++] as string
      // Handle shell splitting: +1k may have been split into "+", "1k".
      if ((spec === '+' || spec === '-') && pos < tokens.length) {
        spec = spec + (tokens[pos++] as string)
      }
      return new SizePred(spec)
    }
    if (tok === '-exec') {
      pos++
      const cmdTokens: string[] = []
      while (pos < tokens.length && tokens[pos] !== ';' && tokens[pos] !== '+') {
        cmdTokens.push(tokens[pos++] as string)
      }
      if (pos >= tokens.length) {
        throw new TerminalError("find: -exec requires terminating ';' or '+'")
      }
      const batch = tokens[pos] === '+'
      pos++ // skip ; or +
      if (cmdTokens.length === 0) throw new TerminalError('find: -exec requires a command')
      return batch
        ? new ExecBatchPred(cmdTokens, parseCtx.stdout, parseCtx.executor)
        : new ExecPred(cmdTokens, parseCtx.stdout, parseCtx.executor)
    }
    throw new TerminalError(`find: unknown predicate: ${tok}`)
  }

  const parseUnary = (): FindPredicate => {
    if (pos >= tokens.length) throw new TerminalError('find: expected expression')
    const tok = tokens[pos] as string
    if (tok === '-not' || tok === '!') {
      pos++
      return new NotPred(parseUnary())
    }
    return parsePrimary()
  }

  const parseAnd = (): FindPredicate => {
    let left = parseUnary()
    while (pos < tokens.length) {
      const tok = tokens[pos] as string
      if (tok === '-a' || tok === '-and') {
        pos++
        left = new AndPred(left, parseUnary())
      } else if (tok !== '-o' && tok !== '-or' && tok !== ')') {
        left = new AndPred(left, parseUnary())
      } else {
        break
      }
    }
    return left
  }

  const parseOr = (): FindPredicate => {
    let left = parseAnd()
    while (pos < tokens.length && (tokens[pos] === '-o' || tokens[pos] === '-or')) {
      pos++
      left = new OrPred(left, parseAnd())
    }
    return left
  }

  const result = parseOr()
  if (pos < tokens.length) throw new TerminalError(`find: unexpected token: ${tokens[pos]}`)
  return result
}

export const find: CommandHandler = async (ctx: CommandContext) => {
  let rootPath = '.'
  let maxdepth: number | null = null
  let mindepth: number | null = null
  const predicateTokens: string[] = []

  const args = ctx.args
  let i = 0
  // Leading positional arg = path. Anything else (starts with `-` or
  // is `(` / `!`) is a predicate.
  if (i < args.length) {
    const first = args[i] as string
    if (!first.startsWith('-') && first !== '(' && first !== '!') {
      rootPath = first
      i++
    }
  }
  while (i < args.length) {
    const tok = args[i] as string
    if (tok === '-maxdepth') {
      i++
      if (i >= args.length) throw new TerminalError('find: -maxdepth requires an argument')
      const n = Number.parseInt(args[i++] as string, 10)
      if (Number.isNaN(n)) throw new TerminalError('find: invalid argument to -maxdepth')
      maxdepth = n
    } else if (tok === '-mindepth') {
      i++
      if (i >= args.length) throw new TerminalError('find: -mindepth requires an argument')
      const n = Number.parseInt(args[i++] as string, 10)
      if (Number.isNaN(n)) throw new TerminalError('find: invalid argument to -mindepth')
      mindepth = n
    } else {
      predicateTokens.push(tok)
      i++
    }
  }

  // Dynamic import breaks the circular dep:
  //   search.ts → interpreter.ts → builtins/index.ts → search.ts
  const executor = async (cmdStr: string, fs: FileSystem): Promise<string> => {
    const { execute } = await import('../interpreter')
    return execute(cmdStr, fs)
  }

  const predicate = parseFindPredicates(predicateTokens, {
    stdout: ctx.stdout,
    executor,
  })
  const actionPresent = hasAction(predicate)

  let items: FileInfo[]
  try {
    items = await ctx.fs.listDetailed(rootPath, { recursive: true })
  } catch (e) {
    throw new TerminalError(`find: ${describeError(e)}`)
  }

  const prefix = rootPath.replace(/\/$/, '')
  for (const item of items) {
    if (ctx.signal.aborted) throw new TerminalError('find: aborted')
    // Depth is computed relative to the queried root — `find /a/b -maxdepth 1`
    // matches direct children of `/a/b`, regardless of the root's own depth.
    const rel = item.path.startsWith(`${prefix}/`) ? item.path.slice(prefix.length + 1) : item.name
    const depth = rel.split('/').length
    if (maxdepth !== null && depth > maxdepth) continue
    if (mindepth !== null && depth < mindepth) continue
    let matched: boolean
    try {
      matched = await predicate.matches(item, ctx.fs)
    } catch (e) {
      if (e instanceof TerminalError) throw e
      continue
    }
    if (!matched) continue
    if (!actionPresent) ctx.stdout.write(`${item.path}\n`)
  }

  await finalizeBatch(predicate, ctx.fs)
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
