/**
 * S(t) — the shared-memory decay score, borrowed from mon3stera's
 * dsh-magic-context `memory.js` and reshaped to this adapter's contracts.
 *
 *   S = clamp(0, 100, I · (1 + α·ln(1 + k)) · exp(−(ln2/τ_eff)·Δt))
 *   τ_eff = τ / (1 + β·k)
 *
 * I is the shared store's importance (1–100). Hits k SLOW the decay and boost
 * the score (LRU-style: used memories do not rot); τ is the category
 * half-life in days, null = immortal; a hit count of zero on a row we have no
 * sidecar stats for decays nothing (cold-start rows are favored, not
 * punished — the sidecar fills on the first recall anyway).
 *
 * Pure functions, no I/O and no MC import. The score gates ONLY the adapter's
 * injection ranking; it never writes the shared store (writer-contract
 * discipline): sub-threshold rows stop being injected here and stay fully
 * searchable — and a hit that lifts a row back over the threshold un-retires
 * it on the next recall.
 */

/** Adapter-side per-memory usage stats (the `memory_stats` sidecar row). */
export interface MemoryStatSummary {
  readonly hits: number
  readonly lastHitAt?: number
  readonly localArchived: boolean
}

export interface MemoryScoringConfig {
  /** Off (default): stats are collected but ranking stays MC's. */
  readonly enabled: boolean
  readonly alpha: number
  readonly beta: number
  /** Scores below this stop being injected (still searchable). */
  readonly archiveThreshold: number
  /** Category half-life in days; null = immortal. Unknown categories: immortal. */
  readonly halfLives: Readonly<Record<string, number | null>>
}

/**
 * Half-life defaults, mon3stera's spirit translated to MC's taxonomy: durable
 * categories are immortal; exact values and names rot; legacy categories take
 * the MC TTL where one exists (KNOWN_ISSUES/WORKFLOW_RULES) or a conservative
 * middle ground otherwise.
 */
export const DEFAULT_MEMORY_SCORING: MemoryScoringConfig = {
  enabled: false,
  alpha: 0.4,
  beta: 0.2,
  archiveThreshold: 2,
  halfLives: {
    PROJECT_RULES: null,
    ARCHITECTURE: null,
    CONSTRAINTS: null,
    CONFIG_VALUES: 60,
    NAMING: 90,
    USER_PREFERENCES: 14,
    WORKFLOW_RULES: 30,
    KNOWN_ISSUES: 30,
    ENVIRONMENT: 90,
  },
}

export function halfLifeFor(config: MemoryScoringConfig, category: string): number | null {
  const value = config.halfLives[category]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export interface ScoredMemoryInput {
  readonly importance: number
  readonly category: string
  readonly hits: number
  readonly lastHitAt?: number
}

/** One memory's current score, on the shared store's 1–100 scale (clamped). */
export function scoreMemory(memory: ScoredMemoryInput, config: MemoryScoringConfig, now: number): number {
  const importance = Number.isFinite(memory.importance) ? Math.max(0, memory.importance) : 0
  const hits = Number.isInteger(memory.hits) && memory.hits > 0 ? memory.hits : 0
  const boost = 1 + config.alpha * Math.log(1 + hits)
  const halfLifeDays = halfLifeFor(config, memory.category)
  let decay = 1
  if (halfLifeDays !== null && memory.lastHitAt !== undefined) {
    const tauEff = halfLifeDays / (1 + config.beta * hits)
    const dtDays = Math.max(0, (now - memory.lastHitAt) / 86_400_000)
    decay = Math.exp(-(Math.LN2 / tauEff) * dtDays)
  }
  return Math.min(100, Math.max(0, importance * boost * decay))
}

/** The per-recall scoring input the lane assembles (config + sidecar stats). */
export interface MemoryRecallScoring {
  readonly config: MemoryScoringConfig
  readonly statsById: ReadonlyMap<number, MemoryStatSummary>
}
