/**
 * Per-session host-side virtual filesystem.
 *
 * `agent.fs(session)` returns the `FileSystem` that backs that
 * session's `/data` / `/scratch` / `/helpers` etc. — the same FS
 * the agent's `ts` emissions see via the runtime adapter.
 *
 * Each session's FS is a `MountFS` composing:
 *   - a writable backing FS (a fresh `MemoryFS` per session, or a
 *     `KvgitFS` over the session's shared `Staged` when configured)
 *   - read-only overlays at fixed prefixes (`/chapters/`, `/skills/`)
 *
 * The chapters overlay is created on first request and refreshed
 * via `refreshChaptersOverlay(session, ...)` whenever the action
 * loop applies new chapters to the session's event log.
 *
 * Backing-FS construction is delegated to a factory passed at
 * construction time. That keeps `VfsManager` agnostic of state
 * plumbing — the factory closes over the agex-ts state resolver when
 * the embedder wants kvgit-backed files, or just hands back a
 * `MemoryFS` per session otherwise.
 */

import type { FileSystem } from 'termish-ts/fs/protocol'
import { ChaptersOverlay, buildChaptersOverlay } from './fs/chapters-overlay'
import { MountFS } from './fs/mount'
import { SkillsOverlay } from './fs/skills-overlay'
import type { AgentEvent, RegisteredSkill } from './types'

const CHAPTERS_PREFIX = '/chapters'
const SKILLS_PREFIX = '/skills'

/** Async factory for the session's backing FS. The factory is async
 *  because kvgit-backed sessions need to await their `Staged`
 *  resolution (IndexedDB / SQLite open are async). MemoryFS is sync
 *  but wears the same async signature for uniformity. */
export type BackingFactory = (session: string) => Promise<FileSystem>

interface SessionEntry {
  readonly mount: MountFS
  readonly chaptersOverlay: ChaptersOverlay
  readonly skillsOverlay: SkillsOverlay
}

export class VfsManager {
  readonly #createBacking: BackingFactory
  readonly #cache = new Map<string, SessionEntry>()

  constructor(createBacking: BackingFactory) {
    this.#createBacking = createBacking
  }

  /** Get the FileSystem for a session. Lazily creates and caches one
   *  per session id; subsequent calls return the same instance.
   *
   *  Async because the backing FS factory may await — for the kvgit
   *  backing, opening the per-session VersionedKV is async. */
  async fs(session: string): Promise<MountFS> {
    const cached = this.#cache.get(session)
    if (cached !== undefined) return cached.mount
    const backing = await this.#createBacking(session)
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
}
