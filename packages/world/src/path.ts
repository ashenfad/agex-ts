/**
 * POSIX-style path helpers: absolute, `/`-separated, the same on every
 * host.
 */

/** Collapse `.` and `..` segments, dedupe slashes, return absolute. */
export function normalize(path: string): string {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (out.length > 0) out.pop()
    } else {
      out.push(seg)
    }
  }
  return `/${out.join('/')}`
}

/** Resolve `path` against `cwd` and normalize. Relative paths anchor
 *  to `cwd`; absolute paths normalize directly. */
export function resolve(path: string, cwd: string): string {
  const combined = path.startsWith('/') ? path : `${cwd}/${path}`
  return normalize(combined)
}

/** POSIX `dirname`: parent directory, `/` for top-level entries. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

/** POSIX `basename`: last segment, or `''` for root `/`. */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return path.slice(idx + 1)
}

/** Join a parent path and a relative path with a single slash. */
export function joinPath(parent: string, child: string): string {
  if (parent === '/') return `/${child}`
  return `${parent}/${child}`
}

/** Whether `path` is `dir` or inside it. */
export function within(path: string, dir: string): boolean {
  return dir === '/' || path === dir || path.startsWith(`${dir}/`)
}
