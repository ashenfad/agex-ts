/**
 * Realm-agnostic surface for host-realm console capture.
 *
 * Sits underneath the two `console-capture.{ts,browser.ts}` variants
 * selected by `package.json`'s `"browser"` export condition. The
 * variants supply `installConsoleProxy` / `runWithCapture` (ALS-backed
 * on Node, stubs in the browser) and re-export everything below.
 *
 * Both channels (the ALS-gated global proxy and the explicit per-fn
 * `ctx.console`) route through `pushArgs` → `detectImage`, so an
 * image-shaped value pushed through either path produces an `image`
 * `OutputPart` indistinguishable from the other. Anything that doesn't
 * detect as an image flows through `safeStringifyArgs` to a `text`
 * part.
 *
 * Image detection rules (`detectImage`):
 * - `{format: 'png'|'jpeg'|'webp', data: <non-empty string>}`
 * - `data:image/(png|jpeg|webp);base64,...` strings
 * - `Uint8Array` whose first ~12 bytes match a PNG / JPEG / WebP magic
 *
 * Mixed args split into ordered parts: `console.log('shot:', bytes)`
 * → text part `'shot:'` + image part. All-text args still join into a
 * single text part (preserves the standard `console.log` convention).
 */

import type { HostFnContext, ImageFormat, OutputPart } from '../types'
import { safeStringifyArgs } from './safe-stringify'

export type { HostFnContext } from '../types'

export interface CaptureTarget {
  readonly outputs: OutputPart[]
  /** When true, captured calls also mirror to the original real
   *  console (useful when debugging tests). */
  readonly passConsole: boolean
}

// Captured before any swap so the Node proxy can fall through to it
// without recursing back into itself (and so test code can compare
// against the real console).
export const realConsole: Console = globalThis.console

/** Proxy fall-through for the unrouted Console methods (`table`,
 *  `time`, `dir`, `group`, ...). Browser Console implementations
 *  validate the `this` binding against an internal slot and throw
 *  `TypeError: Illegal invocation` if these methods are invoked with
 *  `this === <Proxy>`. Re-binding to `realConsole` before returning
 *  the function makes the call site's implicit `this` harmless. */
export function reflectBoundToReal(
  target: object,
  prop: string | symbol,
  receiver: unknown,
): unknown {
  const value = Reflect.get(target, prop, receiver)
  return typeof value === 'function' ? value.bind(realConsole) : value
}

/** Build a per-host-fn context. Used by registered fns that opt in via
 *  `wantsContext: true`. The console closes over `outputs` directly
 *  (no ALS lookup) so it works in browser hosts too. */
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
  // Build a Console-shaped object: route the four levels through the
  // pipeline; fall back to the real console for everything else so
  // feature-detect code doesn't trip.
  const ctxConsole = new Proxy(realConsole, {
    get(target, prop, receiver) {
      if (prop === 'log') return make('log')
      if (prop === 'warn') return make('warn')
      if (prop === 'error') return make('error')
      if (prop === 'info') return make('info')
      return reflectBoundToReal(target, prop, receiver)
    },
  })
  return { console: ctxConsole, signal }
}

/** Walk `args`, route image-shaped values to `image` parts and
 *  everything else to a single `text` part (joined per console.log
 *  convention). Mixed args split: text-then-image-then-text yields
 *  three parts in order. Non-`log` levels prefix the text part with
 *  `[level]` for parity with the worker's in-realm console behavior. */
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

/** Three-rule image detector. Returns `null` for non-image values. */
export function detectImage(value: unknown): { format: ImageFormat; data: string } | null {
  // Rule A — strict object: {format, data}
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
  // Rule C — Uint8Array with magic bytes
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
  // 4 base64 chars → 3 bytes; round up to the nearest 4-char group.
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

/** Convert bytes to base64. Uses `Buffer` on Node, falls back to
 *  `btoa(String.fromCharCode(...))` in browser/Worker realms. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  // Browser fallback. Chunked to avoid argument-count limits on very
  // large buffers (String.fromCharCode applied to >~100k args throws).
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/** Test-only escape hatch: read the captured real console reference
 *  (held before the proxy install). Tests use this to spy on
 *  fall-through behavior without going through the proxy. */
export function _getRealConsoleForTests(): Console {
  return realConsole
}
