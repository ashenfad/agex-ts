/**
 * Runs async calls one at a time, in the order they were queued. A call
 * that fails doesn't stop the ones after it.
 *
 * Not re-entrant by itself: a call that queues another call and awaits
 * it waits forever. The one way in is a call that names the call in
 * progress ({@link active}) as its own: it runs at once, as part of
 * that call. The workspace grants that to host methods code calls (see
 * `withCall`); code inside a call otherwise uses the unqueued parts of
 * the workspace (`files.fs`, `cache`).
 */
export class Queue {
  #tail: Promise<unknown> = Promise.resolve()
  #active: symbol | null = null

  /** The call in progress, while there is one. */
  get active(): symbol | null {
    return this.#active
  }

  /** Queue `fn`, or run it now when `within` is the call in progress. */
  run<T>(fn: () => Promise<T>, within: symbol | null = null): Promise<T> {
    if (within !== null && within === this.#active) return fn()
    const result = this.#tail.then(async () => {
      this.#active = Symbol('call')
      try {
        return await fn()
      } finally {
        this.#active = null
      }
    })
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
