import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

describe('wc', () => {
  it('default shows lines, words, bytes', async () => {
    const out = await execute("echo 'hello world' | wc", new MemoryFS())
    // 1 line (\n at end), 2 words, 12 bytes ("hello world\n")
    expect(out.trim().split(/\s+/)).toEqual(['1', '2', '12'])
  })

  it('-l shows only line count', async () => {
    const out = await execute("echo -ne 'a\\nb\\nc\\n' | wc -l", new MemoryFS())
    expect(out.trim()).toBe('3')
  })

  it('-w shows only word count', async () => {
    const out = await execute("echo 'one two three' | wc -w", new MemoryFS())
    expect(out.trim()).toBe('3')
  })

  it('-c shows only byte count', async () => {
    const out = await execute('echo abc | wc -c', new MemoryFS())
    // "abc\n" = 4 bytes
    expect(out.trim()).toBe('4')
  })

  it('multi-file totals are appended', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('one\n'))
    await fs.write('/b', bytes('two\nthree\n'))
    const out = await execute('wc -l /a /b', fs)
    const lines = out.trim().split('\n')
    expect(lines.length).toBe(3)
    expect(lines[2]?.trim().endsWith('total')).toBe(true)
  })

  it('-L shows max line length', async () => {
    const out = await execute("echo -e 'short\\nlonger line' | wc -L", new MemoryFS())
    expect(out.trim()).toBe('11') // 'longer line' has 11 chars
  })
})

describe('sort', () => {
  it('lexicographic sort', async () => {
    const out = await execute("echo -e 'banana\\napple\\ncherry' | sort", new MemoryFS())
    expect(out).toBe('apple\nbanana\ncherry\n')
  })

  it('-r reverses', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | sort -r", new MemoryFS())
    expect(out).toBe('c\nb\na\n')
  })

  it('-n sorts numerically (10 after 2)', async () => {
    const out = await execute("echo -e '10\\n2\\n100\\n1' | sort -n", new MemoryFS())
    expect(out).toBe('1\n2\n10\n100\n')
  })

  it('-u removes duplicates', async () => {
    const out = await execute("echo -e 'a\\nb\\na\\nb\\nc' | sort -u", new MemoryFS())
    expect(out).toBe('a\nb\nc\n')
  })

  it('-f ignore case', async () => {
    const out = await execute("echo -e 'Banana\\napple\\nCherry' | sort -f", new MemoryFS())
    expect(out).toBe('apple\nBanana\nCherry\n')
  })

  it('-k field-based sort', async () => {
    const out = await execute("echo -e 'b 1\\na 2\\nc 3' | sort -k 2 -n", new MemoryFS())
    expect(out).toBe('b 1\na 2\nc 3\n')
  })

  it('-t custom field separator', async () => {
    const out = await execute("echo -e 'b,1\\na,2\\nc,3' | sort -t , -k 1", new MemoryFS())
    expect(out).toBe('a,2\nb,1\nc,3\n')
  })

  it('reads files', async () => {
    const fs = new MemoryFS()
    await fs.write('/data', bytes('c\na\nb\n'))
    expect(await execute('sort /data', fs)).toBe('a\nb\nc\n')
  })
})

describe('uniq', () => {
  it('collapses adjacent duplicates', async () => {
    const out = await execute("echo -e 'a\\na\\nb\\nb\\nb\\nc' | uniq", new MemoryFS())
    expect(out).toBe('a\nb\nc\n')
  })

  it('does NOT collapse non-adjacent (needs sort first)', async () => {
    const out = await execute("echo -e 'a\\nb\\na' | uniq", new MemoryFS())
    expect(out).toBe('a\nb\na\n')
  })

  it('-c prefixes counts', async () => {
    const out = await execute("echo -e 'a\\na\\nb' | uniq -c", new MemoryFS())
    // counts are 7-char right-justified
    expect(out).toBe('      2 a\n      1 b\n')
  })

  it('-d only emits repeated', async () => {
    const out = await execute("echo -e 'a\\na\\nb' | uniq -d", new MemoryFS())
    expect(out).toBe('a\n')
  })

  it('-u only emits unique (count == 1)', async () => {
    const out = await execute("echo -e 'a\\na\\nb' | uniq -u", new MemoryFS())
    expect(out).toBe('b\n')
  })

  it('-i ignores case when comparing', async () => {
    const out = await execute("echo -e 'A\\na\\nB' | uniq -i", new MemoryFS())
    expect(out).toBe('A\nB\n')
  })
})

describe('cut', () => {
  it('-d , -f selects fields with comma delimiter', async () => {
    const out = await execute("echo 'a,b,c,d' | cut -d , -f 2", new MemoryFS())
    expect(out).toBe('b\n')
  })

  it('-f with multiple field numbers', async () => {
    const out = await execute("echo 'a,b,c,d' | cut -d , -f 1,3", new MemoryFS())
    expect(out).toBe('a,c\n')
  })

  it('-f with a closed range', async () => {
    const out = await execute("echo 'a,b,c,d,e' | cut -d , -f 2-4", new MemoryFS())
    expect(out).toBe('b,c,d\n')
  })

  it('-f with an open-ended range goes to end of line', async () => {
    const out = await execute("echo 'a,b,c,d,e' | cut -d , -f 3-", new MemoryFS())
    expect(out).toBe('c,d,e\n')
  })

  it('-c selects characters', async () => {
    const out = await execute("echo 'abcdef' | cut -c 1-3", new MemoryFS())
    expect(out).toBe('abc\n')
  })

  it('--complement inverts selection', async () => {
    const out = await execute("echo 'a,b,c,d' | cut -d , -f 2 --complement", new MemoryFS())
    expect(out).toBe('a,c,d\n')
  })

  it('--output-delimiter overrides join character', async () => {
    const out = await execute(
      "echo 'a,b,c' | cut -d , -f 1,3 --output-delimiter='|'",
      new MemoryFS(),
    )
    expect(out).toBe('a|c\n')
  })

  it('errors when neither -f nor -c is given', async () => {
    await expect(execute('echo a | cut', new MemoryFS())).rejects.toThrow(/must specify/)
  })

  it('handles tab delimiter via \\t escape in -d', async () => {
    const out = await execute("echo -e 'a\\tb\\tc' | cut -d '\\t' -f 2", new MemoryFS())
    expect(out).toBe('b\n')
  })
})

describe('tr', () => {
  it('translates char-for-char', async () => {
    const out = await execute('echo abc | tr a-c x-z', new MemoryFS())
    expect(out).toBe('xyz\n')
  })

  it('-d deletes chars in SET1', async () => {
    const out = await execute("echo 'hello' | tr -d l", new MemoryFS())
    expect(out).toBe('heo\n')
  })

  it('-s squeezes runs of SET1 chars', async () => {
    const out = await execute("echo 'aaabbbccc' | tr -s a", new MemoryFS())
    expect(out).toBe('abbbccc\n')
  })

  it('uppercase via [:lower:] [:upper:] character classes', async () => {
    const out = await execute("echo 'hello world' | tr '[:lower:]' '[:upper:]'", new MemoryFS())
    expect(out).toBe('HELLO WORLD\n')
  })

  it('-c complements SET1 (translate everything OUTSIDE the set)', async () => {
    // delete all non-digits
    const out = await execute("echo 'a1b2c3' | tr -cd '[:digit:]'", new MemoryFS())
    expect(out).toBe('123')
  })

  it('SET2 padded with last char when shorter than SET1', async () => {
    const out = await execute("echo 'abcd' | tr a-d 'x'", new MemoryFS())
    expect(out).toBe('xxxx\n')
  })

  it('range expansion', async () => {
    const out = await execute("echo 'hello' | tr a-z A-Z", new MemoryFS())
    expect(out).toBe('HELLO\n')
  })

  it('errors with no operands', async () => {
    await expect(execute('echo a | tr', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })
})
