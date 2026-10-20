/**
 * 稀释与 fold 仪表的纯聚合（2026-10-10，架构挑战报告风险 1/2 的"先可测"落地）。
 *
 * 两个风险（docs/memory-architecture-challenge-2026-10-10.md §C3/C5）：
 * ① 稀释——固定 8000 tok / 40 行窗口下，库增长劣化的是选择质量不是上下文大小；
 * ② fold 峰值——m[1] 有 25% 硬顶，真正的问题是"截断丢信息 + fold 不及时"
 *    （实测不存在：刷新 382 次/14d，泄压阀按 YAGNI 不做）。
 *
 * 退役口径（2026-10-10 TTL 排查定案）：契约 TTL 阀门工作正常但进料为零——
 * CATEGORY_DEFAULT_TTL 只管 WORKFLOW_RULES/KNOWN_ISSUES 两个 legacy 类别，
 * 实测库中这两个类别为 0，所以 expired 恒 0 是数据现实不是缺陷。
 * sidecar 的 local_archived 从出生起就没有写者（setter 已删）——真正的退役
 * 机制是 S(t) 在 recall 现场计算（score < archiveThreshold 即不注入），
 * 仪表按同一公式现场重算，单一事实来源。
 *
 * 本模块只做纯聚合；SQL 装载在 mc-report.mjs（tolerant，契约库缺席时降级）。
 */

import { DEFAULT_MEMORY_SCORING, scoreMemory } from '../src/core/memory-scoring.ts'

/** 稀释指标的新近窗口：30 天。 */
export const DILUTION_RECENT_MS = 30 * 86_400_000

/** fold 事件的观察窗口：14 天（与域命中窗口一致）。 */
export const BASELINE_WINDOW_DAYS = 14

/**
 * 基线（fold/refresh）事件聚合。
 *
 * @param {Array<{at: number|string, data: unknown}>} events kind='baseline' 的 journal 行
 *   （data.mode: 'hard' | 'soft'）。
 * @returns 最近一次、距今年龄、hard/soft 计数、平均间隔。
 */
export function baselineEventSummary(events, { now }) {
  const parsed = events
    .map(event => {
      const data = (event && typeof event === 'object' && event.data && typeof event.data === 'object') ? event.data : {}
      const mode = data.mode === 'hard' || data.mode === 'soft' ? data.mode : null
      return { at: Number(event.at) || 0, mode }
    })
    .filter(event => event.at > 0)
    .sort((left, right) => left.at - right.at)
  if (parsed.length === 0) {
    return { count: 0, hard: 0, soft: 0, lastAt: 0, lastMode: null, sinceLastMs: null, avgIntervalMs: null }
  }
  let hard = 0
  let soft = 0
  for (const event of parsed) {
    if (event.mode === 'hard') hard += 1
    else if (event.mode === 'soft') soft += 1
  }
  const last = parsed[parsed.length - 1]
  const intervals = []
  for (let i = 1; i < parsed.length; i += 1) intervals.push(parsed[i].at - parsed[i - 1].at)
  return {
    count: parsed.length,
    hard,
    soft,
    lastAt: last.at,
    lastMode: last.mode,
    sinceLastMs: now - last.at,
    avgIntervalMs: intervals.length > 0 ? Math.round(intervals.reduce((sum, v) => sum + v, 0) / intervals.length) : null,
  }
}

/**
 * 未折叠增量（契约库 max id − baseline_state 水位）。每一项独立容错：
 * 任一侧缺失返回 undefined，不猜 0。
 */
export function pendingFoldCounts({
  contractMaxMemoryId, stateMaxMemoryId,
  contractMaxProfileId, stateProfileWatermark,
  contractMaxMutationId, stateMaxMutationId,
}) {
  const gap = (top, bottom) => (Number.isFinite(top) && Number.isFinite(bottom) ? Math.max(0, top - bottom) : undefined)
  return {
    memories: gap(contractMaxMemoryId, stateMaxMemoryId),
    profile: gap(contractMaxProfileId, stateProfileWatermark),
    mutations: gap(contractMaxMutationId, stateMaxMutationId),
  }
}

/**
 * 稀释核心指标（来自 memory_stats sidecar，不碰契约库）。
 *
 * @param {Array<{memory_id: number, hits: number, injections: number, last_injected_at: number|null, local_archived: 0|1, updated_at: number}>} statRows
 */
export function dilutionSummary(statRows, { now, recentMs = DILUTION_RECENT_MS, topN = 40 }) {
  const rows = statRows.filter(row => Number(row.memory_id) > 0 && Number(row.local_archived) !== 1)
  let injectedEver = 0
  let injectedRecent = 0
  let totalInjections = 0
  for (const row of rows) {
    const injections = Number(row.injections) || 0
    if (injections > 0) injectedEver += 1
    totalInjections += injections
    if (Number.isFinite(row.last_injected_at) && now - Number(row.last_injected_at) < recentMs) injectedRecent += 1
  }
  const byInjections = [...rows].sort((left, right) => (Number(right.injections) || 0) - (Number(left.injections) || 0))
  const topRows = byInjections.slice(0, topN)
  const topInjections = topRows.reduce((sum, row) => sum + (Number(row.injections) || 0), 0)
  return {
    rows: rows.length,
    injectedEver,
    injectedRecent,
    totalInjections,
    topSharePct: totalInjections > 0 ? Math.round((topInjections / totalInjections) * 100) : null,
  }
}

/**
 * S(t) 退役的现场计算（与 memory-bridge pick() 同一公式、同一 sidecar 数据：
 * localArchived 或 score < archiveThreshold 的行不再注入、仍可检索）。
 *
 * @param {Array<{id: number, category: string, importance: number|null}>} poolRows 契约库活跃池
 * @param {Map<number, {hits: number, lastHitAt?: number, localArchived: boolean}>} statsById
 */
export function retiredSummary(poolRows, statsById, { config = DEFAULT_MEMORY_SCORING, now } = {}) {
  let retired = 0
  for (const row of poolRows) {
    const stat = statsById.get(Number(row.id))
    const score = scoreMemory(
      {
        importance: Number(row.importance),
        category: String(row.category),
        hits: stat?.hits ?? 0,
        ...(stat?.lastHitAt === undefined ? {} : { lastHitAt: stat.lastHitAt }),
      },
      config,
      now,
    )
    if (stat?.localArchived === true || score < config.archiveThreshold) retired += 1
  }
  return { pool: poolRows.length, retired }
}

/**
 * 新行进入率：近 N 天创建的行中，有多少至少进过一次基线。
 *
 * @param {Array<{memory_id: number, injections: number}>} statRows
 * @param {number[]} recentCreatedIds 契约库 created_at > 阈值的行 id
 */
export function entryRate(statRows, recentCreatedIds) {
  if (!Array.isArray(recentCreatedIds) || recentCreatedIds.length === 0) {
    return { created: 0, entered: 0, ratePct: null }
  }
  const injected = new Set(statRows.filter(row => (Number(row.injections) || 0) > 0).map(row => Number(row.memory_id)))
  const entered = recentCreatedIds.filter(id => injected.has(Number(id))).length
  return { created: recentCreatedIds.length, entered, ratePct: Math.round((entered / recentCreatedIds.length) * 100) }
}

function fmtDurationShort(ms) {
  const minutes = Math.round(ms / 60_000)
  return minutes < 120 ? `${String(minutes)}m` : `${String(Math.round(minutes / 60))}h`
}

/** 报告行（标签由调用方统一）。 */
export function formatFoldLine(summary, pending) {
  const since = summary.sinceLastMs === null ? '无事件（14d 内没有任何基线刷新）' : `${fmtDurationShort(summary.sinceLastMs)} 前`
  const mode = summary.lastMode === null ? '' : `（${summary.lastMode}）`
  const parts = [
    `14d ${summary.count} 次（hard ${summary.hard} / soft ${summary.soft}）；最近 ${since}${mode}`,
  ]
  if (summary.avgIntervalMs !== null) parts.push(`平均间隔 ${fmtDurationShort(summary.avgIntervalMs)}`)
  const pend = []
  if (pending.memories !== undefined) pend.push(`memories ${pending.memories}`)
  if (pending.profile !== undefined) pend.push(`profile ${pending.profile}`)
  if (pending.mutations !== undefined) pend.push(`mutations ${pending.mutations}`)
  if (pend.length > 0) parts.push(`未折叠增量 ${pend.join(' / ')}`)
  return parts.join('；')
}

export function formatDilutionLine(dilution, entry, retired, ttl) {
  const parts = [
    `注入在册 ${dilution.rows} 行（注入过 ${dilution.injectedEver} / 近30d ${dilution.injectedRecent}）`,
    dilution.topSharePct === null ? 'top40 集中度 n/a' : `top40 集中度 ${dilution.topSharePct}%`,
  ]
  if (retired.pool > 0) parts.push(`S(t) 退役 ${retired.retired}/${retired.pool}（现场计算，仍可检索）`)
  if (ttl !== undefined) parts.push(`TTL 行 ${ttl.rows}（到期 ${ttl.expired}；只管 WORKFLOW_RULES/KNOWN_ISSUES 两类）`)
  if (entry.ratePct !== null) parts.push(`近30d 新行进入率 ${entry.ratePct}%（${entry.entered}/${entry.created}）`)
  return parts.join('；')
}
