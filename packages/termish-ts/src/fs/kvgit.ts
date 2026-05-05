/**
 * `KvgitFS` — `FileSystem` backed by a kvgit-ts `Staged`.
 *
 * Every path becomes a key in the staging buffer. Writes accumulate
 * locally; the user calls `commit()` to flush them as a single
 * versioned commit (with three-way merge if HEAD has moved).
 *
 * Storage layout:
 * - File at `/path/to/file` → key `f:/path/to/file`
 * - Explicit empty dir `/path` → key `d:/path`
 * - A dir is implicit if any `f:` or `d:` key has prefix `<path>/`
 *
 * Per-record byte format:
 * - Byte 0: type tag — 0x46 (`F`, file) or 0x44 (`D`, dir)
 * - Bytes 1–24: ISO 8601 createdAt (always 24 chars: `YYYY-MM-DDTHH:mm:ss.sssZ`)
 * - Bytes 25–48: ISO 8601 modifiedAt (same format)
 * - Bytes 49…: file content (empty for dirs)
 *
 * This keeps content bytes contiguous in the record (no base64), avoids
 * any JSON parsing in the hot path, and lets `read()` slice straight
 * into a Uint8Array.
 *
 * Peer-dep on kvgit-ts. Import only via `termish-ts/fs/kvgit`; importing
 * the main entry never pulls kvgit in.
 */

import type { Staged } from 'kvgit-ts'
import type { Decoder, Encoder } from 'kvgit-ts'
import { basename, dirname, joinPath, resolve } from './path'
import type { FileInfo, FileMetadata, FileSystem } from './protocol'

const TYPE_FILE = 0x46
const TYPE_DIR = 0x44
const ISO_LEN = 24
const HEADER_LEN = 1 + ISO_LEN * 2

interface FileRecord {
  readonly isDir: boolean
  readonly createdAt: string
  readonly modifiedAt: string
  readonly content: Uint8Array
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Typed as `Encoder` (value: unknown) so it plugs into `Staged`'s
 *  constructor without a generic-variance cast at call sites. */
export const fileRecordEncoder: Encoder = (value) => {
  const rec = value as FileRecord
  const out = new Uint8Array(HEADER_LEN + rec.content.byteLength)
  out[0] = rec.isDir ? TYPE_DIR : TYPE_FILE
  const c = enc.encode(rec.createdAt.padEnd(ISO_LEN, ' ').slice(0, ISO_LEN))
  const m = enc.encode(rec.modifiedAt.padEnd(ISO_LEN, ' ').slice(0, ISO_LEN))
  out.set(c, 1)
  out.set(m, 1 + ISO_LEN)
  if (rec.content.byteLength > 0) out.set(rec.content, HEADER_LEN)
  return out
}

export const fileRecordDecoder: Decoder = (bytes) => {
  if (bytes.byteLength < HEADER_LEN) {
    throw new Error('KvgitFS: record too short')
  }
  const isDir = bytes[0] === TYPE_DIR
  const createdAt = dec.decode(bytes.subarray(1, 1 + ISO_LEN)).trim()
  const modifiedAt = dec.decode(bytes.subarray(1 + ISO_LEN, HEADER_LEN)).trim()
  const content = bytes.byteLength > HEADER_LEN ? bytes.subarray(HEADER_LEN) : new Uint8Array(0)
  return { isDir, createdAt, modifiedAt, content }
}

export interface KvgitFSOptions {
  /** Initial virtual cwd. Defaults to `/`. */
  readonly cwd?: string
}

const ROOT_KEY = 'd:/'

export class KvgitFS implements FileSystem {
  readonly #staged: Staged
  #cwd: string

  constructor(staged: Staged, opts: KvgitFSOptions = {}) {
    this.#staged = staged
    this.#cwd = opts.cwd ?? '/'
  }

  /** Expose the underlying `Staged` so callers can `commit()`,
   *  switch branches, etc. */
  get staged(): Staged {
    return this.#staged
  }

  // ---------- cwd ----------

  getcwd(): string {
    return this.#cwd
  }

  async chdir(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (!(await this.#dirExists(abs))) {
      throw new Error(`chdir: not a directory: ${path}`)
    }
    this.#cwd = abs
  }

  // ---------- reads ----------

  async read(path: string): Promise<Uint8Array> {
    const abs = resolve(path, this.#cwd)
    const rec = await this.#getFile(abs)
    if (rec === undefined) {
      if (await this.#dirExists(abs)) throw new Error(`read: is a directory: ${path}`)
      throw new Error(`read: no such file: ${path}`)
    }
    return new Uint8Array(rec.content)
  }

  async exists(path: string): Promise<boolean> {
    const abs = resolve(path, this.#cwd)
    if ((await this.#getFile(abs)) !== undefined) return true
    return this.#dirExists(abs)
  }

  async isFile(path: string): Promise<boolean> {
    const abs = resolve(path, this.#cwd)
    return (await this.#getFile(abs)) !== undefined
  }

  async isDir(path: string): Promise<boolean> {
    const abs = resolve(path, this.#cwd)
    return this.#dirExists(abs)
  }

  async stat(path: string): Promise<FileMetadata> {
    const abs = resolve(path, this.#cwd)
    const file = await this.#getFile(abs)
    if (file !== undefined) {
      return {
        size: file.content.byteLength,
        createdAt: file.createdAt,
        modifiedAt: file.modifiedAt,
        isDir: false,
      }
    }
    if (await this.#dirExists(abs)) {
      const dirRec = await this.#getDir(abs)
      const meta = dirRec ?? syntheticMeta()
      return { size: 0, createdAt: meta.createdAt, modifiedAt: meta.modifiedAt, isDir: true }
    }
    throw new Error(`stat: no such file or directory: ${path}`)
  }

  // ---------- writes ----------

  async write(path: string, content: Uint8Array, mode: 'w' | 'a' = 'w'): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if ((await this.#dirExists(abs)) && (await this.#getFile(abs)) === undefined) {
      throw new Error(`write: is a directory: ${path}`)
    }
    if (!(await this.#dirExists(dirname(abs)))) {
      throw new Error(`write: parent directory does not exist: ${dirname(abs)}`)
    }
    const now = new Date().toISOString()
    const existing = await this.#getFile(abs)
    let next: Uint8Array
    if (mode === 'a' && existing !== undefined) {
      next = new Uint8Array(existing.content.byteLength + content.byteLength)
      next.set(existing.content)
      next.set(content, existing.content.byteLength)
    } else {
      next = new Uint8Array(content)
    }
    const rec: FileRecord = {
      isDir: false,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      content: next,
    }
    this.#staged.set(`f:${abs}`, rec)
  }

  async mkdir(path: string, opts: { parents?: boolean; existOk?: boolean } = {}): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if ((await this.#getFile(abs)) !== undefined) {
      throw new Error(`mkdir: file exists at path: ${path}`)
    }
    if (await this.#dirExists(abs)) {
      if (opts.existOk) return
      throw new Error(`mkdir: directory exists: ${path}`)
    }
    if (opts.parents) {
      const segments = abs.split('/').filter((s) => s !== '')
      let prefix = ''
      for (const seg of segments) {
        prefix = `${prefix}/${seg}`
        if (!(await this.#dirExists(prefix))) this.#addDir(prefix)
      }
    } else {
      if (!(await this.#dirExists(dirname(abs)))) {
        throw new Error(`mkdir: parent directory does not exist: ${dirname(abs)}`)
      }
      this.#addDir(abs)
    }
  }

  async remove(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if ((await this.#getFile(abs)) === undefined) {
      if (await this.#dirExists(abs)) throw new Error(`remove: is a directory: ${path}`)
      throw new Error(`remove: no such file: ${path}`)
    }
    this.#staged.delete(`f:${abs}`)
  }

  async rmdir(path: string): Promise<void> {
    const abs = resolve(path, this.#cwd)
    if (abs === '/') throw new Error('rmdir: cannot remove root')
    if ((await this.#getFile(abs)) !== undefined) {
      throw new Error(`rmdir: not a directory: ${path}`)
    }
    if (!(await this.#dirExists(abs))) {
      throw new Error(`rmdir: no such directory: ${path}`)
    }
    if (await this.#dirHasChildren(abs)) {
      throw new Error(`rmdir: directory not empty: ${path}`)
    }
    this.#staged.delete(`d:${abs}`)
  }

  async rename(src: string, dst: string): Promise<void> {
    const absSrc = resolve(src, this.#cwd)
    const absDst = resolve(dst, this.#cwd)
    if (absSrc === absDst) return

    const srcFile = await this.#getFile(absSrc)
    if (srcFile !== undefined) {
      if (!(await this.#dirExists(dirname(absDst)))) {
        throw new Error(`rename: parent directory does not exist: ${dirname(absDst)}`)
      }
      this.#staged.delete(`f:${absSrc}`)
      this.#staged.set(`f:${absDst}`, srcFile)
      return
    }

    if (await this.#dirExists(absSrc)) {
      const srcPrefix = `${absSrc}/`
      // Materialize the matching keys up front. Awaiting `staged.get()`
      // mid-iteration over `staged.keys()` can let an IndexedDB-backed
      // store auto-commit its read cursor between awaits — pulling the
      // candidates into an array first keeps the cursor walk tight and
      // confines the per-key loads to a separate phase.
      const fileKeys: string[] = []
      const dirKeys: string[] = []
      for await (const k of this.#staged.keys()) {
        if (k.startsWith('f:')) {
          if (k.slice(2).startsWith(srcPrefix)) fileKeys.push(k)
        } else if (k.startsWith('d:')) {
          const path = k.slice(2)
          if (path === absSrc || path.startsWith(srcPrefix)) dirKeys.push(k)
        }
      }

      const fileMoves: Array<[string, FileRecord]> = []
      const dirMoves: Array<[string, FileRecord | null]> = []
      for (const k of fileKeys) {
        const path = k.slice(2)
        const rec = await this.#staged.get<FileRecord>(k)
        if (rec !== undefined) {
          fileMoves.push([`${absDst}/${path.slice(srcPrefix.length)}`, rec])
          this.#staged.delete(k)
        }
      }
      for (const k of dirKeys) {
        const path = k.slice(2)
        const rec = await this.#staged.get<FileRecord>(k)
        const dst = path === absSrc ? absDst : `${absDst}/${path.slice(srcPrefix.length)}`
        dirMoves.push([dst, rec ?? null])
        this.#staged.delete(k)
      }
      for (const [dstPath, rec] of fileMoves) this.#staged.set(`f:${dstPath}`, rec)
      for (const [dstPath, rec] of dirMoves) {
        if (rec !== null) this.#staged.set(`d:${dstPath}`, rec)
      }
      return
    }

    throw new Error(`rename: no such file or directory: ${src}`)
  }

  // ---------- iteration ----------

  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    const abs = resolve(path, this.#cwd)
    if (!(await this.#dirExists(abs))) {
      throw new Error(`list: no such directory: ${path}`)
    }
    const prefix = abs === '/' ? '/' : `${abs}/`
    const direct = new Set<string>()
    const all = new Set<string>()
    for await (const k of this.#staged.keys()) {
      let path2: string
      if (k.startsWith('f:')) path2 = k.slice(2)
      else if (k.startsWith('d:')) path2 = k.slice(2)
      else continue
      if (path2 === abs) continue
      if (!path2.startsWith(prefix)) continue
      const rest = path2.slice(prefix.length)
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
    const userPrefix = path === '/' ? '/' : path.replace(/\/$/, '')
    const out: FileInfo[] = []
    for (const name of names) {
      const childAbs = joinPath(abs, name)
      const userPath = joinPath(userPrefix, name)
      const file = await this.#getFile(childAbs)
      if (file !== undefined) {
        out.push({
          name: basename(name),
          path: userPath,
          size: file.content.byteLength,
          createdAt: file.createdAt,
          modifiedAt: file.modifiedAt,
          isDir: false,
        })
      } else if (await this.#dirExists(childAbs)) {
        const dirRec = (await this.#getDir(childAbs)) ?? syntheticMeta()
        out.push({
          name: basename(name),
          path: userPath,
          size: 0,
          createdAt: dirRec.createdAt,
          modifiedAt: dirRec.modifiedAt,
          isDir: true,
        })
      }
    }
    return out
  }

  // ---------- internal ----------

  async #getFile(abs: string): Promise<FileRecord | undefined> {
    const rec = await this.#staged.get<FileRecord>(`f:${abs}`)
    return rec
  }

  async #getDir(abs: string): Promise<FileRecord | undefined> {
    if (abs === '/') return undefined
    return this.#staged.get<FileRecord>(`d:${abs}`)
  }

  async #dirExists(abs: string): Promise<boolean> {
    if (abs === '/') return true
    if ((await this.#getDir(abs)) !== undefined) return true
    const prefix = `${abs}/`
    for await (const k of this.#staged.keys()) {
      if (k.startsWith('f:') || k.startsWith('d:')) {
        if (k.slice(2).startsWith(prefix)) return true
      }
    }
    return false
  }

  async #dirHasChildren(abs: string): Promise<boolean> {
    const prefix = abs === '/' ? '/' : `${abs}/`
    for await (const k of this.#staged.keys()) {
      if (k.startsWith('f:') || k.startsWith('d:')) {
        const path = k.slice(2)
        if (path !== abs && path.startsWith(prefix)) return true
      }
    }
    return false
  }

  #addDir(abs: string): void {
    if (abs === '/') return
    const now = new Date().toISOString()
    const rec: FileRecord = {
      isDir: true,
      createdAt: now,
      modifiedAt: now,
      content: new Uint8Array(0),
    }
    this.#staged.set(`d:${abs}`, rec)
  }
}

function syntheticMeta(): { createdAt: string; modifiedAt: string } {
  const epoch = new Date(0).toISOString()
  return { createdAt: epoch, modifiedAt: epoch }
}

// Touch ROOT_KEY so a future implementation that wants to root-mark
// stays compatible without reformatting.
void ROOT_KEY
