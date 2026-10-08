/**
 * The context-pressure gate (journal-churn control, 2026-10-08 telemetry
 * review). Every distinct projection reading used to write a row — ~10/min
 * during heavy work. The rules pinned here decide what still gets logged; the
 * panel reads the newest row, so anything below the gate is a lag, not a loss.
 */
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_PRESSURE_MIN_DELTA_RATIO,
  CONTEXT_PRESSURE_MIN_DELTA_TOKENS,
  pressureUsedTokens,
  shouldLogContextPressure,
} from '<path>'

describe('shouldLogContextPressure', () => {
  it('always logs the first reading of a session (it anchors the gauge)', () => {
    expect(shouldLogContextPressure(undefined, { projectedTokens: 130_634, contextWindow: 512_000 })).toBe(true)
    expect(shouldLogContextPressure(undefined, {})).toBe(true)
  })

  it('skips movement below the absolute floor', () => {
    const previous = { used: 130_000, window: 512_000 }
    expect(shouldLogContextPressure(previous, { projectedTokens: 130_100, contextWindow: 512_000 })).toBe(false)
  })

  it('logs a step at or above the floor on a small window', () => {
    const previous = { used: 10_000, window: 100_000 } // floor 512 > 0.25% (250)
    expect(shouldLogContextPressure(previous, { projectedTokens: 10_512, contextWindow: 100_000 })).toBe(true)
    expect(shouldLogContextPressure(previous, { projectedTokens: 10_511, contextWindow: 100_000 })).toBe(false)
  })

  it('lets the relative gate dominate on a large window', () => {
    const window = 512_000
    const gate = Math.round(window * CONTEXT_PRESSURE_MIN_DELTA_RATIO) // 1280
    const previous = { used: 200_000, window }
    expect(shouldLogContextPressure(previous, { projectedTokens: 200_000 + gate - 1, contextWindow: window })).toBe(false)
    expect(shouldLogContextPressure(previous, { projectedTokens: 200_000 + gate, contextWindow: window })).toBe(true)
  })

  it('logs when only the window changed (a different measurement, not a move)', () => {
    expect(shouldLogContextPressure({ used: 130_000, window: 512_000 }, { projectedTokens: 130_100, contextWindow: 400_000 })).toBe(true)
  })

  it('falls back to pressureTokens when projectedTokens is absent, and to 0 for nothing', () => {
    expect(pressureUsedTokens({ pressureTokens: 42 })).toBe(42)
    expect(pressureUsedTokens({ projectedTokens: 7, pressureTokens: 42 })).toBe(7)
    expect(pressureUsedTokens({})).toBe(0)
    // Empty reading vs a session that has never logged → first row wins.
    expect(shouldLogContextPressure({ used: 5_000, window: 0 }, {})).toBe(true)
  })

  it('collapses identical readings (the old signature-dedupe case)', () => {
    const previous = { used: 130_634, window: 512_000 }
    expect(shouldLogContextPressure(previous, { projectedTokens: 130_634, pressureTokens: 130_000, contextWindow: 512_000 })).toBe(false)
  })

  it('a bisected heavy-work sample keeps roughly one row per gate-width of movement', () => {
    // 40 steps of +200 tokens on a 512k window: the first reading anchors, then
    // only crossings of the 1280-token gate log (steps 8, 15, 22, 29, 36) — six
    // rows where the old behaviour wrote forty.
    const window = 512_000
    let previous: { used: number; window: number } | undefined
    let logged = 0
    for (let step = 1; step <= 40; step += 1) {
      const reading = { projectedTokens: 100_000 + step * 200, contextWindow: window }
      if (shouldLogContextPressure(previous, reading)) {
        logged += 1
        previous = { used: pressureUsedTokens(reading), window }
      }
    }
    expect(logged).toBe(6)
  })
})