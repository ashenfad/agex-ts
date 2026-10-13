/**
 * `curl` as a terminal command the host grants: fetch over the network,
 * into the world's files or the transcript.
 *
 * It takes the flags agents reach for: `-o FILE`, `-L`, `-H 'Name:
 * value'`, `-X METHOD`, `-d DATA` (or `-d @file`), `--json DATA`, `-f`,
 * `-s`/`-S`, `-m SECONDS`. A response past the size cap is refused.
 *
 * **Secrets** are used here and nowhere else: `$NAME` (or `${NAME}`) in
 * the URL or a header is replaced by the profile's secret of that name
 * at the request. The shell expands a secret to a reference to itself,
 * so `-H "Authorization: Bearer $TOKEN"` works quoted either way, and
 * the value never passes through the shell. A secret a text response
 * echoes back is replaced by its reference before the response reaches
 * the transcript or a file.
 *
 * **In a browser,** a server that doesn't allow the page's origin
 * (CORS) fails exactly as a network failure does. `curl` tells them
 * apart by asking again with `mode: 'no-cors'`: an answer means the
 * server is up and CORS is the likely cause.
 */

import type { CommandContext, CommandResult } from '@agex-ts/termish'
import { describeFsError } from '@agex-ts/termish'
import { resolve } from './path'
import { type CommandFactory, commandFactory } from './profile'

export interface CurlOptions {
  /** The fetch to use (default `globalThis.fetch`). */
  readonly fetch?: typeof globalThis.fetch
  /** The largest response accepted, in bytes (default 10 MB). */
  readonly maxBytes?: number
  /** Seconds a request may take unless `-m` says otherwise (default 60). */
  readonly timeout?: number
}

export const DEFAULT_CURL_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_CURL_TIMEOUT = 60

/** Make `curl` for a profile's `commands`. */
export function curlCommand(opts: CurlOptions = {}): CommandFactory {
  const maxBytes = opts.maxBytes ?? DEFAULT_CURL_MAX_BYTES
  return commandFactory(
    ({ secrets }) =>
      (ctx) =>
        curl(ctx, secrets, opts),
    {
      description: `curl URL fetches from the network: -o FILE saves into the workspace, -L follows redirects, -H 'Name: value', -X METHOD, -d DATA (or -d @file), --json DATA, -f fails on HTTP errors, -s is quiet, -m SECONDS. Responses over ${Math.round(maxBytes / 1024 / 1024)} MB are refused. A secret goes in a URL or header as $NAME (-H "Authorization: Bearer $TOKEN"); its value never enters the workspace.`,
    },
  )
}

interface Request {
  url: string | null
  method: string | null
  headers: Array<[string, string]>
  data: string[]
  json: string | null
  output: string | null
  follow: boolean
  fail: boolean
  silent: boolean
  showError: boolean
  maxTime: number | null
}

/** Options that take a value, by short and long name. */
const VALUED: Readonly<Record<string, keyof Request | 'data-file'>> = {
  o: 'output',
  '--output': 'output',
  H: 'headers',
  '--header': 'headers',
  X: 'method',
  '--request': 'method',
  d: 'data-file',
  '--data': 'data-file',
  '--data-raw': 'data',
  '--json': 'json',
  m: 'maxTime',
  '--max-time': 'maxTime',
}

const FLAGS: Readonly<Record<string, 'follow' | 'fail' | 'silent' | 'showError'>> = {
  L: 'follow',
  '--location': 'follow',
  f: 'fail',
  '--fail': 'fail',
  s: 'silent',
  '--silent': 'silent',
  S: 'showError',
  '--show-error': 'showError',
}

class Usage extends Error {}

async function parse(ctx: CommandContext): Promise<Request> {
  const req: Request = {
    url: null,
    method: null,
    headers: [],
    data: [],
    json: null,
    output: null,
    follow: false,
    fail: false,
    silent: false,
    showError: false,
    maxTime: null,
  }
  const args = [...ctx.args]
  const take = async (key: keyof Request | 'data-file', value: string | undefined, opt: string) => {
    if (value === undefined) throw new Usage(`option ${opt}: requires a value`)
    if (key === 'headers') {
      const colon = value.indexOf(':')
      if (colon <= 0) throw new Usage(`option ${opt}: a header is 'Name: value'`)
      req.headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()])
    } else if (key === 'data-file') {
      req.data.push(value.startsWith('@') ? await readData(ctx, value.slice(1)) : value)
    } else if (key === 'data') {
      req.data.push(value)
    } else if (key === 'maxTime') {
      const seconds = Number(value)
      if (!(seconds > 0)) throw new Usage(`option ${opt}: expected a number of seconds`)
      req.maxTime = seconds
    } else {
      ;(req as unknown as Record<string, string>)[key] = value
    }
  }
  let rest = false
  while (args.length > 0) {
    const arg = args.shift() as string
    if (rest || !arg.startsWith('-') || arg === '-') {
      if (req.url !== null) throw new Usage('only one URL at a time')
      req.url = arg
    } else if (arg === '--') {
      rest = true
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      const flag = FLAGS[name]
      const valued = VALUED[name]
      if (flag !== undefined) req[flag] = true
      else if (valued !== undefined)
        await take(valued, eq === -1 ? args.shift() : arg.slice(eq + 1), name)
      else throw new Usage(`option ${name}: is unknown`)
    } else {
      // A cluster of short options (`-fsSL`); one that takes a value
      // takes the rest of the cluster, or the next argument.
      for (let i = 1; i < arg.length; i++) {
        const letter = arg[i] as string
        const flag = FLAGS[letter]
        const valued = VALUED[letter]
        if (flag !== undefined) {
          req[flag] = true
        } else if (valued !== undefined) {
          const inline = arg.slice(i + 1)
          await take(valued, inline !== '' ? inline : args.shift(), `-${letter}`)
          break
        } else {
          throw new Usage(`option -${letter}: is unknown`)
        }
      }
    }
  }
  if (req.url === null) throw new Usage('no URL specified')
  return req
}

async function readData(ctx: CommandContext, path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await ctx.fs.read(path))
  } catch (e) {
    throw new Usage(`can't read data from ${path}: ${describeFsError(e)}`)
  }
}

/** `$NAME` and `${NAME}` filled from `secrets`; other names left be. */
function fill(text: string, secrets: Readonly<Record<string, string>>): string {
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, a, b) => {
      const name = (a ?? b) as string
      return Object.hasOwn(secrets, name) ? (secrets[name] as string) : whole
    },
  )
}

/** Secrets a text echoes back, replaced by their references. */
function scrub(text: string, secrets: Readonly<Record<string, string>>): string {
  let out = text
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length >= 4) out = out.split(value).join(`\${${name}}`)
  }
  return out
}

async function curl(
  ctx: CommandContext,
  secrets: Readonly<Record<string, string>>,
  opts: CurlOptions,
): Promise<CommandResult | undefined> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const maxBytes = opts.maxBytes ?? DEFAULT_CURL_MAX_BYTES
  let req: Request
  try {
    req = await parse(ctx)
  } catch (e) {
    if (e instanceof Usage) return { exitCode: 2, stderr: e.message }
    throw e
  }
  const fail = (code: number, message: string): CommandResult => ({
    exitCode: code,
    stderr: req.silent && !req.showError ? '' : `(${code}) ${scrub(message, secrets)}`,
  })

  let url: URL
  try {
    const raw = fill(req.url as string, secrets)
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return fail(3, 'URL rejected: malformed URL')
  }

  const headers = new Headers()
  for (const [name, value] of req.headers) headers.append(name, fill(value, secrets))
  let body: string | undefined
  if (req.json !== null) {
    body = req.json
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    if (!headers.has('accept')) headers.set('accept', 'application/json')
  } else if (req.data.length > 0) {
    body = req.data.join('&')
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
    }
  }
  const method = req.method ?? (body === undefined ? 'GET' : 'POST')

  const seconds = req.maxTime ?? opts.timeout ?? DEFAULT_CURL_TIMEOUT
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, seconds * 1000)
  const onAbort = () => controller.abort()
  ctx.signal.addEventListener('abort', onAbort)

  try {
    let response: Response
    try {
      response = await fetchFn(url, {
        method,
        headers,
        ...(body !== undefined && { body }),
        redirect: req.follow ? 'follow' : 'manual',
        signal: controller.signal,
      })
    } catch {
      if (timedOut) return fail(28, `Operation timed out after ${seconds} seconds`)
      if (ctx.signal.aborted) return fail(130, 'interrupted')
      return fail(...(await diagnose(fetchFn, url, controller.signal)))
    }

    // Not following a redirect: a browser hides it; nothing to show.
    if (response.type === 'opaqueredirect') return undefined
    if (req.fail && response.status >= 400) {
      return fail(22, `The requested URL returned error: ${response.status}`)
    }

    const bytes = await readCapped(response, maxBytes)
    if (bytes === null) return fail(63, `Maximum file size exceeded (${maxBytes} bytes)`)
    const out = scrubBytes(bytes, secrets)
    if (req.output !== null) {
      try {
        await ctx.fs.write(resolve(req.output, ctx.fs.getcwd()), out)
      } catch (e) {
        return fail(23, `Failure writing output to ${req.output}: ${describeFsError(e)}`)
      }
      return undefined
    }
    ctx.stdout.writeBytes(out)
    return undefined
  } catch (e) {
    if (timedOut) return fail(28, `Operation timed out after ${seconds} seconds`)
    throw e
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

/** Why a request failed with no response: in a browser, CORS refuses
 *  as a dead network does; a no-cors request tells them apart. */
async function diagnose(
  fetchFn: typeof globalThis.fetch,
  url: URL,
  signal: AbortSignal,
): Promise<[number, string]> {
  try {
    await fetchFn(url, { mode: 'no-cors', signal })
    return [
      7,
      `${url.host} answered, but its CORS policy doesn't let this page read the response (it must send Access-Control-Allow-Origin for this origin)`,
    ]
  } catch {
    return [6, `Could not reach ${url.host}: the network failed (DNS, TLS, offline, or blocked)`]
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
function scrubBytes(bytes: Uint8Array, secrets: Readonly<Record<string, string>>): Uint8Array {
  if (Object.keys(secrets).length === 0) return bytes
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bytes
  }
  const clean = scrub(text, secrets)
  return clean === text ? bytes : new TextEncoder().encode(clean)
}
