import { describe, expect, it } from 'vitest'
import { parseSseEvents } from '../src/sse'

const enc = new TextEncoder()

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(enc.encode(chunks[i] as string))
      i++
    },
  })
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseSseEvents', () => {
  it('yields payloads of data: lines', async () => {
    const s = streamOf('data: one\ndata: two\n\n')
    expect(await collect(parseSseEvents(s))).toEqual(['one', 'two'])
  })

  it('stops on [DONE]', async () => {
    const s = streamOf('data: one\ndata: [DONE]\ndata: never\n')
    expect(await collect(parseSseEvents(s))).toEqual(['one'])
  })

  it('skips comments, empty lines, and unknown fields', async () => {
    const s = streamOf(': heartbeat\n\nevent: foo\ndata: ok\n\n')
    expect(await collect(parseSseEvents(s))).toEqual(['ok'])
  })

  it('handles \\r\\n line endings', async () => {
    const s = streamOf('data: a\r\ndata: b\r\n')
    expect(await collect(parseSseEvents(s))).toEqual(['a', 'b'])
  })

  it('reassembles a payload split across chunks', async () => {
    const s = streamOf('data: hel', 'lo wor', 'ld\n')
    expect(await collect(parseSseEvents(s))).toEqual(['hello world'])
  })

  it('flushes a final line without a trailing newline', async () => {
    const s = streamOf('data: trailing')
    expect(await collect(parseSseEvents(s))).toEqual(['trailing'])
  })

  it('accepts data: lines with no space (SSE spec — space is optional)', async () => {
    // Anthropic always sends 'data: <payload>' but the spec allows
    // either form. Be defensive against proxies/providers that omit
    // the space.
    const s = streamOf('data:no-space\ndata: with-space\n')
    expect(await collect(parseSseEvents(s))).toEqual(['no-space', 'with-space'])
  })

  it('accepts a no-space data: line in the trailing flush too', async () => {
    const s = streamOf('data:trailing-no-space')
    expect(await collect(parseSseEvents(s))).toEqual(['trailing-no-space'])
  })

  it('preserves multi-byte UTF-8 split across chunks', async () => {
    // U+1F600 grinning face is a 4-byte sequence; split between bytes 2 and 3
    const bytes = enc.encode('data: hi 😀\n')
    const split = 8 // byte position inside the 😀 sequence
    const a = bytes.slice(0, split)
    const b = bytes.slice(split)
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i === 0) {
          controller.enqueue(a)
          i++
        } else if (i === 1) {
          controller.enqueue(b)
          i++
        } else {
          controller.close()
        }
      },
    })
    expect(await collect(parseSseEvents(stream))).toEqual(['hi 😀'])
  })

  it('errors on a single line that exceeds the byte limit before a newline', async () => {
    const huge = `data: ${'x'.repeat(2_000_000)}`
    const s = streamOf(huge)
    await expect(async () => {
      for await (const _ of parseSseEvents(s)) {
        // drain
      }
    }).rejects.toThrow(/exceeded/)
  })
})
