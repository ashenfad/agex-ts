/**
 * Secrets: values the world never holds. A secret lives with the host;
 * the shell and code have only its reference (`${NAME}`), which the
 * host's own code (a command, a host object) fills at the request that
 * needs it.
 *
 * A secret may be bound to the origins it may be sent to, so a request
 * elsewhere is refused rather than leaking it. A plain string is
 * unbound: the host's choice.
 */

import { InvalidNameError } from './errors'

/** A secret as a profile gives it: a value, or a value with the origins
 *  it may be sent to (`['https://abc.supabase.co']`). */
export type SecretSpec = string | { readonly value: string; readonly origins: readonly string[] }

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

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/** The secrets of a profile, as host code reaches them. */
export class Secrets {
  readonly #values = new Map<string, { value: string; origins: ReadonlySet<string> | null }>()

  constructor(specs: Readonly<Record<string, SecretSpec>> = {}) {
    for (const [name, spec] of Object.entries(specs)) {
      if (typeof spec === 'string') {
        this.#values.set(name, { value: spec, origins: null })
      } else {
        this.#values.set(name, {
          value: spec.value,
          origins: new Set(spec.origins.map((o) => originOf(o, name))),
        })
      }
    }
  }

  /** The secrets' names, sorted. */
  names(): string[] {
    return [...this.#values.keys()].sort()
  }

  /** A secret's value, for host code that builds a client with it (the
   *  origins are then that code's to keep). */
  get(name: string): string | undefined {
    return this.#values.get(name)?.value
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
   */
  fill(text: string, to: URL): string {
    return text.replace(REF, (whole, a, b) => {
      const name = (a ?? b) as string
      const secret = this.#values.get(name)
      if (secret === undefined) return whole
      if (secret.origins !== null && !secret.origins.has(to.origin)) {
        throw new SecretOriginError(name, to.origin)
      }
      return secret.value
    })
  }

  /** Whether `text` refers to a secret bound to origins. */
  refersToBound(text: string): boolean {
    for (const m of text.matchAll(REF)) {
      if (this.#values.get((m[1] ?? m[2]) as string)?.origins != null) return true
    }
    return false
  }

  /** `text` with any secret value in it replaced by its reference. */
  scrub(text: string): string {
    let out = text
    for (const [name, { value }] of this.#values) {
      if (value.length >= 4) out = out.split(value).join(secretRef(name))
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

/** Check a profile's secrets: names, values and origins. */
export function checkSecrets(specs: Readonly<Record<string, SecretSpec>>): void {
  for (const [name, spec] of Object.entries(specs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new InvalidNameError(`secret ${JSON.stringify(name)}: a name is [A-Za-z_][A-Za-z0-9_]*`)
    }
    if (typeof spec === 'string') continue
    if (typeof spec !== 'object' || spec === null || typeof spec.value !== 'string') {
      throw new TypeError(`secret ${name}: a string, or {value, origins}`)
    }
    if (!Array.isArray(spec.origins) || spec.origins.length === 0) {
      throw new TypeError(`secret ${name}: origins is a non-empty list of URLs`)
    }
    new Secrets({ [name]: spec })
  }
}
