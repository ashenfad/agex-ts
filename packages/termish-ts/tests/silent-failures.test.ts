/**
 * The cases in `cases/silent-failures.json`: braces, `$PWD` and `$HOME`,
 * unset variables, and the parser's diagnostics. termish-py runs the
 * same file, so the two stay alike.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { ParseError, TerminalError, execute } from '../src/index'

interface Case {
  readonly name: string
  readonly script: string
  /** Files to write first, by absolute path. */
  readonly files?: Readonly<Record<string, string>>
  /** The directory to run in. */
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  /** The transcript: what's returned, or a failure's partial output. */
  readonly stdout?: string
  /** A substring of the error the script fails with. */
  readonly error?: string
  /** A terminal error's exit code. */
  readonly exitCode?: number
}

const cases = JSON.parse(
  readFileSync(new URL('./cases/silent-failures.json', import.meta.url), 'utf8'),
) as Case[]

describe('silent failures', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const fs = new MemoryFS()
    for (const [path, content] of Object.entries(c.files ?? {})) {
      await fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { parents: true, existOk: true })
      await fs.write(path, new TextEncoder().encode(content))
    }
    if (c.cwd !== undefined) {
      await fs.mkdir(c.cwd, { parents: true, existOk: true })
      await fs.chdir(c.cwd)
    }
    const run = execute(c.script, fs, { env: { ...c.env } })
    if (c.error === undefined) {
      expect(await run).toBe(c.stdout)
      return
    }
    const error = await run.then(
      (out) => {
        throw new Error(`succeeded with ${JSON.stringify(out)}`)
      },
      (e: unknown) => e,
    )
    expect(error instanceof ParseError || error instanceof TerminalError).toBe(true)
    expect((error as Error).message).toContain(c.error)
    if (c.exitCode !== undefined) expect((error as TerminalError).exitCode).toBe(c.exitCode)
    if (c.stdout !== undefined) expect((error as TerminalError).partialOutput).toBe(c.stdout)
  })
})
