/**
 * Vitest browser-mode config: the tests that need a real browser
 * (OPFS, workers). Chromium by default; CI also runs Firefox and
 * WebKit with `--browser.name`. Locally, install the browsers once
 * with `pnpm exec playwright install chromium firefox webkit`.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // sqlite-wasm loads its .wasm relative to its own module, which the
  // dependency optimizer would move.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  test: {
    include: ['tests/**/*.browser.test.ts'],
    globals: false,
    browser: {
      enabled: true,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
    },
  },
})
