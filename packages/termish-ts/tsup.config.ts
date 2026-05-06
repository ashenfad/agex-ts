import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/glob.ts', 'src/fs/memory.ts', 'src/fs/real.ts', 'src/fs/kvgit.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
})
