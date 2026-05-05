import { describe, expect, it } from 'vitest'
import { safeStringify, safeStringifyArgs } from '../src/runtime/safe-stringify'

describe('safeStringify — primitives', () => {
  it('strings come out unquoted', () => {
    expect(safeStringify('hello')).toBe('hello')
  })

  it('numbers and booleans stringify naturally', () => {
    expect(safeStringify(42)).toBe('42')
    expect(safeStringify(3.14)).toBe('3.14')
    expect(safeStringify(true)).toBe('true')
    expect(safeStringify(false)).toBe('false')
  })

  it('null and undefined are explicit', () => {
    expect(safeStringify(null)).toBe('null')
    expect(safeStringify(undefined)).toBe('undefined')
  })
})

describe('safeStringify — fringe primitives that throw on naive JSON', () => {
  it('bigint renders with the n suffix', () => {
    expect(safeStringify(123n)).toBe('123n')
  })

  it('symbol renders as Symbol(…)', () => {
    expect(safeStringify(Symbol('mark'))).toBe('Symbol(mark)')
  })

  it('functions render with their name', () => {
    function double(x: number): number {
      return x * 2
    }
    expect(safeStringify(double)).toBe('[Function: double]')
    expect(safeStringify(() => 1)).toMatch(/\[Function/)
  })
})

describe('safeStringify — Error', () => {
  it('renders Error with message + stack', () => {
    const e = new Error('boom')
    const out = safeStringify(e)
    expect(out).toContain('boom')
    expect(out).toMatch(/Error/)
  })

  it('preserves custom Error subclass name', () => {
    class CustomError extends Error {
      constructor() {
        super('custom')
        this.name = 'CustomError'
      }
    }
    const out = safeStringify(new CustomError())
    expect(out).toContain('custom')
  })

  it('errors nested in objects survive serialization', () => {
    const obj = { reason: new Error('nested boom') }
    const out = safeStringify(obj)
    expect(out).toContain('nested boom')
    expect(out).toContain('"name"')
  })
})

describe('safeStringify — circular references', () => {
  it('does not throw on direct self-reference', () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    const out = safeStringify(obj)
    expect(out).toContain('Circular')
    expect(out).toContain('"a":1')
  })

  it('handles indirect cycles', () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { backref: a }
    a.b = b
    expect(() => safeStringify(a)).not.toThrow()
  })
})

describe('safeStringify — objects and arrays', () => {
  it('JSON-shaped output for plain objects', () => {
    expect(safeStringify({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}')
  })

  it('arrays render via JSON', () => {
    expect(safeStringify([1, 2, 3])).toBe('[1,2,3]')
  })

  it('undefined inside objects becomes <undefined>', () => {
    const out = safeStringify({ a: undefined })
    expect(out).toContain('<undefined>')
  })

  it('bigint inside objects renders with n suffix', () => {
    const out = safeStringify({ count: 9_000_000_000_000_000_001n })
    expect(out).toContain('9000000000000000001n')
  })
})

describe('safeStringify — char-budget truncation', () => {
  it('long values truncate with a "[truncated]" marker', () => {
    const long = 'x'.repeat(10_000)
    const out = safeStringify(long, { maxChars: 100 })
    expect(out.length).toBeLessThan(200)
    expect(out).toContain('[truncated, 9900 more chars]')
    expect(out.startsWith('xxx')).toBe(true)
  })

  it('short values pass through unchanged', () => {
    const out = safeStringify('short', { maxChars: 100 })
    expect(out).toBe('short')
  })

  it('default budget protects against huge buffers', () => {
    const huge = 'a'.repeat(1_000_000)
    const out = safeStringify(huge)
    // Default budget is 4000 — leave a bit of headroom for the marker
    expect(out.length).toBeLessThan(4_200)
  })
})

describe('safeStringifyArgs — multi-arg console.log shape', () => {
  it('joins args with single spaces, console.log style', () => {
    expect(safeStringifyArgs(['hello', 42, true])).toBe('hello 42 true')
  })

  it('per-arg truncation (one huge arg does not starve later ones)', () => {
    const huge = 'x'.repeat(10_000)
    const out = safeStringifyArgs([huge, 'after'], { maxChars: 100 })
    expect(out).toContain('[truncated')
    expect(out.endsWith(' after')).toBe(true)
  })

  it('mixed primitives + objects + errors do not throw', () => {
    const out = safeStringifyArgs([
      'level=',
      'info',
      { user: { id: 1n }, ts: undefined },
      new Error('soft fail'),
    ])
    expect(out).toContain('level=')
    expect(out).toContain('1n')
    expect(out).toContain('<undefined>')
    expect(out).toContain('soft fail')
  })
})
