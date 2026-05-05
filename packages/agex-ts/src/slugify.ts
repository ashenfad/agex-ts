/**
 * `slugify` — turn a chapter name into a URL-safe path segment.
 *
 * Used both by the VFS overlay (path = `/chapters/<slug>/`) and by
 * the wire-format renderer that surfaces those paths to the agent
 * ("Full details: /chapters/<slug>/"). Both must agree on the same
 * canonical value, so the slug is computed once at chapter-creation
 * time and stored on `ChapterEvent.slug`.
 *
 * Rules:
 *   - lowercase ASCII letters/digits/hyphens
 *   - whitespace and punctuation collapse to a single hyphen
 *   - leading/trailing hyphens stripped
 *   - empty input or all-non-ASCII falls back to `'chapter'`
 *   - collision handling via `uniqueSlug(base, taken)` — appends
 *     `-2`, `-3`, ... until the result isn't in `taken`
 */

export function slugify(input: string): string {
  const normalized = input
    .toLowerCase()
    // Replace any non-alphanumeric run with a single hyphen
    .replace(/[^a-z0-9]+/g, '-')
    // Strip leading and trailing hyphens
    .replace(/^-+|-+$/g, '')
  if (normalized.length === 0) return 'chapter'
  return normalized
}

/** Pick a slug that isn't already in `taken`. Appends a numeric
 *  suffix starting at 2 until the result is unique. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
