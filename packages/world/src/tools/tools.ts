/**
 * The world's tools, as an agent loop gives them to a model: nontainer's
 * names, schemas and result text, and results a harness can hand an MCP
 * client as they are.
 *
 * `terminal`, `file_write`, `file_edit`, `view_image` (unless vision is
 * off) and `run_ts`. Each call is one workspace call, committed with
 * its tool's name; a failure the agent can act on (a missing file, an
 * edit that didn't match, code that threw) is an error result, not a
 * throw. A workspace that can't take the call (closed, or frozen for a
 * write) throws.
 */

import { FsError, describeFsError } from '@agex-ts/termish'
import { EditError } from '../editing'
import type { Workspace } from '../workspace'
import {
  FILE_EDIT_DESCRIPTION,
  FILE_WRITE_DESCRIPTION,
  VIEW_IMAGE_DESCRIPTION,
  codeDescription,
  terminalDescription,
} from './descriptions'
import { renderCode, renderTerminal } from './render'

/** An image a tool gives back, base64-encoded. */
export interface ToolImage {
  readonly data: string
  readonly format: 'png' | 'jpeg' | 'gif' | 'webp'
  /** The workspace path it was read from, if it was. */
  readonly source?: string
}

export interface ToolOutput {
  /** What the model reads. */
  readonly text: string
  readonly images: readonly ToolImage[]
  /** The path a `file_write` wrote, for a harness to link to. */
  readonly written?: string
  /** The call failed in a way the agent can act on. For a harness's
   *  bookkeeping and an MCP result's `isError`; the text already says
   *  what went wrong. */
  readonly isError: boolean
}

export interface Tool {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments. */
  readonly parameters: Readonly<Record<string, unknown>>
  call(args: Readonly<Record<string, unknown>>): Promise<ToolOutput>
}

export interface ToolOptions {
  /** Offer `view_image` (default true). */
  readonly vision?: boolean
  /** Text appended to the terminal's description. */
  readonly terminalPrimer?: string
  /** Text appended to run_ts's description. */
  readonly codePrimer?: string
}

/** The largest image `view_image` returns, in bytes. */
export const MAX_VIEW_IMAGE_BYTES = 10_000_000

const IMAGE_FORMATS: Readonly<Record<string, ToolImage['format']>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
}

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
})

/** A call's arguments didn't fit its schema. */
class BadArguments extends Error {}

function str(args: Readonly<Record<string, unknown>>, name: string): string {
  const v = args[name]
  if (typeof v !== 'string') throw new BadArguments(`${name} must be a string`)
  return v
}

function bool(args: Readonly<Record<string, unknown>>, name: string): boolean {
  const v = args[name]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new BadArguments(`${name} must be a boolean`)
  return v
}

const text = (t: string, isError = false): ToolOutput => ({ text: t, images: [], isError })

/** Run a call, turning bad arguments into an error result. */
function guarded(
  name: string,
  call: (args: Readonly<Record<string, unknown>>) => Promise<ToolOutput>,
): (args: Readonly<Record<string, unknown>>) => Promise<ToolOutput> {
  return async (args) => {
    try {
      return await call(args ?? {})
    } catch (e) {
      if (e instanceof BadArguments) return text(`${name}: invalid arguments: ${e.message}`, true)
      throw e
    }
  }
}

/** The tools for a workspace, in nontainer's order. */
export function worldTools(ws: Workspace, opts: ToolOptions = {}): Tool[] {
  const tools: Tool[] = [
    {
      name: 'terminal',
      description: terminalDescription(ws, opts.terminalPrimer),
      parameters: object({ command: { type: 'string' } }, ['command']),
      call: guarded('terminal', async (args) => {
        const result = await ws.terminal(str(args, 'command'))
        return text(renderTerminal(result), result.exitCode !== 0)
      }),
    },
    {
      name: 'file_write',
      description: FILE_WRITE_DESCRIPTION,
      parameters: object({ path: { type: 'string' }, content: { type: 'string' } }, [
        'path',
        'content',
      ]),
      call: guarded('file_write', async (args) => {
        const path = str(args, 'path')
        try {
          const out = await ws.files.write(path, str(args, 'content'))
          return { ...text(`wrote ${out.path} (${out.size} bytes)`), written: out.path }
        } catch (e) {
          if (e instanceof FsError)
            return text(`write failed: ${path}: ${describeFsError(e)}`, true)
          throw e
        }
      }),
    },
    {
      name: 'file_edit',
      description: FILE_EDIT_DESCRIPTION,
      parameters: object(
        {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        ['path', 'old_string', 'new_string'],
      ),
      call: guarded('file_edit', async (args) => {
        const path = str(args, 'path')
        try {
          const out = await ws.files.edit(path, str(args, 'old_string'), str(args, 'new_string'), {
            replaceAll: bool(args, 'replace_all'),
          })
          if (out.mode === 'already_applied')
            return text(`no-op: replacement already present in ${path}`)
          const how = out.mode === 'exact' ? '' : ` (matched via ${out.mode})`
          return text(`replaced ${out.count} occurrence(s) in ${path}${how}`)
        } catch (e) {
          if (e instanceof EditError || e instanceof FsError) {
            return text(
              `edit failed: ${e instanceof FsError ? describeFsError(e) : e.message}`,
              true,
            )
          }
          throw e
        }
      }),
    },
  ]

  if (opts.vision !== false) {
    tools.push({
      name: 'view_image',
      description: VIEW_IMAGE_DESCRIPTION,
      parameters: object({ path: { type: 'string' } }, ['path']),
      call: guarded('view_image', async (args) => {
        const path = str(args, 'path')
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
        const format = path.includes('.') ? IMAGE_FORMATS[ext] : undefined
        if (format === undefined) {
          return text(
            `view_image failed: not a viewable image: ${path} (supported: .gif, .jpeg, .jpg, .png, .webp)`,
            true,
          )
        }
        let bytes: Uint8Array
        try {
          bytes = await ws.files.read(path)
        } catch (e) {
          return text(`view_image failed: cannot read ${path}: ${describeFsError(e)}`, true)
        }
        if (bytes.byteLength > MAX_VIEW_IMAGE_BYTES) {
          return text(
            `view_image failed: ${path} is ${bytes.byteLength} bytes (cap ${MAX_VIEW_IMAGE_BYTES}); downscale or re-save it smaller`,
            true,
          )
        }
        return {
          text: `${path} (${format}, ${bytes.byteLength} bytes)`,
          images: [{ data: toBase64(bytes), format, source: path }],
          isError: false,
        }
      }),
    })
  }

  tools.push({
    name: 'run_ts',
    description: codeDescription(ws, opts.codePrimer),
    parameters: object({ code: { type: 'string' } }, ['code']),
    call: guarded('run_ts', async (args) => {
      const result = await ws.runCode(str(args, 'code'))
      return {
        text: renderCode(result, { resolver: ws.settings.profile.code?.resolve !== undefined }),
        images: result.images,
        isError: result.error !== null,
      }
    }),
  })
  return tools
}

/** An MCP `CallToolResult` content block. */
export type McpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name: string }

/**
 * A tool output as an MCP `CallToolResult`: the text, then each image,
 * then a `workspace://` link to what `file_write` wrote. `isError` is
 * the output's, so a client sees a failure the agent can act on as
 * one.
 */
export function toMcpResult(out: ToolOutput): { content: McpContent[]; isError: boolean } {
  const content: McpContent[] = [{ type: 'text', text: out.text }]
  for (const image of out.images) {
    content.push({ type: 'image', data: image.data, mimeType: `image/${image.format}` })
  }
  if (out.written !== undefined) {
    const path = out.written.replace(/^\/+/, '')
    content.push({
      type: 'resource_link',
      uri: `workspace://${path}`,
      name: path.slice(path.lastIndexOf('/') + 1),
    })
  }
  return { content, isError: out.isError }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}
