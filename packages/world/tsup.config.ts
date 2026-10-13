import { defineConfig } from 'tsup'

export default defineConfig({
  // The kernel's workers are entries of their own, so the host finds
  // them with `new URL('./worker.js', import.meta.url)`, a form every
  // bundler understands.
  entry: ['src/index.ts', 'src/worker.ts', 'src/worker.node.ts'],
  format: ['esm'],
  dts: { entry: ['src/index.ts'] },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
})
