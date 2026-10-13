import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    setupFiles: ['./tests/setup-fake-indexeddb.ts'],
  },
})
