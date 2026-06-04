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
  // Pre-bundle deps that would otherwise trip Vite's optimizer mid-run
  // (it reloads the page, which Vitest warns can cause flaky/duplicated
  // tests). DuckDB-WASM: the bytes-shuttling fixture. @cfworker/json-schema
  // + fflate: pulled in transitively by `agex-ts` once the spawn-e2e test
  // imports the full agent (output-schema validation, kvgit compression).
  optimizeDeps: {
    include: ['@duckdb/duckdb-wasm', '@cfworker/json-schema', 'fflate'],
  },
})
