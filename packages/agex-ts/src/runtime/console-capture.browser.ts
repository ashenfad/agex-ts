/**
 * Browser-condition build of `agex-ts/console-capture`.
 *
 * `node:async_hooks` (and therefore `AsyncLocalStorage`) doesn't exist
 * in browsers / Workers, so the implicit capture path can't work. This
 * module ships:
 *
 * - The full `pushArgs` / `detectImage` / `bytesToBase64` /
 *   `makeHostFnContext` surface unchanged — all browser-safe.
 * - `installConsoleProxy()` as a no-op (no ALS to gate on).
 * - `runWithCapture(target, fn)` as `fn()` — runs the user code
 *   straight through with no per-call store. Agent-code `console.log`
 *   inside the worker realm continues to capture via the in-Worker
 *   `makeConsole` (which doesn't depend on this module). Host-fn
 *   capture in the host realm requires the registered fn to opt in to
 *   `wantsContext: true` and use `ctx.console` — that path lives
 *   entirely in `makeHostFnContext` and works here.
 *
 * Selected via `package.json`'s `"browser"` export condition.
 */

import type { HostFnContext, ImageFormat, OutputPart } from '../types'
import { safeStringifyArgs } from './safe-stringify'

export type { HostFnContext } from '../types'

export interface CaptureTarget {
  readonly outputs: OutputPart[]
  readonly passConsole: boolean
}

const realConsole: Console = globalThis.console

export function installConsoleProxy(): void {
  // No-op in browser / Worker hosts. The agent-code in-Worker capture
  // path is independent of this module; host-fn capture requires
  // `wantsContext: true` on the registration.
}

export function runWithCapture<T>(_target: CaptureTarget, fn: () => Promise<T>): Promise<T> {
  return fn()
}

export function makeHostFnContext(args: {
  outputs: OutputPart[]
  signal: AbortSignal
  passConsole?: boolean
}): HostFnContext {
  const { outputs, signal } = args
  const passConsole = args.passConsole === true
  const target: CaptureTarget = { outputs, passConsole }
  const make =
    (level: 'log' | 'warn' | 'error' | 'info') =>
    (...callArgs: unknown[]) => {
      pushArgs(target, level, callArgs)
      if (passConsole) realConsole[level](...callArgs)
    }
  const ctxConsole = new Proxy(realConsole, {
    get(target, prop, receiver) {
      if (prop === 'log') return make('log')
      if (prop === 'warn') return make('warn')
      if (prop === 'error') return make('error')
      if (prop === 'info') return make('info')
      // Bind unrouted methods (table/time/dir/...) to the real console
      // so browser implementations don't `Illegal invocation` on them.
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(realConsole) : value
    },
  })
  return { console: ctxConsole, signal }
}

export function pushArgs(
  target: CaptureTarget,
  level: 'log' | 'warn' | 'error' | 'info',
  args: ReadonlyArray<unknown>,
): void {
  const buf: unknown[] = []
  const flushText = (): void => {
    if (buf.length === 0) return
    const text = safeStringifyArgs(buf)
    const prefixed = level === 'log' ? text : `[${level}] ${text}`
    target.outputs.push({ type: 'text', text: prefixed })
    buf.length = 0
  }
  for (const a of args) {
    const img = detectImage(a)
    if (img !== null) {
      flushText()
      target.outputs.push({ type: 'image', format: img.format, data: img.data })
    } else {
      buf.push(a)
    }
  }
  flushText()
}

export function detectImage(value: unknown): { format: ImageFormat; data: string } | null {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  ) {
    const v = value as { format?: unknown; data?: unknown }
    if (
      (v.format === 'png' || v.format === 'jpeg' || v.format === 'webp') &&
      typeof v.data === 'string' &&
      v.data.length > 0
    ) {
      return { format: v.format, data: v.data }
    }
  }
  // Rule B — data URL string. The MIME label is host-supplied and
  // easily forged by accident (e.g. logging `dataUrl.slice(0, 40)`
  // for a debug print), so apply two gates symmetric with Rule C:
  //   - Payload must be long enough to plausibly be an image
  //     (smallest valid PNG ≈ 70 bytes → 96 base64 chars).
  //   - First 12 decoded bytes must match the declared format.
  // Both guards matter independently: a 40-char slice of a real PNG
  // data URL still carries valid PNG magic in its prefix, so magic
  // alone wouldn't catch it.
  if (typeof value === 'string') {
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(value)
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      const declared = m[1] as ImageFormat
      const payload = m[2]
      if (payload.length >= MIN_IMAGE_BASE64_LENGTH) {
        const prefix = decodeBase64Prefix(payload, 12)
        if (prefix !== null && detectMagicFormat(prefix) === declared) {
          return { format: declared, data: payload }
        }
      }
    }
  }
  if (value instanceof Uint8Array) {
    const fmt = detectMagicFormat(value)
    if (fmt !== null) return { format: fmt, data: bytesToBase64(value) }
  }
  return null
}

/** Smallest plausible image as base64. The minimum valid PNG is
 *  ~70 bytes (signature + IHDR + IDAT + IEND); 96 base64 chars
 *  encodes 72 bytes, comfortably above that floor while still
 *  letting genuinely tiny images through. */
const MIN_IMAGE_BASE64_LENGTH = 96

/** Inspect the first 12 bytes for PNG / JPEG / WebP signatures. */
function detectMagicFormat(b: Uint8Array): ImageFormat | null {
  if (b.byteLength < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'webp'
  }
  return null
}

/** Decode the first `byteCount` bytes from a base64 string. Returns
 *  `null` if the input is too short or fails to decode (e.g. caller
 *  logged a truncated slice that no longer parses as valid base64). */
function decodeBase64Prefix(b64: string, byteCount: number): Uint8Array | null {
  const charsNeeded = Math.ceil(byteCount / 3) * 4
  if (b64.length < charsNeeded) return null
  const slice = b64.slice(0, charsNeeded)
  try {
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(slice, 'base64')
      return buf.byteLength >= byteCount ? new Uint8Array(buf.subarray(0, byteCount)) : null
    }
    const binary = atob(slice)
    if (binary.length < byteCount) return null
    const out = new Uint8Array(byteCount)
    for (let i = 0; i < byteCount; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export function _getRealConsoleForTests(): Console {
  return realConsole
}
