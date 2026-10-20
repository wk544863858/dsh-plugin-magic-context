/**
 * Route health — the two decisions the maintenance lane's quota skip rests on.
 *
 * The design constraint that shaped both (2026-10-10 rulings): a quota can be
 * reset EXTERNALLY (admin reset, pay-as-you-go, early recovery), so nothing may
 * be persisted and no reset time may be guessed. The observation holds for a
 * fixed window only, its owner is real traffic, and expiry is the recovery
 * path — the worst case is one hold's worth of skipped maintenance.
 *
 * The classifier cases below are not invented: the positive wording is DSH's
 * own exhausted-quota family plus the exact live 429 body this deployment
 * produced (`[1310][已达到 7 天使用上限…]`), and `quota resets in one minute`
 * comes from upstream's own test asserting it is NOT terminal — a transient
 * throttle must not arm a 45-minute skip.
 */
import { describe, expect, it } from 'vitest'
import {
  isQuotaExhaustedDetail,
  quotaSkipSince,
  resolveMaintenanceRoute,
  ROUTE_QUOTA_HOLD_MS,
  RouteHealth,
} from '../src/core/route-health.ts'

const T0 = 1_700_000_000_000

describe('isQuotaExhaustedDetail', () => {
  it('recognizes the exhausted family, including the live 429 body', () => {
    // The exact body observed live on provider-a/model-a (journal,
    // 2026-10-09 22:28). If this stops matching, the skip never arms.
    expect(isQuotaExhaustedDetail('1310 [1310][已达到 7 天使用上限，2026-10-12 23:46:18 后可继续使用。如需超限额按量付费使用，可联系管理员开启超额按量付费。]'))
      .toBe(true)
    expect(isQuotaExhaustedDetail('insufficient_quota')).toBe(true)
    expect(isQuotaExhaustedDetail('OpenAI API error (429): You exceeded your current quota, please check your plan and billing details.')).toBe(true)
    expect(isQuotaExhaustedDetail('usage limit exceeded for this billing period')).toBe(true)
    expect(isQuotaExhaustedDetail('account balance exhausted')).toBe(true)
    expect(isQuotaExhaustedDetail('额度已耗尽')).toBe(true)
  })

  it('does NOT arm on transient throttling or non-quota failures', () => {
    // From upstream's own classifier test: a one-minute reset says the route
    // is alive. Arming a 45-minute skip on it would be a false suppression.
    expect(isQuotaExhaustedDetail('quota resets in one minute')).toBe(false)
    expect(isQuotaExhaustedDetail('RATE_LIMIT provider busy')).toBe(false)
    expect(isQuotaExhaustedDetail('invalid_request_error: tool message block shape')).toBe(false)
    expect(isQuotaExhaustedDetail('truncated at the token cap')).toBe(false)
    expect(isQuotaExhaustedDetail('')).toBe(false)
  })
})

describe('RouteHealth', () => {
  it('reports the age of an armed observation and disarms at the hold', () => {
    const health = new RouteHealth()
    health.observeQuotaFailure('provider-a', T0)
    expect(health.quotaSince('provider-a', T0 + 10 * 60_000)).toBe(10 * 60_000)
    // Inside the hold: suppressed.
    expect(health.quotaSince('provider-a', T0 + ROUTE_QUOTA_HOLD_MS - 1)).toBe(ROUTE_QUOTA_HOLD_MS - 1)
    // At/after the hold: the observation expired — the external-reset escape
    // hatch. There is no success signal by design; expiry IS the recovery.
    expect(health.quotaSince('provider-a', T0 + ROUTE_QUOTA_HOLD_MS)).toBeUndefined()
    expect(health.quotaSince('provider-a', T0 + 10 * ROUTE_QUOTA_HOLD_MS)).toBeUndefined()
  })

  it('keeps providers independent and ignores empty names', () => {
    const health = new RouteHealth()
    health.observeQuotaFailure('provider-a', T0)
    expect(health.quotaSince('other-provider', T0 + 1_000)).toBeUndefined()
    health.observeQuotaFailure('', T0)
    expect(health.quotaSince('', T0)).toBeUndefined()
  })

  it('lets the latest observation win (re-armed by ongoing traffic)', () => {
    const health = new RouteHealth()
    health.observeQuotaFailure('p', T0)
    health.observeQuotaFailure('p', T0 + ROUTE_QUOTA_HOLD_MS)
    // The first observation would have expired here; the refresh holds.
    expect(health.quotaSince('p', T0 + ROUTE_QUOTA_HOLD_MS + 60_000)).toBe(60_000)
  })

  it('snapshots only live observations, for journaling', () => {
    const health = new RouteHealth()
    health.observeQuotaFailure('p', T0)
    health.observeQuotaFailure('q', T0 - 5 * ROUTE_QUOTA_HOLD_MS)
    expect(health.snapshot(T0 + 1).has('p')).toBe(true)
    expect(health.snapshot(T0 + 1).has('q')).toBe(false)
  })
})

describe('quotaSkipSince — the skip only ever hits the main conversation\'s own route', () => {
  const routeA = { provider: 'provider-a', model: 'model-a' }
  const routeB = { provider: 'provider-a', model: 'model-b' }

  it('skips when the tick is about to ride the exact route whose provider failed', () => {
    const health = new RouteHealth()
    health.observeQuotaFailure('provider-a', T0)
    expect(quotaSkipSince(health, routeA, routeA, T0 + 5 * 60_000)).toBe(5 * 60_000)
  })

  it('never skips a pinned divergent route — the 2026-10-09 live shape', () => {
    // model-a was quota-dead while model-b verified normally
    // under the SAME provider. A provider-keyed skip would have stalled the
    // live route; the exact-route rule must not.
    const health = new RouteHealth()
    health.observeQuotaFailure('provider-a', T0)
    expect(quotaSkipSince(health, routeB, routeA, T0 + 5 * 60_000)).toBeUndefined()
    // Same guard in the other direction: main on the live model, pin on the dead one.
    expect(quotaSkipSince(health, routeA, routeB, T0 + 5 * 60_000)).toBeUndefined()
  })

  it('does not skip without an observation, an expired one, or a route at all', () => {
    const health = new RouteHealth()
    expect(quotaSkipSince(health, routeA, routeA, T0)).toBeUndefined()
    health.observeQuotaFailure('provider-a', T0)
    expect(quotaSkipSince(health, routeA, routeA, T0 + ROUTE_QUOTA_HOLD_MS)).toBeUndefined()
    expect(quotaSkipSince(health, undefined, routeA, T0 + 1_000)).toBeUndefined()
    expect(quotaSkipSince(health, routeA, undefined, T0 + 1_000)).toBeUndefined()
  })
})

describe('resolveMaintenanceRoute', () => {
  it('prefers the explicit pin, falls back to the session route, then none', () => {
    const pin = { provider: 'pinned', model: 'm1' }
    const session = { provider: 'provider-a', model: 'model-a' }
    expect(resolveMaintenanceRoute(pin, session)).toEqual(pin)
    expect(resolveMaintenanceRoute(undefined, session)).toEqual(session)
    expect(resolveMaintenanceRoute(undefined, undefined)).toBeUndefined()
  })

  it('rejects half-empty identities instead of routing to a blank provider', () => {
    expect(resolveMaintenanceRoute({ provider: '', model: 'm' }, { provider: 'p', model: 'm2' })).toEqual({ provider: 'p', model: 'm2' })
    expect(resolveMaintenanceRoute({ provider: 'p', model: '' }, undefined)).toBeUndefined()
  })
})
