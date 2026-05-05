import { describe, expect, it } from 'vitest'
import { ParseError } from '../src/errors'
import { toScript } from '../src/parser'

describe('toScript — empty / whitespace input', () => {
  it('returns an empty Script for empty string', () => {
    const s = toScript('')
    expect(s.pipelines).toEqual([])
    expect(s.operators).toEqual([])
  })

  it('returns an empty Script for whitespace-only input', () => {
    const s = toScript('   \t\n  ')
    expect(s.pipelines).toEqual([])
  })
})

describe('toScript — single command', () => {
  it('parses a bare command with no args', () => {
    const s = toScript('ls')
    expect(s.pipelines).toHaveLength(1)
    expect(s.pipelines[0]?.commands).toHaveLength(1)
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.name).toBe('ls')
    expect(cmd?.args).toEqual([])
    expect(cmd?.redirects).toEqual([])
  })

  it('parses a command with multiple args', () => {
    const s = toScript('ls -la /tmp')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.name).toBe('ls')
    expect(cmd?.args).toEqual(['-la', '/tmp'])
  })
})

describe('toScript — pipes', () => {
  it('parses a single pipe', () => {
    const s = toScript('ls | grep .ts')
    expect(s.pipelines).toHaveLength(1)
    expect(s.pipelines[0]?.commands).toHaveLength(2)
    expect(s.pipelines[0]?.commands[0]?.name).toBe('ls')
    expect(s.pipelines[0]?.commands[1]?.name).toBe('grep')
    expect(s.pipelines[0]?.commands[1]?.args).toEqual(['.ts'])
  })

  it('parses multiple pipes', () => {
    const s = toScript('cat foo | grep bar | wc -l')
    const cmds = s.pipelines[0]?.commands
    expect(cmds).toHaveLength(3)
    expect(cmds?.map((c) => c.name)).toEqual(['cat', 'grep', 'wc'])
  })

  it('errors on a trailing pipe', () => {
    expect(() => toScript('ls |')).toThrow(ParseError)
  })

  it('errors on a leading pipe', () => {
    expect(() => toScript('| ls')).toThrow(ParseError)
  })

  it('errors on a pipe immediately after another pipe', () => {
    expect(() => toScript('ls | | grep')).toThrow(ParseError)
  })
})

describe('toScript — operators', () => {
  it('parses a semicolon sequence', () => {
    const s = toScript('cd /tmp; ls')
    expect(s.pipelines).toHaveLength(2)
    expect(s.operators).toEqual([';'])
  })

  it('parses && (AND-then)', () => {
    const s = toScript('cd /tmp && ls')
    expect(s.operators).toEqual(['&&'])
  })

  it('parses || (OR-else)', () => {
    const s = toScript('false || echo nope')
    expect(s.operators).toEqual(['||'])
  })

  it('parses mixed operators', () => {
    const s = toScript('cd dir && ls -la | grep .ts; echo done')
    expect(s.pipelines).toHaveLength(3)
    expect(s.operators).toEqual(['&&', ';'])
  })

  it('treats newlines as ; separators between pipelines', () => {
    const s = toScript('cd /tmp\nls -la')
    expect(s.pipelines).toHaveLength(2)
    expect(s.operators).toEqual([';'])
  })
})

describe('toScript — redirects', () => {
  it('parses a > redirect', () => {
    const s = toScript('cat foo > out')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.redirects).toEqual([{ type: '>', target: 'out' }])
  })

  it('parses a >> redirect', () => {
    const s = toScript('echo hi >> log.txt')
    expect(s.pipelines[0]?.commands[0]?.redirects).toEqual([{ type: '>>', target: 'log.txt' }])
  })

  it('parses a < redirect', () => {
    const s = toScript('cat < input.txt')
    expect(s.pipelines[0]?.commands[0]?.redirects).toEqual([{ type: '<', target: 'input.txt' }])
  })

  it('discards 2> stderr redirects (no separate stderr stream)', () => {
    const s = toScript('grep foo file 2> /dev/null')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.args).toEqual(['foo', 'file']) // the literal "2" was popped
    expect(cmd?.redirects).toEqual([]) // redirect itself discarded
  })

  it('discards 2>&1 fd merge', () => {
    const s = toScript('cmd arg 2>&1')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.args).toEqual(['arg'])
    expect(cmd?.redirects).toEqual([])
  })

  it("treats '2' followed by space + '>' as a regular arg + redirect (not fd-2)", () => {
    // `echo 2 > file` should write the literal "2" to `file`,
    // not be interpreted as a fd-2 redirect.
    const s = toScript('echo 2 > file')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.args).toEqual(['2'])
    expect(cmd?.redirects).toEqual([{ type: '>', target: 'file' }])
  })

  it('handles 2>>file (append fd-2 redirect)', () => {
    const s = toScript('grep foo file 2>>err.log')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.args).toEqual(['foo', 'file'])
    expect(cmd?.redirects).toEqual([])
  })

  it('errors on > with no target', () => {
    expect(() => toScript('cat foo >')).toThrow(ParseError)
  })

  it('errors on > followed by another operator', () => {
    expect(() => toScript('cat foo > | grep')).toThrow(ParseError)
  })
})

describe('toScript — quoting', () => {
  it('preserves spaces inside double quotes as one arg', () => {
    const s = toScript('echo "hello world"')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.name).toBe('echo')
    // args contain the masked-and-unmasked form — quotes are preserved
    // until execution time when unmaskAndUnquote runs.
    expect(cmd?.args).toEqual(['"hello world"'])
  })

  it('preserves spaces inside single quotes as one arg', () => {
    const s = toScript("echo 'foo bar baz'")
    expect(s.pipelines[0]?.commands[0]?.args).toEqual(["'foo bar baz'"])
  })

  it('preserves quoted wildcards as literal (vs glob expansion later)', () => {
    // The quoting is preserved through parsing so the interpreter can
    // distinguish `grep '*' f` (literal) from `grep * f` (glob).
    const s = toScript("grep '*' file")
    expect(s.pipelines[0]?.commands[0]?.args).toEqual(["'*'", 'file'])
  })

  it('handles mixed quoted and unquoted args', () => {
    const s = toScript('cmd "with space" plain "another one"')
    expect(s.pipelines[0]?.commands[0]?.args).toEqual(['"with space"', 'plain', '"another one"'])
  })
})

describe('toScript — line continuation', () => {
  it('joins lines on backslash-newline', () => {
    const s = toScript('git add \\\n  file1.txt \\\n  file2.txt')
    const cmd = s.pipelines[0]?.commands[0]
    expect(cmd?.name).toBe('git')
    expect(cmd?.args).toEqual(['add', 'file1.txt', 'file2.txt'])
  })
})

describe('toScript — backslash escape outside quotes', () => {
  it('treats backslash-space as a single arg with a space', () => {
    const s = toScript('cat file\\ name')
    expect(s.pipelines[0]?.commands[0]?.args).toEqual(['file name'])
  })
})

describe('toScript — combined fixtures', () => {
  it('parses a realistic agent pipeline', () => {
    const s = toScript('cd src && grep -r "TODO" . | head -n 5 > todos.txt')
    expect(s.pipelines).toHaveLength(2)
    expect(s.operators).toEqual(['&&'])
    const second = s.pipelines[1]
    expect(second?.commands).toHaveLength(2)
    expect(second?.commands[0]?.name).toBe('grep')
    expect(second?.commands[0]?.args).toEqual(['-r', '"TODO"', '.'])
    expect(second?.commands[1]?.name).toBe('head')
    expect(second?.commands[1]?.args).toEqual(['-n', '5'])
    expect(second?.commands[1]?.redirects).toEqual([{ type: '>', target: 'todos.txt' }])
  })
})
