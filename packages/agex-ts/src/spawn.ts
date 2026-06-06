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
import { MountFS, normalizeAbs } from './fs/mount'
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
 *  Schema) and the `outputJsonSchema` the clone is shown. A `view` mount
 *  `announcement` (Gap 1) rides in the clone's `primer` so it surfaces in
 *  the opening task message, after any spec-supplied primer. */
function buildCloneDef(
  spec: SpawnSpec,
  announcement: string | null,
): TaskDefinition<unknown, unknown> {
  const primer = [spec.primer, announcement].filter((p) => p != null).join('\n\n')
  return {
    description: spec.task,
    ...(spec.output !== undefined && {
      output: jsonSchemaToStandard(spec.output),
      outputJsonSchema: spec.output,
    }),
    ...(spec.outputDescription !== undefined && { outputDescription: spec.outputDescription }),
    ...(primer.length > 0 && { primer }),
  }
}

/** Resolve a `view` path to an absolute `MountFS` prefix. An absolute
 *  path anchors at the filesystem root; a *relative* one resolves
 *  against the parent session's cwd — the same way the parent's own
 *  `fs.*` calls resolve it — so `view: "notes.md"` mounts wherever the
 *  parent would read `notes.md`, not at a root-anchored (and often
 *  empty) `/notes.md`. `normalizeAbs` collapses `.`/`..` and strips the
 *  trailing slash. A result of `'/'` is left for `MountFS` to reject. */
function resolveViewPrefix(path: string, cwd: string): string {
  return path.startsWith('/') ? normalizeAbs(path) : normalizeAbs(`${cwd}/${path}`)
}

/** Maximum directory entries named inline in a `view` mount
 *  announcement before it summarizes the remainder as `+N more`. */
const VIEW_ANNOUNCE_MAX_ENTRIES = 16

/** Build the read-only mount self-announcement folded into a clone's
 *  task framing (Gap 1): a clone starts on a blank workspace and is
 *  never told `view` files were mounted, so a real model often won't
 *  think to `list("/")` and find them. Per-file views announce the file
 *  directly; a directory view announces its root plus a shallow,
 *  count-capped listing (cheap for large trees). `null` when nothing is
 *  mounted. */
async function buildViewAnnouncement(
  backing: VirtualFileSystem,
  prefixes: string[],
): Promise<string | null> {
  if (prefixes.length === 0) return null
  const lines: string[] = []
  for (const prefix of prefixes) {
    if (await backing.isDir(prefix)) {
      const entries = await backing.list(prefix)
      const shown = entries.slice(0, VIEW_ANNOUNCE_MAX_ENTRIES)
      const more = entries.length > shown.length ? `, +${entries.length - shown.length} more` : ''
      const noun = entries.length === 1 ? 'entry' : 'entries'
      const listing = shown.length > 0 ? `: ${shown.join(', ')}${more}` : ''
      lines.push(`- ${prefix}/ — read-only directory, ${entries.length} ${noun}${listing}`)
    } else {
      lines.push(`- ${prefix} — read-only file`)
    }
  }
  return `Read-only files have been mounted into your workspace (you may read them, but not write to them):\n${lines.join('\n')}`
}

/** A read-only window onto `inner` rooted at `base`, for `spawn`'s
 *  `view`. `MountFS` strips the mount prefix before delegating (and
 *  rejects writes to a mounted overlay), so to expose the parent's
 *  `<base>` subtree at the clone's `<base>` we re-prepend `base` to
 *  incoming paths (`#at`) and re-anchor outgoing ones to the view root
 *  (`#fromBase`) — so this presents as a native overlay rooted at
 *  `base`. (`list` already returns query-relative paths, so only
 *  `listDetailed`, whose paths are query-prefixed, needs re-anchoring.)
 *  Mutators throw defensively — `MountFS` blocks overlay writes before
 *  they reach here. */
class ReadOnlyView implements VirtualFileSystem {
  constructor(
    private readonly inner: VirtualFileSystem,
    private readonly base: string,
  ) {}
  #at(p: string): string {
    if (p === '' || p === '/') return this.base
    return `${this.base}${p.startsWith('/') ? p : `/${p}`}`
  }
  /** Inverse of `#at` for returned paths: strip `base` so a result is
   *  relative to the view (overlay) root — matching how a native
   *  overlay reports paths. `MountFS` re-prepends the mount prefix on a
   *  recursive listing from an ancestor, so without this the path would
   *  double-prefix (`/data/data/x`). */
  #fromBase(p: string): string {
    if (p === this.base) return '/'
    if (p.startsWith(`${this.base}/`)) return p.slice(this.base.length)
    return p
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
    // `list` returns paths relative to the queried dir (no leading
    // slash), so querying at the view root already yields view-relative
    // results — pass through unchanged.
    return this.inner.list(this.#at(p), opts)
  }
  async listDetailed(
    p = '/',
    opts?: { recursive?: boolean },
  ): ReturnType<VirtualFileSystem['listDetailed']> {
    // `listDetailed` paths are query-prefixed (absolute here), so
    // re-anchor them at the view root or `MountFS` double-prefixes.
    const entries = await this.inner.listDetailed(this.#at(p), opts)
    return entries.map((fi) => ({ ...fi, path: this.#fromBase(fi.path) }))
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
 *  When `view` is set, the named parent paths are resolved (relative to
 *  the parent's cwd) and mounted read-only at the same location (the
 *  parent's *backing* FS, so no nested `/view/skills`); `MountFS` rejects
 *  writes to a mounted overlay, so read-only falls out for free. A path
 *  that resolves to nothing throws, rather than silently mounting an
 *  empty overlay the clone would report as "doesn't exist". Returns a
 *  `viewAnnouncement` (Gap 1) so the clone can be told what was mounted.
 *  Nothing here mutates the parent. */
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
  let viewAnnouncement: string | null = null
  if (view !== undefined) {
    const backing = await agent.backingFs(parentSession)
    const cwd = backing.getcwd()
    const paths = typeof view === 'string' ? [view] : view
    // Dedupe: two paths can resolve to the same prefix (e.g. `notes.md`
    // and `./notes.md`). `MountFS` already collapses same-prefix mounts,
    // but deduping here also keeps the announcement from listing a path
    // twice and skips redundant stat/list calls. `Set` preserves order.
    const prefixes = [...new Set(paths.map((p) => resolveViewPrefix(p, cwd)))]
    for (const prefix of prefixes) {
      if (!(await backing.exists(prefix))) {
        throw new Error(`spawn view path not found in the parent filesystem: ${prefix}`)
      }
      mounts.push({ prefix, fs: new ReadOnlyView(backing, prefix) })
    }
    viewAnnouncement = await buildViewAnnouncement(backing, prefixes)
  }
  return {
    eventLog: new EventLogImpl(state, session),
    fs: new MountFS(new MemoryFS(), mounts),
    cache: new CacheImpl(state, session),
    viewAnnouncement,
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
    // Build resources first: mounting `view` is what surfaces the
    // self-announcement folded into the clone's task framing below.
    const { viewAnnouncement, ...resources } = await buildCloneResources(
      agent,
      idx,
      parentSession,
      normalized.view,
    )
    // The parent may have aborted *during* the setup above. Re-check
    // before queueing on the (non-abort-aware) semaphore: a doomed
    // waiter would otherwise block until a permit frees, only to throw.
    if (parentSignal.aborted) throw new CancelledError()
    const cloneDef = buildCloneDef(normalized, viewAnnouncement)

    // Forward the clone's events to the parent's stream, re-tagged so a
    // host UI can demux concurrent clones. We do NOT thread them into the
    // parent's durable log (stream, don't store) — the clone's own log is
    // the throwaway `Live` above.
    const label = `${agent.name}:spawn#${idx}`
    const onEvent =
      parentOnEvent === undefined
        ? undefined
        : (e: AgentEvent) => parentOnEvent({ ...e, agentName: label, spawnIndex: idx })

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
