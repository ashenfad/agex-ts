import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

/**
 * A case both termish-ts and termish-py run (`cases/awk.json`, the same
 * file in each repo): a script, the files it starts with, and what it
 * prints, or the error it fails with.
 */
interface Case {
  readonly name: string
  readonly script: string
  readonly files?: Record<string, string>
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdout?: string
  readonly error?: string
  readonly exitCode?: number
}

const cases: Case[] = JSON.parse(readFileSync(new URL('./cases/awk.json', import.meta.url), 'utf8'))

async function run(c: Case): Promise<{ stdout: string; exitCode: number; error: string }> {
  const fs = new MemoryFS()
  for (const [path, text] of Object.entries(c.files ?? {})) {
    await fs.write(path, new TextEncoder().encode(text))
  }
  if (c.cwd !== undefined) {
    await fs.mkdir(c.cwd, { parents: true, existOk: true })
    await fs.chdir(c.cwd)
  }
  try {
    const stdout = await execute(c.script, fs, { env: { ...c.env } })
    return { stdout, exitCode: 0, error: '' }
  } catch (e) {
    if (!(e instanceof TerminalError)) throw e
    return { stdout: e.partialOutput, exitCode: e.exitCode, error: e.message }
  }
}

describe('awk cases', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const got = await run(c)
    if (c.error !== undefined) expect(got.error + got.stdout).toContain(c.error)
    if (c.stdout !== undefined) expect(got.stdout).toBe(c.stdout)
    expect(got.exitCode).toBe(c.exitCode ?? 0)
  })
})

describe('awk', () => {
  it('stops a runaway loop when the signal aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await expect(
      execute("awk 'BEGIN { while (1) x++ }'", new MemoryFS(), { signal: controller.signal }),
    ).rejects.toThrow(/aborted/)
  })
})
