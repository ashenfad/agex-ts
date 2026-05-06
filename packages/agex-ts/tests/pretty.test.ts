import { describe, expect, it } from 'vitest'
import { prettyEvents, prettyTokens } from '../src/pretty'
import type { ActionEvent, AgentEvent, TokenChunk } from '../src/types'

function capture(): { write: (s: string) => void; out: () => string } {
  const buf: string[] = []
  return { write: (s: string) => buf.push(s), out: () => buf.join('') }
}

function tk(t: Partial<TokenChunk> & { type: TokenChunk['type'] }): TokenChunk {
  return {
    content: '',
    done: false,
    emissionIndex: 0,
    ...t,
  }
}

describe('prettyTokens', () => {
  it('writes a header for toolStart and streams ts content inline', () => {
    const { write, out } = capture()
    prettyTokens(tk({ type: 'toolStart', content: 'ts_action', done: true }), { write })
    prettyTokens(tk({ type: 'ts', content: 'task' }), { write })
    prettyTokens(tk({ type: 'ts', content: 'Success(' }), { write })
    prettyTokens(tk({ type: 'ts', content: '1)' }), { write })
    prettyTokens(tk({ type: 'emission', done: true, content: '' }), { write })
    expect(out()).toBe('\n[ts_action]\ntaskSuccess(1)\n')
  })

  it('streams thinking and text content inline', () => {
    const { write, out } = capture()
    prettyTokens(tk({ type: 'thinking', content: 'plan ' }), { write })
    prettyTokens(tk({ type: 'thinking', content: 'first' }), { write })
    prettyTokens(tk({ type: 'text', content: ' aside' }), { write })
    expect(out()).toBe('plan first aside')
  })

  it('streams title content as deltas arrive and closes with a newline', () => {
    // Mirrors how the JsonStringExtractor delivers string-valued
    // tool args: per-chunk `done: false` deltas followed by an
    // empty `done: true` closer.
    const { write, out } = capture()
    prettyTokens(tk({ type: 'title', content: 'Compute ' }), { write })
    prettyTokens(tk({ type: 'title', content: 'answer' }), { write })
    prettyTokens(tk({ type: 'title', content: '', done: true }), { write })
    expect(out()).toBe('Compute answer\n')
  })

  it('handles an empty title (just the closer) without writing stray text', () => {
    const { write, out } = capture()
    prettyTokens(tk({ type: 'title', content: '', done: true }), { write })
    expect(out()).toBe('\n')
  })

  it('labels filePath / fileSearch as content streams; closes with newline; streams fileContent inline', () => {
    const { write, out } = capture()
    // filePath streams as a single content chunk (Gemini sends the
    // whole JSON in one ArgDelta) followed by a done:true closer.
    prettyTokens(tk({ type: 'filePath', content: '/n.txt' }), { write })
    prettyTokens(tk({ type: 'filePath', content: '', done: true }), { write })
    prettyTokens(tk({ type: 'fileSearch', content: 'old' }), { write })
    prettyTokens(tk({ type: 'fileSearch', content: '', done: true }), { write })
    prettyTokens(tk({ type: 'fileContent', content: 'new ' }), { write })
    prettyTokens(tk({ type: 'fileContent', content: 'value' }), { write })
    expect(out()).toBe('\npath: /n.txt\n\nsearch: old\nnew value')
  })

  it('skips signature tokens (opaque)', () => {
    const { write, out } = capture()
    prettyTokens(
      tk({ type: 'signature', content: '', done: true, signature: new Uint8Array([1, 2]) }),
      { write },
    )
    expect(out()).toBe('')
  })

  it('uses the default writer when none is given', () => {
    // Just exercise the default path — proves no exception.
    expect(() => prettyTokens(tk({ type: 'emission', done: true, content: '' }))).not.toThrow()
  })
})

describe('prettyEvents', () => {
  function captureLines(): { write: (l: string) => void; lines: () => string[] } {
    const out: string[] = []
    return { write: (l: string) => out.push(l), lines: () => out }
  }

  const ts = '2026-05-05T00:00:00.000Z'

  it('formats taskStart with the task name', () => {
    const { write, lines } = captureLines()
    prettyEvents(
      { type: 'taskStart', timestamp: ts, agentName: 'a', taskName: 'compute', inputs: null },
      { write },
    )
    expect(lines()).toEqual(['[taskStart] compute'])
  })

  it('formats action emissions per type with appropriate prefixes', () => {
    const action: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [
        { type: 'thinking', text: 'plan' },
        { type: 'ts', code: 'taskSuccess(1)' },
        { type: 'terminal', commands: 'ls /' },
        { type: 'fileWrite', path: '/n', content: 'hi', mode: 'append' },
        { type: 'fileEdit', path: '/n', search: 'a', content: 'b' },
        { type: 'text', text: 'aside' },
      ],
    }
    const { write, lines } = captureLines()
    prettyEvents(action, { write })
    expect(lines()).toEqual([
      '[thinking] plan',
      '[ts]\n  taskSuccess(1)',
      '[terminal] ls /',
      '[fileWrite] /n (append)',
      '[fileEdit] /n',
      '[text] aside',
    ])
  })

  it('surfaces ts/terminal titles when present', () => {
    const action: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [
        { type: 'ts', code: 'taskSuccess(1)', title: 'Compute answer' },
        { type: 'terminal', commands: 'ls /', title: 'Glance at root' },
      ],
    }
    const { write, lines } = captureLines()
    prettyEvents(action, { write })
    expect(lines()).toEqual([
      '[ts] Compute answer\n  taskSuccess(1)',
      '[terminal] Glance at root ls /',
    ])
  })

  it('formats output text and image parts', () => {
    const { write, lines } = captureLines()
    prettyEvents(
      {
        type: 'output',
        timestamp: ts,
        agentName: 'a',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'image', format: 'png', data: 'b64' },
        ],
      },
      { write },
    )
    expect(lines()).toEqual(['[stdout] hello', '[stdout] <image png>'])
  })

  it('formats terminal events (success/fail/clarify/cancelled/error)', () => {
    const { write, lines } = captureLines()
    const events: AgentEvent[] = [
      { type: 'success', timestamp: ts, agentName: 'a', result: 1 },
      { type: 'fail', timestamp: ts, agentName: 'a', message: 'nope' },
      { type: 'clarify', timestamp: ts, agentName: 'a', message: 'huh?' },
      {
        type: 'cancelled',
        timestamp: ts,
        agentName: 'a',
        taskName: 't',
        iterationsCompleted: 3,
      },
      {
        type: 'error',
        timestamp: ts,
        agentName: 'a',
        errorName: 'TypeError',
        errorMessage: 'bad',
        recoverable: true,
      },
    ]
    for (const e of events) prettyEvents(e, { write })
    expect(lines()).toEqual([
      '[success]',
      '[fail] nope',
      '[clarify] huh?',
      '[cancelled] t after 3 iterations',
      '[error] TypeError: bad',
    ])
  })

  it('caps overly long bodies with a tail marker', () => {
    const { write, lines } = captureLines()
    const big = 'x'.repeat(50)
    prettyEvents(
      {
        type: 'action',
        timestamp: ts,
        agentName: 'a',
        emissions: [{ type: 'thinking', text: big }],
      },
      { write, maxBody: 10 },
    )
    expect(lines()[0]).toBe(`[thinking] xxxxxxxxxx…(${50 - 10} more)`)
  })
})
