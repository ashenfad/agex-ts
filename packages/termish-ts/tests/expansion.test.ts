/**
 * Variable expansion: `$?`, `$NAME`, `${NAME}`. Ported from termish-py's
 * test_expansion.py.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { type CommandHandler, ParseError, TerminalError, execute } from '../src/index'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

let fs: MemoryFS
beforeEach(() => {
  fs = new MemoryFS()
})

describe('$?', () => {
  it('is 0 after a success', async () => {
    expect(await execute('true; echo $?', fs)).toBe('0\n')
  })

  it('is 1 after a failure', async () => {
    expect(await execute('false; echo $?', fs)).toBe('1\n')
  })

  it('is 127 for a command not found', async () => {
    expect(await execute('nosuchcmd; echo $?', fs)).toBe('nosuchcmd: command not found\n127\n')
  })

  it('is 1 for a missing file, after its diagnostic', async () => {
    expect(await execute('cat /missing; echo exit=$?', fs)).toMatch(
      /^cat: \/missing: .*\nexit=1\n$/,
    )
  })

  it('expands in double quotes, not single', async () => {
    expect(await execute('false; echo "code: $?"', fs)).toBe('code: 1\n')
    expect(await execute("false; echo '$?'", fs)).toBe('$?\n')
  })

  it('starts at 0, and resets after a success', async () => {
    expect(await execute('echo $?', fs)).toBe('0\n')
    expect(await execute('false; true; echo $?', fs)).toBe('0\n')
  })

  it('is the exit of the command that rescued a failure', async () => {
    expect(await execute('false || true; echo $?', fs)).toBe('0\n')
  })

  it("is a command's own exit code", async () => {
    const curl: CommandHandler = async (ctx) => {
      if (ctx.args.some((a) => a.startsWith('--'))) {
        return { exitCode: 2, stderr: 'unrecognized option' }
      }
      ctx.stdout.write('ok\n')
      return undefined
    }
    const out = await execute('curl --max-time 5 x; echo exit=$?', fs, { commands: { curl } })
    expect(out).toBe('unrecognized option\nexit=2\n')
  })

  it('expands before glob detection', async () => {
    await fs.write('/x', bytes('')) // a one-char name `?` would match
    expect(await execute('true; echo $?', fs)).toBe('0\n')
  })
})

describe('$NAME and ${NAME}', () => {
  it('expand from env', async () => {
    expect(await execute('echo $NAME', fs, { env: { NAME: 'alice' } })).toBe('alice\n')
    expect(await execute('echo ${NAME}x', fs, { env: { NAME: 'alice' } })).toBe('alicex\n')
  })

  it('expand in double quotes, not single', async () => {
    expect(await execute('echo "hi $NAME"', fs, { env: { NAME: 'alice' } })).toBe('hi alice\n')
    expect(await execute("echo '$NAME'", fs, { env: { NAME: 'alice' } })).toBe('$NAME\n')
  })

  it('stop the script at an unset variable, as under set -u', async () => {
    await expect(execute('echo "[$UNSET]"', fs)).rejects.toThrow('UNSET: unbound variable')
    const err = await execute('echo before; rm -r $UNSET/x; echo after', fs).catch((e) => e)
    expect(err).toBeInstanceOf(TerminalError)
    expect(err.message).toBe('UNSET: unbound variable')
    expect(err.exitCode).toBe(1)
    expect(err.partialOutput).toBe('before\n')
    // nothing after it runs, not even a rescue
    await expect(execute('echo ${UNSET} || echo rescued', fs)).rejects.toThrow('unbound')
  })

  it('give a default for one that may be unset', async () => {
    expect(await execute('echo "[${UNSET:-}]"', fs)).toBe('[]\n')
    expect(await execute('echo ${UNSET:-fallback} ${UNSET-dash}', fs)).toBe('fallback dash\n')
    const env = { EMPTY: '', NAME: 'alice' }
    expect(await execute('echo "[${EMPTY:-x}] [${EMPTY-x}]"', fs, { env })).toBe('[x] []\n')
    expect(await execute('echo ${NAME:-x} ${UNSET:-$NAME}', fs, { env })).toBe('alice alice\n')
  })

  it('remove an unquoted word that expands to nothing', async () => {
    expect(await execute('echo a $EMPTY b', fs, { env: { EMPTY: '' } })).toBe('a b\n')
  })

  it('have $PWD as the current directory, whatever the env says', async () => {
    await execute('mkdir -p /w/sub', fs)
    const env = { PWD: '/elsewhere' }
    expect(await execute('cd /w; echo $PWD; cd sub && echo "${PWD}"', fs, { env })).toBe(
      '/w\n/w/sub\n',
    )
  })

  it('follow the double-quote backslash rule', async () => {
    const env = { NAME: 'alice' }
    expect(await execute('echo "\\$NAME"', fs, { env })).toBe('$NAME\n')
    expect(await execute('echo "\\\\$NAME"', fs, { env })).toBe('\\alice\n')
    expect(await execute('echo "a\\\\b"', fs)).toBe('a\\b\n')
    expect(await execute('echo "a\\.b"', fs)).toBe('a\\.b\n')
  })

  it('expand in redirect targets', async () => {
    await execute('echo hi > $OUT', fs, { env: { OUT: '/o.txt' } })
    expect(text(await fs.read('/o.txt'))).toBe('hi\n')
    await fs.write('/in.txt', bytes('data\n'))
    expect(await execute('cat < $IN', fs, { env: { IN: '/in.txt' } })).toBe('data\n')
  })

  it('expand in the command name, and an empty name shifts away', async () => {
    expect(await execute('$CMD hello', fs, { env: { CMD: 'echo' } })).toBe('hello\n')
    expect(await execute('$EMPTY echo hi', fs, { env: { EMPTY: '' } })).toBe('hi\n')
  })

  it('make a command of nothing a silent no-op', async () => {
    const env = { EMPTY: '' }
    expect(await execute('$EMPTY', fs, { env })).toBe('')
    expect(await execute('$EMPTY; echo $?', fs, { env })).toBe('0\n')
  })

  it('never split a value with spaces into words', async () => {
    const out = await execute('$CMD; echo $?', fs, { env: { CMD: 'echo hello' } })
    expect(out).toBe('echo hello: command not found\n127\n')
    await fs.write('/f.txt', bytes('a b\nc\n'))
    expect(await execute('grep $PAT /f.txt', fs, { env: { PAT: 'a b' } })).toBe('a b\n')
  })

  it('glob an expanded value', async () => {
    await fs.write('/a.txt', bytes(''))
    await fs.write('/b.txt', bytes(''))
    const out = await execute('echo $PAT', fs, { env: { PAT: '*.txt' } })
    expect(out.split(/\s+/).filter(Boolean).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('share the env with later commands and the caller', async () => {
    const setvar: CommandHandler = async (ctx) => {
      ctx.env.FOO = 'bar'
    }
    expect(await execute('setvar; echo $FOO', fs, { commands: { setvar } })).toBe('bar\n')
    const env: Record<string, string> = {}
    await execute('setvar', fs, { commands: { setvar }, env })
    expect(env).toEqual({ FOO: 'bar' })
  })
})

describe('an unquoted backslash', () => {
  it('keeps an escaped $ literal', async () => {
    expect(await execute('echo \\$NAME', fs, { env: { NAME: 'alice' } })).toBe('$NAME\n')
    expect(await execute('echo \\${NAME}', fs, { env: { NAME: 'alice' } })).toBe('${NAME}\n')
  })

  it('escapes itself before an expansion', async () => {
    expect(await execute('echo \\\\$NAME', fs, { env: { NAME: 'alice' } })).toBe('\\alice\n')
  })

  it('still escapes other characters', async () => {
    expect(await execute('echo a\\ b', fs)).toBe('a b\n')
    expect(await execute('echo a\\\\b', fs)).toBe('a\\b\n')
  })

  it('makes an escaped $( a literal, not a substitution', async () => {
    expect(await execute('echo \\$(pwd)', fs)).toBe('$(pwd)\n')
  })
})

describe('forms with $ that stay literal', () => {
  it('keeps a trailing anchor and $1', async () => {
    await fs.write('/f.txt', bytes('foo\nfoobar\n'))
    expect(await execute('grep foo$ /f.txt', fs)).toBe('foo\n')
    expect(await execute('echo $1', fs)).toBe('$1\n')
  })

  it('refuses command substitution, unless single-quoted', async () => {
    await expect(execute('echo $(pwd)', fs)).rejects.toThrow(ParseError)
    await expect(execute('echo "now: $(pwd)"', fs)).rejects.toThrow(/Command substitution/)
    expect(await execute("echo '$(pwd)'", fs)).toBe('$(pwd)\n')
  })

  it('never expands a heredoc body', async () => {
    const out = await execute('cat <<EOF\nhi $NAME\nEOF', fs, { env: { NAME: 'alice' } })
    expect(out).toBe('hi $NAME\n')
  })
})

describe('end to end', () => {
  it('runs the curl line an agent wrote', async () => {
    const curl: CommandHandler = async (ctx) => {
      ctx.stdout.write('{"status":"ok"}\n')
    }
    await fs.mkdir('/app', { parents: true })
    const out = await execute(
      "cd /app && curl -v 'api/overview' 2>&1 | head -30; " + 'echo "=== EXIT $? ==="',
      fs,
      { commands: { curl } },
    )
    expect(out).toBe('{"status":"ok"}\n=== EXIT 0 ===\n')
  })

  it('still throws when the last pipeline fails', async () => {
    const error = await execute('echo start; cat /missing', fs).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TerminalError)
    expect((error as TerminalError).partialOutput).toBe('start\n')
    expect((error as TerminalError).exitCode).toBe(1)
  })
})

describe('escapes and quotes', () => {
  it('an escaped operator character is a word, never the operator', async () => {
    expect(await execute('echo a \\; | wc -c', fs)).toBe('4\n')
    expect(await execute('echo a \\| b', fs)).toBe('a | b\n')
    expect(await execute('echo \\>', fs)).toBe('>\n')
    expect(await execute('echo \\&', fs)).toBe('&\n')
  })

  it("find -exec's \\; may be followed by a pipe", async () => {
    await fs.mkdir('/d')
    await fs.write('/d/a.t', bytes('a\n'))
    await fs.write('/d/b.t', bytes('b\n'))
    expect(await execute("find /d -name '*.t' -exec cat {} \\; | wc -l", fs)).toBe('2\n')
  })

  it('an escaped glob character is literal', async () => {
    await fs.write('/a.txt', bytes('a'))
    expect(await execute('echo \\*', fs)).toBe('*\n')
    expect(await execute('echo a\\?', fs)).toBe('a?\n')
  })

  it('a quote after an even run of backslashes opens', async () => {
    expect(await execute("echo \\\\'$NAME'", fs, { env: { NAME: 'x' } })).toBe('\\$NAME\n')
    // after an odd run it is escaped
    expect(await execute("echo \\\\\\'x", fs)).toBe("\\'x\n")
    expect(await execute("echo \\'", fs)).toBe("'\n")
    expect(await execute('echo \\"q', fs)).toBe('"q\n')
  })

  it('an escaped space still joins a word', async () => {
    expect(await execute('echo a\\ b', fs)).toBe('a b\n')
  })
})

describe('braces', () => {
  it('refuse to make more words than the limit', async () => {
    await expect(execute('echo {1..200000}', fs)).rejects.toThrow('brace expansion: more than')
    await expect(
      execute(
        'echo {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}',
        fs,
      ),
    ).rejects.toThrow('brace expansion: more than')
  })

  it('expand in the command name', async () => {
    expect(await execute('{echo,hi}', fs)).toBe('hi\n')
  })
})
