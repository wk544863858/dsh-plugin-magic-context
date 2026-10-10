/**
 * The maintenance tick's schedule (the adapter's slice of MC's dreamer): TTL
 * expiry always runs when the writer is writable; LLM verification uses the
 * main conversation's latest route, unless an explicit
 * `maintenance.verifyProvider/verifyModel` pin overrides it (the rollback
 * lever). A tick has no session of its own, so "latest" is last-seen-wins
 * across concurrent sessions — enough for a lane whose only requirement is "a
 * route the user currently trusts". A route observed quota-exhausted inside
 * the hold skips the LLM steps with one info line instead of joining the main
 * conversation's failure noise. The sweep covers the configured project plus
 * every identity this process resolved for a session (see
 * {@link PreStepProjects}). Fail-open end to end: a broken tick journals and
 * waits for the next one.
 *
 * Moved verbatim out of index.ts. The interval starts only AFTER the boot
 * catch-up run: with both timers armed at mount they fire together at 60s and
 * sweep twice (measured: two identical maintenance rows per boot, and two llm
 * calls for the same batch).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterStores } from '../core/stores.ts'
import type { Journal } from '../core/journal.ts'
import { runMaintenanceTick, type MaintenanceLlm } from '../core/maintenance.ts'
import { PROFILE_REVIEW_META_KEY, runProfileReview, type ProfileReviewLlm, type ProfileReviewOutcome } from '../core/profile-review.ts'
import type { VectorBackfillOutcome } from '../core/vector-backfill.ts'
import { quotaSkipSince, resolveMaintenanceRoute, ROUTE_QUOTA_HOLD_MS, RouteHealth, type RouteChoice } from '../core/route-health.ts'

/** WP11 default batch: how many vectors one maintenance tick may add. */
export const VECTOR_BACKFILL_DEFAULT_LIMIT = 24
import type { MemoryWriter } from '../core/memory-write.ts'
import type { ProfileWriter } from '../core/profile-write.ts'
import { errText } from '../core/types.ts'
import type { HistorianLlm } from './historian.ts'
import type { MagicContextDshConfig } from './config.ts'
import type { PreStepProjects } from './pre-step.ts'
import { liveBoolean, liveNumber, liveString, liveValue } from './volatile.ts'
import { existsSync } from 'node:fs'

/** Newest maintenance tally, surfaced by the telemetry panel (dreamer KPI). */
export interface MaintenanceLast {
  at: number
  expired: number
  verified: number
  updated: number
  archived: number
}

export interface MaintenanceWiring {
  /** Getter, not a copy — the panel polls the newest tally. */
  maintenanceLast: () => MaintenanceLast | undefined
  /** The newest profile-review outcome (WP7), for the same panel. */
  profileReviewLast: () => ProfileReviewOutcome | undefined
  /** The newest vector-backfill outcome (WP11), same panel. */
  vectorBackfillLast: () => VectorBackfillOutcome | undefined
}

export function wireMaintenance(input: {
  ctx: Context
  config: MagicContextDshConfig
  stores: AdapterStores
  journal: Journal | undefined
  llm: HistorianLlm | undefined
  writer: MemoryWriter | undefined
  profileWriter: ProfileWriter | undefined
  /** WP11: the lane's backfill closure; absent when the lane is unusable. */
  vectorBackfill?: (limit: number, journal: Journal) => Promise<VectorBackfillOutcome | undefined>
  /** Volatile per-provider quota observations, fed from `agent/request-error`. */
  routeHealth: RouteHealth
  /** The main conversation's latest route; the tick follows it when unpinned. */
  lastSessionRoute: () => RouteChoice | undefined
  projects: PreStepProjects
  /** The adapter-level disposer list (timers ride it). */
  disposers: Array<() => void>
  /** The compaction engine sets this when the adapter is disposed. */
  isDisposed: () => boolean
}): MaintenanceWiring {
  const { ctx, config, stores, journal, llm, writer, profileWriter, vectorBackfill, routeHealth, lastSessionRoute, projects, disposers, isDisposed } = input
  const { seenIdentities } = projects
  let maintenanceLast: MaintenanceLast | undefined
  let profileReviewLast: ProfileReviewOutcome | undefined
  let vectorBackfillLast: VectorBackfillOutcome | undefined
  let maintenanceBusy = false
  const runMaintenance = async (): Promise<void> => {
    if (maintenanceBusy || isDisposed() || stores.closed || journal === undefined) return
    if (liveBoolean(config.maintenance?.enabled, true) === false) return
    maintenanceBusy = true
    try {
      // The evidence pass (schema v7, mon3stera's codebase-grounded verify):
      // root resolution order — the explicit `memory.evidenceRoot`, then
      // `memory.project` when it is a real path (a `git:`/`dir:` identity is
      // not). Without a root the stage skips and the tick behaves exactly as
      // before; the mode ships `off` for the shadow-window rollout.
      const evidenceModeRaw = String(liveValue(config.maintenance?.evidenceVerify?.mode) ?? '')
      const evidenceMode = evidenceModeRaw === 'shadow' || evidenceModeRaw === 'enforce' ? evidenceModeRaw : undefined
      const evidenceRoot = ((): string | undefined => {
        const explicit = liveValue(config.memory?.evidenceRoot)
        if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) return explicit
        const project = liveValue(config.memory?.project)
        if (
          typeof project === 'string' && project.length > 0
          && !project.startsWith('git:') && !project.startsWith('dir:')
          && existsSync(project)
        ) return project
        return undefined
      })()
      const evidenceMaxRows = liveNumber(config.maintenance?.evidenceVerify?.maxRows, 4)
      // The route every LLM step of this tick uses, resolved ONCE: the explicit
      // pin wins (rollback lever), otherwise the main conversation's latest
      // route. A quota observation skips the LLM steps ONLY when the tick is
      // about to ride the main conversation's own exact route — the event
      // carries a provider but no model, and quotas are route-scoped, so a
      // provider-keyed skip would stall a live sibling model (2026-10-09:
      // model-a exhausted while model-b verified normally).
      // One info line, zero requests; the observation is volatile and owned by
      // real traffic, so an externally reset quota re-opens the lane within one
      // hold at the cost of one cheap probe.
      const pinnedProvider = liveString(config.maintenance?.verifyProvider, '')
      const pinnedModel = liveString(config.maintenance?.verifyModel, '')
      const tickRoute = resolveMaintenanceRoute(
        pinnedProvider.length > 0 && pinnedModel.length > 0 ? { provider: pinnedProvider, model: pinnedModel } : undefined,
        lastSessionRoute(),
      )
      const tickQuotaAge = quotaSkipSince(routeHealth, tickRoute, lastSessionRoute(), Date.now())
      if (tickRoute !== undefined && tickQuotaAge !== undefined) {
        journal.info(
          'maintenance',
          `LLM steps skipped: ${tickRoute.provider}/${tickRoute.model} observed quota-exhausted ${String(Math.round(tickQuotaAge / 60_000))}m ago (hold ${String(Math.round(ROUTE_QUOTA_HOLD_MS / 60_000))}m)`,
          { provider: tickRoute.provider, model: tickRoute.model, quotaAgeMs: tickQuotaAge, route: `${tickRoute.provider}/${tickRoute.model}` },
        )
      }
      const tickLlmReady = llm !== undefined && tickRoute !== undefined && tickQuotaAge === undefined
      const identities = new Set<string>()
      if (config.memory?.project !== undefined) identities.add(config.memory.project)
      for (const identity of seenIdentities) identities.add(identity)
      for (const identity of identities) {
        const outcome = await runMaintenanceTick({
          writer,
          identity,
          sessionId: 'mc-maintenance',
          journal,
          ...(tickLlmReady && tickRoute !== undefined && llm !== undefined
            ? { llm: llm as unknown as MaintenanceLlm, route: tickRoute }
            : {}),
          ...(evidenceMode !== undefined && evidenceRoot !== undefined
            ? { evidence: { mode: evidenceMode, root: evidenceRoot, maxRows: evidenceMaxRows } }
            : {}),
        })
        // A writer-level problem applies to every identity — stop the sweep.
        if (outcome.reason === 'writer-unavailable' || outcome.reason === 'read-only') break
        maintenanceLast = {
          at: Date.now(),
          expired: outcome.expired,
          verified: outcome.verified,
          updated: outcome.updated,
          archived: outcome.archived,
        }
      }

      // WP7: the `user` domain's review. It is GLOBAL — one candidate pool, one
      // profile — so it runs once per tick rather than per identity, and it is
      // deliberately outside the loop's `break` (the memory writer failing says
      // nothing about the profile tables, which live in the same file but are
      // reached through their own connection).
      //
      // The throttle is a stored timestamp because DSH has no daily scheduler to
      // hang MC's `review-user-memories` cadence on. It is written only when a
      // review actually RAN, so a failed call is retried on the next tick
      // instead of being silenced for a day by its own failure.
      if (liveBoolean(config.memory?.global?.user?.review, false) && profileWriter !== undefined) {
        const lastReviewRaw = Number(stores.getMeta(PROFILE_REVIEW_META_KEY) ?? '')
        const review = await runProfileReview({
          writer: profileWriter,
          sessionId: 'mc-maintenance',
          journal,
          ...(tickLlmReady && tickRoute !== undefined && llm !== undefined
            ? { llm: llm as unknown as ProfileReviewLlm, route: tickRoute }
            : {}),
          ...(Number.isFinite(lastReviewRaw) && lastReviewRaw > 0 ? { lastReviewAt: lastReviewRaw } : {}),
        })
        if (review.ran) stores.setMeta(PROFILE_REVIEW_META_KEY, String(Date.now()))
        profileReviewLast = review
      }

      // WP11: fill the vector lane. Also global, also once per tick, and off by
      // default because it is the switch that writes vectors into the shared
      // store. `vectorBackfill` returns undefined when the lane is unusable
      // (no reader/embedder/writer), which is reported as "not run" rather than
      // silently looking like "nothing missing".
      if (liveBoolean(config.memory?.vectorBackfill, false) && vectorBackfill !== undefined) {
        const limit = Math.max(1, Math.floor(config.memory?.vectorBackfillLimit ?? VECTOR_BACKFILL_DEFAULT_LIMIT))
        const outcome = await vectorBackfill(limit, journal)
        if (outcome === undefined) {
          journal.info('vector-lane', 'backfill lane unavailable (no embedder or no writable store)', {
            outcome: 'backfill-unavailable',
          })
        } else {
          vectorBackfillLast = outcome
        }
      }
    } catch (error) {
      journal.error('maintenance', `maintenance tick failed: ${errText(error)}`)
    } finally {
      maintenanceBusy = false
    }
  }
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  const maintenanceFirst = setTimeout(() => {
    void runMaintenance().finally(() => {
      maintenanceTimer = setInterval(
        () => { void runMaintenance() },
        Math.max(60_000, liveNumber(config.maintenance?.intervalMs, 1_800_000)),
      )
      ;(maintenanceTimer as unknown as { unref?: () => void }).unref?.()
    })
  }, 60_000)
  ;(maintenanceFirst as unknown as { unref?: () => void }).unref?.()
  disposers.push(() => {
    if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer)
    clearTimeout(maintenanceFirst)
  })
  return {
    maintenanceLast: () => maintenanceLast,
    profileReviewLast: () => profileReviewLast,
    vectorBackfillLast: () => vectorBackfillLast,
  }
}
