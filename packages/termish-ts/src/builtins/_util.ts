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
