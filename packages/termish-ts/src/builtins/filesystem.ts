/**
 * Filesystem builtins: `pwd`, `cd`, `ls`, `mkdir`, `touch`, `cp`, `mv`,
 * `rm`, `basename`, `dirname`.
 *
 * All ten ports follow termish-py's behavior including the flag set.
 * Each command parses its own argv via the local `parseArgs` helper
 * and translates errors into `TerminalError` with the standard
 * `<prog>: <message>` shape agents are used to seeing.
 */

import type { CommandContext, CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { describeFsError } from '../fs/errors'
import { joinPath, basename as pathBasename, dirname as pathDirname, resolve } from '../fs/path'
import type { FileInfo, FileSystem } from '../fs/protocol'
import { parseArgs } from './_argparse'
import { formatLsTime, humanSize, padLeft } from './_util'

// ---------------------------------------------------------------------------
// pwd, cd
// ---------------------------------------------------------------------------

export const pwd: CommandHandler = async (ctx) => {
  ctx.stdout.write(`${ctx.fs.getcwd()}\n`)
}

export const cd: CommandHandler = async (ctx) => {
  const path = ctx.args.length === 0 ? '/' : (ctx.args[0] as string)
  try {
    await ctx.fs.chdir(path)
  } catch (e) {
    throw new TerminalError(`cd: ${describeError(e, path)}`)
  }
}

// ---------------------------------------------------------------------------
// mkdir
// ---------------------------------------------------------------------------

export const mkdir: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: { parents: { aliases: ['-p', '--parents'] } },
      minPositional: 1,
    },
    'mkdir',
  )
  for (const path of parsed.positional) {
    try {
      await ctx.fs.mkdir(path, {
        parents: parsed.flags.parents === true,
        existOk: parsed.flags.parents === true,
      })
    } catch (e) {
      throw new TerminalError(`mkdir: cannot create directory '${path}': ${describeError(e)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

export const ls: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        long: { aliases: ['-l'] },
        all: { aliases: ['-a'] },
        recursive: { aliases: ['-R'] },
        humanReadable: { aliases: ['-h', '--human-readable'] },
        time: { aliases: ['-t'] },
        size: { aliases: ['-S'] },
        reverse: { aliases: ['-r'] },
        directory: { aliases: ['-d', '--directory'] },
        classify: { aliases: ['-F', '--classify'] },
        onePerLine: { aliases: ['-1'] },
      },
    },
    'ls',
  )
  const flag = (name: string): boolean => parsed.flags[name] === true
  const operands = parsed.positional.length > 0 ? parsed.positional : ['.']
  const fs = ctx.fs

  const sizeText = (size: number): string =>
    flag('humanReadable') ? padLeft(humanSize(size), 6) : padLeft(`${size}`, 8)
  const longLine = (type: string, size: number, modifiedAt: string, path: string): string =>
    `${type}rw-r--r-- 1 agent agent ${sizeText(size)} ${formatLsTime(modifiedAt)} ${path}\n`

  const listDir = async (path: string): Promise<void> => {
    const recursive = flag('recursive')
    if (flag('long') || flag('time') || flag('size') || flag('classify')) {
      let items: FileInfo[] = await fs.listDetailed(path, { recursive })
      if (!flag('all')) items = items.filter((it) => !pathBasename(it.path).startsWith('.'))
      if (flag('size')) items = [...items].sort((a, b) => b.size - a.size)
      else if (flag('time')) {
        items = [...items].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''))
      }
      if (flag('reverse')) items = [...items].reverse()
      const suffix = (it: FileInfo): string => (flag('classify') && it.isDir ? '/' : '')
      if (flag('long')) {
        for (const it of items) {
          ctx.stdout.write(
            longLine(it.isDir ? 'd' : '-', it.size, it.modifiedAt, `${it.path}${suffix(it)}`),
          )
        }
      } else if (items.length > 0) {
        ctx.stdout.write(`${items.map((it) => `${it.path}${suffix(it)}`).join('\n')}\n`)
      }
      return
    }
    let names = (await fs.list(path, { recursive })).filter(
      (p) => flag('all') || !(pathBasename(p) || p).startsWith('.'),
    )
    if (flag('reverse')) names = [...names].reverse()
    if (names.length > 0) ctx.stdout.write(`${names.join('\n')}\n`)
  }

  // GNU's order: a missing operand is reported and the rest are listed;
  // file operands (and, with -d, directories as entries) come first, by
  // name and with no header; then each directory, by name, under a
  // `dir:` header whenever there is more than one operand, with a blank
  // line before every group after the first.
  const missing: string[] = []
  const files: string[] = []
  const dirs: string[] = []
  for (const path of operands) {
    try {
      if (await fs.isDir(path)) (flag('directory') ? files : dirs).push(path)
      else if (await fs.exists(path)) files.push(path)
      else missing.push(path)
    } catch {
      missing.push(path)
    }
  }

  // Operands in the order their entries would be: by name, or by size
  // or time (largest and newest first) under -S and -t, reversed by -r.
  const operandOrder = async (paths: string[]): Promise<string[]> => {
    let ordered = [...paths].sort()
    if (flag('size') || flag('time')) {
      const keys = new Map<string, number | string>()
      for (const p of ordered) {
        try {
          const meta = await fs.stat(p)
          keys.set(p, flag('size') ? meta.size : (meta.modifiedAt ?? ''))
        } catch {
          keys.set(p, flag('size') ? 0 : '')
        }
      }
      ordered = ordered.sort((a, b) => {
        const ka = keys.get(a) as number | string
        const kb = keys.get(b) as number | string
        if (ka === kb) return 0
        return ka < kb ? 1 : -1
      })
    }
    return flag('reverse') ? ordered.reverse() : ordered
  }

  const orderedFiles = await operandOrder(files)
  const orderedDirs = await operandOrder(dirs)
  const errors = missing.map((p) => `ls: cannot access '${p}': No such file or directory`)
  if (orderedFiles.length === 0 && orderedDirs.length === 0) {
    throw new TerminalError(errors.join('\n'), { exitCode: 2 })
  }

  for (const path of orderedFiles) {
    if (flag('long')) {
      try {
        const meta = await fs.stat(path)
        ctx.stdout.write(longLine(meta.isDir ? 'd' : '-', meta.size, meta.modifiedAt, path))
      } catch (e) {
        throw new TerminalError(`ls: cannot access '${path}': ${describeError(e)}`)
      }
    } else {
      ctx.stdout.write(`${path}\n`)
    }
  }
  const headers = operands.length > 1
  for (let k = 0; k < orderedDirs.length; k++) {
    const path = orderedDirs[k] as string
    if (orderedFiles.length > 0 || k > 0) ctx.stdout.write('\n')
    if (headers) ctx.stdout.write(`${path}:\n`)
    try {
      await listDir(path)
    } catch (e) {
      throw new TerminalError(`ls: cannot access '${path}': ${describeError(e)}`)
    }
  }

  if (errors.length > 0) return { exitCode: 2, stderr: `${errors.join('\n')}\n` }
  return undefined
}

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------

export const touch: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: { noCreate: { aliases: ['-c', '--no-create'] } },
      minPositional: 1,
    },
    'touch',
  )
  for (const path of parsed.positional) {
    try {
      const exists = await ctx.fs.exists(path)
      if (!exists) {
        if (parsed.flags.noCreate === true) continue
        await ctx.fs.write(path, new Uint8Array(0))
      } else {
        // Re-write existing content to bump mtime (matching termish-py).
        const content = await ctx.fs.read(path)
        await ctx.fs.write(path, content)
      }
    } catch (e) {
      throw new TerminalError(`touch: ${describeError(e, path)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------------

export const cp: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        recursive: { aliases: ['-r', '-R'] },
        archive: { aliases: ['-a', '--archive'] },
      },
      minPositional: 2,
    },
    'cp',
  )
  // Last positional is dst; everything before is sources.
  const sources = parsed.positional.slice(0, -1)
  const dst = parsed.positional[parsed.positional.length - 1] as string
  const recursive = parsed.flags.recursive === true || parsed.flags.archive === true

  if (sources.length > 1 && !(await ctx.fs.isDir(dst))) {
    throw new TerminalError(`cp: target '${dst}' is not a directory`)
  }

  for (const src of sources) {
    try {
      if (await ctx.fs.isDir(src)) {
        if (!recursive) {
          throw new TerminalError(`cp: -r not specified; omitting directory '${src}'`)
        }
        // Determine target: if dst is a dir, copy under it; else dst is the new name.
        const targetPath = (await ctx.fs.isDir(dst))
          ? joinPath(dst.replace(/\/$/, ''), pathBasename(src.replace(/\/$/, '')))
          : dst
        // Reject "copy into self" (dst path inside src tree).
        const srcAbs = resolve(src, ctx.fs.getcwd())
        const dstAbs = resolve(targetPath, ctx.fs.getcwd())
        if (dstAbs === srcAbs || dstAbs.startsWith(`${srcAbs}/`)) {
          throw new TerminalError(`cp: cannot copy '${src}' into itself`)
        }
        await copyRecursive(src, targetPath, ctx.fs)
      } else {
        const content = await ctx.fs.read(src)
        const targetPath = (await ctx.fs.isDir(dst))
          ? joinPath(dst.replace(/\/$/, ''), pathBasename(src))
          : dst
        await ctx.fs.write(targetPath, content)
      }
    } catch (e) {
      if (e instanceof TerminalError) throw e
      throw new TerminalError(`cp: cannot stat '${src}': ${describeError(e)}`)
    }
  }
}

async function copyRecursive(src: string, dst: string, fs: FileSystem): Promise<void> {
  if (!(await fs.exists(dst))) await fs.mkdir(dst)
  for (const item of await fs.listDetailed(src)) {
    const name = pathBasename(item.path.replace(/\/$/, ''))
    const srcChild = joinPath(src.replace(/\/$/, ''), name)
    const dstChild = joinPath(dst.replace(/\/$/, ''), name)
    if (item.isDir) {
      await copyRecursive(srcChild, dstChild, fs)
    } else {
      const content = await fs.read(srcChild)
      await fs.write(dstChild, content)
    }
  }
}

// ---------------------------------------------------------------------------
// mv
// ---------------------------------------------------------------------------

export const mv: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        force: { aliases: ['-f', '--force'] },
        noClobber: { aliases: ['-n', '--no-clobber'] },
      },
      minPositional: 2,
    },
    'mv',
  )
  // Last positional is the destination; everything before is a source.
  // Matches POSIX `mv` and our own `cp`. Multi-source mandates that
  // the destination is an existing directory.
  const sources = parsed.positional.slice(0, -1)
  const dstArg = parsed.positional[parsed.positional.length - 1] as string
  const force = parsed.flags.force === true
  // POSIX: -f overrides -n.
  const noClobber = !force && parsed.flags.noClobber === true

  const dstIsDir = await ctx.fs.isDir(dstArg)
  const trailingSlash = dstArg.endsWith('/') && dstArg !== '/'

  if (trailingSlash && !dstIsDir) {
    throw new TerminalError(`mv: target '${dstArg}': Not a directory`)
  }
  if (sources.length > 1 && !dstIsDir) {
    throw new TerminalError(`mv: target '${dstArg}' is not a directory`)
  }

  // Strip a single trailing slash for joining; root keeps its slash.
  const dstNormalized = trailingSlash ? dstArg.slice(0, -1) : dstArg

  for (const src of sources) {
    const target = dstIsDir ? joinPath(dstNormalized, pathBasename(src.replace(/\/$/, ''))) : dstArg
    // Reject "move into self" symmetric with cp's check — would be
    // unrecoverable (rename would shuffle the tree partially).
    if (dstIsDir) {
      const srcAbs = resolve(src, ctx.fs.getcwd())
      const targetAbs = resolve(target, ctx.fs.getcwd())
      if (targetAbs === srcAbs || targetAbs.startsWith(`${srcAbs}/`)) {
        throw new TerminalError(`mv: cannot move '${src}' to a subdirectory of itself, '${target}'`)
      }
    }
    if (noClobber && (await ctx.fs.exists(target))) continue
    try {
      await ctx.fs.rename(src, target)
    } catch (e) {
      throw new TerminalError(`mv: cannot stat '${src}': ${describeError(e)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

export const rm: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        recursive: { aliases: ['-r', '-R'] },
        force: { aliases: ['-f', '--force'] },
      },
      minPositional: 1,
    },
    'rm',
  )
  for (const path of parsed.positional) {
    try {
      if (await ctx.fs.isDir(path)) {
        if (parsed.flags.recursive !== true) {
          throw new TerminalError(`rm: cannot remove '${path}': Is a directory (use -r to remove)`)
        }
        const abs = resolve(path, ctx.fs.getcwd())
        if (abs === '/' || abs === '') {
          throw new TerminalError('rm: cannot remove root directory')
        }
        await removeRecursive(path, ctx.fs)
      } else if (await ctx.fs.exists(path)) {
        await ctx.fs.remove(path)
      } else if (parsed.flags.force !== true) {
        throw new TerminalError(`rm: cannot remove '${path}': No such file or directory`)
      }
    } catch (e) {
      if (e instanceof TerminalError) throw e
      throw new TerminalError(`rm: ${path}: ${describeError(e)}`)
    }
  }
}

async function removeRecursive(path: string, fs: FileSystem): Promise<void> {
  for (const item of await fs.listDetailed(path)) {
    const name = pathBasename(item.path.replace(/\/$/, ''))
    const childPath = joinPath(path.replace(/\/$/, ''), name)
    if (item.isDir) {
      await removeRecursive(childPath, fs)
    } else {
      await fs.remove(childPath)
    }
  }
  await fs.rmdir(path)
}

// ---------------------------------------------------------------------------
// basename, dirname (text-only — no FS access)
// ---------------------------------------------------------------------------

export const basename: CommandHandler = async (ctx: CommandContext) => {
  if (ctx.args.length === 0) throw new TerminalError('basename: missing operand')
  const path = ctx.args[0] as string
  const stripped = path.replace(/\/$/, '')
  let name = stripped.includes('/') ? (stripped.split('/').pop() as string) : stripped
  if (ctx.args.length > 1) {
    const suffix = ctx.args[1] as string
    if (name !== suffix && name.endsWith(suffix)) {
      name = name.slice(0, name.length - suffix.length)
    }
  }
  ctx.stdout.write(`${name}\n`)
}

export const dirname: CommandHandler = async (ctx: CommandContext) => {
  if (ctx.args.length === 0) throw new TerminalError('dirname: missing operand')
  const path = ctx.args[0] as string
  if (!path.includes('/')) {
    ctx.stdout.write('.\n')
    return
  }
  const parent = path.replace(/\/$/, '').split('/').slice(0, -1).join('/')
  ctx.stdout.write(`${parent.length > 0 ? parent : '/'}\n`)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeError(e: unknown, contextPath?: string): string {
  const msg = describeFsError(e)
  if (contextPath !== undefined && !msg.includes(contextPath)) {
    return `${contextPath}: ${msg}`
  }
  return msg
}

// Reference pathDirname so the import isn't unused — used by future
// commands in this file (cp/rm currently use it via joinPath alongside
// basename). Keep this here so a refactor that drops one of them
// doesn't silently lose the import.
void pathDirname
