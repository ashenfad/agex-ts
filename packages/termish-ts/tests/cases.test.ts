/**
 * The shared cases: scripts and what they give, the same file in
 * termish-py (`tests/cases/`), so both terminals behave alike.
 *
 * A case's `stdout` (or `stdoutRegex`, searched) is what the script
 * wrote, the partial output when it failed; `error` is a substring of
 * the failure's message and stderr (a parse error's too); `exitCode` the
 * failure's code. `files` are written first, and the script runs in
 * `cwd` with `env`.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ParseError, TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

interface Case {
  name: string
  script: string
  files?: Record<string, string>
  cwd?: string
  env?: Record<string, string>
  stdout?: string
  stdoutRegex?: string
  error?: string
  exitCode?: number
}

const dir = join(__dirname, 'cases')
const enc = new TextEncoder()

async function run(c: Case): Promise<{ stdout: string; error: TerminalError | ParseError | null }> {
  const fs = new MemoryFS()
  for (const [path, content] of Object.entries(c.files ?? {})) {
    const slash = path.lastIndexOf('/')
    if (slash > 0) await fs.mkdir(path.slice(0, slash), { parents: true, existOk: true })
    await fs.write(path, enc.encode(content))
  }
  if (c.cwd !== undefined) {
    await fs.mkdir(c.cwd, { parents: true, existOk: true })
    await fs.chdir(c.cwd)
  }
  try {
    return { stdout: await execute(c.script, fs, { env: { ...c.env } }), error: null }
  } catch (e) {
    if (e instanceof ParseError) return { stdout: '', error: e }
    if (!(e instanceof TerminalError)) throw e
    return { stdout: e.partialOutput, error: e }
  }
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const cases = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Case[]
  describe(file, () => {
    for (const c of cases) {
      it(c.name, async () => {
        const { stdout, error } = await run(c)
        if (c.stdout !== undefined) expect(stdout).toBe(c.stdout)
        if (c.stdoutRegex !== undefined) expect(stdout).toMatch(new RegExp(c.stdoutRegex))
        if (c.error === undefined) {
          expect(error).toBeNull()
        } else {
          expect(error, 'the script should fail').not.toBeNull()
          const stderr = error instanceof TerminalError ? error.stderr : undefined
          expect(`${error?.message}\n${stderr ?? ''}`).toContain(c.error)
        }
        if (c.exitCode !== undefined) {
          expect(error instanceof TerminalError ? error.exitCode : 0).toBe(c.exitCode)
        }
      })
    }
  })
}
