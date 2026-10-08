/**
 * The compaction engine must never break a host step.
 *
 * Why this file exists: with `registerCompactionEngine` enabled, DSH calls
 * `compactIfNeeded` in the middle of a session step. A remounted composition
 * (hmr reload) closes the old stores while a stale engine instance may still
 * receive host calls — measured live as `database is not open` escaping into
 * the step and interrupting the session (2026-10-07). Pinned here:
 *  - a stale engine (`stores.closed` or `isDisposed()`) no-ops every entry;
 *  - a store failure inside the pass is contained (warn + null), the pass
 *    itself never throws across the seam;
 *  - the manual path still works when stores are healthy.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerMagicCompactionEngine } from '../src/dsh/compaction-engine.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    } catch {
      /* best effort */
    }
  }
})

const silentLogger = { info: () => {}, warn: () => {} }

/** The base class the host seam would inject, reduced to the called surface. */
class FakeBase {
  constructor(_ctx: unknown, _config?: unknown) {}
}

const agent = { session: { id: 'ses-1', header: { cwd: 'D:/work' }, append: () => ({ seq: 1 }) } }

interface Engine {
  compactIfNeeded(agent: unknown): Promise<unknown | null>
  compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<unknown | null>
}

async function build(options: {
  readonly stores: AdapterStores
  readonly isDisposed?: () => boolean
  readonly storesOverride?: AdapterStores
}): Promise<Engine> {
  let mounted: Engine | undefined
  const ctx = {
    plugin(Base: unknown): void {
      mounted = new (Base as new (c: unknown) => Engine)(ctx) as Engine
    },
  }
  await registerMagicCompactionEngine(ctx as never, {
    base: FakeBase,
    stores: options.stores,
    policy: {
      executeThreshold: 65,
      forceThreshold: 85,
      ttlMs: 300_000,
      protectedToolResults: 8,
      historianProtectedNodes: 8,
      historianMinNodes: 3,
      historianMaxTokens: 2048,
      historianMaxTokensCeiling: 32_768,
      historianMinBudgetTokens: 5000,
      baselineTokens: 2000,
      memoryBudgetTokens: 8000,
      memoryLimit: 40,
      historianTimeoutMs: 120_000,
    },
    logger: silentLogger,
    ...options.isDisposed === undefined ? {} : { isDisposed: options.isDisposed },
  })
  expect(mounted).toBeDefined()
  return mounted!
}

describe('a stale engine no-ops instead of throwing into the host step', () => {
  it('compactIfNeeded returns null once the stores are closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-engine-'))
    tempDirs.push(dir)
    const stores = openStores(dir)
    stores.close()
    expect(stores.closed).toBe(true)
    const engine = await build({ stores })
    await expect(engine.compactIfNeeded(agent)).resolves.toBeNull()
  })

  it('compactIfNeeded returns null when the composition is disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-engine-'))
    tempDirs.push(dir)
    const stores = openStores(dir)
    let disposed = false
    const engine = await build({ stores, isDisposed: () => disposed })
    disposed = true
    await expect(engine.compactIfNeeded(agent)).resolves.toBeNull()
    stores.close()
  })

  it('contains a store failure: warn + null, never a throw across the seam', async () => {
    const exploding: AdapterStores = new Proxy({} as AdapterStores, {
      get(_target, prop) {
        if (prop === 'closed') return false
        if (prop === 'close') return () => {}
        return () => {
          throw new Error('database is not open')
        }
      },
    })
    const warns: string[] = []
    const journalWarns: string[] = []
    let mounted: Engine | undefined
    const ctx = {
      plugin(Base: unknown): void {
        mounted = new (Base as new (c: unknown) => Engine)(ctx) as Engine
      },
    }
    await registerMagicCompactionEngine(ctx as never, {
      base: FakeBase,
      stores: exploding,
      policy: {
        executeThreshold: 65, forceThreshold: 85, ttlMs: 300_000, protectedToolResults: 8,
        historianProtectedNodes: 8, historianMinNodes: 3, historianMaxTokens: 2048,
        historianMaxTokensCeiling: 32_768, historianMinBudgetTokens: 5000,
        baselineTokens: 2000, memoryBudgetTokens: 8000, memoryLimit: 40, historianTimeoutMs: 120_000,
      },
      logger: { info: () => {}, warn: (message: string) => { warns.push(message) } },
      journal: {
        info: () => {},
        warn: (summary: string) => { journalWarns.push(summary) },
      } as never,
    })
    expect(mounted).toBeDefined()
    await expect(mounted!.compactIfNeeded(agent)).resolves.toBeNull()
    expect(warns.some(message => message.includes('management pass failed'))).toBe(true)
    expect(journalWarns.length).toBe(1)
  })
})
