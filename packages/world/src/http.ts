/**
 * `http`, a host object a host grants (`hostObjects: {http:
 * httpHost()}`): `fetch` over the network from code, with secrets.
 *
 *     const r = await http.fetch('https://api.example/items', {
 *       headers: { Authorization: `Bearer ${secret('TOKEN')}` },
 *       as: 'json',
 *     })
 *     // r: { status, ok, statusText, url, headers, body }
 *
 * `secret('TOKEN')` is a reference, filled in the URL or a header at the
 * request (if the secret may go to that origin), so the value never
 * reaches code. The request is `curl`'s: the size cap, an echoed secret
 * replaced by its reference, CORS told from a dead network, and a
 * {@link NetError} (name `NetError`, curl's exit code as `code`) when it
 * fails. Redirects are followed unless `follow: false`, but never while
 * carrying a secret bound to origins.
 */

import { type NetOptions, request } from './net'
import { type HostFactory, hostFactory } from './profile'

export type HttpOptions = NetOptions

export interface HttpInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  /** Follow redirects (default true). */
  readonly follow?: boolean
  /** Seconds the request may take. */
  readonly timeout?: number
  /** The body as text (default), parsed JSON, or bytes. */
  readonly as?: 'text' | 'json' | 'bytes'
}

export interface HttpResult {
  readonly status: number
  readonly ok: boolean
  readonly statusText: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

/** Make the `http` host object for a profile's `hostObjects`. */
export function httpHost(opts: HttpOptions = {}): HostFactory {
  return hostFactory((_ws, { secrets }) => ({
    async fetch(url: string, init: HttpInit = {}): Promise<HttpResult> {
      if (typeof url !== 'string') throw new TypeError('http.fetch: url must be a string')
      const r = await request(
        {
          url,
          ...(init.method !== undefined && { method: init.method }),
          headers: Object.entries(init.headers ?? {}),
          ...(init.body !== undefined && { body: init.body }),
          follow: init.follow ?? true,
          ...(init.timeout !== undefined && { timeout: init.timeout }),
        },
        secrets,
        opts,
      )
      const as = init.as ?? 'text'
      const text = () => new TextDecoder().decode(r.bytes)
      return {
        status: r.status,
        ok: r.ok,
        statusText: r.statusText,
        url: r.url,
        headers: r.headers,
        body: as === 'bytes' ? r.bytes : as === 'json' ? JSON.parse(text()) : text(),
      }
    },
  }))
}
