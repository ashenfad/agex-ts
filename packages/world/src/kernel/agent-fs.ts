/**
 * The `fs` code sees: the world's bytes-only filesystem, with the text
 * forms code reaches for from Node and Deno routed onto it.
 *
 *     await fs.read(path, 'utf8')      await fs.write(path, 'text')
 *     await fs.readFile(path, 'utf8')  await fs.writeFile(path, 'text')
 *     await fs.readText(path)          await fs.writeText(path, 'text')
 *
 * Without an encoding, `read` and `readFile` give bytes, and `write`
 * and `writeFile` take bytes as well as strings. Every other method
 * of `fs` (its own properties: the worker's bridge stub) passes
 * through.
 */

interface BytesFs {
  read(path: string): Promise<Uint8Array>
  write(path: string, content: Uint8Array, mode?: 'w' | 'a'): Promise<void>
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

function decode(bytes: Uint8Array, encoding: string): string {
  const enc = encoding.toLowerCase()
  if (enc === 'utf8' || enc === 'utf-8') return decoder.decode(bytes)
  throw new Error(
    `fs.read: unsupported encoding '${encoding}' (only utf8): read bytes without an encoding and decode them with a TextDecoder`,
  )
}

export function wrapAgentFs<F extends BytesFs>(fs: F): F {
  const read = async (path: string, encoding?: string): Promise<Uint8Array | string> => {
    const bytes = await fs.read(path)
    return encoding === undefined ? bytes : decode(bytes, encoding)
  }
  const write = (path: string, content: Uint8Array | string, mode?: 'w' | 'a'): Promise<void> =>
    fs.write(path, typeof content === 'string' ? encoder.encode(content) : content, mode)
  const aliases: Record<string, unknown> = {
    read,
    readFile: read,
    readText: (path: string) => read(path, 'utf8'),
    write,
    writeFile: write,
    writeText: (path: string, text: string, mode?: 'w' | 'a') => write(path, text, mode),
  }
  return Object.freeze({ ...fs, ...aliases }) as F
}
