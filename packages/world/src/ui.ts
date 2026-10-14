/**
 * `ui` artifacts: how code says "show this".
 *
 * With `profile.code.ui` on, code has a `ui` object, fresh each run;
 * `ui.revenue = figure` (or `ui = { revenue: figure }`) asks for the
 * value to be shown. When the run ends, each value that renders is
 * written to `<root>/ui/<name>.<ext>`, by kind:
 *
 * | value | file |
 * |---|---|
 * | a Plotly spec, `{data: [...], layout: {...}}` | `<name>.plotly.json` |
 * | an array of row objects, or an Arrow table | `<name>.table.json`: `{columns, data, total, columnTypes}` |
 * | an array of stat and callout cards | `<name>.cards.json`: `{items}` |
 * | image bytes, a `data:image` URL, a Blob, an `OffscreenCanvas` | `<name>.png` (or `.jpg`, `.gif`, `.webp`) |
 * | the path of a file the code saved | that file, as it is |
 *
 * The result names each one (`[ui artifacts: revenue ->
 * /workspace/ui/revenue.plotly.json]`), and says why a value gave
 * nothing (`[ui note: …]`). A reply embeds one as
 * `![revenue](/workspace/ui/revenue.plotly.json)`; a harness renders
 * it by {@link artifactKind}, and shows after the reply the ones it
 * doesn't embed. An artifact is a file, so it is committed with the
 * run, rewinds with the rest, and a reply can be rendered again from
 * the record alone.
 *
 * nontainer's `ui` convention, with JavaScript's values in place of
 * Python's: the same paths, file formats and notes.
 */

import type { FileSystem } from '@agex-ts/termish'
import type { UiHarvest } from './kernel/ui-values'
import { repr } from './repr'

export { MAX_ARTIFACT_BYTES, looksLikePlotly } from './kernel/ui-values'

/** One artifact a run wrote: the name it has in `ui`, and its path. */
export interface Artifact {
  readonly name: string
  readonly path: string
}

/** Where `ui` artifacts land: `<root>/ui`. */
export function uiRoot(root: string): string {
  return `${root === '/' ? '' : root.replace(/\/+$/, '')}/ui`
}

/** What a kind of artifact is, by its path's suffix: `plotly`,
 *  `table`, `cards`, `image`, `html`, `json`, `text`, or `binary`. A
 *  consumer may still sniff a bare `.json` for a Plotly spec. */
export type ArtifactKind =
  | 'plotly'
  | 'table'
  | 'cards'
  | 'image'
  | 'html'
  | 'json'
  | 'text'
  | 'binary'

export function artifactKind(path: string): ArtifactKind {
  const lower = path.toLowerCase()
  if (lower.endsWith('.plotly.json')) return 'plotly'
  if (lower.endsWith('.table.json')) return 'table'
  if (lower.endsWith('.cards.json')) return 'cards'
  if (/\.(png|jpe?g|gif|webp)$/.test(lower)) return 'image'
  if (lower.endsWith('.html')) return 'html'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.txt')) return 'text'
  return 'binary'
}

/**
 * Write a run's `ui` entries under `<root>/ui`, returning what was
 * written and why anything wasn't. A pointer is kept when it names a
 * file. Writing never fails the run: a write that fails (a frozen
 * workspace) is a note.
 */
export async function writeUi(
  fs: FileSystem,
  root: string,
  harvest: UiHarvest,
): Promise<{ artifacts: Artifact[]; notes: string[] }> {
  const artifacts: Artifact[] = []
  const notes = [...harvest.notes]
  const dir = uiRoot(root)
  let made = false
  for (const entry of harvest.entries) {
    if ('pointer' in entry) {
      let isFile = false
      try {
        isFile = await fs.isFile(entry.pointer)
      } catch {
        isFile = false
      }
      if (isFile) artifacts.push({ name: entry.name, path: entry.pointer })
      else {
        notes.push(
          `${repr(entry.name)} is the path ${entry.pointer}, which names no file, so nothing was rendered: save the file first, or assign the value itself`,
        )
      }
      continue
    }
    const path = `${dir}/${entry.name}.${entry.ext}`
    try {
      if (!made) {
        await fs.mkdir(dir, { parents: true, existOk: true })
        made = true
      }
      const data =
        typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data
      await fs.write(path, data)
      artifacts.push({ name: entry.name, path })
    } catch (e) {
      notes.push(
        `${repr(entry.name)} could not be saved to ${path}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  return { artifacts, notes }
}

/** The result's line naming the artifacts, `[ui artifacts: name ->
 *  path, …]`; empty for none. Names are sanitized, so neither `, ` nor
 *  ` -> ` occurs in one and {@link parseArtifactsNote} reads it back. */
export function artifactsNote(artifacts: readonly Artifact[]): string {
  if (artifacts.length === 0) return ''
  return `[ui artifacts: ${artifacts.map((a) => `${a.name} -> ${a.path}`).join(', ')}]`
}

/** The artifacts a result's text names, from its `[ui artifacts: …]`
 *  line; empty for none. */
export function parseArtifactsNote(text: string): Artifact[] {
  const m = /\[ui artifacts: (.*?)\]/.exec(text)
  if (m === null) return []
  const out: Artifact[] = []
  for (const seg of (m[1] as string).split(', ')) {
    const pair = /^([\w.-]+) -> (\/\S+)$/.exec(seg)
    if (pair !== null) out.push({ name: pair[1] as string, path: pair[2] as string })
  }
  return out
}

/** How `ui` is described to the agent, in run_ts's description. */
export function uiDescription(root: string): string {
  const dir = uiRoot(root)
  return `\
Rich replies: assign \`ui.name = value\` (ui is an object, fresh each call; don't declare your own), where the value is one of:
- a Plotly figure spec \`{ data: [...], layout: {...} }\`: a chart
- an array of row objects \`[{ city: 'Oslo', temp: 4 }, ...]\` (or an Arrow table): a table
- PNG/JPEG/GIF/WebP bytes, a \`data:image/...\` URL, a Blob or an OffscreenCanvas: a picture
- a card row \`[{ label: 'Revenue', value: '$1.2M', sublabel: '+8% MoM' }]\`; a callout item is \`{ type: 'callout', title, body, tone?: 'info' | 'success' | 'warning' }\`
That is the whole set: anything else is data, which nothing renders. When the call ends, each is saved under ${dir}/ (don't write there yourself) and the result notes its path. Embed one in your reply with markdown image syntax, using the exact path from the note: ![name](${dir}/name.plotly.json). The ones you don't embed are shown after your reply. (The path of a file you saved yourself works as a value too.) An artifact is capped at 8MB: aggregate or sample data rather than shipping every row.`
}
