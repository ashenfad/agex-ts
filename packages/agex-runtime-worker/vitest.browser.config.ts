/**
 * Vitest browser-mode config — Web Workers are the whole point of
 * this package, so tests have to run in a real browser. Playwright
 * (Chromium) is the provider; first-time local setup needs
 * `pnpm exec playwright install chromium`.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    browser: {
      enabled: true,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
    },
  },
  // Pre-bundle DuckDB-WASM (used by tests/fixtures/duckdb-fixture.ts)
  // so the dep optimizer doesn't kick in mid-test and reload the page,
  // which Vitest warns about and can cause flaky test ordering.
  optimizeDeps: {
    include: ['@duckdb/duckdb-wasm'],
  },
})
