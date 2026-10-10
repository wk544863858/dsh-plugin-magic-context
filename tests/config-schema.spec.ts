/**
 * The runtime config schema — the contract the settings form and the loader
 * rely on.
 *
 * These assertions guard three measured traps:
 *  1. `Config` must ride on the DEFAULT export: the loader's `unwrapExports`
 *     reads `Config` from the default object, so a named export alone is
 *     silently ignored and the configuration never parses.
 *  2. Only declared fields are visible to the settings form, and only
 *     `.volatile()` ones are projected at all — so the tunable knobs must be
 *     declared volatile or the UI has nothing to render.
 *  3. `memory` must stay UNDECLARED: schemastery materialises declared nested
 *     objects with defaults, and in this plugin the mere presence of `memory`
 *     opens the read/write bridge on the shared store. Declaring it would turn
 *     memory on for every profile that never asked for it.
 */
import { describe, expect, it } from 'vitest'
import mcDshPlugin, { Config, policyOf } from '../src/index.ts'
import { DEFAULT_POLICY } from '../src/core/policy.ts'

type Volatile = { get(): unknown }

describe('runtime Config schema', () => {
  it('rides on the default export, where the loader looks for it', () => {
    expect((mcDshPlugin as { Config?: unknown }).Config).toBe(Config)
  })

  it('declares the tunable thresholds as volatile references with the real defaults', () => {
    const value = Config({}) as unknown as Record<string, any>
    // Volatile leaves are live references, not plain numbers.
    expect(typeof (value.policy.executeThreshold as Volatile).get).toBe('function')
    expect((value.policy.executeThreshold as Volatile).get()).toBe(DEFAULT_POLICY.executeThreshold)
    expect((value.policy.forceThreshold as Volatile).get()).toBe(DEFAULT_POLICY.forceThreshold)
    expect((value.policy.assumedContextWindow as Volatile).get()).toBe(DEFAULT_POLICY.assumedContextWindow)
    expect((value.policy.baselineTokens as Volatile).get()).toBe(DEFAULT_POLICY.baselineTokens)
    expect((value.policy.memoryLimit as Volatile).get()).toBe(DEFAULT_POLICY.memoryLimit)
    expect((value.journal.retentionDays as Volatile).get()).toBe(30)
    expect((value.journal.enabled as Volatile).get()).toBe(true)
    // The compaction seam stays OFF unless a user turns it on explicitly.
    expect((value.registerCompactionEngine as Volatile).get()).toBe(false)
    expect((value.historianEnabled as Volatile).get()).toBe(true)
  })

  it('accepts the percent-based thresholds the policy actually uses', () => {
    const value = Config({ policy: { executeThreshold: 30, forceThreshold: 95, assumedContextWindow: 12_000 } }) as unknown as Record<string, any>
    expect((value.policy.executeThreshold as Volatile).get()).toBe(30)
    expect((value.policy.forceThreshold as Volatile).get()).toBe(95)
    expect((value.policy.assumedContextWindow as Volatile).get()).toBe(12_000)
    // Out-of-range values are rejected rather than silently clamped.
    expect(() => Config({ policy: { executeThreshold: 150 } })).toThrow()
    expect(() => Config({ policy: { assumedContextWindow: 0 } })).toThrow()
  })

  it('rejects a journal retention that would prune the whole table at open', () => {
    // 0/negative days prune with a future cutoff — every row is "older".
    expect(() => Config({ journal: { retentionDays: 0 } })).toThrow()
    expect(() => Config({ journal: { retentionDays: -5 } })).toThrow()
    const value = Config({ journal: { retentionDays: 7 } }) as unknown as Record<string, any>
    expect((value.journal.retentionDays as Volatile).get()).toBe(7)
  })

  it('never materialises the memory block, and passes unknown keys through', () => {
    const bare = Config({}) as unknown as Record<string, unknown>
    expect(bare.memory).toBeUndefined()

    const sentinel = { provider: 'mock', model: 'mock' }
    const explicit = Config({
      memory: { dbPath: 'C:/tmp/context.db', project: 'git:abc', autoPromote: false },
      defineTool: sentinel,
    }) as unknown as Record<string, any>
    expect(explicit.memory.dbPath).toBe('C:/tmp/context.db')
    expect(explicit.memory.autoPromote).toBe(false)
    // Undeclared keys survive untouched (schemastery passes them through).
    expect(explicit.defineTool).toBe(sentinel)
  })

  it('reads live values at the decision point, which is what makes an edit immediate', () => {
    // A volatile reference whose value changes between two evaluations.
    let current = 20
    const live = { get: () => current }
    const policy = policyOf({ executeThreshold: live as unknown as number })
    expect(policy.executeThreshold).toBe(20)
    current = 80
    expect(policyOf({ executeThreshold: live as unknown as number }).executeThreshold).toBe(80)
    // Plain values and absent fields keep their defaults.
    expect(policyOf({ forceThreshold: 70 }).forceThreshold).toBe(70)
    expect(policyOf(undefined).executeThreshold).toBe(DEFAULT_POLICY.executeThreshold)
    expect(policyOf({ executeThreshold: { get: () => Number.NaN } as unknown as number }).executeThreshold)
      .toBe(DEFAULT_POLICY.executeThreshold)
  })
})
