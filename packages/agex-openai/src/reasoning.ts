/**
 * Codec for uncodex's opaque reasoning replay extension.
 *
 * agex-ts deliberately treats `signature` bytes as provider-owned state. The
 * OpenAI adapter stores the complete reasoning_details record in those bytes
 * so the record can make a lossless round trip without becoming visible text.
 */

export const UNCODEX_REASONING_DETAIL_TYPE = 'reasoning.uncodex'
export const UNCODEX_REASONING_DETAIL_VERSION = 1

export interface UncodexReasoningDetail extends Readonly<Record<string, unknown>> {
  readonly type: typeof UNCODEX_REASONING_DETAIL_TYPE
  readonly version: typeof UNCODEX_REASONING_DETAIL_VERSION
  readonly item: Readonly<Record<string, unknown>>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeReasoningDetail(value: unknown): Uint8Array | undefined {
  if (!isUncodexReasoningDetail(value)) return undefined
  return encoder.encode(JSON.stringify(value))
}

export function decodeReasoningSignature(value: Uint8Array): UncodexReasoningDetail | undefined {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(value))
    return isUncodexReasoningDetail(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isUncodexReasoningDetail(value: unknown): value is UncodexReasoningDetail {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const detail = value as Record<string, unknown>
  if (
    detail.type !== UNCODEX_REASONING_DETAIL_TYPE ||
    detail.version !== UNCODEX_REASONING_DETAIL_VERSION
  ) {
    return false
  }
  const item = detail.item
  return isRecord(item) && item.type === 'reasoning'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
