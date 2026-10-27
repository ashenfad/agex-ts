/**
 * One HTTP request on the host's behalf, with secrets: what `curl` and
 * the `http` host object share.
 *
 * - References to secrets (`${NAME}`) are filled in the URL and the
 *   headers, never the body. A secret bound to origins is filled only
 *   for those, and a request carrying one follows no redirect. A secret
 *   declared without a value can't be filled here: a request carrying
 *   one is refused, never sent with the reference in it.
 * - A response past the size cap is refused.
 * - A secret a text response echoes back is replaced by its reference.
 * - In a browser, a server that doesn't allow the page's origin (CORS)
 *   fails as a dead network does; a `no-cors` retry tells them apart.
 *
 * Failures are {@link NetError}s carrying curl's exit code for them.
 */

import { DeclaredSecretError, SecretOriginError, type Secrets } from './secrets'

export interface NetOptions {
  /** The fetch to use (default `globalThis.fetch`). */
  readonly fetch?: typeof globalThis.fetch
  /** The largest response accepted, in bytes (default 10 MB). */
  readonly maxBytes?: number
  /** Seconds a request may take (default 60). */
  readonly timeout?: number
}

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_NET_TIMEOUT = 60

export interface NetRequest {
  readonly url: string
  readonly method?: string
  readonly headers?: ReadonlyArray<readonly [string, string]>
  readonly body?: string | Uint8Array
  /** Follow redirects (default false: a redirect is the answer). */
  readonly follow?: boolean
  /** Seconds, overriding the options' timeout. */
  readonly timeout?: number
}

export interface NetResponse {
  readonly status: number
  readonly statusText: string
  readonly ok: boolean
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** The body, with any echoed secret replaced by its reference. */
  readonly bytes: Uint8Array
  /** A redirect not followed that the browser hid (no status, no
   *  location). */
  readonly hiddenRedirect: boolean
}

/** A request that failed, with curl's exit code for the failure. */
export class NetError extends Error {
  override readonly name = 'NetError'
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export async function request(
  req: NetRequest,
  given: Secrets,
  opts: NetOptions = {},
  signal?: AbortSignal,
): Promise<NetResponse> {
  // one snapshot for the whole request: what is filled is what is
  // scrubbed, should the host's secrets change while it is in flight
  const secrets = given.now()
  const fetchFn = opts.fetch ?? globalThis.fetch
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const seconds = req.timeout ?? opts.timeout ?? DEFAULT_NET_TIMEOUT

  const raw = /^[a-z][a-z0-9+.-]*:/i.test(req.url) ? req.url : `https://${req.url}`
  let url: URL
  const headers = new Headers()
  let bound = secrets.refersToBound(req.url)
  try {
    // The origin is the unfilled URL's, and filling may not change it:
    // a secret can't move a request somewhere else.
    const to = new URL(raw)
    url = new URL(secrets.fill(raw, to))
    if (url.origin !== to.origin) throw new SecretOriginError('in the URL', url.origin)
    for (const [name, value] of req.headers ?? []) {
      bound ||= secrets.refersToBound(value)
      headers.append(name, secrets.fill(value, url))
    }
  } catch (e) {
    if (e instanceof SecretOriginError) throw new NetError(3, `URL rejected: ${e.message}`)
    if (e instanceof DeclaredSecretError) throw new NetError(3, e.message)
    throw new NetError(3, 'URL rejected: malformed URL')
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, seconds * 1000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  const stopped = (): NetError | null =>
    timedOut
      ? new NetError(28, `Operation timed out after ${seconds} seconds`)
      : signal?.aborted === true
        ? new NetError(130, 'interrupted')
        : null

  try {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(req.body !== undefined && { body: req.body as BodyInit }),
        // A bound secret goes only where it is bound: no redirect may
        // carry it elsewhere.
        redirect: req.follow === true && !bound ? 'follow' : 'manual',
        signal: controller.signal,
      })
    } catch {
      throw stopped() ?? (await diagnose(fetchFn, url, controller.signal))
    }
    const hiddenRedirect = response.type === 'opaqueredirect'
    if (req.follow === true && bound && (hiddenRedirect || isRedirect(response.status))) {
      throw new NetError(
        47,
        `won't follow a redirect while sending a secret bound to ${url.origin}`,
      )
    }
    let bytes: Uint8Array | null
    try {
      bytes = await readCapped(response, maxBytes)
    } catch (e) {
      throw stopped() ?? e
    }
    if (bytes === null) throw new NetError(63, `Maximum file size exceeded (${maxBytes} bytes)`)
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      url: secrets.scrub(response.url || url.href),
      headers: Object.fromEntries(
        [...response.headers.entries()].map(([k, v]) => [k, secrets.scrub(v)]),
      ),
      bytes: scrubBytes(bytes, secrets),
      hiddenRedirect,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

const isRedirect = (status: number): boolean => status >= 300 && status < 400

/** Why a request failed with no response: in a browser, CORS refuses
 *  as a dead network does; a no-cors request tells them apart. */
async function diagnose(
  fetchFn: typeof globalThis.fetch,
  url: URL,
  signal: AbortSignal,
): Promise<NetError> {
  // The probe carries no secret: the URL's own, unfilled.
  const probe = new URL(url.origin + url.pathname)
  try {
    await fetchFn(probe, { mode: 'no-cors', signal })
    return new NetError(
      7,
      `${url.host} answered, but its CORS policy doesn't let this page read the response (it must send Access-Control-Allow-Origin for this origin)`,
    )
  } catch {
    return new NetError(
      6,
      `Could not reach ${url.host}: the network failed (DNS, TLS, offline, or blocked)`,
    )
  }
}

/** The body, or null past `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** A text body with any echoed secret replaced; other bytes as they are. */
function scrubBytes(bytes: Uint8Array, secrets: Secrets): Uint8Array {
  if (secrets.names().length === 0) return bytes
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bytes
  }
  const clean = secrets.scrub(text)
  return clean === text ? bytes : new TextEncoder().encode(clean)
}
