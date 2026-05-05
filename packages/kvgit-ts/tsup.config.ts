import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/backends/memory.ts', 'src/backends/idb.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
})
