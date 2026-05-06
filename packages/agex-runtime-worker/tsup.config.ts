import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entry points:
  //   - `index.ts` — host-side: `workerRuntime()` factory and types.
  //   - `worker.ts` — what runs *inside* the spawned Web Worker.
  //     Bundled to its own file so consumers (and our own host code)
  //     can reference it via `new URL('./worker.js', import.meta.url)`,
  //     which Vite / webpack / esbuild all understand and fingerprint
  //     correctly during their own build.
  entry: ['src/index.ts', 'src/worker.ts'],
  format: ['esm'],
  dts: { entry: ['src/index.ts'] },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
})
