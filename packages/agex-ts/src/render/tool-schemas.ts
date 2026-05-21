/**
 * Provider-agnostic JSON schemas for the four action tools the agent
 * may call: `ts_action`, `terminal_action`, `write_file`, `edit_file`.
 *
 * Each schema is a plain dict — `{ name, description, parameters }`.
 * Provider packages translate the envelope:
 *
 *   - Anthropic renames `parameters` → `input_schema`, no wrapper.
 *   - OpenAI wraps in `{ type: 'function', function: { ... } }`.
 *   - Gemini puts `parameters` directly under `function_declarations`.
 *
 * The schema *bodies* are identical across providers — only the
 * outer shape differs. Keeping them in one place avoids three copies
 * of the same JSON drifting apart.
 *
 * `toolSchemas({ nativeThinking: true })` strips the `thinking`
 * narration parameter from action tools — appropriate when the
 * provider delivers native thinking blocks (Claude 4+ extended
 * thinking, Gemini 3 thought parts), so asking the model to also
 * fill a `thinking` argument is redundant and confuses the model
 * into half-completing the schema instead of running real code.
 */

import type { ToolName } from './index'

// `as const` so the constants are literal-typed (e.g. `'ts_action'`),
// not widened to `ToolName`. That preserves narrowing when callers
// switch on a tool name and compare against these constants.
export const TOOL_TS = 'ts_action' as const
export const TOOL_TERMINAL = 'terminal_action' as const
export const TOOL_WRITE_FILE = 'write_file' as const
export const TOOL_EDIT_FILE = 'edit_file' as const

/** Runtime registry of every known tool name. Kept next to the
 *  literal constants so adding a fifth tool here is a one-line edit
 *  that both `ToolName` (compile-time) and call sites doing runtime
 *  membership checks (e.g. parser fallback messaging) pick up. */
export const KNOWN_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  TOOL_TS,
  TOOL_TERMINAL,
  TOOL_WRITE_FILE,
  TOOL_EDIT_FILE,
])

export interface ToolSchema {
  readonly name: ToolName
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface ToolSchemaOptions {
  /** Strip the `thinking` narration parameter from action tool
   *  schemas. Appropriate when the provider supplies native thinking
   *  blocks; the model then emits real reasoning as a separate
   *  thought channel rather than as a JSON string. */
  readonly nativeThinking?: boolean
}

const TS_SCHEMA: ToolSchema = {
  name: TOOL_TS,
  description:
    'Run TypeScript code. The task is driven by special calls inside the code: ' +
    'taskSuccess(result) finishes successfully, taskFail(message) finishes with an ' +
    'error, taskClarify(prompt) asks the caller a question. If none is called, the ' +
    'code returns normally and the turn continues — printed output appears on the ' +
    'next turn.',
  parameters: {
    type: 'object',
    required: ['title', 'thinking', 'code'],
    properties: {
      title: {
        type: 'string',
        description: 'Short title for this turn (one line).',
      },
      thinking: {
        type: 'string',
        description: 'Step-by-step reasoning for this turn.',
      },
      code: {
        type: 'string',
        description: 'TypeScript source to execute.',
      },
    },
  },
}

const TERMINAL_SCHEMA: ToolSchema = {
  name: TOOL_TERMINAL,
  description:
    'Run shell commands. Does not signal task completion on its own — use ts_action ' +
    'with taskSuccess() / taskFail() to finish.',
  parameters: {
    type: 'object',
    required: ['title', 'thinking', 'commands'],
    properties: {
      title: {
        type: 'string',
        description: 'Short title for this turn (one line).',
      },
      thinking: {
        type: 'string',
        description: 'Step-by-step reasoning for this turn.',
      },
      commands: {
        type: 'string',
        description:
          'Shell commands to run. Supported: ls, cat, head, tail, grep, find, wc, ' +
          'sort, uniq, cut, tr, sed, diff, xargs, cp, mv, rm, mkdir, touch, pwd, cd, ' +
          'basename, dirname, echo, printf, tee, tar, gzip, gunzip, zip, unzip. ' +
          'Notes: (1) no shell variable expansion — `$VAR` references and `X=42` ' +
          'assignments are not interpreted (each command is a thin handler, not a ' +
          'full shell). (2) `cd` is persistent — the working directory carries over ' +
          'to the next call within this session. (3) Within a single call commands ' +
          'halt on first error; chain with `;`, `&&`, `||` to control flow ' +
          '(`cmd || true` for best-effort).',
      },
    },
  },
}

const WRITE_FILE_SCHEMA: ToolSchema = {
  name: TOOL_WRITE_FILE,
  description: "Write or append a file. Place TypeScript modules under '/helpers'.",
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    properties: {
      path: {
        type: 'string',
        description: "Absolute path within the agent's VFS.",
      },
      content: {
        type: 'string',
        description: 'File contents to write.',
      },
      mode: {
        type: 'string',
        enum: ['write', 'append'],
        description: "Defaults to 'write'.",
      },
    },
  },
}

const EDIT_FILE_SCHEMA: ToolSchema = {
  name: TOOL_EDIT_FILE,
  description:
    "Surgical search-and-replace. 'search' must match the file exactly (including " +
    'whitespace) and occur once unless matchAll=true; its text is swapped for ' +
    "'content'. To insert new content around an anchor, include the anchor in " +
    "'content' — e.g. append a function after 'function foo(){...}' by searching " +
    'for the whole block and replacing with the same block plus the new function ' +
    'underneath.',
  parameters: {
    type: 'object',
    required: ['path', 'search', 'content'],
    properties: {
      path: {
        type: 'string',
        description: "Absolute path within the agent's VFS.",
      },
      search: {
        type: 'string',
        description: 'Exact text to locate. Whitespace is significant.',
      },
      content: {
        type: 'string',
        description: "Replacement text. Swapped in for 'search'.",
      },
      matchAll: {
        type: 'boolean',
        description: 'If true, apply to every occurrence. Defaults to false.',
      },
    },
  },
}

/** Return the four action tool schemas. Pass `nativeThinking: true`
 *  on providers that deliver native thinking blocks (Claude 4+,
 *  Gemini 3) so the action tools don't ask the model to also
 *  narrate reasoning into a JSON parameter. */
export function toolSchemas(opts: ToolSchemaOptions = {}): ToolSchema[] {
  const action =
    opts.nativeThinking === true
      ? [stripNarrationParams(TS_SCHEMA), stripNarrationParams(TERMINAL_SCHEMA)]
      : [TS_SCHEMA, TERMINAL_SCHEMA]
  return [...action, WRITE_FILE_SCHEMA, EDIT_FILE_SCHEMA]
}

function stripNarrationParams(schema: ToolSchema): ToolSchema {
  const params = schema.parameters as {
    type: string
    required?: ReadonlyArray<string>
    properties?: Readonly<Record<string, unknown>>
  }
  const newProps: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params.properties ?? {})) {
    if (k !== 'thinking') newProps[k] = v
  }
  const newRequired = (params.required ?? []).filter((r) => r !== 'thinking')
  return {
    ...schema,
    parameters: {
      ...params,
      properties: newProps,
      required: newRequired,
    },
  }
}
