/**
 * Files in memory: a `Directory` for Node, for tests, and for anything
 * without OPFS.
 */

import type { Directory, SyncFile } from './files'

/** A directory's files by name, as bytes. */
export type DirectoryImage = ReadonlyMap<string, Uint8Array>

/** Growable bytes: the contents of one in-memory file. */
class Bytes {
  data: Uint8Array
  size: number

  constructor(initial: Uint8Array = new Uint8Array(0)) {
    this.data = initial.slice()
    this.size = initial.byteLength
  }

  read(into: Uint8Array, at: number): number {
    const n = Math.max(0, Math.min(into.byteLength, this.size - at))
    if (n > 0) into.set(this.data.subarray(at, at + n))
    return n
  }

  write(from: Uint8Array, at: number): void {
    // Bytes between the old end and `at` read as zeros: `resize`
    // clears whatever a truncate left past the end.
    this.resize(Math.max(this.size, at))
    this.reserve(at + from.byteLength)
    this.data.set(from, at)
    this.size = Math.max(this.size, at + from.byteLength)
  }

  resize(size: number): void {
    this.reserve(size)
    if (size > this.size) this.data.fill(0, this.size, size)
    this.size = size
  }

  snapshot(): Uint8Array {
    return this.data.slice(0, this.size)
  }

  private reserve(size: number): void {
    if (size <= this.data.byteLength) return
    const grown = new Uint8Array(Math.max(size, this.data.byteLength * 2, 4096))
    grown.set(this.data.subarray(0, this.size))
    this.data = grown
  }
}

/**
 * An in-memory `SyncFile`. Standalone (`new MemoryFile()`) it is a
 * scratch file; a `MemoryDirectory` hands out ones over its files.
 */
export class MemoryFile implements SyncFile {
  private closed = false

  constructor(
    private readonly bytes: Bytes = new Bytes(),
    private readonly onClose: () => void = () => {},
  ) {}

  read(into: Uint8Array, at: number): number {
    this.check()
    return this.bytes.read(into, at)
  }

  write(from: Uint8Array, at: number): void {
    this.check()
    this.bytes.write(from, at)
  }

  truncate(size: number): void {
    this.check()
    this.bytes.resize(size)
  }

  sync(): void {
    this.check()
  }

  size(): number {
    this.check()
    return this.bytes.size
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }

  private check(): void {
    if (this.closed) throw new Error('file is closed')
  }
}

/**
 * A `Directory` in memory. Files keep their bytes across close and
 * reopen; `image()` copies them out and `new MemoryDirectory(image)`
 * starts a directory from a copy, which is how a test "restarts the
 * process" on the files a crash left.
 */
export class MemoryDirectory implements Directory {
  private readonly files = new Map<string, Bytes>()
  private readonly opened = new Set<string>()

  constructor(image?: DirectoryImage) {
    if (image) for (const [name, data] of image) this.files.set(name, new Bytes(data))
  }

  async open(name: string): Promise<SyncFile> {
    checkName(name)
    if (this.opened.has(name)) throw new Error(`file is already open: ${name}`)
    let bytes = this.files.get(name)
    if (!bytes) {
      bytes = new Bytes()
      this.files.set(name, bytes)
    }
    this.opened.add(name)
    return new MemoryFile(bytes, () => this.opened.delete(name))
  }

  async delete(name: string): Promise<void> {
    if (this.opened.has(name)) throw new Error(`file is open: ${name}`)
    this.files.delete(name)
  }

  async exists(name: string): Promise<boolean> {
    return this.files.has(name)
  }

  /** The names of the files, sorted. */
  names(): string[] {
    return [...this.files.keys()].sort()
  }

  /** A copy of every file's bytes. */
  image(): DirectoryImage {
    const out = new Map<string, Uint8Array>()
    for (const [name, bytes] of this.files) out.set(name, bytes.snapshot())
    return out
  }
}

function checkName(name: string): void {
  if (name === '' || name.includes('/')) throw new Error(`bad file name: ${JSON.stringify(name)}`)
}
