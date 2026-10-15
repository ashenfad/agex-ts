/**
 * Filesystem inspection builtins: `du`, `stat`, `realpath`.
 *
 * Mirrors termish-py's `fsinfo.py`. Sizes are a file's bytes, not
 * disk blocks: the filesystems here have none, so `du` sums what the
 * files hold (GNU's `--apparent-size`).
 */

import type { CommandContext, CommandHandler, CommandResult } from '../context'
import { TerminalError } from '../errors'
import { describeFsError } from '../fs/errors'
import { normalize, resolve } from '../fs/path'
import type { FileMetadata } from '../fs/protocol'
import { parseArgs } from './_argparse'
import { strftime } from './clock'

/** A failure partway, reported once the rest has run. */
function failed(errors: readonly string[]): CommandResult | undefined {
  return errors.length === 0 ? undefined : { exitCode: 1, stderr: errors.join('\n') }
}

// ---------------------------------------------------------------------------
// du
// ---------------------------------------------------------------------------

/**
 * A size as `du -h` shows it: bytes below 1K, then one decimal below
 * 10 and none above, rounded up (`1.5K`, `12K`, `1.0M`).
 */
export function duHuman(bytes: number): string {
  if (bytes < 1024) return String(bytes)
  const units = ['K', 'M', 'G', 'T', 'P']
  let v = bytes / 1024
  let u = 0
  for (;;) {
    const shown = v < 10 ? Math.ceil(v * 10) / 10 : Math.ceil(v)
    if (shown < 1024 || u === units.length - 1) {
      const text = shown < 10 ? shown.toFixed(1) : String(shown)
      return `${text}${units[u]}`
    }
    v /= 1024
    u++
  }
}

/**
 * `du [-s] [-a] [-c] [-h] [PATH...]`
 *
 * Bytes under each directory (each subdirectory too), the deepest
 * first; `-a` lists files as well, `-s` only each PATH's total, `-c`
 * adds a grand total, `-h` shows `12K`-style sizes. PATH defaults to
 * `.`. Sizes are file bytes, not disk blocks.
 */
export const du: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        summarize: { aliases: ['-s', '--summarize'] },
        all: { aliases: ['-a', '--all'] },
        total: { aliases: ['-c', '--total'] },
        human: { aliases: ['-h', '--human-readable'] },
        bytes: { aliases: ['-b', '--bytes', '--apparent-size'] },
      },
    },
    'du',
  )
  if (parsed.flags.summarize === true && parsed.flags.all === true) {
    throw new TerminalError('du: cannot both summarize and show all entries')
  }
  const show = (n: number): string => (parsed.flags.human === true ? duHuman(n) : String(n))
  const paths = parsed.positional.length === 0 ? ['.'] : parsed.positional
  const errors: string[] = []
  let grand = 0
  for (const path of paths) {
    let meta: FileMetadata
    try {
      meta = await ctx.fs.stat(path)
    } catch (e) {
      errors.push(`du: cannot access '${path}': ${describeFsError(e)}`)
      continue
    }
    if (!meta.isDir) {
      ctx.stdout.write(`${show(meta.size)}\t${path}\n`)
      grand += meta.size
      continue
    }
    const base = path === '/' ? '' : path.replace(/\/+$/, '')
    const sizes = await treeSizes(ctx, path)
    const lines: string[] = []
    // post-order: a directory after everything under it
    const visit = (dir: string): number => {
      let total = 0
      for (const child of sizes.children.get(dir) ?? []) {
        const full = dir === '' ? child : `${dir}/${child}`
        if (sizes.dirs.has(full)) total += visit(full)
        else {
          const size = sizes.files.get(full) ?? 0
          total += size
          if (parsed.flags.all === true) lines.push(`${show(size)}\t${base}/${full}`)
        }
      }
      if (dir !== '' && parsed.flags.summarize !== true)
        lines.push(`${show(total)}\t${base}/${dir}`)
      return total
    }
    const total = visit('')
    lines.push(`${show(total)}\t${path}`)
    grand += total
    ctx.stdout.write(`${lines.join('\n')}\n`)
  }
  if (parsed.flags.total === true) ctx.stdout.write(`${show(grand)}\ttotal\n`)
  return failed(errors)
}

interface TreeSizes {
  /** Each directory's entries (relative paths, `''` the root), sorted. */
  children: Map<string, string[]>
  dirs: Set<string>
  files: Map<string, number>
}

async function treeSizes(ctx: CommandContext, root: string): Promise<TreeSizes> {
  const names = [...(await ctx.fs.list(root, { recursive: true }))].sort()
  const out: TreeSizes = { children: new Map(), dirs: new Set(), files: new Map() }
  const prefix = root.endsWith('/') ? root : `${root}/`
  for (const name of names) {
    const meta = await ctx.fs.stat(prefix + name)
    if (meta.isDir) out.dirs.add(name)
    else out.files.set(name, meta.size)
    const slash = name.lastIndexOf('/')
    const parent = slash === -1 ? '' : name.slice(0, slash)
    const leaf = slash === -1 ? name : name.slice(slash + 1)
    const list = out.children.get(parent) ?? []
    list.push(leaf)
    out.children.set(parent, list)
  }
  return out
}

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

/** A metadata timestamp (ISO 8601, UTC), or null when there is none. */
function when(iso: string): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

const showTime = (d: Date | null): string =>
  d === null ? '-' : strftime(d, '%Y-%m-%d %H:%M:%S %z', false)
const epoch = (d: Date | null): string =>
  d === null ? '-' : String(Math.floor(d.getTime() / 1000))

function fileType(meta: FileMetadata): string {
  if (meta.isDir) return 'directory'
  return meta.size === 0 ? 'regular empty file' : 'regular file'
}

/** `stat -c`'s conversions: `%n %s %F %y %Y %w %W %%`. */
function statFormat(format: string, name: string, meta: FileMetadata): string {
  const modified = when(meta.modifiedAt)
  const born = when(meta.createdAt)
  return format.replace(/%(.)/g, (match, code: string) => {
    switch (code) {
      case 'n':
        return name
      case 's':
        return String(meta.size)
      case 'F':
        return fileType(meta)
      case 'y':
        return showTime(modified)
      case 'Y':
        return epoch(modified)
      case 'w':
        return showTime(born)
      case 'W':
        return epoch(born)
      case '%':
        return '%'
      default:
        return match
    }
  })
}

/**
 * `stat [-c FORMAT] PATH...`
 *
 * Each path's name, size, type and times, as a block; `-c` formats
 * them instead, with `%n` (name), `%s` (size in bytes), `%F` (type),
 * `%y`/`%Y` (modified, as a time or seconds since the epoch),
 * `%w`/`%W` (created) and `%%`.
 */
export const stat: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    { flags: { format: { aliases: ['-c', '--format'], takesValue: true } }, minPositional: 1 },
    'stat',
  )
  const format = typeof parsed.flags.format === 'string' ? parsed.flags.format : null
  const errors: string[] = []
  for (const path of parsed.positional) {
    let meta: FileMetadata
    try {
      meta = await ctx.fs.stat(path)
    } catch (e) {
      errors.push(`stat: cannot stat '${path}': ${describeFsError(e)}`)
      continue
    }
    if (format !== null) {
      ctx.stdout.write(`${statFormat(format, path, meta)}\n`)
      continue
    }
    const block = [
      `  File: ${path}`,
      `  Size: ${meta.size}`,
      `  Type: ${fileType(meta)}`,
      `Modify: ${showTime(when(meta.modifiedAt))}`,
      ` Birth: ${showTime(when(meta.createdAt))}`,
    ]
    ctx.stdout.write(`${block.join('\n')}\n`)
  }
  return failed(errors)
}

// ---------------------------------------------------------------------------
// realpath
// ---------------------------------------------------------------------------

/**
 * `realpath [-e | -m] PATH...`
 *
 * Each path made absolute, with `.`, `..` and repeated slashes
 * resolved. By default its directory must exist; `-e` asks the path
 * itself to, `-m` neither. There are no symlinks to follow.
 */
export const realpath: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        existing: { aliases: ['-e', '--canonicalize-existing'] },
        missing: { aliases: ['-m', '--canonicalize-missing'] },
        strip: { aliases: ['-s', '--strip', '--no-symlinks'] },
      },
      minPositional: 1,
    },
    'realpath',
  )
  const errors: string[] = []
  for (const path of parsed.positional) {
    const abs = normalize(resolve(path, ctx.fs.getcwd()))
    if (parsed.flags.missing !== true) {
      const parent = abs === '/' ? '/' : abs.slice(0, abs.lastIndexOf('/')) || '/'
      const must = parsed.flags.existing === true ? abs : parent
      if (!(await ctx.fs.exists(must)) || (must === parent && !(await ctx.fs.isDir(parent)))) {
        errors.push(`realpath: ${path}: No such file or directory`)
        continue
      }
    }
    ctx.stdout.write(`${abs}\n`)
  }
  return failed(errors)
}
