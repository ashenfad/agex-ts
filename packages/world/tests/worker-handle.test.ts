/**
 * The browser worker's start: a script of another origin than the
 * page's starts through a same-origin `blob:` module that imports it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkerHandle, crossOriginScript } from '../src/kernel/handle'

const page = { href: 'https://apps.example/app/index.html', origin: 'https://apps.example' }
const CDN = 'https://cdn.jsdelivr.net/npm/@agex-ts/world@0.1.2/dist/worker.js'

describe('crossOriginScript', () => {
  it('names a script of another origin, absolute', () => {
    expect(crossOriginScript(CDN, page)).toBe(CDN)
    expect(crossOriginScript(new URL(CDN), page)).toBe(CDN)
    expect(crossOriginScript('http://apps.example/w.js', page)).toBe('http://apps.example/w.js')
    expect(crossOriginScript('https://apps.example:8443/w.js', page)).toBe(
      'https://apps.example:8443/w.js',
    )
  })

  it('passes a same-origin script, relative or absolute', () => {
    expect(crossOriginScript('https://apps.example/dist/worker.js', page)).toBeNull()
    expect(crossOriginScript('./worker.js', page)).toBeNull()
    expect(crossOriginScript('/worker.js', page)).toBeNull()
  })

  it('passes blob: and data: URLs', () => {
    expect(crossOriginScript('blob:https://cdn.example/1234', page)).toBeNull()
    expect(crossOriginScript('data:text/javascript,postMessage(1)', page)).toBeNull()
  })

  it('passes everything with no page to compare with', () => {
    expect(crossOriginScript(CDN, undefined)).toBeNull()
  })

  it('names every http(s) script from an opaque origin', () => {
    const opaque = { href: 'https://apps.example/app/index.html', origin: 'null' }
    expect(crossOriginScript(CDN, opaque)).toBe(CDN)
    expect(crossOriginScript('./worker.js', opaque)).toBe('https://apps.example/app/worker.js')
  })

  it('passes a relative URL with no base to resolve it against', () => {
    expect(crossOriginScript('./worker.js', { href: 'about:srcdoc', origin: 'null' })).toBeNull()
  })
})

/** A stand-in for the browser's `Worker`: records how it was made and
 *  which listeners it holds. */
class FakeWorker extends EventTarget {
  static made: FakeWorker[] = []
  terminated = false
  constructor(
    readonly url: string | URL,
    readonly options: WorkerOptions,
  ) {
    super()
    FakeWorker.made.push(this)
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true
  }
}

describe('a browser worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    FakeWorker.made = []
  })

  const stub = () => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('location', page)
    return vi.spyOn(URL, 'revokeObjectURL')
  }

  it('starts a cross-origin script through a blob module that imports it', async () => {
    const revoked = stub()
    const handle = await createWorkerHandle(CDN, 'browser')
    const [w] = FakeWorker.made
    const shim = String(w?.url)
    expect(shim.startsWith('blob:')).toBe(true)
    expect(w?.options).toEqual({ type: 'module' })
    const blob = await fetch(shim).then((r) => r.text())
    expect(blob).toBe(`import ${JSON.stringify(CDN)}\n`)
    expect(revoked).not.toHaveBeenCalled()
    w?.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } }))
    w?.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } }))
    expect(revoked).toHaveBeenCalledTimes(1)
    expect(revoked).toHaveBeenCalledWith(shim)
    handle.terminate()
    expect(revoked).toHaveBeenCalledTimes(1)
  })

  it("lets the shim go when it's terminated before answering", async () => {
    const revoked = stub()
    const handle = await createWorkerHandle(CDN, 'browser')
    handle.terminate()
    expect(FakeWorker.made[0]?.terminated).toBe(true)
    expect(revoked).toHaveBeenCalledTimes(1)
  })

  it('starts a same-origin script directly', async () => {
    const revoked = stub()
    const url = new URL('https://apps.example/dist/worker.js')
    const handle = await createWorkerHandle(url, 'browser')
    expect(FakeWorker.made[0]?.url).toBe(url)
    handle.terminate()
    expect(revoked).not.toHaveBeenCalled()
  })
})
