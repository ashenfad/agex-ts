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
 *   - ✅ Full re-export shapes supported: `export { x }`,
 *     `export { x as y }`, `export * from '...'`, `export * as ns
 *     from '...'`, default re-exports
 *   - ✅ Top-level `await` works inside helpers — each helper is
 *     an async function we `await` before its dependents load,
 *     so `export const data = await fetch(...)` resolves correctly
 *     across the import graph
 *   - ❌ No live bindings — `export let x = 0` followed by mutation
 *     in the helper isn't visible to importers (we copy values at
 *     load time). Workaround: wrap mutable state in an object so
 *     it's shared by reference. Rare in agent-written helpers (they
 *     trend toward pure functions and constants).
 *   - ❌ No `import.meta` or import attributes — agents don't use
 *     these.
 *   - ❌ Cyclic helper imports throw a clear error rather than
 *     supporting real ESM's temporal-dead-zone partial-binding
 *     semantics. Agents don't write cyclic helpers in practice.
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
 *
 * **Regex-vs-real-parser caveat:** the import/export rewriting is
 * regex-based, not AST-based. This is fine in practice because
 * agent-written helpers are short, idiomatic, and don't contain
 * pathological cases — but a few fragile spots exist:
 *
 *   - An `import` or `export` statement appearing inside a string
 *     literal or comment can fool the matcher. (`const s = "import
 *     { x } from '/p'"` would attempt to load `/p` from the VFS.)
 *   - Multi-line `export default` expressions truncate at the
 *     first newline. Single-line forms — including IIFEs and
 *     inline objects — work fine.
 *   - Re-exports from non-VFS paths (`export { x } from 'react'`)
 *     are rewritten to `__exports.X = __modules['react'].X`,
 *     which throws at runtime since `react` isn't in the modules
 *     map. Helpers that re-export from npm-style packages aren't
 *     supported.
 *
 * If/when these bite real agent code, the answer is to swap the
 * regex passes for an AST walk (e.g. via `oxc-parser` or
 * `@babel/parser`'s lightweight estree mode). For now they
 * haven't surfaced.
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

/** Wire-friendly form of a prepared script — same import-rewriting
 *  but helpers are returned as JS source strings rather than
 *  pre-evaluated exports objects. The worker runtime ships these
 *  across the postMessage boundary (function exports don't
 *  structured-clone, but strings do) and AsyncFunction-evaluates
 *  each helper in its own realm to populate the modules map. */
export interface PreparedForWire {
  /** Same as `PreparedScript.code`. */
  readonly code: string
  /** Helpers in dependency order — each entry's body may reference
   *  earlier entries via `__modules['/path']`. The worker iterates
   *  in order, evaluating each into a fresh `__exports` object,
   *  registering it under `path`. */
  readonly helpers: ReadonlyArray<{
    /** Resolved VFS path (without extension if the user code
     *  imported without one) — the key the agent's rewritten code
     *  uses to look this module up in `__modules`. */
    readonly path: string
    /** Body of an `async function(__exports, __modules) { ... }`
     *  that populates `__exports` and returns it. */
    readonly body: string
  }>
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
  // Reuse the wire path then evaluate each helper locally — same
  // semantics as before, just a different output shape on the
  // far side. The dual-key aliasing (resolved + sourcePath) that
  // the previous direct implementation did is preserved here.
  const prepared = await prepareScriptForWire(source, fs, tsBlankSpace)
  if (prepared.helpers.length === 0) return { code: prepared.code, modules: {} }
  const modules: Record<string, Readonly<Record<string, unknown>>> = {}
  for (const h of prepared.helpers) {
    const fn = new AsyncFunction('__exports', '__modules', h.body)
    const exports: Record<string, unknown> = {}
    await fn(exports, modules)
    modules[h.path] = exports
  }
  return { code: prepared.code, modules }
}

/** Wire-friendly variant of `prepareScript`: same rewriting +
 *  recursive helper resolution, but each helper body is returned as
 *  a string instead of evaluated locally. The runtime adapter on
 *  the receiving side (today: `agex-runtime-worker`) iterates the
 *  list in order, AsyncFunction-evaluates each body to get its
 *  exports, and registers them under `path` in its own
 *  `__modules` map.
 *
 *  The `transform` parameter handles TS → JS conversion of helper
 *  source files. evalRuntime passes `tsBlankSpace`; workerRuntime
 *  passes its configurable transform (default ts-blank-space, can
 *  be swapped for esbuild-wasm). */
export async function prepareScriptForWire(
  source: string,
  fs: VirtualFileSystem,
  transform: (src: string) => string | Promise<string>,
): Promise<PreparedForWire> {
  const imports = parseImports(source)
  if (imports.length === 0) return { code: source, helpers: [] }

  // Collect helpers in dependency order. A helper's body references
  // its dependencies' exports through `__modules`, so deps must be
  // evaluated first (worker-side eval iterates this list in order).
  const helpers: Array<{ path: string; body: string }> = []
  const compiled = new Set<string>()
  const inFlight = new Set<string>()

  async function walk(importPath: string, baseDir: string): Promise<void> {
    const resolved = resolveVfsPath(importPath, baseDir)
    if (compiled.has(resolved)) return
    if (inFlight.has(resolved)) {
      throw new Error(
        `module loader: cyclic helper import — '${resolved}' is already being loaded. Helper cycles are unsupported; refactor the shared bits into a third file.`,
      )
    }
    inFlight.add(resolved)

    const sourcePath = await findFile(resolved, fs)
    const bytes = await fs.read(sourcePath)
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const stripped = await transform(raw)

    // Recurse into this helper's own imports first so its body's
    // `__modules` lookups land on already-evaluated entries.
    const subImports = parseImports(stripped)
    const dirOfHelper = dirname(sourcePath)
    for (const sub of subImports) {
      if (!isVfsPath(sub.path) && !sub.path.startsWith('.')) continue
      await walk(sub.path, dirOfHelper)
    }

    const body = compileHelperBody(stripped, sourcePath, dirOfHelper)
    helpers.push({ path: resolved, body })
    compiled.add(resolved)
    // Aliases: if the file was found with an extension, register
    // that path too (a sub-helper that imported with the explicit
    // extension would otherwise miss). Same body is reused; the
    // worker assigns the same exports to both keys at eval time.
    if (sourcePath !== resolved && !compiled.has(sourcePath)) {
      helpers.push({ path: sourcePath, body: aliasBody(resolved, sourcePath) })
      compiled.add(sourcePath)
    }
    inFlight.delete(resolved)
  }

  for (const imp of imports) {
    if (!isVfsPath(imp.path)) continue
    await walk(imp.path, '/')
  }

  // Rewrite the user code's imports to `__modules` lookups.
  let out = source
  for (const imp of [...imports].reverse()) {
    if (!isVfsPath(imp.path)) continue
    if (imp.isReexport) {
      // Re-exports aren't valid in script context; strip them.
      out = `${out.slice(0, imp.start)}/* re-export skipped */${out.slice(imp.end)}`
      continue
    }
    const resolved = resolveVfsPath(imp.path, '/')
    if (!compiled.has(resolved)) continue
    const replacement = rewriteAsLookup(imp.binding, resolved)
    out = out.slice(0, imp.start) + replacement + out.slice(imp.end)
  }
  return { code: out, helpers }
}

/** Body for an alias entry — when the same helper file should be
 *  reachable under two paths (e.g. `/helpers/foo` and the
 *  with-extension form `/helpers/foo.ts`), the alias just copies
 *  the already-evaluated module's exports rather than re-running
 *  the helper. Worker iterates helpers in order, so by the time
 *  this body runs, `__modules[primary]` is populated. */
function aliasBody(primaryPath: string, aliasPath: string): string {
  void aliasPath
  return `Object.assign(__exports, __modules[${JSON.stringify(primaryPath)}]); return __exports;\n`
}

// ---------------------------------------------------------------------------
// Helper loading
// ---------------------------------------------------------------------------

/** Compile a helper's transformed source into the body of an
 *  `async function(__exports, __modules) { ... }`. No evaluation —
 *  the result is a string that callers can `new AsyncFunction(...)`
 *  themselves, either in the host realm (evalRuntime, via
 *  `prepareScript`) or in the worker realm after shipping over
 *  postMessage (workerRuntime, via `prepareScriptForWire`). */
function compileHelperBody(stripped: string, sourcePath: string, dirOfHelper: string): string {
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
  return `${body}\n${exportAssignments}\nreturn __exports;\n//# sourceURL=${sourcePath}\n`
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
  // Uses lookbehind (?<=^|[\n;]) so the boundary char is NOT
  // consumed — that way multi-statement-per-line forms like
  // `export { a } from 'b'; export { c } from 'd';` work (after the
  // first replacement the regex resumes scanning right after the
  // semicolon and the lookbehind matches).
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, inside: string, path: string) => {
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
      return lines.join('\n')
    },
  )
  // export * as NS from '/path' — bind the whole module's exports
  // as a namespace property. Must come BEFORE the bare `export *`
  // pattern so the more specific match wins.
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, name: string, path: string) => {
      const resolved =
        isVfsPath(path) || path.startsWith('.') ? resolveVfsPath(path, dirOfHelper) : path
      return `__exports[${JSON.stringify(name)}] = __modules[${JSON.stringify(resolved)}];`
    },
  )
  // export * from '/path' — copy all exports onto __exports
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, path: string) => {
      const resolved =
        isVfsPath(path) || path.startsWith('.') ? resolveVfsPath(path, dirOfHelper) : path
      return `Object.assign(__exports, __modules[${JSON.stringify(resolved)}]);`
    },
  )
  return out
}

/** Rewrite `export ...` declarations to plain ones; track exported
 *  names for the trailing `__exports.X = X` block.
 *
 *  All four patterns use lookbehind `(?<=^|[\n;])` so the boundary
 *  char (semicolon / newline / start-of-source) isn't consumed —
 *  this lets multi-statement-per-line forms like
 *  `const x = 1; export const y = 2;` work, since after replacing
 *  the first match the regex resumes scanning right after the `;`
 *  and the lookbehind matches.
 *
 *  Known limit: `export default <expr>` reads up to the next
 *  newline OR end-of-source, not balanced parens/braces. So
 *  `export default { a: 1, b: 2 }` written across multiple lines
 *  truncates at the first `\n`. Single-line forms (including
 *  IIFEs and inline objects) work fine. Agent helpers
 *  overwhelmingly use single-line defaults; if we hit the limit
 *  in practice we'd switch to a real expression parser. */
function rewriteHelperExports(code: string): { code: string; exportNames: string[] } {
  const exportNames: string[] = []
  let out = code

  // export default <expr> — captures to the next newline or
  // end-of-source. Single-line form (the common case) handles
  // arbitrary `;`s inside the expression (IIFE: `(() => { ... })()`,
  // calls: `mkConfig(); …`). The inline rewrite assigns to
  // __exports.default directly — we don't add 'default' to
  // exportNames (the trailing block would emit
  // `__exports['default'] = default;` and `default` is a reserved
  // word).
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s+default\s+([\s\S]*?)(?=$|\n)/gm,
    (_m, expr: string) => `__exports.default = ${expr.trim()}`,
  )

  // export function NAME / export async function NAME / export class NAME.
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s+(async\s+function\b|function\b|class\b)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind: string, name: string) => {
      if (!exportNames.includes(name)) exportNames.push(name)
      return `${kind} ${name}`
    },
  )

  // export const NAME = ... / export let NAME / export var NAME.
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind: string, name: string) => {
      if (!exportNames.includes(name)) exportNames.push(name)
      return `${kind} ${name}`
    },
  )

  // export { a, b as c } — track names + aliases.
  out = out.replace(/(?<=^|[\n;])[ \t]*export\s*\{([^}]*)\}[ \t]*;?/gm, (_m, inside: string) => {
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
    return lines.join('\n')
  })

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
