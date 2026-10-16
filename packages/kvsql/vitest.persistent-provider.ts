/**
 * Vitest's Playwright provider, but each test page runs in a
 * persistent browser profile (in a temporary directory, removed at the
 * end) instead of an ephemeral context.
 *
 * Ephemeral contexts are private-browsing sessions: WebKit refuses
 * OPFS in them outright (`navigator.storage.getDirectory()` rejects
 * with UnknownError), and Chromium and Firefox keep their storage off
 * the disk. A persistent profile gives every browser OPFS on a real
 * disk, as a web app gets it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { playwright } from '@vitest/browser/providers'
import type { BrowserContext, BrowserType } from 'playwright'

/** The members of Vitest's Playwright provider used here. */
interface PlaywrightProvider {
  browserName: 'chromium' | 'firefox' | 'webkit'
  contexts: Map<string, BrowserContext>
  ctx: { config: { browser: { headless: boolean } } }
  options?: { launch?: object; context?: object }
  createContext(contextId: string): Promise<BrowserContext>
  close(): Promise<void>
}

const Provider = playwright as unknown as new () => PlaywrightProvider

export default class PersistentPlaywrightProvider extends Provider {
  private readonly profiles: string[] = []

  override async createContext(contextId: string): Promise<BrowserContext> {
    const existing = this.contexts.get(contextId)
    if (existing) return existing
    const browsers = (await import('playwright')) as unknown as Record<string, BrowserType>
    const browser = browsers[this.browserName]
    if (!browser) throw new Error(`no Playwright browser ${this.browserName}`)
    const profile = await mkdtemp(join(tmpdir(), `kvsql-${this.browserName}-`))
    this.profiles.push(profile)
    const context = await browser.launchPersistentContext(profile, {
      ...this.options?.launch,
      ...this.options?.context,
      headless: this.ctx.config.browser.headless,
      ignoreHTTPSErrors: true,
      serviceWorkers: 'allow',
    })
    this.contexts.set(contextId, context)
    return context
  }

  override async close(): Promise<void> {
    await super.close()
    await Promise.all(this.profiles.map((p) => rm(p, { recursive: true, force: true })))
    this.profiles.length = 0
  }
}
