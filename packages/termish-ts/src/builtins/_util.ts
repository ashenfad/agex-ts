/**
 * Shared helpers for builtin implementations.
 */

/**
 * Human-readable byte size.
 *
 * | Size | Output |
 * |---|---|
 * | < 1 KiB | `123B` (no decimal) |
 * | < 1 MiB | `12.3K` |
 * | < 1 GiB | `4.5M` |
 * | etc.    | one decimal place, IEC unit suffix |
 *
 * Matches `ls -h` formatting from termish-py.
 */
export function humanSize(size: number): string {
  let n = size
  const units = ['B', 'K', 'M', 'G', 'T']
  for (const unit of units) {
    if (Math.abs(n) < 1024) {
      return unit === 'B' ? `${Math.round(n)}${unit}` : `${n.toFixed(1)}${unit}`
    }
    n /= 1024
  }
  return `${n.toFixed(1)}P`
}

/** Format an ISO timestamp's first 16 chars with `T` → space, like
 *  `2024-01-15T10:30` → `2024-01-15 10:30`. Pads to 16 chars on
 *  empty / missing input. */
export function formatLsTime(modifiedAt: string | undefined): string {
  if (!modifiedAt) return ' '.repeat(16)
  return modifiedAt.slice(0, 16).replace('T', ' ')
}

/** Pad a string to a minimum width by left-padding with spaces. */
export function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s
}

/** Binary-content sniff over the first 4KB of bytes. Returns true for
 *  blobs that would only waste tokens if dumped:
 *
 *  - any NUL byte (0x00) — almost never appears in real text
 *  - C0 / DEL control chars (excluding `\t \n \r`) above ~1% of the
 *    sample
 *
 *  Plain UTF-8 text, JSON, source code, markdown, and CSVs all pass
 *  comfortably; PNG/JPEG/protobuf/sqlite/etc. trip the gate. The
 *  base64-in-source workaround case is *not* binary by this measure
 *  (it's all printable ASCII) — the output cap on `executeScript` is
 *  the safety net for that case. */
export function looksLikeBinary(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4096))
  let suspect = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i] as number
    if (b === 0) return true
    // Control chars except TAB (0x09), LF (0x0A), CR (0x0D).
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
      suspect++
    }
  }
  return suspect / sample.length > 0.01
}
