/**
 * The SQLite VFS over `SyncFile`s.
 *
 * SQLite reaches files through a VFS, whose calls are synchronous. This
 * one serves two kinds of file:
 *
 * - **Registered files**, the database and its rollback journal, which
 *   the opener registers by path before SQLite asks for them (opening a
 *   `SyncFile` may be asynchronous; `xOpen` can't wait). A database
 *   file, journal, super-journal or WAL path nobody registered fails to
 *   open, so nothing meant to persist ever lands in memory by mistake.
 * - **Scratch files**, everything SQLite opens for itself (temp
 *   databases, statement journals, sorter spills), which live in memory
 *   and vanish on close.
 *
 * Deleting a registered file truncates it to zero bytes, and a
 * zero-byte registered file reports as absent. The file stays open: its
 * handle belongs to the opener, and removing an OPFS file is
 * asynchronous. SQLite treats an empty journal the same as a missing
 * one, so a "deleted" journal is never mistaken for a hot one.
 */

import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import type { SyncFile } from './files'
import { MemoryFile } from './memory'

/** The name the VFS registers under by default. */
export const VFS_NAME = 'kvsql'

/**
 * The sector size reported to SQLite: the unit a write may tear in, so
 * the smallest unit SQLite journals. 4096 is the block size of the file
 * systems OPFS sits on, so no write is assumed to be finer-grained than
 * the disk underneath. It costs nothing at this build's default page
 * size (8192), or any page size from 4096 up: SQLite journals whole
 * pages anyway. Smaller pages would be journalled four or eight to a
 * sector.
 */
export const SECTOR_SIZE = 4096

const PERSISTENT_KINDS = ['MAIN_DB', 'MAIN_JOURNAL', 'SUPER_JOURNAL', 'WAL'] as const

/** One file SQLite has open, by its `sqlite3_file*`. */
interface OpenFile {
  path: string
  file: SyncFile
  flags: number
  /** Opened without a name: a scratch file SQLite can't reopen, dropped on close. */
  unnamed: boolean
  /** SQLite's current lock level on the file (`SQLITE_LOCK_*`). */
  lock: number
}

type Method = (...args: never[]) => number | undefined
type Methods = Record<string, Method>

/** The struct members set here that the build's typings leave out or misname. */
interface IoMethodsStruct {
  pointer: number
  $iVersion: number
}
interface VfsStruct {
  pointer: number
  $xRandomness: number
  $xSleep: number
  dispose(): void
}

const installed = new WeakMap<Sqlite3Static, KvsqlVfs>()

/**
 * The VFS on this SQLite build, installed on first use. One per build:
 * every database the build opens through it shares its registry.
 */
export function kvsqlVfs(sqlite3: Sqlite3Static): KvsqlVfs {
  let vfs = installed.get(sqlite3)
  if (!vfs) {
    vfs = new KvsqlVfs(sqlite3, VFS_NAME)
    installed.set(sqlite3, vfs)
  }
  return vfs
}

/**
 * A registry of files by path, installed as a SQLite VFS.
 *
 * **Locking** is bookkeeping only. The design is one connection per
 * database file: the opener refuses a second connection to a path in
 * the same realm, and in a browser the file's exclusive access handle
 * keeps other workers and tabs out. So no lock can conflict; each file
 * records the level SQLite asked for, and `xCheckReservedLock` reports
 * a reserved lock only when this connection holds one. That keeps
 * SQLite's hot-journal check right: a journal left by a crash, with no
 * writer holding a reserved lock, is hot and gets rolled back.
 *
 * **Device characteristics:** `SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN`
 * only. Deleting a registered file empties it in place rather than
 * removing it, so to SQLite an open file is undeletable, and with the
 * flag SQLite keeps the journal open between transactions in TRUNCATE
 * or PERSIST mode instead of closing and reopening it. Nothing stronger
 * is claimed: OPFS promises no atomic or ordered writes, so SQLite
 * journals and syncs as for an ordinary disk.
 */
export class KvsqlVfs {
  readonly name: string
  private readonly registered = new Map<string, SyncFile>()
  private readonly scratch = new Map<string, MemoryFile>()
  private readonly open = new Map<number, OpenFile>()
  private nextScratch = 0
  private persistentFlags = 0
  private error: unknown = null

  constructor(
    private readonly sqlite3: Sqlite3Static,
    name: string,
  ) {
    if (sqlite3.capi.sqlite3_vfs_find(name)) throw new Error(`a VFS named ${name} already exists`)
    this.name = name
    for (const kind of PERSISTENT_KINDS) this.persistentFlags |= sqlite3.capi[`SQLITE_OPEN_${kind}`]
    this.install()
  }

  /**
   * Makes `file` the file SQLite gets when it opens `path`. The caller
   * keeps ownership: unregistering doesn't close it.
   */
  register(path: string, file: SyncFile): void {
    if (this.registered.has(path)) throw new Error(`already registered: ${path}`)
    this.registered.set(path, file)
  }

  /** Forgets `path`. SQLite must have closed it. */
  unregister(path: string): void {
    if (this.isOpen(path)) throw new Error(`SQLite still has ${path} open`)
    this.registered.delete(path)
  }

  /** Whether a file is registered at `path`. */
  has(path: string): boolean {
    return this.registered.has(path)
  }

  /** Whether SQLite has `path` open. */
  isOpen(path: string): boolean {
    for (const f of this.open.values()) if (f.path === path) return true
    return false
  }

  /**
   * The last error a file operation threw, cleared when read. SQLite
   * reports only an error code (`SQLITE_IOERR_WRITE`, say); this is
   * the exception behind it.
   */
  takeError(): unknown {
    const err = this.error
    this.error = null
    return err
  }

  private install(): void {
    const { capi, wasm } = this.sqlite3
    const C = capi
    const fail = (err: unknown, rc: number): number => {
      this.error = err
      return rc
    }
    const entry = (pFile: number): OpenFile => {
      const f = this.open.get(pFile)
      if (!f) throw new Error(`no open file at ${pFile}`)
      return f
    }
    const bytes = (p: number, n: number): Uint8Array => wasm.heap8u().subarray(p, p + n)
    // The build's typings name this `ptrSizeof`; at runtime it is `ptr.size`.
    const ptrSize = (wasm as unknown as { ptr: { size: number } }).ptr.size

    const io: Methods = {
      xClose: (pFile: number) => {
        const f = this.open.get(pFile)
        this.open.delete(pFile)
        try {
          if (f && (f.unnamed || f.flags & C.SQLITE_OPEN_DELETEONCLOSE)) this.remove(f.path, false)
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_CLOSE)
        }
      },
      xRead: (pFile: number, pDest: number, n: number, offset: bigint | number) => {
        try {
          const into = bytes(pDest, n)
          const got = entry(pFile).file.read(into, Number(offset))
          if (got >= n) return 0
          into.fill(0, got)
          return C.SQLITE_IOERR_SHORT_READ
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_READ)
        }
      },
      xWrite: (pFile: number, pSrc: number, n: number, offset: bigint | number) => {
        try {
          entry(pFile).file.write(bytes(pSrc, n), Number(offset))
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_WRITE)
        }
      },
      xTruncate: (pFile: number, size: bigint | number) => {
        try {
          entry(pFile).file.truncate(Number(size))
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_TRUNCATE)
        }
      },
      xSync: (pFile: number, _flags: number) => {
        try {
          entry(pFile).file.sync()
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_FSYNC)
        }
      },
      xFileSize: (pFile: number, pSize: number) => {
        try {
          wasm.poke64(pSize, BigInt(entry(pFile).file.size()))
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_FSTAT)
        }
      },
      xLock: (pFile: number, level: number) => {
        try {
          entry(pFile).lock = level
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_LOCK)
        }
      },
      xUnlock: (pFile: number, level: number) => {
        try {
          entry(pFile).lock = level
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_UNLOCK)
        }
      },
      xCheckReservedLock: (pFile: number, pOut: number) => {
        try {
          wasm.poke32(pOut, entry(pFile).lock >= C.SQLITE_LOCK_RESERVED ? 1 : 0)
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_CHECKRESERVEDLOCK)
        }
      },
      // The one file control handled is `PRAGMA journal_mode=WAL`, which
      // is refused. Without exclusive locking SQLite ignores it anyway
      // (there are no shared-memory methods); with it, SQLite would mark
      // the file as WAL and then fail to open the WAL file, leaving a
      // database that no later connection can open. Every other control
      // returns NOTFOUND, which tells SQLite to use its defaults.
      xFileControl: (_pFile: number, op: number, pArg: number) => {
        if (op !== C.SQLITE_FCNTL_PRAGMA) return C.SQLITE_NOTFOUND
        const arg = (i: number) => {
          const p = wasm.peekPtr(pArg + i * ptrSize)
          return p ? (wasm.cstrToJs(p) ?? '') : ''
        }
        if (arg(1).toLowerCase() !== 'journal_mode' || arg(2).toLowerCase() !== 'wal') {
          return C.SQLITE_NOTFOUND
        }
        wasm.pokePtr(pArg, wasm.allocCString('WAL mode is not supported by this VFS', false))
        return C.SQLITE_ERROR
      },
      xSectorSize: () => SECTOR_SIZE,
      xDeviceCharacteristics: () => C.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN,
    }

    // Version 1: no shared-memory or memory-mapping methods.
    const ioStruct = new capi.sqlite3_io_methods()
    ;(ioStruct as unknown as IoMethodsStruct).$iVersion = 1
    this.installVfs({ io: { struct: ioStruct, methods: io } })
    const pIo = ioStruct.pointer

    const vfs: Methods = {
      xOpen: (_pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) => {
        try {
          const named = zName !== 0 && wasm.peek8(zName) !== 0
          const path = named ? (wasm.cstrToJs(zName) as string) : `scratch:${this.nextScratch++}`
          let file: SyncFile | undefined = this.registered.get(path)
          if (!file) {
            if (flags & this.persistentFlags) {
              return fail(new Error(`not registered with the VFS: ${path}`), C.SQLITE_CANTOPEN)
            }
            file = this.scratch.get(path)
            if (!file) {
              if (!(flags & C.SQLITE_OPEN_CREATE)) return C.SQLITE_CANTOPEN
              const created = new MemoryFile()
              this.scratch.set(path, created)
              file = created
            }
          }
          this.open.set(pFile, { path, file, flags, unnamed: !named, lock: C.SQLITE_LOCK_NONE })
          const handle = new capi.sqlite3_file(pFile)
          handle.$pMethods = pIo
          handle.dispose()
          if (pOutFlags) wasm.poke32(pOutFlags, flags)
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_CANTOPEN)
        }
      },
      xDelete: (_pVfs: number, zName: number, syncDir: number) => {
        try {
          this.remove(wasm.cstrToJs(zName) as string, syncDir !== 0)
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_DELETE)
        }
      },
      xAccess: (_pVfs: number, zName: number, _flags: number, pOut: number) => {
        try {
          const path = wasm.cstrToJs(zName) as string
          const file = this.registered.get(path)
          const exists = file ? file.size() > 0 : this.scratch.has(path)
          wasm.poke32(pOut, exists ? 1 : 0)
          return 0
        } catch (err) {
          return fail(err, C.SQLITE_IOERR_ACCESS)
        }
      },
      // Paths are flat names: the full pathname is the name itself.
      xFullPathname: (_pVfs: number, zName: number, nOut: number, pOut: number) =>
        wasm.cstrncpy(pOut, zName, nOut) < nOut ? 0 : C.SQLITE_CANTOPEN,
      xGetLastError: (_pVfs: number, nOut: number, pOut: number) => {
        const err = this.error
        if (err === null) return 0
        if (nOut > 0) {
          const msg = new TextEncoder().encode(err instanceof Error ? err.message : String(err))
          const out = bytes(pOut, nOut)
          const n = Math.min(msg.byteLength, nOut - 1)
          out.set(msg.subarray(0, n))
          out[n] = 0
        }
        return C.SQLITE_IOERR
      },
      xCurrentTime: (_pVfs: number, pOut: number) => {
        wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, 'double')
        return 0
      },
      xCurrentTimeInt64: (_pVfs: number, pOut: number) => {
        wasm.poke(pOut, 210866760000000 + Date.now(), 'i64')
        return 0
      },
    }

    const vfsStruct = new capi.sqlite3_vfs()
    vfsStruct.$iVersion = 2
    vfsStruct.$szOsFile = (
      capi.sqlite3_file as unknown as { structInfo: { sizeof: number } }
    ).structInfo.sizeof
    vfsStruct.$mxPathname = 512
    vfsStruct.$zName = wasm.allocCString(this.name, false)
    vfsStruct.addOnDispose(vfsStruct.$zName)
    // Randomness and sleep come from the build's default VFS, which
    // seeds from the platform's secure random source.
    const pDefault = capi.sqlite3_vfs_find(null)
    if (pDefault) {
      const dflt = new capi.sqlite3_vfs(pDefault) as unknown as VfsStruct
      const own = vfsStruct as unknown as VfsStruct
      own.$xRandomness = dflt.$xRandomness
      own.$xSleep = dflt.$xSleep
      dflt.dispose()
    }
    const own = vfsStruct as unknown as VfsStruct
    if (!own.$xRandomness) {
      vfs.xRandomness = (_pVfs: number, n: number, pOut: number) => {
        crypto.getRandomValues(bytes(pOut, n))
        return n
      }
    }
    if (!own.$xSleep) vfs.xSleep = () => 0
    this.installVfs({ vfs: { struct: vfsStruct, methods: vfs } })
  }

  /** Deletes `path`: a registered file is emptied, a scratch file dropped. */
  private remove(path: string, sync: boolean): void {
    const file = this.registered.get(path)
    if (file) {
      file.truncate(0)
      if (sync) file.sync()
    } else {
      this.scratch.delete(path)
    }
  }

  private installVfs(spec: {
    io?: { struct: unknown; methods: Methods }
    vfs?: { struct: unknown; methods: Methods }
  }): void {
    const install = this.sqlite3.vfs.installVfs as unknown as (spec: unknown) => void
    install.call(this.sqlite3.vfs, spec)
  }
}
