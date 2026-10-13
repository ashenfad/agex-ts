import { cborCodec } from '@agex-ts/kvgit'
import { InvalidNameError, ReadOnlyError } from './errors'
import type { KeyReader, KeyWriter } from './fs'
import { CACHE_PREFIX } from './layout'
import { storable } from './values'

/**
 * A session's cache: named values kept with its files.
 *
 * Versioned like everything else in the session: an entry commits with
 * the next commit, and forks and checkouts carry it. It is left out of
 * file diffs. Values are what a stored value is (see `values`): data,
 * bytes, typed arrays, `Map`, `Set`, `Date`, `RegExp`, bigints; one
 * holding anything else (a class's instance, a function) is refused
 * with `Unencodable` rather than stored changed. Values are copied in
 * and out, so changing one afterwards changes nothing stored.
 *
 * Keys are strings that don't start with `__` and contain no `/`.
 */
export class WorkspaceCache {
  readonly #view: KeyReader
  readonly #writable: () => boolean

  /** @internal Made by the workspace. */
  constructor(view: KeyReader, writable: () => boolean = () => true) {
    this.#view = view
    this.#writable = writable
  }

  /** A copy of the value, or undefined if the key isn't set. */
  async get(key: string): Promise<unknown> {
    const value = await this.#view.get(CACHE_PREFIX + checkKey(key))
    return value === undefined ? undefined : cborCodec.decode(cborCodec.encode(value))
  }

  async has(key: string): Promise<boolean> {
    return (await this.#view.get(CACHE_PREFIX + checkKey(key))) !== undefined
  }

  /** The cache's keys, sorted. */
  async keys(): Promise<string[]> {
    return (await this.#view.keys())
      .filter((k) => k.startsWith(CACHE_PREFIX))
      .map((k) => k.slice(CACHE_PREFIX.length))
  }

  set(key: string, value: unknown): void {
    const k = CACHE_PREFIX + checkKey(key)
    if (value === undefined) throw new TypeError('a cache value cannot be undefined')
    storable(value)
    this.#writer().set(k, cborCodec.decode(cborCodec.encode(value)))
  }

  /** @returns false if the key was not there. */
  async delete(key: string): Promise<boolean> {
    return this.#writer().delete(CACHE_PREFIX + checkKey(key))
  }

  #writer(): KeyWriter {
    const view = this.#view as Partial<KeyWriter>
    if (typeof view.set !== 'function' || !this.#writable()) {
      throw new ReadOnlyError('this cache is read-only')
    }
    return this.#view as KeyWriter
  }
}

function checkKey(key: string): string {
  if (typeof key !== 'string' || key === '' || key.startsWith('__') || key.includes('/')) {
    throw new InvalidNameError(
      `cache key ${JSON.stringify(key)}: a key is a non-empty string, not starting with '__', without '/'`,
    )
  }
  return key
}
