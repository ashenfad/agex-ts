/**
 * Archive commands: `gzip`, `gunzip`, `tar`, `zip`, `unzip`.
 *
 * gzip + zip are powered by `fflate` (browser-safe, zero Node deps).
 * tar uses an in-house USTAR reader/writer in `_tar.ts`.
 *
 * stdout for binary data: `gzip -c` writes compressed bytes to stdout.
 * Termish stdout is a string pipeline, so we encode the bytes via
 * latin-1 (1:1 byte→codepoint), matching termish-py. Pipelines that
 * need to round-trip the bytes through a builtin that decodes UTF-8
 * will misbehave — the docs surface this caveat.
 */

import { gunzipSync, gzipSync, unzipSync, zipSync } from 'fflate'
import type { CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { basename, dirname, joinPath, normalize } from '../fs/path'
import type { FileSystem } from '../fs/protocol'
import { parseArgs } from './_argparse'
import { type TarEntry, readTar, writeTar } from './_tar'

const decoder = new TextDecoder('utf-8', { fatal: false })
const latin1 = new TextDecoder('latin1')
const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// gzip / gunzip
// ---------------------------------------------------------------------------

export const gzip: CommandHandler = async (ctx) => {
  // Pre-pass: pluck `-1`..`-9` compression-level shorthand before argparse.
  let level = 9
  const filtered: string[] = []
  for (const a of ctx.args) {
    if (/^-[1-9]$/.test(a)) level = Number.parseInt(a.slice(1), 10)
    else filtered.push(a)
  }

  const parsed = parseArgs(
    filtered,
    {
      flags: {
        decompress: { aliases: ['-d', '--decompress'] },
        keep: { aliases: ['-k', '--keep'] },
        force: { aliases: ['-f', '--force'] },
        toStdout: { aliases: ['-c', '--stdout'] },
      },
    },
    'gzip',
  )

  if (parsed.positional.length === 0) throw new TerminalError('gzip: no files specified')

  for (const path of parsed.positional) {
    const decompress = parsed.flags.decompress === true
    const keep = parsed.flags.keep === true
    const force = parsed.flags.force === true
    const toStdout = parsed.flags.toStdout === true

    let content: Uint8Array
    try {
      content = await ctx.fs.read(path)
    } catch (e) {
      throw new TerminalError(`gzip: ${path}: ${describeError(e)}`)
    }

    if (decompress) {
      if (!path.endsWith('.gz')) {
        throw new TerminalError(`gzip: ${path}: unknown suffix -- ignored`)
      }
      let result: Uint8Array
      try {
        result = gunzipSync(content)
      } catch (e) {
        throw new TerminalError(`gzip: ${path}: ${describeError(e)}`)
      }
      if (toStdout) {
        ctx.stdout.write(decoder.decode(result))
      } else {
        const outPath = path.slice(0, -3)
        if ((await ctx.fs.exists(outPath)) && !force) {
          throw new TerminalError(`gzip: ${outPath} already exists; use -f to overwrite`)
        }
        await ctx.fs.write(outPath, result)
        if (!keep) await ctx.fs.remove(path)
      }
    } else {
      if (path.endsWith('.gz')) {
        throw new TerminalError(`gzip: ${path} already has .gz suffix -- unchanged`)
      }
      const result = gzipSync(content, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 })
      if (toStdout) {
        ctx.stdout.write(latin1.decode(result))
      } else {
        const outPath = `${path}.gz`
        if ((await ctx.fs.exists(outPath)) && !force) {
          throw new TerminalError(`gzip: ${outPath} already exists; use -f to overwrite`)
        }
        await ctx.fs.write(outPath, result)
        if (!keep) await ctx.fs.remove(path)
      }
    }
  }
}

export const gunzip: CommandHandler = async (ctx) => {
  return gzip({ ...ctx, args: ['-d', ...ctx.args] })
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

export const tar: CommandHandler = async (ctx) => {
  let args: readonly string[] = ctx.args
  // Traditional dashless form: `tar czf x.tar.gz ...` → `tar -czf ...`.
  if (args.length > 0) {
    const first = args[0] as string
    if (!first.startsWith('-') && /[cxt]/.test(first)) {
      args = [`-${first}`, ...args.slice(1)]
    }
  }

  const parsed = parseArgs(
    args,
    {
      flags: {
        create: { aliases: ['-c', '--create'] },
        extract: { aliases: ['-x', '--extract'] },
        list: { aliases: ['-t', '--list'] },
        file: { aliases: ['-f', '--file'], takesValue: true },
        gzipFlag: { aliases: ['-z', '--gzip'] },
        verbose: { aliases: ['-v', '--verbose'] },
        directory: { aliases: ['-C', '--directory'], takesValue: true },
        stripComponents: { aliases: ['--strip-components'], takesValue: true },
      },
    },
    'tar',
  )

  const modeCount =
    (parsed.flags.create === true ? 1 : 0) +
    (parsed.flags.extract === true ? 1 : 0) +
    (parsed.flags.list === true ? 1 : 0)
  if (modeCount !== 1) {
    throw new TerminalError('tar: exactly one of -c, -x, -t must be specified')
  }
  const file = parsed.flags.file as string | undefined
  if (file === undefined) throw new TerminalError('tar: -f option is required')

  const useGzip = parsed.flags.gzipFlag === true
  const verbose = parsed.flags.verbose === true
  const chdir = parsed.flags.directory as string | undefined
  const stripStr = parsed.flags.stripComponents as string | undefined
  const strip = stripStr === undefined ? 0 : Number.parseInt(stripStr, 10)

  if (parsed.flags.create === true) {
    if (parsed.positional.length === 0) {
      throw new TerminalError('tar: no files specified for archive')
    }
    const entries: TarEntry[] = []
    for (const p of parsed.positional) {
      // -C: lookup happens under chdir, but the arcname stays as written.
      const lookup = normalize(joinPath(chdir ?? '', p))
      await collectTarEntries(ctx.fs, lookup, p, entries, verbose, ctx.stdout)
    }
    let bytes = writeTar(entries)
    if (useGzip) bytes = gzipSync(bytes)
    await ctx.fs.write(file, bytes)
    return
  }

  const targetDir = chdir ?? ctx.fs.getcwd()
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.read(file)
  } catch (e) {
    throw new TerminalError(`tar: ${file}: ${describeError(e)}`)
  }
  if (useGzip || isGzipMagic(bytes)) {
    try {
      bytes = gunzipSync(bytes)
    } catch (e) {
      throw new TerminalError(`tar: error reading archive: ${describeError(e)}`)
    }
  }

  let entries: TarEntry[]
  try {
    entries = readTar(bytes)
  } catch (e) {
    throw new TerminalError(`tar: error reading archive: ${describeError(e)}`)
  }

  if (parsed.flags.list === true) {
    for (const e of entries) ctx.stdout.write(`${e.name}\n`)
    return
  }

  // extract
  for (const e of entries) {
    if (e.name.split('/').includes('..')) {
      throw new TerminalError(`tar: ${e.name}: path traversal detected, skipping`)
    }
    let safe = e.name.replace(/^\/+/, '')
    if (safe.length === 0) continue
    if (strip > 0) {
      const parts = safe.split('/')
      const stripped = parts.slice(strip)
      if (stripped.length === 0 || (stripped.length === 1 && stripped[0] === '')) continue
      safe = stripped.join('/')
    }
    if (basename(safe).startsWith('._')) continue

    const outPath = joinPath(targetDir, safe)
    if (e.type === 'dir') {
      await ctx.fs.mkdir(outPath, { parents: true, existOk: true })
    } else if (e.type === 'file') {
      const parent = dirname(outPath)
      if (parent !== '/' && parent !== '') {
        await ctx.fs.mkdir(parent, { parents: true, existOk: true })
      }
      await ctx.fs.write(outPath, e.content)
    }
    if (verbose) ctx.stdout.write(`${e.name}\n`)
  }
}

async function collectTarEntries(
  fs: FileSystem,
  filePath: string,
  arcname: string,
  out: TarEntry[],
  verbose: boolean,
  stdout: { write(s: string): void },
): Promise<void> {
  if (!(await fs.exists(filePath))) {
    throw new TerminalError(`tar: ${filePath}: No such file or directory`)
  }
  const isDir = await fs.isDir(filePath)
  if (isDir) {
    out.push({
      name: `${arcname.replace(/\/$/, '')}/`,
      type: 'dir',
      content: new Uint8Array(0),
      mode: 0o755,
      mtime: 0,
    })
    if (verbose) stdout.write(`${arcname}/\n`)
    const children = await fs.list(filePath)
    for (const name of children) {
      await collectTarEntries(
        fs,
        joinPath(filePath, name),
        joinPath(arcname, name),
        out,
        verbose,
        stdout,
      )
    }
  } else {
    const content = await fs.read(filePath)
    out.push({ name: arcname, type: 'file', content, mode: 0o644, mtime: 0 })
    if (verbose) stdout.write(`${arcname}\n`)
  }
}

function isGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

// ---------------------------------------------------------------------------
// zip / unzip
// ---------------------------------------------------------------------------

export const zip: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        recurse: { aliases: ['-r', '--recurse-paths'] },
      },
      minPositional: 1,
    },
    'zip',
  )

  if (parsed.positional.length < 2) throw new TerminalError('zip: no files specified')

  let archivePath = parsed.positional[0] as string
  if (!archivePath.endsWith('.zip')) archivePath += '.zip'
  const files = parsed.positional.slice(1)

  const recursive = parsed.flags.recurse === true
  const tree: Record<string, Uint8Array> = {}
  for (const p of files) await collectZipEntries(ctx.fs, p, p, recursive, tree)

  const bytes = zipSync(tree)
  await ctx.fs.write(archivePath, bytes)
}

async function collectZipEntries(
  fs: FileSystem,
  filePath: string,
  arcname: string,
  recursive: boolean,
  tree: Record<string, Uint8Array>,
): Promise<void> {
  if (!(await fs.exists(filePath))) {
    throw new TerminalError(`zip: ${filePath}: No such file or directory`)
  }
  if (await fs.isDir(filePath)) {
    if (!recursive) throw new TerminalError(`zip: ${filePath}: is a directory (use -r to include)`)
    // Directory marker — fflate uses trailing slash.
    tree[`${arcname.replace(/\/$/, '')}/`] = new Uint8Array(0)
    const children = await fs.list(filePath)
    for (const name of children) {
      await collectZipEntries(
        fs,
        joinPath(filePath, name),
        joinPath(arcname, name),
        recursive,
        tree,
      )
    }
  } else {
    tree[arcname] = await fs.read(filePath)
  }
}

export const unzip: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        list: { aliases: ['-l', '--list'] },
        directory: { aliases: ['-d', '--directory'], takesValue: true },
        overwrite: { aliases: ['-o', '--overwrite'] },
      },
      minPositional: 1,
    },
    'unzip',
  )
  const archivePath = parsed.positional[0] as string
  const targetDir = (parsed.flags.directory as string | undefined) ?? ctx.fs.getcwd()
  const wantedFiles = new Set(parsed.positional.slice(1))

  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.read(archivePath)
  } catch {
    throw new TerminalError(`unzip: cannot find ${archivePath}`)
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new TerminalError(`unzip: ${archivePath}: not a valid zip file`)
  }

  const list = parsed.flags.list === true
  if (list) {
    ctx.stdout.write(`Archive:  ${archivePath}\n`)
    ctx.stdout.write('  Length      Name\n')
    ctx.stdout.write('---------  ----\n')
    let total = 0
    let count = 0
    for (const [name, data] of Object.entries(entries)) {
      ctx.stdout.write(`${data.length.toString().padStart(9, ' ')}  ${name}\n`)
      total += data.length
      count++
    }
    ctx.stdout.write('---------  ----\n')
    ctx.stdout.write(`${total.toString().padStart(9, ' ')}  ${count} files\n`)
    return
  }

  for (const [name, data] of Object.entries(entries)) {
    if (wantedFiles.size > 0 && !wantedFiles.has(name)) continue
    if (name.split('/').includes('..')) {
      throw new TerminalError(`unzip: ${name}: path traversal detected, skipping`)
    }
    const safe = name.replace(/^\/+/, '')
    if (safe.length === 0) continue
    if (basename(safe).startsWith('._')) continue

    const outPath = joinPath(targetDir, safe)
    const isDir = name.endsWith('/')
    if (isDir) {
      await ctx.fs.mkdir(outPath, { parents: true, existOk: true })
    } else {
      const parent = dirname(outPath)
      if (parent !== '/' && parent !== '') {
        await ctx.fs.mkdir(parent, { parents: true, existOk: true })
      }
      if ((await ctx.fs.exists(outPath)) && parsed.flags.overwrite !== true) {
        ctx.stdout.write(`  skipping: ${safe} (already exists)\n`)
        continue
      }
      await ctx.fs.write(outPath, data)
      ctx.stdout.write(`  inflating: ${safe}\n`)
    }
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Force module load of encoder so it's not flagged as unused if all
// code paths get tree-shaken in tests.
void encoder
