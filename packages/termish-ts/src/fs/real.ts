/**
 * `RealFS` — Node.js-backed `FileSystem` rooted at a host directory.
 *
 * Every virtual POSIX path (`/data/file.txt`) maps to a real path under
 * the configured `root` (`${root}/data/file.txt`). The root acts as
 * the FS's virtual `/`, so agent code that operates on `/foo` cannot
 * reach anything outside the sandbox.
 *
 * Designed for Node only — the implementation imports `node:fs/promises`.
 * For browser-side real-FS access, use the File System Access API in a
 * separate adapter (not implemented here).
 */

import { promises as fsp } from 'node:fs'
import * as nodePath from 'node:path/posix'
import { dirname, joinPath, resolve } from './path'
import type { FileInfo, FileMetadata, FileSystem } from './protocol'

export interface RealFSOptions {
  /** Absolute host-side path that becomes the virtual `/`. The
   *  directory must already exist; the constructor does not create it. */
  readonly root: string
  /** Initial virtual cwd. Defaults to `/`. */
  readonly cwd?: string
}

export class RealFS implements FileSystem {
  readonly #root: string
  #cwd: string

  constructor(opts: RealFSOptions) {
    if (!nodePath.isAbsolute(opts.root)) {
      throw new Error(`RealFS: root must be absolute, got: ${opts.root}`)
    }
    this.#root = nodePath.normalize(opts.root).replace(/\/+$/, '') || '/'
    this.#cwd = opts.cwd ?? '/'
  }

  // ---------- cwd ----------

  getcwd(): string {
    return this.#cwd
  }

  async chdir(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    const real = this.#toReal(abs)
    let stat: Awaited<ReturnType<typeof fsp.stat>>
    try {
      stat = await fsp.stat(real)
    } catch {
      throw new Error(`chdir: not a directory: ${path}`)
    }
    if (!stat.isDirectory()) throw new Error(`chdir: not a directory: ${path}`)
    this.#cwd = abs
  }

  // ---------- reads ----------

  async read(path: string): Promise<Uint8Array> {
    const real = this.#toReal(resolve(path, this.#cwd))
    let stat: Awaited<ReturnType<typeof fsp.stat>>
    try {
      stat = await fsp.stat(real)
    } catch {
      throw new Error(`read: no such file: ${path}`)
    }
    if (stat.isDirectory()) throw new Error(`read: is a directory: ${path}`)
    const buf = await fsp.readFile(real)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async exists(path: string): Promise<boolean> {
    const real = this.#toReal(resolve(path, this.#cwd))
    try {
      await fsp.stat(real)
      return true
    } catch {
      return false
    }
  }

  async isFile(path: string): Promise<boolean> {
    const real = this.#toReal(resolve(path, this.#cwd))
    try {
      const s = await fsp.stat(real)
      return s.isFile()
    } catch {
      return false
    }
  }

  async isDir(path: string): Promise<boolean> {
    const real = this.#toReal(resolve(path, this.#cwd))
    try {
      const s = await fsp.stat(real)
      return s.isDirectory()
    } catch {
      return false
    }
  }

  async stat(path: string): Promise<FileMetadata> {
    const real = this.#toReal(resolve(path, this.#cwd))
    let s: Awaited<ReturnType<typeof fsp.stat>>
    try {
      s = await fsp.stat(real)
    } catch {
      throw new Error(`stat: no such file or directory: ${path}`)
    }
    return {
      size: s.isDirectory() ? 0 : s.size,
      createdAt: new Date(s.birthtimeMs || s.ctimeMs).toISOString(),
      modifiedAt: new Date(s.mtimeMs).toISOString(),
      isDir: s.isDirectory(),
    }
  }

  // ---------- writes ----------

  async write(path: string, content: Uint8Array, mode: 'w' | 'a' = 'w'): Promise<void> {
    const abs = resolve(path, this.#cwd)
    const real = this.#toReal(abs)
    // Match MemoryFS: error if parent doesn't exist (no implicit mkdir).
    const parentReal = this.#toReal(dirname(abs))
    try {
      const s = await fsp.stat(parentReal)
      if (!s.isDirectory()) {
        throw new Error(`write: parent directory does not exist: ${dirname(abs)}`)
      }
    } catch {
      throw new Error(`write: parent directory does not exist: ${dirname(abs)}`)
    }
    // Match MemoryFS: error if path is a directory.
    try {
      const s = await fsp.stat(real)
      if (s.isDirectory()) throw new Error(`write: is a directory: ${path}`)
    } catch (e) {
      // Stat failure is fine — file just doesn't exist yet.
      if (e instanceof Error && e.message.startsWith('write:')) throw e
    }
    await fsp.writeFile(real, content, { flag: mode === 'a' ? 'a' : 'w' })
  }

  async mkdir(path: string, opts: { parents?: boolean; existOk?: boolean } = {}): Promise<void> {
    const abs = resolve(path, this.#cwd)
    const real = this.#toReal(abs)
    try {
      const s = await fsp.stat(real)
      if (s.isFile()) throw new Error(`mkdir: file exists at path: ${path}`)
      if (s.isDirectory()) {
        if (opts.existOk) return
        throw new Error(`mkdir: directory exists: ${path}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('mkdir:')) throw e
      // Doesn't exist yet — fine, fall through.
    }
    if (!opts.parents) {
      const parentReal = this.#toReal(dirname(abs))
      try {
        const s = await fsp.stat(parentReal)
        if (!s.isDirectory()) {
          throw new Error(`mkdir: parent directory does not exist: ${dirname(abs)}`)
        }
      } catch {
        throw new Error(`mkdir: parent directory does not exist: ${dirname(abs)}`)
      }
    }
    await fsp.mkdir(real, { recursive: opts.parents === true })
  }

  async remove(path: string): Promise<void> {
    const real = this.#toReal(resolve(path, this.#cwd))
    let s: Awaited<ReturnType<typeof fsp.stat>>
    try {
      s = await fsp.stat(real)
    } catch {
      throw new Error(`remove: no such file: ${path}`)
    }
    if (s.isDirectory()) throw new Error(`remove: is a directory: ${path}`)
    await fsp.unlink(real)
  }

  async rmdir(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (abs === '/') throw new Error('rmdir: cannot remove root')
    const real = this.#toReal(abs)
    let s: Awaited<ReturnType<typeof fsp.stat>>
    try {
      s = await fsp.stat(real)
    } catch {
      throw new Error(`rmdir: no such directory: ${path}`)
    }
    if (!s.isDirectory()) throw new Error(`rmdir: not a directory: ${path}`)
    const entries = await fsp.readdir(real)
    if (entries.length > 0) throw new Error(`rmdir: directory not empty: ${path}`)
    await fsp.rmdir(real)
  }

  async rename(src: string, dst: string): Promise<void> {
    const realSrc = this.#toReal(resolve(src, this.#cwd))
    const realDst = this.#toReal(resolve(dst, this.#cwd))
    if (realSrc === realDst) return
    try {
      await fsp.stat(realSrc)
    } catch {
      throw new Error(`rename: no such file or directory: ${src}`)
    }
    const dstParent = dirname(resolve(dst, this.#cwd))
    try {
      const s = await fsp.stat(this.#toReal(dstParent))
      if (!s.isDirectory()) {
        throw new Error(`rename: parent directory does not exist: ${dstParent}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('rename:')) throw e
      throw new Error(`rename: parent directory does not exist: ${dstParent}`)
    }
    await fsp.rename(realSrc, realDst)
  }

  // ---------- iteration ----------

  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    const abs = resolve(path, this.#cwd)
    const real = this.#toReal(abs)
    let stat: Awaited<ReturnType<typeof fsp.stat>>
    try {
      stat = await fsp.stat(real)
    } catch {
      throw new Error(`list: no such directory: ${path}`)
    }
    if (!stat.isDirectory()) throw new Error(`list: not a directory: ${path}`)

    const out: string[] = []
    if (opts.recursive) {
      await walk(real, '', out)
    } else {
      const entries = await fsp.readdir(real)
      for (const e of entries) out.push(e)
    }
    return out.sort()
  }

  async listDetailed(path = '.', opts: { recursive?: boolean } = {}): Promise<FileInfo[]> {
    const names = await this.list(path, opts)
    const userPrefix = path === '/' ? '/' : path.replace(/\/$/, '')
    const baseReal = this.#toReal(resolve(path, this.#cwd))
    const out: FileInfo[] = []
    for (const name of names) {
      const childReal = nodePath.join(baseReal, name)
      let s: Awaited<ReturnType<typeof fsp.stat>>
      try {
        s = await fsp.stat(childReal)
      } catch {
        continue // pruned mid-iteration
      }
      const last = name.includes('/') ? (name.slice(name.lastIndexOf('/') + 1) as string) : name
      out.push({
        name: last,
        path: joinPath(userPrefix, name),
        size: s.isDirectory() ? 0 : s.size,
        createdAt: new Date(s.birthtimeMs || s.ctimeMs).toISOString(),
        modifiedAt: new Date(s.mtimeMs).toISOString(),
        isDir: s.isDirectory(),
      })
    }
    return out
  }

  // ---------- internal ----------

  /** Map a virtual absolute path to a real host path under `root`.
   *  Throws if the path would escape the root. */
  #toReal(virtualAbs: string): string {
    // `resolve()` already collapsed `..`, so it can never escape `/`.
    // Guard anyway in case someone constructs paths by hand.
    if (!virtualAbs.startsWith('/')) {
      throw new Error(`RealFS: expected absolute path, got: ${virtualAbs}`)
    }
    const real = nodePath.join(this.#root, virtualAbs)
    if (real !== this.#root && !real.startsWith(`${this.#root}/`)) {
      throw new Error(`RealFS: path escape detected: ${virtualAbs}`)
    }
    return real
  }
}

async function walk(real: string, relPrefix: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(real, { withFileTypes: true })
  for (const e of entries) {
    const childReal = nodePath.join(real, e.name)
    const childRel = relPrefix === '' ? e.name : `${relPrefix}/${e.name}`
    out.push(childRel)
    if (e.isDirectory()) await walk(childReal, childRel, out)
  }
}
