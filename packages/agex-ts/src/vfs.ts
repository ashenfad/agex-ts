/**
 * Per-session host-side virtual filesystem.
 *
 * `agent.fs(session)` returns the `FileSystem` that backs that
 * session's `/data` / `/scratch` / `/helpers` etc. — the same FS
 * the agent's `ts` emissions see via the runtime adapter.
 *
 * v1 backs each session with an independent `MemoryFS` cached on
 * the agent. The kvgit-backed path (sharing the agent's state
 * backend so the FS lands in the same versioned commit chain as
 * the event log + cache) is a follow-up; the design.md §6.2 notes
 * apply once that wiring exists.
 */

import { MemoryFS } from 'termish-ts/fs/memory'
import type { FSConfig, VirtualFileSystem } from './types'

export class VfsManager {
  readonly #config: FSConfig
  readonly #cache = new Map<string, VirtualFileSystem>()

  constructor(config: FSConfig = { type: 'memory' }) {
    this.#config = config
  }

  /** Get the FileSystem for a session. Lazily creates and caches one
   *  per session id; subsequent calls return the same instance. */
  fs(session: string): VirtualFileSystem {
    const cached = this.#cache.get(session)
    if (cached !== undefined) return cached
    const fresh = this.#create()
    this.#cache.set(session, fresh)
    return fresh
  }

  #create(): VirtualFileSystem {
    switch (this.#config.type) {
      case 'memory':
        return new MemoryFS()
      case 'kvgit':
        // Wiring the agent's KvgitState into KvgitFS lands in a
        // follow-up — for v1 the agent surfaces this as a runtime
        // error rather than a silent fallback.
        throw new Error('VfsManager: { type: "kvgit" } is not wired in v1; use { type: "memory" }')
      default: {
        const exhaustive: never = this.#config
        throw new Error(`VfsManager: unknown FSConfig type: ${(exhaustive as FSConfig).type}`)
      }
    }
  }
}
