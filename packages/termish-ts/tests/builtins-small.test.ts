/**
 * The small commands, where the shared cases can't reach: host
 * commands in `help`/`which`/`command`, MD5 across padding lengths,
 * `du -h`'s rounding, `seq`'s limit and `strftime`'s conversions.
 * Mirrors termish-py's test_small_commands.py.
 */

import { describe, expect, it } from 'vitest'
import { md5Hex } from '../src/builtins/checksum'
import { strftime } from '../src/builtins/clock'
import { duHuman } from '../src/builtins/fsinfo'
import { HELP } from '../src/builtins/help-text'
import { BUILTINS } from '../src/builtins/index'
import { SEQ_MAX } from '../src/builtins/lines'
import type { CommandHandler } from '../src/context'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()

const deploy: CommandHandler = Object.assign(async () => undefined, {
  description: 'ship the app',
})
const quiet: CommandHandler = async () => undefined

describe('host commands', () => {
  const commands = { deploy, quiet }

  it('are listed by help, with a description when they have one', async () => {
    const out = await execute('help', new MemoryFS(), { commands })
    expect(out).toMatch(/^deploy +ship the app$/m)
    expect(out).toMatch(/^quiet$/m)
  })

  it('show their description in help NAME, or say there is none', async () => {
    const fs = new MemoryFS()
    expect(await execute('help deploy', fs, { commands })).toBe('deploy - ship the app\n')
    expect(await execute('help quiet', fs, { commands })).toBe(
      'quiet: a command of this host, with no help here\n',
    )
  })

  it('are found by which and command', async () => {
    const fs = new MemoryFS()
    expect(await execute('which deploy', fs, { commands })).toBe('deploy\n')
    expect(await execute('command -V deploy', fs, { commands })).toBe('deploy is a host command\n')
  })

  it("override a builtin's help when they take its name", async () => {
    const out = await execute('help ls', new MemoryFS(), {
      commands: { ls: Object.assign(async () => undefined, { description: 'a host ls' }) },
    })
    expect(out).toBe('ls - a host ls\n')
  })
})

describe('help', () => {
  it('has a summary and a usage for every builtin', () => {
    const missing = [...BUILTINS.keys()].filter(
      (name) => !HELP[name]?.summary || !HELP[name]?.usage,
    )
    expect(missing).toEqual([])
  })
})

describe('md5', () => {
  it('matches RFC 1321 vectors', () => {
    expect(md5Hex(enc.encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex(enc.encode('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0')
    expect(
      md5Hex(
        enc.encode(
          '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
        ),
      ),
    ).toBe('57edf4a22be3c955ac49da2e2107b67a')
  })

  it('pads at the block edges', () => {
    // 55, 56 and 64 bytes: the length field just fits, just doesn't, a whole block
    expect(md5Hex(enc.encode('a'.repeat(55)))).toBe('ef1772b6dff9a122358552954ad0df65')
    expect(md5Hex(enc.encode('a'.repeat(56)))).toBe('3b0c8ac703f828b04c6c197006d17218')
    expect(md5Hex(enc.encode('a'.repeat(64)))).toBe('014842d480b571495a4a0363793f7367')
  })
})

describe('du -h', () => {
  it('rounds up, one decimal under 10', () => {
    expect(duHuman(0)).toBe('0')
    expect(duHuman(1023)).toBe('1023')
    expect(duHuman(1024)).toBe('1.0K')
    expect(duHuman(1536)).toBe('1.5K')
    expect(duHuman(1537)).toBe('1.6K')
    expect(duHuman(10 * 1024)).toBe('10K')
    expect(duHuman(10 * 1024 + 1)).toBe('11K')
    expect(duHuman(1024 * 1024 - 1)).toBe('1.0M')
    expect(duHuman(5 * 1024 ** 3)).toBe('5.0G')
  })

  it('shows sizes that way', async () => {
    const fs = new MemoryFS()
    await fs.write('/big', enc.encode('x'.repeat(1536)))
    expect(await execute('du -h /big', fs)).toBe('1.5K\t/big\n')
  })
})

describe('seq', () => {
  it('stops at its limit', async () => {
    const error = (await execute(`seq ${SEQ_MAX + 1}`, new MemoryFS()).catch(
      (e: unknown) => e,
    )) as TerminalError
    expect(error).toBeInstanceOf(TerminalError)
    expect(error.message).toContain('too many numbers')
  })
})

describe('strftime', () => {
  // 2026-03-05 07:08:09 UTC, a Thursday, day 64
  const at = new Date(Date.UTC(2026, 2, 5, 7, 8, 9))

  it('formats each conversion', () => {
    expect(strftime(at, '%Y %y %m %d %e %j %H %I %M %S %p %u %w', true)).toBe(
      '2026 26 03 05  5 064 07 07 08 09 AM 4 4',
    )
    expect(strftime(at, '%a %A %b %B', true)).toBe('Thu Thursday Mar March')
    expect(strftime(at, '%F %T %D %R %z %:z %Z %s', true)).toBe(
      '2026-03-05 07:08:09 03/05/26 07:08 +0000 +00:00 UTC 1772694489',
    )
    expect(strftime(at, '%n%t%%%Q', true)).toBe('\n\t%%Q')
  })

  it('shows 12 for noon and midnight on a 12-hour clock', () => {
    expect(strftime(new Date(Date.UTC(2026, 0, 1, 0)), '%I %p', true)).toBe('12 AM')
    expect(strftime(new Date(Date.UTC(2026, 0, 1, 12)), '%I %p', true)).toBe('12 PM')
  })
})
