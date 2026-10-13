import { InvalidNameError } from './errors'
import { normalize } from './path'

/** A session id: letters, digits, `_`, `-` and `.`, not starting with
 *  `.`. A branch whose name isn't one (a tag's ref, a store branch
 *  starting with `@`) is never a session. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/

/** Where a store tag is kept: store tag `v1` is the repository tag
 *  `@store/v1`. A session's tag `v1` is `<session>/v1`. */
export const STORE_TAG_SCOPE = '@store/'

export function isSessionName(name: string): boolean {
  return SESSION_ID_RE.test(name)
}

export function checkSessionName(name: string): string {
  if (!isSessionName(name)) {
    throw new InvalidNameError(
      `session ${JSON.stringify(name)}: an id is letters, digits, '_', '-' and '.', not starting with '.'`,
    )
  }
  return name
}

/** A session tag's name: non-empty, without `%`, not starting with `@`. */
export function checkTagName(name: string): string {
  if (typeof name !== 'string' || name === '' || name.includes('%') || name.startsWith('@')) {
    throw new InvalidNameError(
      `tag ${JSON.stringify(name)}: a tag name is non-empty, without '%', not starting with '@'`,
    )
  }
  return name
}

/** A store tag's name: a session tag's rules, and no `@` or `:`. */
export function checkStoreTagName(name: string): string {
  checkTagName(name)
  if (name.includes('@') || name.includes(':')) {
    throw new InvalidNameError(`store tag ${JSON.stringify(name)}: a store tag has no '@' or ':'`)
  }
  // ws-git reads seven or more hex characters as a commit id first, so
  // a store tag spelled that way could never be reached by name.
  if (/^[0-9a-f]{7,}$/.test(name)) {
    throw new InvalidNameError(
      `store tag ${JSON.stringify(name)}: a store tag isn't spelled like a commit id (seven or more hex characters): a word that could be read as either would be neither`,
    )
  }
  return name
}

/** A workspace root: absolute, with no `.` or `..` segments. */
export function normalizeRoot(root: string): string {
  if (!root.startsWith('/')) {
    throw new InvalidNameError(`root ${JSON.stringify(root)} is not absolute`)
  }
  if (root.split('/').some((s) => s === '.' || s === '..')) {
    throw new InvalidNameError(`root ${JSON.stringify(root)} has a '.' or '..' segment`)
  }
  return normalize(root)
}
