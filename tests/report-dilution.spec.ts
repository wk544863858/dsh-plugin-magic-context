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
  retiredSummary,
} from '../scripts/report-dilution.mjs'
import { classifyDeparted, sweepScores, sweepSummary } from '../scripts/score-diff.mjs'
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
  ]

  it('counts active rows, ever/recent injections, top-N concentration', () => {
    const d = dilutionSummary(rows, { now: NOW, topN: 2 })
    expect(d.rows).toBe(3)
    expect(d.injectedEver).toBe(2)
    expect(d.injectedRecent).toBe(1)
    expect(d.totalInjections).toBe(150)
    expect(d.topSharePct).toBe(100)                           // (100+50)/150：前三名拿走全部
  })

  it('n/a concentration when nothing was ever injected', () => {
    const d = dilutionSummary([rows[2]], { now: NOW })
    expect(d.topSharePct).toBeNull()
  })
})

describe('retiredSummary — 与 recall pick() 同一公式的现场计算', () => {
  const config = { ...DEFAULT_MEMORY_SCORING, enabled: true }

  it('retires decayed and localArchived rows, keeps immortal unhit rules in the pool', () => {
    const statsById = new Map([
      [1, { hits: 0, lastHitAt: NOW - 200 * DAY, localArchived: false }],  // USER_PREFERENCES 14d 半衰 → 衰减退役
      [2, { hits: 0, localArchived: true }],                               // 手动退役钩子
    ])
    const pool = [
      { id: 1, category: 'USER_PREFERENCES', importance: 50 },
      { id: 2, category: 'PROJECT_RULES', importance: 80 },
      { id: 3, category: 'PROJECT_RULES', importance: 80 },                 // 永生类别且无衰减 → 在池
    ]
    const r = retiredSummary(pool, statsById, { config, now: NOW })
    expect(r).toEqual({ pool: 3, retired: 2 })
  })

  it('empty pool and missing stats degrade to zero retirement over the pool size', () => {
    expect(retiredSummary([], new Map(), { config, now: NOW })).toEqual({ pool: 0, retired: 0 })
    expect(retiredSummary([{ id: 9, category: 'ARCHITECTURE', importance: 70 }], new Map(), { config, now: NOW }))
      .toEqual({ pool: 1, retired: 0 })
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
      retiredSummary([{ id: 1, category: 'USER_PREFERENCES', importance: 50 }],
        new Map([[1, { hits: 0, lastHitAt: NOW - 200 * DAY, localArchived: false }]]),
        { config: { ...DEFAULT_MEMORY_SCORING, enabled: true }, now: NOW }),
      { rows: 0, expired: 0 },
    )
    expect(d).toContain('top40 集中度 n/a')
    expect(d).toContain('S(t) 退役 1/1')
    expect(d).toContain('TTL 行 0（到期 0')
    expect(d).toContain('新行进入率 0%（0/2）')
  })
})

describe('sweepScores / sweepSummary —— 阈值扫描的群体与计数', () => {
  const config = { ...DEFAULT_MEMORY_SCORING, enabled: true }
  const pool = [
    { id: 1, category: 'PROJECT_RULES', importance: 50 },     // 永生未用：score 冻结在 50
    { id: 2, category: 'CONFIG_VALUES', importance: 50 },     // 会衰减未用（无 stats ⇒ 冷启动不衰减，同样冻结 50）
    { id: 3, category: 'CONFIG_VALUES', importance: 90 },     // 会衰减在用，200d 未再命中 ⇒ 深度衰减
  ]
  const statsById = new Map([
    [3, { hits: 2, lastHitAt: NOW - 200 * DAY, localArchived: false }],
  ])
  const scored = sweepScores(pool, statsById, config, NOW)

  it('classifies decayable cohorts and freezes cold rows at importance', () => {
    const cold = scored.find(row => row.id === 2)
    const immortal = scored.find(row => row.id === 1)
    const decayed = scored.find(row => row.id === 3)
    expect(cold?.decayable).toBe(true)
    expect(cold?.score).toBe(50)
    expect(immortal?.decayable).toBe(false)
    expect(immortal?.score).toBe(50)
    expect(decayed?.score).toBeLessThan(50)
  })

  it('counts retirement per threshold and splits cohorts', () => {
    const summary = sweepSummary(scored, [2, 50, 70])
    const at50 = summary.byThreshold.find(row => row.threshold === 50)
    expect(at50?.retired).toBe(1)                                  // 只有衰减行 < 50
    expect(at50?.retiredDecayableUnused).toBe(0)                   // 冷冻行不在 50 以下退役
    expect(at50?.retiredImmortalUsed).toBe(0)
    const at70 = summary.byThreshold.find(row => row.threshold === 70)
    expect(at70?.retired).toBe(3)
    expect(summary.distribution['immortal-unused'].n).toBe(1)
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
