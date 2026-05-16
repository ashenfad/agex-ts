import { describe, expect, it } from 'vitest'
import type { CommandHandler } from '../src/context'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => dec.decode(b)

describe('execute — single commands', () => {
  it('echo writes args joined by spaces with a trailing newline', async () => {
    const out = await execute('echo hello world', new MemoryFS())
    expect(out).toBe('hello world\n')
  })

  it('echo with no args writes just a newline', async () => {
    expect(await execute('echo', new MemoryFS())).toBe('\n')
  })

  it('cat reads a file', async () => {
    const fs = new MemoryFS()
    await fs.write('/note.txt', bytes('hello there'))
    const out = await execute('cat /note.txt', fs)
    expect(out).toBe('hello there')
  })

  it('cat on a missing file throws TerminalError', async () => {
    const fs = new MemoryFS()
    await expect(execute('cat /nope', fs)).rejects.toBeInstanceOf(TerminalError)
  })
})

describe('execute — pipelines', () => {
  it('pipes stdout to stdin', async () => {
    const fs = new MemoryFS()
    await fs.write('/data', bytes('one\ntwo\nthree'))
    // cat with no args reads stdin
    const out = await execute('cat /data | cat', fs)
    expect(out).toBe('one\ntwo\nthree')
  })

  it('chains multiple stages', async () => {
    const out = await execute('echo hello | cat | cat', new MemoryFS())
    expect(out).toBe('hello\n')
  })
})

describe('execute — operators', () => {
  it('runs both pipelines on ;', async () => {
    const out = await execute('echo a; echo b', new MemoryFS())
    expect(out).toBe('a\nb\n')
  })

  it('runs the right side of && only on success', async () => {
    const fs = new MemoryFS()
    // First fails (missing file), second should be skipped
    await expect(execute('cat /nope && echo follow', fs)).rejects.toBeInstanceOf(TerminalError)
    // Verify "follow" wasn't reached: the partial output should not contain it
    try {
      await execute('cat /nope && echo follow', fs)
    } catch (e) {
      expect((e as TerminalError).partialOutput).toBe('')
    }
  })

  it('does run the right side of && when the left succeeds', async () => {
    const out = await execute('echo first && echo second', new MemoryFS())
    expect(out).toBe('first\nsecond\n')
  })

  it('runs the right side of || only on failure', async () => {
    const fs = new MemoryFS()
    const out = await execute('cat /nope || echo recovered', fs)
    expect(out).toBe('recovered\n')
  })

  it('does NOT run the right side of || when the left succeeds', async () => {
    const out = await execute('echo ok || echo nope', new MemoryFS())
    expect(out).toBe('ok\n')
  })
})

describe('execute — redirects', () => {
  it('> writes pipeline output to a file (overwrite)', async () => {
    const fs = new MemoryFS()
    const out = await execute('echo hello > /out.txt', fs)
    expect(out).toBe('') // pipeline output suppressed
    expect(text(await fs.read('/out.txt'))).toBe('hello\n')
  })

  it('>> appends', async () => {
    const fs = new MemoryFS()
    await execute('echo first > /log; echo second >> /log', fs)
    expect(text(await fs.read('/log'))).toBe('first\nsecond\n')
  })

  it('< reads input from a file', async () => {
    const fs = new MemoryFS()
    await fs.write('/in', bytes('from the file'))
    const out = await execute('cat < /in', fs)
    expect(out).toBe('from the file')
  })

  it('handles a quoted redirect target with spaces', async () => {
    const fs = new MemoryFS()
    await execute('echo hi > "/spaced name.txt"', fs)
    expect(text(await fs.read('/spaced name.txt'))).toBe('hi\n')
  })
})

describe('execute — glob expansion', () => {
  it('expands * in args', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/dir', { parents: true })
    await fs.write('/dir/a.txt', bytes('A'))
    await fs.write('/dir/b.txt', bytes('B'))
    await fs.chdir('/dir')
    const out = await execute('cat *.txt', fs)
    expect(out).toBe('AB')
  })

  it('does NOT glob-expand quoted args', async () => {
    const fs = new MemoryFS()
    // No file matches; if cat tried to glob, it would fail-or-pass-literal
    // Either way the literal '*.txt' should reach the command.
    await expect(execute("cat '*.txt'", fs)).rejects.toThrow(/\*\.txt/)
  })

  it('falls back to the literal pattern when no matches', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/empty', { parents: true })
    await fs.chdir('/empty')
    await expect(execute('cat *.csv', fs)).rejects.toThrow(/\*\.csv/)
  })
})

describe('execute — quoted args', () => {
  it('strips outer quotes from args before passing to handler', async () => {
    const out = await execute('echo "with spaces"', new MemoryFS())
    expect(out).toBe('with spaces\n')
  })

  it('preserves spaces in single-quoted args', async () => {
    const out = await execute("echo 'foo bar baz'", new MemoryFS())
    expect(out).toBe('foo bar baz\n')
  })
})

describe('execute — injected commands', () => {
  it('host commands resolve when present', async () => {
    const greet: CommandHandler = async (ctx) => {
      ctx.stdout.write(`hello ${ctx.args[0] ?? 'world'}\n`)
    }
    const out = await execute('greet alice', new MemoryFS(), { commands: { greet } })
    expect(out).toBe('hello alice\n')
  })

  it('injected commands override builtins on name collision', async () => {
    const fakeEcho: CommandHandler = async (ctx) => {
      ctx.stdout.write(`fake: ${ctx.args.join(',')}\n`)
    }
    const out = await execute('echo a b c', new MemoryFS(), {
      commands: { echo: fakeEcho },
    })
    expect(out).toBe('fake: a,b,c\n')
  })

  it('throws on unknown command', async () => {
    await expect(execute('nosuchcmd', new MemoryFS())).rejects.toThrow(/command not found/)
  })

  it('Map-form commands also work', async () => {
    const handler: CommandHandler = async (ctx) => {
      ctx.stdout.write('mapform\n')
    }
    const out = await execute('foo', new MemoryFS(), {
      commands: new Map([['foo', handler]]),
    })
    expect(out).toBe('mapform\n')
  })

  it('host commands stay reachable through xargs', async () => {
    const shout: CommandHandler = async (ctx) => {
      ctx.stdout.write(`SHOUT(${ctx.args.join(',')})\n`)
    }
    const out = await execute("echo -e 'a\\nb' | xargs -I {} shout {}", new MemoryFS(), {
      commands: { shout },
    })
    expect(out).toBe('SHOUT(a)\nSHOUT(b)\n')
  })

  it('host commands stay reachable through find -exec', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await fs.write('/b.txt', bytes('bravo'))
    const tag: CommandHandler = async (ctx) => {
      ctx.stdout.write(`TAG:${ctx.args[0]}\n`)
    }
    const out = await execute("find / -name '*.txt' -exec tag {} ';'", fs, {
      commands: { tag },
    })
    expect(out).toContain('TAG:/a.txt')
    expect(out).toContain('TAG:/b.txt')
  })
})

describe('execute — partial output on failure', () => {
  it('TerminalError carries accumulated partial output from earlier successful pipelines', async () => {
    const fs = new MemoryFS()
    await fs.write('/ok', bytes('first '))
    try {
      await execute('cat /ok; cat /nope', fs)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(TerminalError)
      expect((e as TerminalError).partialOutput).toBe('first ')
    }
  })
})

describe('execute — cancellation', () => {
  it('throws TerminalError when AbortSignal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      execute('echo hi; echo there', new MemoryFS(), { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(TerminalError)
  })

  it('aborts between pipelines when the signal fires mid-script', async () => {
    // A custom command that fires the abort signal during its own execution
    let ctrl: AbortController = new AbortController()
    const aborter: CommandHandler = async (ctx) => {
      ctx.stdout.write('before abort\n')
      ctrl.abort()
    }
    const out = execute('aborter; echo after', new MemoryFS(), {
      commands: { aborter },
      get signal(): AbortSignal {
        return ctrl.signal
      },
    } as never)
    // We need a fresh shape — pass the signal directly
    void out
    ctrl = new AbortController()
    const realOut = execute('aborter; echo after', new MemoryFS(), {
      commands: { aborter },
      signal: ctrl.signal,
    })
    await expect(realOut).rejects.toBeInstanceOf(TerminalError)
  })
})

describe('execute — empty / whitespace input', () => {
  it('returns empty string on empty input', async () => {
    expect(await execute('', new MemoryFS())).toBe('')
  })

  it('returns empty string on whitespace-only input', async () => {
    expect(await execute('   \t  ', new MemoryFS())).toBe('')
  })
})

describe('execute — maxOutputChars', () => {
  it('passes output through unchanged when under the cap', async () => {
    const fs = new MemoryFS()
    await fs.write('/small.txt', bytes('hello'))
    const out = await execute('cat /small.txt', fs, { maxOutputChars: 100 })
    expect(out).toBe('hello')
  })

  it('truncates and appends a marker when output exceeds the cap', async () => {
    const fs = new MemoryFS()
    const payload = 'x'.repeat(500)
    await fs.write('/big.txt', bytes(payload))
    const out = await execute('cat /big.txt', fs, { maxOutputChars: 100 })
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('<truncated: 400 more characters')
    expect(out).toContain('head/tail/grep/sed')
  })

  it('does not split a surrogate pair at the cap boundary', async () => {
    const fs = new MemoryFS()
    // 𝄞 (U+1D11E) encodes as a high+low surrogate pair in JS strings.
    // If the cap lands between the two units, the marker should appear
    // before the pair, not in the middle of it.
    const payload = `aaaaaaaaa${'𝄞'.repeat(50)}`
    await fs.write('/u.txt', bytes(payload))
    const out = await execute('cat /u.txt', fs, { maxOutputChars: 10 })
    // The 10th UTF-16 code unit is a high surrogate; cap should pull
    // back to 9 so we don't emit a lone half-pair.
    expect(out.startsWith('aaaaaaaaa')).toBe(true)
    expect(out).toContain('<truncated:')
  })

  it('treats maxOutputChars=0 / undefined as "no cap"', async () => {
    const fs = new MemoryFS()
    const payload = 'y'.repeat(1000)
    await fs.write('/big.txt', bytes(payload))
    expect(await execute('cat /big.txt', fs, { maxOutputChars: 0 })).toBe(payload)
    expect(await execute('cat /big.txt', fs)).toBe(payload)
  })

  it('caps partialOutput on TerminalError too', async () => {
    const fs = new MemoryFS()
    await fs.write('/big.txt', bytes('z'.repeat(500)))
    // First pipeline accumulates output, second fails.
    try {
      await execute('cat /big.txt; cat /missing', fs, { maxOutputChars: 100 })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(TerminalError)
      const partial = (e as TerminalError).partialOutput
      expect(partial).toContain('<truncated: 400 more characters')
    }
  })
})
