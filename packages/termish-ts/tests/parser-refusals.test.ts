/**
 * What the parser refuses, with a diagnostic that says where and what to
 * do instead (control flow, function definitions, assignments, `$(...)`
 * and `$((...))`), every one in the script at once, and comments. Ported
 * from termish-py's test_parser.py and test_heredoc.py.
 */

import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { ParseError, TerminalError, execute, toScript } from '../src/index'

const parseError = (script: string): ParseError => {
  try {
    toScript(script)
  } catch (e) {
    if (e instanceof ParseError) return e
    throw e
  }
  throw new Error(`${script} parsed`)
}

describe('control flow', () => {
  it.each([
    ['for', 'xargs or find -exec'],
    ['while', 'xargs or find -exec'],
    ['until', 'xargs or find -exec'],
    ['do', 'xargs or find -exec'],
    ['done', 'xargs or find -exec'],
    ['if', '&& and ||'],
    ['then', '&& and ||'],
    ['elif', '&& and ||'],
    ['else', '&& and ||'],
    ['fi', '&& and ||'],
    ['case', ''],
    ['esac', ''],
  ])('refuses %s in command position', (keyword, advice) => {
    const message = parseError(`${keyword} whatever`).message
    expect(message.startsWith(`line 1, col 1: ${keyword}: control flow is not supported`)).toBe(
      true,
    )
    if (advice) expect(message).toContain(advice)
  })

  it('reports a loop once, not once per keyword', () => {
    expect(parseError('for f in a b; do echo $f; done').message).toBe(
      'line 1, col 1: for: control flow is not supported; use xargs or find -exec for iteration',
    )
    expect(parseError('for f in a b\ndo\n  echo $f\ndone').message).toBe(
      'line 1, col 1: for: control flow is not supported; use xargs or find -exec for iteration',
    )
  })

  it('points a conditional at test and the operators', () => {
    expect(parseError('if [ -f a ]; then echo y; fi').message).toBe(
      'line 1, col 1: if: control flow is not supported; test with [ ... ] and branch with && and || instead',
    )
  })

  it.each([
    'echo x | for f in a; do echo $f; done',
    'echo x; done',
    'echo x && then',
    'echo x || elif',
    '> out.txt while',
    '2>err.txt until',
  ])('refuses a keyword after a separator or redirect: %s', (script) => {
    expect(parseError(script).message).toContain('control flow is not supported')
  })

  it.each([
    ['echo for', 'echo', ['for']],
    ['grep -r done .', 'grep', ['-r', 'done', '.']],
    ['ls if', 'ls', ['if']],
    ['cat then else fi', 'cat', ['then', 'else', 'fi']],
  ])('leaves a keyword as an argument alone: %s', (script, name, args) => {
    const cmd = toScript(script).pipelines[0]?.commands[0]
    expect(cmd?.name).toBe(name)
    expect(cmd?.args).toEqual(args)
  })

  it.each(["'for' x", '"if" x', "'done'"])('lets a quoted keyword be a command: %s', (s) => {
    expect(() => toScript(s)).not.toThrow()
  })

  it('lets a keyword be a redirect target, and a file name', async () => {
    expect(toScript('echo hi > for').pipelines[0]?.commands[0]?.redirects[0]?.target).toBe('for')
    const fs = new MemoryFS()
    await execute('echo hello > for', fs)
    expect(await execute('cat for', fs)).toBe('hello\n')
  })

  it('leaves a heredoc body inert', async () => {
    const out = await execute('cat <<EOF\nfor f in a b; do\n  echo $f\ndone\nEOF', new MemoryFS())
    expect(out).toBe('for f in a b; do\n  echo $f\ndone\n')
  })

  it('is a parse error, not a terminal error', async () => {
    const error = await execute('for f in a; do echo $f; done', new MemoryFS()).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ParseError)
    expect(error).not.toBeInstanceOf(TerminalError)
  })
})

describe('where, and how many', () => {
  it('names the line and column of each, in order', () => {
    expect(parseError('echo a\necho $((2+3))\nN=3\necho "x $(date)"').message).toBe(
      [
        'line 2, col 6: arithmetic expansion $((...)) is not supported; compute it in code',
        "line 3, col 1: N=3: variable assignment is not supported; write the value where it's used, or compute it in code",
        "line 4, col 9: Command substitution '$(...)' is not supported; run the inner command separately",
      ].join('\n'),
    )
  })

  it('counts lines and columns in the script as written', () => {
    // a continuation, a quoted span and a heredoc body before the problem
    const script = 'echo "a b" \\\n  c\ncat <<EOF\nbody\nEOF\n  if x'
    expect(parseError(script).message).toMatch(/^line 6, col 3: if: /)
  })

  it('reports a structural error with the problems before it', () => {
    expect(parseError('N=1\necho a | | b').message).toBe(
      [
        "line 1, col 1: N=1: variable assignment is not supported; write the value where it's used, or compute it in code",
        "line 2, col 10: Expected command after '|', got '|'",
      ].join('\n'),
    )
  })

  it('runs nothing when anything is reported', async () => {
    const fs = new MemoryFS()
    await expect(execute('echo hi > a.txt\necho $((1))', fs)).rejects.toThrow(ParseError)
    expect(await fs.exists('/a.txt')).toBe(false)
  })

  it('sees assignments as a prefix and after a pipe, not as arguments', () => {
    expect(parseError('N=3 echo hi').message).toContain('N=3: variable assignment')
    expect(parseError('echo | X="a b" cat').message).toContain('X="a b": variable assignment')
    expect(() => toScript('echo N=3; env A=1; [ a = b ]')).not.toThrow()
  })

  it('leaves $(...) and $((...)) alone in single quotes and escaped', () => {
    expect(() => toScript("echo '$((1))' \\$(x) '$(y)'")).not.toThrow()
  })
})

describe('background jobs and tab-stripping heredocs', () => {
  it("refuses '&', bash's '&>' included, every one reported", () => {
    expect(parseError('echo a & echo b\nls &> out').message).toBe(
      [
        "line 1, col 8: '&' is not supported: commands run one at a time, in order (for both outputs in one file, use > FILE 2>&1)",
        "line 2, col 4: '&' is not supported: commands run one at a time, in order (for both outputs in one file, use > FILE 2>&1)",
      ].join('\n'),
    )
  })

  it("refuses '&' where a filename or a command is read, too", () => {
    for (const script of ['echo hi > &', 'echo hi | & cat', 'cat < &', 'echo hi 2> &']) {
      expect(parseError(script).message, script).toMatch(/: '&' is not supported: /)
    }
  })

  it("leaves '&' quoted or escaped, '&&' and '2>&1' alone", async () => {
    const fs = new MemoryFS()
    expect(await execute("echo 'a & b' a\\&b && echo ok 2>&1", fs)).toBe('a & b a&b\nok\n')
  })

  it("refuses '<<-', pointing at '<<'", () => {
    expect(parseError('cat <<-EOF\n\thi\n\tEOF').message).toBe(
      "line 1, col 5: '<<-' (a heredoc that strips tabs) is not supported; use '<<', whose closing delimiter may be indented",
    )
  })
})

describe('function definitions', () => {
  it('refuses the function keyword', () => {
    expect(parseError('function greet { echo hi; }').message).toMatch(
      /^line 1, col 1: function: function definitions/,
    )
  })

  it.each(['greet() { echo hi; }', 'greet () { echo hi; }', 'greet( ) { echo hi; }'])(
    'refuses %s',
    (script) => {
      expect(parseError(script).message).toMatch(/^line 1, col 1: greet\(\): function definitions/)
    },
  )

  it('leaves a lone paren argument alone', () => {
    expect(toScript('grep ( file').pipelines[0]?.commands[0]?.args).toEqual(['(', 'file'])
  })
})

describe('comments', () => {
  it('drop a word-start # to the end of the line', async () => {
    const fs = new MemoryFS()
    expect(await execute('echo hi # a comment', fs)).toBe('hi\n')
    expect(await execute('# only a comment\necho next', fs)).toBe('next\n')
  })

  it('may mention command substitution', async () => {
    expect(await execute('echo hi # $(pwd)', new MemoryFS())).toBe('hi\n')
    expect(await execute('# "$(pwd)"\necho next', new MemoryFS())).toBe('next\n')
  })

  it('start after an operator, in the heredoc scanner too', async () => {
    expect(await execute('echo hi;# <<EOF', new MemoryFS())).toBe('hi\n')
    expect(await execute('echo hi &&# <<EOF', new MemoryFS())).toBe('hi\n')
  })

  it('never start a heredoc', async () => {
    expect((await execute('echo hi # <<EOF not a heredoc', new MemoryFS())).trim()).toBe('hi')
  })

  it('leave # inside a word or quotes alone', async () => {
    expect(toScript('cat <<E#F\nbody\nE#F').pipelines[0]?.commands[0]?.redirects[0]?.content).toBe(
      'body\n',
    )
    expect((await execute("echo '#<<EOF literal'", new MemoryFS())).trim()).toBe('#<<EOF literal')
    expect(await execute('echo a#b', new MemoryFS())).toBe('a#b\n')
  })
})
