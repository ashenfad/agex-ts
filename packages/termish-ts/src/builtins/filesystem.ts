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
  const paths = parsed.positional.length > 0 ? parsed.positional : ['.']
  const fs = ctx.fs

  // POSIX-style header policy: `dir:` headers only appear when more
  // than one *directory* will be listed (or when files and dirs are
  // mixed — files print first inline, then each dir gets a header).
  // Single-target invocations and pure-file lists never get headers.
  // Pre-classify so we know whether a header is needed before looping.
  const classified: Array<{ path: string; kind: 'file' | 'dir' | 'missing' }> = []
  for (const p of paths) {
    if (await fs.isFile(p)) classified.push({ path: p, kind: 'file' })
    else if (await fs.isDir(p)) classified.push({ path: p, kind: 'dir' })
    else classified.push({ path: p, kind: 'missing' })
  }
  const dirCount = classified.filter((c) => c.kind === 'dir').length
  const fileCount = classified.filter((c) => c.kind === 'file').length
  const showHeaders = dirCount > 1 || (dirCount >= 1 && fileCount >= 1)

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i] as string
    const kind = classified[i]?.kind ?? 'missing'
    if (showHeaders && kind === 'dir') ctx.stdout.write(`${path}:\n`)

    try {
      // -d + directory: list the directory itself, not its contents.
      if (parsed.flags.directory === true && (await fs.isDir(path))) {
        if (parsed.flags.long === true) {
          const meta = await fs.stat(path)
          const sz =
            parsed.flags.humanReadable === true
              ? padLeft(humanSize(meta.size), 6)
              : padLeft(`${meta.size}`, 8)
          const time = formatLsTime(meta.modifiedAt)
          ctx.stdout.write(`drw-r--r-- 1 agent agent ${sz} ${time} ${path}\n`)
        } else {
          ctx.stdout.write(`${path}\n`)
        }
        maybeSeparator(ctx, classified, i)
        continue
      }

      // If the path itself is a file, list just the file (matches `ls foo.txt`).
      if (await fs.isFile(path)) {
        if (parsed.flags.long === true) {
          const meta = await fs.stat(path)
          const sz =
            parsed.flags.humanReadable === true
              ? padLeft(humanSize(meta.size), 6)
              : padLeft(`${meta.size}`, 8)
          const time = formatLsTime(meta.modifiedAt)
          ctx.stdout.write(`-rw-r--r-- 1 agent agent ${sz} ${time} ${path}\n`)
        } else {
          ctx.stdout.write(`${path}\n`)
        }
        maybeSeparator(ctx, classified, i)
        continue
      }

      const needsDetailed =
        parsed.flags.long === true ||
        parsed.flags.time === true ||
        parsed.flags.size === true ||
        parsed.flags.classify === true

      const recursive = parsed.flags.recursive === true
      let items: FileInfo[]

      if (needsDetailed) {
        items = await fs.listDetailed(path, { recursive })
        if (parsed.flags.all !== true) {
          items = items.filter((it) => !pathBasename(it.path).startsWith('.'))
        }
        if (parsed.flags.size === true) {
          items = [...items].sort((a, b) => b.size - a.size)
        } else if (parsed.flags.time === true) {
          items = [...items].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''))
        }
        if (parsed.flags.reverse === true) items = [...items].reverse()

        if (parsed.flags.long === true) {
          for (const it of items) {
            const typeChar = it.isDir ? 'd' : '-'
            const sz =
              parsed.flags.humanReadable === true
                ? padLeft(humanSize(it.size), 6)
                : padLeft(`${it.size}`, 8)
            const time = formatLsTime(it.modifiedAt)
            const suffix = parsed.flags.classify === true && it.isDir ? '/' : ''
            ctx.stdout.write(
              `${typeChar}rw-r--r-- 1 agent agent ${sz} ${time} ${it.path}${suffix}\n`,
            )
          }
        } else {
          const lines = items.map(
            (it) => `${it.path}${parsed.flags.classify === true && it.isDir ? '/' : ''}`,
          )
          if (lines.length > 0) ctx.stdout.write(`${lines.join('\n')}\n`)
        }
      } else {
        const names = await fs.list(path, { recursive })
        let filtered = names.filter(
          (p) => parsed.flags.all === true || !(pathBasename(p) || p).startsWith('.'),
        )
        if (parsed.flags.reverse === true) filtered = [...filtered].reverse()
        if (filtered.length > 0) ctx.stdout.write(`${filtered.join('\n')}\n`)
      }
    } catch (e) {
      throw new TerminalError(`ls: cannot access '${path}': ${describeError(e)}`)
    }

    maybeSeparator(ctx, classified, i)
  }
}

/** Write a blank-line separator between this entry and the next *only*
 *  when both are directories (POSIX-ish: `ls dir1 dir2` puts a blank
 *  line between the two listings; consecutive file args print together
 *  without separators). */
function maybeSeparator(
  ctx: CommandContext,
  classified: ReadonlyArray<{ kind: 'file' | 'dir' | 'missing' }>,
  i: number,
): void {
  if (i >= classified.length - 1) return
  const here = classified[i]?.kind
  const next = classified[i + 1]?.kind
  if (here === 'dir' && next === 'dir') ctx.stdout.write('\n')
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
  const msg = e instanceof Error ? e.message : String(e)
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
