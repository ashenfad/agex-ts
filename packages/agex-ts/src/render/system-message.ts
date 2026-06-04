/**
 * `buildSystemMessage(agent)` — composes the agent's system prompt
 * from the four standard parts, in cache-friendly order:
 *
 *   1. BUILTIN_PRIMER (or `agent.agexPrimerOverride`) — agex
 *      conventions, identical across every task for every agent
 *      that doesn't override
 *   2. Capabilities or Registered Resources — `capabilitiesPrimer`
 *      if set (curated control), otherwise auto-rendered from the
 *      policy table
 *   3. Skills listing — names + first-line descriptions of
 *      registered skills (full content lives in `/skills/<name>/SKILL.md`)
 *   4. `agent.primer` — the agent's own per-instance voice
 *
 * Stable parts top-loaded so provider packages can place a cache
 * marker after part 4: everything in the system message is
 * cacheable, and reading it costs zero new tokens on subsequent
 * turns of the same task — or even subsequent tasks against the
 * same agent shape.
 */

import { renderSkillsListing } from '../fs/skills-overlay'
import type { Policy } from '../types'
import { BUILTIN_PRIMER } from './builtin-primer'
import { renderRegistrations } from './registrations'

export interface SystemMessageInputs {
  /** The full registration table. Only the description-bearing
   *  entries get rendered into the prompt. */
  readonly policy: Policy
  /** When set, replaces the BUILTIN_PRIMER entirely. Use only if
   *  you really mean to override agex's environment description. */
  readonly agexPrimerOverride?: string
  /** When set, replaces the auto-rendered "Registered Resources"
   *  section with curated prose. Use when the auto-rendering
   *  doesn't fit your agent's UX (e.g. you want to organize tools
   *  thematically, or surface only some of them). */
  readonly capabilitiesPrimer?: string
  /** The agent's per-instance voice. Appended last. */
  readonly agentPrimer?: string
  /** Optional addendum the runtime adapter contributes (via
   *  `RuntimeAdapter.primerAddendum`). Inserted just after the
   *  built-in primer so any environment-specific guidance the
   *  agent needs (e.g. workerRuntime's `routeFetchToVfs` enabling
   *  fetch-against-VFS) is read alongside the agex conventions. */
  readonly runtimeAddendum?: string
  /** When true, append the `spawn` (sub-tasks) section. Set by the task
   *  loop only for spawn-enabled top-level runs, so the primer never
   *  teaches a `spawn` the agent can't call. See `docs/roadmap/spawn.md`. */
  readonly spawnEnabled?: boolean
  /** When true, this run is an ephemeral sub-task clone (a `spawn`
   *  child). Appends a short note setting its expectations: it has its
   *  own scratch VFS via `fs.*`, but third-party libraries that fetch
   *  URLs won't reach that VFS. Mutually exclusive with `spawnEnabled`
   *  (clones are depth-1 and never get `spawn`). */
  readonly isClone?: boolean
}

/** Teaches the `spawn` builtin. Appended only when `spawnEnabled`. Kept
 *  terse and stable (cache-friendly): the contract mirrors a task, and
 *  fan-out is native `Promise.all` — no bespoke API to learn. */
const SPAWN_PRIMER = `## Spawn (sub-tasks)

\`spawn\` runs an ephemeral, memoryless clone of yourself to fulfil a typed sub-task — generating data, drafting an artifact, researching one point — and returns its result. The clone has your capabilities but none of your memory, cache, or files, so reserve it for self-contained work worth that cost.

\`\`\`ts
// one-shot, prose contract — returns the clone's taskSuccess value
const summary = await spawn('Summarize /docs/spec.md in three bullets')

// structured contract: pass an input and a JSON Schema the result must satisfy
const tile = await spawn({
  task: 'Produce a 64x64 SVG tile',
  input: { prompt: 'a small castle' },
  output: { type: 'object', properties: { svg: { type: 'string' } }, required: ['svg'] },
})
\`\`\`

Fan out with ordinary \`Promise.all\` — concurrency is bounded for you:

\`\`\`ts
const tiles = await Promise.all(prompts.map((p) => spawn({ task: 'Produce a tile', input: { prompt: p } })))
\`\`\`

A clone that fails throws, so \`await spawn(...)\` rejects — catch it, or let it surface as this turn's error. Clones can't spawn (they're leaf workers), and a handle must be awaited within the action that created it.`

/** Shown to a sub-task clone instead of the spawn section. Sets two
 *  expectations: the clone has its own throwaway VFS reachable via
 *  `fs.*`, and third-party libraries that fetch URLs read from the
 *  network, not that VFS (so load local files explicitly). */
const SUBAGENT_PRIMER = `## Sub-task

You're running as an ephemeral sub-task clone. You have your own scratch filesystem — read and write it with \`fs.read\` / \`fs.write\`. Note: third-party libraries that fetch URLs read from the network, not your filesystem. To use one with a local file, \`fs.read\` the bytes yourself and pass them in — don't rely on the library fetching a VFS path.`

export function buildSystemMessage(inputs: SystemMessageInputs): string {
  const parts: string[] = []

  // 1. Agex conventions (or override)
  parts.push(inputs.agexPrimerOverride ?? BUILTIN_PRIMER)

  // 1b. Runtime-contributed addendum (e.g. workerRuntime's
  // routeFetchToVfs notice). Appears alongside the agex conventions
  // so environment-specific guidance reads as part of the same
  // "how this environment works" section.
  if (inputs.runtimeAddendum !== undefined && inputs.runtimeAddendum.trim().length > 0) {
    parts.push(inputs.runtimeAddendum.trim())
  }

  // 2. Capabilities (curated) or Registered Resources (auto)
  if (inputs.capabilitiesPrimer !== undefined) {
    if (inputs.capabilitiesPrimer.trim().length > 0) {
      parts.push(`# Capabilities Primer\n\n${inputs.capabilitiesPrimer.trim()}`)
    }
  } else {
    const registrations = renderRegistrations(inputs.policy)
    if (registrations.trim().length > 0) {
      parts.push(`# Registered Resources\n\n${registrations}`)
    }
  }

  // 2b. Spawn (sub-tasks) for a spawn-enabled top-level run, or the
  // sub-task note for a clone. Mutually exclusive (clones are depth-1),
  // and both sit with the capability descriptions.
  if (inputs.spawnEnabled === true) {
    parts.push(SPAWN_PRIMER)
  } else if (inputs.isClone === true) {
    parts.push(SUBAGENT_PRIMER)
  }

  // 3. Skills listing (names + descriptions; full content via VFS overlay)
  const skillsListing = renderSkillsListing(inputs.policy.skills)
  if (skillsListing.trim().length > 0) {
    parts.push(skillsListing)
  }

  // 4. Agent's own primer
  if (inputs.agentPrimer !== undefined && inputs.agentPrimer.trim().length > 0) {
    parts.push(inputs.agentPrimer.trim())
  }

  return parts.join('\n\n')
}
