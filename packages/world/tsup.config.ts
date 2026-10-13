import { defineConfig } from 'tsup'

export default defineConfig({
  // The kernel's workers are entries of their own, so the host finds
  // them with `new URL('./worker.js', import.meta.url)`, a form every
  // bundler understands.
  entry: {
    index: 'src/index.ts',
    'conformance/index': 'src/conformance/index.ts',
    worker: 'src/worker.ts',
    'worker.node': 'src/worker.node.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', 'conformance/index': 'src/conformance/index.ts' } },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
})
