import { defineConfig } from 'tsup'

export default defineConfig({
  // Entry points:
  //   - `index.ts` — host-side: `workerRuntime()` factory and types.
  //   - `worker.ts` — what runs inside a browser Web Worker.
  //   - `worker.node.ts` — what runs inside a Node `worker_threads`
  //     worker. Same core logic (`worker-core.ts`), different platform
  //     port (`self` vs `parentPort`).
  //   Each worker is bundled to its own file so consumers (and our own
  //   host code) can reference it via `new URL('./worker.js', …)` /
  //   `new URL('./worker.node.js', …)`, which Vite / webpack / esbuild
  //   all understand and fingerprint correctly during their own build.
  entry: ['src/index.ts', 'src/worker.ts', 'src/worker.node.ts'],
  format: ['esm'],
  dts: { entry: ['src/index.ts'] },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
})
