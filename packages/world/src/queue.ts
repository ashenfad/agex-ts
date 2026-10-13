/**
 * Runs async calls one at a time, in the order they were queued. A call
 * that fails doesn't stop the ones after it.
 *
 * Not re-entrant: a call that queues another call on the same queue and
 * awaits it waits forever. Code running inside a call uses the
 * unqueued parts of the workspace (`ws.files.fs`, `ws.cache`).
 */
export class Queue {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
