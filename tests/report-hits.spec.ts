/**
 * 域命中与配额跳过的纯聚合用例（C-7 产品判据埋点）。
 *
 * 语料形状取自真库 memory-recall 载荷（projects 是被注入行 project_path 的去重
 * 列表，截断到 24 字符——`dir:global:org` 14 字符、`dir:global:machine` 18 字符，
 * 均不会被截断）与 route-health 跳过行的 summary 前缀。
 */
import { describe, expect, it } from 'vitest'
import {
  DOMAIN_HIT_WINDOW_DAYS,
  extractDomainHits,
  extractQuotaSkips,
  formatDomainHitLine,
} from '../scripts/report-hits.mjs'

const ORG = 'dir:global:org'
const MACHINE = 'dir:global:machine'

function recall(identity, projects, at = 1_000) {
  return { at, sessionId: 's1', data: { identity, projects, rows: projects.length } }
}

describe('extractDomainHits', () => {
  it('aggregates events and distinct non-self readers per domain — the WP9 criterion input', () => {
    const hits = extractDomainHits([
      recall('git:aaa', [ORG, 'git:bbb']),
      recall('git:bbb', [ORG]),        // second distinct reader of org rows
      recall('git:aaa', [ORG]),        // same reader again: events count, readers do not
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0].domainId).toBe(ORG)
    expect(hits[0].events).toBe(3)
    expect(hits[0].readers).toEqual(['git:aaa', 'git:bbb'])
  })

  it('keeps domains separate and ignores plain project rows and self-injection', () => {
    const hits = extractDomainHits([
      recall('git:aaa', ['git:bbb', 'git:ccc']),          // no domain rows at all
      recall(ORG, [ORG]),                                  // the domain identity itself: not a reader
      recall('git:aaa', [MACHINE]),
    ])
    expect(hits.map(h => h.domainId)).toEqual([MACHINE, ORG].sort())
    expect(hits.find(h => h.domainId === ORG)?.readers).toEqual([])
    expect(hits.find(h => h.domainId === MACHINE)?.readers).toEqual(['git:aaa'])
  })

  it('deduplicates a domain listed once per event and tolerates broken payloads', () => {
    const hits = extractDomainHits([
      recall('git:aaa', [ORG, ORG]),
      { at: 'x', data: null },
      { at: 2, data: 'not-an-object' },
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0].events).toBe(1)
  })

  it('tracks the latest hit timestamp', () => {
    const hits = extractDomainHits([recall('git:aaa', [ORG], 100), recall('git:bbb', [ORG], 900)])
    expect(hits[0].lastAt).toBe(900)
  })
})

describe('extractQuotaSkips', () => {
  it('counts only skip rows and collects distinct routes', () => {
    const skips = extractQuotaSkips([
      { at: 100, summary: 'LLM steps skipped: p/m observed quota-exhausted 5m ago (hold 45m)', data: { route: 'p/m' } },
      { at: 300, summary: 'LLM steps skipped: p/m observed quota-exhausted 40m ago (hold 45m)', data: { route: 'p/m' } },
      { at: 200, summary: 'verify ran', data: { route: 'p/m' } },
      { at: 400, summary: 'LLM steps skipped: q/n observed quota-exhausted 1m ago (hold 45m)', data: {} },
    ])
    expect(skips.count).toBe(3)
    expect(skips.lastAt).toBe(400)
    expect(skips.routes).toEqual(['p/m'])
  })

  it('returns zero state on empty input', () => {
    expect(extractQuotaSkips([])).toEqual({ count: 0, lastAt: 0, routes: [] })
  })
})

describe('formatDomainHitLine', () => {
  it('states the zero-hit case as criterion evidence, not silence', () => {
    const line = formatDomainHitLine([], { now: 1_000 })
    expect(line).toContain('0')
    expect(line).toContain('未命中')
  })

  it('renders per-domain counts with reader counts', () => {
    const line = formatDomainHitLine(
      [{ domainId: ORG, events: 3, readers: ['git:aaa', 'git:bbb'], lastAt: 500 }],
      { now: 500 + 86_400_000 },
    )
    expect(line).toContain(ORG)
    expect(line).toContain('3 次注入')
    expect(line).toContain('2 个读取项目')
    expect(line).toContain('1.0d 前')
  })

  it('exports the criterion-aligned window', () => {
    expect(DOMAIN_HIT_WINDOW_DAYS).toBe(14)
  })
})
