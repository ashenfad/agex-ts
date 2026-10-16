/**
 * Files in the origin-private file system (OPFS), through synchronous
 * access handles. Those exist only in dedicated workers, so this
 * directory works only there.
 */

import type { Directory, SyncFile } from './files'

/**
 * The part of `FileSystemSyncAccessHandle` used here. TypeScript
 * declares the handle only in its web-worker library, which this
 * package doesn't build against.
 */
interface SyncAccessHandle {
  read(buffer: Uint8Array, options: { at: number }): number
  write(buffer: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  flush(): void
  getSize(): number
  close(): void
}

interface SyncAccessFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>
}

/** One OPFS file behind its synchronous access handle. */
export class OpfsFile implements SyncFile {
  constructor(private readonly handle: SyncAccessHandle) {}

  read(into: Uint8Array, at: number): number {
    return this.handle.read(into, { at })
  }

  write(from: Uint8Array, at: number): void {
    const n = this.handle.write(from, { at })
    if (n !== from.byteLength) throw new Error(`short write: ${n} of ${from.byteLength} bytes`)
  }

  truncate(size: number): void {
    this.handle.truncate(size)
  }

  sync(): void {
    this.handle.flush()
  }

  size(): number {
    return this.handle.getSize()
  }

  close(): void {
    this.handle.close()
  }
}

/**
 * A directory in OPFS. Each open file holds an exclusive synchronous
 * access handle, so while one is open no other worker or tab can open
 * it.
 *
 * Deleting an open file is refused by Chromium and Firefox, but WebKit
 * deletes it: the open handle goes on reading and writing, and the
 * file is gone when it closes. So whatever keeps a second connection
 * away from a database must keep deletes away from it too.
 */
export class OpfsDirectory implements Directory {
  constructor(readonly handle: FileSystemDirectoryHandle) {}

  /**
   * The directory at `path` (names from the OPFS root), created if
   * missing. With no names, the OPFS root itself.
   */
  static async at(...path: string[]): Promise<OpfsDirectory> {
    let dir = await navigator.storage.getDirectory()
    for (const name of path) dir = await dir.getDirectoryHandle(name, { create: true })
    return new OpfsDirectory(dir)
  }

  async open(name: string): Promise<SyncFile> {
    const file = await this.handle.getFileHandle(name, { create: true })
    const handle = await (file as unknown as SyncAccessFileHandle).createSyncAccessHandle()
    return new OpfsFile(handle)
  }

  async delete(name: string): Promise<void> {
    try {
      await this.handle.removeEntry(name)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.handle.getFileHandle(name)
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError'
}
