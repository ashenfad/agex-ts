/**
 * Vitest config for the *Node* lane. Today this lane has nothing to
 * run — Web Workers are the whole point of the package and need a
 * real browser, which lives in `vitest.browser.config.ts`.
 *
 * The split (and the deliberately scoped `include` here) is what
 * keeps `pnpm -r test` green on the workspace's Node CI runner: the
 * default-glob pickup would otherwise drag in the browser-only
 * `tests/smoke.test.ts` and explode on `Worker is not defined`.
 *
 * Future Node-runnable unit tests (e.g. for the `transform` module,
 * which is Node-safe) can land under `tests/node/` and be picked up
 * automatically.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
  },
})
