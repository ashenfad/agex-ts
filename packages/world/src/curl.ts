/**
 * `curl` as a terminal command the host grants: fetch over the network,
 * into the world's files or the transcript.
 *
 * It takes the flags agents reach for: `-o FILE`, `-L`, `-H 'Name:
 * value'`, `-X METHOD`, `-d DATA` (or `-d @file`), `--json DATA`, `-f`,
 * `-s`/`-S`, `-m SECONDS`, `-i` (the status line and headers before the
 * body) and `-w FORMAT` (what the transfer was, after it).
 *
 * **Secrets:** `$NAME` (or `${NAME}`) in the URL or a header is filled
 * with the profile's secret at the request, if the secret may go to
 * that origin. The shell expands a secret to a reference to itself, so
 * `-H "Authorization: Bearer $TOKEN"` works quoted either way, and the
 * value never passes through the shell. The rest (the size cap,
 * scrubbing an echoed secret, telling CORS from a dead network) is
 * `request`'s, shared with the `http` host object. What `-i` and `-w`
 * print is scrubbed as the body is.
 */

import type { CommandContext, CommandResult } from '@agex-ts/termish'
import { describeFsError } from '@agex-ts/termish'
import { DEFAULT_MAX_BYTES, NetError, type NetOptions, type NetResponse, request } from './net'
import { resolve } from './path'
import { type CommandFactory, commandFactory } from './profile'
import type { Secrets } from './secrets'

/** How `curl` fetches: the fetch, the size cap (default 10 MB), and the
 *  timeout unless `-m` says otherwise (default 60 seconds). */
export type CurlOptions = NetOptions

/** Make `curl` for a profile's `commands`. */
export function curlCommand(opts: CurlOptions = {}): CommandFactory {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  return commandFactory(
    ({ secrets }) =>
      (ctx) =>
        curl(ctx, secrets, opts),
    {
      description: `curl URL fetches from the network: -o FILE saves into the workspace, -L follows redirects, -H 'Name: value', -X METHOD, -d DATA (or -d @file), --json DATA, -f fails on HTTP errors, -s is quiet, -m SECONDS, -i prints the status line and headers before the body, -w FORMAT prints after the transfer (${WRITE_OUT_NAMES}, \\n). Responses over ${Math.round(maxBytes / 1024 / 1024)} MB are refused. A secret goes in a URL or header as $NAME (-H "Authorization: Bearer $TOKEN"); its value never enters the workspace.`,
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
  include: boolean
  writeOut: string | null
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
  w: 'writeOut',
  '--write-out': 'writeOut',
}

const FLAGS: Readonly<Record<string, 'follow' | 'fail' | 'silent' | 'showError' | 'include'>> = {
  L: 'follow',
  '--location': 'follow',
  f: 'fail',
  '--fail': 'fail',
  s: 'silent',
  '--silent': 'silent',
  S: 'showError',
  '--show-error': 'showError',
  i: 'include',
  '--include': 'include',
}

/** What `-w` reads of a transfer: of no response, status 0. */
interface Transfer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly url: string
  readonly size: number
}

/** The `-w` variables, by name. */
const WRITE_OUT: Readonly<Record<string, (t: Transfer) => string>> = {
  http_code: (t) => String(t.status).padStart(3, '0'),
  content_type: (t) => t.headers['content-type'] ?? '',
  url_effective: (t) => t.url,
  size_download: (t) => String(t.size),
}

const WRITE_OUT_NAMES = Object.keys(WRITE_OUT)
  .map((name) => `%{${name}}`)
  .join(', ')

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' }

const WRITE_OUT_PART = /%\{([^}]*)\}|%%|\\([nrt])/g

/** Refuse a `-w` format naming a variable `curl` doesn't have. */
function checkWriteOut(format: string, opt: string): void {
  for (const m of format.matchAll(WRITE_OUT_PART)) {
    const name = m[1]
    if (name !== undefined && !Object.hasOwn(WRITE_OUT, name)) {
      throw new Usage(`option ${opt}: unknown variable %{${name}}; supported: ${WRITE_OUT_NAMES}`)
    }
  }
}

/** A `-w` format filled in from a transfer: its variables, `%%` and the
 *  escapes `\n`, `\r` and `\t`. */
function writeOut(format: string, t: Transfer): string {
  return format.replace(WRITE_OUT_PART, (m: string, name?: string, letter?: string) => {
    if (name !== undefined) return (WRITE_OUT[name] as (t: Transfer) => string)(t)
    if (letter !== undefined) return ESCAPES[letter] as string
    return m === '%%' ? '%' : m
  })
}

/** What `-i` prints before the body: the status line (fetch doesn't
 *  say which HTTP version answered, so it says 1.1), the headers, and a
 *  blank line. */
function headerBlock(response: NetResponse): string {
  const status = `HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd()
  const lines = Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`)
  return `${[status, ...lines].join('\n')}\n\n`
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
    include: false,
    writeOut: null,
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
    } else if (key === 'writeOut') {
      checkWriteOut(value, opt)
      req.writeOut = value
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

async function curl(
  ctx: CommandContext,
  secrets: Secrets,
  opts: CurlOptions,
): Promise<CommandResult | undefined> {
  let req: Request
  try {
    req = await parse(ctx)
  } catch (e) {
    if (e instanceof Usage) return { exitCode: 2, stderr: e.message }
    throw e
  }
  const fail = (code: number, message: string): CommandResult => ({
    exitCode: code,
    stderr: req.silent && !req.showError ? '' : `(${code}) ${secrets.scrub(message)}`,
  })

  const headers: Array<[string, string]> = [...req.headers]
  const has = (name: string) => headers.some(([n]) => n.toLowerCase() === name)
  let body: string | undefined
  if (req.json !== null) {
    body = req.json
    if (!has('content-type')) headers.push(['content-type', 'application/json'])
    if (!has('accept')) headers.push(['accept', 'application/json'])
  } else if (req.data.length > 0) {
    body = req.data.join('&')
    if (!has('content-type')) headers.push(['content-type', 'application/x-www-form-urlencoded'])
  }

  // `-w` prints after the transfer, failed or not, to stdout.
  const printWriteOut = (t: Transfer): void => {
    if (req.writeOut !== null) ctx.stdout.write(secrets.scrub(writeOut(req.writeOut, t)))
  }

  let response: NetResponse
  try {
    response = await request(
      {
        url: req.url as string,
        ...(req.method !== null && { method: req.method }),
        headers,
        ...(body !== undefined && { body }),
        follow: req.follow,
        ...(req.maxTime !== null && { timeout: req.maxTime }),
      },
      secrets,
      opts,
      ctx.signal,
    )
  } catch (e) {
    if (e instanceof NetError) {
      printWriteOut({ status: 0, headers: {}, url: req.url as string, size: 0 })
      return fail(e.code, e.message)
    }
    throw e
  }
  const transfer: Transfer = {
    status: response.status,
    headers: response.headers,
    url: response.url,
    size: response.bytes.byteLength,
  }

  // A redirect not followed, which the browser hid: nothing to show.
  if (response.hiddenRedirect) {
    printWriteOut(transfer)
    return undefined
  }
  if (req.fail && response.status >= 400) {
    printWriteOut(transfer)
    return fail(22, `The requested URL returned error: ${response.status}`)
  }
  const head = req.include ? new TextEncoder().encode(secrets.scrub(headerBlock(response))) : null
  const bytes = head === null ? response.bytes : concat(head, response.bytes)
  if (req.output !== null) {
    try {
      await ctx.fs.write(resolve(req.output, ctx.fs.getcwd()), bytes)
    } catch (e) {
      return fail(23, `Failure writing output to ${req.output}: ${describeFsError(e)}`)
    }
  } else {
    ctx.stdout.writeBytes(bytes)
  }
  printWriteOut(transfer)
  return undefined
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}
