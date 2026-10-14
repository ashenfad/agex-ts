/**
 * What the host grants a world: host objects for its code, variables,
 * secrets, and how its code runs. A profile is given when a session is
 * opened, held in memory only (it is never stored), and inherited by
 * forks.
 */

import type { CommandHandler } from '@agex-ts/termish'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { InvalidNameError } from './errors'
import { type SecretSpec, type Secrets, checkSecrets, secretRef } from './secrets'
import { type SkillSource, skillName } from './skills'
import { isSchema } from './values'
import { describe, inspect } from './values/inspect'
import type { Workspace } from './workspace'

const FACTORY = Symbol('world.hostFactory')
const COMMAND = Symbol('world.commandFactory')
const WANTS_CALL = Symbol('world.withCall')
const TYPED = Symbol('world.typedHost')

/** What a host object made per world receives beside its workspace. */
export interface HostWorld {
  /** The profile's secrets, which only the host's own code holds: a
   *  client built with one keeps it out of the world. */
  readonly secrets: Secrets
}

/** A host object made per world: `factory(ws, {secrets})` runs as each
 *  workspace opens, forks included, so the object knows which session
 *  it serves. */
export interface HostFactory {
  readonly [FACTORY]: (ws: Workspace, world: HostWorld) => object
}

/** Make a host object per world. */
export function hostFactory(factory: (ws: Workspace, world: HostWorld) => object): HostFactory {
  return { [FACTORY]: factory }
}

/**
 * What one method of a {@link typedHost} takes and gives: a Standard
 * Schema per argument, in order (an array), or by name (an object, in
 * the order the method takes them: the names show in errors), and one
 * for what it returns. Either may be left out, for a method whose
 * arguments or result are any data.
 */
export interface MethodContract {
  readonly args?: readonly StandardSchemaV1[] | Readonly<Record<string, StandardSchemaV1>>
  readonly returns?: StandardSchemaV1
}

/** A typed host object's methods, by name. */
export type HostContract = Readonly<Record<string, MethodContract>>

/** A host object with a contract: see {@link typedHost}. */
export interface TypedHost {
  readonly [TYPED]: { readonly host: object | HostFactory; readonly methods: HostContract }
}

/**
 * A host object whose methods are typed: code may call exactly the
 * methods `methods` names, each argument is checked against its schema
 * on the host before the method runs (a mismatch is a `TypeError` at
 * the call in the code, naming where), and the method gets what the
 * schemas give back, so a schema that transforms hands it the
 * transformed value. A result is checked against `returns` before it
 * goes back to the code. `host` is an object or a {@link hostFactory}.
 */
export function typedHost(host: object | HostFactory, methods: HostContract): TypedHost {
  checkContract('typedHost', methods)
  return { [TYPED]: { host, methods } }
}

/** A host object: an object whose public methods (not starting with
 *  `_`) code may call, a {@link hostFactory}, or a {@link typedHost}. */
export type HostObject = object | HostFactory | TypedHost

/** A host object as one workspace holds it: the object, and its
 *  contract when it is typed. */
export interface HostEntry {
  readonly obj: object
  readonly contract: HostContract | null
  /** The methods code may call, sorted. */
  readonly methods: readonly string[]
}

/**
 * What a host method declared with {@link withCall} receives first,
 * when code calls it.
 */
export interface HostCall {
  /**
   * The workspace whose code made the call, as part of that call:
   * its changes (a fork, a commit, a file write) run now, inside the
   * code's call, rather than queueing behind it, which would wait
   * forever. A fork commits the call's changes so far.
   */
  readonly ws: Workspace
}

/** A host method declared with {@link withCall}. */
export type CallAware<A extends unknown[], R> = ((...args: A) => R) & {
  readonly [WANTS_CALL]: (call: HostCall, ...args: A) => R
}

/**
 * Declare a host method that receives the {@link HostCall} when code
 * calls it, for a method that changes the workspace whose code called
 * it. Called directly by the host, it gets no call: `call` is
 * undefined.
 *
 * A method that changes that workspace any other way (a workspace it
 * closed over) queues behind the code's call, which waits for the
 * method: the two wait on each other until the run times out.
 */
export function withCall<A extends unknown[], R>(
  fn: (call: HostCall | undefined, ...args: A) => R,
): CallAware<A, R> {
  const direct = function (this: unknown, ...args: A): R {
    return fn.call(this, undefined, ...args)
  }
  return Object.assign(direct, { [WANTS_CALL]: fn as (call: HostCall, ...args: A) => R })
}

/** The call-aware implementation of a method, if it has one. */
export function callAware(
  fn: unknown,
): ((call: HostCall, ...args: unknown[]) => unknown) | undefined {
  return typeof fn === 'function'
    ? (fn as Partial<CallAware<unknown[], unknown>>)[WANTS_CALL]
    : undefined
}

export interface CodeSettings {
  /** Seconds a run may take before it is stopped (default 30). */
  readonly timeout?: number
  /** The most characters of stdout, and of stderr, a result keeps
   *  (default 32,000); the rest is cut and `truncated` set. */
  readonly maxObservation?: number
  /** A bare import (`'arquero'`) to the URL to load it from, or null
   *  for none: `(name) => \`https://esm.sh/${name}\``, say. Without
   *  one, only world paths, `'host'` and URLs import. */
  readonly resolve?: (specifier: string) => string | null | Promise<string | null>
  /** `fetch('/path')` reads the world's files: for every path (true,
   *  falling back to the network on a miss), only under these
   *  prefixes (a miss is a 404), or never (false, the default). */
  readonly routeFetch?: boolean | readonly string[]
  /** TypeScript to JavaScript; default ts-blank-space, which strips
   *  types and refuses the forms that need more (enums, namespaces,
   *  decorators). A transform should keep every line where it was, as
   *  ts-blank-space does, or errors name the wrong lines. */
  readonly transform?: (code: string) => string | Promise<string>
  /** Where the kernel's worker runs: a browser Web Worker or Node
   *  `worker_threads` (default: detected), and its script (default:
   *  the package's built worker). */
  readonly worker?: { readonly target?: 'auto' | 'browser' | 'node'; readonly url?: string | URL }
}

/** What a host command made per world knows about it. */
export interface CommandWorld {
  /** The workspace, as part of the shell call the command runs in: a
   *  change it makes (a write, a commit) runs at once, not queued
   *  behind that call. */
  readonly ws: Workspace
  /** The profile's secrets, which only the host's own code holds. */
  readonly secrets: Secrets
}

/** A terminal command made per world, with a line for the terminal
 *  tool's description. */
export interface CommandFactory {
  readonly [COMMAND]: (world: CommandWorld) => CommandHandler
  readonly description?: string
}

/**
 * Make a terminal command per world: `make({ws, secrets})` runs as each
 * workspace opens, forks included. A command that uses secrets is made
 * this way, since nothing else carries them.
 */
export function commandFactory(
  make: (world: CommandWorld) => CommandHandler,
  opts: { description?: string } = {},
): CommandFactory {
  return {
    [COMMAND]: make,
    ...(opts.description !== undefined && { description: opts.description }),
  }
}

/** A terminal command: a termish handler, or a {@link commandFactory}. */
export type HostCommand = CommandHandler | CommandFactory

export interface Profile {
  /** Objects code can call, by name. Each is a binding of its own and
   *  a member of `host` (`import { db } from 'host'`). */
  readonly hostObjects?: Readonly<Record<string, HostObject>>
  /**
   * Data code reads by name: each a binding of its own, sent to the
   * worker by value with each run, so code gets a fresh copy every time
   * and can't change the host's. Only what crosses by value is taken: a
   * value with a live part (a function, a class's instance) is refused.
   */
  readonly values?: Readonly<Record<string, unknown>>
  /**
   * Ordinary configuration, public by design (a service's URL, a
   * public key): `env` in code, and the shell's variables.
   */
  readonly variables?: Readonly<Record<string, string>>
  /**
   * Values that never enter the world: no code or shell reads them,
   * and nothing stores them. The shell and code have references to them
   * (`$NAME`, `secret('NAME')`), which the host's own code (a command,
   * a host object) fills at the request that needs one. A secret given
   * as `{value, origins}` is filled only for requests to those origins;
   * a plain string goes wherever it is asked to.
   */
  readonly secrets?: Readonly<Record<string, SecretSpec>>
  /** Terminal commands, by name, beside termish's own (a name of
   *  theirs replaces it). */
  readonly commands?: Readonly<Record<string, HostCommand>>
  readonly code?: CodeSettings
  /**
   * Skills mounted read-only at `<root>/skills/<name>` (see `skills`):
   * the embedder's, never the agent's to change, and not files of the
   * session, so no commit carries them. Each is a `SKILL.md` text, or
   * its files.
   */
  readonly skills?: readonly SkillSource[]
}

/** Names code already has, and words JavaScript reserves. */
const RESERVED = new Set([
  ...['fs', 'cache', 'env', 'console', 'host', 'secret', '__modules', '__load', '__exports'],
  ...['__registered', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'globalThis'],
  ...['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default'],
  ...['delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for'],
  ...['function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new'],
  ...['null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super'],
  ...['switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with'],
  'yield',
])

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Check a profile's names, and return it. */
export function checkProfile(profile: Profile): Profile {
  for (const [name, entry] of Object.entries(profile.hostObjects ?? {})) {
    if (!IDENTIFIER.test(name) || RESERVED.has(name)) {
      throw new InvalidNameError(
        `host object ${JSON.stringify(name)}: a name is an identifier code doesn't already have`,
      )
    }
    // A typed object (not one a factory makes) has its contract checked
    // against its methods now, not when a workspace opens.
    const typed = (entry as Partial<TypedHost>)[TYPED]
    if (typed !== undefined && (typed.host as Partial<HostFactory>)[FACTORY] === undefined) {
      hostEntry(name, typed.host, typed.methods)
    }
  }
  for (const [name, value] of Object.entries(profile.values ?? {})) {
    if (!IDENTIFIER.test(name) || RESERVED.has(name)) {
      throw new InvalidNameError(
        `value ${JSON.stringify(name)}: a name is an identifier code doesn't already have`,
      )
    }
    if (profile.hostObjects !== undefined && name in profile.hostObjects) {
      throw new InvalidNameError(`${name} is both a value and a host object`)
    }
    const live = inspect(value, 'cross')
    if (live !== null) {
      throw new TypeError(`value ${name} can't be sent to code by value: ${describe(live)}`)
    }
  }
  for (const [name, value] of Object.entries(profile.variables ?? {})) {
    if (!VARIABLE.test(name)) {
      throw new InvalidNameError(
        `variable ${JSON.stringify(name)}: a name is [A-Za-z_][A-Za-z0-9_]*`,
      )
    }
    if (typeof value !== 'string') throw new TypeError(`variable ${name}: a value is a string`)
  }
  checkSecrets(profile.secrets ?? {})
  for (const name of Object.keys(profile.variables ?? {})) {
    if (profile.secrets !== undefined && name in profile.secrets) {
      throw new InvalidNameError(`${name} is both a variable and a secret`)
    }
  }
  for (const [name, command] of Object.entries(profile.commands ?? {})) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name)) {
      throw new InvalidNameError(
        `command ${JSON.stringify(name)}: a name is letters, digits and _ . + -`,
      )
    }
    if (
      typeof command !== 'function' &&
      (command as Partial<CommandFactory>)[COMMAND] === undefined
    ) {
      throw new TypeError(`command ${name}: a handler or a commandFactory`)
    }
  }
  const skills = new Set<string>()
  for (const skill of profile.skills ?? []) {
    const name = skillName(skill)
    if (skills.has(name)) throw new InvalidNameError(`two skills are named '${name}'`)
    skills.add(name)
  }
  return profile
}

/** The terminal commands of a profile for one workspace, factories
 *  made. */
export function makeCommands(profile: Profile, world: CommandWorld): Map<string, CommandHandler> {
  const out = new Map<string, CommandHandler>()
  for (const [name, command] of Object.entries(profile.commands ?? {})) {
    out.set(name, typeof command === 'function' ? command : command[COMMAND](world))
  }
  return out
}

/** The description lines of a profile's commands, by name. */
export function commandDescriptions(profile: Profile): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  for (const [name, command] of Object.entries(profile.commands ?? {})) {
    out.set(name, typeof command === 'function' ? undefined : command.description)
  }
  return out
}

/**
 * The shell's variables for one call: the profile's variables, and each
 * secret as a reference to itself (`$TOKEN` expands to `${TOKEN}`), so
 * a command that takes secrets can find and fill it, and nothing else
 * ever sees its value.
 */
export function shellEnv(profile: Profile): Record<string, string> {
  const env: Record<string, string> = { ...profile.variables }
  for (const name of Object.keys(profile.secrets ?? {})) env[name] = secretRef(name)
  return env
}

/** The host objects of a profile for one workspace, factories made. */
export function makeHostObjects(
  profile: Profile,
  ws: Workspace,
  world: HostWorld,
): Map<string, HostEntry> {
  const out = new Map<string, HostEntry>()
  for (const [name, entry] of Object.entries(profile.hostObjects ?? {})) {
    const typed = (entry as Partial<TypedHost>)[TYPED]
    const host = typed === undefined ? entry : typed.host
    const factory = (host as Partial<HostFactory>)[FACTORY]
    const obj = factory === undefined ? host : factory(ws, world)
    out.set(name, hostEntry(name, obj, typed?.methods ?? null))
  }
  return out
}

function hostEntry(name: string, obj: object, contract: HostContract | null): HostEntry {
  const methods = publicMethods(obj)
  if (contract === null) return { obj, contract, methods }
  const missing = Object.keys(contract).filter((m) => !methods.includes(m))
  if (missing.length > 0) {
    throw new TypeError(
      `host object ${name}: its contract names ${missing.join(', ')}, not among its methods`,
    )
  }
  return { obj, contract, methods: Object.keys(contract).sort() }
}

function checkContract(what: string, methods: HostContract): void {
  if (typeof methods !== 'object' || methods === null || Object.keys(methods).length === 0) {
    throw new TypeError(`${what}: a contract names at least one method`)
  }
  for (const [method, contract] of Object.entries(methods)) {
    const args = contract.args ?? []
    const schemas = Array.isArray(args) ? args : Object.values(args)
    for (const schema of [
      ...schemas,
      ...(contract.returns === undefined ? [] : [contract.returns]),
    ]) {
      if (!isSchema(schema)) {
        throw new TypeError(`${what}: ${method} has something other than a Standard Schema`)
      }
    }
  }
}

/** The methods code may call on a host object: every function-valued
 *  property, own or inherited (short of `Object.prototype`), whose name
 *  doesn't start with `_`. */
export function publicMethods(obj: object): string[] {
  const names = new Set<string>()
  for (let o: object | null = obj; o !== null && o !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === 'constructor' || name.startsWith('_')) continue
      if (typeof (obj as Record<string, unknown>)[name] === 'function') names.add(name)
    }
    o = Object.getPrototypeOf(o) as object | null
  }
  return [...names].sort()
}
