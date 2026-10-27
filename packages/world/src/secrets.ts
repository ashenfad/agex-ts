/**
 * Secrets: values the world never holds. A secret lives with the host;
 * the shell and code have only its reference (`${NAME}`), which the
 * host's own code (a command, a host object) fills at the request that
 * needs it.
 *
 * A secret may be bound to the origins it may be sent to, so a request
 * elsewhere is refused rather than leaking it. A plain string is
 * unbound: the host's choice.
 *
 * A secret may also be declared without a value: the world names it and
 * has its reference, but its value is held further out, by a host
 * object that sends the request on and has it filled there. The world's
 * own requests refuse to carry it, since they have nothing to fill.
 */

import { InvalidNameError } from './errors'

/** A secret as a profile gives it: a value, or a value with the origins
 *  it may be sent to (`['https://abc.supabase.co']`), or only those
 *  origins, for a secret declared here whose value the host holds. */
export type SecretSpec = string | { readonly value?: string; readonly origins: readonly string[] }

/** Secrets by name, as a profile gives them. */
export type SecretSpecs = Readonly<Record<string, SecretSpec>>

/** A secret's reference, as the shell expands it and `secret(name)`
 *  gives it in code. */
export const secretRef = (name: string): string => `\${${name}}`

/** A reference was filled into a request for an origin its secret isn't
 *  bound to. */
export class SecretOriginError extends Error {
  override readonly name = 'SecretOriginError'
  constructor(
    readonly secret: string,
    readonly origin: string,
  ) {
    super(`secret ${secret} may not be sent to ${origin}`)
  }
}

/** A secret declared without a value was asked for one (filled into a
 *  request, or read with `get`): the host holds it, so only a host
 *  object that fills it can send the request. */
export class DeclaredSecretError extends Error {
  override readonly name = 'DeclaredSecretError'
  constructor(readonly secret: string) {
    super(
      `secret ${secret} has no value here: the host holds it, so the request must go through a host object that fills it`,
    )
  }
}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

type Entries = Map<string, { value: string | null; origins: ReadonlySet<string> | null }>

/** Secrets read from specs: each name's value (null when declared
 *  without one) and origins (null when unbound). */
function entriesOf(specs: SecretSpecs): Entries {
  const entries: Entries = new Map()
  for (const [name, spec] of Object.entries(specs)) {
    if (typeof spec === 'string') {
      entries.set(name, { value: spec, origins: null })
    } else {
      entries.set(name, {
        value: spec.value ?? null,
        origins: new Set(spec.origins.map((o) => originOf(o, name))),
      })
    }
  }
  return entries
}

/**
 * The secrets of a profile, as host code reaches them. Given a
 * function, they are what it returns at each use, checked whenever it
 * returns something new: a key granted while the session is open is
 * there for the next request, and one revoked is gone.
 */
export class Secrets {
  readonly #source: SecretSpecs | (() => SecretSpecs)
  #read: { specs: SecretSpecs; entries: Entries } | null = null

  constructor(specs: SecretSpecs | (() => SecretSpecs) = {}) {
    this.#source = specs
    if (typeof specs !== 'function') this.#read = { specs, entries: entriesOf(specs) }
  }

  get #values(): Entries {
    if (typeof this.#source !== 'function') return (this.#read as { entries: Entries }).entries
    const specs = this.#source()
    if (this.#read?.specs !== specs) {
      checkSecrets(specs)
      this.#read = { specs, entries: entriesOf(specs) }
    }
    return this.#read.entries
  }

  /** The secrets' names, sorted. */
  names(): string[] {
    return [...this.#values.keys()].sort()
  }

  /**
   * A secret's value, for host code that builds a client with it (the
   * origins are then that code's to keep).
   *
   * @throws DeclaredSecretError for a secret declared without a value.
   */
  get(name: string): string | undefined {
    const secret = this.#values.get(name)
    if (secret?.value === null) throw new DeclaredSecretError(name)
    return secret?.value
  }

  /** Whether a secret is declared without a value (false for a name
   *  that isn't a secret). */
  declared(name: string): boolean {
    return this.#values.get(name)?.value === null
  }

  /** The origins a secret may be sent to; null when unbound. */
  origins(name: string): readonly string[] | null {
    const origins = this.#values.get(name)?.origins
    return origins === undefined || origins === null ? null : [...origins]
  }

  /**
   * Fill the references (`${NAME}` or `$NAME`) in `text`, for a request
   * to `to`. A name that isn't a secret is left as it is.
   *
   * @throws SecretOriginError for a bound secret `to` isn't one of its
   *   origins.
   * @throws DeclaredSecretError for a secret declared without a value.
   */
  fill(text: string, to: URL): string {
    const values = this.#values
    return text.replace(REF, (whole, a, b) => {
      const name = (a ?? b) as string
      const secret = values.get(name)
      if (secret === undefined) return whole
      if (secret.origins !== null && !secret.origins.has(to.origin)) {
        throw new SecretOriginError(name, to.origin)
      }
      if (secret.value === null) throw new DeclaredSecretError(name)
      return secret.value
    })
  }

  /** Whether `text` refers to a secret bound to origins. */
  refersToBound(text: string): boolean {
    const values = this.#values
    for (const m of text.matchAll(REF)) {
      if (values.get((m[1] ?? m[2]) as string)?.origins != null) return true
    }
    return false
  }

  /** `text` with any secret value in it replaced by its reference (a
   *  declared secret has none to replace). */
  scrub(text: string): string {
    let out = text
    for (const [name, { value }] of this.#values) {
      if (value !== null && value.length >= 4) out = out.split(value).join(secretRef(name))
    }
    return out
  }
}

function originOf(url: string, secret: string): string {
  try {
    const origin = new URL(url).origin
    if (origin === 'null') throw new Error()
    return origin
  } catch {
    throw new InvalidNameError(`secret ${secret}: origin ${JSON.stringify(url)} is not a URL`)
  }
}

/** Check a profile's secrets: names, values and origins. A secret
 *  without a value is bound to origins all the same. */
export function checkSecrets(specs: Readonly<Record<string, SecretSpec>>): void {
  for (const [name, spec] of Object.entries(specs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new InvalidNameError(`secret ${JSON.stringify(name)}: a name is [A-Za-z_][A-Za-z0-9_]*`)
    }
    if (typeof spec === 'string') continue
    if (
      typeof spec !== 'object' ||
      spec === null ||
      (spec.value !== undefined && typeof spec.value !== 'string')
    ) {
      throw new TypeError(`secret ${name}: a string, {value, origins}, or {origins}`)
    }
    if (!Array.isArray(spec.origins) || spec.origins.length === 0) {
      throw new TypeError(`secret ${name}: origins is a non-empty list of URLs`)
    }
    new Secrets({ [name]: spec })
  }
}
