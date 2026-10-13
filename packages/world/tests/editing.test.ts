import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EditError, applyEdit, ratio } from '../src/editing'

interface Case {
  name: string
  content: string
  old: string
  new: string
  replace_all: boolean
  result?: { content: string; count: number; mode: string }
  error?: string
}

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/golden-editing.json', import.meta.url), 'utf8'),
) as { cases: Case[]; ratios: Array<{ a: string; b: string; ratio: number }> }

describe("applyEdit does what nontainer's apply_edit does", () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      const run = () =>
        applyEdit(c.content, c.old, c.new, { replaceAll: c.replace_all, path: 'f.py' })
      if (c.result !== undefined) {
        expect(run()).toEqual(c.result)
      } else {
        let message = ''
        try {
          run()
        } catch (e) {
          expect(e).toBeInstanceOf(EditError)
          message = (e as Error).message
        }
        // The world may add a near-miss note after nontainer's message.
        expect(message.startsWith(c.error as string)).toBe(true)
      }
    })
  }
})

describe("ratio is difflib's SequenceMatcher.ratio", () => {
  for (const r of golden.ratios) {
    it(`${JSON.stringify(r.a.slice(0, 20))} ~ ${JSON.stringify(r.b.slice(0, 20))}`, () => {
      expect(ratio(r.a, r.b)).toBeCloseTo(r.ratio, 12)
    })
  }
})

describe('beyond nontainer', () => {
  it('refuses an empty quote', () => {
    expect(() => applyEdit('abc', '', 'x')).toThrow('old_string is empty')
  })

  it('says when the quote missed only by typographic look-alikes', () => {
    expect(() => applyEdit('label = “Save”\n', 'label = "Save"', 'x')).toThrow(
      /typographic characters/,
    )
  })

  it('says when the quote missed only by Unicode normal form', () => {
    expect(() => applyEdit('café = 1\n', 'café = 1', 'x')).toThrow(/Unicode normalization/)
  })
})
