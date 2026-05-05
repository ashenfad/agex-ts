/**
 * In-process `FileSystem` implementation backed by a `Map`.
 *
 * Used by tests, ephemeral agent sessions, and as the reference
 * implementation against which other adapters (RealFS, KvgitFS) are
 * conformance-tested.
 *
 * Path model: POSIX-style absolute paths internally. Relative paths
 * are resolved against the in-memory cwd (defaults to `/`).
 *
 * Directory model: dirs are mostly implicit — `isDir(path)` is true
 * iff *some* file is stored under `path/`. Empty dirs that the user
 * explicitly `mkdir`s get tracked in a separate set so `rmdir` and
 * `list` see them too.
 */

import { basename, dirname, joinPath, resolve } from './path'
import type { FileInfo, FileMetadata, FileSystem } from './protocol'

interface FileMeta {
  readonly createdAt: string
  modifiedAt: string
}

export class MemoryFS implements FileSystem {
  #cwd = '/'
  readonly #files = new Map<string, Uint8Array>()
  readonly #fileMeta = new Map<string, FileMeta>()
  /** Dirs explicitly created via `mkdir`. The root `/` is always present. */
  readonly #explicitDirs = new Set<string>(['/'])
  readonly #dirMeta = new Map<string, FileMeta>([
    ['/', { createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString() }],
  ])

  // ---------- cwd ----------

  getcwd(): string {
    return this.#cwd
  }

  async chdir(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (!this.#dirExists(abs)) {
      throw new Error(`chdir: not a directory: ${path}`)
    }
    this.#cwd = abs
  }

  // ---------- reads ----------

  async read(path: string): Promise<Uint8Array> {
    const abs = resolve(path, this.#cwd)
    const v = this.#files.get(abs)
    if (v === undefined) {
      if (this.#dirExists(abs)) throw new Error(`read: is a directory: ${path}`)
      throw new Error(`read: no such file: ${path}`)
    }
    // Return a fresh view so callers can't mutate stored bytes.
    return new Uint8Array(v)
  }

  async exists(path: string): Promise<boolean> {
    const abs = resolve(path, this.#cwd)
    return this.#files.has(abs) || this.#dirExists(abs)
  }

  async isFile(path: string): Promise<boolean> {
    const abs = resolve(path, this.#cwd)
    return this.#files.has(abs)
  }

  async isDir(path: string): Promise<boolean> {
    const abs = resolve(path, this.#cwd)
    return this.#dirExists(abs)
  }

  async stat(path: string): Promise<FileMetadata> {
    const abs = resolve(path, this.#cwd)
    if (this.#files.has(abs)) {
      const meta = this.#fileMeta.get(abs) as FileMeta
      return {
        size: (this.#files.get(abs) as Uint8Array).byteLength,
        createdAt: meta.createdAt,
        modifiedAt: meta.modifiedAt,
        isDir: false,
      }
    }
    if (this.#dirExists(abs)) {
      const meta = this.#dirMeta.get(abs) ?? syntheticDirMeta()
      return {
        size: 0,
        createdAt: meta.createdAt,
        modifiedAt: meta.modifiedAt,
        isDir: true,
      }
    }
    throw new Error(`stat: no such file or directory: ${path}`)
  }

  // ---------- writes ----------

  async write(path: string, content: Uint8Array, mode: 'w' | 'a' = 'w'): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (this.#dirExists(abs) && !this.#files.has(abs)) {
      throw new Error(`write: is a directory: ${path}`)
    }
    const parent = dirname(abs)
    if (!this.#dirExists(parent)) {
      throw new Error(`write: parent directory does not exist: ${parent}`)
    }

    let next: Uint8Array
    if (mode === 'a' && this.#files.has(abs)) {
      const existing = this.#files.get(abs) as Uint8Array
      next = new Uint8Array(existing.length + content.length)
      next.set(existing)
      next.set(content, existing.length)
    } else {
      next = new Uint8Array(content)
    }
    this.#files.set(abs, next)

    const now = new Date().toISOString()
    const existingMeta = this.#fileMeta.get(abs)
    this.#fileMeta.set(abs, {
      createdAt: existingMeta?.createdAt ?? now,
      modifiedAt: now,
    })
  }

  async mkdir(path: string, opts: { parents?: boolean; existOk?: boolean } = {}): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (this.#files.has(abs)) {
      throw new Error(`mkdir: file exists at path: ${path}`)
    }
    if (this.#dirExists(abs)) {
      if (opts.existOk) return
      throw new Error(`mkdir: directory exists: ${path}`)
    }
    if (opts.parents) {
      // Create all missing intermediate dirs.
      const segments = abs.split('/').filter((s) => s !== '')
      let prefix = ''
      for (const seg of segments) {
        prefix = `${prefix}/${seg}`
        if (!this.#dirExists(prefix)) this.#addDir(prefix)
      }
    } else {
      const parent = dirname(abs)
      if (!this.#dirExists(parent)) {
        throw new Error(`mkdir: parent directory does not exist: ${parent}`)
      }
      this.#addDir(abs)
    }
  }

  async remove(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (!this.#files.has(abs)) {
      if (this.#dirExists(abs)) throw new Error(`remove: is a directory: ${path}`)
      throw new Error(`remove: no such file: ${path}`)
    }
    this.#files.delete(abs)
    this.#fileMeta.delete(abs)
  }

  async rmdir(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (abs === '/') throw new Error('rmdir: cannot remove root')
    if (this.#files.has(abs)) {
      throw new Error(`rmdir: not a directory: ${path}`)
    }
    if (!this.#dirExists(abs)) {
      throw new Error(`rmdir: no such directory: ${path}`)
    }
    if (this.#dirHasChildren(abs)) {
      throw new Error(`rmdir: directory not empty: ${path}`)
    }
    this.#explicitDirs.delete(abs)
    this.#dirMeta.delete(abs)
  }

  async rename(src: string, dst: string): Promise<void> {
    const absSrc = resolve(src, this.#cwd)
    const absDst = resolve(dst, this.#cwd)
    if (absSrc === absDst) return

    if (this.#files.has(absSrc)) {
      const dstParent = dirname(absDst)
      if (!this.#dirExists(dstParent)) {
        throw new Error(`rename: parent directory does not exist: ${dstParent}`)
      }
      const value = this.#files.get(absSrc) as Uint8Array
      const meta = this.#fileMeta.get(absSrc) as FileMeta
      this.#files.delete(absSrc)
      this.#fileMeta.delete(absSrc)
      this.#files.set(absDst, value)
      this.#fileMeta.set(absDst, meta)
      return
    }

    if (this.#dirExists(absSrc)) {
      const srcPrefix = `${absSrc}/`
      // Move every file whose key starts with srcPrefix.
      const moves: Array<[string, string]> = []
      for (const k of this.#files.keys()) {
        if (k.startsWith(srcPrefix)) moves.push([k, `${absDst}/${k.slice(srcPrefix.length)}`])
      }
      for (const [from, to] of moves) {
        const value = this.#files.get(from) as Uint8Array
        const meta = this.#fileMeta.get(from) as FileMeta
        this.#files.delete(from)
        this.#fileMeta.delete(from)
        this.#files.set(to, value)
        this.#fileMeta.set(to, meta)
      }
      // Move explicit dir entries the same way (including the source itself).
      const dirMoves: Array<[string, string]> = []
      for (const d of this.#explicitDirs) {
        if (d === absSrc) dirMoves.push([d, absDst])
        else if (d.startsWith(srcPrefix))
          dirMoves.push([d, `${absDst}/${d.slice(srcPrefix.length)}`])
      }
      for (const [from, to] of dirMoves) {
        const meta = this.#dirMeta.get(from)
        this.#explicitDirs.delete(from)
        this.#dirMeta.delete(from)
        this.#explicitDirs.add(to)
        if (meta !== undefined) this.#dirMeta.set(to, meta)
      }
      return
    }

    throw new Error(`rename: no such file or directory: ${src}`)
  }

  // ---------- iteration ----------

  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    const abs = resolve(path, this.#cwd)
    if (!this.#dirExists(abs)) {
      throw new Error(`list: no such directory: ${path}`)
    }
    const prefix = abs === '/' ? '/' : `${abs}/`
    const direct = new Set<string>()
    const all = new Set<string>()

    for (const k of this.#files.keys()) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      if (opts.recursive) {
        all.add(rest)
      } else {
        const slash = rest.indexOf('/')
        direct.add(slash === -1 ? rest : rest.slice(0, slash))
      }
    }
    for (const d of this.#explicitDirs) {
      if (d === abs) continue
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (opts.recursive) {
        all.add(rest)
      } else {
        const slash = rest.indexOf('/')
        direct.add(slash === -1 ? rest : rest.slice(0, slash))
      }
    }

    const out = opts.recursive ? [...all] : [...direct]
    return out.sort()
  }

  async listDetailed(path = '.', opts: { recursive?: boolean } = {}): Promise<FileInfo[]> {
    const names = await this.list(path, opts)
    const abs = resolve(path, this.#cwd)
    const out: FileInfo[] = []
    for (const name of names) {
      const childAbs = joinPath(abs, name)
      const isDir = this.#dirExists(childAbs) && !this.#files.has(childAbs)
      if (isDir) {
        const meta = this.#dirMeta.get(childAbs) ?? syntheticDirMeta()
        out.push({
          name: basename(name),
          path: name,
          size: 0,
          createdAt: meta.createdAt,
          modifiedAt: meta.modifiedAt,
          isDir: true,
        })
      } else {
        const value = this.#files.get(childAbs)
        const meta = this.#fileMeta.get(childAbs)
        if (value === undefined || meta === undefined) continue // pruned mid-iteration
        out.push({
          name: basename(name),
          path: name,
          size: value.byteLength,
          createdAt: meta.createdAt,
          modifiedAt: meta.modifiedAt,
          isDir: false,
        })
      }
    }
    return out
  }

  // ---------- internal helpers ----------

  #dirExists(abs: string): boolean {
    if (this.#explicitDirs.has(abs)) return true
    if (abs === '/') return true
    const prefix = `${abs}/`
    for (const k of this.#files.keys()) if (k.startsWith(prefix)) return true
    for (const d of this.#explicitDirs) if (d.startsWith(prefix)) return true
    return false
  }

  #dirHasChildren(abs: string): boolean {
    const prefix = abs === '/' ? '/' : `${abs}/`
    for (const k of this.#files.keys()) if (k.startsWith(prefix)) return true
    for (const d of this.#explicitDirs) {
      if (d !== abs && d.startsWith(prefix)) return true
    }
    return false
  }

  #addDir(abs: string): void {
    this.#explicitDirs.add(abs)
    const now = new Date().toISOString()
    this.#dirMeta.set(abs, { createdAt: now, modifiedAt: now })
  }
}

function syntheticDirMeta(): FileMeta {
  const epoch = new Date(0).toISOString()
  return { createdAt: epoch, modifiedAt: epoch }
}
