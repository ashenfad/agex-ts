import { describe, expect, it } from 'vitest'
import { RegistrationError } from '../src/errors'
import { PolicyBuilder, memberAllowed } from '../src/policy'

describe('PolicyBuilder — registerFn', () => {
  it('records a function with description-presence flag', () => {
    const p = new PolicyBuilder()
    p.registerFn('greet', { fn: () => 'hi', description: 'Greet someone.' })
    const snap = p.snapshot()
    expect(snap.fns.get('greet')?.description).toBe('Greet someone.')
    expect(snap.fns.get('greet')?.kind).toBe('fn')
  })

  it('description-less registration is allowed but has no description', () => {
    const p = new PolicyBuilder()
    p.registerFn('hidden', { fn: () => null })
    expect(p.snapshot().fns.get('hidden')?.description).toBeUndefined()
  })

  it('rejects invalid identifiers', () => {
    const p = new PolicyBuilder()
    expect(() => p.registerFn('not a name', { fn: () => null })).toThrow(RegistrationError)
    expect(() => p.registerFn('1numeric', { fn: () => null })).toThrow(RegistrationError)
  })
})

describe('PolicyBuilder — name uniqueness across kinds', () => {
  it('rejects re-registration under any kind', () => {
    const p = new PolicyBuilder()
    p.registerFn('shared', { fn: () => null })
    expect(() => p.registerSkill('shared', '...')).toThrow(/already registered as a fn/)
    expect(() => p.registerNamespace('shared', { target: {} })).toThrow(/already registered/)
  })
})

describe('PolicyBuilder — registerTerminal', () => {
  it('requires a description', () => {
    const p = new PolicyBuilder()
    expect(() =>
      p.registerTerminal('beep', {
        handler: async () => undefined,
      }),
    ).toThrow(/description is required/)
  })

  it('requires a function handler', () => {
    const p = new PolicyBuilder()
    expect(() =>
      // @ts-expect-error — intentionally wrong handler type
      p.registerTerminal('beep', { description: 'x', handler: 'not a fn' }),
    ).toThrow(/must be a function/)
  })

  it('records a valid terminal', () => {
    const p = new PolicyBuilder()
    p.registerTerminal('beep', {
      description: 'Make a beep.',
      handler: async () => undefined,
    })
    expect(p.snapshot().terminals.get('beep')?.description).toBe('Make a beep.')
  })
})

describe('PolicyBuilder — fingerprint', () => {
  it('changes when a registration is added', () => {
    const p = new PolicyBuilder()
    const empty = p.fingerprint()
    p.registerFn('a', { fn: () => null })
    const oneFn = p.fingerprint()
    expect(empty).not.toBe(oneFn)
    p.registerSkill('helpful', 'tips')
    expect(p.fingerprint()).not.toBe(oneFn)
  })
})

describe('memberAllowed — filter rules', () => {
  it('include "*" allows everything', () => {
    expect(memberAllowed('foo', '*', undefined)).toBe(true)
    expect(memberAllowed('_internal', '*', undefined)).toBe(true)
  })

  it('exclude wins over include', () => {
    expect(memberAllowed('foo', '*', 'foo')).toBe(false)
  })

  it('exclude glob _* hides underscore-prefixed members when supplied', () => {
    // Not a default — embedders pass `exclude: '_*'` explicitly if
    // they want the Python-style "underscore = private" convention.
    expect(memberAllowed('_secret', undefined, '_*')).toBe(false)
    expect(memberAllowed('public', undefined, '_*')).toBe(true)
  })

  it('no exclude means everything passes (no _*-by-default)', () => {
    expect(memberAllowed('_internal', undefined, undefined)).toBe(true)
    expect(memberAllowed('public', undefined, undefined)).toBe(true)
  })

  it('predicate filter works', () => {
    expect(memberAllowed('foo', (n) => n.length === 3, undefined)).toBe(true)
    expect(memberAllowed('longer', (n) => n.length === 3, undefined)).toBe(false)
  })

  it('array of globs: any match counts', () => {
    expect(memberAllowed('foo', ['bar', 'foo'], undefined)).toBe(true)
    expect(memberAllowed('baz', ['bar', 'foo'], undefined)).toBe(false)
  })

  it('? matches a single character', () => {
    expect(memberAllowed('foo', 'fo?', undefined)).toBe(true)
    expect(memberAllowed('foooo', 'fo?', undefined)).toBe(false)
  })
})

describe('PolicyBuilder — URL-shipped registrations', () => {
  it('registerFn rejects passing both fn and url (host xor url)', () => {
    const p = new PolicyBuilder()
    expect(() => p.registerFn('x', { fn: () => null, url: 'https://example.com/m.js' })).toThrow(
      /pass either the live value or \{ url, export\? \}, not both/,
    )
  })

  it('registerFn rejects passing neither fn nor url', () => {
    const p = new PolicyBuilder()
    expect(() => p.registerFn('x', {})).toThrow(/missing the registered value/)
  })

  it('registerFn rejects an empty-string url', () => {
    const p = new PolicyBuilder()
    expect(() => p.registerFn('x', { url: '' })).toThrow(/url must be a non-empty string/)
  })

  it('registerFn accepts a url-only registration', () => {
    const p = new PolicyBuilder()
    p.registerFn('x', { url: 'https://example.com/m.js' })
    expect(p.snapshot().fns.get('x')?.url).toBe('https://example.com/m.js')
    expect(p.snapshot().fns.get('x')?.fn).toBeUndefined()
  })

  it('registerFn rejects paramsSchema combined with url', () => {
    const p = new PolicyBuilder()
    // The schema shape doesn't matter for this guard — the rejection
    // fires on `paramsSchema !== undefined`. Use a stub that satisfies
    // the StandardSchemaV1 interface just enough to typecheck.
    const stubSchema = {
      '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) },
    } as unknown as NonNullable<Parameters<PolicyBuilder['registerFn']>[1]['paramsSchema']>
    expect(() =>
      p.registerFn('x', {
        url: 'https://example.com/m.js',
        paramsSchema: stubSchema,
      }),
    ).toThrow(/paramsSchema can't be combined with \{ url \}/)
  })

  it('registerCls rejects passing both cls and url', () => {
    const p = new PolicyBuilder()
    class K {}
    expect(() => p.registerCls('K', { cls: K, url: 'https://example.com/m.js' })).toThrow(
      /pass either the live value or \{ url, export\? \}, not both/,
    )
  })

  it('registerCls rejects passing neither cls nor url', () => {
    const p = new PolicyBuilder()
    expect(() => p.registerCls('K', {})).toThrow(/missing the registered value/)
  })

  it('registerCls rejects constructable:false combined with url', () => {
    const p = new PolicyBuilder()
    expect(() =>
      p.registerCls('K', { url: 'https://example.com/m.js', constructable: false }),
    ).toThrow(/constructable: false can't be combined with \{ url \}/)
  })

  it('registerCls rejects include / exclude / configure combined with url', () => {
    const p = new PolicyBuilder()
    expect(() => p.registerCls('K', { url: 'https://example.com/m.js', include: '*' })).toThrow(
      /include.*can't be combined with \{ url \}/,
    )
    expect(() => p.registerCls('K2', { url: 'https://example.com/m.js', exclude: '_*' })).toThrow(
      /exclude.*can't be combined with \{ url \}/,
    )
    expect(() =>
      p.registerCls('K3', { url: 'https://example.com/m.js', configure: { foo: {} } }),
    ).toThrow(/configure.*can't be combined with \{ url \}/)
  })

  it('registerNamespace rejects passing both target and url', () => {
    const p = new PolicyBuilder()
    expect(() =>
      p.registerNamespace('ns', { target: {}, url: 'https://example.com/m.js' }),
    ).toThrow(/pass either the live value or \{ url, export\? \}, not both/)
  })

  it('registerNamespace rejects passing neither target nor url', () => {
    const p = new PolicyBuilder()
    expect(() => p.registerNamespace('ns', {})).toThrow(/missing the registered value/)
  })

  it('registerNamespace rejects include / exclude combined with url', () => {
    const p = new PolicyBuilder()
    expect(() =>
      p.registerNamespace('ns', { url: 'https://example.com/m.js', include: '*' }),
    ).toThrow(/include.*can't be combined with \{ url \}/)
    expect(() =>
      p.registerNamespace('ns2', { url: 'https://example.com/m.js', exclude: '_*' }),
    ).toThrow(/exclude.*can't be combined with \{ url \}/)
  })

  it('registerNamespace accepts url + optional export plucker', () => {
    const p = new PolicyBuilder()
    p.registerNamespace('ns', { url: 'https://example.com/m.js', export: 'utils' })
    expect(p.snapshot().namespaces.get('ns')?.url).toBe('https://example.com/m.js')
    expect(p.snapshot().namespaces.get('ns')?.export).toBe('utils')
  })
})
