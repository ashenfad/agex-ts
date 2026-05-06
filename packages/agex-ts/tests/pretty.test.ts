import { describe, expect, it } from 'vitest'
import { prettyTokens } from '../src/pretty'
import type { TokenChunk } from '../src/types'

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

  it('emits a one-line title only on done', () => {
    const { write, out } = capture()
    prettyTokens(tk({ type: 'title', content: 'work' }), { write })
    expect(out()).toBe('')
    prettyTokens(tk({ type: 'title', content: 'work', done: true }), { write })
    expect(out()).toBe('# work\n')
  })

  it('labels filePath / fileSearch on done; streams fileContent inline', () => {
    const { write, out } = capture()
    prettyTokens(tk({ type: 'filePath', content: '/n.txt', done: true }), { write })
    prettyTokens(tk({ type: 'fileSearch', content: 'old', done: true }), { write })
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
