/**
 * `MountFS` — composes a writable backing `FileSystem` with one or
 * more read-only overlays mounted at fixed path prefixes.
 *
 * Routing rules:
 *   - Reads under a mount prefix go to the overlay.
 *   - Reads outside any mount go to the backing FS.
 *   - All writes go to the backing FS — overlay writes throw a
 *     `TypeError` clearly attributing the rejection to the mount.
 *   - `cwd` and `chdir` are tracked on the backing FS only; mount
 *     paths are absolute and don't participate in cwd resolution.
 *   - `list()` of a directory that *contains* a mount point includes
 *     the mount-point name as a virtual subdirectory.
 *
 * Designed for the agent's per-session VFS — the backing FS is a
 * `MemoryFS` (or future `KvgitFS`) and the overlays are the
 * `ChaptersOverlay` (this PR), eventually `/skills/`, `/outputs/`,
 * etc. Each overlay is a full `FileSystem` implementation; MountFS
 * doesn't care what's underneath.
 */

import type { FileInfo, FileMetadata, FileSystem } from '@agex-ts/termish'

export interface Mount {
  /** Path prefix the overlay handles. Must start with `/` and not
   *  end with `/` (e.g. `/chapters`). The MountFS routes any path
   *  equal to or under this prefix to the overlay. */
  readonly prefix: string
  readonly fs: FileSystem
}

export class MountFS implements FileSystem {
  readonly #backing: FileSystem
  readonly #mounts: Mount[]

  constructor(backing: FileSystem, mounts: ReadonlyArray<Mount> = []) {
    this.#backing = backing
    this.#mounts = []
    for (const m of mounts) this.mount(m.prefix, m.fs)
  }

  /** Add or replace a mount at `prefix`. Throws if the prefix is
   *  invalid; replaces silently if a mount at the same prefix exists.
   *
   *  Mounts are kept sorted by descending prefix length so the most
   *  specific match wins during routing — e.g. given mounts at `/a`
   *  and `/a/b`, a read at `/a/b/file.txt` correctly routes to `/a/b`. */
  mount(prefix: string, fs: FileSystem): void {
    this.#validatePrefix(prefix)
    const idx = this.#mounts.findIndex((m) => m.prefix === prefix)
    if (idx >= 0) this.#mounts[idx] = { prefix, fs }
    else this.#mounts.push({ prefix, fs })
    this.#mounts.sort((a, b) => b.prefix.length - a.prefix.length)
  }

  /** Remove a mount. Returns true if one was removed. */
  unmount(prefix: string): boolean {
    const idx = this.#mounts.findIndex((m) => m.prefix === prefix)
    if (idx < 0) return false
    this.#mounts.splice(idx, 1)
    return true
  }

  /** Currently active mounts in declaration order. */
  get mounts(): ReadonlyArray<Mount> {
    return this.#mounts
  }

  // ---------- cwd ----------

  getcwd(): string {
    return this.#backing.getcwd()
  }

  async chdir(path: string): Promise<void> {
    return this.#backing.chdir(path)
  }

  // ---------- reads ----------

  async read(path: string): Promise<Uint8Array> {
    const route = this.#route(path)
    return route.fs.read(route.path)
  }

  async exists(path: string): Promise<boolean> {
    const route = this.#route(path)
    return route.fs.exists(route.path)
  }

  async isFile(path: string): Promise<boolean> {
    const route = this.#route(path)
    return route.fs.isFile(route.path)
  }

  async isDir(path: string): Promise<boolean> {
    const route = this.#route(path)
    if (route.fs === this.#backing) {
      // The mount POINTS themselves are virtual dirs that don't exist
      // in the backing FS. Recognize them here.
      const abs = this.#abs(path)
      for (const m of this.#mounts) {
        if (abs === m.prefix) return true
      }
    }
    return route.fs.isDir(route.path)
  }

  async stat(path: string): Promise<FileMetadata> {
    const route = this.#route(path)
    if (route.fs === this.#backing) {
      const abs = this.#abs(path)
      for (const m of this.#mounts) {
        if (abs === m.prefix) {
          // Mount point itself — synthesize a directory stat.
          return {
            size: 0,
            createdAt: EPOCH_ISO,
            modifiedAt: EPOCH_ISO,
            isDir: true,
          }
        }
      }
    }
    return route.fs.stat(route.path)
  }

  // ---------- writes (always go to the backing FS) ----------

  async write(path: string, content: Uint8Array, mode?: 'w' | 'a'): Promise<void> {
    const route = this.#route(path)
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot write under read-only mount ${route.mountPrefix}`)
    }
    return this.#backing.write(path, content, mode)
  }

  async mkdir(path: string, opts?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const route = this.#route(path)
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot mkdir under read-only mount ${route.mountPrefix}`)
    }
    return this.#backing.mkdir(path, opts)
  }

  async remove(path: string): Promise<void> {
    const route = this.#route(path)
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot remove under read-only mount ${route.mountPrefix}`)
    }
    return this.#backing.remove(path)
  }

  async rmdir(path: string): Promise<void> {
    const route = this.#route(path)
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot rmdir under read-only mount ${route.mountPrefix}`)
    }
    return this.#backing.rmdir(path)
  }

  async rename(src: string, dst: string): Promise<void> {
    const srcRoute = this.#route(src)
    const dstRoute = this.#route(dst)
    if (srcRoute.fs !== this.#backing || dstRoute.fs !== this.#backing) {
      throw new TypeError('MountFS: cannot rename across or under read-only mounts')
    }
    return this.#backing.rename(src, dst)
  }

  // ---------- iteration ----------

  async list(path?: string, opts?: { recursive?: boolean }): Promise<string[]> {
    const route = this.#route(path ?? '.')
    const base = await route.fs.list(route.path, opts)
    if (route.fs !== this.#backing) return base.sort()

    // Backing-FS listing — splice in any mount points whose parent
    // matches the queried directory so the agent sees them as
    // subdirectories.
    const abs = this.#abs(path ?? '.')
    const extras = new Set<string>()
    const prefix = abs === '/' ? '/' : `${abs}/`
    for (const m of this.#mounts) {
      if (!m.prefix.startsWith(prefix)) continue
      const rest = m.prefix.slice(prefix.length)
      if (rest.length === 0) continue
      if (opts?.recursive) {
        // Add the mount's recursive contents under the rest prefix
        extras.add(rest)
        const inner = await m.fs.list('/', { recursive: true })
        for (const k of inner) extras.add(`${rest}/${k}`)
      } else {
        // Only add the immediate-child mount-point name
        const slash = rest.indexOf('/')
        extras.add(slash === -1 ? rest : rest.slice(0, slash))
      }
    }
    const out = new Set<string>(base)
    for (const x of extras) out.add(x)
    return [...out].sort()
  }

  async listDetailed(path?: string, opts?: { recursive?: boolean }): Promise<FileInfo[]> {
    const route = this.#route(path ?? '.')
    const base = await route.fs.listDetailed(route.path, opts)
    if (route.fs !== this.#backing) return base

    // Same splice logic as list(); synthesize FileInfo entries for
    // visible mount points.
    const abs = this.#abs(path ?? '.')
    const extras: FileInfo[] = []
    const prefix = abs === '/' ? '/' : `${abs}/`
    const userPrefix = path === '/' || path === undefined || path === '.' ? (path ?? '.') : path
    for (const m of this.#mounts) {
      if (!m.prefix.startsWith(prefix)) continue
      const rest = m.prefix.slice(prefix.length)
      if (rest.length === 0) continue
      const slash = rest.indexOf('/')
      const head = slash === -1 ? rest : rest.slice(0, slash)
      const headPath = userPrefix === '/' ? `/${head}` : `${userPrefix}/${head}`
      extras.push({
        name: head,
        path: headPath,
        size: 0,
        createdAt: EPOCH_ISO,
        modifiedAt: EPOCH_ISO,
        isDir: true,
      })
      if (opts?.recursive) {
        const inner = await m.fs.listDetailed('/', { recursive: true })
        for (const fi of inner) {
          extras.push({
            ...fi,
            path: `${m.prefix}${fi.path === '/' ? '' : fi.path}`,
          })
        }
      }
    }
    const all = [...base, ...extras]
    // Dedupe by path (mount-point head name might also exist in
    // backing FS as a file; mount wins).
    const byPath = new Map<string, FileInfo>()
    for (const fi of all) byPath.set(fi.path, fi)
    return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  // ---------- internal ----------

  #abs(path: string): string {
    if (path === '.') return this.#backing.getcwd()
    if (path.startsWith('/')) return normalizeAbs(path)
    return normalizeAbs(`${this.#backing.getcwd()}/${path}`)
  }

  /** Pick the FS that owns `path` and return the path translated
   *  into that FS's namespace. Mount paths route to the overlay
   *  with the mount prefix stripped; everything else routes to the
   *  backing FS unchanged. */
  #route(path: string): { fs: FileSystem; path: string; mountPrefix: string | null } {
    const abs = this.#abs(path)
    for (const m of this.#mounts) {
      if (abs === m.prefix) {
        return { fs: m.fs, path: '/', mountPrefix: m.prefix }
      }
      if (abs.startsWith(`${m.prefix}/`)) {
        return { fs: m.fs, path: abs.slice(m.prefix.length), mountPrefix: m.prefix }
      }
    }
    return { fs: this.#backing, path, mountPrefix: null }
  }

  #validatePrefix(prefix: string): void {
    if (!prefix.startsWith('/')) {
      throw new Error(`MountFS: mount prefix must start with '/': ${prefix}`)
    }
    if (prefix === '/') {
      throw new Error('MountFS: cannot mount at root /')
    }
    if (prefix.endsWith('/')) {
      throw new Error(`MountFS: mount prefix must not end with '/': ${prefix}`)
    }
  }
}

const EPOCH_ISO = new Date(0).toISOString()

function normalizeAbs(path: string): string {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (out.length > 0) out.pop()
    } else out.push(seg)
  }
  return `/${out.join('/')}`
}
