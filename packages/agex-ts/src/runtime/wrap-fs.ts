/**
 * `wrapAgentFs(fs)` — ergonomic wrapper around the underlying
 * `FileSystem` protocol that the agent sees as `fs`.
 *
 * The termish-ts `FileSystem` protocol is bytes-only by design (it's
 * a general async-storage abstraction; backends shouldn't care about
 * JS-specific encodings). But agents reach for whichever ecosystem's
 * file-IO convention comes to mind first — Node, Deno, browser web
 * APIs — and they're not always the same person across turns. This
 * wrapper accepts the most common reflexes and routes them all to
 * the bytes-only protocol underneath:
 *
 *   const text = await fs.read(path, 'utf8')     // Node-style with encoding
 *   const text = await fs.readFile(path, 'utf8') // Node-standard alias
 *   const text = await fs.readText(path)         // Deno-flavored shortcut
 *
 *   await fs.write(path, 'hello')                // Node-style, string ok
 *   await fs.writeFile(path, 'hello')            // Node-standard alias
 *   await fs.writeText(path, 'hello')            // Deno-flavored shortcut
 *
 * Bytes-form still works identically for code that wants the raw
 * form: `fs.read(path)` / `fs.write(path, bytes)` / `fs.readFile(path)`
 * / `fs.writeFile(path, bytes)`.
 *
 * Used at the agex injection boundary in both `evalRuntime` (host
 * realm) and `agex-runtime-worker` (the bridged fs proxy that runs
 * in the worker realm). Same wrapper, same agent-visible surface.
 */

import type { FileSystem } from 'termish-ts'

const utf8Decoder = new TextDecoder('utf-8')
const utf8Encoder = new TextEncoder()

/** Encodings the wrapper recognizes. `'utf8'` is the dominant case
 *  by far; the alias and raw-bytes form are included for parity with
 *  Node's `fs.readFile` API. Other encodings (base64, hex, latin1)
 *  can be added if real agent traffic needs them — for now, throw
 *  with a clear message so agents see the actual gap rather than a
 *  silent "you got bytes when you wanted text". */
const SUPPORTED_ENCODINGS = new Set(['utf8', 'utf-8'])

/** Decode bytes to string with the given encoding. Throws a clean
 *  error for anything we don't yet recognize so the agent sees a
 *  fixable error instead of a surprising default. */
function decodeBytes(bytes: Uint8Array, encoding: string): string {
  const enc = encoding.toLowerCase()
  if (enc === 'utf8' || enc === 'utf-8') return utf8Decoder.decode(bytes)
  throw new Error(
    `fs.read: unsupported encoding '${encoding}' — supported: ${[...SUPPORTED_ENCODINGS].join(', ')}. For other encodings, read as bytes (omit the second argument) and decode manually with a TextDecoder.`,
  )
}

/**
 * Wrap a bytes-only `FileSystem`-shaped object so the agent can use
 * the conventional `fs.read(path, 'utf8')` / `fs.write(path, str)`
 * patterns. The returned object proxies all other methods through
 * unchanged.
 *
 * Accepts a structural subset of `FileSystem` so the wrapper works
 * equally well over the host's real VFS (eval runtime) and the
 * RPC-bridged proxy (worker runtime). Either way the underlying
 * `read`/`write` are invoked with bytes; the wrapper handles the
 * string<->bytes shuffle.
 */
export function wrapAgentFs<F extends Pick<FileSystem, 'read' | 'write'>>(fs: F): F {
  // Build the read/write helpers as closures over the target so the
  // alias methods can share a single implementation rather than
  // duplicating the encoding-shuffle logic per alias.
  const doRead = async (path: string, encoding?: string): Promise<Uint8Array | string> => {
    const bytes = await fs.read(path)
    if (encoding === undefined) return bytes
    return decodeBytes(bytes, encoding)
  }
  const doWrite = async (
    path: string,
    content: Uint8Array | string,
    mode?: 'w' | 'a',
  ): Promise<void> => {
    const bytes = typeof content === 'string' ? utf8Encoder.encode(content) : content
    // The underlying signature takes (path, bytes, mode?). Mode
    // pass-through preserves the existing 'a' append semantics.
    return fs.write(path, bytes, mode)
  }
  // `readText` / `writeText` are the Deno-flavored shortcuts: text
  // is the only shape, no encoding arg needed (UTF-8 implied).
  const doReadText = (path: string): Promise<string> => doRead(path, 'utf8') as Promise<string>
  const doWriteText = (path: string, str: string, mode?: 'w' | 'a'): Promise<void> =>
    doWrite(path, str, mode)

  // Method aliases the agent's reflex might reach for. `read`/`write`
  // are the canonical termish-ts surface; `readFile`/`writeFile` mirror
  // Node's standard names; `readText`/`writeText` are the Deno-flavored
  // shortcuts. All collapse to the same backing implementation — there's
  // no behavior difference between aliases.
  const aliases: Record<string, unknown> = {
    read: doRead,
    readFile: doRead,
    readText: doReadText,
    write: doWrite,
    writeFile: doWrite,
    writeText: doWriteText,
  }

  // Proxy lets us intercept the alias set while delegating every
  // other method (existing or future) to the underlying
  // implementation without listing them. Important because the
  // worker bridge proxy has its own surface that may grow over
  // time — we don't want to accidentally hide methods.
  return new Proxy(fs as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in aliases) {
        return aliases[prop]
      }
      const value = Reflect.get(target, prop, receiver)
      // Bind class methods to the real target so they can access
      // private fields. Without this, calling e.g. `proxy.exists(p)`
      // would invoke `exists` with `this === proxy`, and any access
      // to a `#privateField` inside the method would throw because
      // the proxy isn't an instance of the underlying class.
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as F
}
