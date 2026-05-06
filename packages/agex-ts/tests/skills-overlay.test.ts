import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { SkillsOverlay, renderSkillsListing } from '../src/fs/skills-overlay'
import type { RegisteredSkill } from '../src/types'

const dec = new TextDecoder()

function skillsMap(entries: Record<string, string>): Map<string, RegisteredSkill> {
  const m = new Map<string, RegisteredSkill>()
  for (const [name, content] of Object.entries(entries)) {
    m.set(name, { kind: 'skill', name, content })
  }
  return m
}

describe('SkillsOverlay — file map', () => {
  it('exposes /<name>/SKILL.md per registered skill', async () => {
    const o = new SkillsOverlay(
      skillsMap({ db: '# Database\n\nUse db.query.', api: '# API rules' }),
    )
    expect(await o.exists('/db/SKILL.md')).toBe(true)
    expect(await o.exists('/api/SKILL.md')).toBe(true)
    expect(dec.decode(await o.read('/db/SKILL.md'))).toContain('Use db.query.')
  })

  it('list("/") returns each skill name as a directory', async () => {
    const o = new SkillsOverlay(skillsMap({ a: '#A', b: '#B' }))
    expect(await o.list('/')).toEqual(['a', 'b'])
    expect(await o.isDir('/a')).toBe(true)
    expect(await o.list('/a')).toEqual(['SKILL.md'])
  })

  it('write methods throw on the read-only overlay', async () => {
    const o = new SkillsOverlay(skillsMap({ a: '#A' }))
    await expect(o.write()).rejects.toThrow(/read-only/)
    await expect(o.mkdir()).rejects.toThrow(/read-only/)
    await expect(o.remove()).rejects.toThrow(/read-only/)
  })

  it('swap() refreshes the backing skills map', async () => {
    const o = new SkillsOverlay(skillsMap({ a: '#A' }))
    expect(await o.list('/')).toEqual(['a'])
    o.swap(skillsMap({ b: '#B' }))
    expect(await o.list('/')).toEqual(['b'])
    await expect(o.read('/a/SKILL.md')).rejects.toThrow(/no such file/)
  })
})

describe('renderSkillsListing', () => {
  it('lists names + first-line description and points at the cat path', () => {
    const out = renderSkillsListing(
      skillsMap({
        db_howto: '# Database How-To\n\nUse db.query for SELECTs.',
        plain: 'just text, no header',
      }),
    )
    expect(out).toContain('## Skills')
    expect(out).toContain('cat /skills/<name>/SKILL.md')
    expect(out).toContain('db_howto')
    expect(out).toContain('Database How-To')
    expect(out).toContain('plain')
    expect(out).toContain('just text, no header')
  })

  it('returns empty string when there are no skills', () => {
    expect(renderSkillsListing(skillsMap({}))).toBe('')
  })
})

describe('agent.fs(session) mounts the skills overlay', () => {
  it('a registered skill is readable at /skills/<name>/SKILL.md after refresh', async () => {
    const agent = await createAgent({ name: 'A' })
    agent.skill('# How To\n\nDo X.', { name: 'howto' })
    agent.refreshSkillsOverlay()
    const fs = agent.fs()
    expect(await fs.exists('/skills/howto/SKILL.md')).toBe(true)
    expect(dec.decode(await fs.read('/skills/howto/SKILL.md'))).toContain('How To')
  })
})
