/**
 * When a context-pressure reading is worth a journal row.
 *
 * The host's `contextPressure` projection changes on nearly every step, and the
 * listener used to journal every distinct reading: measured at ~10 rows/minute
 * during heavy work (2,516 rows on 2026-10-07, 413 rows in 44 minutes on
 * 2026-10-08). The gauge only needs a reading that is genuinely new, so a
 * reading is logged when it is at least {@link CONTEXT_PRESSURE_MIN_DELTA_TOKENS}
 * or {@link CONTEXT_PRESSURE_MIN_DELTA_RATIO} of the window away from the last
 * LOGGED one — plus whenever the window itself changes, and always for the
 * first reading of a session.
 *
 * The panel reads the newest row, so the visible cost is a gauge that may lag
 * by up to that threshold (≤0.25% of the window); the benefit is a journal
 * whose pressure history is readable instead of a wall of near-identical rows.
 */

/** One host reading of the occupancy projection. */
export interface ContextPressureReading {
  readonly projectedTokens?: number
  readonly pressureTokens?: number
  readonly contextWindow?: number
}

/** The reading this module last decided to journal for a session. */
export interface LoggedPressureReading {
  readonly used: number
  readonly window: number
}

/** Absolute floor: below this, a change is noise regardless of window size. */
export const CONTEXT_PRESSURE_MIN_DELTA_TOKENS = 512
/** Relative gate: keeps the threshold meaningful on very large windows. */
export const CONTEXT_PRESSURE_MIN_DELTA_RATIO = 0.0025

/** The tokens the gauge would show: the projection's own preference order. */
export function pressureUsedTokens(reading: ContextPressureReading): number {
  return reading.projectedTokens ?? reading.pressureTokens ?? 0
}

export function shouldLogContextPressure(
  previous: LoggedPressureReading | undefined,
  reading: ContextPressureReading,
): boolean {
  const used = pressureUsedTokens(reading)
  const window = reading.contextWindow ?? 0
  // The first reading of a session is always worth a row (it anchors the gauge).
  if (previous === undefined) return true
  // A changed window is a different measurement, not a small movement.
  if (window !== previous.window) return true
  const delta = Math.abs(used - previous.used)
  return delta >= Math.max(CONTEXT_PRESSURE_MIN_DELTA_TOKENS, Math.round(window * CONTEXT_PRESSURE_MIN_DELTA_RATIO))
}