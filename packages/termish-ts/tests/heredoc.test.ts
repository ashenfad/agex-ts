import { describe, expect, it } from 'vitest'
import type { CommandHandler } from '../src/context'
import { ParseError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'
import { toScript } from '../src/parser'

const decoder = new TextDecoder()

describe('heredoc parsing', () => {
  it('stores a basic literal body on the redirect', () => {
    const script = toScript('cat <<EOF\nhello\nworld\nEOF')
    expect(script.pipelines[0]?.commands[0]?.redirects).toEqual([
      {
        type: '<<',
        target: 'EOF',
        content: 'hello\nworld\n',
      },
    ])
  })

  it.each(["<<'EOF'", '<<"EOF"', "<< 'EOF'"])('accepts quoted delimiter form %s', (form) => {
    const script = toScript(`cat ${form}\nbody\nEOF`)
    expect(script.pipelines[0]?.commands[0]?.redirects[0]).toEqual({
      type: '<<',
      target: 'EOF',
      content: 'body\n',
    })
  })

  it('accepts an empty body', () => {
    const script = toScript('cat <<EOF\nEOF')
    expect(script.pipelines[0]?.commands[0]?.redirects[0]?.content).toBe('')
  })

  it('keeps quotes and shell operators inside the body inert', () => {
    const body = 'a | b > c ; \'quoted\' "double" && <<nested\n'
    const script = toScript(`cat <<END\n${body}END`)
    expect(script.pipelines[0]?.commands[0]?.redirects[0]?.content).toBe(body)
  })

  it('accepts an indented delimiter', () => {
    const script = toScript('cat <<EOF\nbody\n    EOF')
    expect(script.pipelines[0]?.commands[0]?.redirects[0]?.content).toBe('body\n')
  })

  it('ignores a heredoc-looking operator inside quotes', () => {
    const script = toScript("echo '<<EOF not a heredoc'")
    expect(script.pipelines[0]?.commands[0]?.redirects).toEqual([])
  })

  it('tracks quoted spans across lines while finding later heredocs', () => {
    const script = toScript('echo "first\n<<NOT_A_HEREDOC"; cat <<EOF\nbody\nEOF')
    expect(script.pipelines[0]?.commands[0]?.redirects).toEqual([])
    expect(script.pipelines[1]?.commands[0]?.redirects[0]?.content).toBe('body\n')
  })

  it('rejects a missing delimiter', () => {
    expect(() => toScript('cat <<\nbody\nEOF')).toThrow(
      new ParseError("Expected delimiter after '<<'"),
    )
  })

  it('rejects an unterminated body with the expected delimiter', () => {
    expect(() => toScript('cat <<EOF\nno end in sight')).toThrow(
      "Unterminated heredoc: expected 'EOF' before end of input",
    )
  })
})

describe('heredoc execution', () => {
  it('feeds literal input to cat', async () => {
    const out = await execute('cat <<EOF\nline one\nline two\nEOF', new MemoryFS())
    expect(out).toBe('line one\nline two\n')
  })

  it('feeds a pipeline', async () => {
    const out = await execute('cat <<EOF | sort\nbanana\napple\nEOF', new MemoryFS())
    expect(out).toBe('apple\nbanana\n')
  })

  it('supports direct multiline file writes with output redirection', async () => {
    const fs = new MemoryFS()
    const out = await execute(
      "cat <<'TS' > /app.ts\nexport const answer = 42\nconsole.log(answer)\nTS",
      fs,
    )
    expect(out).toBe('')
    expect(decoder.decode(await fs.read('/app.ts'))).toBe(
      'export const answer = 42\nconsole.log(answer)\n',
    )
  })

  it('supports the tee write idiom', async () => {
    const fs = new MemoryFS()
    await execute("tee /script.ts <<'TS'\nconsole.log('hello')\nTS", fs)
    expect(decoder.decode(await fs.read('/script.ts'))).toBe("console.log('hello')\n")
  })

  it('continues with commands after the heredoc pipeline', async () => {
    const out = await execute('cat <<EOF && echo done\npayload\nEOF', new MemoryFS())
    expect(out).toBe('payload\ndone\n')
  })

  it('consumes multiple heredoc bodies in command order', async () => {
    const out = await execute('cat <<A; cat <<B\nfirst\nA\nsecond\nB', new MemoryFS())
    expect(out).toBe('first\nsecond\n')
  })

  it('uses the last input redirect', async () => {
    const fs = new MemoryFS()
    await fs.write('/from-file', new TextEncoder().encode('file input\n'))
    expect(await execute('cat <<EOF < /from-file\nheredoc input\nEOF', fs)).toBe('file input\n')
    expect(await execute('cat < /from-file <<EOF\nheredoc input\nEOF', fs)).toBe('heredoc input\n')
  })

  it('delivers stdin to injected commands', async () => {
    const shout: CommandHandler = async (ctx) => {
      ctx.stdout.write(ctx.stdin.toUpperCase())
    }
    const out = await execute('shout <<EOF\nquiet words\nEOF', new MemoryFS(), {
      commands: { shout },
    })
    expect(out).toBe('QUIET WORDS\n')
  })

  it('joins command-line continuations without touching body backslashes', async () => {
    const out = await execute(
      'cat <<EOF \\\n | tr a-z A-Z\nC:\\path\\\nnext line\nEOF',
      new MemoryFS(),
    )
    expect(out).toBe('C:\\PATH\\\nNEXT LINE\n')
  })
})
