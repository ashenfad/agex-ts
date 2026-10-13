/**
 * Attachments: another session's tree, frozen at a commit, mounted
 * read-only inside this one (`ws.files.attach`). For reading someone
 * else's work in place (a delegate's branch, before deciding whether to
 * merge it) without copying it in. Not versioned, not carried by a
 * fork, gone when the session closes.
 *
 * {@link AttachFS} is always the filesystem the agent and the host see,
 * transparent while nothing is attached, so an attachment made later
 * reaches the shell and the kernel through the object they already
 * hold. It keeps the working directory: standing inside an attachment
 * doesn't move the session's own (stored) one.
 */

import { type FileInfo, type FileMetadata, type FileSystem, FsError } from '@agex-ts/termish'
import { readManyOf } from './fs'
import { basename, normalize, resolve } from './path'

const EPOCH = new Date(0).toISOString()

/**
 * One directory of a filesystem shown as the root: what an attachment
 * mounts, the source's workspace root, so a file it calls `auth.py`
 * reads as `<at>/auth.py`. Reads only.
 */
export class SubtreeFS implements FileSystem {
  readonly #fs: FileSystem
  readonly #prefix: string

  constructor(fs: FileSystem, prefix: string) {
    this.#fs = fs
    this.#prefix = normalize(prefix)
  }

  #under(path: string): string {
    const rel = normalize(resolve(path, '/')).replace(/^\/+/, '')
    return rel === '' ? this.#prefix : normalize(`${this.#prefix}/${rel}`)
  }

  #out(path: string): string {
    if (path === this.#prefix) return '/'
    return path.startsWith(`${this.#prefix}/`) ? path.slice(this.#prefix.length) : path
  }

  getcwd(): string {
    return '/'
  }
  async chdir(path: string): Promise<void> {
    if (!(await this.isDir(path))) throw new FsError('ENOENT', path)
  }
  read(path: string): Promise<Uint8Array> {
    return this.#fs.read(this.#under(path))
  }
  async readMany(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    const under = paths.map((p) => this.#under(p))
    const found = await readManyOf(this.#fs, under)
    const out = new Map<string, Uint8Array>()
    paths.forEach((path, i) => {
      const bytes = found.get(under[i] as string)
      if (bytes !== undefined) out.set(path, bytes)
    })
    return out
  }
  exists(path: string): Promise<boolean> {
    return this.#fs.exists(this.#under(path))
  }
  isFile(path: string): Promise<boolean> {
    return this.#fs.isFile(this.#under(path))
  }
  isDir(path: string): Promise<boolean> {
    return this.#fs.isDir(this.#under(path))
  }
  stat(path: string): Promise<FileMetadata> {
    return this.#fs.stat(this.#under(path))
  }
  list(path = '/', opts?: { recursive?: boolean }): Promise<string[]> {
    return this.#fs.list(this.#under(path), opts)
  }
  async listDetailed(path = '/', opts?: { recursive?: boolean }): Promise<FileInfo[]> {
    const infos = await this.#fs.listDetailed(this.#under(path), opts)
    return infos.map((info) => ({ ...info, path: this.#out(info.path) }))
  }
  async write(path: string): Promise<void> {
    throw new FsError('EROFS', path)
  }
  async mkdir(path: string): Promise<void> {
    throw new FsError('EROFS', path)
  }
  async remove(path: string): Promise<void> {
    throw new FsError('EROFS', path)
  }
  async rmdir(path: string): Promise<void> {
    throw new FsError('EROFS', path)
  }
  async rename(src: string): Promise<void> {
    throw new FsError('EROFS', src)
  }
}

/** The session's filesystem, with whatever is attached mounted in it. */
export class AttachFS implements FileSystem {
  readonly #base: FileSystem
  readonly #home: string
  /** Mount point → its filesystem, longest first. */
  #mounts: [string, FileSystem][] = []
  /** The working directory while it is inside an attachment. */
  #cwd: string | null = null

  /** `home` is where the cwd lands when the attachment it was in goes. */
  constructor(base: FileSystem, home: string) {
    this.#base = base
    this.#home = home
  }

  /** The mount points. */
  get points(): string[] {
    return this.#mounts.map(([at]) => at)
  }

  attach(at: string, fs: FileSystem): void {
    this.#mounts = [...this.#mounts, [at, fs] as [string, FileSystem]].sort(
      (a, b) => b[0].length - a[0].length,
    )
  }

  /** Drop every mount, moving nothing: for a session that is closing. */
  clear(): void {
    this.#mounts = []
    this.#cwd = null
  }

  async detach(at: string): Promise<void> {
    this.#mounts = this.#mounts.filter(([p]) => p !== at)
    // Standing inside it, there's nowhere to go back to: home.
    if (this.#cwd !== null && this.#route(this.#cwd).at === null && !this.#holds(this.#cwd)) {
      this.#cwd = null
      await this.#base.chdir(this.#home)
    }
  }

  #abs(path: string): string {
    return normalize(resolve(path, this.getcwd()))
  }

  /** Where an absolute path goes: a mount and the path inside it, or the
   *  session's own filesystem. */
  #route(abs: string): { at: string | null; fs: FileSystem; path: string } {
    for (const [at, fs] of this.#mounts) {
      if (abs === at) return { at, fs, path: '/' }
      if (abs.startsWith(`${at}/`)) return { at, fs, path: abs.slice(at.length) }
    }
    return { at: null, fs: this.#base, path: abs }
  }

  /** Where `path` goes. To the session's own filesystem it goes as the
   *  caller spelled it while the cwd is the session's, so errors name
   *  it the same way. */
  #to(path: string) {
    const r = this.#route(this.#abs(path))
    return r.at === null && this.#cwd === null ? { ...r, path } : r
  }

  /** The names directly inside directory `abs` that lead to a mount
   *  point: the point itself, or a directory it is under. */
  #pointsIn(abs: string): string[] {
    const prefix = abs === '/' ? '/' : `${abs}/`
    const names = this.#mounts
      .map(([at]) => at)
      .filter((at) => at.startsWith(prefix))
      .map((at) => at.slice(prefix.length).split('/')[0] as string)
    return [...new Set(names)]
  }

  /** Whether `abs` is a directory only because a mount point is under
   *  it: `/workspace/skills` when a skill is mounted at
   *  `/workspace/skills/<name>`. It reads as an empty directory holding
   *  the way to its mounts. */
  #holds(abs: string): boolean {
    if (this.#route(abs).at !== null) return false
    const prefix = abs === '/' ? '/' : `${abs}/`
    return this.#mounts.some(([at]) => at.startsWith(prefix))
  }

  #readOnly(path: string, at: string): FsError {
    return new FsError('EROFS', path, `'${path}' is in a read-only attachment (${at})`)
  }

  getcwd(): string {
    return this.#cwd ?? this.#base.getcwd()
  }

  async chdir(path: string): Promise<void> {
    const abs = this.#abs(path)
    const r = this.#route(abs)
    if (r.at === null) {
      if (this.#holds(abs) && !(await this.#base.isDir(abs))) {
        // only a way to its mounts: the cwd is kept here, as inside one
        this.#cwd = abs
        return
      }
      await this.#base.chdir(this.#cwd === null ? path : abs)
      this.#cwd = null
      return
    }
    if (!(await r.fs.isDir(r.path))) throw new FsError('ENOENT', path)
    this.#cwd = abs
  }

  async read(path: string): Promise<Uint8Array> {
    const r = this.#to(path)
    return r.fs.read(r.path)
  }

  /** Each path from the filesystem it routes to: one batch per mount. */
  async readMany(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    const groups = new Map<FileSystem, { given: string[]; routed: string[] }>()
    for (const path of paths) {
      const r = this.#to(path)
      const group = groups.get(r.fs) ?? { given: [], routed: [] }
      groups.set(r.fs, group)
      group.given.push(path)
      group.routed.push(r.path)
    }
    const out = new Map<string, Uint8Array>()
    for (const [fs, { given, routed }] of groups) {
      const found = await readManyOf(fs, routed)
      given.forEach((path, i) => {
        const bytes = found.get(routed[i] as string)
        if (bytes !== undefined) out.set(path, bytes)
      })
    }
    return out
  }

  async exists(path: string): Promise<boolean> {
    const r = this.#to(path)
    return (await r.fs.exists(r.path)) || this.#holds(this.#abs(path))
  }

  async isFile(path: string): Promise<boolean> {
    const r = this.#to(path)
    return r.fs.isFile(r.path)
  }

  async isDir(path: string): Promise<boolean> {
    const r = this.#to(path)
    return (await r.fs.isDir(r.path)) || this.#holds(this.#abs(path))
  }

  async stat(path: string): Promise<FileMetadata> {
    const r = this.#to(path)
    try {
      return await r.fs.stat(r.path)
    } catch (e) {
      if (!this.#holds(this.#abs(path))) throw e
      return { size: 0, createdAt: EPOCH, modifiedAt: EPOCH, isDir: true }
    }
  }

  /** What the session's own filesystem lists at `abs`: nothing, for a
   *  directory that only leads to mounts. */
  async #own<T>(abs: string, list: () => Promise<T[]>): Promise<T[]> {
    try {
      return await list()
    } catch (e) {
      if (this.#holds(abs) && !(await this.#base.exists(abs))) return []
      throw e
    }
  }

  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    const abs = this.#abs(path)
    const r = this.#route(abs)
    if (r.at !== null) return r.fs.list(r.path, opts)
    const own = await this.#own(abs, () => r.fs.list(r.path, opts))
    const points = this.#pointsIn(abs)
    if (points.length === 0) return own
    const extra = new Set(own)
    for (const name of points) extra.add(name)
    if (opts.recursive === true) {
      for (const name of points) {
        const below = abs === '/' ? `/${name}` : `${abs}/${name}`
        for (const e of await this.list(below, opts)) extra.add(`${name}/${e}`)
      }
    }
    return [...extra].sort()
  }

  async listDetailed(path = '.', opts: { recursive?: boolean } = {}): Promise<FileInfo[]> {
    const abs = this.#abs(path)
    const r = this.#route(abs)
    const prefix = path === '/' ? '' : path.replace(/\/$/, '')
    if (r.at !== null) return this.#mounted(prefix, r.fs, r.path, opts)
    const infos = await this.#own(abs, () => r.fs.listDetailed(path, opts))
    const seen = new Set(infos.map((i) => i.path))
    for (const name of this.#pointsIn(abs)) {
      if (!infos.some((i) => i.name === name && i.path === `${prefix}/${name}`)) {
        infos.push({
          name,
          path: `${prefix}/${name}`,
          size: 0,
          createdAt: EPOCH,
          modifiedAt: EPOCH,
          isDir: true,
        })
        seen.add(`${prefix}/${name}`)
      }
      if (opts.recursive === true) {
        for (const info of await this.listDetailed(`${prefix}/${name}`, opts)) {
          if (!seen.has(info.path)) {
            seen.add(info.path)
            infos.push(info)
          }
        }
      }
    }
    return infos.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** A mount's entries under `inside` (a path in the mount), named from
   *  `spelled`, the caller's spelling of that directory. */
  async #mounted(
    spelled: string,
    fs: FileSystem,
    inside: string,
    opts: { recursive?: boolean },
  ): Promise<FileInfo[]> {
    const cut = inside === '/' ? 0 : inside.length
    const infos = await fs.listDetailed(inside, opts)
    return infos.map((info) => ({ ...info, path: `${spelled}${info.path.slice(cut)}` }))
  }

  async write(path: string, content: Uint8Array, mode?: 'w' | 'a'): Promise<void> {
    const r = this.#to(path)
    if (r.at !== null) throw this.#readOnly(path, r.at)
    return this.#base.write(r.path, content, mode)
  }

  async mkdir(path: string, opts?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const r = this.#to(path)
    if (r.at !== null) throw this.#readOnly(path, r.at)
    return this.#base.mkdir(r.path, opts)
  }

  async remove(path: string): Promise<void> {
    const r = this.#to(path)
    if (r.at !== null) throw this.#readOnly(path, r.at)
    return this.#base.remove(r.path)
  }

  async rmdir(path: string): Promise<void> {
    const r = this.#to(path)
    if (r.at !== null) throw this.#readOnly(path, r.at)
    return this.#base.rmdir(r.path)
  }

  async rename(src: string, dst: string): Promise<void> {
    const a = this.#to(src)
    const b = this.#to(dst)
    if (a.at !== null) throw this.#readOnly(src, a.at)
    if (b.at !== null) throw this.#readOnly(dst, b.at)
    return this.#base.rename(a.path, b.path)
  }
}
