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

// Pull glob matching from @agex-ts/termish's narrow `./glob` sub-path
// rather than the package main — main bundles the shell builtins
// (notably the archive command pulling fflate, which uses
// `createRequire('module')` and trips Vite's browser-externals
// shim). The sub-path stays browser-safe so anyone importing
// `agex-ts/policy` from a Worker / browser context can do so
// without dragging the shell layer.
import { globMatch as termishGlobMatch } from '@agex-ts/termish/glob'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { RegistrationError, SchemaError } from './errors'
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
  readonly wantsContext?: boolean
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

/** Identifier-shape regex for names that become JS bindings.
 *
 *  Used for host-bound fn / cls / namespace registrations (which land
 *  as top-level scope bindings AND as AsyncFunction parameter names)
 *  and for terminal command names (CLI tokens; convention favors
 *  identifier-shape). Both use cases require the name to be a valid
 *  JS identifier — no hyphens, no scopes.
 *
 *  Names that DON'T become JS bindings — URL-shipped registration
 *  specifiers, skill names (which become VFS path segments at
 *  `/skills/<name>/SKILL.md`) — use `RELAXED_NAME_RE` instead. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Relaxed name shape for non-binding-producing registrations.
 *
 *  Two use cases share these rules:
 *  - **URL-shipped fn / cls / namespace**: the name is an npm-style
 *    import specifier compared verbatim against the agent's
 *    `import { x } from '<name>'`. Allows `apache-arrow`,
 *    `@scope/pkg`, `pkg/sub`, etc. — exactly as the agent's training
 *    data suggests.
 *  - **Skills**: the name becomes a VFS path segment at
 *    `/skills/<name>/SKILL.md`. Path segments accept hyphens
 *    (`interactive-app`), dots (`v1.docs`), etc. — they're not JS
 *    identifiers. Mirrors agex-py's kebab-case skill convention.
 *
 *  The bounds are intentionally loose: any non-empty string with no
 *  whitespace and no control characters. Whitespace would break import
 *  parsers / VFS path segments; control chars in names are always
 *  typos. */
const RELAXED_NAME_RE = /^[^\s\p{Cc}]+$/u

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
    if (opts.url !== undefined && opts.wantsContext === true) {
      // `wantsContext` injects a host-realm `ctx` argument at the
      // host-side dispatch site. URL-shipped fns are called natively
      // in the worker realm with no host-side hook, so the flag
      // would silently no-op; reject loudly instead.
      throw new RegistrationError(
        `fn '${name}': wantsContext can't be combined with { url } — URL-shipped fns are called natively in the worker realm; host-side ctx injection has no hook there.`,
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
    // Skill names become VFS path segments at `/skills/<name>/SKILL.md`,
    // not JS identifiers — accept the path-friendly shapes
    // (`interactive-app`, `data-export`, etc.) the agex-py side uses by
    // convention. See `RELAXED_NAME_RE` for the rules.
    this.#assertNameValid(name, 'skill', true)
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

  /** Hash-style fingerprint of the current policy, for invalidating
   *  cached primer / dependency snapshots.
   *
   *  Covers the agent-visible *configuration* of each registration —
   *  name, description, filters, url/export, flags — not just the set
   *  of names. Registration is add-only (re-registering a name throws,
   *  and nothing removes), so a name-and-count scheme would already
   *  catch every mutation of a single builder over time. The reason to
   *  hash config is comparison *across* policies: two agents
   *  registering the same names with different descriptions render
   *  different primers, and `Agent.fingerprint` is public precisely so
   *  a host can decide whether a cached snapshot still applies.
   *
   *  Live host values (`fn`, `cls`, `target`, terminal handlers,
   *  `paramsSchema`) are treated as **opaque** — a presence marker,
   *  never traversed. See `OPAQUE_FIELDS` for why that's required and
   *  not merely a simplification. The consequence: two policies whose
   *  configs match but whose function bodies or target contents differ
   *  fingerprint identically. That's the intended granularity — the
   *  rendered surface is names and descriptions, which config already
   *  pins.
   *
   *  Pure with respect to the policy: repeated calls with no
   *  intervening registration always return the same string. */
  fingerprint(): string {
    const parts: string[] = []
    for (const m of [this.#fns, this.#classes, this.#namespaces, this.#skills, this.#terminals]) {
      for (const k of [...m.keys()].sort()) {
        parts.push(`${k}:${stableConfig(m.get(k))}`)
      }
    }
    return parts.join('|')
  }

  // -- Internal -----------------------------------------------------------

  #assertNameValid(name: string, kind: string, relaxed = false): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new RegistrationError(`${kind}: name must be a non-empty string`)
    }
    if (relaxed) {
      // Relaxed names cover URL-shipped registration specifiers
      // (`apache-arrow`, `@scope/pkg`) and skill names (`interactive-
      // app`, used as VFS path segments at `/skills/<name>/SKILL.md`).
      // Neither becomes a JS identifier; both need to accept the
      // hyphenated / scoped / dotted shapes their respective
      // ecosystems use. Reject only whitespace and control chars,
      // which would break import parsers / path lookups.
      if (!RELAXED_NAME_RE.test(name)) {
        throw new RegistrationError(
          `${kind} '${name}': name must be non-empty with no whitespace or control characters. Accepts hyphens, scopes, subpaths, and dots — e.g. 'apache-arrow', '@scope/pkg', 'interactive-app'.`,
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

/**
 * Wrap a host-bound fn so its `paramsSchema` validates the agent's
 * call args before the underlying function runs.
 *
 * Both runtimes call this at their host-side dispatch site — the eval
 * runtime when injecting the binding, the worker runtime when servicing
 * an RPC. Enforcement has to live host-side: `paramsSchema` is a live
 * validator object, and only registration names cross to the worker
 * realm (see `buildConfigure`). That's the same reason `registerFn`
 * rejects `paramsSchema` combined with `{ url }` — a URL-shipped fn is
 * called natively in the worker with no host hook to validate at.
 *
 * Returns `fn` unchanged when no schema is registered: zero overhead,
 * and — importantly — zero change to call semantics for the common
 * case. Wrapping unconditionally would turn every registered sync fn
 * into a promise-returning one under the eval runtime, where bindings
 * are injected raw rather than bridged.
 *
 * For the same reason the wrapper stays synchronous when the validator
 * answers synchronously (Zod, Valibot and ArkType all do for non-async
 * schemas). Only a genuinely async validator forces an async call.
 *
 * The args array is the validation subject, so `paramsSchema` describes
 * the whole parameter list — a tuple schema (`z.tuple([...])`) is the
 * natural shape. A validator that returns a transformed array (coercion)
 * has its output passed through to the fn; a non-array return is
 * ignored in favor of the original args, since spreading it would
 * silently mangle the call.
 */
export function enforceParamsSchema<F extends (...args: never[]) => unknown>(
  fn: F,
  schema: StandardSchemaV1 | undefined,
  fnName: string,
): F {
  if (schema === undefined) return fn
  const target = fn as unknown as (...a: unknown[]) => unknown
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const result = schema['~standard'].validate(args)
    if (isThenable(result)) {
      return result.then((settled) => target.apply(this, applyParams(settled, args, fnName)))
    }
    return target.apply(this, applyParams(result, args, fnName))
  }
  return wrapped as unknown as F
}

function isThenable<T>(v: T | Promise<T>): v is Promise<T> {
  return typeof (v as { then?: unknown } | null)?.then === 'function'
}

/** Throw on validation issues, else pick the arg list to call with. */
function applyParams(
  result: StandardSchemaV1.Result<unknown>,
  args: readonly unknown[],
  fnName: string,
): unknown[] {
  if (result.issues !== undefined) {
    const issues = result.issues.map((i) => ({
      path: (i.path ?? []).map((p) =>
        typeof p === 'object' && p !== null ? (p.key as PropertyKey) : p,
      ),
      message: i.message,
    }))
    throw new SchemaError(
      `fn '${fnName}': params validation failed: ${issues.map((i) => i.message).join('; ')}`,
      issues,
    )
  }
  const value = (result as { value: unknown }).value
  return Array.isArray(value) ? (value as unknown[]) : [...args]
}

function matchesFilter(name: string, filter: MemberFilter): boolean {
  if (typeof filter === 'function') return filter(name)
  if (typeof filter === 'string') return termishGlobMatch(filter, name)
  for (const f of filter) {
    if (termishGlobMatch(f, name)) return true
  }
  return false
}

/** Serialize a registration record's config for `fingerprint()`.
 *
 *  Key order is normalized so an equivalent record always produces the
 *  same string. Non-serializable values (functions, class
 *  constructors, namespace targets, schemas) collapse to a presence
 *  marker — see `fingerprint()` for why that's the right granularity.
 *  A `MemberFilter` may itself be a predicate function, which lands in
 *  the same bucket. */
function stableConfig(reg: object | undefined): string {
  if (reg === undefined) return '∅'
  const parts: string[] = []
  for (const key of Object.keys(reg).sort()) {
    const value = (reg as Record<string, unknown>)[key]
    parts.push(`${key}=${OPAQUE_FIELDS.has(key) ? presence(value) : stableValue(value)}`)
  }
  return parts.join(',')
}

/** Registration fields holding a live host value the embedder handed
 *  us: the fn / class / namespace target / terminal handler, and the
 *  `paramsSchema` validator. These are reduced to a presence marker,
 *  never traversed.
 *
 *  Traversing them would be wrong three ways. A namespace target is an
 *  arbitrary user object, so it can be cyclic (`ns.self = ns`) —
 *  recursion would blow the stack on a plain property read. Reading
 *  its properties invokes getters, giving `fingerprint()` side effects
 *  and a dependence on live values. And because it reflects mutable
 *  runtime state, two calls with no registration change could disagree
 *  — which defeats the entire point of a fingerprint. What the primer
 *  renders is the member *names*, and those are already pinned by the
 *  registration's own config (`include` / `exclude` / `configure`). */
const OPAQUE_FIELDS = new Set(['fn', 'cls', 'target', 'handler', 'paramsSchema'])

function presence(value: unknown): string {
  return value === undefined ? 'absent' : 'present'
}

/** Serialize a *config* value — strings, booleans, numbers, member
 *  filters, and the small `configure` record. Never reached for the
 *  opaque fields above, so recursion depth is bounded by our own
 *  registration types rather than by embedder data. A `MemberFilter`
 *  may itself be a predicate function, which collapses to `fn`. */
function stableValue(value: unknown): string {
  if (typeof value === 'function') return 'fn'
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (typeof value === 'object') {
    const inner = Object.keys(value as object)
      .sort()
      .map((k) => `${k}=${stableValue((value as Record<string, unknown>)[k])}`)
    return `{${inner.join(',')}}`
  }
  return String(value)
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
