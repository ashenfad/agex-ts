import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type CaptureTarget,
  _getRealConsoleForTests,
  bytesToBase64,
  detectImage,
  installConsoleProxy,
  makeHostFnContext,
  pushArgs,
  runWithCapture,
} from '../src/runtime/console-capture'
import type { OutputPart } from '../src/types'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
])
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

beforeAll(() => {
  installConsoleProxy()
})

const newTarget = (): CaptureTarget => ({ outputs: [] as OutputPart[], passConsole: false })

describe('detectImage', () => {
  it('accepts {format,data} for png/jpeg/webp', () => {
    expect(detectImage({ format: 'png', data: 'abc' })).toEqual({ format: 'png', data: 'abc' })
    expect(detectImage({ format: 'jpeg', data: 'abc' })).toEqual({ format: 'jpeg', data: 'abc' })
    expect(detectImage({ format: 'webp', data: 'abc' })).toEqual({ format: 'webp', data: 'abc' })
  })
  it('rejects unsupported format', () => {
    expect(detectImage({ format: 'gif', data: 'abc' })).toBeNull()
  })
  it('rejects missing fields and empty data', () => {
    expect(detectImage({ format: 'png' })).toBeNull()
    expect(detectImage({ data: 'abc' })).toBeNull()
    expect(detectImage({ format: 'png', data: '' })).toBeNull()
  })
  it('accepts data:image URLs', () => {
    expect(detectImage('data:image/png;base64,iVBORw0KGgo')).toEqual({
      format: 'png',
      data: 'iVBORw0KGgo',
    })
    expect(detectImage('data:image/webp;base64,UklGR')).toEqual({
      format: 'webp',
      data: 'UklGR',
    })
  })
  it('rejects unsupported data URL formats', () => {
    expect(detectImage('data:image/gif;base64,abc')).toBeNull()
    expect(detectImage('not a data url')).toBeNull()
  })
  it('accepts Uint8Array with PNG/JPEG/WebP magic', () => {
    const png = detectImage(PNG)
    expect(png?.format).toBe('png')
    expect(png?.data.length).toBeGreaterThan(0)
    const jpeg = detectImage(JPEG)
    expect(jpeg?.format).toBe('jpeg')
    const webp = detectImage(WEBP)
    expect(webp?.format).toBe('webp')
  })
  it('rejects too-short or non-image Uint8Array', () => {
    expect(detectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(detectImage(new Uint8Array(20))).toBeNull()
  })
  it('rejects primitives, arrays, dates', () => {
    expect(detectImage(null)).toBeNull()
    expect(detectImage(undefined)).toBeNull()
    expect(detectImage(5)).toBeNull()
    expect(detectImage('hi')).toBeNull()
    expect(detectImage([])).toBeNull()
    expect(detectImage(new Date())).toBeNull()
  })
})

describe('pushArgs', () => {
  it('all-text args produce one text part', () => {
    const t = newTarget()
    pushArgs(t, 'log', ['hello', 'world', 42])
    expect(t.outputs).toEqual([{ type: 'text', text: 'hello world 42' }])
  })
  it('one image arg produces one image part', () => {
    const t = newTarget()
    pushArgs(t, 'log', [{ format: 'png', data: 'abc' }])
    expect(t.outputs).toEqual([{ type: 'image', format: 'png', data: 'abc' }])
  })
  it('mixed text-then-image splits in order', () => {
    const t = newTarget()
    pushArgs(t, 'log', ['shot:', { format: 'png', data: 'abc' }])
    expect(t.outputs).toEqual([
      { type: 'text', text: 'shot:' },
      { type: 'image', format: 'png', data: 'abc' },
    ])
  })
  it('mixed image-then-text splits in order', () => {
    const t = newTarget()
    pushArgs(t, 'log', [{ format: 'png', data: 'abc' }, 'after'])
    expect(t.outputs).toEqual([
      { type: 'image', format: 'png', data: 'abc' },
      { type: 'text', text: 'after' },
    ])
  })
  it('multiple images interleaved with text preserve order', () => {
    const t = newTarget()
    pushArgs(t, 'log', ['a', { format: 'png', data: 'p1' }, 'b', { format: 'jpeg', data: 'j1' }])
    expect(t.outputs).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image', format: 'png', data: 'p1' },
      { type: 'text', text: 'b' },
      { type: 'image', format: 'jpeg', data: 'j1' },
    ])
  })
  it('non-log levels prefix the text part', () => {
    const t = newTarget()
    pushArgs(t, 'warn', ['careful'])
    pushArgs(t, 'error', ['boom'])
    pushArgs(t, 'info', ['fyi'])
    expect(t.outputs).toEqual([
      { type: 'text', text: '[warn] careful' },
      { type: 'text', text: '[error] boom' },
      { type: 'text', text: '[info] fyi' },
    ])
  })
  it('non-log levels do not prefix image parts', () => {
    const t = newTarget()
    pushArgs(t, 'warn', [{ format: 'png', data: 'abc' }])
    expect(t.outputs).toEqual([{ type: 'image', format: 'png', data: 'abc' }])
  })
})

describe('global proxy + ALS', () => {
  // The proxy is permanently installed; track real-console writes via spy
  // and restore after each test.
  let logSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
  })

  it('inside runWithCapture, console.log lands in target.outputs', async () => {
    const t = newTarget()
    await runWithCapture(t, async () => {
      console.log('hello')
    })
    expect(t.outputs).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('outside runWithCapture, console.log falls through to real console', () => {
    const real = _getRealConsoleForTests()
    logSpy = vi.spyOn(real, 'log').mockImplementation(() => {})
    console.log('outside')
    expect(logSpy).toHaveBeenCalledWith('outside')
  })

  it('nested runWithCapture swaps target', async () => {
    const outer = newTarget()
    const inner = newTarget()
    await runWithCapture(outer, async () => {
      console.log('outer-1')
      await runWithCapture(inner, async () => {
        console.log('inner')
      })
      console.log('outer-2')
    })
    expect(outer.outputs).toEqual([
      { type: 'text', text: 'outer-1' },
      { type: 'text', text: 'outer-2' },
    ])
    expect(inner.outputs).toEqual([{ type: 'text', text: 'inner' }])
  })

  it('concurrent runWithCapture calls do not cross-contaminate', async () => {
    const t1 = newTarget()
    const t2 = newTarget()
    await Promise.all([
      runWithCapture(t1, async () => {
        await new Promise((r) => setTimeout(r, 10))
        console.log('a')
      }),
      runWithCapture(t2, async () => {
        await new Promise((r) => setTimeout(r, 5))
        console.log('b')
      }),
    ])
    expect(t1.outputs).toEqual([{ type: 'text', text: 'a' }])
    expect(t2.outputs).toEqual([{ type: 'text', text: 'b' }])
  })

  it('idempotent install does not stack proxies', () => {
    installConsoleProxy()
    installConsoleProxy()
    installConsoleProxy()
    const real = _getRealConsoleForTests()
    logSpy = vi.spyOn(real, 'log').mockImplementation(() => {})
    console.log('once')
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('passConsole mirrors captured calls to the real console', async () => {
    const real = _getRealConsoleForTests()
    logSpy = vi.spyOn(real, 'log').mockImplementation(() => {})
    const t: CaptureTarget = { outputs: [], passConsole: true }
    await runWithCapture(t, async () => {
      console.log('mirrored')
    })
    expect(t.outputs).toEqual([{ type: 'text', text: 'mirrored' }])
    expect(logSpy).toHaveBeenCalledWith('mirrored')
  })
})

describe('makeHostFnContext', () => {
  it('console.log lands in outputs as text', () => {
    const outputs: OutputPart[] = []
    const ac = new AbortController()
    const ctx = makeHostFnContext({ outputs, signal: ac.signal })
    ctx.console.log('from host fn')
    expect(outputs).toEqual([{ type: 'text', text: 'from host fn' }])
  })
  it('console.log of image-shaped value lands as image part', () => {
    const outputs: OutputPart[] = []
    const ctx = makeHostFnContext({ outputs, signal: new AbortController().signal })
    ctx.console.log({ format: 'png', data: 'abc' })
    expect(outputs).toEqual([{ type: 'image', format: 'png', data: 'abc' }])
  })
  it('signal forwards from the AbortController', () => {
    const ac = new AbortController()
    const ctx = makeHostFnContext({ outputs: [], signal: ac.signal })
    expect(ctx.signal.aborted).toBe(false)
    ac.abort()
    expect(ctx.signal.aborted).toBe(true)
  })
  it('non-routed methods fall through to real console', () => {
    const real = _getRealConsoleForTests()
    const tableSpy = vi.spyOn(real, 'table').mockImplementation(() => {})
    const ctx = makeHostFnContext({ outputs: [], signal: new AbortController().signal })
    ctx.console.table([{ a: 1 }])
    expect(tableSpy).toHaveBeenCalled()
    tableSpy.mockRestore()
  })

  it('non-routed methods are bound to the real console (no Illegal invocation)', () => {
    // Browser Console implementations (Chrome/Firefox/WebKit) check
    // `this` against an internal slot for methods like `table`,
    // `time`, `dir`, etc. and throw `TypeError: Illegal invocation`
    // when invoked with `this === <Proxy>`. Simulate that by
    // installing a stub on the real console whose body asserts `this
    // === realConsole` — the test fails if our Proxy returned an
    // unbound reference.
    const real = _getRealConsoleForTests()
    let seenThis: unknown = null
    const original = real.table
    // biome-ignore lint/suspicious/noExplicitAny: console.table arity
    real.table = function (this: unknown, ..._args: any[]): void {
      seenThis = this
    }
    try {
      const ctx = makeHostFnContext({ outputs: [], signal: new AbortController().signal })
      ctx.console.table([{ a: 1 }])
      expect(seenThis).toBe(real)
    } finally {
      real.table = original
    }
  })
})

describe('global proxy — Illegal invocation guard', () => {
  it('binds unrouted methods to the real console', () => {
    const real = _getRealConsoleForTests()
    let seenThis: unknown = null
    const original = real.dir
    // biome-ignore lint/suspicious/noExplicitAny: console.dir arity
    real.dir = function (this: unknown, ..._args: any[]): void {
      seenThis = this
    }
    try {
      // The proxy is permanently installed on `globalThis.console`.
      // Access via `console.dir` — same call shape browser code uses.
      console.dir({ x: 1 })
      expect(seenThis).toBe(real)
    } finally {
      real.dir = original
    }
  })
})

describe('bytesToBase64', () => {
  it('round-trips through atob', () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x21]) // "hi!"
    expect(bytesToBase64(bytes)).toBe('aGkh')
  })
  it('handles empty input', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })
})
