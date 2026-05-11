#!/usr/bin/env node
/**
 * Bundle-shape check: scan every package's built `dist/` for patterns
 * that mean "this artifact won't run in a browser bundle."
 *
 * Catches regressions like:
 *  - tsup inlining a transitive dep that uses `createRequire('module')`
 *    (we hit this with fflate via termish-ts)
 *  - a Node-only sub-path leaking into a chunk that browser bundlers
 *    statically analyze (we hit this with kvgit-ts/backends/sqlite)
 *
 * Per-package allowlist below carves out the legitimately Node-only
 * entry files that are *expected* to import Node builtins. Browser
 * bundlers resolve those via the `"browser"` exports condition to a
 * stub instead — see e.g. kvgit-ts/src/backends/sqlite.browser.ts.
 *
 * Run via `pnpm check:dist`. CI runs this after `pnpm build`.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// Patterns we never want to see in a browser-targeted bundle.
const FORBIDDEN = [
  { pattern: /from\s+['"]node:module['"]/, label: "import from 'node:module'" },
  { pattern: /from\s+['"]module['"]/, label: "import from 'module'" },
  { pattern: /createRequire\s*\(/, label: 'createRequire call' },
  { pattern: /from\s+['"]node:worker_threads['"]/, label: "import from 'node:worker_threads'" },
  { pattern: /from\s+['"]worker_threads['"]/, label: "import from 'worker_threads'" },
  { pattern: /from\s+['"]node:sqlite['"]/, label: "import from 'node:sqlite'" },
]

// Files that are *allowed* to contain forbidden patterns because they
// are platform-conditional sub-path entries (browser bundlers resolve
// to a stub via the `"browser"` exports condition). Paths are relative
// to the package root.
const ALLOWLIST = {
  'kvgit-ts': ['dist/backends/sqlite.js'],
  'termish-ts': ['dist/fs/real.js'],
}

// Packages to scan. Anything not listed is skipped (e.g. the monorepo
// root, examples).
const PACKAGES = [
  'agex-ts',
  'kvgit-ts',
  'termish-ts',
  'agex-anthropic',
  'agex-openai',
  'agex-gemini',
  'agex-runtime-worker',
  'agex-git',
]

async function* walkJsFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJsFiles(path)
    else if (entry.isFile() && entry.name.endsWith('.js')) yield path
  }
}

function stripComments(code) {
  // Rough but good enough — we just need to skip JSDoc / line-comment
  // mentions of the forbidden tokens. Won't handle commented-out code
  // perfectly, which is fine: code in comments is unreachable, so a
  // false positive there is still worth flagging in a review.
  return code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

async function checkPackage(pkgName) {
  const pkgPath = join(repoRoot, 'packages', pkgName)
  const distPath = join(pkgPath, 'dist')
  try {
    await stat(distPath)
  } catch {
    return { pkgName, missingDist: true, violations: [] }
  }

  const allowedRel = new Set(ALLOWLIST[pkgName] ?? [])
  const violations = []
  for await (const file of walkJsFiles(distPath)) {
    const rel = relative(pkgPath, file)
    if (allowedRel.has(rel)) continue
    const code = stripComments(await readFile(file, 'utf8'))
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(code)) violations.push({ file: rel, label })
    }
  }
  return { pkgName, missingDist: false, violations }
}

const results = await Promise.all(PACKAGES.map(checkPackage))
const missing = results.filter((r) => r.missingDist)
const allViolations = results.flatMap((r) => r.violations.map((v) => ({ pkg: r.pkgName, ...v })))

if (missing.length > 0) {
  console.error('check-dist-shape: the following packages have no dist/ — run `pnpm build` first:')
  for (const m of missing) console.error(`  - ${m.pkgName}`)
  process.exit(1)
}

if (allViolations.length > 0) {
  console.error('\ncheck-dist-shape FAILED — browser-hostile patterns found in built artifacts:\n')
  for (const v of allViolations) {
    console.error(`  [${v.pkg}] ${v.file}: ${v.label}`)
  }
  console.error(
    '\nFix the leak in source (most often a tsup-inlined transitive dep, or a' +
      '\ndynamic-import target that needs a "browser" exports-condition stub),' +
      '\nor add the file to ALLOWLIST in scripts/check-dist-shape.mjs if it is' +
      '\na legitimately Node-only entry covered by an exports-condition stub.\n',
  )
  process.exit(1)
}

console.log(`check-dist-shape: ok (${PACKAGES.length} packages scanned)`)
