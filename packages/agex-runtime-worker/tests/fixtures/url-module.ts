/**
 * Test fixture: a tiny ESM module the worker imports via the
 * URL-shipped registration path. Vite (driving Vitest browser
 * mode) serves this file under a stable URL; tests pass that URL
 * to `agent.cls({ url, export: '...' })` and friends.
 *
 * Pure JS — no host closures, no Node deps — exactly the kind of
 * code the URL-shipped path is for.
 */

export class Vec {
  constructor(
    public x: number,
    public y: number,
  ) {}
  add(other: Vec): Vec {
    return new Vec(this.x + other.x, this.y + other.y)
  }
  magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y)
  }
  static zero(): Vec {
    return new Vec(0, 0)
  }
}

export function double(x: number): number {
  return x * 2
}

export const utils = {
  greet(name: string): string {
    return `hello ${name}`
  },
  shout(s: string): string {
    return s.toUpperCase()
  },
}

export default {
  marker: 'default-export-payload',
}
