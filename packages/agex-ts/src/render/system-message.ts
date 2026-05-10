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
}

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
