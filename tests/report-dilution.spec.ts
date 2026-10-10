/**
 * 稀释与 fold 仪表的纯聚合用例 + score-diff 离场分类用例。
 */
import { describe, expect, it } from 'vitest'
import {
  BASELINE_WINDOW_DAYS,
  DILUTION_RECENT_MS,
  baselineEventSummary,
  dilutionSummary,
  entryRate,
  formatDilutionLine,
  formatFoldLine,
  pendingFoldCounts,
} from '../scripts/report-dilution.mjs'
import { classifyDeparted } from '../scripts/score-diff.mjs'
import { DEFAULT_MEMORY_SCORING, scoreMemory } from '../src/core/memory-scoring.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

describe('baselineEventSummary', () => {
  it('aggregates hard/soft counts, recency, and average interval', () => {
    const s = baselineEventSummary(
      [
        { at: NOW - 3 * DAY, data: { mode: 'hard' } },
        { at: NOW - 1 * DAY, data: { mode: 'soft' } },
        { at: NOW - 2 * DAY, data: { mode: 'hard' } },
      ],
      { now: NOW },
    )
    expect(s.count).toBe(3)
    expect(s.hard).toBe(2)
    expect(s.soft).toBe(1)
    expect(s.sinceLastMs).toBe(DAY)
    expect(s.avgIntervalMs).toBe(DAY)
    expect(s.lastMode).toBe('soft')
  })

  it('returns an explicit empty state and tolerates broken payloads', () => {
    const empty = baselineEventSummary([], { now: NOW })
    expect(empty.sinceLastMs).toBeNull()
    const noisy = baselineEventSummary(
      [{ at: 'x', data: null }, { at: NOW - 1000, data: 'not-an-object' }],
      { now: NOW },
    )
    expect(noisy.count).toBe(1)
    expect(noisy.lastMode).toBeNull()
  })
})

describe('pendingFoldCounts', () => {
  it('computes non-negative gaps and never guesses on missing sides', () => {
    const p = pendingFoldCounts({
      contractMaxMemoryId: 1371, stateMaxMemoryId: 1360,
      contractMaxProfileId: 20, stateProfileWatermark: 25,   // 水位领先（升级折叠）→ 0，不是负数
      contractMaxMutationId: undefined, stateMaxMutationId: 99,
    })
    expect(p.memories).toBe(11)
    expect(p.profile).toBe(0)
    expect(p.mutations).toBeUndefined()
  })
})

describe('dilutionSummary', () => {
  const rows = [
    { memory_id: 1, hits: 10, injections: 100, last_injected_at: NOW - 1000, local_archived: 0, updated_at: NOW - 1000 },
    { memory_id: 2, hits: 0, injections: 50, last_injected_at: NOW - 40 * DAY, local_archived: 0, updated_at: NOW - DAY },
    { memory_id: 3, hits: 0, injections: 0, last_injected_at: null, local_archived: 0, updated_at: NOW - DAY },
    { memory_id: 4, hits: 0, injections: 5, last_injected_at: NOW - 1000, local_archived: 1, updated_at: NOW - 2 * DAY },
  ]

  it('counts active rows, ever/recent injections, top-N concentration, archive liveness', () => {
    const d = dilutionSummary(rows, { now: NOW, topN: 2 })
    expect(d.rows).toBe(3)                                   // archived row excluded from the pool view
    expect(d.injectedEver).toBe(2)
    expect(d.injectedRecent).toBe(1)
    expect(d.totalInjections).toBe(150)
    expect(d.topSharePct).toBe(100)                           // (100+50)/150：前三名拿走全部
    expect(d.archived).toBe(1)
    expect(d.archivedRecent).toBe(1)
  })

  it('n/a concentration when nothing was ever injected', () => {
    const d = dilutionSummary([rows[2]], { now: NOW })
    expect(d.topSharePct).toBeNull()
  })
})

describe('entryRate', () => {
  it('answers the dilution question directly: of new rows, how many ever entered the baseline', () => {
    const stats = [
      { memory_id: 1, injections: 3 },
      { memory_id: 2, injections: 0 },
    ]
    expect(entryRate(stats, [1, 2, 3])).toEqual({ created: 3, entered: 1, ratePct: 33 })
    expect(entryRate(stats, [])).toEqual({ created: 0, entered: 0, ratePct: null })
  })
})

describe('format lines', () => {
  it('render fold and dilution lines without guessing on missing gaps', () => {
    const fold = formatFoldLine(
      baselineEventSummary([{ at: NOW - 2 * 3_600_000, data: { mode: 'hard' } }], { now: NOW }),
      { memories: 11, profile: undefined, mutations: 2 },
    )
    expect(fold).toContain('hard 1 / soft 0')
    expect(fold).toContain('2h 前（hard）')
    expect(fold).toContain('memories 11')
    expect(fold).toContain('mutations 2')
    expect(fold).not.toContain('profile')

    const d = formatDilutionLine(
      dilutionSummary([], { now: NOW }),
      entryRate([], [1, 2]),
    )
    expect(d).toContain('top40 集中度 n/a')
    expect(d).toContain('新行进入率 0%（0/2）')
  })
})

describe('classifyDeparted (score-diff)', () => {
  it('separates threshold-retired rows from budget-displaced rows using the real scoring fn', () => {
    const config = { ...DEFAULT_MEMORY_SCORING, enabled: true }
    const statsById = new Map([
      // USER_PREFERENCES, half-life 14d, never hit again for 200 days → decayed below 2 → retired
      [1, { hits: 0, lastHitAt: NOW - 200 * DAY, localArchived: false }],
      // already archived locally → retired regardless of score
      [2, { hits: 0, localArchived: true }],
    ])
    const departed = classifyDeparted(
      [
        { id: 1, category: 'USER_PREFERENCES', importance: 50 },
        { id: 2, category: 'PROJECT_RULES', importance: 80 },
        { id: 3, category: 'PROJECT_RULES', importance: 80 },  // no stats, immortal category → displaced
      ],
      statsById,
      config,
      NOW,
    )
    expect(departed.find(r => r.id === 1)?.retired).toBe(true)
    expect(departed.find(r => r.id === 2)?.retired).toBe(true)
    expect(departed.find(r => r.id === 3)?.retired).toBe(false)
    // sanity: the classifier agrees with scoreMemory on the boundary
    expect(scoreMemory({ importance: 50, category: 'USER_PREFERENCES', hits: 0, lastHitAt: NOW - 200 * DAY }, config, NOW)).toBeLessThan(config.archiveThreshold)
  })

  it('exports the criterion-aligned window constant', () => {
    expect(BASELINE_WINDOW_DAYS).toBe(14)
    expect(DILUTION_RECENT_MS).toBe(30 * DAY)
  })
})
