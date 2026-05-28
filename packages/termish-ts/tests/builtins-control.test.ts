import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

describe('true', () => {
  it('produces no output and succeeds', async () => {
    expect(await execute('true', new MemoryFS())).toBe('')
  })

  it('chains with && (true && cmd runs cmd)', async () => {
    expect(await execute('true && echo ok', new MemoryFS())).toBe('ok\n')
  })

  it('short-circuits || (true || cmd skips cmd)', async () => {
    // If || ran `echo skipped` it would appear in stdout — it must not.
    expect(await execute('true || echo skipped', new MemoryFS())).toBe('')
  })
})

describe('false', () => {
  it('fails with a TerminalError', async () => {
    await expect(execute('false', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('|| recovers from false', async () => {
    expect(await execute('false || echo recovered', new MemoryFS())).toBe('recovered\n')
  })

  it('&& short-circuits after false (false && cmd skips cmd)', async () => {
    // `false && cmd` is still a script-level failure because the last
    // pipeline (false) failed and && skipped the recovery. So we use
    // a trailing || to soak the failure back into success.
    expect(await execute('false && echo skipped || echo afterwards', new MemoryFS())).toBe(
      'afterwards\n',
    )
  })
})

describe('|| true idiom', () => {
  it('rescues a failing command', async () => {
    // The original failing transcript: `<cmd that may fail> || true`.
    // Use a guaranteed-missing path to provoke the failure.
    expect(await execute('cat /missing || true', new MemoryFS())).toBe('')
  })
})
