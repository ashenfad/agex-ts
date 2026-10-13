/** The suite runs once per backend: each run is on the one it names. */

import { IndexedDB } from '@agex-ts/kvgit/backends/idb'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { expect, it } from 'vitest'
import { BACKEND, BACKENDS, newKV } from './backends'

it('runs on the backend it names', async () => {
  expect(BACKENDS.map(([name]) => name)).toEqual([BACKEND])
  const kv = await newKV()
  expect(kv).toBeInstanceOf(BACKEND === 'idb' ? IndexedDB : Memory)
})
