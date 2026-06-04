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
import { CancelledError, TaskFailError } from './errors'
import { EventLogImpl } from './event-log'
import { MountFS } from './fs/mount'
import { SkillsOverlay } from './fs/skills-overlay'
import { jsonSchemaToStandard } from './json-schema'
import { Live } from './state/live'
import { type TaskDefinition, type TaskFnInternal, makeTask } from './task'
import type { AgentEvent, SpawnFn, SpawnSpec } from './types'

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

/** Build the clone's throwaway substrate: a fresh in-process `Live` for
 *  the (discarded) event log + cache, and a blank `MemoryFS` with the
 *  parent's `/skills` overlay mounted so the clone has the same skills.
 *  Nothing here touches the parent's configured session. */
async function buildCloneResources(agent: Agent, idx: number) {
  const { MemoryFS } = await import('@agex-ts/termish/fs/memory')
  const state = new Live()
  const session = `spawn#${idx}`
  const fs = new MountFS(new MemoryFS(), [
    { prefix: SKILLS_PREFIX, fs: new SkillsOverlay(agent.policy().skills) },
  ])
  return {
    eventLog: new EventLogImpl(state, session),
    fs,
    cache: new CacheImpl(state, session),
  }
}

export function createSpawn(
  agent: Agent,
  parentSignal: AbortSignal,
  parentOnEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
  maxSpawns: number,
): SpawnFn {
  const semaphore = new Semaphore(Math.max(1, maxSpawns))
  let counter = 0

  return async (spec: string | SpawnSpec): Promise<unknown> => {
    const idx = counter++
    const normalized: SpawnSpec = typeof spec === 'string' ? { task: spec } : spec
    const cloneDef = buildCloneDef(normalized)
    const resources = await buildCloneResources(agent, idx)

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
      // Cancellation propagates (the parent is being torn down). A
      // sub-task failure must NOT surface as a TaskFailError — the runtime
      // would read it as the *parent* calling taskFail. Re-raise as a
      // plain Error so the parent sees an ordinary recoverable error it
      // can read next turn (or catch around the spawn call).
      if (e instanceof CancelledError) throw e
      if (e instanceof TaskFailError) throw new Error(`spawned sub-task failed: ${e.message}`)
      throw e
    } finally {
      semaphore.release()
    }
  }
}
