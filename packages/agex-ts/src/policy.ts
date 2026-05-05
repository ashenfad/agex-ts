/**
 * `PolicyBuilder` — incremental construction of the agent's
 * registration table.
 *
 * The five `register*` methods correspond to `agent.fn`, `.cls`,
 * `.namespace`, `.skill`, `.terminal`. Each one validates eagerly
 * (RegistrationError on bad input or name collision) and updates
 * a single registration record in the appropriate map.
 *
 * `snapshot()` returns an immutable `Policy` view — the runtime
 * adapter consumes one of these at `init()` time. Subsequent calls
 * to `register*` invalidate any earlier snapshot conceptually, but
 * since snapshots are read-only views of the live maps, callers
 * should re-snapshot after each registration burst.
 */

import { globMatch as termishGlobMatch } from 'termish-ts'
import { RegistrationError } from './errors'
import type {
  MemberConfig,
  MemberFilter,
  Policy,
  RegisteredCls,
  RegisteredFn,
  RegisteredNs,
  RegisteredSkill,
  RegisteredTerminal,
  RegistrationCommon,
  TerminalCommandHandler,
} from './types'

interface FnRegistration extends RegistrationCommon {
  readonly fn: RegisteredFn['fn']
  readonly paramsSchema?: RegisteredFn['paramsSchema']
}

interface ClsRegistration extends RegistrationCommon {
  readonly cls: RegisteredCls['cls']
  readonly constructable?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
}

interface NsRegistration extends RegistrationCommon {
  readonly target: object
  readonly recursive?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
  readonly live?: boolean
}

interface TerminalRegistration extends RegistrationCommon {
  readonly handler: TerminalCommandHandler
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export class PolicyBuilder {
  readonly #fns = new Map<string, RegisteredFn>()
  readonly #classes = new Map<string, RegisteredCls>()
  readonly #namespaces = new Map<string, RegisteredNs>()
  readonly #skills = new Map<string, RegisteredSkill>()
  readonly #terminals = new Map<string, RegisteredTerminal>()

  // -- Mutators -----------------------------------------------------------

  registerFn(name: string, opts: FnRegistration): void {
    this.#assertNameValid(name, 'fn')
    this.#assertNameAvailable(name)
    this.#fns.set(name, omitUndefined({ kind: 'fn', name, ...opts }) as RegisteredFn)
  }

  registerCls(name: string, opts: ClsRegistration): void {
    this.#assertNameValid(name, 'cls')
    this.#assertNameAvailable(name)
    this.#classes.set(name, omitUndefined({ kind: 'cls', name, ...opts }) as RegisteredCls)
  }

  registerNamespace(name: string, opts: NsRegistration): void {
    this.#assertNameValid(name, 'namespace')
    this.#assertNameAvailable(name)
    this.#namespaces.set(name, omitUndefined({ kind: 'namespace', name, ...opts }) as RegisteredNs)
  }

  registerSkill(name: string, content: string): void {
    this.#assertNameValid(name, 'skill')
    this.#assertNameAvailable(name)
    if (typeof content !== 'string') {
      throw new RegistrationError(`skill ${name}: content must be a string`)
    }
    this.#skills.set(name, { kind: 'skill', name, content })
  }

  registerTerminal(name: string, opts: TerminalRegistration): void {
    this.#assertNameValid(name, 'terminal')
    this.#assertNameAvailable(name)
    if (opts.description === undefined || opts.description.length === 0) {
      // Terminal commands have no docstring fallback in JS; require an
      // explicit description so the agent can discover the command.
      throw new RegistrationError(`terminal ${name}: description is required`)
    }
    if (typeof opts.handler !== 'function') {
      throw new RegistrationError(`terminal ${name}: handler must be a function`)
    }
    this.#terminals.set(
      name,
      omitUndefined({ kind: 'terminal', name, ...opts }) as RegisteredTerminal,
    )
  }

  // -- View ---------------------------------------------------------------

  snapshot(): Policy {
    // Return read-only views over the live maps. `ReadonlyMap` is a
    // structural type; the .get/.has/.keys surface is fine for
    // consumers but they can't mutate.
    return {
      fns: this.#fns as ReadonlyMap<string, RegisteredFn>,
      classes: this.#classes as ReadonlyMap<string, RegisteredCls>,
      namespaces: this.#namespaces as ReadonlyMap<string, RegisteredNs>,
      skills: this.#skills as ReadonlyMap<string, RegisteredSkill>,
      terminals: this.#terminals as ReadonlyMap<string, RegisteredTerminal>,
    }
  }

  /** Hash-style fingerprint of the current policy. Cheap to compute;
   *  any registration mutation changes the value. The agent uses
   *  this to invalidate cached primer/dependency snapshots. */
  fingerprint(): string {
    const parts: string[] = []
    for (const m of [this.#fns, this.#classes, this.#namespaces, this.#skills, this.#terminals]) {
      for (const k of [...m.keys()].sort()) parts.push(`${k}@${m.size}`)
    }
    return parts.join('|')
  }

  // -- Internal -----------------------------------------------------------

  #assertNameValid(name: string, kind: string): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new RegistrationError(`${kind}: name must be a non-empty string`)
    }
    if (!NAME_RE.test(name)) {
      throw new RegistrationError(
        `${kind} ${name}: name must match /^[A-Za-z_][A-Za-z0-9_]*$/ (valid JS identifier)`,
      )
    }
  }

  #assertNameAvailable(name: string): void {
    const found =
      (this.#fns.has(name) && 'fn') ||
      (this.#classes.has(name) && 'cls') ||
      (this.#namespaces.has(name) && 'namespace') ||
      (this.#skills.has(name) && 'skill') ||
      (this.#terminals.has(name) && 'terminal')
    if (found) {
      throw new RegistrationError(`name "${name}" already registered as a ${found}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Filter helpers — used by the runtime adapter when injecting class /
// namespace members. Live here because they're closely tied to the
// registration record types.
// ---------------------------------------------------------------------------

/**
 * Apply the standard `include`/`exclude` filtering rule to a member name.
 *
 * - `exclude` always wins (matches agex-py's default `_*` exclusion of
 *   underscore-prefixed members).
 * - `include` defaults to "everything not excluded".
 * - Filter values can be a single glob (`'foo*'`), an array of globs, or
 *   a predicate function.
 *
 * Globs are simple shell-style: `*` matches any chars (no slashes), `?`
 * matches one char. No bracket expressions for v1.
 */
export function memberAllowed(
  name: string,
  include: MemberFilter | undefined,
  exclude: MemberFilter | undefined,
): boolean {
  if (exclude !== undefined && matchesFilter(name, exclude)) return false
  if (include === undefined) return true
  return matchesFilter(name, include)
}

function matchesFilter(name: string, filter: MemberFilter): boolean {
  if (typeof filter === 'function') return filter(name)
  if (typeof filter === 'string') return termishGlobMatch(filter, name)
  for (const f of filter) {
    if (termishGlobMatch(f, name)) return true
  }
  return false
}

/** Strip keys whose value is `undefined`. With `exactOptionalPropertyTypes`,
 *  setting an optional field to literal `undefined` is a type error;
 *  callers can pass undefineds and we drop them here. */
function omitUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
}
