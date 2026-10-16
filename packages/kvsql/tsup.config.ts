import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  // sqlite-wasm finds its .wasm file next to its own module; bundling
  // it would break that lookup.
  external: ['@sqlite.org/sqlite-wasm'],
})
