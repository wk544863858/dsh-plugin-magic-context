/**
 * 域命中与配额跳过的纯聚合（C-7 产品判据埋点，2026-10-10）。
 *
 * 背景：WP9 的产品判据是"上线 2 周内若无一条 org 记忆被 ≥2 个不同项目命中，
 * 判定需求不成立并停止投入"——但直到这次评估前没有任何聚合能回答这个问题
 * （数据其实一直在产生：memory-recall 载荷的 projects 数组含被注入行的
 * project_path，域身份行 dir:global:* 会出现在其中）。
 *
 * 本模块只做纯聚合，SQL 装载在 mc-report.mjs（沿用 readVectorLane 的直查先例），
 * 判据窗口固定 14 天，与产品判据对齐。
 */

/** 全局域身份行的 project_path 前缀（契约域身份，见 normalizeStoredProjectPath 规则）。 */
export const DOMAIN_ID_PREFIX = 'dir:global:'

/** 与产品判据对齐的观察窗口。 */
export const DOMAIN_HIT_WINDOW_DAYS = 14

/**
 * 从 memory-recall 事件中提取域命中。
 *
 * @param {Array<{at: number|string, sessionId?: string, data: unknown}>} recalls
 *   事件 data 需含 `identity`（读取方项目身份）与 `projects`（被注入行的
 *   project_path 列表，截断到 24 字符——`dir:global:org`(14)/`dir:global:machine`(18) 均安全）。
 * @returns {Array<{domainId: string, events: number, readers: string[], lastAt: number}>}
 *   按域聚合：命中事件数、去重读取方身份列表（产品判据的直接输入）、最近一次命中。
 */
export function extractDomainHits(recalls) {
  const byDomain = new Map()
  for (const row of recalls) {
    const data = (row && typeof row === 'object' && row.data && typeof row.data === 'object') ? row.data : {}
    const projects = Array.isArray(data.projects) ? data.projects : []
    const identity = typeof data.identity === 'string' ? data.identity : ''
    const at = Number(row.at) || 0
    const seen = new Set()
    for (const project of projects) {
      if (typeof project !== 'string' || !project.startsWith(DOMAIN_ID_PREFIX)) continue
      const domainId = project
      if (seen.has(domainId)) continue
      seen.add(domainId)
      const entry = byDomain.get(domainId) ?? { domainId, events: 0, readers: new Set(), lastAt: 0 }
      entry.events += 1
      // 域身份行自己不算读取方；只有别的项目注入了它才算一次命中。
      if (identity.length > 0 && identity !== domainId) entry.readers.add(identity)
      entry.lastAt = Math.max(entry.lastAt, at)
      byDomain.set(domainId, entry)
    }
  }
  return [...byDomain.values()]
    .map(entry => ({ domainId: entry.domainId, events: entry.events, readers: [...entry.readers].sort(), lastAt: entry.lastAt }))
    .sort((a, b) => b.events - a.events || a.domainId.localeCompare(b.domainId))
}

/**
 * 从 maintenance journal 行中提取配额跳过（route-health 车道的可见性）。
 *
 * @param {Array<{at: number|string, summary?: string, data?: unknown}>} rows
 *   kind='maintenance' 的行；跳过行由 summary 前缀识别，route 取自 data.route。
 * @returns {{count: number, lastAt: number, routes: string[]}}
 */
export function extractQuotaSkips(rows) {
  let count = 0
  let lastAt = 0
  const routes = new Set()
  for (const row of rows) {
    const summary = typeof row.summary === 'string' ? row.summary : ''
    if (!summary.startsWith('LLM steps skipped:')) continue
    count += 1
    lastAt = Math.max(lastAt, Number(row.at) || 0)
    const data = (row.data && typeof row.data === 'object') ? row.data : {}
    if (typeof data.route === 'string' && data.route.length > 0) routes.add(data.route)
  }
  return { count, lastAt, routes: [...routes].sort() }
}

/**
 * 报告行（两行，None 时省略由调用方决定）。
 * @returns {string}
 */
export function formatDomainHitLine(hits, { now } = { now: Date.now() }) {
  if (hits.length === 0) return '0（没有任何域身份行被注入——若域已启用，这就是产品判据的"未命中"证据）'
  return hits.map(hit => {
    const ageDays = now && hit.lastAt ? `${((now - hit.lastAt) / 86_400_000).toFixed(1)}d 前` : '未知时间'
    return `${hit.domainId}: ${hit.events} 次注入 / ${hit.readers.length} 个读取项目（最近 ${ageDays}）`
  }).join('；')
}
