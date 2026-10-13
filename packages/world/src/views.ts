/**
 * Sparse views: what a narrowed fork sees.
 *
 * A fork can be given some paths (`ws.fork(name, {paths})`). Its branch
 * still holds everything its parent had; only what it lists and reads
 * is narrowed. That makes "push this content to the delegate" cost no
 * prune commit, and the merge back stays an ordinary three-way.
 *
 * **The write rule.** A narrowed session may *create* a path anywhere
 * (notes and scratch are ordinary work, and a new path merges as an
 * addition), and what it creates joins its view, so it can read back
 * what it made. Changing or removing a path that exists outside the
 * view is refused (`EACCES`): you can't overwrite what you can't see.
 *
 * **The record**, at {@link VIEW_KEY}, holds two lists: the **view**,
 * what the session sees now (what the write rule checks), and the
 * **seed**, what it was given, which never grows. A diff groups by the
 * seed: a note the delegate wrote is in its view because it made it,
 * and it's exactly the change a caller mustn't miss. A session that
 * sees the whole tree records nothing; the record merges as ours, so
 * merging a narrowed delegate never narrows the caller.
 */

import { type FileInfo, type FileMetadata, type FileSystem, FsError } from '@agex-ts/termish'
import { InvalidNameError } from './errors'
import { VIEW_KEY } from './layout'
import { normalize, resolve } from './path'

export { VIEW_KEY }

const VIEW_VERSION = 1

/** A view record: what the session sees, and what it was given. */
export interface ViewRecord {
  readonly paths: readonly string[]
  readonly seed: readonly string[]
}

const absolutes = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((p): p is string => typeof p === 'string' && p.startsWith('/')))].sort()
    : []

/** A stored view, or null for the whole tree (absent, or a layout this
 *  doesn't know: the answer that can't hide a file from its owner). */
export function parseView(raw: unknown): ViewRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  if (v.version !== VIEW_VERSION || !Array.isArray(v.paths)) return null
  return {
    paths: absolutes(v.paths),
    seed: Array.isArray(v.seed) ? absolutes(v.seed) : absolutes(v.paths),
  }
}

export function encodeView(
  paths: readonly string[],
  seed: readonly string[] = paths,
): Record<string, unknown> {
  return {
    version: VIEW_VERSION,
    paths: [...new Set(paths)].sort(),
    seed: [...new Set(seed)].sort(),
  }
}

/**
 * Seed paths as the caller spelled them (absolute, or relative to the
 * root; a directory or a file) as absolute paths. Empty is an empty
 * view: a session given no files, which sees what it makes. `/` is
 * refused: a view of everything isn't a view, and the whole tree is
 * `paths` left out.
 */
export function normalizeView(paths: readonly string[] | string, root: string): string[] {
  const out = new Set<string>()
  for (const entry of typeof paths === 'string' ? [paths] : paths) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new InvalidNameError(`view paths are non-empty strings: ${JSON.stringify(entry)}`)
    }
    const abs = normalize(resolve(entry.trim(), root))
    if (abs === '/') {
      throw new InvalidNameError(
        `'${entry}' names the whole filesystem, which is not a view — leave paths out for the whole tree, or name the workspace root ('${root}') to see all of it as a seed`,
      )
    }
    out.add(abs)
  }
  return [...out].sort()
}

/**
 * A filesystem narrowed to some paths of the one beneath it. Outside
 * the view reads as absent; the root, and the way down to each view
 * entry, stay visible as directories. Writes follow the rule above.
 * With no view (null) it is the filesystem beneath, unchanged.
 */
export class ViewFS implements FileSystem {
  readonly #fs: FileSystem
  readonly #root: string
  #view: string[] | null = null
  #seed: string[] = []
  readonly #extend: (record: ViewRecord) => void

  constructor(fs: FileSystem, root: string, extend: (record: ViewRecord) => void = () => {}) {
    this.#fs = fs
    this.#root = normalize(root)
    this.#extend = extend
  }

  /** What the session sees now; null for the whole tree. */
  get view(): readonly string[] | null {
    return this.#view
  }

  /** What it was given; empty for the whole tree. */
  get seed(): readonly string[] {
    return this.#seed
  }

  /** Narrow to `record`, or show the whole tree (null). */
  setView(record: ViewRecord | null): void {
    this.#view = record === null ? null : [...record.paths]
    this.#seed = record === null ? [] : [...record.seed]
  }

  /** Whether the view shows `path` (absolute, or from the cwd). */
  sees(path: string): boolean {
    return this.#visible(this.#abs(path))
  }

  #abs(path: string): string {
    return normalize(resolve(path, this.#fs.getcwd()))
  }

  #visible(abs: string): boolean {
    const view = this.#view
    if (view === null || abs === '/') return true
    if (abs === this.#root || this.#root.startsWith(`${abs}/`)) return true
    for (const entry of view) {
      if (abs === entry || abs.startsWith(`${entry}/`)) return true
      if (entry.startsWith(`${abs}/`)) return true
    }
    return false
  }

  #hidden(path: string): FsError {
    return new FsError(
      'EACCES',
      path,
      `'${path}' is outside this session's view (${(this.#view ?? []).join(', ') || 'nothing'}): it holds a file this session was not given, and a path it cannot see is one it may not change. Write somewhere new instead.`,
    )
  }

  /** A new path anywhere (which joins the view); never a change to one
   *  the view hides. */
  async #guardWrite(path: string): Promise<void> {
    const abs = this.#abs(path)
    if (this.#visible(abs)) return
    if (await this.#fs.exists(abs)) throw this.#hidden(path)
    this.#widen(abs)
  }

  /** Changing or dropping an existing path: only inside the view. */
  async #guardChange(path: string): Promise<void> {
    const abs = this.#abs(path)
    if (this.#visible(abs)) return
    if (await this.#fs.exists(abs)) throw this.#hidden(path)
    throw new FsError('ENOENT', path)
  }

  /** @internal Whether a write to `path` would be refused, asked before
   *  a call that must do all of its writes or none. */
  async refused(path: string, change: 'write' | 'remove'): Promise<FsError | null> {
    const abs = this.#abs(path)
    if (this.#visible(abs)) return null
    if (await this.#fs.exists(abs)) return this.#hidden(path)
    return change === 'remove' ? new FsError('ENOENT', path) : null
  }

  #widen(abs: string): void {
    if (this.#view === null) return
    this.#view = [...new Set([...this.#view, abs])].sort()
    this.#extend({ paths: this.#view, seed: this.#seed })
  }

  /** @internal A path made by the session's own verbs joins the view. */
  include(path: string): void {
    const abs = this.#abs(path)
    if (!this.#visible(abs)) this.#widen(abs)
  }

  // ---------- position ----------

  getcwd(): string {
    return this.#fs.getcwd()
  }

  async chdir(path: string): Promise<void> {
    if (!this.sees(path)) throw new FsError('ENOENT', path)
    return this.#fs.chdir(path)
  }

  // ---------- reads ----------

  async read(path: string): Promise<Uint8Array> {
    if (!this.sees(path)) throw new FsError('ENOENT', path)
    return this.#fs.read(path)
  }

  async exists(path: string): Promise<boolean> {
    return this.sees(path) && this.#fs.exists(path)
  }

  async isFile(path: string): Promise<boolean> {
    return this.sees(path) && this.#fs.isFile(path)
  }

  async isDir(path: string): Promise<boolean> {
    return this.sees(path) && this.#fs.isDir(path)
  }

  async stat(path: string): Promise<FileMetadata> {
    if (!this.sees(path)) throw new FsError('ENOENT', path)
    return this.#fs.stat(path)
  }

  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    if (!this.sees(path)) throw new FsError('ENOENT', path)
    const base = this.#abs(path)
    const entries = await this.#fs.list(path, opts)
    return entries.filter((e) => this.#visible(normalize(resolve(e, base))))
  }

  async listDetailed(path = '.', opts: { recursive?: boolean } = {}): Promise<FileInfo[]> {
    if (!this.sees(path)) throw new FsError('ENOENT', path)
    const infos = await this.#fs.listDetailed(path, opts)
    return infos.filter((info) => this.sees(info.path))
  }

  // ---------- writes ----------

  async write(path: string, content: Uint8Array, mode?: 'w' | 'a'): Promise<void> {
    await this.#guardWrite(path)
    return this.#fs.write(path, content, mode)
  }

  async mkdir(path: string, opts?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    // A directory is a container, never content: making one changes no
    // file the view hides, and a new file under an unseen directory
    // needs it.
    return this.#fs.mkdir(path, opts)
  }

  async remove(path: string): Promise<void> {
    await this.#guardChange(path)
    return this.#fs.remove(path)
  }

  async rmdir(path: string): Promise<void> {
    await this.#guardChange(path)
    return this.#fs.rmdir(path)
  }

  async rename(src: string, dst: string): Promise<void> {
    await this.#guardChange(src)
    await this.#guardWrite(dst)
    return this.#fs.rename(src, dst)
  }
}
