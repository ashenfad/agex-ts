/**
 * Render the agent's registration table as markdown for the system
 * prompt. Each kind gets its own section; entries with descriptions
 * lead with their description (the prominence-by-presence rule).
 *
 * For namespaces and classes, we list visible members so the agent
 * doesn't have to discover them by trial and error. Member visibility
 * uses the same `include`/`exclude` filter pair the runtime adapter
 * applies — what's listed here is what the agent will actually be
 * able to call.
 *
 * Members without an explicit `configure[name].description` are listed
 * by name only. With one, the description is appended.
 */

import { memberAllowed } from '../policy'
import type {
  MemberConfig,
  MemberFilter,
  Policy,
  RegisteredCls,
  RegisteredFn,
  RegisteredNs,
  RegisteredTerminal,
} from '../types'

/** Build the "Registered Resources" section of the system prompt. */
export function renderRegistrations(policy: Policy): string {
  const sections: string[] = []
  const fns = renderFns(policy.fns)
  if (fns !== '') sections.push(fns)
  const classes = renderClasses(policy.classes)
  if (classes !== '') sections.push(classes)
  const namespaces = renderNamespaces(policy.namespaces)
  if (namespaces !== '') sections.push(namespaces)
  const terminals = renderTerminals(policy.terminals)
  if (terminals !== '') sections.push(terminals)
  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Per-kind renderers
// ---------------------------------------------------------------------------

function renderFns(fns: ReadonlyMap<string, RegisteredFn>): string {
  const visible = [...fns.values()].filter((r) => r.description !== undefined)
  if (visible.length === 0) return ''
  const lines = ['## Functions', '']
  for (const r of sorted(visible)) {
    lines.push(`- \`${r.name}\` — ${r.description as string}`)
  }
  return lines.join('\n')
}

function renderClasses(classes: ReadonlyMap<string, RegisteredCls>): string {
  const visible = [...classes.values()].filter((r) => r.description !== undefined)
  if (visible.length === 0) return ''
  const lines = ['## Classes', '']
  for (const r of sorted(visible)) {
    lines.push(`- \`${r.name}\` — ${r.description as string}`)
    if (r.constructable === false) {
      lines.push('  - *(not constructable; use as a type / static surface only)*')
    }
    if (r.cls !== undefined) {
      // Host-bound — introspect the prototype for the member list.
      const members = enumerateMembers(r.cls.prototype as object, r.include, r.exclude)
      appendMemberLines(lines, members, r.configure ?? {})
    }
    // URL-shipped: we don't have the constructor host-side to
    // introspect. The embedder's `description` is the source of
    // truth for what's available; if they want a method list in
    // the primer, they put it in the description.
  }
  return lines.join('\n')
}

function renderNamespaces(namespaces: ReadonlyMap<string, RegisteredNs>): string {
  const visible = [...namespaces.values()].filter((r) => r.description !== undefined)
  if (visible.length === 0) return ''
  const lines = ['## Namespaces', '']
  for (const r of sorted(visible)) {
    lines.push(`- \`${r.name}\` — ${r.description as string}`)
    if (r.target !== undefined) {
      const members = enumerateMembers(r.target, r.include, r.exclude)
      appendMemberLines(lines, members, r.configure ?? {})
    }
    // URL-shipped: same reasoning as `renderClasses`.
  }
  return lines.join('\n')
}

function renderTerminals(terminals: ReadonlyMap<string, RegisteredTerminal>): string {
  if (terminals.size === 0) return ''
  const lines = ['## Terminal Commands', '']
  for (const r of sorted([...terminals.values()])) {
    // Terminal commands always have a description (required at registration).
    lines.push(`- \`${r.name}\` — ${r.description as string}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Member enumeration
// ---------------------------------------------------------------------------

/** Collect callable / accessor member names on `target` plus its
 *  prototype chain, applying the standard include/exclude filter. */
function enumerateMembers(
  target: object,
  include: MemberFilter | undefined,
  exclude: MemberFilter | undefined,
): string[] {
  const seen = new Set<string>()
  for (const k of Object.getOwnPropertyNames(target)) {
    if (k === 'constructor') continue
    if (memberAllowed(k, include, exclude)) seen.add(k)
  }
  // Walk the prototype chain so class methods (which live on .prototype,
  // not on instances) get listed too.
  let proto: object | null = Object.getPrototypeOf(target) as object | null
  while (proto !== null && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === 'constructor') continue
      if (memberAllowed(k, include, exclude)) seen.add(k)
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return [...seen].sort()
}

function appendMemberLines(
  lines: string[],
  members: ReadonlyArray<string>,
  configure: Readonly<Record<string, MemberConfig>>,
): void {
  if (members.length === 0) return
  lines.push('  - *Members:*')
  for (const m of members) {
    const cfg = configure[m]
    if (cfg !== undefined && cfg.description !== undefined) {
      lines.push(`    - \`${m}\` — ${cfg.description}`)
    } else {
      lines.push(`    - \`${m}\``)
    }
  }
}

function sorted<T extends { name: string }>(entries: ReadonlyArray<T>): T[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
