/**
 * Test fixture for evalRuntime URL-shipped registration tests.
 *
 * Plain JS (not TypeScript) so Node's native dynamic `import(url)`
 * can load it directly — agex-ts tests run in Vitest's Node mode
 * without a TS loader for runtime imports, so a `.ts` fixture
 * here would fail.
 */

export class Vec {
  constructor(x, y) {
    this.x = x
    this.y = y
  }
  add(other) {
    return new Vec(this.x + other.x, this.y + other.y)
  }
  magnitude() {
    return Math.sqrt(this.x * this.x + this.y * this.y)
  }
}

export function double(x) {
  return x * 2
}

export const utils = {
  greet(name) {
    return `hello ${name}`
  },
}

export default {
  marker: 'default-payload',
}
