/**
 * Route health — the volatile "this route is quota-exhausted" observation lane.
 *
 * Two decisions live here, both deliberately tiny:
 *
 *  1. **What counts as an exhausted quota.** Wording only — the canonical
 *     provider-neutral wording family DSH itself recognizes (`insufficient
 *     quota/balance/credits`, `quota/usage limit exceeded…`), plus the Chinese
 *     limit wording this deployment actually produces (`已达到 7 天使用上限`).
 *     Transient throttling is NOT this: `quota resets in one minute` says the
 *     route is alive, so it must not arm a skip (DSH's own classifier makes the
 *     same distinction).
 *
 *  2. **How long one observation holds.** A fixed hold, nothing persisted. The
 *     signal's owner is real traffic — the host's `agent/request-error` events
 *     keep re-arming it while the main conversation keeps failing on that
 *     route, and it simply expires after the hold when nothing does. That is
 *     the whole point: an externally reset quota (admin reset, pay-as-you-go
 *     enabled, early recovery) cannot be trapped by a stale guess, because
 *     there is no durable state to go stale — the worst case is one hold's
 *     worth of skipped maintenance, and the maintenance tick's own next probe
 *     re-discovers the truth at the cost of one cheap rejected request.
 */

/** One provider/model identity, as the host reports it per request. */
export interface RouteChoice {
  readonly provider: string
  readonly model: string
}

/**
 * Exhausted-quota wording. `detail` is whatever the failure surface exposed
 * (message preferred, code as a fallback) — callers concatenate what they have.
 */
export function isQuotaExhaustedDetail(detail: string): boolean {
  return /insufficient[\s_-]*(?:quota|balance|credits?)/i.test(detail)
    || /(?:quota|usage[\s_-]*limit)[\s_-]*(?:exceeded|exhausted|reached)/i.test(detail)
    || /exceed(?:ed|s)?[\s_-]*(?:(?:your|the)[\s_-]*)?(?:current[\s_-]*)?quota/i.test(detail)
    || /(?:balance|credits?)[\s_-]*(?:exhausted|depleted)/i.test(detail)
    || /使用上限|额度(?:已)?(?:用尽|耗尽)|余额不足/.test(detail)
}

/** How long one quota observation suppresses the maintenance lane. */
export const ROUTE_QUOTA_HOLD_MS = 45 * 60_000

/**
 * The observation map. Volatile by design: process lifetime, no persistence,
 * no reset-time parsing. `now` is always injected so the hold is testable.
 */
export class RouteHealth {
  private readonly quotaAt = new Map<string, number>()

  /** Arm the skip for one provider. Idempotent; the latest observation wins. */
  observeQuotaFailure(provider: string, at: number): void {
    if (provider.length === 0) return
    this.quotaAt.set(provider, at)
  }

  /**
   * Milliseconds since the latest quota observation for this provider, when
   * that observation is still inside the hold; `undefined` when the route is
   * not suppressed (no observation, or an expired one).
   */
  quotaSince(provider: string, now: number, holdMs: number = ROUTE_QUOTA_HOLD_MS): number | undefined {
    const at = this.quotaAt.get(provider)
    if (at === undefined) return undefined
    const age = now - at
    return age >= 0 && age < holdMs ? age : undefined
  }

  /** Read-only copy, for journaling and the doctor surface. */
  snapshot(now: number, holdMs: number = ROUTE_QUOTA_HOLD_MS): ReadonlyMap<string, number> {
    const out = new Map<string, number>()
    for (const [provider, at] of this.quotaAt) {
      if (now - at < holdMs) out.set(provider, at)
    }
    return out
  }
}

/**
 * The skip decision the maintenance tick actually uses — deliberately narrower
 * than the observation. The event carries a provider but no model, while a
 * quota is route-scoped (provider/model): the live 2026-10-09 incident had
 * provider-a/model-a exhausted while provider-a/model-b
 * verified normally, and a provider-keyed skip would have suppressed the live
 * route. So an observation may only suppress the main conversation's OWN
 * exact route: the tick route must equal the last session route in provider
 * AND model, and the observation must be for that provider. A pinned route
 * that diverges from the main conversation never skips — one cheap rejected
 * request beats silently stalling a working route.
 */
export function quotaSkipSince(
  health: RouteHealth,
  tickRoute: RouteChoice | undefined,
  lastSessionRoute: RouteChoice | undefined,
  now: number,
  holdMs: number = ROUTE_QUOTA_HOLD_MS,
): number | undefined {
  if (tickRoute === undefined || lastSessionRoute === undefined) return undefined
  if (tickRoute.provider !== lastSessionRoute.provider || tickRoute.model !== lastSessionRoute.model) return undefined
  return health.quotaSince(tickRoute.provider, now, holdMs)
}

/**
 * The maintenance lane's route, resolved once per tick.
 *
 * Priority is explicit over following: a pinned `maintenance.verifyProvider`
 * wins (it is the rollback lever), the main conversation's latest route is the
 * default, and neither being available means the lane runs its LLM-less steps
 * only — exactly the pre-existing behavior. "Latest" is last-seen-wins across
 * concurrent sessions, which is fine for a lane whose only requirement is "a
 * route the user currently trusts".
 */
export function resolveMaintenanceRoute(
  explicit: RouteChoice | undefined,
  lastSession: RouteChoice | undefined,
): RouteChoice | undefined {
  if (explicit !== undefined && explicit.provider.length > 0 && explicit.model.length > 0) return explicit
  if (lastSession !== undefined && lastSession.provider.length > 0 && lastSession.model.length > 0) return lastSession
  return undefined
}
