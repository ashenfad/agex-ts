/**
 * Python's `repr` of a string: how nontainer's messages quote a word
 * (`'name'`, or `"it's"`), and so how the world's ws-git messages,
 * which match them word for word, quote one too.
 */
export function repr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = ''
  for (const c of s) {
    if (c === '\\') out += '\\\\'
    else if (c === quote) out += `\\${c}`
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else out += c
  }
  return `${quote}${out}${quote}`
}
