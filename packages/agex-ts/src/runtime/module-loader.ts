/**
 * Module loader bridging the agent's VFS to userspace JS execution.
 *
 * The JS engine has no idea our `VirtualFileSystem` exists — when
 * agent code says `import { x } from '/helpers/foo'`, the engine has
 * no plug point that lets us route the path to our in-memory FS.
 *
 * The "obvious" fix — rewrite `import` statements into dynamic
 * `import()` of `data:application/javascript;base64,...` URLs — is
 * cleaner because it gives us real ESM semantics. But Node's
 * `new AsyncFunction(...)` has no module context attached, so calls
 * to `import()` from inside it throw "A dynamic import callback was
 * not specified." Working around it requires Node 21+ (`vm.compileFunction`
 * + `importModuleDynamically`) or Node 22.5+ (`vm.constants.USE_MAIN_
 * CONTEXT_DEFAULT_LOADER`). Browser-side it'd be fine, but we want one
 * implementation across both.
 *
 * **Strategy:** userspace ESM emulation. Each helper file becomes an
 * async function that captures its `export`s into an object; user
 * `import` statements get rewritten to destructure from a pre-loaded
 * module map. Works in any JS environment (browser, Node 20+, edge
 * runtimes, Workers).
 *
 * **Trade-offs vs real ESM (data: URLs in a Worker realm):**
 *   - ✅ Works everywhere, no Node version gates
 *   - ✅ No engine module context required
 *   - ❌ No live bindings (helpers can't mutate exports after load —
 *     not a pattern agents use)
 *   - ❌ No top-level `await` coordination across helper graph
 *     (each helper is a single async function; module-evaluation
 *     ordering is straightforward request-order)
 *   - ❌ Re-exports limited (`export { x } from '...'` needs to be
 *     resolved by us; `export * from '...'` not yet supported)
 *
 * **Stack traces:** every helper script gets a `//# sourceURL=`
 * pragma so engine-reported file names use the agent's original
 * VFS path. Line/column numbers preserved by `ts-blank-space`
 * (whitespace substitution, no AST rewriting).
 *
 * **Path resolution:**
 *   - Absolute (`/helpers/foo`): VFS-relative; tried with `.ts`,
 *     `.js`, `.mjs` extensions if the exact name doesn't exist.
 *   - Relative (`./other`, `../shared/x`): resolved relative to the
 *     containing helper's directory.
 *   - Anything else (`react`, `node:fs`, `https://...`): not handled
 *     here. The user code's import is left unchanged, which will
 *     fail at execution time (no engine module loader). evalRuntime
 *     is documented as no-isolation; production sandboxing belongs
 *     to runtime-worker.
 *
 * **Cycles:** detected during recursive resolution and rejected
 * with a clear error. Real ESM allows synchronous cycles; userspace
 * emulation can't easily replicate the partial-evaluation semantics,
 * so we don't try.
 */

import tsBlankSpace from 'ts-blank-space'
import type { VirtualFileSystem } from '../types'

/** Result of preprocessing a single user `ts_action` body. */
export interface PreparedScript {
  /** The script with its `import` statements replaced by lookups
   *  into the injected `__modules` map. */
  readonly code: string
  /** Module map to inject as the `__modules` parameter. Maps
   *  resolved VFS path → exports object. */
  readonly modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

/** Top-level JS/TS imports we recognize and rewrite. */
interface ImportStatement {
  /** Char-offset start in the source. */
  readonly start: number
  /** Char-offset end (exclusive) in the source. */
  readonly end: number
  /** The path as written between quotes. */
  readonly path: string
  /** Parsed clause: what the import binds. */
  readonly binding: ImportBinding
  /** True when this is `export ... from` rather than `import` —
   *  treated as a graph edge for path resolution but skipped on
   *  the user-script rewrite (re-exports aren't valid in a script
   *  context). */
  readonly isReexport: boolean
}

type ImportBinding =
  | { kind: 'named'; entries: ReadonlyArray<{ source: string; local: string }> }
  | { kind: 'namespace'; local: string }
  | { kind: 'default'; local: string }
  | {
      kind: 'mixed'
      defaultLocal: string
      entries: ReadonlyArray<{ source: string; local: string }>
    }
  | { kind: 'sideEffect' }

/** Per-call state — caches loaded helpers and tracks the
 *  in-progress set for cycle detection. */
interface LoadContext {
  /** Resolved VFS path → exports object. */
  readonly cache: Map<string, Readonly<Record<string, unknown>>>
  /** Resolved paths currently being loaded (for cycle detection). */
  readonly seen: Set<string>
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Rewrite `import` statements in user code to `const { ... } =
 *  __modules['/path']` lookups. Helpers (and helper-of-helpers,
 *  transitively) are pre-loaded; the returned `modules` map should
 *  be passed as the `__modules` parameter when invoking the
 *  resulting AsyncFunction. */
export async function prepareScript(
  source: string,
  fs: VirtualFileSystem,
): Promise<PreparedScript> {
  const imports = parseImports(source)
  if (imports.length === 0) return { code: source, modules: {} }

  const ctx: LoadContext = { cache: new Map(), seen: new Set() }
  for (const imp of imports) {
    if (!isVfsPath(imp.path)) continue
    await loadHelper(imp.path, '/', fs, ctx)
  }

  // Rewrite from end to start so earlier offsets don't shift.
  let out = source
  for (const imp of [...imports].reverse()) {
    if (!isVfsPath(imp.path)) continue
    if (imp.isReexport) {
      // Re-exports aren't valid in script context; strip them.
      out = `${out.slice(0, imp.start)}/* re-export skipped */${out.slice(imp.end)}`
      continue
    }
    const resolved = resolveVfsPath(imp.path, '/')
    if (!ctx.cache.has(resolved)) continue
    const replacement = rewriteAsLookup(imp.binding, resolved)
    out = out.slice(0, imp.start) + replacement + out.slice(imp.end)
  }
  // Convert the cache to a plain object for injection.
  const modules: Record<string, Readonly<Record<string, unknown>>> = {}
  for (const [k, v] of ctx.cache) modules[k] = v
  return { code: out, modules }
}

// ---------------------------------------------------------------------------
// Helper loading
// ---------------------------------------------------------------------------

async function loadHelper(
  importPath: string,
  baseDir: string,
  fs: VirtualFileSystem,
  ctx: LoadContext,
): Promise<Readonly<Record<string, unknown>>> {
  const resolved = resolveVfsPath(importPath, baseDir)
  const cached = ctx.cache.get(resolved)
  if (cached !== undefined) return cached
  if (ctx.seen.has(resolved)) {
    throw new Error(
      `module loader: cyclic helper import — '${resolved}' is already being loaded. Helper cycles are unsupported; refactor the shared bits into a third file.`,
    )
  }
  ctx.seen.add(resolved)

  const sourcePath = await findFile(resolved, fs)
  const bytes = await fs.read(sourcePath)
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const stripped = tsBlankSpace(raw)

  // Recursively load this helper's own imports first so they're
  // available when its body executes.
  const subImports = parseImports(stripped)
  const dirOfHelper = dirname(sourcePath)
  for (const sub of subImports) {
    if (!isVfsPath(sub.path) && !sub.path.startsWith('.')) continue
    await loadHelper(sub.path, dirOfHelper, fs, ctx)
  }

  // Rewrite the helper into an async function that:
  //   - replaces `export` declarations with plain ones + `__exports.X = X`
  //   - replaces `import` statements with `const ... = __modules['/path']`
  //   - returns `__exports` at the end
  const exports = await runHelper(stripped, sourcePath, dirOfHelper, ctx)
  ctx.cache.set(resolved, exports)
  ctx.cache.set(sourcePath, exports)
  ctx.seen.delete(resolved)
  return exports
}

async function runHelper(
  stripped: string,
  sourcePath: string,
  dirOfHelper: string,
  ctx: LoadContext,
): Promise<Readonly<Record<string, unknown>>> {
  // Pass 1: rewrite re-exports first (`export { x } from '/path'`,
  // `export * from '/path'`). They become `__exports.X = __modules['/path'].X`
  // assignments. Has to happen BEFORE rewriteHelperExports so the
  // remaining `export` keyword scan doesn't trip on them.
  const reexported = rewriteHelperReexports(stripped, dirOfHelper)
  // Pass 2: rewrite `export ...` declarations, tracking exported
  // names for the trailing assignment block.
  const { code, exportNames } = rewriteHelperExports(reexported)
  // Pass 3: rewrite plain `import` statements (non-reexport) into
  // lookups against the pre-loaded module cache.
  const imports = parseImports(code)
  let body = code
  for (const imp of [...imports].reverse()) {
    if (imp.isReexport) continue // already handled in pass 1
    if (!isVfsPath(imp.path) && !imp.path.startsWith('.')) continue
    const resolved = resolveVfsPath(imp.path, dirOfHelper)
    const replacement = rewriteAsLookup(imp.binding, resolved)
    body = body.slice(0, imp.start) + replacement + body.slice(imp.end)
  }
  const exportAssignments = exportNames
    .map((n) => `__exports[${JSON.stringify(n)}] = ${n};`)
    .join('\n')
  const wrapped = `${body}\n${exportAssignments}\nreturn __exports;\n//# sourceURL=${sourcePath}\n`
  const fn = new AsyncFunction('__exports', '__modules', wrapped)
  const exports: Record<string, unknown> = {}
  const modules: Record<string, unknown> = {}
  for (const [k, v] of ctx.cache) modules[k] = v
  await fn(exports, modules)
  return exports
}

// ---------------------------------------------------------------------------
// Export-statement rewriting
// ---------------------------------------------------------------------------

/** Rewrite `export { a, b } from '/path'` and `export * from '/path'`
 *  into `__exports.X = __modules['/path'].X` assignments. The
 *  pre-loaded module cache (assigned to `__modules` in the helper's
 *  scope) holds the source helper's exports. Must run BEFORE the
 *  scan for plain `export` declarations so the parser doesn't trip
 *  on the re-export's `export` keyword first. */
function rewriteHelperReexports(code: string, dirOfHelper: string): string {
  let out = code
  // export { a, b as c } from '/path'
  out = out.replace(
    /(^|[\n;])[ \t]*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"][ \t]*;?[ \t]*(?=$|\n)/gm,
    (_m, lead: string, inside: string, path: string) => {
      const resolved =
        isVfsPath(path) || path.startsWith('.') ? resolveVfsPath(path, dirOfHelper) : path
      const key = JSON.stringify(resolved)
      const lines: string[] = []
      for (const part of inside.split(',')) {
        const t = part.trim()
        if (t.length === 0) continue
        const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        const sourceName = aliased !== null ? (aliased[1] as string) : t
        const exportName = aliased !== null ? (aliased[2] as string) : t
        lines.push(
          `__exports[${JSON.stringify(exportName)}] = __modules[${key}][${JSON.stringify(sourceName)}];`,
        )
      }
      return `${lead}${lines.join('\n')}`
    },
  )
  // export * from '/path' — copy all exports onto __exports
  out = out.replace(
    /(^|[\n;])[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"][ \t]*;?[ \t]*(?=$|\n)/gm,
    (_m, lead: string, path: string) => {
      const resolved =
        isVfsPath(path) || path.startsWith('.') ? resolveVfsPath(path, dirOfHelper) : path
      return `${lead}Object.assign(__exports, __modules[${JSON.stringify(resolved)}]);`
    },
  )
  return out
}

/** Rewrite `export ...` declarations to plain ones; track exported
 *  names for the trailing `__exports.X = X` block. */
function rewriteHelperExports(code: string): { code: string; exportNames: string[] } {
  const exportNames: string[] = []
  let out = code

  // export default <expr>
  // Tolerates `export default` after a leading `;` (single-line
  // helpers like `const x = 1; export default x` are common).
  // Captures up to the next `;`, newline, or end-of-string. The
  // inline rewrite directly assigns to __exports.default — we
  // don't add 'default' to exportNames (which would generate
  // `__exports['default'] = default;` in the trailing block,
  // and `default` is a reserved word).
  out = out.replace(
    /(^|[\n;])[ \t]*export\s+default\s+([\s\S]*?)(?=[\n;]|$)/gm,
    (_m, lead: string, expr: string) => `${lead}__exports.default = ${expr.trim()}`,
  )

  // export function NAME / export async function NAME / export class NAME.
  // Tolerates `export` after `;` (single-line form).
  out = out.replace(
    /(^|[\n;])[ \t]*export\s+(async\s+function\b|function\b|class\b)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, lead: string, kind: string, name: string) => {
      if (!exportNames.includes(name)) exportNames.push(name)
      return `${lead}${kind} ${name}`
    },
  )

  // export const NAME = ... / export let NAME / export var NAME.
  out = out.replace(
    /(^|[\n;])[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, lead: string, kind: string, name: string) => {
      if (!exportNames.includes(name)) exportNames.push(name)
      return `${lead}${kind} ${name}`
    },
  )

  // export { a, b as c } — track names + aliases.
  out = out.replace(
    /(^|[\n;])[ \t]*export\s*\{([^}]*)\}[ \t]*;?[ \t]*(?=$|\n)/gm,
    (_m, lead: string, inside: string) => {
      const lines: string[] = []
      for (const part of inside.split(',')) {
        const t = part.trim()
        if (t.length === 0) continue
        const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        if (aliased !== null) {
          const local = aliased[1] as string
          const exported = aliased[2] as string
          if (!exportNames.includes(exported)) exportNames.push(exported)
          lines.push(`__exports[${JSON.stringify(exported)}] = ${local};`)
        } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
          if (!exportNames.includes(t)) exportNames.push(t)
          // Will be assigned by the trailing __exports block.
        }
      }
      return `${lead}${lines.join('\n')}`
    },
  )

  return { code: out, exportNames }
}

// ---------------------------------------------------------------------------
// Import-statement parsing + rewriting
// ---------------------------------------------------------------------------

/** Find top-level static module-graph edges in the source — both
 *  `import` statements and `export ... from` re-exports. */
export function parseImports(source: string): ImportStatement[] {
  const out: ImportStatement[] = []
  const importRe =
    /^[ \t]*import\b((?:[\s\S](?!^[ \t]*(?:import|export)\b))*?)['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm
  for (const m of source.matchAll(importRe)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    const middle = (m[1] ?? '').trim()
    const path = m[2] ?? ''
    out.push({
      start,
      end,
      path,
      binding: parseClause(middle),
      isReexport: false,
    })
  }
  const reexportRe =
    /^[ \t]*export\b((?:[\s\S](?!^[ \t]*(?:import|export)\b))*?)\bfrom\b[\s]*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm
  for (const m of source.matchAll(reexportRe)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    const path = m[2] ?? ''
    out.push({
      start,
      end,
      path,
      binding: { kind: 'sideEffect' },
      isReexport: true,
    })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

function parseClause(clause: string): ImportBinding {
  const trimmed = clause.replace(/from\s*$/, '').trim()
  if (trimmed.length === 0) return { kind: 'sideEffect' }
  const ns = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)
  if (ns !== null) return { kind: 'namespace', local: ns[1] as string }
  const mixed = trimmed.match(/^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*)\}$/)
  if (mixed !== null) {
    return {
      kind: 'mixed',
      defaultLocal: mixed[1] as string,
      entries: parseNamedEntries(mixed[2] as string),
    }
  }
  const named = trimmed.match(/^\{([\s\S]*)\}$/)
  if (named !== null) {
    return { kind: 'named', entries: parseNamedEntries(named[1] as string) }
  }
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return { kind: 'default', local: trimmed }
  }
  return { kind: 'sideEffect' }
}

function parseNamedEntries(inside: string): ReadonlyArray<{ source: string; local: string }> {
  const entries: Array<{ source: string; local: string }> = []
  for (const part of inside.split(',')) {
    const t = part.trim()
    if (t.length === 0) continue
    const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
    if (aliased !== null) {
      entries.push({ source: aliased[1] as string, local: aliased[2] as string })
    } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
      entries.push({ source: t, local: t })
    }
  }
  return entries
}

/** Rewrite `import { ... } from '/path'` as a destructuring lookup
 *  against the injected `__modules` map. */
function rewriteAsLookup(binding: ImportBinding, resolvedPath: string): string {
  const key = JSON.stringify(resolvedPath)
  switch (binding.kind) {
    case 'sideEffect':
      // No bindings to extract; the helper has already been loaded.
      return `/* import ${resolvedPath} */`
    case 'namespace':
      return `const ${binding.local} = __modules[${key}];`
    case 'default':
      return `const { default: ${binding.local} } = __modules[${key}];`
    case 'named': {
      if (binding.entries.length === 0) return `/* import ${resolvedPath} */`
      const dest = binding.entries
        .map((e) => (e.source === e.local ? e.source : `${e.source}: ${e.local}`))
        .join(', ')
      return `const { ${dest} } = __modules[${key}];`
    }
    case 'mixed': {
      const named = binding.entries
        .map((e) => (e.source === e.local ? e.source : `${e.source}: ${e.local}`))
        .join(', ')
      return `const { default: ${binding.defaultLocal}, ${named} } = __modules[${key}];`
    }
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function isVfsPath(p: string): boolean {
  return p.startsWith('/')
}

function resolveVfsPath(path: string, base: string): string {
  if (path.startsWith('/')) return normalize(path)
  const baseDir = base.endsWith('/') ? base : `${base}/`
  return normalize(`${baseDir}${path}`)
}

function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return `/${out.join('/')}`
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return '/'
  return path.slice(0, slash)
}

async function findFile(resolved: string, fs: VirtualFileSystem): Promise<string> {
  if (await fs.exists(resolved)) return resolved
  for (const ext of ['.ts', '.js', '.mjs']) {
    const candidate = `${resolved}${ext}`
    if (await fs.exists(candidate)) return candidate
  }
  throw new Error(
    `module loader: helper not found in VFS — '${resolved}' (also tried .ts, .js, .mjs extensions)`,
  )
}
