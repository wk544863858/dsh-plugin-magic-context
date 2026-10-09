/**
 * The historian failure classifier (scripts/report-classify.mjs).
 *
 * Why this file exists, and why its fixtures are copied verbatim out of the live
 * journal: the report used to print one number, "historian 失败率 53.4%", for a
 * window whose 47 failures were 553 remounts (already excluded), 29 truncated
 * digests, 9 timeouts, 6 malformed outputs and 3 account-quota rejections. The
 * arithmetic was right and the sentence was wrong — it reads as "the historian
 * is broken" when the pipeline worked and the account was out of budget. A
 * health signal nobody can act on gets ignored, which is worse than no signal.
 *
 * The first version of the classifier had exactly that defect in miniature: it
 * labelled `/stream-error/` as network trouble, and re-reading the live corpus
 * showed all 29 "network" failures were "truncated at the token cap" — a
 * capacity problem wearing a transport label. The test below holds that line
 * (see "does not call a token-cap truncation a network problem").
 */
import { describe, expect, it } from 'vitest'
import {
  CAUSE_ORDER,
  classifyHistorianFailure,
  describeCauses,
  extractQuotaReset,
  splitByClass,
} from '../scripts/report-classify.mjs'

/** (kind, reason) pairs copied verbatim from the adapter journal, 2026-10-06..09. */
const LIVE_CORPUS = [
  {
    label: 'quota exhausted (the account is out of budget, not broken)',
    kind: 'stream-error',
    reason:
      'historian call failed: 429 {"error":{"type":"1310","message":"[1310][已达到 7 天使用上限，'
      + '2026-10-12 23:46:18 后可继续使用。如需超限额按量付费使用，可联系管理员开启超额按量付费。]'
      + '][20261009222854',
    cause: 'environment:quota',
  },
  {
    label: 'token-cap truncation (capacity, and retrying cannot help)',
    kind: 'stream-error',
    reason: 'historian call truncated at the token cap (incomplete digest)',
    cause: 'pipeline:truncated',
  },
  {
    label: 'request rejected by the provider (deterministic shape bug)',
    kind: 'stream-error',
    reason:
      'historian call failed: 400 {"error":{"type":"invalid_request_error","message":'
      + '"unexpected `***.***.content.0: tool_use_i',
    cause: 'pipeline:request-shape',
  },
  {
    label: 'provider overloaded',
    kind: 'stream-error',
    reason:
      'historian call failed: 503 {"error":{"type":"new_api_error","message":'
      + '"system cpu overloaded (current: 98.7%, threshold:',
    cause: 'environment:provider',
  },
  {
    label: 'transport died',
    kind: 'stream-error',
    reason: 'historian call failed: Connection error.',
    cause: 'environment:network',
  },
  {
    label: 'stream terminated',
    kind: 'stream-error',
    reason: 'historian call failed: terminated',
    cause: 'environment:network',
  },
  {
    label: 'call ran out of time',
    kind: 'timeout',
    reason: 'historian call timed out after 59997ms',
    cause: 'environment:timeout',
  },
  {
    label: 'model emitted broken JSON',
    kind: 'invalid-output',
    reason:
      "magic-context historian output rejected: invalid JSON (Expected ':' after property name "
      + 'in JSON at position 3273 (line 1 column 3274))',
    cause: 'pipeline:output',
  },
  {
    label: 'model emitted the wrong shape',
    kind: 'invalid-output',
    reason: 'magic-context historian output rejected: summary must be an object with p1..p4',
    cause: 'pipeline:output',
  },
  {
    label: 'adapter remounted mid-run (benign, and already excluded from the rate)',
    kind: 'adapter-remount',
    reason: 'the adapter remounted (hmr or restart) while the run was in flight',
    cause: 'other:adapter-remount',
  },
]

describe('classifyHistorianFailure — the live corpus', () => {
  for (const entry of LIVE_CORPUS) {
    it(`classifies ${entry.label}`, () => {
      expect(classifyHistorianFailure(entry.kind, entry.reason)).toBe(entry.cause)
    })
  }

  it('does not call a token-cap truncation a network problem', () => {
    // The regression this test was written for: `stream-error` is the KIND of
    // transport, not the CAUSE of failure, and matching it as network trouble
    // hid the largest real failure class behind a label nobody would act on.
    const cause = classifyHistorianFailure(
      'stream-error',
      'historian call truncated at the token cap (incomplete digest)',
    )
    expect(cause).toBe('pipeline:truncated')
    expect(cause).not.toBe('environment:network')
  })

  it('lets quota win over the transport kind that carried it', () => {
    // A 429 arrives as `stream-error`; reporting that as network trouble sends
    // someone hunting a broken socket while memory ingestion is simply paused.
    expect(
      classifyHistorianFailure('stream-error', 'historian call failed: 429 rate limit reached'),
    ).toBe('environment:quota')
  })

  it('keeps an unknown kind visible instead of burying it in "other"', () => {
    expect(classifyHistorianFailure('some-new-kind', 'nothing matches')).toBe('other:some-new-kind')
    expect(classifyHistorianFailure('', '')).toBe('other:unknown')
  })

  it('classifies every entry of the live corpus into a named class', () => {
    const unclassified = LIVE_CORPUS.filter(entry =>
      classifyHistorianFailure(entry.kind, entry.reason).startsWith('other:')
      && entry.kind !== 'adapter-remount')
    expect(unclassified.map(entry => entry.label)).toEqual([])
  })
})

describe('extractQuotaReset', () => {
  it('pulls the provider-stated reset time, which is the most actionable fact in the failure', () => {
    const reason =
      'historian call failed: 429 {"error":{"type":"1310","message":"[1310][已达到 7 天使用上限，'
      + '2026-10-12 23:46:18 后可继续使用。]'
    expect(extractQuotaReset(reason)).toBe('2026-10-12 23:46:18')
  })

  it('normalizes an ISO-T separator', () => {
    expect(extractQuotaReset('out of budget until 2026-10-12T23:46:18')).toBe('2026-10-12 23:46:18')
  })

  it('returns null when the message states no time, and for non-strings', () => {
    expect(extractQuotaReset('historian call timed out after 59997ms')).toBeNull()
    expect(extractQuotaReset(undefined)).toBeNull()
    expect(extractQuotaReset(null)).toBeNull()
  })
})

describe('describeCauses / splitByClass', () => {
  it('groups by class, fixable first, and orders within a group by action', () => {
    expect(describeCauses({
      'environment:timeout': 9,
      'pipeline:output': 6,
      'environment:quota': 3,
      'pipeline:truncated': 29,
    })).toBe('管道（截断 29 · 输出非法 6） · 环境（配额 3 · 超时 9）')
  })

  it('keeps an unclassified kind visible under 其他 rather than dropping it', () => {
    expect(describeCauses({ 'other:stream-error': 2, 'pipeline:output': 6 }))
      .toBe('管道（输出非法 6） · 其他（stream-error 2）')
  })

  it('returns empty for no data', () => {
    expect(describeCauses({})).toBe('')
    expect(describeCauses(undefined)).toBe('')
  })

  it('appends when a cause last fired, so a stale burst cannot pass as a live fault', () => {
    // All 23 truncations sat inside one three-minute burst on 10-06 and none
    // recurred; without the date the count alone reads as the biggest live problem.
    const lastAt = new Date(2026, 9, 6, 17, 52).getTime()
    expect(describeCauses({ 'pipeline:truncated': 23 }, { 'pipeline:truncated': { lastAt } }))
      .toBe('管道（截断 23（至 10-06））')
  })

  it('omits the date when last-seen data is missing or unparsable', () => {
    expect(describeCauses({ 'pipeline:truncated': 23 }, {})).toBe('管道（截断 23）')
    expect(describeCauses({ 'pipeline:truncated': 23 }, { 'pipeline:truncated': { lastAt: Number.NaN } }))
      .toBe('管道（截断 23）')
  })

  it('covers every cause in CAUSE_ORDER with a distinct rank', () => {
    expect(new Set(CAUSE_ORDER).size).toBe(CAUSE_ORDER.length)
    expect(CAUSE_ORDER.length).toBeGreaterThan(0)
  })

  it('splits "needs a fix" from "wait it out" — the distinction the old report lost', () => {
    expect(splitByClass({
      'pipeline:truncated': 29,
      'pipeline:output': 6,
      'environment:quota': 3,
      'environment:timeout': 9,
      'other:adapter-remount': 553,
    })).toEqual({ pipeline: 35, environment: 12, other: 553 })
  })

  it('treats missing or junk counts as zero rather than NaN', () => {
    expect(splitByClass({})).toEqual({ pipeline: 0, environment: 0, other: 0 })
    expect(splitByClass({ 'pipeline:output': null })).toEqual({ pipeline: 0, environment: 0, other: 0 })
  })
})
