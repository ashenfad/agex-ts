/**
 * Skills, after nontainer's: the profile's are mounted read-only, an
 * agent's own are files it writes beside them, and the catalog lists
 * both for the tool text.
 */

import { describe, expect, it } from 'vitest'
import {
  FILE_PREFIX,
  Store,
  type Workspace,
  frontmatter,
  skillCatalog,
  skillName,
  toolInstructions,
} from '../src/index'
import { newKV } from './backends'

const NUMBERS = `---
name: numbers
description: Doing arithmetic with care
---
# Numbers

Check every sum twice.
`

const MEDIA = {
  name: 'media',
  files: {
    'SKILL.md': '---\ndescription: Making images and sound\n---\nUse helpers/make.ts.\n',
    'helpers/make.ts': 'export const make = () => 1\n',
  },
}

async function open(profile = {}): Promise<Workspace> {
  return (await Store.open(await newKV())).open('s', { profile })
}

describe('frontmatter', () => {
  it('reads top-level fields, and nothing else', () => {
    expect(frontmatter(NUMBERS)).toEqual({
      name: 'numbers',
      description: 'Doing arithmetic with care',
    })
    expect(frontmatter('﻿---\nName: "quoted"\nnested:\n  inner: no\n---\n')).toEqual({
      name: 'quoted',
      nested: '',
    })
    expect(frontmatter('no block here')).toEqual({})
    expect(frontmatter('---\nunterminated: yes\n')).toEqual({})
  })

  it('names a skill by its frontmatter, else by the name it was given', () => {
    expect(skillName(NUMBERS)).toBe('numbers')
    expect(skillName(MEDIA)).toBe('media')
    expect(skillName({ name: 'My Skill!', files: { 'SKILL.md': '# none' } })).toBe('my-skill')
    expect(() => skillName({ files: { 'notes.md': 'x' } })).toThrow(/SKILL\.md/)
    expect(() => skillName({ files: { 'SKILL.md': 'x', '../escape': 'y' } })).toThrow(/inside/)
  })
})

describe('mounted skills', () => {
  it("are read-only, beside the agent's own, and no commit's", async () => {
    const ws = await open({ skills: [NUMBERS, MEDIA] })
    expect(ws.mountedSkills).toEqual(['media', 'numbers'])
    // the agent writes a skill of its own: ordinary files
    await ws.terminal('mkdir -p skills/mine && echo "# mine" > skills/mine/SKILL.md')
    const head = ws.head
    expect((await ws.terminal('cat /workspace/skills/numbers/SKILL.md')).stdout).toBe(NUMBERS)
    expect((await ws.terminal('ls /workspace/skills')).stdout).toBe('media\nmine\nnumbers\n')
    expect((await ws.terminal('cd skills && ls && cd media && ls')).stdout).toBe(
      'media\nmine\nnumbers\nSKILL.md\nhelpers\n',
    )
    const write = await ws.terminal('echo no > /workspace/skills/numbers/SKILL.md')
    expect(write.exitCode).not.toBe(0)
    expect(write.stderr).toMatch(/read-only/)
    expect((await ws.terminal('rm -r /workspace/skills/numbers')).exitCode).not.toBe(0)
    // not the session's files: no commit holds them, and ws-git sees none
    const changed = await ws.diff(head)
    expect([...changed.added, ...changed.modified].filter((p) => p.includes('/skills/'))).toEqual(
      [],
    )
    const snapshot = await ws.store.repo.snapshot({ commit: ws.head })
    expect(await snapshot.get(`${FILE_PREFIX}/workspace/skills/numbers/SKILL.md`)).toBeUndefined()
    expect(await snapshot.get(`${FILE_PREFIX}/workspace/skills/mine/SKILL.md`)).toBeDefined()
    expect(ws.uncommitted).toBe(false)
    // ws-git sees the agent's own skill as its work, and never a mounted one
    expect((await ws.index.status()).unstaged).toEqual(['/workspace/skills/mine/SKILL.md'])
    await ws.close()
  })

  it('stand alone, before the agent writes one of its own', async () => {
    const ws = await open({ skills: [NUMBERS] })
    expect(await ws.files.fs.isDir('/workspace/skills')).toBe(true)
    expect((await ws.files.fs.stat('/workspace/skills')).isDir).toBe(true)
    expect((await ws.terminal('ls /workspace')).stdout).toBe('skills\n')
    expect((await ws.terminal('cd /workspace/skills && pwd && ls')).stdout).toBe(
      '/workspace/skills\nnumbers\n',
    )
    expect((await ws.terminal('find /workspace -name SKILL.md')).stdout).toBe(
      '/workspace/skills/numbers/SKILL.md\n',
    )
    expect((await ws.terminal('grep -r twice /workspace')).stdout).toBe(
      '/workspace/skills/numbers/SKILL.md:Check every sum twice.\n',
    )
    await ws.close()
  })

  it('come with every open: forks and frozen views too', async () => {
    const ws = await open({ skills: [NUMBERS] })
    await ws.files.write('a.txt', 'a')
    const child = await ws.fork('child')
    expect(await child.files.readText('/workspace/skills/numbers/SKILL.md')).toBe(NUMBERS)
    await ws.tags.add('v1')
    const frozen = await ws.tags.at('v1')
    expect(await frozen.files.readText('/workspace/skills/numbers/SKILL.md')).toBe(NUMBERS)
    await child.close()
    await ws.close()
  })

  it('refuse two of one name', async () => {
    await expect(open({ skills: [NUMBERS, NUMBERS] })).rejects.toThrow(
      /two skills are named 'numbers'/,
    )
  })
})

describe('the catalog', () => {
  it("lists every skill, mounted or the agent's own, for the tool text", async () => {
    const ws = await open({ skills: [MEDIA] })
    expect(await skillCatalog(ws)).toMatch(
      /^\n\nSkills — packaged guidance under \/workspace\/skills/,
    )
    await ws.files.write('skills/numbers/SKILL.md', NUMBERS)
    const catalog = await skillCatalog(ws)
    expect(catalog).toContain(
      '- media: Making images and sound\n- numbers: Doing arithmetic with care\n',
    )
    expect(catalog).toContain('cat /workspace/skills/<name>/SKILL.md')
    expect(await toolInstructions(ws)).toContain(catalog)
    await ws.close()
  })

  it('is empty without skills', async () => {
    const ws = await open()
    expect(await skillCatalog(ws)).toBe('')
    expect(await toolInstructions(ws)).not.toContain('Skills')
    await ws.close()
  })
})
