/**
 * Magic Context — DeepSeek Harness adapter (Phase 2: historian + baseline).
 *
 * Composition root: boot probes → seam listeners → neutral stores.
 * All DSH contact happens through `./dsh/`; all policy logic is neutral
 * (`./core`). See docs/dsh-port-feasibility-2026-10-06.md for the seam map
 * and the upgrade-insulation contract.
 *
 * The wiring bands live in their own modules (each moved verbatim out of this
 * file, closure locals become the destructured fields of a deps object):
 *  - `dsh/config.ts` — the configuration interface;
 *  - `dsh/volatile.ts` — the volatile-reference readers + `policyOf`;
 *  - `dsh/memory-lane.ts` — the memory gate/bridge/writer/search lane and the
 *    ctx_memory closures;
 *  - `dsh/pre-step.ts` — the preStep band (tagging, drift, identity, the
 *    pressure decision and its execute pass) and the reduce-guidance inject;
 *  - `dsh/maintenance-wiring.ts` — the dreamer-slice sweep and its timers.
 *
 * What remains here is the composition itself: probe, open stores/journal,
 * wire each band, mount the compaction seam, telemetry, and the dispose list.
 *
 * Phase 1 — the context-management loop without an LLM historian:
 *  - §N§ tags at admission/landing (Phase 0);
 *  - pressure measurement from durable usage + the logged context window;
 *  - execute/defer pass decisions (threshold + cache TTL; MC scheduler);
 *  - ctx_reduce marks queue and LAND only inside the execute band;
 *  - ctx_expand restores original content from cited source events;
 *  - emergency reclaim + retry on CONTEXT_WINDOW_EXCEEDED;
 *  - /ctx-status command.
 *
 * Phase 2 — the historian, the m[0]/m[1] baseline, project memories, and the
 * compaction seam:
 *  - the historian digests the oldest eligible span into a four-tier
 *    compartment, out of band, only writing a store row;
 *  - the execute band publishes compartments as `[compacted §C<n>§]` range
 *    replacements and refreshes the baseline node it composes;
 *  - project memories are recalled from Magic Context's shared `context.db`
 *    into m[0] (read-only by default);
 *  - a custom CompactionEngine occupies the `ctx.compaction` seam so no
 *    checkpoint-summarizing engine competes with the reclaim lanes.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  DSH_EVENTS,
  enumerateSurfaceToolResults,
  probeDshSeams,
  readUsageFields,
  requestContextOf,
  tagToolResultContent,
  type ContentBlock,
  type Session,
  type SessionEvent,
} from './dsh/seams.ts'
import { reclaimForEmergency } from './dsh/emergency.ts'
import type { HistorianLlm } from './dsh/historian.ts'
import { historianInFlight } from './dsh/historian.ts'
import { publishReadyCompartments } from './dsh/management-pass.ts'
import { defineCtxExpandTool, defineCtxReduceTool, defineCtxMemoryTool, type LocalDefineTool } from './dsh/tool-bridge.ts'
import { ReduceNudgeTracker } from './dsh/reduce-guidance.ts'
import { registerCtxStatusCommand } from './dsh/status-command.ts'
import { registerCtxRecompCommand } from './dsh/recomp.ts'
import { registerCtxGlobalCommand, registerCtxProfileCommand } from './dsh/command-surface.ts'
import { reviewGlobalCandidates, type GlobalReviewAsker } from './dsh/global-review.ts'
import { SearchHintTracker } from './dsh/search-hint.ts'
import { registerMagicCompactionEngine, type EngineHandle } from './dsh/compaction-engine.ts'
import { liveJournal } from './dsh/live-journal.ts'
import { createTelemetryService } from './dsh/telemetry.ts'
import { openMemoryLane } from './dsh/memory-lane.ts'
import { injectReduceGuidance, preStepListener, type PreStepProjects } from './dsh/pre-step.ts'
import { wireMaintenance } from './dsh/maintenance-wiring.ts'
import { SWITCH_SNAPSHOT_META_KEY, buildSwitchSnapshot, diffSwitches } from './dsh/config-switches.ts'
import { isQuotaExhaustedDetail, RouteHealth, type RouteChoice } from './core/route-health.ts'
import type { MagicContextDshConfig, MagicContextDshConfigDefineTool } from './dsh/config.ts'
import { DEFAULT_POLICY, type PressurePolicy } from './core/policy.ts'
import z from '@deepseek-ai/schemastery'
import { ensureTag, tagPrefix } from './core/tagger.ts'
import { recoverOrphanHistorianRuns, type Journal } from './core/journal.ts'
import { defaultDataDir, openStores, SCHEMA_VERSION } from './core/stores.ts'
import { errText, type UsageRecord } from './core/types.ts'
import { liveBoolean, liveNumber, liveString, policyOf } from './dsh/volatile.ts'
import {
  pressureUsedTokens,
  shouldLogContextPressure,
  type ContextPressureReading,
  type LoggedPressureReading,
} from './dsh/context-pressure.ts'

/**
 * Structural views of the host events this file listens to.
 *
 * Cordis types a listener from its declaration-merged event map; these events
 * arrive through the string table in `./dsh/seams.ts`, so each handler names the
 * fields it reads. Until the typecheck ran for real, `noCheck` let every one of
 * these parameters be an implicit `any`.
 */
interface WaterfallDecision {
  readonly kind: string
  readonly content?: readonly ContentBlock[]
  readonly value?: unknown
}

/** `tools/post-execute` — the landing waterfall for a tool result. */
interface PostToolExecuteExec {
  readonly callId: string
  readonly agent?: { readonly session: Session }
}
interface PostToolExecuteResult {
  readonly isError: boolean
  readonly content?: readonly ContentBlock[]
}

/** `agent/request-error` — the overflow path and the quota feed read it. */
interface RequestErrorPayload {
  readonly failure: { readonly code: string; readonly message?: string }
  readonly provider?: string
  readonly signal: { readonly aborted: boolean }
  readonly agent: { readonly session: Session }
}

export type { MagicContextDshConfig, MagicContextDshConfigDefineTool }

export const name = 'magic-context-dsh-poc'

/**
 * Required host services. Declaring the injection makes the loader wait for
 * availability (a bare `ctx.get()` does not) and unlocks guarded property
 * access inside apply. A host without a tools registry or LLM seam pends this
 * plugin visibly instead of half-mounting it.
 */
export const inject = ['tools', 'llm']

interface Registrar {
  register(definition: unknown): unknown
}

export async function apply(ctx: Context, config: MagicContextDshConfig = {}): Promise<void> {
  if (config.enabled === false) {
    ctx.logger.info('magic-context dsh adapter: disabled by config')
    return
  }
  const probe = probeDshSeams(ctx)
  if (!probe.ok) {
    // Fail loud, not silent: an adapter that cannot see its seams must not
    // pretend to manage context (Magic Context's fail-closed discipline).
    throw new Error(
      `magic-context dsh adapter: DSH seam probe failed on this host build: ${probe.problems.join('; ')}`,
    )
  }

  const policy: PressurePolicy = policyOf(config.policy)
  /** Re-evaluated per pass so a settings-form edit applies immediately. */
  const activePolicy = (): PressurePolicy => policyOf(config.policy)
  /** Process start, for the telemetry uptime readout. */
  const startedAt = Date.now()
  const storeDir = config.dataDir ?? defaultDataDir()
  const stores = openStores(storeDir)
  ctx.logger.info(`magic-context dsh adapter: stores at ${stores.dbPath}`)
  // §N§ registry retention (the tags table only ever grows; the journal's
  // mount-time prune is the precedent): one DELETE per mount, logged only when
  // it removed something, and never allowed to break the mount.
  try {
    const tagsRetentionDays = liveNumber(config.tags?.retentionDays, 30)
    const prunedTags = stores.pruneTags(Date.now() - tagsRetentionDays * 24 * 60 * 60_000)
    if (prunedTags > 0) {
      ctx.logger.info(`magic-context dsh adapter: pruned ${String(prunedTags)} tag registry rows past ${String(tagsRetentionDays)}d retention`)
    }
  } catch (error) {
    ctx.logger.warn(`magic-context dsh adapter: tag retention prune failed: ${errText(error)}`)
  }
  // Volatile config leaves arrive as live references (see `Config`), so every
  // consumer reads through the `live*` helpers instead of comparing the raw
  // value: `config.registerCompactionEngine !== false` is TRUE for a reference,
  // which would mount the engine a user had explicitly disabled.
  //
  // `journal` is a LIVE wrapper when the composition boots with the journal
  // on: enabled/level/mirror/retention are read at write time, so a
  // settings-form edit applies to the next entry (a volatile commit never
  // remounts, and the old mount-time construction made every journal edit a
  // dead option until restart — the audit, 2026-10-10). Booting with
  // `journal.enabled: false` still wires `undefined`: the maintenance tick
  // reads a missing journal as "do not run", and the boot-time opt-out keeps
  // that meaning (turning it back on then needs an app restart, which the
  // form's hint says).
  const journal: Journal | undefined = liveBoolean(config.journal?.enabled, true) === false
    ? undefined
    : liveJournal({ config, stores, storeDir, logger: ctx.logger })
  /** Sessions already announced, so the journal gets exactly one first-seen row. */
  const seenSessions = new Set<string>()
  // Journal repair: an hmr remount disposes stores mid-run and leaves a
  // historian `start` without a terminal sibling. At mount time no run of the
  // new composition is in flight yet, so every still-open start predates this
  // process and gets one synthetic `adapter-remount` terminal (journal.ts).
  const recoveredHistorianRuns = journal === undefined ? 0 : recoverOrphanHistorianRuns(stores, journal)
  /** Resolved tool-constructor path, recorded at boot for the review. */
  let toolMode = 'skipped'
  /** The LLM seam (declared inject); the historian's auxiliary call uses it. */
  const llm = (ctx as unknown as { llm?: HistorianLlm }).llm
  /** Reduce-guidance state per session (Channel 1/2 sticky bands, turn counts). */
  const reduceTracker = new ReduceNudgeTracker()

  // ── The memory lane ────────────────────────────────────────────────────────
  // `memory` is deliberately NOT declared in the exported Config: a schemastery
  // key would be materialized for every profile and would open the bridge
  // everywhere. It therefore arrives as a plain object, and the gate is simply:
  //   absent config        → off   (no bridge, no writer, no recall, no ctx_memory)
  //   enabled: false       → off   (explicit opt-out; reported as disabled-by-config)
  //   anything else        → on
  // Read once, inside the lane, so a disabled adapter can never half-open.
  const lane = openMemoryLane(ctx, config, stores)
  const { memoryRecall, memoryWriter, profileWriter, memorySearch, describeMemoryWrite } = lane
  const { memorySettings } = lane

  const disposers: Array<() => void> = []
  const on = (name: string, listener: unknown): void => {
    disposers.push((ctx.on as unknown as (n: string, l: unknown) => () => void).call(ctx, name, listener))
  }

  // ── The compaction seam ────────────────────────────────────────────────────
  // Occupying `ctx.compaction` is what makes this adapter authoritative over
  // reclaim: no checkpoint-summarizing engine may compete with the historian
  // and the drop lanes. Hosts that mount compaction-basic must disable that
  // row in the profile patch (see the README) — two providers on one context
  // throw.
  //
  // `registerCompactionEngine` is a LIVE switch: the pre-step band calls
  // `reconcileEngine` on every step, so a settings-form toggle mounts or
  // unmounts the engine without a restart. The switch is volatile, and a
  // volatile commit never remounts the plugin — the old mount-time branch
  // made the form's toggle a dead option: it saved, and nothing changed
  // until the app restarted (the audit, 2026-10-10). The state sits here,
  // before any `await` in apply, so a pre-step firing mid-apply (during the
  // tools section's dynamic import) cannot hit a temporal-dead-zone read.
  let adapterDisposed = false
  let engineHandle: EngineHandle | undefined
  let engineBusy = false
  /** One mount attempt per ON transition: a failing mount must not retry on every step. */
  let engineFailed = false
  const reconcileEngine = (): void => {
    const wanted = liveBoolean(config.registerCompactionEngine, false)
    if (engineBusy || adapterDisposed || wanted === (engineHandle !== undefined)) return
    if (wanted && engineFailed) return
    engineBusy = true
    if (wanted) {
      void (async () => {
        try {
          const base = config.compactionBase ?? (await import('@deepseek-ai/dsh-compaction')).CompactionEngine
          // Awaiting: a duplicate-mount rejection (`ctx.compaction` already
          // owned) must land in the catch below, not become an unhandled
          // rejection.
          engineHandle = await registerMagicCompactionEngine(ctx, {
            base,
            stores,
            policy,
            activePolicy,
            logger: ctx.logger,
            ...llm === undefined ? {} : { llm },
            ...journal === undefined ? {} : { journal },
            ...config.historian === undefined ? {} : { route: config.historian },
            ...memoryRecall === undefined ? {} : { recall: memoryRecall },
            isDisposed: () => adapterDisposed,
          })
          ctx.logger.info('magic-context dsh adapter: CompactionEngine mounted on ctx.compaction')
          stores.setMeta('compaction_engine', 'magic-context-dsh')
          journal?.info('engine', 'CompactionEngine mounted on ctx.compaction', { action: 'mounted' })
        } catch (error) {
          const detail = errText(error)
          engineFailed = true
          stores.setMeta('compaction_engine', `unavailable: ${detail}`)
          journal?.warn('engine', `CompactionEngine not mounted: ${detail}`, { action: 'unavailable', detail })
          ctx.logger.warn(
            `magic-context dsh adapter: CompactionEngine not mounted `
            + `(${detail}); the management loop is unaffected`,
          )
        } finally {
          engineBusy = false
        }
      })()
      return
    }
    const handle = engineHandle
    if (handle === undefined) {
      // Unreachable past the guard above; kept so the narrowing is explicit.
      engineBusy = false
      return
    }
    engineHandle = undefined
    engineFailed = false
    void handle.dispose()
      .then(() => {
        // Record the opt-out explicitly: a stale "mounted" value from an
        // earlier composition would otherwise keep claiming the seam.
        stores.setMeta('compaction_engine', 'disabled-by-config')
        journal?.info('engine', 'CompactionEngine unmounted by configuration', { action: 'unmounted' })
        ctx.logger.info('magic-context dsh adapter: CompactionEngine unmounted (disabled by configuration)')
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`magic-context dsh adapter: engine unmount failed: ${errText(error)}`)
      })
      .finally(() => { engineBusy = false })
  }
  // Boot: mount eagerly, or record the opt-out explicitly (a stale "mounted"
  // value from an earlier composition would otherwise keep claiming the seam).
  if (liveBoolean(config.registerCompactionEngine, false)) {
    reconcileEngine()
  } else {
    stores.setMeta('compaction_engine', 'disabled-by-config')
    journal?.info('engine', 'CompactionEngine disabled by configuration', { action: 'disabled-by-config' })
  }

  // Identities the preStep registers, the maintenance sweep serves and the
  // panel scopes by — one registry, three consumers.
  const projects: PreStepProjects = { seenIdentities: new Set<string>(), sessionIdentity: new Map<string, string>() }

  // Auto-search hint state: one hint per user turn (preStep runs per model step).
  const searchHints = new SearchHintTracker()

  // The main conversation's latest route (last-seen-wins across sessions) and
  // the volatile per-provider quota observations fed from `agent/request-error`.
  // The maintenance lane follows the route when unpinned, and skips its LLM
  // steps while the route's latest observation is an exhausted quota — the
  // signal is owned by real traffic and never persisted, so an externally
  // reset quota cannot be trapped by a stale guess.
  let lastSessionRoute: RouteChoice | undefined
  const routeHealth = new RouteHealth()

  // ── §N§ tags + the pressure decision on the admitted user batch ───────────
  on(DSH_EVENTS.preStep, preStepListener({
    ctx,
    config,
    stores,
    journal,
    llm,
    reduceTracker,
    lane,
    projects,
    seenSessions,
    activePolicy,
    /** Engine mount/unmount rides the step band: a form toggle applies without a restart. */
    reconcileEngine: () => reconcileEngine(),
    searchHints,
    noteSessionRoute: route => { lastSessionRoute = route },
  }))

  // ── §N§ tags on tool results at landing (Phase 0) ─────────────────────────
  on(DSH_EVENTS.postToolExecute, async (exec: PostToolExecuteExec, result: PostToolExecuteResult, next: () => Promise<WaterfallDecision>) => {
    const decision = await next()
    if (decision.kind !== 'accept' || 'value' in decision || result.isError) return decision
    const sessionId = exec.agent?.session.id
    if (sessionId === undefined) return decision
    const tag = ensureTag(stores, sessionId, { kind: 'tool-result', callId: exec.callId })
    const base = decision.content ?? result.content
    // Nothing to tag (a result without content blocks); the decision is
    // already the host's, so it passes through unchanged.
    if (base === undefined) return decision
    return { kind: 'accept', content: tagToolResultContent(base, tagPrefix, tag) }
  })

  // ── Reduce guidance through the SystemPrompt service (MC parity) ──────────
  injectReduceGuidance({ ctx, config, stores, journal, llm, reduceTracker, lane, projects, seenSessions, activePolicy })

  // ── Usage recording from durable assistant/message events (Phase 0) ───────
  on(DSH_EVENTS.sessionEvent, (session: Session, event: SessionEvent) => {
    const fields = readUsageFields(event)
    if (fields === undefined) return
    const record: UsageRecord = { sessionId: session.id, recordedAt: Date.now(), ...fields }
    try {
      stores.recordUsage(record)
    } catch (error) {
      const detail = errText(error)
      journal?.warn('error', `usage recording failed: ${detail}`, { scope: 'usage', detail }, session.id)
      // Best effort by design (mirrors MC per-turn fail-open): the next
      // assistant/message anchors a fresh row.
      ctx.logger.warn(
        `magic-context: usage recording failed for ${session.id}@${String(fields.seq)}: ${detail}`,
      )
    }
  })

  // ── Emergency reclaim + retry on provider-confirmed overflow ──────────────
  on(DSH_EVENTS.requestError, async (payload: RequestErrorPayload, next: () => Promise<WaterfallDecision>) => {
    // Route-health feed, best-effort by design: these reads sit BEFORE the
    // band try/catch below, so a drifted payload shape would throw into the
    // host's request-error waterfall. An exhausted-quota wording for a known
    // provider arms the maintenance lane's skip; anything else is ignored.
    try {
      const provider = payload?.provider
      const failure = payload?.failure
      if (typeof provider === 'string' && provider.length > 0 && failure !== undefined) {
        const detail = `${failure.code ?? ''} ${failure.message ?? ''}`
        if (isQuotaExhaustedDetail(detail)) routeHealth.observeQuotaFailure(provider, Date.now())
      }
    } catch (feedError) {
      ctx.logger.warn(`magic-context: route-health feed failed: ${errText(feedError)}`)
    }
    // Shape-tolerant guard: these reads sit BEFORE the band try/catch below, so
    // a drifted payload shape would throw into the host's request-error
    // waterfall. Degrade to pass-through instead — the emergency lane simply
    // stays idle, and the doctor heartbeat is what surfaces the drift.
    if (payload?.failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE || payload?.signal?.aborted) return next()
    const session = payload.agent?.session
    const sessionId = session?.id
    if (session === undefined || sessionId === undefined) return next()
    const before = session.surface.replaceGeneration
    try {
      // C1: the token window scales with the route's context window.
      const context = requestContextOf(session)
      // ── Tier 0 (fusion, mon3stera's ready bank): land ready compartments
      // BEFORE the drop lane. One replacement reclaims a whole digested
      // span; an emergency drop only individual tool results — and the
      // request has already failed once, so this bust cannot lose more than
      // the failed retry did. This lane is a forced execute band in
      // everything but name (the same exception family as the wire-repair
      // iron rule: the provider rejected the wire as-is). Fail-open: a
      // publish failure falls through to the drop lane, never skips it. No
      // baseline refresh and no fact promotion here — both belong to the
      // next execute pass (facts stay durable in the compartment row).
      const publishedIds: number[] = []
      const publishOnce = (): void => {
        const bank = publishReadyCompartments({
          session,
          sessionId,
          stores,
          policy,
          ...journal === undefined ? {} : { journal },
        })
        publishedIds.push(...bank.ids)
      }
      publishOnce()
      // ── Tier 0.5 (OFF by default): a digest in flight gets a bounded
      // chance to finish before the drop lane fires (mon3stera's
      // waitReadyTimeout race). `forceWaitReadyMs: 0` — the shipped default —
      // skips the wait; flip it after the force-path observation window.
      if (publishedIds.length === 0) {
        const waitReadyMs = Math.max(0, policy.forceWaitReadyMs)
        const inFlight = historianInFlight(sessionId)
        if (waitReadyMs > 0 && inFlight !== undefined) {
          await Promise.race([
            inFlight.catch(() => undefined),
            new Promise<void>(resolve => {
              const timer = setTimeout(resolve, waitReadyMs)
              ;(timer as { unref?: () => void }).unref?.()
            }),
          ])
          journal?.info('force-path', `overflow path waited on the in-flight historian (${String(waitReadyMs)}ms cap)`, {
            tier: 'wait',
            waitReadyMs,
          }, sessionId)
          publishOnce()
        }
      }
      if (publishedIds.length > 0) {
        journal?.warn('force-path', `provider rejected the request as too long; landed ${String(publishedIds.length)} ready compartment(s) before the drop lane`, {
          tier: 'publish',
          published: publishedIds,
          reason: 'context-window-exceeded',
          generationBefore: before,
          generationAfter: session.surface.replaceGeneration,
        }, sessionId)
      }
      // Re-enumerate AFTER any publish: it shadows surface nodes, and
      // dropping against a stale seq would throw into the waterfall.
      const nodes = enumerateSurfaceToolResults(session, callId =>
        stores.getTag(sessionId, { kind: 'tool-result', callId }))
      const reclaim = reclaimForEmergency(session, nodes, policy, context.contextWindow)
      journal?.warn('emergency-reclaim', `provider rejected the request as too long; dropped ${String(reclaim.dropped.length)} tool output(s)`, {
        dropped: reclaim.dropped.length,
        protected: reclaim.protectedCount,
        reason: 'context-window-exceeded',
        tier: reclaim.dropped.length > 0 ? 'drop' : publishedIds.length > 0 ? 'publish-only' : 'none',
        publishedBeforeDrop: publishedIds,
        generationBefore: before,
        generationAfter: session.surface.replaceGeneration,
        retried: session.surface.replaceGeneration > before,
      }, sessionId)
      ctx.logger.warn(
        `magic-context: overflow reclaim landed ${String(publishedIds.length)} compartment(s), dropped ${String(reclaim.dropped.length)} tool outputs `
          + `(${String(reclaim.protectedCount)} protected) after a context-overflow rejection`,
      )
    } catch (error) {
      const detail = errText(error)
      journal?.error('error', `emergency reclaim failed: ${detail}`, { scope: 'request-error', detail }, sessionId)
      ctx.logger.warn(
        `magic-context: emergency reclaim failed: ${detail}`,
      )
      return next()
    }
    // Durable surface progress is the retry proof (compaction-basic pattern):
    // a retry re-derives the request from the shrunken surface.
    if (!payload?.signal?.aborted && session.surface.replaceGeneration > before) {
      return { kind: 'retry' }
    }
    return next()
  })

  // ── Tools + command ────────────────────────────────────────────────────────
  // Human approval for global-domain candidates (L1① second leg): the asker
  // resolves the session's live root Agent and forwards the cards to the
  // host's user-questions waterfall. Structural injection — the package is
  // not a dependency; the asker stays undefined (fail-closed at call time)
  // when the service is absent, e.g. headless.
  let askGlobalReview: GlobalReviewAsker | undefined
  ctx.inject(['userQuestions', 'agents'], (scope: unknown) => {
    const { userQuestions, agents } = scope as {
      userQuestions?: { ask(request: unknown): Promise<unknown> }
      agents?: { get(id: string): unknown }
    }
    if (userQuestions === undefined || agents === undefined) return
    askGlobalReview = async ({ questions, sessionId }) => {
      const agent = sessionId === undefined ? undefined : agents.get(sessionId)
      return userQuestions.ask({ questions, ...(agent === undefined ? {} : { agent }) })
    }
  })
  if (config.registerTools !== false) {
    // Constructor resolution: host-injected → dynamic import. The import is
    // the normal path (`@deepseek-ai/dsh-tools` is a hard dependency); when
    // neither resolves, the failure propagates and the mount aborts loudly —
    // the ctx_* tools are the only entry for the agent's reduce marks, so a
    // boot without them must not half-run. See dsh/tool-bridge.ts.
    let defineTool = config.defineTool
    toolMode = 'host-injected'
    if (defineTool === undefined) {
      defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool
      toolMode = 'dynamic-import'
    }
    try {
      const registrar = (ctx as unknown as { tools: Registrar }).tools
      // The host's `defineTool` takes a wider option type than the subset this
      // package authors; `tool-bridge`'s seam names that subset so the three
      // tool bodies keep their argument types (see `LocalDefineTool`).
      const deps = { stores, defineTool: defineTool as LocalDefineTool, ...journal === undefined ? {} : { journal } }
      registrar.register(defineCtxReduceTool(deps))
      registrar.register(defineCtxExpandTool(deps))
      if (memoryRecall !== undefined) {
        registrar.register(defineCtxMemoryTool(lane.ctxMemoryRegistration({
          activePolicy,
          defineTool,
          journal,
          // L1① second leg: the review closure reads the asker binding lazily —
          // the inject above may land after this registration runs.
          reviewGlobal: exec => {
            const ask = askGlobalReview
            const pending = reviewGlobalCandidates({
              store: stores,
              ...(ask === undefined
                ? {}
                : { ask: ({ questions, sessionId }) => ask({ questions, sessionId }) }),
              ...memoryWriter === undefined || memoryWriter.status.ok !== true ? {} : { publisher: memoryWriter },
              ...journal === undefined ? {} : { journal },
              batchLimit: liveNumber(config.memory?.global?.review?.batchLimit, 5),
              sessionId: exec?.agent?.session?.id,
              now: () => Date.now(),
            })
            return pending.then(r => ({
              outcome: `审批完成：批准 ${String(r.approved)} / 拒绝 ${String(r.rejected)} / 跳过 ${String(r.skipped)}`
                + ` / 失败 ${String(r.failed)}；剩余待审 ${String(r.remaining)}`,
              detail: r.lines.length === 0 ? undefined : r.lines.join('\n'),
            }))
          },
        })))
      }
      ctx.logger.info(`magic-context dsh adapter: ctx_reduce / ctx_expand registered (${toolMode})`)
    } catch (error) {
      // Fail closed: without its tools the adapter cannot accept the
      // agent's reduce marks, so a mount without them must be loud, not
      // silently half-alive. Use registerTools: false to opt out explicitly.
      throw new Error(
        `magic-context dsh adapter: agent tools failed to register `
          + `(${errText(error)})`,
      )
    }
  }
  if (config.registerStatusCommand !== false) {
    registerCtxStatusCommand(ctx, { stores, policy: activePolicy })
    // Recomp rides the same gate: it needs the same seams as the historian, and
    // its handler refuses with a readable message when the LLM is absent or the
    // historian is switched off.
    registerCtxRecompCommand(ctx, {
      stores,
      policy: activePolicy,
      logger: ctx.logger,
      // LIVE gate: the same volatile `historianEnabled` the pre-step band
      // reads at decision time (the old mount-time boolean disagreed with
      // the live gate after a settings-form toggle).
      enabled: () => liveBoolean(config.historianEnabled, true) !== false,
      ...journal === undefined ? {} : { journal },
      ...llm === undefined ? {} : { llm },
      ...config.historian === undefined ? {} : { route: config.historian },
    })
    ctx.logger.info('magic-context dsh adapter: /ctx-status and /ctx-recomp registered')
    // The global-domain surface rides the same gate: with Magic Context's
    // dashboard gone these commands ARE the operating surface for the profile
    // queue and the domains.
    registerCtxProfileCommand(ctx, {
      stores,
      ...memoryRecall === undefined ? {} : { contractDbPath: memoryRecall.dbPath },
      // WP12/DoD: retiring a profile row is the user domain's only write from
      // the command surface. Without the writer the command says so instead of
      // reporting a retirement that never happened.
      ...profileWriter === undefined || profileWriter.status.ok !== true ? {} : { profileWriter },
    })
    registerCtxGlobalCommand(ctx, {
      stores,
      ...memoryRecall === undefined ? {} : { contractDbPath: memoryRecall.dbPath },
      // WP9: approving a candidate publishes it. Without the writer there is no
      // way to make it visible, and the command says so rather than marking a
      // candidate approved that nobody can see.
      ...memoryWriter === undefined || memoryWriter.status.ok !== true ? {} : { publisher: memoryWriter },
    })
    ctx.logger.info('magic-context dsh adapter: /ctx-profile and /ctx-global registered')
  }

  stores.setMeta('adapter_version', 'phase2')
  stores.setMeta('memory_bridge', memoryRecall === undefined
    ? memorySettings === undefined ? 'off' : 'disabled-by-config'
    : memoryRecall.status.ok
      ? `ok schema v${String(memoryRecall.status.schemaVersion)}`
      : `unavailable: ${String(memoryRecall.status.detail)}`)
  stores.setMeta('memory_write', describeMemoryWrite())
  // ── Telemetry for the browser half (validation-period observability) ──────
  // The Remote event whitelist is a compile-time constant, so a third-party
  // bundle cannot subscribe to plugin events; a web route we own is the
  // supported seam (verified by docs/dsh-plugin-ui-telemetry-contract.md).
  //
  // `ctx.get('webServer')` is a SNAPSHOT read: the web server's provider fiber
  // is normally not active yet when a bundle applies, so reading it eagerly
  // returned undefined and the route never registered (measured as a 404 in an
  // isolated profile while the desktop instance happened to win the race).
  // `ctx.inject` waits for the service and re-runs on its lifecycle, which is
  // how @deepseek-ai/dsh-client-modules attaches its own route.
  let telemetry: ReturnType<typeof createTelemetryService> | undefined
  ctx.inject(['webServer'], (scope) => {
    const webServer = (scope as unknown as {
      webServer: {
        register(route: {
          kind: 'prefix'
          path: string
          handler: (req: never, res: never) => void
        }): () => void
      }
    }).webServer
    telemetry = createTelemetryService({
      stores,
      ...journal === undefined ? {} : { journal },
      meta: () => ({
        engine: stores.getMeta('compaction_engine'),
        memory: stores.getMeta('memory_bridge'),
        memoryWrite: stores.getMeta('memory_write'),
        toolsMode: toolMode,
      }),
      // Dreamer-slice KPIs for the panel: the viewed session's project
      // verification coverage + the newest maintenance tally. Lazy getters —
      // the panel polls them, nothing runs at mount.
      memoryStats: (sessionId?: string, identity?: string) => {
        if (memoryWriter === undefined) return undefined
        // The identity telemetry resolved from this scope's newest recall comes
        // first: it is the very project the header shows, and the process
        // serves several sessions (first-seen would answer for someone else's
        // project). Config and the session registry are the fallbacks.
        const resolved = identity
          ?? config.memory?.project
          ?? (sessionId !== undefined ? projects.sessionIdentity.get(sessionId) : undefined)
          ?? [...projects.seenIdentities][0]
        if (resolved === undefined) return undefined
        try {
          const stats = memoryWriter.stats(resolved)
          return { total: stats.rows, verified: stats.verified, unverified: stats.unverified }
        } catch {
          return undefined
        }
      },
      maintenanceLast: maintenance.maintenanceLast,
      startedAt,
    })
    const service = telemetry
    scope.effect(() => webServer.register({
      kind: 'prefix',
      path: '/mc-telemetry',
      handler: (req, res) => service.handle(
        req as unknown as Parameters<typeof service.handle>[0],
        res as unknown as Parameters<typeof service.handle>[1],
      ),
    }))
    journal?.info('boot', 'telemetry route attached for the browser half', {
      telemetry: '/mc-telemetry',
      routes: ['/mc-telemetry/summary', '/mc-telemetry/events'],
    })
  })

  // ── Maintenance tick (the adapter's slice of MC's dreamer) ─────────────────
  const maintenance = wireMaintenance({
    ctx,
    config,
    stores,
    journal,
    llm,
    writer: memoryWriter,
    profileWriter,
    vectorBackfill: lane.vectorBackfill,
    routeHealth,
    lastSessionRoute: () => lastSessionRoute,
    projects,
    disposers,
    isDisposed: () => adapterDisposed,
  })

  // The occupancy gauge the native meter shows, from the SAME source: the
  // host's `contextPressure` projection. projectedTokens is the last
  // request's prompt-side usage plus the surface's signed movement since the
  // sample — the answer for the NEXT request, not the last-request bill our
  // pass ledger carries (the two read differently and the user noticed).
  // A reading lands in the journal only when it is genuinely new (see
  // dsh/context-pressure.ts): every distinct reading used to write a row,
  // measured at ~10 rows/minute during heavy work. Telemetry serves the newest
  // row to the panel, so both gauges agree within one threshold step.
  ctx.inject(['sessionProjections'], (scope) => {
    // Structural, not host-typed on purpose: `SessionProjectionMap` is
    // merge-extensible and `contextPressure` is registered at runtime by the
    // token meter, so the host type's key union cannot name our key.
    const registry = (scope as { sessionProjections?: {
      onChanged(listener: (session: { id?: string }, key: string, value: unknown) => void): () => void
    } }).sessionProjections
    if (journal === undefined || registry === undefined) return
    const lastBySession = new Map<string, LoggedPressureReading>()
    const disposeListener = registry.onChanged((session, key, value) => {
      try {
        if (key !== 'contextPressure') return
        const reading = value as ContextPressureReading
        const sid = typeof session?.id === 'string' ? session.id : ''
        if (!shouldLogContextPressure(lastBySession.get(sid), reading)) return
        lastBySession.set(sid, { used: pressureUsedTokens(reading), window: reading.contextWindow ?? 0 })
        if (lastBySession.size > 64) {
          const oldest = lastBySession.keys().next().value
          if (oldest !== undefined) lastBySession.delete(oldest)
        }
        const used = pressureUsedTokens(reading)
        journal.info('context-pressure', `context pressure reading: ${String(used)} / ${String(reading.contextWindow ?? 0)} tok`, {
          projectedTokens: reading.projectedTokens,
          pressureTokens: reading.pressureTokens,
          contextWindow: reading.contextWindow,
        }, sid === '' ? undefined : sid)
      } catch {
        // a failed reading must never break the host's projection drive
      }
    })
    // The listener's disposer rides this inject fiber — a scope reload
    // re-runs the whole inject and swaps listeners cleanly.
    void disposeListener
  })

  // Config-drift alarm (2026-10-12): the profile's `config` block is REPLACE
  // semantics and once silently dropped three switch keys — the switches fell
  // back to defaults with no error row, found ~12h later by inference. Diff
  // this mount's effective snapshot against the previous mount's (persisted in
  // the adapter meta table) and say so LOUDLY when something went off. First
  // mount only seeds. Fail-open: a meta failure must not break the boot.
  const switches = buildSwitchSnapshot(config)
  try {
    const previousRaw = stores.getMeta(SWITCH_SNAPSHOT_META_KEY)
    if (previousRaw !== undefined) {
      const previous = JSON.parse(previousRaw) as Record<string, unknown>
      for (const row of diffSwitches(previous, switches)) {
        const detail = { key: row.key, before: row.before, after: row.after }
        if (row.severity === 'went-off') {
          journal?.warn('config-drift', `switch went OFF: ${row.key} (${String(row.before)} -> ${String(row.after)})`, detail)
        } else {
          journal?.info('config-drift', `switch changed: ${row.key} (${String(row.before)} -> ${String(row.after)})`, detail)
        }
      }
    }
    stores.setMeta(SWITCH_SNAPSHOT_META_KEY, JSON.stringify(switches))
  } catch (error) {
    journal?.warn('config-drift', `switch snapshot diff failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  journal?.info('boot', `adapter booted (tools: ${toolMode}, historian: ${liveBoolean(config.historianEnabled, true) === false ? 'off' : llm === undefined ? 'no-llm' : 'on'})`, {
    version: 'phase2',
    dbPath: stores.dbPath,
    schemaVersion: SCHEMA_VERSION,
    recoveredHistorianRuns,
    switches,
    // D1: set only when this mount laid the contract store down (fresh machine)
    ...lane.contractBootstrap === undefined ? {} : { contractBootstrap: lane.contractBootstrap },
    tools: { mode: toolMode, registered: config.registerTools !== false },
    engine: stores.getMeta('compaction_engine'),
    memory: stores.getMeta('memory_bridge'),
    memoryWrite: stores.getMeta('memory_write'),
    telemetry: telemetry === undefined ? 'pending (registers with webServer)' : '/mc-telemetry',
    // Resolved once for display; the tick itself resolves at decision time.
    maintenance: {
      enabled: liveBoolean(config.maintenance?.enabled, true) !== false,
      intervalMs: Math.max(60_000, liveNumber(config.maintenance?.intervalMs, 1_800_000)),
      verify: llm === undefined
        ? 'off (no llm)'
        : ((): string => {
            const provider = liveString(config.maintenance?.verifyProvider, '')
            const model = liveString(config.maintenance?.verifyModel, '')
            if (provider.length > 0 && model.length > 0) return `${provider}/${model}`
            // Unpinned: the tick follows the main conversation's latest route
            // (last-seen-wins); the per-tick journal rows carry the actual route.
            return 'follow-session'
          })(),
    },
    historian: {
      enabled: liveBoolean(config.historianEnabled, true) !== false && llm !== undefined,
      route: config.historian === undefined ? 'session-route' : `${config.historian.provider}/${config.historian.model}`,
    },
    journal: { enabled: journal !== undefined, mirror: journal?.mirrorPath, retentionDays: liveNumber(config.journal?.retentionDays, 30) },
    tagsRetentionDays: liveNumber(config.tags?.retentionDays, 30),
    // 融合 v7 的四个待观察翻转（boot 行可见，巡检核对配置漂移）。
    compartmentGuardMode: config.policy?.compartmentGuardMode,
    forceWaitReadyMs: liveNumber(config.policy?.forceWaitReadyMs, 0),
    evidenceVerifyMode: config.maintenance?.evidenceVerify?.mode,
    memoryScoringEnabled: config.memory?.scoring?.enabled === true,
    policy: {
      executeThreshold: policy.executeThreshold,
      forceThreshold: policy.forceThreshold,
      assumedContextWindow: policy.assumedContextWindow,
      ttlMs: policy.ttlMs,
      protectedToolResults: policy.protectedToolResults,
      historianProtectedNodes: policy.historianProtectedNodes,
      historianMinNodes: policy.historianMinNodes,
      historianTimeoutMs: policy.historianTimeoutMs,
      historianMaxTokens: policy.historianMaxTokens,
      historianMaxTokensCeiling: policy.historianMaxTokensCeiling,
      historianMinBudgetTokens: policy.historianMinBudgetTokens,
      baselineTokens: policy.baselineTokens,
      memoryLimit: policy.memoryLimit,
    },
  })

  ctx.effect(() => () => {
    // Flag FIRST: a stale engine holding the old closure must see disposed
    // before it can touch any of the handles being closed below.
    adapterDisposed = true
    for (const dispose of disposers.splice(0)) dispose()
    telemetry?.close()
    memoryWriter?.close()
    profileWriter?.close()
    memorySearch?.close()
    memoryRecall?.close()
    stores.close()
  }, 'magic-context dsh adapter listeners and stores')

  ctx.logger.info('magic-context dsh adapter: phase-2 management loop wired')
}

// Public entry surface: only what external consumers (the POC suite and the
// loader's default export) actually import. Everything else is imported
// in-package from its owning module.
export { replaceToolResultWithPlaceholder } from './dsh/seams.ts'
export { reclaimForEmergency } from './dsh/emergency.ts'
export { openStores } from './core/stores.ts'
export { DEFAULT_POLICY } from './core/policy.ts'
export { openJournal, redactData, formatJournalLine, recoverOrphanHistorianRuns } from './core/journal.ts'
export { runManagementPass } from './dsh/management-pass.ts'
export { policyOf } from './dsh/volatile.ts'

/**
 * The runtime schema the loader (and the plugin page's settings form) reads.
 *
 * Only the fields a user may tune are declared, and only those are `.volatile()`
 * — the Host's `settings.describe` projects volatile fields exclusively, so an
 * undeclared or non-volatile field simply has no form control. schemastery
 * passes undeclared keys through untouched (verified), so `defineTool`,
 * `compactionBase`, `historian` and the rest stay exactly as configured.
 *
 * Volatility is also the mechanism behind "apply immediately": the loader
 * commits a volatile-only change into the live reference without remounting the
 * fiber, and this plugin reads those references through {@link policyOf} at
 * every decision point.
 *
 * `memory` is deliberately NOT declared here. schemastery materialises declared
 * nested objects with their defaults, so declaring it would hand every profile
 * a `memory` object even when the user configured none — and in this plugin the
 * mere presence of `memory` opens the read/write bridge on the shared store.
 * Memory stays opt-in by configuration; its thresholds are edited in the patch.
 */
export const Config = z.object({
  historianEnabled: z.boolean().default(true).volatile(),
  registerCompactionEngine: z.boolean().default(false).volatile(),
  /** One notice entry in the session stream per action-bearing pass (see session-notice.ts). */
  sessionNotices: z.boolean().default(true).volatile(),
  /**
   * Auto-search hint: one "you may recall something related" entry per user turn,
   * built from the user's own words (see search-hint.ts).
   */
  searchHint: z.boolean().default(true).volatile(),

  /**
   * Maintenance tick (the adapter's slice of MC's dreamer): TTL expiry always
   * runs when the memory writer is writable; LLM verification additionally
   * needs an explicit route because a tick has no session to inherit one from.
   */
  maintenance: z.object({
    enabled: z.boolean().default(true).volatile(),
    intervalMs: z.number().min(60_000).default(1_800_000).volatile(),
    /** Empty provider/model = verify off (schemastery objects cannot be optional). */
    verifyProvider: z.string().default('').volatile(),
    verifyModel: z.string().default('').volatile(),
  }),

  journal: z.object({
    enabled: z.boolean().default(true).volatile(),
    level: z.string().default('info').volatile(),
    /** min(1): a stray 0/negative would prune the whole table at open. */
    retentionDays: z.number().min(1).default(30).volatile(),
    mirror: z.boolean().default(true).volatile(),
  }),

  /**
   * §N§ tag registry retention: one registry row per tagged target, pruned
   * once per mount. Rows that old belong to compacted spans and the
   * per-session counters are never touched, so tag numbers stay monotonic.
   */
  tags: z.object({
    retentionDays: z.number().min(1).default(30).volatile(),
  }),

  policy: z.object({
    /** Usage percent (0-100) at which the execute band opens. */
    executeThreshold: z.number().min(0).max(100).default(65).volatile(),
    /** Usage percent (0-100) at which reclaim becomes unconditional. */
    forceThreshold: z.number().min(0).max(100).default(85).volatile(),
    /**
     * Window assumed for scheduling when the routed model discloses none.
     * Without it a route that publishes no window defers 'no-window' forever,
     * which silently disables the execute band.
     */
    assumedContextWindow: z.number().min(1).default(256_000).volatile(),
    ttlMs: z.number().default(300_000).volatile(),
    protectedToolResults: z.number().default(8).volatile(),
    historianProtectedNodes: z.number().default(8).volatile(),
    historianMinNodes: z.number().default(3).volatile(),
    /** Wall-clock budget for one historian run; a spent budget journals `failed`.
     *  120s: large backlogs (600+ pending nodes) measured ~60s+ per digest. */
    historianTimeoutMs: z.number().default(120_000).volatile(),
    /** Generation cap for the historian; the historian raises anything below 8192. */
    historianMaxTokens: z.number().default(8_192).volatile(),
    /** Ceiling the historian may escalate to after a token-cap truncation (retry doubling). */
    historianMaxTokensCeiling: z.number().default(32_768).volatile(),
    historianMinBudgetTokens: z.number().default(5_000).volatile(),
    baselineTokens: z.number().default(2_000).volatile(),
    memoryBudgetTokens: z.number().default(8_000).volatile(),
    memoryLimit: z.number().default(40).volatile(),
    /**
     * The compartment publish guard (fusion v7): `observe` journals the
     * verdicts only (shipped default); `enforce` acts on them — supersede a
     * draft whose range gained substantive nodes, reject a digest that would
     * not shrink the wire; `off` skips the guard.
     */
    compartmentGuardMode: z.string().default('observe').volatile(),
    /** Entrant tokens past which a draft's range counts as drifted (re-digest). */
    compartmentEntrantTokens: z.number().min(0).default(200).volatile(),
    /**
     * Overflow-path wait on an in-flight historian before the drop lane
     * (0 = never wait — the shipped default; flip after observation).
     */
    forceWaitReadyMs: z.number().min(0).default(0).volatile(),
  }),
})

/**
 * The plugin as a loadable object. This is what every loading mode mounts:
 * the profile loader takes a package's default export, and in-tree glue and
 * tests pass it to `ctx.plugin` directly — one source of truth for the
 * required services (`inject`), the apply entry, and the runtime `Config`.
 *
 * `Config` MUST live on the default export: the loader's `unwrapExports` picks
 * the default object and reads `Config` from it, so a named `export const
 * Config` alone is silently ignored and the configuration never parses
 * (measured on cordis 4.0.4).
 */
export default { name, inject, apply, Config }
