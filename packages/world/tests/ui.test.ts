/**
 * `ui` artifacts, run in the kernel's built Node worker (build the
 * package before testing).
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type Profile,
  Store,
  type Workspace,
  artifactKind,
  artifactsNote,
  parseArtifactsNote,
  uiRoot,
  worldTools,
} from '../src/index'
import { newKV } from './backends'

const WORKER = new URL('../dist/worker.node.js', import.meta.url)

beforeAll(() => {
  if (!existsSync(fileURLToPath(WORKER))) {
    throw new Error('build @agex-ts/world first: the kernel tests run its built Node worker')
  }
})

async function open(ui = true, profile: Profile = {}): Promise<Workspace> {
  const store = await Store.open(await newKV())
  return store.open('s', {
    profile: { ...profile, code: { worker: { target: 'node', url: WORKER }, ui } },
  })
}

const json = async (ws: Workspace, path: string): Promise<unknown> =>
  JSON.parse(await ws.files.readText(path))

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]

describe('ui artifacts', () => {
  it('writes each kind under ui/, committed with the run, and names them', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      ui.revenue = { data: [{ type: 'bar', x: ['a', 'b'], y: new Float64Array([1, 2]) }], layout: { title: 'R' } }
      ui.rows = [{ city: 'Oslo', temp: 4 }, { city: 'Rome', temp: 18, wet: true }]
      ui.kpis = [{ label: 'Revenue', value: 1200, sublabel: '+8%' }, { type: 'callout', title: 'Note', body: 'b', tone: 'loud' }]
      ui.logo = new Uint8Array(${JSON.stringify(PNG)})
    `)
    expect(out.error).toBeNull()
    expect(out.uiNotes).toEqual([])
    expect(out.artifacts).toEqual([
      { name: 'revenue', path: '/workspace/ui/revenue.plotly.json' },
      { name: 'rows', path: '/workspace/ui/rows.table.json' },
      { name: 'kpis', path: '/workspace/ui/kpis.cards.json' },
      { name: 'logo', path: '/workspace/ui/logo.png' },
    ])
    expect(await json(ws, '/workspace/ui/revenue.plotly.json')).toEqual({
      data: [{ type: 'bar', x: ['a', 'b'], y: [1, 2] }],
      layout: { title: 'R' },
    })
    expect(await json(ws, '/workspace/ui/rows.table.json')).toEqual({
      columns: ['city', 'temp', 'wet'],
      data: [
        ['Oslo', 4, null],
        ['Rome', 18, true],
      ],
      total: 2,
      columnTypes: ['string', 'number', 'boolean'],
    })
    expect(await json(ws, '/workspace/ui/kpis.cards.json')).toEqual({
      items: [
        { type: 'stat', label: 'Revenue', value: 1200, sublabel: '+8%' },
        { type: 'callout', title: 'Note', body: 'b', tone: 'info' },
      ],
    })
    expect([...(await ws.files.read('/workspace/ui/logo.png'))]).toEqual(PNG)
    // one commit holds the run's artifacts
    expect(out.commit).toBe(ws.head)
    expect((await ws.log())[0]?.info?.tool).toBe('run_ts')
    await ws.close()
  })

  it('sees ui assigned whole, and a card row assigned straight to it', async () => {
    const ws = await open()
    const whole = await ws.runCode('ui = { t: [{ a: 1 }] }')
    expect(whole.artifacts).toEqual([{ name: 't', path: '/workspace/ui/t.table.json' }])
    const bare = await ws.runCode(`ui = [{ label: 'n', value: 1 }]`)
    expect(bare.artifacts).toEqual([{ name: 'cards', path: '/workspace/ui/cards.cards.json' }])
    await ws.close()
  })

  it('writes nothing for data, and says what would render', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      ui.count = 3
      ui.cfg = { a: 1 }
      ui.one = { label: 'Revenue', value: 1 }
      ui.row = [{ label: 'a', value: 1 }, { label: 'b', value: 2 }, { title: 'x' }]
    `)
    expect(out.artifacts).toEqual([])
    expect(out.uiNotes).toHaveLength(4)
    expect(out.uiNotes[0]).toMatch(/^'count' is a number, which is data and not a UI artifact/)
    expect(out.uiNotes[1]).toMatch(/^'cfg' is a plain object, which is data/)
    expect(out.uiNotes[2]).toMatch(/^'one' looks like a single stat, but a card row is an ARRAY/)
    expect(out.uiNotes[3]).toMatch(/^'row' looks like a card row, but this item .*\{"title":"x"\}/)
    expect(await ws.files.exists('/workspace/ui')).toBe(false)
    await ws.close()
  })

  it('reads tables from Arrow-shaped values, with dates, bigints and nested cells', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      ui.arrow = { schema: { fields: [{ name: 'n' }] }, numRows: 500, toArray: () => [{ n: 1n }],
                   slice(a, b) { return { toArray: () => [{ n: 1n }, { n: 2n }] } } }
      ui.mixed = [{ when: new Date(0), big: 2n ** 70n, tags: ['a'] }]
    `)
    expect(out.uiNotes).toEqual([])
    expect(await json(ws, '/workspace/ui/arrow.table.json')).toEqual({
      columns: ['n'],
      data: [[1], [2]],
      total: 500,
      columnTypes: ['number'],
    })
    expect(await json(ws, '/workspace/ui/mixed.table.json')).toEqual({
      columns: ['when', 'big', 'tags'],
      data: [['1970-01-01T00:00:00.000Z', '1180591620717411303424', '["a"]']],
      total: 1,
      columnTypes: ['datetime', 'number', 'string'],
    })
    await ws.close()
  })

  it('keeps 200 rows of a long table, and says how many there were', async () => {
    const ws = await open()
    await ws.runCode('ui.t = Array.from({ length: 250 }, (_, i) => ({ i }))')
    const t = (await json(ws, '/workspace/ui/t.table.json')) as { data: unknown[]; total: number }
    expect(t.data).toHaveLength(200)
    expect(t.total).toBe(250)
    await ws.close()
  })

  it('takes an image as a data URL or {format, data}', async () => {
    const ws = await open()
    const b64 = Buffer.from(PNG).toString('base64')
    const out = await ws.runCode(`
      ui.a = 'data:image/png;base64,${b64}'
      ui.b = { format: 'png', data: '${b64}' }
      ui.c = new Uint8Array([1, 2, 3])
    `)
    expect(out.artifacts.map((a) => a.path)).toEqual(['/workspace/ui/a.png', '/workspace/ui/b.png'])
    expect(out.uiNotes[0]).toMatch(/^'c' is a Uint8Array, which is data/)
    await ws.close()
  })

  it('honors the path of a file the code saved, and says when it names none', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      await fs.mkdir('/workspace/out')
      await fs.write('/workspace/out/chart.png', new Uint8Array(${JSON.stringify(PNG)}))
      ui.chart = '/workspace/out/chart.png'
      ui.gone = '/workspace/nope.png'
    `)
    expect(out.artifacts).toEqual([{ name: 'chart', path: '/workspace/out/chart.png' }])
    expect(out.uiNotes[0]).toMatch(/^'gone' is the path \/workspace\/nope.png, which names no file/)
    await ws.close()
  })

  it('refuses an artifact past the cap, writing the note in its place', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      ui.big = { data: [{ y: Array.from({ length: 1_000_000 }, () => 123456.789) }], layout: {} }
    `)
    expect(out.uiNotes[0]).toMatch(/^ui artifact 'big' NOT rendered: too large .*customdata/)
    expect(out.artifacts).toEqual([{ name: 'big', path: '/workspace/ui/big.txt' }])
    expect(await ws.files.readText('/workspace/ui/big.txt')).toBe(out.uiNotes[0])
    await ws.close()
  })

  it('sanitizes names, and renders the first twenty', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      ui['my chart!'] = [{ label: 'a', value: 1 }]
      for (let i = 0; i < 21; i++) ui['k' + i] = [{ label: 'a', value: i }]
    `)
    expect(out.artifacts[0]).toEqual({
      name: 'my-chart',
      path: '/workspace/ui/my-chart.cards.json',
    })
    expect(out.artifacts).toHaveLength(20)
    expect(out.uiNotes).toEqual(['ui holds 22 values; only the first 20 were rendered'])
    await ws.close()
  })

  it('still renders what a failing run left in ui', async () => {
    const ws = await open()
    const out = await ws.runCode(`ui.t = [{ a: 1 }]; throw new Error('late')`)
    expect(out.error?.message).toBe('late')
    expect(out.artifacts).toHaveLength(1)
    await ws.close()
  })

  it('says when the code declared its own ui', async () => {
    const ws = await open()
    const out = await ws.runCode('const ui = { t: [{ a: 1 }] }')
    expect(out.artifacts).toEqual([])
    expect(out.uiNotes[0]).toMatch(/^the code declares its own `ui`/)
    await ws.close()
  })

  it('is off by default: ui is a free name, and nothing is written', async () => {
    const ws = await open(false)
    const out = await ws.runCode(`
      const free = typeof ui
      const ui = { t: [{ a: 1 }] }
      return free
    `)
    expect(out.error?.name).toBe('ReferenceError')
    const plain = await ws.runCode('const ui = { t: [{ a: 1 }] }; return Object.keys(ui)')
    expect(plain.value).toBe('["t"]')
    expect(plain.artifacts).toEqual([])
    expect(plain.uiNotes).toEqual([])
    expect(await ws.files.exists('/workspace/ui')).toBe(false)
    await ws.close()
  })
})

describe('ui in run_ts', () => {
  it('describes ui only when it is on, and notes the artifacts in the result', async () => {
    const off = await open(false)
    const offRun = worldTools(off).find((t) => t.name === 'run_ts')
    expect(offRun?.description).not.toContain('Rich replies')
    await off.close()

    const ws = await open()
    const run = worldTools(ws).find((t) => t.name === 'run_ts')
    expect(run?.description).toContain('![name](/workspace/ui/name.plotly.json)')
    const out = await run?.call({ code: `console.log('hi'); ui.t = [{ a: 1 }]; ui.n = 2` })
    expect(out?.text).toMatch(
      /^hi\n\[ui artifacts: t -> \/workspace\/ui\/t\.table\.json\]\n\[ui note: 'n' is a number/,
    )
    expect(parseArtifactsNote(out?.text ?? '')).toEqual([
      { name: 't', path: '/workspace/ui/t.table.json' },
    ])
    await ws.close()
  })
})

describe('the ui helpers', () => {
  it('round-trip the artifacts note, and tell kinds by suffix', () => {
    const list = [
      { name: 'a.b-c', path: '/workspace/ui/a.b-c.plotly.json' },
      { name: 'img', path: '/workspace/ui/img.png' },
    ]
    expect(parseArtifactsNote(`out\n${artifactsNote(list)}\n[ui note: x]`)).toEqual(list)
    expect(artifactsNote([])).toBe('')
    expect(parseArtifactsNote('nothing here')).toEqual([])
    expect(
      [
        'x.plotly.json',
        'x.table.json',
        'x.cards.json',
        'x.JPG',
        'x.html',
        'x.json',
        'x.txt',
        'x.bin',
      ].map(artifactKind),
    ).toEqual(['plotly', 'table', 'cards', 'image', 'html', 'json', 'text', 'binary'])
    expect(uiRoot('/workspace')).toBe('/workspace/ui')
    expect(uiRoot('/')).toBe('/ui')
  })
})
