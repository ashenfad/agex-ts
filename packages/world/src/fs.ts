/**
 * `WorldFS`: termish's `FileSystem` over a session's keys.
 *
 * Writes go into the worktree as pending changes; nothing here commits.
 * The workspace's own calls commit them (`ws.files.write`, a tool call),
 * or `ws.commit()` does. Over a snapshot it is read-only: every write
 * throws `EROFS`.
 *
 * Directories are explicit: `mkdir` writes a record, and a write needs
 * its parent to exist, as on a disk. A file whose parent lost its
 * record (one writer removed an empty directory while another wrote
 * into it, and the two merged) still lists under the grandparent, and
 * `mkdir -p` gives the directory back its record.
 */

import { type FileInfo, type FileMetadata, type FileSystem, FsError } from '@agex-ts/termish'
import { CWD_KEY, type FileRecord, META_PREFIX, fileKey, isFileRecord, metaKey } from './layout'
import { basename, dirname, joinPath, resolve, within } from './path'

/** The reads the filesystem needs: a worktree's or a snapshot's. */
export interface KeyReader {
  get(key: string): Promise<unknown>
  getMany(keys: Iterable<string>): Promise<Map<string, unknown>>
  keys(): Promise<string[]>
}

/** A reader that also takes pending writes: a worktree. */
export interface KeyWriter extends KeyReader {
  set(key: string, value: unknown): void
  delete(key: string): Promise<boolean>
}

export interface WorldFSOptions {
  /** The initial working directory. Default `/`. */
  readonly cwd?: string
  /** Write each `chdir` to the session, so it commits and reopens with
   *  the files. Default false. */
  readonly persistCwd?: boolean
}

const EPOCH = new Date(0).toISOString()
const ROOT: FileRecord = { size: 0, createdAt: EPOCH, modifiedAt: EPOCH, isDir: true }

function isWriter(view: KeyReader): view is KeyWriter {
  return typeof (view as Partial<KeyWriter>).set === 'function'
}

/** The keys under directory `abs`'s metadata, children and deeper. */
const metaPrefixUnder = (abs: string): string =>
  abs === '/' ? `${META_PREFIX}/` : `${metaKey(abs)}/`

export class WorldFS implements FileSystem {
  readonly #view: KeyReader
  readonly #persistCwd: boolean
  #cwd: string

  constructor(view: KeyReader, opts: WorldFSOptions = {}) {
    this.#view = view
    this.#cwd = opts.cwd ?? '/'
    this.#persistCwd = opts.persistCwd ?? false
  }

  /** Whether writes throw `EROFS`. */
  get readOnly(): boolean {
    return !isWriter(this.#view)
  }

  // ---------- cwd ----------

  getcwd(): string {
    return this.#cwd
  }

  async chdir(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (!(await this.#isDir(abs))) {
      throw new FsError((await this.exists(path)) ? 'ENOTDIR' : 'ENOENT', path)
    }
    this.#cwd = abs
    if (this.#persistCwd && isWriter(this.#view)) this.#view.set(CWD_KEY, abs)
  }

  /** Move the in-memory working directory without checking or storing
   *  it: for the workspace, after a checkout put a different one in the
   *  session. */
  resetCwd(abs: string): void {
    this.#cwd = abs
  }

  // ---------- reads ----------

  async read(path: string): Promise<Uint8Array> {
    const abs = resolve(path, this.#cwd)
    const rec = await this.#record(abs)
    if (rec === undefined) throw new FsError('ENOENT', path)
    if (rec.isDir) throw new FsError('EISDIR', path)
    return this.#content(abs)
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#record(resolve(path, this.#cwd))) !== undefined
  }

  async isFile(path: string): Promise<boolean> {
    return (await this.#record(resolve(path, this.#cwd)))?.isDir === false
  }

  async isDir(path: string): Promise<boolean> {
    return this.#isDir(resolve(path, this.#cwd))
  }

  async stat(path: string): Promise<FileMetadata> {
    const rec = await this.#record(resolve(path, this.#cwd))
    if (rec === undefined) throw new FsError('ENOENT', path)
    return {
      size: rec.size,
      createdAt: rec.createdAt,
      modifiedAt: rec.modifiedAt,
      isDir: rec.isDir,
    }
  }

  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    const abs = resolve(path, this.#cwd)
    if (!(await this.#isDir(abs))) {
      throw new FsError((await this.exists(path)) ? 'ENOTDIR' : 'ENOENT', path)
    }
    return [...(await this.#entriesUnder(abs, opts.recursive ?? false)).keys()].sort()
  }

  async listDetailed(path = '.', opts: { recursive?: boolean } = {}): Promise<FileInfo[]> {
    const abs = resolve(path, this.#cwd)
    if (!(await this.#isDir(abs))) {
      throw new FsError((await this.exists(path)) ? 'ENOTDIR' : 'ENOENT', path)
    }
    const entries = await this.#entriesUnder(abs, opts.recursive ?? false)
    const names = [...entries.keys()].sort()
    const records = await this.#view.getMany(names.map((n) => metaKey(joinPath(abs, n))))
    const userPrefix = path === '/' ? '/' : path.replace(/\/$/, '')
    return names.map((name) => {
      const found = records.get(metaKey(joinPath(abs, name)))
      // A directory known only from the paths under it has no record.
      const rec = isFileRecord(found) ? found : { ...ROOT }
      return {
        name: basename(name),
        path: joinPath(userPrefix, name),
        size: rec.size,
        createdAt: rec.createdAt,
        modifiedAt: rec.modifiedAt,
        isDir: rec.isDir,
      }
    })
  }

  // ---------- writes ----------

  async write(path: string, content: Uint8Array, mode: 'w' | 'a' = 'w'): Promise<void> {
    const view = this.#writer(path)
    const abs = resolve(path, this.#cwd)
    const rec = await this.#record(abs)
    if (rec?.isDir === true) throw new FsError('EISDIR', path)
    await this.#requireParent(abs)

    let next: Uint8Array
    if (mode === 'a' && rec !== undefined) {
      const existing = await this.#content(abs)
      next = new Uint8Array(existing.byteLength + content.byteLength)
      next.set(existing)
      next.set(content, existing.byteLength)
    } else {
      next = new Uint8Array(content)
    }
    const now = new Date().toISOString()
    view.set(fileKey(abs), next)
    view.set(metaKey(abs), {
      size: next.byteLength,
      createdAt: rec?.createdAt ?? now,
      modifiedAt: now,
      isDir: false,
    } satisfies FileRecord)
  }

  async mkdir(path: string, opts: { parents?: boolean; existOk?: boolean } = {}): Promise<void> {
    const view = this.#writer(path)
    const abs = resolve(path, this.#cwd)
    const rec = await this.#record(abs)
    if (rec !== undefined) {
      if (rec.isDir && opts.existOk === true) return
      throw new FsError('EEXIST', path)
    }
    if (opts.parents === true) {
      const segments = abs.split('/').filter((s) => s !== '')
      let prefix = ''
      for (const seg of segments) {
        prefix = `${prefix}/${seg}`
        const at = await this.#view.get(metaKey(prefix))
        if (isFileRecord(at)) {
          if (!at.isDir) throw new FsError('ENOTDIR', path)
          continue
        }
        this.#addDir(view, prefix)
      }
      return
    }
    await this.#requireParent(abs)
    this.#addDir(view, abs)
  }

  async remove(path: string): Promise<void> {
    const view = this.#writer(path)
    const abs = resolve(path, this.#cwd)
    const rec = await this.#record(abs)
    if (rec === undefined) throw new FsError('ENOENT', path)
    if (rec.isDir) throw new FsError('EISDIR', path)
    await view.delete(fileKey(abs))
    await view.delete(metaKey(abs))
  }

  async rmdir(path: string): Promise<void> {
    const view = this.#writer(path)
    const abs = resolve(path, this.#cwd)
    if (abs === '/') throw new FsError('EINVAL', path, 'Cannot remove the root')
    const rec = await this.#record(abs)
    if (rec === undefined) throw new FsError('ENOENT', path)
    if (!rec.isDir) throw new FsError('ENOTDIR', path)
    if ((await this.#entriesUnder(abs, false)).size > 0) throw new FsError('ENOTEMPTY', path)
    await view.delete(metaKey(abs))
  }

  async rename(src: string, dst: string): Promise<void> {
    const view = this.#writer(src)
    const absSrc = resolve(src, this.#cwd)
    const absDst = resolve(dst, this.#cwd)
    const rec = await this.#record(absSrc)
    if (rec === undefined) throw new FsError('ENOENT', src)
    if (absSrc === absDst) return
    if (absSrc === '/') throw new FsError('EINVAL', src, 'Cannot move the root')
    await this.#requireParent(absDst)
    const target = await this.#record(absDst)

    if (!rec.isDir) {
      if (target?.isDir === true) throw new FsError('EISDIR', dst)
      const content = await this.#content(absSrc)
      await view.delete(fileKey(absSrc))
      await view.delete(metaKey(absSrc))
      view.set(fileKey(absDst), content)
      view.set(metaKey(absDst), rec)
      return
    }

    if (within(absDst, absSrc)) {
      throw new FsError('EINVAL', dst, 'Cannot move a directory into itself')
    }
    if (target !== undefined) {
      if (!target.isDir) throw new FsError('ENOTDIR', dst)
      if ((await this.#entriesUnder(absDst, false)).size > 0) throw new FsError('ENOTEMPTY', dst)
    }
    const moving = (await this.#view.keys()).filter(
      (k) =>
        k === metaKey(absSrc) ||
        k.startsWith(`${metaKey(absSrc)}/`) ||
        k.startsWith(`${fileKey(absSrc)}/`),
    )
    const values = await this.#view.getMany(moving)
    for (const key of moving) {
      const value = values.get(key)
      await view.delete(key)
      if (value === undefined) continue
      const isMeta = key.startsWith(META_PREFIX)
      const prefix = isMeta ? metaKey(absSrc) : fileKey(absSrc)
      const moved = absDst + key.slice(prefix.length)
      view.set(isMeta ? metaKey(moved) : fileKey(moved), value)
    }
    if (within(this.#cwd, absSrc)) this.resetCwd(absDst + this.#cwd.slice(absSrc.length))
  }

  // ---------- internals ----------

  #writer(path: string): KeyWriter {
    if (!isWriter(this.#view)) throw new FsError('EROFS', path)
    return this.#view
  }

  async #record(abs: string): Promise<FileRecord | undefined> {
    if (abs === '/') return ROOT
    const found = await this.#view.get(metaKey(abs))
    return isFileRecord(found) ? found : undefined
  }

  async #isDir(abs: string): Promise<boolean> {
    return (await this.#record(abs))?.isDir === true
  }

  async #content(abs: string): Promise<Uint8Array> {
    const found = await this.#view.get(fileKey(abs))
    return found instanceof Uint8Array ? new Uint8Array(found) : new Uint8Array(0)
  }

  async #requireParent(abs: string): Promise<void> {
    const parent = dirname(abs)
    if (await this.#isDir(parent)) return
    // The nearest existing ancestor decides: a file there makes the
    // path ENOTDIR, a directory makes it a missing parent.
    let at = parent
    for (;;) {
      const rec = await this.#record(at)
      if (rec !== undefined) throw new FsError(rec.isDir ? 'ENOENT' : 'ENOTDIR', parent)
      at = dirname(at)
    }
  }

  #addDir(view: KeyWriter, abs: string): void {
    const now = new Date().toISOString()
    view.set(metaKey(abs), { size: 0, createdAt: now, modifiedAt: now, isDir: true })
  }

  /** The entries under directory `abs`, as paths relative to it:
   *  children only, or everything below with `recursive`. Directories
   *  known only from paths under them count. */
  async #entriesUnder(abs: string, recursive: boolean): Promise<Set<string>> {
    const prefix = metaPrefixUnder(abs)
    const out = new Set<string>()
    for (const key of await this.#view.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest === '') continue
      const parts = rest.split('/')
      if (recursive) {
        for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'))
      } else {
        out.add(parts[0] as string)
      }
    }
    return out
  }
}
