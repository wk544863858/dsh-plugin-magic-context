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

/**
 * WP11 gate. Default TRUE since 2026-10-12: the memory write path never embeds,
 * so with the lane off every NEW memory stayed vector-less forever and Chinese
 * semantic recall (the only channel with real recall on this corpus — FTS with
 * unicode61 hits ~18%) silently decayed as rows accumulated. The vectors land
 * in the machine's own single-writer store, bounded by
 * `vectorBackfillLimit` per tick and gated by the shared-space parity check
 * (a closed gate aborts the whole batch). Set the key to `false` to keep the
 * shared store free of writes.
 */
export function vectorBackfillEnabled(memory: MagicContextDshConfig['memory']): boolean {
  return liveBoolean(memory?.vectorBackfill, true)
}
/** Live maintenance tickers keyed by adapter DB path — a same-DB remount replaces its predecessor (see wireMaintenance). */
const maintenanceTickers = new Map<string, () => void>()
import type { MemoryWriter } from '../core/memory-write.ts'
import type { ProfileWriter } from '../core/profile-write.ts'
import { errText } from '../core/types.ts'
import { autoStageGlobalCandidates, type AutoStageLlm } from '../core/global-autostage.ts'
import type { HistorianLlm } from './historian.ts'
import type { MagicContextDshConfig } from './config.ts'
import type { PreStepProjects } from './pre-step.ts'
import { liveBoolean, liveNumber, liveString } from './volatile.ts'
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

      // L1① v10: classify-then-route global auto-stage. The classifier needs
      // the SAME LLM seam as the verify lane (route, model, session id), so it
      // rides the tick's route. Fail-closed: no route (or the pin route on
      // quota-hold) means NOTHING is staged — the memories stay at project
      // level, never a guessed fallback domain.
      if (liveBoolean(config.memory?.global?.machine?.autoStage, false)
        && tickLlmReady && tickRoute !== undefined && llm !== undefined && writer !== undefined) {
        const outcome = await autoStageGlobalCandidates({
          store: stores,
          corpusDbPath: writer.dbPath,
          now: Date.now(),
          llm: llm as unknown as AutoStageLlm,
          route: tickRoute,
        })
        if (outcome.staged.length > 0) {
          journal.info(
            'memory-promote',
            `auto-staged ${String(outcome.staged.length)} global candidate(s): ${outcome.staged
              .map(entry => `#${String(entry.candidateId)}(memory ${String(entry.memoryId)} → ${entry.domainId})`)
              .join(', ')}`,
            { phase: 'auto-stage', staged: outcome.staged, skipped: outcome.skipped },
          )
        }
        if (outcome.reason !== undefined) {
          journal.info(
            'memory-promote',
            `auto-stage paused: ${outcome.reason} (memories stay at project level)`,
            { phase: 'auto-stage', reason: outcome.reason },
          )
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

      // WP11: fill the vector lane. Also global, also once per tick, and on by
      // default since 2026-10-12 (see {@link vectorBackfillEnabled} for the
      // reasoning). `vectorBackfill` returns undefined when the lane is
      // unusable (no reader/embedder/writer), which is reported as "not run"
      // rather than silently looking like "nothing missing".
      if (vectorBackfillEnabled(config.memory) && vectorBackfill !== undefined) {
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
  // One live ticker per adapter store, process-wide. A remount that arrives
  // without its predecessor's disposal (the GUI-reconnect reload path) used to
  // STACK a second 60s first-tick and a second interval on the same DB —
  // measured at 6 ticks/75 minutes. The registry, keyed by `dbPath`, replaces
  // the live ticker instead: a same-DB remount takes over, different-DB mounts
  // (tests with separate data dirs) stay independent.
  const predecessor = maintenanceTickers.get(stores.dbPath)
  if (predecessor !== undefined) predecessor()
  let stopped = false
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  const stopTicker = (): void => {
    if (stopped) return
    stopped = true
    if (maintenanceTickers.get(stores.dbPath) === stopTicker) maintenanceTickers.delete(stores.dbPath)
    if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer)
    clearTimeout(maintenanceFirst)
  }
  const maintenanceFirst = setTimeout(() => {
    void runMaintenance().finally(() => {
      if (stopped) return
      maintenanceTimer = setInterval(
        () => { void runMaintenance() },
        Math.max(60_000, liveNumber(config.maintenance?.intervalMs, 1_800_000)),
      )
      ;(maintenanceTimer as unknown as { unref?: () => void }).unref?.()
    })
  }, 60_000)
  ;(maintenanceFirst as unknown as { unref?: () => void }).unref?.()
  maintenanceTickers.set(stores.dbPath, stopTicker)
  disposers.push(stopTicker)
  return {
    maintenanceLast: () => maintenanceLast,
    profileReviewLast: () => profileReviewLast,
    vectorBackfillLast: () => vectorBackfillLast,
  }
}
