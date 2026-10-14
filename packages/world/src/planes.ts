/**
 * A harness's own records in a session's branch: `ws.plane(name)`.
 *
 * A plane is a set of keyed values beside the files, the conversation
 * and compaction's record, under `__plane__/<name>/`. Code and tools
 * never see it, and a commit, a fork or a checkout carries it with
 * everything else, so a record says how things stood at any commit. A
 * write is left for the next commit to carry, as a fold's is.
 *
 * agex keeps a task's spec, inputs, state and value on its `__task__`
 * plane, so a task resumes from its world alone.
 */

import { InvalidNameError, ReadOnlyError } from './errors'
import type { KeyReader, KeyWriter } from './fs'
import { PLANE_PREFIX } from './layout'

const PLANE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** The key prefix of plane `name`. */
export function planePrefix(name: string): string {
  if (!PLANE_NAME.test(name)) {
    throw new InvalidNameError(
      `plane ${JSON.stringify(name)}: a name is letters, digits and _ . -, not starting with . or -`,
    )
  }
  return `${PLANE_PREFIX}${name}/`
}

/** One plane of a workspace: see the module's doc. */
export class WorkspacePlane {
  readonly name: string
  readonly #prefix: string
  readonly #view: KeyReader
  readonly #writable: () => boolean

  /** @internal Made by the workspace. */
  constructor(name: string, view: KeyReader, writable: () => boolean = () => true) {
    this.name = name
    this.#prefix = planePrefix(name)
    this.#view = view
    this.#writable = writable
  }

  /** The value at `key`, pending writes included; null for none. */
  async get(key: string): Promise<unknown> {
    return (await this.#view.get(this.#prefix + key)) ?? null
  }

  /** The plane's keys, sorted. */
  async keys(): Promise<string[]> {
    return (await this.#view.keys())
      .filter((k) => k.startsWith(this.#prefix))
      .map((k) => k.slice(this.#prefix.length))
      .sort()
  }

  /**
   * Set `key`, for the next commit to carry.
   *
   * @throws ReadOnlyError on a frozen or closed workspace.
   */
  set(key: string, value: unknown): void {
    this.#writer().set(this.#prefix + key, value)
  }

  /** Delete `key`; whether it was there. */
  delete(key: string): Promise<boolean> {
    return this.#writer().delete(this.#prefix + key)
  }

  /** Delete every key of the plane. */
  async clear(): Promise<void> {
    const writer = this.#writer()
    for (const key of await this.keys()) await writer.delete(this.#prefix + key)
  }

  #writer(): KeyWriter {
    const view = this.#view as Partial<KeyWriter>
    if (typeof view.set !== 'function' || !this.#writable()) {
      throw new ReadOnlyError(`this workspace cannot write its ${this.name} plane`)
    }
    return this.#view as KeyWriter
  }
}
