/**
 * The maintenance tick's schedule (the adapter's slice of MC's dreamer): TTL
 * expiry always runs when the writer is writable; LLM verification needs an
 * explicit `maintenance.verifyProvider/verifyModel` because a tick has no
 * session to inherit a route from. The sweep covers the configured project
 * plus every identity this process resolved for a session (see
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
}

export function wireMaintenance(input: {
  ctx: Context
  config: MagicContextDshConfig
  stores: AdapterStores
  journal: Journal | undefined
  llm: HistorianLlm | undefined
  writer: MemoryWriter | undefined
  profileWriter: ProfileWriter | undefined
  projects: PreStepProjects
  /** The adapter-level disposer list (timers ride it). */
  disposers: Array<() => void>
  /** The compaction engine sets this when the adapter is disposed. */
  isDisposed: () => boolean
}): MaintenanceWiring {
  const { ctx, config, stores, journal, llm, writer, profileWriter, projects, disposers, isDisposed } = input
  const { seenIdentities } = projects
  let maintenanceLast: MaintenanceLast | undefined
  let profileReviewLast: ProfileReviewOutcome | undefined
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
      const identities = new Set<string>()
      if (config.memory?.project !== undefined) identities.add(config.memory.project)
      for (const identity of seenIdentities) identities.add(identity)
      for (const identity of identities) {
        const verifyProvider = liveString(config.maintenance?.verifyProvider, '')
        const verifyModel = liveString(config.maintenance?.verifyModel, '')
        const routeReady = verifyProvider.length > 0 && verifyModel.length > 0
        const outcome = await runMaintenanceTick({
          writer,
          identity,
          sessionId: 'mc-maintenance',
          journal,
          ...(llm === undefined || !routeReady ? {} : { llm: llm as unknown as MaintenanceLlm, route: { provider: verifyProvider, model: verifyModel } }),
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
        const reviewProvider = liveString(config.maintenance?.verifyProvider, '')
        const reviewModel = liveString(config.maintenance?.verifyModel, '')
        const reviewRouteReady = reviewProvider.length > 0 && reviewModel.length > 0
        const lastReviewRaw = Number(stores.getMeta(PROFILE_REVIEW_META_KEY) ?? '')
        const review = await runProfileReview({
          writer: profileWriter,
          sessionId: 'mc-maintenance',
          journal,
          ...(llm === undefined || !reviewRouteReady
            ? {}
            : { llm: llm as unknown as ProfileReviewLlm, route: { provider: reviewProvider, model: reviewModel } }),
          ...(Number.isFinite(lastReviewRaw) && lastReviewRaw > 0 ? { lastReviewAt: lastReviewRaw } : {}),
        })
        if (review.ran) stores.setMeta(PROFILE_REVIEW_META_KEY, String(Date.now()))
        profileReviewLast = review
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
  }
}
