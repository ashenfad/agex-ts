/**
 * `buildTaskMessage(def, input)` — composes the per-task user
 * message that opens the conversation.
 *
 * Structure mirrors agex-py's `build_task_message`:
 *
 *   Task: <description>
 *   <def.primer if set>
 *
 *   Details for your task are available in the `inputs` variable.
 *   Here is its structure and content:
 *   ```
 *   inputs.field1 = <value>
 *   inputs.field2 = <value>
 *   ```
 *
 *   Access these values with patterns like `inputs.field1`.
 *
 *   When complete, call `taskSuccess(result)` with your result.
 *   The result type should be:
 *   ```json
 *   <JSON Schema or prose>
 *   ```
 *
 * Per-field input rendering only happens when we have a JSON Schema
 * for the input that describes an object with discoverable
 * properties. Without one, falls back to a single-blob
 * `inputs = <safeStringify>` line.
 *
 * Output rendering preference, in order: `outputJsonSchema`
 * override → `extractJsonSchema(output)` → `outputDescription`
 * prose → generic fallback.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import { safeStringify } from '../runtime/safe-stringify'
import type { TaskDefinition } from '../task'
import { extractJsonSchema, hasObjectProperties, objectPropertyNames } from './extract-schema'

export function buildTaskMessage<I, O>(def: TaskDefinition<I, O>, inputValue: I): string {
  const parts: string[] = []
  parts.push(`Task: ${def.description}`)
  if (def.primer !== undefined && def.primer.trim().length > 0) {
    parts.push(def.primer.trim())
  }
  parts.push(buildInputsBlock(def, inputValue))
  parts.push(buildExpectedReturnBlock(def))
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Inputs block
// ---------------------------------------------------------------------------

function buildInputsBlock<I, O>(def: TaskDefinition<I, O>, inputValue: I): string {
  if (inputValue === undefined) {
    return 'This task takes no inputs (the `inputs` variable is `undefined`).'
  }

  // The `inputs` variable is already in scope inside `ts_action`.
  // Reminder is repeated alongside every render mode so the model
  // doesn't redeclare it (`const inputs = {...}` would shadow-throw).
  const reminder =
    'The `inputs` variable is already bound to this value — read fields off it directly (e.g. `inputs.foo`); do not redeclare it.'

  const intro =
    'Details for your task are available in the `inputs` variable. Here is its structure and content:'

  const jsonSchema = resolveInputJsonSchema(def)
  if (jsonSchema !== null && hasObjectProperties(jsonSchema)) {
    const lines: string[] = []
    const properties = objectPropertyNames(jsonSchema)
    for (const prop of properties) {
      const fieldValue = (inputValue as Record<string, unknown>)[prop]
      lines.push(`${prop}: ${safeStringify(fieldValue, { maxChars: 2_000 })}`)
    }
    const renderedFields = `\`\`\`yaml\n${lines.join('\n')}\n\`\`\``
    return [intro, renderedFields, reminder].join('\n\n')
  }

  if (def.inputDescription !== undefined && def.inputDescription.trim().length > 0) {
    const blob = `\`\`\`json\n${safeStringify(inputValue, { maxChars: 4_000 })}\n\`\`\``
    return `${intro}\n\nShape: ${def.inputDescription.trim()}\n\n${blob}\n\n${reminder}`
  }

  // Fallback: single-blob value
  const blob = `\`\`\`json\n${safeStringify(inputValue, { maxChars: 4_000 })}\n\`\`\``
  return `${intro}\n\n${blob}\n\n${reminder}`
}

function resolveInputJsonSchema<I, O>(def: TaskDefinition<I, O>): object | null {
  if (def.inputJsonSchema !== undefined) return def.inputJsonSchema
  if (def.input !== undefined) return extractJsonSchema(def.input as StandardSchemaV1)
  return null
}

// ---------------------------------------------------------------------------
// Expected return block
// ---------------------------------------------------------------------------

function buildExpectedReturnBlock<I, O>(def: TaskDefinition<I, O>): string {
  const jsonSchema = resolveOutputJsonSchema(def)
  if (jsonSchema !== null) {
    return `When complete, call \`taskSuccess(result)\` with a value matching:\n\n\`\`\`json\n${JSON.stringify(jsonSchema, null, 2)}\n\`\`\``
  }
  if (def.outputDescription !== undefined && def.outputDescription.trim().length > 0) {
    return `When complete, call \`taskSuccess(result)\` with: ${def.outputDescription.trim()}`
  }
  // Generic fallback — no schema, no description: agent leans on the
  // task description itself to infer what makes sense.
  return 'When complete, call `taskSuccess(result)` with whatever value satisfies the task.'
}

function resolveOutputJsonSchema<I, O>(def: TaskDefinition<I, O>): object | null {
  if (def.outputJsonSchema !== undefined) return def.outputJsonSchema
  if (def.output !== undefined) return extractJsonSchema(def.output as StandardSchemaV1)
  return null
}
