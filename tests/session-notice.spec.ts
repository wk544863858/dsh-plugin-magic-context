/**
 * Session-notice (Channel A of the live session stream) — contract tests.
 *
 * The transcript renders every `user/message` whose `source.kind` is a
 * producer name as an injection row, and `form: 'notice'` as a collapsed
 * notice row whose one-line `summary` is readable without expanding (chat
 * `contextProducer` / `contextBody` case 'notice'; the host's own
 * `boundContextSummary` bounds that summary at 120 chars). plan-mode's mode
 * notifications are the in-tree precedent.
 *
 * These tests pin what the adapter appends after an action-bearing management
 * pass: only notable outcomes produce an entry; the summary carries the
 * discrete actions (publish / force-drop / promotion) with the net reclaim;
 * the appended event is a user-role notice with `surfaceOp: 'append'`; and a
 * hostile session object can never wedge the turn (fail-open).
 */
import { describe, expect, it } from 'vitest'
import {
  appendSessionNotice,
  sessionNoticeSummary,
  NOTICE_SUMMARY_MAX_CHARS,
  type SessionNoticeResult,
} from '../src/dsh/session-notice.ts'

const base: SessionNoticeResult = {
  published: [],
  forceDropped: 0,
  factsPromoted: 0,
  factsSeenAgain: 0,
  baselineUpdated: false,
  tokensBefore: 1000,
  tokensAfter: 1000,
}

describe('sessionNoticeSummary', () => {
  it('is null when the pass did nothing notable (baseline-only refresh)', () => {
    expect(sessionNoticeSummary({ ...base, tokensAfter: base.tokensBefore - 500, baselineUpdated: true })).toBeNull()
  })

  it('names the published compartments and the net reclaim', () => {
    const summary = sessionNoticeSummary({ ...base, published: [2], tokensAfter: base.tokensBefore - 104_146 })
    expect(summary).toContain('Magic Context · ')
    expect(summary).toContain('compacted 1 compartment')
    expect(summary).toContain('§C2§')
    expect(summary).toContain('reclaimed 104,146 tok')
  })

  it('pluralizes the compartment count', () => {
    const summary = sessionNoticeSummary({ ...base, published: [1, 2], tokensAfter: base.tokensBefore - 1000 })
    expect(summary).toContain('compacted 2 compartments')
  })

  it('reports fact promotion with the seen-again count', () => {
    const summary = sessionNoticeSummary({ ...base, factsPromoted: 9, factsSeenAgain: 2 })
    expect(summary).toContain('promoted 9 memories')
    expect(summary).toContain('(2 already known)')
  })

  it('reports force-band drops', () => {
    const summary = sessionNoticeSummary({ ...base, forceDropped: 3, tokensAfter: base.tokensBefore - 12_000 })
    expect(summary).toContain('emergency-dropped 3 tool outputs')
    expect(summary).toContain('reclaimed 12,000 tok')
  })

  it('bounds the one-line account to the host notice budget', () => {
    const many = Array.from({ length: 40 }, (_, i) => i + 1)
    const summary = sessionNoticeSummary({ ...base, published: many })
    expect(summary).not.toBeNull()
    expect(summary!.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS)
    expect(summary!.endsWith('…')).toBe(true)
  })
})

describe('appendSessionNotice', () => {
  it('appends a user-role notice with surfaceOp append', () => {
    const calls: Array<{ type: string; data: Record<string, unknown>; options: unknown }> = []
    const session = { append: (type: string, data: Record<string, unknown>, options: unknown) => {
      calls.push({ type, data, options })
      return 42
    } }
    const outcome = appendSessionNotice({
      session,
      result: { ...base, published: [7], factsPromoted: 9, tokensAfter: base.tokensBefore - 1000 },
    })
    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.type).toBe('user/message')
    expect(call.options).toEqual({ surfaceOp: 'append' })
    expect(call.data.role).toBe('user')
    expect(typeof call.data.id).toBe('string')
    const source = call.data.source as Record<string, unknown>
    expect(source.kind).toBe('magic-context')
    expect(source.form).toBe('notice')
    expect(typeof source.summary).toBe('string')
    const content = call.data.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toContain('compacted 1 compartment')
  })

  it('appends the English baseline line when the baseline moved', () => {
    const calls: Array<{ data: Record<string, unknown> }> = []
    const session = { append: (_type: string, data: Record<string, unknown>) => { calls.push({ data }); return 7 } }
    const outcome = appendSessionNotice({
      session,
      result: { ...base, published: [3], baselineUpdated: true, tokensAfter: base.tokensBefore - 500 },
    })
    expect(outcome.ok).toBe(true)
    const content = calls[0]!.data.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toContain('Baseline refreshed (m[0] frozen point advanced)')
  })

  it('stays quiet on a nothing-notable pass and never calls append', () => {
    let calls = 0
    const session = { append: () => { calls += 1; return 0 } }
    const outcome = appendSessionNotice({ session, result: base })
    expect(outcome).toEqual({ ok: false, reason: 'not-notable' })
    expect(calls).toBe(0)
  })

  it('fails open when the session rejects the append', () => {
    const session = { append: () => { throw new Error('session sealed') } }
    const outcome = appendSessionNotice({
      session,
      result: { ...base, factsPromoted: 1 },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('append-failed')
      expect(outcome.detail).toContain('session sealed')
    }
  })
})
