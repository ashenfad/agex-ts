/**
 * Crash injection, for testing what SQLite leaves behind when the
 * process dies mid-write.
 */

import type { Directory, SyncFile } from './files'

/** The file operations a crash can be injected at. */
export type CrashOp = 'write' | 'truncate' | 'sync'

/**
 * Where to crash: the `n`th (from 1) operation of kind `op`, counted
 * across every file of the directory from the moment the crash is
 * armed. The operation doesn't happen, except that a write may land in
 * part: `torn` is how many of its leading bytes reach the file (none
 * by default).
 */
export interface CrashPoint {
  op: CrashOp
  n: number
  torn?: number
}

/** Thrown by every operation of a directory that has crashed. */
export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`simulated crash at ${point.op} #${point.n}`)
    this.name = 'SimulatedCrash'
  }
}

/**
 * A `Directory` that passes everything to another until a crash point
 * is reached, then dies there.
 *
 * `crashAt(point)` arms a crash at the `n`th write, truncate or sync.
 * When it hits, that operation fails (a torn write lands its first
 * `torn` bytes first), and from then on every operation of the
 * directory or its files throws `SimulatedCrash`, except `close`,
 * which releases the underlying file. So nothing SQLite does after the
 * failure, such as rolling back from its journal, reaches the files:
 * the underlying directory holds exactly what a process that died at
 * that instant would leave, and reopening it is the next process.
 *
 * That is the state a process death leaves on a real file system:
 * every completed write is there, synced or not. Power loss, which can
 * also drop or reorder unsynced writes, is not modelled.
 *
 * `ops` counts every write, truncate and sync passed through so far,
 * so a test can run a transaction once to count its operations, then
 * crash at each. Subclasses can override `tick` to watch the order.
 */
export class CrashingDirectory implements Directory {
  private armed: { point: CrashPoint; seen: number } | null = null
  private dead: SimulatedCrash | null = null

  /** Operations so far, by kind, across all files. */
  readonly ops: Record<CrashOp, number> = { write: 0, truncate: 0, sync: 0 }

  constructor(readonly inner: Directory) {}

  async open(name: string): Promise<SyncFile> {
    this.alive()
    return new CrashingFile(await this.inner.open(name), name, this)
  }

  async delete(name: string): Promise<void> {
    this.alive()
    await this.inner.delete(name)
  }

  async exists(name: string): Promise<boolean> {
    this.alive()
    return this.inner.exists(name)
  }

  /** Arms a crash (replacing any armed one). Counting starts now. */
  crashAt(point: CrashPoint): void {
    if (!Number.isInteger(point.n) || point.n < 1) throw new RangeError('crash n must be >= 1')
    this.alive()
    this.armed = { point, seen: 0 }
  }

  /** The point the directory crashed at, if it has. */
  get crashed(): CrashPoint | null {
    return this.dead?.point ?? null
  }

  /**
   * Counts an operation on file `name`, returning the armed crash
   * point if this operation is it.
   */
  protected tick(op: CrashOp, _name: string): CrashPoint | undefined {
    this.ops[op]++
    const armed = this.armed
    if (armed?.point.op !== op) return undefined
    armed.seen++
    return armed.seen === armed.point.n ? armed.point : undefined
  }

  /** @internal Runs `op` on a file unless the directory is dead or this is the crash. */
  run(op: CrashOp, name: string, apply: (torn: number | undefined) => void): void {
    this.alive()
    const point = this.tick(op, name)
    if (point) {
      this.armed = null
      this.dead = new SimulatedCrash(point)
      if (op === 'write' && point.torn) apply(point.torn)
      throw this.dead
    }
    apply(undefined)
  }

  /** @internal Throws if the directory has crashed. */
  alive(): void {
    if (this.dead) throw this.dead
  }
}

class CrashingFile implements SyncFile {
  constructor(
    private readonly file: SyncFile,
    private readonly name: string,
    private readonly dir: CrashingDirectory,
  ) {}

  read(into: Uint8Array, at: number): number {
    this.dir.alive()
    return this.file.read(into, at)
  }

  write(from: Uint8Array, at: number): void {
    this.dir.run('write', this.name, (torn) => {
      const n = torn === undefined ? from.byteLength : Math.min(torn, from.byteLength)
      this.file.write(n === from.byteLength ? from : from.subarray(0, n), at)
    })
  }

  truncate(size: number): void {
    this.dir.run('truncate', this.name, () => this.file.truncate(size))
  }

  sync(): void {
    this.dir.run('sync', this.name, () => this.file.sync())
  }

  size(): number {
    this.dir.alive()
    return this.file.size()
  }

  close(): void {
    this.file.close()
  }
}
