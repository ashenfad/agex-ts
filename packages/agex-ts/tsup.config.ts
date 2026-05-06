import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/types.ts',
    'src/errors.ts',
    'src/policy.ts',
    'src/state/index.ts',
    'src/llm/dummy.ts',
    'src/runtime/eval.ts',
    'src/runtime/module-loader.ts',
    'src/render/index.ts',
    'src/providers/index.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
})
