import { defineConfig } from 'tsup'

export default defineConfig({
  // The client is the page's entry, and loads neither SQLite nor kvgit;
  // the worker is the default worker's.
  entry: ['src/index.ts', 'src/client.ts', 'src/worker.ts'],
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
