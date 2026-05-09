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

// Pull glob matching from termish-ts's narrow `./glob` sub-path
// rather than the package main — main bundles the shell builtins
// (notably the archive command pulling fflate, which uses
// `createRequire('module')` and trips Vite's browser-externals
// shim). The sub-path stays browser-safe so anyone importing
// `agex-ts/policy` from a Worker / browser context can do so
// without dragging the shell layer.
import { globMatch as termishGlobMatch } from 'termish-ts/glob'
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
  readonly fn?: RegisteredFn['fn']
  readonly url?: string
  readonly export?: string
  readonly paramsSchema?: RegisteredFn['paramsSchema']
}

interface ClsRegistration extends RegistrationCommon {
  readonly cls?: RegisteredCls['cls']
  readonly url?: string
  readonly export?: string
  readonly constructable?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
}

interface NsRegistration extends RegistrationCommon {
  readonly target?: object
  readonly url?: string
  readonly export?: string
  readonly recursive?: boolean
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
}

interface TerminalRegistration extends RegistrationCommon {
  readonly handler: TerminalCommandHandler
}

/** Identifier-shape regex for host-bound registration names.
 *
 *  Host-bound names land as top-level scope bindings AND as
 *  AsyncFunction parameter names, so they must be valid JS
 *  identifiers (no hyphens, no scopes). URL-shipped names use
 *  `URL_NAME_RE` (much more permissive) — they're only ever import
 *  specifiers compared via string equality, not JS identifiers. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Permitted shape for URL-shipped registration names — npm-style
 *  import specifiers. Allows hyphens, scopes (`@scope/pkg`),
 *  subpaths (`pkg/sub`), dots, etc. The agent's import statement is
 *  matched against this string verbatim, so `apache-arrow` registers
 *  fine and the agent writes `import { Table } from 'apache-arrow'`
 *  exactly as their training data suggests.
 *
 *  The bounds are intentionally loose: any non-empty string with no
 *  whitespace and no control characters. Agent imports can't contain
 *  whitespace anyway (it'd break the parser), and control chars in
 *  registration names are always typos. */
const URL_NAME_RE = /^[^\s\p{Cc}]+$/u

export class PolicyBuilder {
  readonly #fns = new Map<string, RegisteredFn>()
  readonly #classes = new Map<string, RegisteredCls>()
  readonly #namespaces = new Map<string, RegisteredNs>()
  readonly #skills = new Map<string, RegisteredSkill>()
  readonly #terminals = new Map<string, RegisteredTerminal>()

  // -- Mutators -----------------------------------------------------------

  registerFn(name: string, opts: FnRegistration): void {
    this.#assertNameValid(name, 'fn', opts.url !== undefined)
    this.#assertNameAvailable(name)
    this.#assertHostXorUrl(name, 'fn', opts.fn !== undefined, opts.url)
    if (opts.url !== undefined && opts.paramsSchema !== undefined) {
      // `paramsSchema` is enforced by the host-side agent loop
      // before calling a registered fn — it has no hook into a
      // worker-realm callable. Combining the two would silently
      // ignore the schema; reject loudly instead.
      throw new RegistrationError(
        `fn '${name}': paramsSchema can't be combined with { url } — URL-shipped fns are called natively in the worker realm where the host-side schema check doesn't apply. If you need validation, fold it into the imported function.`,
      )
    }
    this.#fns.set(name, omitUndefined({ kind: 'fn', name, ...opts }) as RegisteredFn)
  }

  registerCls(name: string, opts: ClsRegistration): void {
    this.#assertNameValid(name, 'cls', opts.url !== undefined)
    this.#assertNameAvailable(name)
    this.#assertHostXorUrl(name, 'cls', opts.cls !== undefined, opts.url)
    if (opts.url !== undefined) {
      this.#assertNoFiltersWithUrl(name, 'cls', opts)
      if (opts.constructable === false) {
        // `constructable: false` only manifests as a primer hint
        // ("use as a type / static surface only") — it's not
        // enforced anywhere. With a URL-shipped class the worker
        // imports the real constructor and the agent can `new` it
        // regardless of what the primer says. Reject the
        // combination so the embedder doesn't ship a misleading
        // primer.
        throw new RegistrationError(
          `cls '${name}': constructable: false can't be combined with { url } — the URL-shipped class is constructable in the worker realm regardless. Pre-wrap the export in a non-constructable facade if you want the agent locked out.`,
        )
      }
    }
    this.#classes.set(name, omitUndefined({ kind: 'cls', name, ...opts }) as RegisteredCls)
  }

  registerNamespace(name: string, opts: NsRegistration): void {
    this.#assertNameValid(name, 'namespace', opts.url !== undefined)
    this.#assertNameAvailable(name)
    this.#assertHostXorUrl(name, 'namespace', opts.target !== undefined, opts.url)
    if (opts.url !== undefined) {
      this.#assertNoFiltersWithUrl(name, 'namespace', opts)
    }
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

  #assertNameValid(name: string, kind: string, urlShipped = false): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new RegistrationError(`${kind}: name must be a non-empty string`)
    }
    if (urlShipped) {
      // URL-shipped names are import specifiers (string-equality
      // matched against `import { ... } from '<name>'`), never JS
      // identifiers. Allow npm-style specifiers (`apache-arrow`,
      // `@scope/pkg`, `pkg/sub`) — reject only whitespace and
      // control chars, which would break the import parser anyway.
      if (!URL_NAME_RE.test(name)) {
        throw new RegistrationError(
          `${kind} '${name}': URL-shipped name must be a non-empty import specifier (no whitespace, no control characters). For host-bound registrations the name must additionally be a valid JS identifier; URL-shipped accepts npm-style specifiers like 'apache-arrow' or '@scope/pkg'.`,
        )
      }
      return
    }
    if (!NAME_RE.test(name)) {
      throw new RegistrationError(
        `${kind} ${name}: name must match /^[A-Za-z_][A-Za-z0-9_]*$/ (valid JS identifier)`,
      )
    }
  }

  /** Enforce mutual exclusivity between host-bound and URL-shipped
   *  forms. Exactly one must be present — registering an fn / cls /
   *  namespace with both a live value and a `url` (or with neither)
   *  is a programming error. */
  #assertHostXorUrl(
    name: string,
    kind: 'fn' | 'cls' | 'namespace',
    hasHost: boolean,
    url: string | undefined,
  ): void {
    const hasUrl = url !== undefined
    if (hasHost && hasUrl) {
      throw new RegistrationError(
        `${kind} '${name}': pass either the live value or { url, export? }, not both`,
      )
    }
    if (!hasHost && !hasUrl) {
      throw new RegistrationError(
        `${kind} '${name}': missing the registered value (pass a function / class / object, or a { url, export? } spec)`,
      )
    }
    if (hasUrl && url.length === 0) {
      throw new RegistrationError(`${kind} '${name}': url must be a non-empty string`)
    }
  }

  /** Per-method visibility filters (`include` / `exclude` /
   *  `configure`) only make sense for host-bound registrations.
   *  URL-shipped modules ship into the worker realm whole — there
   *  is no per-export gating point on the host side. Ban the
   *  combination at registration time so the embedder gets a
   *  clear error instead of silently ignored options. */
  #assertNoFiltersWithUrl(
    name: string,
    kind: 'cls' | 'namespace',
    opts: { include?: MemberFilter; exclude?: MemberFilter; configure?: object },
  ): void {
    const offending: string[] = []
    if (opts.include !== undefined) offending.push('include')
    if (opts.exclude !== undefined) offending.push('exclude')
    if (opts.configure !== undefined) offending.push('configure')
    if (offending.length > 0) {
      throw new RegistrationError(
        `${kind} '${name}': ${offending.join(' / ')} can't be combined with { url } — URL-shipped registrations are exposed whole. Pre-wrap the export in a thinner module if you need a narrower surface.`,
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
 * - `exclude` always wins.
 * - `include` defaults to "everything not excluded".
 * - Filter values can be a single glob (`'foo*'`), an array of globs, or
 *   a predicate function.
 *
 * Globs are simple shell-style: `*` matches any chars (no slashes), `?`
 * matches one char. No bracket expressions for v1.
 *
 * No default `_*` exclusion: TypeScript has `#field` for true privacy
 * and `private` as a compile-time hint, so an underscore prefix carries
 * no special meaning here. If a registered target intentionally exposes
 * `_helper`, the agent sees it. Embedders who want the Python-style
 * convention can pass `exclude: '_*'` explicitly.
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
