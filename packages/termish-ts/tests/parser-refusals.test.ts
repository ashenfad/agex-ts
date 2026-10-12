/**
 * What the parser refuses, with one diagnostic that says what to do
 * instead (control flow, function definitions), and comments. Ported from
 * termish-py's test_parser.py and test_heredoc.py.
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
    expect(message.startsWith(`${keyword}: control flow is not supported`)).toBe(true)
    if (advice) expect(message).toContain(advice)
  })

  it('reports a loop once, not once per keyword', () => {
    expect(parseError('for f in a b; do echo $f; done').message).toBe(
      'for: control flow is not supported; use xargs or find -exec for iteration',
    )
  })

  it('points a conditional at test and the operators', () => {
    expect(parseError('if [ -f a ]; then echo y; fi').message).toBe(
      'if: control flow is not supported; test with [ ... ] and branch with && and || instead',
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

describe('function definitions', () => {
  it('refuses the function keyword', () => {
    expect(parseError('function greet { echo hi; }').message).toMatch(
      /^function: function definitions/,
    )
  })

  it.each(['greet() { echo hi; }', 'greet () { echo hi; }', 'greet( ) { echo hi; }'])(
    'refuses %s',
    (script) => {
      expect(parseError(script).message).toMatch(/^greet\(\): function definitions/)
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
