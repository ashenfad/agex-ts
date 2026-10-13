/**
 * Imports of the world's own modules, for code run in the kernel.
 *
 * The worker runs code as the body of an async function, which has no
 * module loader, so imports are emulated: each module the code imports
 * from the world's files becomes an async function that fills an
 * exports object, and each `import` statement becomes a lookup.
 *
 * - **A path** (`./lib.ts`, `../shared/x`, `/workspace/util`) is one of
 *   the world's files: relative to the working directory in the code
 *   run, relative to the importing module in a module, and tried with
 *   `.ts`, `.js` and `.mjs` when the exact name isn't there. Modules
 *   are read and compiled on the host, so the worker never fetches
 *   them.
 * - **`'host'`** is the host objects (`import { db } from 'host'`).
 * - **Anything else** (`'arquero'`, `'https://…'`) is loaded in the
 *   worker: a URL directly, a bare name through the profile's resolver.
 *
 * Top-level `await` works in modules, and re-exports (`export { x }
 * from`, `export * from`, `export * as ns from`) do. The emulation has
 * no live bindings (a module's exports are copied when it finishes),
 * no `import.meta`, and refuses cyclic imports. The rewriting is by
 * pattern, not a parser: imports inside template literals and comments
 * are left alone, and a multi-line `export default` expression is cut
 * at its first line.
 */

/** The reads the loader needs from the world's filesystem. */
export interface ModuleSource {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<Uint8Array>
}

/** Code ready for the worker: imports rewritten, and the world modules
 *  it needs compiled, dependencies first. */
export interface PreparedCode {
  readonly code: string
  readonly modules: ReadonlyArray<{
    /** The path the code's lookups use (as imported, extension or
     *  not). */
    readonly path: string
    /** Body of `async (__exports, __modules, __registered, __load)`. */
    readonly body: string
  }>
}

/** Specifiers bound to host values rather than loaded. */
const REGISTERED: ReadonlySet<string> = new Set(['host'])

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

/**
 * Rewrite the code's imports and compile the world modules it reaches.
 *
 * @param source the code, already stripped of types.
 * @param cwd the directory the code's relative imports start from.
 * @param transform turns a module's TypeScript into JavaScript.
 */
export async function prepareCode(
  source: string,
  fs: ModuleSource,
  cwd: string,
  transform: (src: string) => string | Promise<string>,
): Promise<PreparedCode> {
  const imports = parseImports(source)
  if (imports.length === 0) return { code: source, modules: [] }

  const modules: Array<{ path: string; body: string }> = []
  const compiled = new Set<string>()
  const inFlight = new Set<string>()

  async function walk(importPath: string, baseDir: string): Promise<void> {
    const resolved = resolveVfsPath(importPath, baseDir)
    if (compiled.has(resolved)) return
    // A module is the file found, however it was spelled: `./dep` and
    // `./dep.ts` are one module, evaluated once.
    const sourcePath = await findFile(resolved, fs)
    if (!compiled.has(sourcePath)) {
      if (inFlight.has(sourcePath)) {
        throw new Error(
          `cyclic import: '${sourcePath}' is already being loaded; move what the two share into a third module`,
        )
      }
      inFlight.add(sourcePath)
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(await fs.read(sourcePath))
      const stripped = await transform(raw)
      // A module's own imports load first, so its lookups find them.
      const dirOfHelper = dirname(sourcePath)
      for (const sub of parseImports(stripped)) {
        if (isWorldPath(sub.path)) await walk(sub.path, dirOfHelper)
      }
      modules.push({
        path: sourcePath,
        body: compileHelperBody(stripped, sourcePath, dirOfHelper),
      })
      compiled.add(sourcePath)
      inFlight.delete(sourcePath)
    }
    if (resolved !== sourcePath) {
      modules.push({ path: resolved, body: aliasBody(sourcePath) })
      compiled.add(resolved)
    }
  }

  for (const imp of imports) {
    if (isWorldPath(imp.path)) await walk(imp.path, cwd)
  }

  let out = source
  for (const imp of [...imports].reverse()) {
    let replacement: string
    if (imp.isReexport) {
      // Re-exports mean nothing in the code run.
      replacement = '/* re-export skipped */'
    } else if (isWorldPath(imp.path)) {
      replacement = rewriteAsLookup(imp.binding, resolveVfsPath(imp.path, cwd))
    } else if (REGISTERED.has(imp.path)) {
      replacement = rewriteAsRegisteredAccess(imp.binding, imp.path)
    } else {
      replacement = rewriteAsUrlLoad(imp.binding, imp.path)
    }
    out =
      out.slice(0, imp.start) +
      keepLines(out.slice(imp.start, imp.end), replacement) +
      out.slice(imp.end)
  }
  return { code: out, modules }
}

/** Body for another spelling of a module (`/lib/util` for
 *  `/lib/util.ts`): the module's own exports object, which modules
 *  evaluated in order have already filled. */
function aliasBody(primaryPath: string): string {
  return `return __modules[${JSON.stringify(primaryPath)}];\n`
}

// ---------------------------------------------------------------------------
// Module compiling
// ---------------------------------------------------------------------------

/** Compile a module's JavaScript into the body of
 *  `async (__exports, __modules, __registered, __load) => …`, a string
 *  the worker evaluates. Its imports become lookups as the code's do:
 *  world paths in `__modules`, `'host'` in `__registered`, anything
 *  else `await __load(specifier)`. */
function compileHelperBody(stripped: string, sourcePath: string, dirOfHelper: string): string {
  // Pass 1: rewrite re-exports first (`export { x } from '/path'`,
  // `export * from '/path'`). They become `__exports.X = __modules['/path'].X`
  // assignments. Has to happen BEFORE rewriteHelperExports so the
  // remaining `export` keyword scan doesn't trip on them.
  const reexported = rewriteHelperReexports(stripped, dirOfHelper)
  // Pass 2: rewrite `export ...` declarations, tracking exported
  // names for the trailing assignment block.
  const { code, exportNames } = rewriteHelperExports(reexported)
  // Pass 3: rewrite plain `import` statements (non-reexport) — VFS
  // paths to `__modules` lookups, registered names to `__registered`
  // lookups.
  const imports = parseImports(code)
  let body = code
  for (const imp of [...imports].reverse()) {
    if (imp.isReexport) continue // already handled in pass 1
    if (isWorldPath(imp.path)) {
      const resolved = resolveVfsPath(imp.path, dirOfHelper)
      const replacement = rewriteAsLookup(imp.binding, resolved)
      body =
        body.slice(0, imp.start) +
        keepLines(body.slice(imp.start, imp.end), replacement) +
        body.slice(imp.end)
      continue
    }
    const replacement = REGISTERED.has(imp.path)
      ? rewriteAsRegisteredAccess(imp.binding, imp.path, true)
      : rewriteAsUrlLoad(imp.binding, imp.path)
    body =
      body.slice(0, imp.start) +
      keepLines(body.slice(imp.start, imp.end), replacement) +
      body.slice(imp.end)
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
  // Where a re-export reads from: a world module, the host objects, or
  // a package or URL loaded as an import of it would be.
  const source = (path: string): string =>
    isWorldPath(path)
      ? `__modules[${JSON.stringify(resolveVfsPath(path, dirOfHelper))}]`
      : REGISTERED.has(path)
        ? `__registered[${JSON.stringify(path)}]`
        : `(await __load(${JSON.stringify(path)}))`
  let out = code
  // export { a, b as c } from '/path'
  // Uses lookbehind (?<=^|[\n;]) so the boundary char is NOT
  // consumed — that way multi-statement-per-line forms like
  // `export { a } from 'b'; export { c } from 'd';` work (after the
  // first replacement the regex resumes scanning right after the
  // semicolon and the lookbehind matches).
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (m: string, inside: string, path: string) => {
      const from = source(path)
      const lines: string[] = []
      for (const part of inside.split(',')) {
        const t = part.trim()
        if (t.length === 0) continue
        const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        const sourceName = aliased !== null ? (aliased[1] as string) : t
        const exportName = aliased !== null ? (aliased[2] as string) : t
        lines.push(
          `__exports[${JSON.stringify(exportName)}] = ${from}[${JSON.stringify(sourceName)}];`,
        )
      }
      return keepLines(m, lines.join(' '))
    },
  )
  // export * as NS from '/path' — bind the whole module's exports
  // as a namespace property. Must come BEFORE the bare `export *`
  // pattern so the more specific match wins.
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (m: string, name: string, path: string) =>
      keepLines(m, `__exports[${JSON.stringify(name)}] = ${source(path)};`),
  )
  // export * from '/path' — copy all exports onto __exports
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (m: string, path: string) => keepLines(m, `Object.assign(__exports, ${source(path)});`),
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
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\{([^}]*)\}[ \t]*;?/gm,
    (m: string, inside: string) => {
      const lines: string[] = []
      for (const part of inside.split(',')) {
        const t = part.trim()
        if (t.length === 0) continue
        const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        if (aliased !== null) {
          const local = aliased[1] as string
          const exported = aliased[2] as string
          // Assigned here from its local name: `exported` names no local
          // binding, so the trailing block mustn't assign it.
          lines.push(`__exports[${JSON.stringify(exported)}] = ${local};`)
        } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
          if (!exportNames.includes(t)) exportNames.push(t)
          // Will be assigned by the trailing __exports block.
        }
      }
      return keepLines(m, lines.join(' '))
    },
  )

  return { code: out, exportNames }
}

// ---------------------------------------------------------------------------
// Import-statement parsing + rewriting
// ---------------------------------------------------------------------------

/**
 * Blank out template-literal contents and comments so the import/
 * re-export regexes can't match statements that live inside them —
 * an agent embedding app source in a backtick string (`await
 * fs.writeText('app/index.js', \`import ...\`)`) must not get that
 * string's imports rewritten into `__load(...)` calls the app's
 * realm can't resolve.
 *
 * Masked chars become spaces; newlines are preserved so offsets AND
 * line structure stay aligned with the original source (the caller
 * slices replacements into the original by offset). Single/double-
 * quoted strings are tracked (so a quote can't open a fake template
 * or comment) but NOT masked — import specifiers live in them.
 * Template interpolations (`${...}`) re-enter live-code scanning,
 * including nested templates. Regex literals are not tracked — a
 * quote/backtick inside one can desync the scanner (rare in agent
 * code; the failure mode is a missed rewrite, which surfaces as a
 * clear eval-time syntax error rather than silent corruption).
 */
export function maskTemplatesAndComments(src: string): string {
  const out = src.split('')
  /** Template-nesting stack: 'tpl' = inside a template's literal
   *  text (masked); {depth} = inside a `${...}` interpolation
   *  (live code), tracking unmatched `{` so object literals don't
   *  close it early. */
  type Frame = 'tpl' | { depth: number }
  const stack: Frame[] = []
  let str: '"' | "'" | null = null
  let comment: 'line' | 'block' | null = null
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (comment === 'line') {
      if (c === '\n') comment = null
      else out[i] = ' '
      i++
      continue
    }
    if (comment === 'block') {
      if (c === '*' && n === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        comment = null
        i += 2
        continue
      }
      if (c !== '\n') out[i] = ' '
      i++
      continue
    }
    if (str !== null) {
      // Tracked but not masked — see doc comment.
      if (c === '\\') {
        // Skip the full CRLF after a line-continuation backslash so the
        // trailing '\n' doesn't trip the recovery heuristic below.
        if (src[i + 1] === '\r' && src[i + 2] === '\n') i += 3
        else i += 2
        continue
      }
      if (c === str || c === '\n') str = null
      i++
      continue
    }
    const top = stack[stack.length - 1]
    if (top === 'tpl') {
      if (c === '\\') {
        out[i] = ' '
        if (i + 1 < src.length && src[i + 1] !== '\n') out[i + 1] = ' '
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        out[i] = ' '
        i++
        continue
      }
      if (c === '$' && n === '{') {
        stack.push({ depth: 0 })
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        continue
      }
      if (c !== '\n') out[i] = ' '
      i++
      continue
    }
    // Live code (top-level or inside an interpolation).
    if (c === '/' && n === '/') {
      comment = 'line'
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      continue
    }
    if (c === '/' && n === '*') {
      comment = 'block'
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      str = c
      i++
      continue
    }
    if (c === '`') {
      stack.push('tpl')
      out[i] = ' '
      i++
      continue
    }
    if (top !== undefined) {
      // `top` can only be an interpolation frame here — the 'tpl'
      // case was handled (and `continue`d) above.
      if (c === '{') top.depth++
      else if (c === '}') {
        if (top.depth === 0) {
          stack.pop() // back into the template's literal text
          out[i] = ' '
          i++
          continue
        }
        top.depth--
      }
    }
    i++
  }
  return out.join('')
}

/** Find top-level static module-graph edges in the source — both
 *  `import` statements and `export ... from` re-exports. Scans a
 *  masked copy of the source (template literals and comments
 *  blanked) so string-embedded code can't produce false matches;
 *  offsets and matched text are valid against the original because
 *  masking is char-for-char and real import statements contain no
 *  template/comment chars. */
export function parseImports(source: string): ImportStatement[] {
  const out: ImportStatement[] = []
  const masked = maskTemplatesAndComments(source)
  const importRe =
    /(?<=^|;)[ \t]*import\b((?:[\s\S](?!^[ \t]*(?:import|export)\b))*?)['"]([^'"]+)['"][ \t]*(?:;|$)/gm
  for (const m of masked.matchAll(importRe)) {
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
    /(?<=^|;)[ \t]*export\b((?:[\s\S](?!^[ \t]*(?:import|export)\b))*?)\bfrom\b[\s]*['"]([^'"]+)['"][ \t]*(?:;|$)/gm
  for (const m of masked.matchAll(reexportRe)) {
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

/** Rewrite an import of anything not in the world (a package, a URL)
 *  to `await __load(specifier)`, which the worker resolves and imports
 *  once per worker. */
function rewriteAsUrlLoad(binding: ImportBinding, name: string): string {
  const target = `(await __load(${JSON.stringify(name)}))`
  switch (binding.kind) {
    case 'sideEffect':
      return `await __load(${JSON.stringify(name)});`
    case 'namespace':
      return `const ${binding.local} = ${target};`
    case 'default':
      return `const ${binding.local} = ${target}.default;`
    case 'named': {
      if (binding.entries.length === 0) return `await __load(${JSON.stringify(name)});`
      const dest = binding.entries
        .map((e) => (e.source === e.local ? e.source : `${e.source}: ${e.local}`))
        .join(', ')
      // No temporary binding: two imports of one specifier would
      // declare it twice. `__load` caches, so a second await is cheap.
      return `const { ${dest} } = ${target};`
    }
    case 'mixed': {
      const named = binding.entries
        .map((e) => (e.source === e.local ? e.source : `${e.source}: ${e.local}`))
        .join(', ')
      return `const ${binding.defaultLocal} = ${target}.default; const { ${named} } = ${target};`
    }
  }
}

/** Rewrite an import of a registered name (`'host'`) to a lookup of the
 *  value bound to it. In the code run, `import * as host from 'host'`
 *  is a no-op: `host` is already bound. */
function rewriteAsRegisteredAccess(
  binding: ImportBinding,
  name: string,
  helperContext = false,
): string {
  // In the code run, a registered name is a binding of the run; a
  // module reaches it through its `__registered` parameter.
  const target = helperContext ? `__registered[${JSON.stringify(name)}]` : name
  // The "elide" path (when a binding name matches the registered
  // name) only makes sense in main code where the value is already
  // there as a global. In helper context we always need the const
  // declaration so the local binding lands in helper scope.
  switch (binding.kind) {
    case 'sideEffect':
      return `/* import '${name}' (already in scope) */`
    case 'namespace':
      if (binding.local === name && !helperContext) return `/* import * as ${name} */`
      return `const ${binding.local} = ${target};`
    case 'default':
      if (binding.local === name && !helperContext) return `/* import ${name} (already in scope) */`
      return `const ${binding.local} = ${target}.default;`
    case 'named': {
      if (binding.entries.length === 0) return `/* import '${name}' */`
      const dest = binding.entries
        .map((e) => (e.source === e.local ? e.source : `${e.source}: ${e.local}`))
        .join(', ')
      return `const { ${dest} } = ${target};`
    }
    case 'mixed': {
      const named = binding.entries
        .map((e) => (e.source === e.local ? e.source : `${e.source}: ${e.local}`))
        .join(', ')
      const defaultPart =
        binding.defaultLocal === name && !helperContext
          ? ''
          : `const ${binding.defaultLocal} = ${target}.default;`
      const namedPart = `const { ${named} } = ${target};`
      return defaultPart === '' ? namedPart : `${defaultPart}\n${namedPart}`
    }
  }
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

/** `replacement` on one line, then as many line breaks as `original`
 *  had, so the lines after a rewritten statement keep their numbers
 *  (stack traces name them). */
function keepLines(original: string, replacement: string): string {
  const breaks = original.split('\n').length - 1
  return replacement.replace(/\n/g, ' ') + '\n'.repeat(breaks)
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** A specifier naming one of the world's files: absolute, or relative
 *  with `./` or `../`. */
function isWorldPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('./') || p.startsWith('../')
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

async function findFile(resolved: string, fs: ModuleSource): Promise<string> {
  if (await fs.exists(resolved)) return resolved
  for (const ext of ['.ts', '.js', '.mjs']) {
    const candidate = `${resolved}${ext}`
    if (await fs.exists(candidate)) return candidate
  }
  throw new Error(`Cannot find module '${resolved}' (also tried .ts, .js and .mjs)`)
}
