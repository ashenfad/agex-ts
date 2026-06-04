/**
 * `spawn` — agent-authored ephemeral sub-tasks (see `docs/roadmap/spawn.md`).
 *
 * `createSpawn` builds the `spawn` capability injected into a top-level
 * agent's code. Calling `spawn(spec)` runs a **clone** of the agent — the
 * same policy/registrations, but on throwaway state (a fresh `Live` event
 * log + cache and a blank `MemoryFS`, with the parent's `/skills` overlay
 * mounted read-only) — to fulfil a typed sub-task and return its result.
 *
 * The clone runs the *same* task loop (`makeTask`) via the `RunContext`
 * seam, so it inherits everything — output enforce-and-retry, cancellation,
 * the no-action nudge — for free. Injecting `resources` is what makes the
 * run ephemeral: it never touches the parent's session, never chapters, and
 * gets no `spawn` of its own (depth-1 leaf workers).
 *
 * Fan-out is native `Promise.all`; a semaphore bounds concurrent clones to
 * the agent's `maxSpawns`. A clone failure rejects the `spawn` promise as a
 * plain recoverable error — never a `TaskFailError`, which the runtime would
 * misread as the *parent* finishing.
 */

import type { Agent } from './agent'
import { CacheImpl } from './cache'
import { CancelledError, TaskFailError, isCancelledError } from './errors'
import { EventLogImpl } from './event-log'
import { MountFS } from './fs/mount'
import { SkillsOverlay } from './fs/skills-overlay'
import { jsonSchemaToStandard } from './json-schema'
import { Live } from './state/live'
import { type TaskDefinition, type TaskFnInternal, makeTask } from './task'
import type { AgentEvent, SpawnFn, SpawnSpec, VirtualFileSystem } from './types'

const SKILLS_PREFIX = '/skills'

/** A counting semaphore with direct hand-off: a release wakes the next
 *  waiter rather than incrementing, so the bound holds exactly. */
class Semaphore {
  #free: number
  readonly #waiters: Array<() => void> = []

  constructor(permits: number) {
    this.#free = permits
  }

  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free--
      return
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve))
  }

  release(): void {
    const next = this.#waiters.shift()
    if (next !== undefined) next()
    else this.#free++
  }
}

/** Map a `SpawnSpec` onto a `TaskDefinition` for the clone. A JSON Schema
 *  `output` becomes both the validated `output` (compiled to a Standard
 *  Schema) and the `outputJsonSchema` the clone is shown. */
function buildCloneDef(spec: SpawnSpec): TaskDefinition<unknown, unknown> {
  return {
    description: spec.task,
    ...(spec.output !== undefined && {
      output: jsonSchemaToStandard(spec.output),
      outputJsonSchema: spec.output,
    }),
    ...(spec.outputDescription !== undefined && { outputDescription: spec.outputDescription }),
    ...(spec.primer !== undefined && { primer: spec.primer }),
  }
}

/** Normalize a `view` path into a `MountFS` prefix: ensure a leading
 *  slash and strip a trailing one. Invalid results (`''` / `'/'`) are
 *  left for `MountFS` to reject with its own clear message. */
function viewPrefix(path: string): string {
  const withLead = path.startsWith('/') ? path : `/${path}`
  return withLead.length > 1 && withLead.endsWith('/') ? withLead.slice(0, -1) : withLead
}

/** A read-only window onto `inner` rooted at `base`, for `spawn`'s
 *  `view`. `MountFS` strips the mount prefix before delegating (and
 *  rejects writes to a mounted overlay), so to expose the parent's
 *  `<base>` subtree at the clone's `<base>` we re-prepend `base` to the
 *  stripped path. Because the mount prefix *equals* `base`, paths the
 *  inner FS returns (e.g. recursive `list`) are already clone-absolute,
 *  so results pass through untouched. Mutators throw defensively —
 *  `MountFS` blocks overlay writes before they reach here. */
class ReadOnlyView implements VirtualFileSystem {
  constructor(
    private readonly inner: VirtualFileSystem,
    private readonly base: string,
  ) {}
  #at(p: string): string {
    if (p === '' || p === '/') return this.base
    return `${this.base}${p.startsWith('/') ? p : `/${p}`}`
  }
  // cwd is tracked on the MountFS backing, so these aren't reached.
  getcwd(): string {
    return '/'
  }
  async chdir(): Promise<void> {}
  read(p: string): Promise<Uint8Array> {
    return this.inner.read(this.#at(p))
  }
  exists(p: string): Promise<boolean> {
    return this.inner.exists(this.#at(p))
  }
  isFile(p: string): Promise<boolean> {
    return this.inner.isFile(this.#at(p))
  }
  isDir(p: string): Promise<boolean> {
    return this.inner.isDir(this.#at(p))
  }
  stat(p: string): ReturnType<VirtualFileSystem['stat']> {
    return this.inner.stat(this.#at(p))
  }
  list(p = '/', opts?: { recursive?: boolean }): Promise<string[]> {
    return this.inner.list(this.#at(p), opts)
  }
  listDetailed(
    p = '/',
    opts?: { recursive?: boolean },
  ): ReturnType<VirtualFileSystem['listDetailed']> {
    return this.inner.listDetailed(this.#at(p), opts)
  }
  async write(): Promise<void> {
    throw new TypeError('spawn view is read-only')
  }
  async mkdir(): Promise<void> {
    throw new TypeError('spawn view is read-only')
  }
  async remove(): Promise<void> {
    throw new TypeError('spawn view is read-only')
  }
  async rmdir(): Promise<void> {
    throw new TypeError('spawn view is read-only')
  }
  async rename(): Promise<void> {
    throw new TypeError('spawn view is read-only')
  }
}

/** Build the clone's throwaway substrate: a fresh in-process `Live` for
 *  the (discarded) event log + cache, and a blank `MemoryFS` with the
 *  parent's `/skills` overlay mounted so the clone has the same skills.
 *  When `view` is set, the named parent paths are mounted read-only at
 *  the same location (the parent's *backing* FS, so no nested
 *  `/view/skills`); `MountFS` rejects writes to a mounted overlay, so
 *  read-only falls out for free. Nothing here mutates the parent. */
async function buildCloneResources(
  agent: Agent,
  idx: number,
  parentSession: string,
  view: string | string[] | undefined,
) {
  const { MemoryFS } = await import('@agex-ts/termish/fs/memory')
  const state = new Live()
  const session = `spawn#${idx}`
  const mounts: Array<{ prefix: string; fs: VirtualFileSystem }> = [
    { prefix: SKILLS_PREFIX, fs: new SkillsOverlay(agent.policy().skills) },
  ]
  if (view !== undefined) {
    const backing = await agent.backingFs(parentSession)
    const paths = typeof view === 'string' ? [view] : view
    for (const p of paths) {
      const prefix = viewPrefix(p)
      mounts.push({ prefix, fs: new ReadOnlyView(backing, prefix) })
    }
  }
  return {
    eventLog: new EventLogImpl(state, session),
    fs: new MountFS(new MemoryFS(), mounts),
    cache: new CacheImpl(state, session),
  }
}

export function createSpawn(
  agent: Agent,
  parentSession: string,
  parentSignal: AbortSignal,
  parentOnEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
  maxSpawns: number,
): SpawnFn {
  const semaphore = new Semaphore(Math.max(1, maxSpawns))
  let counter = 0

  return async (spec: string | SpawnSpec): Promise<unknown> => {
    // Bail before allocating clone state if the parent is already gone.
    if (parentSignal.aborted) throw new CancelledError()
    const idx = counter++
    const normalized: SpawnSpec = typeof spec === 'string' ? { task: spec } : spec
    const cloneDef = buildCloneDef(normalized)
    const resources = await buildCloneResources(agent, idx, parentSession, normalized.view)

    // Forward the clone's events to the parent's stream, re-tagged so a
    // host UI can demux concurrent clones. We do NOT thread them into the
    // parent's durable log (stream, don't store) — the clone's own log is
    // the throwaway `Live` above.
    const label = `${agent.name}:spawn#${idx}`
    const onEvent =
      parentOnEvent === undefined
        ? undefined
        : (e: AgentEvent) => parentOnEvent({ ...e, agentName: label })

    await semaphore.acquire()
    try {
      const cloneFn = makeTask(agent, cloneDef) as TaskFnInternal<unknown, unknown>
      return await cloneFn(
        normalized.input,
        { signal: parentSignal, ...(onEvent !== undefined && { onEvent }) },
        { resources },
      )
    } catch (e) {
      // Cancellation propagates (the parent is being torn down). Use
      // isCancelledError, not instanceof: a cancellation raised inside the
      // clone's *emission* originates in the worker and comes back as a
      // plain Error with the right name but no CancelledError prototype.
      if (isCancelledError(e)) throw e
      // A sub-task failure must NOT surface as a TaskFailError — the runtime
      // would read it as the *parent* calling taskFail. Re-raise as a plain
      // Error so the parent sees an ordinary recoverable error it can read
      // next turn (or catch around the spawn call). instanceof is reliable
      // here: this TaskFailError is constructed host-side by the clone's
      // makeTask loop (the worker only returns a fail outcome as data).
      if (e instanceof TaskFailError) throw new Error(`spawned sub-task failed: ${e.message}`)
      throw e
    } finally {
      semaphore.release()
    }
  }
}
