import { MemoryFS } from 'termish-ts/fs/memory'
import { describe, expect, it } from 'vitest'
import { parseImports, prepareScript } from '../src/runtime/module-loader'

const enc = new TextEncoder()

async function fsWith(files: Record<string, string>): Promise<MemoryFS> {
  const fs = new MemoryFS()
  for (const [path, content] of Object.entries(files)) {
    const slash = path.lastIndexOf('/')
    if (slash > 0) await fs.mkdir(path.slice(0, slash), { parents: true, existOk: true })
    await fs.write(path, enc.encode(content))
  }
  return fs
}

// ---------------------------------------------------------------------------
// parseImports
// ---------------------------------------------------------------------------

describe('parseImports', () => {
  it('extracts named imports', () => {
    const out = parseImports("import { foo, bar } from '/helpers/x'")
    expect(out).toHaveLength(1)
    expect(out[0]?.path).toBe('/helpers/x')
    expect(out[0]?.binding).toEqual({
      kind: 'named',
      entries: [
        { source: 'foo', local: 'foo' },
        { source: 'bar', local: 'bar' },
      ],
    })
  })

  it('handles aliased named imports', () => {
    const out = parseImports("import { foo as bar } from '/helpers/x'")
    expect(out[0]?.binding).toEqual({
      kind: 'named',
      entries: [{ source: 'foo', local: 'bar' }],
    })
  })

  it('handles namespace imports', () => {
    const out = parseImports("import * as utils from '/helpers/x'")
    expect(out[0]?.binding).toEqual({ kind: 'namespace', local: 'utils' })
  })

  it('handles default imports', () => {
    const out = parseImports("import myDefault from '/helpers/x'")
    expect(out[0]?.binding).toEqual({ kind: 'default', local: 'myDefault' })
  })

  it('handles mixed default + named', () => {
    const out = parseImports("import myDefault, { x, y } from '/helpers/x'")
    expect(out[0]?.binding).toEqual({
      kind: 'mixed',
      defaultLocal: 'myDefault',
      entries: [
        { source: 'x', local: 'x' },
        { source: 'y', local: 'y' },
      ],
    })
  })

  it('handles side-effect imports', () => {
    const out = parseImports("import '/helpers/setup'")
    expect(out[0]?.binding).toEqual({ kind: 'sideEffect' })
  })

  it('finds multiple imports across the source', () => {
    const out = parseImports(`
import { a } from '/helpers/x'
import * as b from '/helpers/y'
const c = 1
import 'react'
`)
    expect(out.map((i) => i.path)).toEqual(['/helpers/x', '/helpers/y', 'react'])
  })

  it('tolerates multiline named imports', () => {
    const out = parseImports(`
import {
  foo,
  bar as baz,
} from '/helpers/x'
`)
    expect(out).toHaveLength(1)
    expect(out[0]?.binding).toEqual({
      kind: 'named',
      entries: [
        { source: 'foo', local: 'foo' },
        { source: 'bar', local: 'baz' },
      ],
    })
  })

  it('returns empty for code with no imports', () => {
    expect(parseImports('const x = 1\nconsole.log(x)')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// prepareScript
// ---------------------------------------------------------------------------

describe('prepareScript', () => {
  it('passes through code with no imports unchanged + empty modules map', async () => {
    const fs = new MemoryFS()
    const out = await prepareScript('const x = 1\ntaskSuccess(x)', fs)
    expect(out.code).toBe('const x = 1\ntaskSuccess(x)')
    expect(out.modules).toEqual({})
  })

  it('rewrites a single named import as destructuring against __modules', async () => {
    const fs = await fsWith({
      '/helpers/utils.ts': 'export function foo() { return 42 }',
    })
    const src = "import { foo } from '/helpers/utils'\ntaskSuccess(foo())"
    const out = await prepareScript(src, fs)
    expect(out.code).toContain('const { foo } = __modules["/helpers/utils"]')
    expect(out.code).toContain('taskSuccess(foo())')
    // Pre-loaded helper exports come back in the modules map.
    const utils = out.modules['/helpers/utils'] as { foo: () => number }
    expect(typeof utils.foo).toBe('function')
    expect(utils.foo()).toBe(42)
  })

  it('handles aliased + namespace + default + side-effect bindings', async () => {
    const fs = await fsWith({
      '/helpers/a.ts': 'export const x = 1; export const y = 2',
      '/helpers/b.ts': 'export const z = 3',
      '/helpers/c.ts': 'const d = 4; export default d',
      '/helpers/d.ts': 'const sideEffect = 1',
    })
    const src = `
import { x as alpha } from '/helpers/a'
import * as ns from '/helpers/b'
import myD from '/helpers/c'
import '/helpers/d'
`
    const out = await prepareScript(src, fs)
    expect(out.code).toContain('const { x: alpha } = __modules["/helpers/a"]')
    expect(out.code).toContain('const ns = __modules["/helpers/b"]')
    expect(out.code).toContain('const { default: myD } = __modules["/helpers/c"]')
    // Side-effect import: just a comment; no binding extracted.
    expect(out.code).toContain('/* import /helpers/d */')
    // Default value resolves correctly
    const c = out.modules['/helpers/c'] as { default: number }
    expect(c.default).toBe(4)
  })

  it('passes through non-VFS imports (react, node:fs) unchanged', async () => {
    const fs = new MemoryFS()
    const src = "import { useState } from 'react'\nimport fs from 'node:fs'"
    const out = await prepareScript(src, fs)
    expect(out.code).toContain("from 'react'")
    expect(out.code).toContain("from 'node:fs'")
  })

  it('resolves helper-of-helper imports recursively', async () => {
    const fs = await fsWith({
      '/helpers/leaf.ts': 'export const x = 42',
      '/helpers/middle.ts': "export { x as wrapped } from '/helpers/leaf'",
    })
    const out = await prepareScript("import { wrapped } from '/helpers/middle'", fs)
    // Both paths should be in the modules map.
    expect(out.modules['/helpers/leaf']).toBeDefined()
    expect(out.modules['/helpers/middle']).toBeDefined()
    const middle = out.modules['/helpers/middle'] as { wrapped: number }
    expect(middle.wrapped).toBe(42)
  })

  it('throws a clear error when a helper import targets a missing file', async () => {
    const fs = new MemoryFS()
    await expect(prepareScript("import { x } from '/helpers/missing'", fs)).rejects.toThrow(
      /not found in VFS/,
    )
  })

  it('detects cyclic helper imports and throws', async () => {
    const fs = await fsWith({
      '/helpers/a.ts': "export { x } from '/helpers/b'",
      '/helpers/b.ts': "export { x } from '/helpers/a'",
    })
    await expect(prepareScript("import { x } from '/helpers/a'", fs)).rejects.toThrow(
      /cyclic helper import/,
    )
  })

  it('finds files with .ts extension when import omits one', async () => {
    const fs = await fsWith({
      '/helpers/foo.ts': 'export const x = 1',
    })
    const out = await prepareScript("import { x } from '/helpers/foo'", fs)
    expect(out.code).toContain('__modules["/helpers/foo"]')
    expect((out.modules['/helpers/foo'] as { x: number }).x).toBe(1)
  })

  it("supports `export * from '/path'` (re-export all)", async () => {
    const fs = await fsWith({
      '/helpers/leaf.ts': 'export const a = 1; export const b = 2',
      '/helpers/all.ts': "export * from '/helpers/leaf'",
    })
    const out = await prepareScript("import { a, b } from '/helpers/all'", fs)
    const all = out.modules['/helpers/all'] as { a: number; b: number }
    expect(all.a).toBe(1)
    expect(all.b).toBe(2)
  })

  it("supports `export * as ns from '/path'` (namespace re-export)", async () => {
    const fs = await fsWith({
      '/helpers/leaf.ts': 'export const a = 1; export const b = 2',
      '/helpers/wrap.ts': "export * as utils from '/helpers/leaf'",
    })
    const out = await prepareScript("import { utils } from '/helpers/wrap'", fs)
    const wrap = out.modules['/helpers/wrap'] as { utils: { a: number; b: number } }
    expect(wrap.utils?.a).toBe(1)
    expect(wrap.utils?.b).toBe(2)
  })

  it('runs a real end-to-end helper that exports multiple functions', async () => {
    // Concrete proof that the userspace ESM emulation produces a
    // working module — exports are real JS values that callers can
    // invoke from their own scope.
    const fs = await fsWith({
      '/helpers/math.ts': `
        export function add(a: number, b: number): number { return a + b }
        export function mul(a: number, b: number): number { return a * b }
        export const TAU = Math.PI * 2
      `,
    })
    const out = await prepareScript("import { add, mul, TAU } from '/helpers/math'", fs)
    const m = out.modules['/helpers/math'] as {
      add: (a: number, b: number) => number
      mul: (a: number, b: number) => number
      TAU: number
    }
    expect(m.add(2, 3)).toBe(5)
    expect(m.mul(4, 5)).toBe(20)
    expect(m.TAU).toBeCloseTo(Math.PI * 2)
  })
})
