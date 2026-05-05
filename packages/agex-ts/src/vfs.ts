/**
 * Per-session host-side virtual filesystem.
 *
 * `agent.fs(session)` returns the `FileSystem` that backs that
 * session's `/data` / `/scratch` / `/helpers` etc. — the same FS
 * the agent's `ts` emissions see via the runtime adapter.
 *
 * Each session's FS is a `MountFS` composing:
 *   - a writable backing FS (a per-session `MemoryFS` in v1)
 *   - read-only overlays at fixed prefixes (`/chapters/` today,
 *     future `/skills/`)
 *
 * The chapters overlay is created on first request and refreshed
 * via `refreshChaptersOverlay(session, ...)` whenever the action
 * loop applies new chapters to the session's event log.
 */

import { MemoryFS } from 'termish-ts/fs/memory'
import { ChaptersOverlay, buildChaptersOverlay } from './fs/chapters-overlay'
import { MountFS } from './fs/mount'
import { SkillsOverlay } from './fs/skills-overlay'
import type { AgentEvent, FSConfig, RegisteredSkill } from './types'

const CHAPTERS_PREFIX = '/chapters'
const SKILLS_PREFIX = '/skills'

interface SessionEntry {
  readonly mount: MountFS
  readonly chaptersOverlay: ChaptersOverlay
  readonly skillsOverlay: SkillsOverlay
}

export class VfsManager {
  readonly #config: FSConfig
  readonly #cache = new Map<string, SessionEntry>()

  constructor(config: FSConfig = { type: 'memory' }) {
    this.#config = config
  }

  /** Get the FileSystem for a session. Lazily creates and caches one
   *  per session id; subsequent calls return the same instance. */
  fs(session: string): MountFS {
    const cached = this.#cache.get(session)
    if (cached !== undefined) return cached.mount
    const backing = this.#createBacking()
    const chaptersOverlay = new ChaptersOverlay()
    const skillsOverlay = new SkillsOverlay()
    const mount = new MountFS(backing, [
      { prefix: CHAPTERS_PREFIX, fs: chaptersOverlay },
      { prefix: SKILLS_PREFIX, fs: skillsOverlay },
    ])
    this.#cache.set(session, { mount, chaptersOverlay, skillsOverlay })
    return mount
  }

  /** Rebuild the `/chapters/` overlay for `session` from the current
   *  event log. Called by the action loop after chaptering applies a
   *  new chapter so the agent sees it immediately on its next
   *  filesystem read. No-op if the session hasn't been initialized
   *  yet (the next `fs()` call will build a fresh overlay). */
  async refreshChaptersOverlay(
    session: string,
    events: AsyncIterable<AgentEvent>,
    resolveEvent: (ref: string) => Promise<AgentEvent | undefined>,
  ): Promise<void> {
    const entry = this.#cache.get(session)
    if (entry === undefined) return
    const files = await buildChaptersOverlay(events, resolveEvent)
    entry.chaptersOverlay.swap(files)
  }

  /** Rebuild the `/skills/` overlay for `session` from the agent's
   *  current registered skills. Called when a new skill registers,
   *  or lazily on first task call (so freshly registered skills are
   *  visible without an explicit refresh). */
  refreshSkillsOverlay(session: string, skills: ReadonlyMap<string, RegisteredSkill>): void {
    const entry = this.#cache.get(session)
    if (entry === undefined) return
    entry.skillsOverlay.swap(skills)
  }

  #createBacking(): MemoryFS {
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
