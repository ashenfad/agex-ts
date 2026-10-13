/**
 * Python difflib's `unified_diff`, on kvgit's port of its
 * `SequenceMatcher`, so a diff here prints the hunks Python prints:
 * the same grouping (`get_grouped_opcodes`, three lines of context) and
 * the same range spelling.
 */

import { type Opcode, SequenceMatcher } from '@agex-ts/kvgit'

/** `SequenceMatcher.get_grouped_opcodes(n)`: hunks of changes with up
 *  to `n` lines of context. */
export function groupedOpcodes(codes: readonly Opcode[], n = 3): Opcode[][] {
  let list = codes.map((c) => ({ ...c }))
  if (list.length === 0) list = [{ tag: 'equal', aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 }]
  const first = list[0] as Opcode
  if (first.tag === 'equal') {
    list[0] = {
      ...first,
      aStart: Math.max(first.aStart, first.aEnd - n),
      bStart: Math.max(first.bStart, first.bEnd - n),
    }
  }
  const last = list[list.length - 1] as Opcode
  if (last.tag === 'equal') {
    list[list.length - 1] = {
      ...last,
      aEnd: Math.min(last.aEnd, last.aStart + n),
      bEnd: Math.min(last.bEnd, last.bStart + n),
    }
  }
  const nn = n + n
  const groups: Opcode[][] = []
  let group: Opcode[] = []
  for (const c of list) {
    let { aStart: i1, aEnd: i2, bStart: j1, bEnd: j2 } = c
    // A long stretch of equal lines ends one hunk and starts the next.
    if (c.tag === 'equal' && i2 - i1 > nn) {
      group.push({
        tag: 'equal',
        aStart: i1,
        aEnd: Math.min(i2, i1 + n),
        bStart: j1,
        bEnd: Math.min(j2, j1 + n),
      })
      groups.push(group)
      group = []
      i1 = Math.max(i1, i2 - n)
      j1 = Math.max(j1, j2 - n)
    }
    group.push({ tag: c.tag, aStart: i1, aEnd: i2, bStart: j1, bEnd: j2 })
  }
  if (group.length > 0 && !(group.length === 1 && group[0]?.tag === 'equal')) groups.push(group)
  return groups
}

/** difflib's `_format_range_unified`. */
function range(start: number, stop: number): string {
  let beginning = start + 1
  const length = stop - start
  if (length === 1) return `${beginning}`
  if (length === 0) beginning -= 1
  return `${beginning},${length}`
}

/**
 * difflib's `unified_diff(a, b, fromfile, tofile, lineterm='')`: the
 * lines are kept with their endings, as Python's are, and each output
 * line is one string (a content line keeps its ending; the caller
 * strips it).
 */
export function unifiedDiff(
  a: readonly string[],
  b: readonly string[],
  fromfile: string,
  tofile: string,
  n = 3,
): string[] {
  const out: string[] = []
  const matcher = new SequenceMatcher<string>(null, a, b)
  let started = false
  for (const group of groupedOpcodes(matcher.getOpcodes(), n)) {
    if (!started) {
      started = true
      out.push(`--- ${fromfile}`, `+++ ${tofile}`)
    }
    const first = group[0] as Opcode
    const last = group[group.length - 1] as Opcode
    out.push(`@@ -${range(first.aStart, last.aEnd)} +${range(first.bStart, last.bEnd)} @@`)
    for (const c of group) {
      if (c.tag === 'equal') {
        for (const line of a.slice(c.aStart, c.aEnd)) out.push(` ${line}`)
        continue
      }
      if (c.tag === 'replace' || c.tag === 'delete') {
        for (const line of a.slice(c.aStart, c.aEnd)) out.push(`-${line}`)
      }
      if (c.tag === 'replace' || c.tag === 'insert') {
        for (const line of b.slice(c.bStart, c.bEnd)) out.push(`+${line}`)
      }
    }
  }
  return out
}

/** Python's `str.splitlines(keepends=True)`. */
export function splitLinesKeepEnds(text: string): string[] {
  const out: string[] = []
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the separators Python's splitlines splits on
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g
  let start = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(text.slice(start, m.index + m[0].length))
    start = m.index + m[0].length
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}
