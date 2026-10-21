/**
 * stderr: failure diagnostics show in the transcript once execution goes
 * on past them, as a terminal shows stderr; `2>`, `2>>` and `2>&1` route
 * it; `/dev/null` discards and reads empty. Ported from termish-py's
 * test_stderr.py and test_dev_null.py.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import {
  type CommandHandler,
  type CommandResult,
  ParseError,
  TerminalError,
  execute,
} from '../src/index'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

/** The failure `script` throws, run on its own filesystem. */
async function failure(script: string, f = new MemoryFS()): Promise<TerminalError> {
  const error = await execute(script, f).catch((e: unknown) => e)
  if (!(error instanceof TerminalError)) throw new Error(`${script} did not fail`)
  return error
}

/** A command that rejects any `--` option, as the retrospective's curl did. */
const curl: CommandHandler = async (ctx) => {
  for (const a of ctx.args) {
    if (a.startsWith('--')) return { exitCode: 2, stderr: `curl: option ${a}: is unknown` }
  }
  ctx.stdout.write('{"status":"ok"}\n')
  return undefined
}

// MemoryFS's own wording for a missing file, as `cat` reports it.
let missing: string
let missingA: string
let missingB: string
beforeAll(async () => {
  missing = (await failure('cat /missing')).message
  missingA = (await failure('cat /a')).message
  missingB = (await failure('cat /b')).message
})

let fs: MemoryFS
beforeEach(() => {
  fs = new MemoryFS()
})

describe('a failure execution goes on past', () => {
  it('shows its diagnostic', async () => {
    expect(await execute('cat /missing; echo ok', fs)).toBe(`${missing}\nok\n`)
    expect(await execute('cat /missing || echo fallback', fs)).toBe(`${missing}\nfallback\n`)
    expect(await execute('nosuchcmd; echo ok', fs)).toBe('nosuchcmd: command not found\nok\n')
  })

  it('shows it even when || true swallows the exit code', async () => {
    expect(await execute('cat /missing || true', fs)).toBe(`${missing}\n`)
  })

  it('stays silent when the command was (false)', async () => {
    expect(await execute('false; echo ok', fs)).toBe('ok\n')
    expect(await execute('false || echo rescued', fs)).toBe('rescued\n')
  })

  it("shows a command's own stderr", async () => {
    const out = await execute('curl --max-time 5 x; echo exit=$?', fs, { commands: { curl } })
    expect(out).toBe('curl: option --max-time: is unknown\nexit=2\n')
  })

  it('shows every one', async () => {
    expect(await execute('cat /a; cat /b; echo done', fs)).toBe(`${missingA}\n${missingB}\ndone\n`)
  })
})

describe('a failure at the end', () => {
  it('throws, with its diagnostic on the error and not in the transcript', async () => {
    const error = await failure('echo start; cat /missing')
    expect(error.partialOutput).toBe('start\n')
    expect(error.message).toBe(missing)
    expect(error.exitCode).toBe(1)
  })

  it('throws when && skips the rest', async () => {
    await expect(execute('cat /missing && echo yes', fs)).rejects.toThrow(TerminalError)
  })

  it('keeps earlier diagnostics in the partial output', async () => {
    const error = await failure('cat /a; echo mid; cat /b')
    expect(error.partialOutput).toBe(`${missingA}\nmid\n`)
    expect(error.message).toBe(missingB)
  })

  it("carries the command's stderr and exit code", async () => {
    const error = (await execute('curl --fail x', fs, { commands: { curl } }).catch(
      (e: unknown) => e,
    )) as TerminalError
    expect(error.stderr).toBe('curl: option --fail: is unknown')
    expect(error.exitCode).toBe(2)
  })
})

describe('a warning from a command that succeeded', () => {
  const warn: CommandHandler = async (ctx) => {
    ctx.stdout.write('a\nb\n')
    return { exitCode: 0, stderr: 'warn: something\n' }
  }

  it('shows in the transcript', async () => {
    expect(await execute('warn', fs, { commands: { warn } })).toBe('warn: something\na\nb\n')
  })

  it('is never fed to the next stage', async () => {
    expect(await execute('warn | wc -l', fs, { commands: { warn } })).toBe('warn: something\n2\n')
  })

  it('joins the pipe under 2>&1', async () => {
    expect((await execute('warn 2>&1 | wc -l', fs, { commands: { warn } })).trim()).toBe('3')
  })
})

describe("a failing command's own output", () => {
  it('goes to its output redirect, not the transcript', async () => {
    await fs.write('/a', bytes('AAA\n'))
    expect(await execute('cat /a /missing > /out; true', fs)).toBe(`${missing}\n`)
    expect(text(await fs.read('/out'))).toBe('AAA\n')
  })

  it('appends with >>, and is discarded by /dev/null', async () => {
    await fs.write('/a', bytes('AAA\n'))
    await fs.write('/log', bytes('old\n'))
    await execute('cat /a /missing >> /log; true', fs)
    expect(text(await fs.read('/log'))).toBe('old\nAAA\n')
    expect(await execute('cat /a /missing > /dev/null; true', fs)).toBe(`${missing}\n`)
    expect(await fs.exists('/dev/null')).toBe(false)
  })

  it('goes to the transcript without a redirect', async () => {
    await fs.write('/a', bytes('AAA\n'))
    expect(await execute('cat /a /missing; true', fs)).toBe(`AAA\n${missing}\n`)
  })

  it('follows the redirect when stderr goes to a file too', async () => {
    await fs.write('/a', bytes('AAA\n'))
    expect(await execute('cat /a /missing > /out 2> /err; true', fs)).toBe('')
    expect(text(await fs.read('/out'))).toBe('AAA\n')
    expect(text(await fs.read('/err'))).toBe(`${missing}\n`)
  })
})

describe('2> and 2>>', () => {
  it('capture the diagnostic', async () => {
    expect(await execute('cat /missing 2>/err.txt; echo ok', fs)).toBe('ok\n')
    expect(text(await fs.read('/err.txt'))).toBe(`${missing}\n`)
  })

  it('truncate the target even with nothing to write', async () => {
    await fs.write('/err.txt', bytes('old content'))
    expect(await execute('echo hi 2>/err.txt', fs)).toBe('hi\n')
    expect(text(await fs.read('/err.txt'))).toBe('')
  })

  it('append with 2>>', async () => {
    await execute('cat /a 2>>/err.txt; cat /b 2>>/err.txt; true', fs)
    expect(text(await fs.read('/err.txt'))).toBe(`${missingA}\n${missingB}\n`)
  })

  it('still stop the pipeline, silently', async () => {
    const error = await failure('cat /missing 2>/dev/null')
    expect(error.exitCode).toBe(1)
    expect(error.stderr).toBe('')
  })

  it("take a command's stderr, and a variable target", async () => {
    const out = await execute('curl --fail x 2>/err.txt; echo exit=$?', fs, { commands: { curl } })
    expect(out).toBe('exit=2\n')
    expect(text(await fs.read('/err.txt'))).toBe('curl: option --fail: is unknown\n')
    await execute('cat /missing 2>$LOG; true', fs, { env: { LOG: '/my.log' } })
    expect(text(await fs.read('/my.log'))).toBe(`${missing}\n`)
  })

  it('silence a command not found', async () => {
    expect(await execute('nosuchcmd 2>/dev/null; echo ok', fs)).toBe('ok\n')
  })
})

describe('2>&1', () => {
  it('sends the diagnostic through the pipe', async () => {
    expect(await execute('cat /missing 2>&1 | head -1', fs)).toBe(`${missing}\n`)
  })

  it('lets the pipeline go on, its exit the last stage', async () => {
    const out = await execute('cat /missing 2>&1 | wc -l; echo exit=$?', fs)
    expect(out.replace(/^ +/, '')).toBe('1\nexit=0\n')
  })

  it('in the last stage, throws with the exit code and no second diagnostic', async () => {
    const error = await failure('cat /missing 2>&1')
    expect(error.exitCode).toBe(1)
    expect(error.partialOutput).toBe(`${missing}\n`)
    expect(error.stderr).toBe('')
  })

  it('lands in an output redirect', async () => {
    await execute('cat /missing 2>&1 > /all.txt; true', fs)
    expect(text(await fs.read('/all.txt'))).toBe(`${missing}\n`)
  })

  it('leaves stdout alone on success', async () => {
    expect(await execute('echo hi 2>&1', fs)).toBe('hi\n')
    expect(await execute('echo hi 2>&1 | wc -l', fs)).toBe('1\n')
  })
})

describe("the retrospective's curl line", () => {
  it('shows a rejected flag through the pipe', async () => {
    await fs.mkdir('/app', { parents: true })
    const out = await execute(
      "cd /app && curl --max-time 5 'api/overview' 2>&1 | head -30; " + 'echo "=== EXIT $? ==="',
      fs,
      { commands: { curl } },
    )
    expect(out).toBe('curl: option --max-time: is unknown\n=== EXIT 0 ===\n')
  })

  it('keeps the exit code without the merge', async () => {
    const out = await execute(
      `curl --max-time 5 'api/overview' | head -30; echo "=== EXIT $? ==="`,
      fs,
      { commands: { curl } },
    )
    expect(out).toBe('curl: option --max-time: is unknown\n=== EXIT 2 ===\n')
  })
})

describe('/dev/null', () => {
  it('discards > and >>, and is never written', async () => {
    expect(await execute('echo hi > /dev/null; echo ok', fs)).toBe('ok\n')
    expect(await execute('echo hi >> /dev/null; echo ok', fs)).toBe('ok\n')
    expect(await execute('cat /missing > /dev/null 2>&1; echo exit=$?', fs)).toBe('exit=1\n')
    expect(await fs.exists('/dev/null')).toBe(false)
  })

  it("keeps a pipeline's exit code", async () => {
    await fs.write('/a.txt', bytes('x\n'))
    expect(await execute('cat /a.txt > /dev/null && echo ok', fs)).toBe('ok\n')
    await expect(execute('cat /missing > /dev/null', fs)).rejects.toThrow(TerminalError)
    expect(await fs.exists('/dev/null')).toBe(false)
  })

  it('reads empty', async () => {
    expect(await execute('cat < /dev/null; echo ok', fs)).toBe('ok\n')
    expect((await execute('wc -c < /dev/null', fs)).trim()).toBe('0')
  })

  it('is /dev/null however it is spelled', async () => {
    for (const target of ['/dev/./null', '/dev//null', '/tmp/../dev/null']) {
      expect(await execute(`echo hi > ${target}; echo ok`, fs)).toBe('ok\n')
    }
    expect((await execute('cd / && echo hi > dev/null && wc -c < dev/null', fs)).trim()).toBe('0')
    expect(await fs.exists('/dev/null')).toBe(false)
  })

  it('leaves other targets as files', async () => {
    await execute('echo hi > /out.txt', fs)
    expect(text(await fs.read('/out.txt'))).toBe('hi\n')
  })
})

/** A failed script's `displayStderr` is what reached stderr
 *  unredirected: the final command's own diagnostic, named once, or
 *  nothing when it failed silently or its stderr went elsewhere. */
describe('displayStderr', () => {
  const MISSING = "ls: cannot access '/nope': No such file or directory"
  let fs: MemoryFS

  beforeEach(async () => {
    fs = new MemoryFS()
    await fs.mkdir('/w')
    await fs.write('/w/f.txt', bytes('hello\n'))
    await fs.write('/w/out.txt', bytes('old\n'))
  })

  const fail = async (
    script: string,
    commands: Record<string, CommandHandler> = {},
  ): Promise<TerminalError> => {
    const error = await execute(script, fs, { commands }).catch((e: unknown) => e)
    if (!(error instanceof TerminalError)) throw new Error(`${script} did not fail`)
    return error
  }

  it("doesn't prefix a stderr that starts with the name", async () => {
    // ls with several operands returns its own "ls: ..." stderr
    const e = await fail('ls /w /nope')
    expect(e.exitCode).toBe(2)
    expect(e.partialOutput).toBe('/w:\nf.txt\nout.txt\n')
    expect(e.stderr).toBe(`${MISSING}\n`)
    expect(e.message).toBe(`${MISSING}\n`)
    expect(e.displayStderr).toBe(`${MISSING}\n`)
  })

  it('prefixes a stderr without the name', async () => {
    const tool: CommandHandler = async () => ({ exitCode: 2, stderr: 'usage: tool <path>' })
    const e = await fail('tool', { tool })
    expect(e.stderr).toBe('usage: tool <path>')
    expect(e.message).toBe('tool: usage: tool <path>')
    expect(e.displayStderr).toBe('tool: usage: tool <path>')
  })

  it('reads a name inside the text as no prefix', async () => {
    const tool: CommandHandler = async () => ({ exitCode: 1, stderr: 'toolbox: broken' })
    expect((await fail('tool', { tool })).displayStderr).toBe('tool: toolbox: broken')
  })

  it('shows the message of a failure that is only a message', async () => {
    const e = await fail('cat /nope')
    expect(e.stderr).toBeUndefined()
    expect(e.displayStderr).toBe('cat: /nope: No such file or directory')
  })

  it('is empty when 2>&1 merged it into stdout', async () => {
    const e = await fail('ls /w /nope 2>&1')
    expect(e.exitCode).toBe(2)
    // once, in the transcript, where 2>&1 sent it
    expect(e.partialOutput).toBe(`/w:\nf.txt\nout.txt\n${MISSING}\n`)
    expect(e.stderr).toBe('')
    expect(e.displayStderr).toBe('')
  })

  it('is empty when it was discarded', async () => {
    const e = await fail('ls /w /nope 2>/dev/null')
    expect(e.exitCode).toBe(2)
    expect(e.partialOutput).toBe('/w:\nf.txt\nout.txt\n')
    expect(e.displayStderr).toBe('')
  })

  it('is empty when it went to a file', async () => {
    const e = await fail('ls /w /nope 2>/w/err.txt')
    expect(e.exitCode).toBe(2)
    expect(e.displayStderr).toBe('')
    expect(text(await fs.read('/w/err.txt'))).toBe(`${MISSING}\n`)
  })

  it('is empty for grep without a match', async () => {
    for (const script of ['grep zebra /w/f.txt', 'cd /w && grep -r zebra .']) {
      const e = await fail(script)
      expect(e.exitCode).toBe(1)
      expect(e.stderr).toBe('')
      expect(e.displayStderr).toBe('')
      expect(e.message).toBe('grep: exited with code 1')
    }
  })

  it('is empty for a false test', async () => {
    const e = await fail('test -f /nope')
    expect(e.exitCode).toBe(1)
    expect(e.displayStderr).toBe('')
  })

  it('is empty for a handler that gave no stderr', async () => {
    const quiet: CommandHandler = async () => ({ exitCode: 3 }) as unknown as CommandResult
    const e = await fail('quiet', { quiet })
    expect(e.exitCode).toBe(3)
    expect(e.stderr).toBe('')
    expect(e.displayStderr).toBe('')
  })

  it('leaves an earlier failure in the transcript', async () => {
    const e = await fail('cat /a; echo mid; ls /w /nope')
    expect(e.partialOutput).toBe('cat: /a: No such file or directory\nmid\n/w:\nf.txt\nout.txt\n')
    expect(e.displayStderr).toBe(`${MISSING}\n`)
  })

  it('is empty when a silent failure follows an earlier one', async () => {
    const e = await fail('ls /w /nope; grep zebra /w/f.txt')
    expect(e.exitCode).toBe(1)
    expect(e.partialOutput).toBe(`/w:\nf.txt\nout.txt\n${MISSING}\n`)
    expect(e.displayStderr).toBe('')
  })

  it('leaves a parse error alone', async () => {
    await expect(execute('echo $(pwd)', fs)).rejects.toBeInstanceOf(ParseError)
  })

  it('names the command once under xargs', async () => {
    const e = await fail('echo /w /nope | xargs ls')
    expect(e.exitCode).toBe(2)
    expect(e.displayStderr).toBe(`${MISSING}\n`)
  })

  /** A command that warns on its first run and fails on the next. */
  const warnThen = (failure: CommandResult): Record<string, CommandHandler> => {
    let calls = 0
    return {
      warn: async () => (++calls === 1 ? { exitCode: 0, stderr: 'warn: careful\n' } : failure),
    }
  }

  it('shows xargs warnings before a silent failure', async () => {
    const e = await fail('echo a b | xargs -n 1 warn', warnThen({ exitCode: 7, stderr: '' }))
    expect(e.exitCode).toBe(7)
    // the message still names the failure; the screen shows only what
    // reached stderr, the warning
    expect(e.message).toBe('warn: careful\nwarn: exited with code 7\n')
    expect(e.displayStderr).toBe('warn: careful\n')
    expect(e.stderr).toBe('warn: careful\n')
  })

  it('shows xargs warnings before a failure with a diagnostic', async () => {
    const e = await fail(
      'echo a b | xargs -n 1 warn',
      warnThen({ exitCode: 7, stderr: 'warn: broke' }),
    )
    expect(e.exitCode).toBe(7)
    expect(e.message).toBe('warn: careful\nwarn: broke\n')
    expect(e.displayStderr).toBe('warn: careful\nwarn: broke\n')
  })

  it('is empty for xargs warnings and a failure all redirected', async () => {
    const e = await fail(
      'echo a b | xargs -n 1 warn 2>/dev/null',
      warnThen({ exitCode: 7, stderr: '' }),
    )
    expect(e.exitCode).toBe(7)
    expect(e.displayStderr).toBe('')
  })

  it('takes an explicit displayStderr first', () => {
    const e = new TerminalError('x: exited with code 3', {
      exitCode: 3,
      stderr: 'w\n',
      displayStderr: 'w\n',
    })
    expect(e.displayStderr).toBe('w\n')
    expect(new TerminalError('boom').displayStderr).toBe('boom')
    expect(new TerminalError('x: exited with code 1', { stderr: '' }).displayStderr).toBe('')
  })
})
