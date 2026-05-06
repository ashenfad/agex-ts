/**
 * Streaming JSON string-value extractor.
 *
 * Parses a streaming JSON object incrementally and yields deltas for
 * each top-level string value as its decoded content grows.
 * Non-string values (numbers, booleans, null, nested arrays/objects)
 * are parsed and skipped — no deltas emitted for them. The final
 * authoritative parse happens after the stream closes via
 * `JSON.parse` on the buffered raw text.
 *
 * Use case: Anthropic streams a tool_use block's `input` as
 * `input_json_delta` chunks that may split at any byte boundary,
 * including mid-escape and mid-`\\uXXXX`. Feeding those chunks
 * through `JsonStringExtractor` lets the agent stream the model's
 * `code` / `commands` / `thinking` / `title` strings to the UI in
 * real time, before the tool call finishes.
 *
 * TS port of agex-py's `agex.llm.formats.json_stream`.
 */

export interface JsonStringDelta {
  readonly key: string
  readonly content: string
  readonly done: boolean
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
}

enum State {
  BeforeObject = 0,
  ExpectKeyOrEnd = 1,
  InKey = 2,
  ExpectColon = 3,
  ExpectValue = 4,
  InString = 5,
  SkipNonString = 6,
  ExpectCommaOrEnd = 7,
  Done = 8,
}

const WS = new Set([' ', '\t', '\n', '\r'])

export class JsonStringExtractor {
  private state: State = State.BeforeObject
  private currentKey = ''
  private keyBuf: string[] = []
  private valueBuf: string[] = []
  private escape = false
  private unicodeHex: string[] = []
  private unicodePending = 0
  private skipDepth = 0
  private skipInStr = false
  private skipEsc = false

  /** Feed a chunk of JSON text; collect deltas as strings grow/close.
   *  Tolerant of chunk boundaries at any position, including
   *  mid-escape and mid-`\\uXXXX`. */
  feed(chunk: string): JsonStringDelta[] {
    const out: JsonStringDelta[] = []
    for (const ch of chunk) {
      this.consume(ch, out)
    }
    // Flush any text accumulated for the currently-open string.
    // Close deltas (done=true) are pushed inline by `consume` when the
    // closing quote arrives; this only fires when the chunk ends
    // mid-value.
    if (this.valueBuf.length > 0 && this.state === State.InString) {
      out.push({ key: this.currentKey, content: this.valueBuf.join(''), done: false })
      this.valueBuf = []
    }
    return out
  }

  private consume(ch: string, out: JsonStringDelta[]): void {
    switch (this.state) {
      case State.BeforeObject:
        if (ch === '{') this.state = State.ExpectKeyOrEnd
        return
      case State.ExpectKeyOrEnd:
        if (WS.has(ch)) return
        if (ch === '"') {
          this.keyBuf = []
          this.state = State.InKey
        } else if (ch === '}') {
          this.state = State.Done
        }
        return
      case State.InKey:
        if (this.escape) {
          this.keyBuf.push(SIMPLE_ESCAPES[ch] ?? ch)
          this.escape = false
        } else if (ch === '\\') {
          this.escape = true
        } else if (ch === '"') {
          this.currentKey = this.keyBuf.join('')
          this.state = State.ExpectColon
        } else {
          this.keyBuf.push(ch)
        }
        return
      case State.ExpectColon:
        if (ch === ':') this.state = State.ExpectValue
        return
      case State.ExpectValue:
        if (WS.has(ch)) return
        if (ch === '"') {
          this.state = State.InString
          this.valueBuf = []
          this.escape = false
          this.unicodePending = 0
          return
        }
        // Non-string value — skip until balanced close or top-level comma.
        this.skipInStr = false
        this.skipEsc = false
        this.skipDepth = ch === '{' || ch === '[' ? 1 : 0
        this.state = State.SkipNonString
        return
      case State.InString:
        this.consumeInString(ch, out)
        return
      case State.SkipNonString:
        this.consumeSkip(ch)
        return
      case State.ExpectCommaOrEnd:
        if (WS.has(ch)) return
        if (ch === ',') this.state = State.ExpectKeyOrEnd
        else if (ch === '}') this.state = State.Done
        return
      case State.Done:
        return
    }
  }

  private consumeInString(ch: string, out: JsonStringDelta[]): void {
    if (this.unicodePending > 0) {
      this.unicodeHex.push(ch)
      this.unicodePending--
      if (this.unicodePending === 0) {
        const hex = this.unicodeHex.join('')
        this.unicodeHex = []
        const code = Number.parseInt(hex, 16)
        if (Number.isFinite(code)) {
          this.valueBuf.push(String.fromCodePoint(code))
        } else {
          this.valueBuf.push('�')
        }
      }
      return
    }
    if (this.escape) {
      this.escape = false
      if (ch === 'u') {
        this.unicodePending = 4
        this.unicodeHex = []
      } else {
        this.valueBuf.push(SIMPLE_ESCAPES[ch] ?? ch)
      }
      return
    }
    if (ch === '\\') {
      this.escape = true
      return
    }
    if (ch === '"') {
      if (this.valueBuf.length > 0) {
        out.push({ key: this.currentKey, content: this.valueBuf.join(''), done: false })
        this.valueBuf = []
      }
      out.push({ key: this.currentKey, content: '', done: true })
      this.state = State.ExpectCommaOrEnd
      return
    }
    this.valueBuf.push(ch)
  }

  private consumeSkip(ch: string): void {
    if (this.skipInStr) {
      if (this.skipEsc) {
        this.skipEsc = false
      } else if (ch === '\\') {
        this.skipEsc = true
      } else if (ch === '"') {
        this.skipInStr = false
      }
      return
    }
    if (ch === '"') {
      this.skipInStr = true
      return
    }
    if (ch === '{' || ch === '[') {
      this.skipDepth++
      return
    }
    if (ch === '}' || ch === ']') {
      if (this.skipDepth > 0) {
        this.skipDepth--
        if (this.skipDepth === 0) this.state = State.ExpectCommaOrEnd
        return
      }
      // Unmatched close — a bare literal (42, true, null) ended at
      // the object's closing brace.
      if (ch === '}') this.state = State.Done
      return
    }
    if (ch === ',' && this.skipDepth === 0) {
      this.state = State.ExpectKeyOrEnd
    }
  }
}
