import { describe, expect, it } from 'vitest'
import { Store } from '../src/index'
import { newKV } from './backends'

describe("the terminal's variables", () => {
  it('have HOME as the root and PWD as the current directory', async () => {
    const store = await Store.open(await newKV())
    const ws = await store.open('s')
    const out = await ws.terminal('mkdir sub && cd sub && echo $HOME $PWD')
    expect(out.stdout).toBe('/workspace /workspace/sub\n')
  })

  it("take the profile's HOME, and its variables", async () => {
    const store = await Store.open(await newKV())
    const ws = await store.open('s', { root: '/w', profile: { variables: { HOME: '/home/me' } } })
    expect((await ws.terminal('echo $HOME')).stdout).toBe('/home/me\n')
    const other = await store.open('t', { root: '/w', profile: { variables: { NAME: 'x' } } })
    expect((await other.terminal('echo $HOME $NAME')).stdout).toBe('/w x\n')
  })

  it('stop a call at one that is unset, saying which', async () => {
    const store = await Store.open(await newKV())
    const ws = await store.open('s')
    const out = await ws.terminal('echo before; rm -r $NOPE/x; echo after')
    expect(out.stdout).toBe('before\n')
    expect(out.stderr).toContain('NOPE: unbound variable')
    expect(out.exitCode).toBe(1)
  })
})
