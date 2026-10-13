import { defineWorkspace } from 'vitest/config'

/** The suite, once on each backend (see `tests/backends.ts`). */
export default defineWorkspace([
  { extends: './vitest.config.ts', test: { name: 'memory', env: { WORLD_BACKEND: 'memory' } } },
  { extends: './vitest.config.ts', test: { name: 'idb', env: { WORLD_BACKEND: 'idb' } } },
])
