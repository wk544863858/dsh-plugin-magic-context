/**
 * The S(t) decay scoring (schema v7, borrowed from mon3stera's
 * dsh-magic-context memory.js): hits slow the decay and boost the score,
 * category half-lives gate retirement, and cold-start rows (no sidecar stats
 * yet) are favored — never punished for stats the adapter has not collected.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MEMORY_SCORING, halfLifeFor, scoreMemory } from '../src/core/memory-scoring.ts'

const DAY = 86_400_000

describe('S(t) memory scoring', () => {
  it('immortal categories never decay; hits still boost (clamped at 100)', () => {
    const config = DEFAULT_MEMORY_SCORING
    const fresh = scoreMemory({ importance: 50, category: 'ARCHITECTURE', hits: 0, lastHitAt: undefined }, config, 1000 * DAY)
    expect(fresh).toBe(50)
    const old = scoreMemory({ importance: 50, category: 'ARCHITECTURE', hits: 0, lastHitAt: 1000 * DAY }, config, 1000 * DAY)
    expect(old).toBe(50)
    const hit = scoreMemory({ importance: 50, category: 'ARCHITECTURE', hits: 4, lastHitAt: 1000 * DAY }, config, 1000 * DAY)
    expect(hit).toBeCloseTo(Math.min(100, 50 * (1 + 0.4 * Math.log(5))), 6)
  })

  it('decays by the category half-life; hits slow the decay (tau_eff = tau / (1 + beta*k))', () => {
    const config = DEFAULT_MEMORY_SCORING
    const now = 1000 * DAY
    // One half-life with no hits: exactly half.
    const noHits = scoreMemory({ importance: 100, category: 'CONFIG_VALUES', hits: 0, lastHitAt: now - 60 * DAY }, config, now)
    expect(noHits).toBeCloseTo(50, 5)
    // At 30 days the slowdown dominates: tau_eff shrinks to 60/1.8 ≈ 33.3
    // days, so decay is mild (2^-0.9 ≈ 0.54) and the log-boost applies —
    // strictly hotter than the untouched row at the same age.
    const olderNoHits = scoreMemory({ importance: 100, category: 'CONFIG_VALUES', hits: 0, lastHitAt: now - 30 * DAY }, config, now)
    const withHits = scoreMemory({ importance: 100, category: 'CONFIG_VALUES', hits: 4, lastHitAt: now - 30 * DAY }, config, now)
    expect(olderNoHits).toBeCloseTo(100 * Math.SQRT1_2, 5)
    expect(withHits).toBeGreaterThan(olderNoHits)
  })

  it('rows without sidecar stats are favored, not punished', () => {
    // No lastHitAt: no decay is applied, whatever the category half-life is.
    expect(scoreMemory({ importance: 80, category: 'CONFIG_VALUES', hits: 0 }, DEFAULT_MEMORY_SCORING, 10_000 * DAY)).toBe(80)
  })

  it('clamps to the shared store scale', () => {
    const config = DEFAULT_MEMORY_SCORING
    expect(scoreMemory({ importance: 100, category: 'ARCHITECTURE', hits: 50, lastHitAt: undefined }, config, 0)).toBe(100)
    // importance 1 after ~11 CONFIG_VALUES half-lives is far under the threshold.
    expect(scoreMemory({ importance: 1, category: 'CONFIG_VALUES', hits: 0, lastHitAt: 0 }, config, 400 * DAY)).toBeLessThan(2)
  })

  it('halfLifeFor: unknown and non-positive values are immortal', () => {
    expect(halfLifeFor(DEFAULT_MEMORY_SCORING, 'PROJECT_RULES')).toBeNull()
    expect(halfLifeFor(DEFAULT_MEMORY_SCORING, 'MADE_UP')).toBeNull()
    expect(halfLifeFor({ ...DEFAULT_MEMORY_SCORING, halfLives: { X: 0 } }, 'X')).toBeNull()
    expect(halfLifeFor({ ...DEFAULT_MEMORY_SCORING, halfLives: { X: 30 } }, 'X')).toBe(30)
  })
})
