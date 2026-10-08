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
import { join } from 'node:path'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  DSH_EVENTS,
  enumerateSurfaceToolResults,
  probeDshSeams,
  readUsageFields,
  requestContextOf,
  tagToolResultContent,
} from './dsh/seams.ts'
import { reclaimForEmergency } from './dsh/emergency.ts'
import type { HistorianLlm } from './dsh/historian.ts'
import { defineCtxExpandTool, defineCtxReduceTool, defineCtxMemoryTool } from './dsh/tool-bridge.ts'
import { ReduceNudgeTracker } from './dsh/reduce-guidance.ts'
import { registerCtxStatusCommand } from './dsh/status-command.ts'
import { registerCtxRecompCommand } from './dsh/recomp.ts'
import { SearchHintTracker } from './dsh/search-hint.ts'
import { registerMagicCompactionEngine } from './dsh/compaction-engine.ts'
import { createTelemetryService } from './dsh/telemetry.ts'
import { openMemoryLane } from './dsh/memory-lane.ts'
import { injectReduceGuidance, preStepListener, type PreStepProjects } from './dsh/pre-step.ts'
import { wireMaintenance } from './dsh/maintenance-wiring.ts'
import type { MagicContextDshConfig, MagicContextDshConfigDefineTool } from './dsh/config.ts'
import { DEFAULT_POLICY, type PressurePolicy } from './core/policy.ts'
import z from '@deepseek-ai/schemastery'
import { ensureTag, tagPrefix } from './core/tagger.ts'
import { openJournal, recoverOrphanHistorianRuns, type Journal, type JournalLevel } from './core/journal.ts'
import { defaultDataDir, openStores, SCHEMA_VERSION } from './core/stores.ts'
import { errText, type UsageRecord } from './core/types.ts'
import { liveBoolean, liveNumber, liveString, policyOf } from './dsh/volatile.ts'
import {
  pressureUsedTokens,
  shouldLogContextPressure,
  type ContextPressureReading,
  type LoggedPressureReading,
} from './dsh/context-pressure.ts'

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
  // Volatile config leaves arrive as live references (see `Config`), so every
  // consumer reads through the `live*` helpers instead of comparing the raw
  // value: `config.registerCompactionEngine !== false` is TRUE for a reference,
  // which would mount the engine a user had explicitly disabled.
  const journal: Journal | undefined = liveBoolean(config.journal?.enabled, true)
    ? openJournal({
      stores,
      ...liveBoolean(config.journal?.mirror, true) === false ? {} : { mirrorPath: join(storeDir, 'activity.log') },
      level: liveString(config.journal?.level, 'info') as JournalLevel,
      retentionDays: liveNumber(config.journal?.retentionDays, 30),
      logger: ctx.logger,
    })
    : undefined
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
  const { memoryRecall, memoryWriter, memorySearch, describeMemoryWrite } = lane
  const { memorySettings } = lane

  const disposers: Array<() => void> = []
  const on = (name: string, listener: unknown): void => {
    disposers.push((ctx.on as unknown as (n: string, l: unknown) => () => void).call(ctx, name, listener))
  }

  // Identities the preStep registers, the maintenance sweep serves and the
  // panel scopes by — one registry, three consumers.
  const projects: PreStepProjects = { seenIdentities: new Set<string>(), sessionIdentity: new Map<string, string>() }

  // Auto-search hint state: one hint per user turn (preStep runs per model step).
  const searchHints = new SearchHintTracker()

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
    searchHints,
  }))

  // ── §N§ tags on tool results at landing (Phase 0) ─────────────────────────
  on(DSH_EVENTS.postToolExecute, async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || 'value' in decision || result.isError) return decision
    const sessionId = exec.agent?.session.id
    if (sessionId === undefined) return decision
    const tag = ensureTag(stores, sessionId, { kind: 'tool-result', callId: exec.callId })
    const base = decision.content ?? result.content
    return { kind: 'accept', content: tagToolResultContent(base, tagPrefix, tag) }
  })

  // ── Reduce guidance through the SystemPrompt service (MC parity) ──────────
  injectReduceGuidance({ ctx, config, stores, journal, llm, reduceTracker, lane, projects, seenSessions, activePolicy })

  // ── Usage recording from durable assistant/message events (Phase 0) ───────
  on(DSH_EVENTS.sessionEvent, (session, event) => {
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
  on(DSH_EVENTS.requestError, async (payload, next) => {
    if (payload.failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || payload.signal.aborted) return next()
    const sessionId = payload.agent.session.id
    const before = payload.agent.session.surface.replaceGeneration
    try {
      const nodes = enumerateSurfaceToolResults(payload.agent.session, callId =>
        stores.getTag(sessionId, { kind: 'tool-result', callId }))
      // C1: the token window scales with the route's context window.
      const context = requestContextOf(payload.agent.session)
      const reclaim = reclaimForEmergency(payload.agent.session, nodes, policy, context.contextWindow)
      journal?.warn('emergency-reclaim', `provider rejected the request as too long; dropped ${String(reclaim.dropped.length)} tool output(s)`, {
        dropped: reclaim.dropped.length,
        protected: reclaim.protectedCount,
        reason: 'context-window-exceeded',
        generationBefore: before,
        generationAfter: payload.agent.session.surface.replaceGeneration,
        retried: payload.agent.session.surface.replaceGeneration > before,
      }, sessionId)
      ctx.logger.warn(
        `magic-context: emergency reclaim dropped ${String(reclaim.dropped.length)} tool outputs `
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
    if (!payload.signal.aborted && payload.agent.session.surface.replaceGeneration > before) {
      return { kind: 'retry' }
    }
    return next()
  })

  // ── Tools + command ────────────────────────────────────────────────────────
  if (config.registerTools !== false) {
    // Constructor resolution: host-injected → dynamic import → local builder.
    // The local builder is what makes the packaged Desktop runtime work: a
    // profile-installed bundle cannot import the harness packages (Node's ESM
    // resolver ignores NODE_PATH), and ToolDefinition is a plain structural
    // interface either way. See dsh/tool-bridge.ts.
    let defineTool = config.defineTool
    toolMode = 'host-injected'
    if (defineTool === undefined) {
      try {
        defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool
        toolMode = 'dynamic-import'
      } catch {
        toolMode = 'local-builder'
      }
    }
    try {
      const registrar = (ctx as unknown as { tools: Registrar }).tools
      const deps = { stores, ...defineTool === undefined ? {} : { defineTool }, ...journal === undefined ? {} : { journal } }
      registrar.register(defineCtxReduceTool(deps))
      registrar.register(defineCtxExpandTool(deps))
      if (memoryRecall !== undefined) {
        registrar.register(defineCtxMemoryTool(lane.ctxMemoryRegistration({ activePolicy, defineTool, journal })))
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
    registerCtxStatusCommand(ctx, { stores, policy })
    // Recomp rides the same gate: it needs the same seams as the historian, and
    // its handler refuses with a readable message when the LLM is absent or the
    // historian is switched off.
    registerCtxRecompCommand(ctx, {
      stores,
      policy,
      logger: ctx.logger,
      enabled: liveBoolean(config.historianEnabled, true) !== false,
      ...journal === undefined ? {} : { journal },
      ...llm === undefined ? {} : { llm },
      ...config.historian === undefined ? {} : { route: config.historian },
    })
    ctx.logger.info('magic-context dsh adapter: /ctx-status and /ctx-recomp registered')
  }

  // ── The compaction seam ────────────────────────────────────────────────────
  // Occupying `ctx.compaction` is what makes this adapter authoritative over
  // reclaim: no checkpoint-summarizing engine may compete with the historian
  // and the drop lanes. Hosts that mount compaction-basic must disable that
  // row (see the README's profile patch) — two providers on one context throw.
  let adapterDisposed = false
  if (liveBoolean(config.registerCompactionEngine, false)) {
    try {
      const base = config.compactionBase ?? (await import('@deepseek-ai/dsh-compaction')).CompactionEngine
      // Awaiting: a duplicate-mount rejection (`ctx.compaction` already owned)
      // must land in the catch below, not become an unhandled rejection.
      await registerMagicCompactionEngine(ctx, {
        base,
        stores,
        policy,
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
      stores.setMeta('compaction_engine', `unavailable: ${detail}`)
      journal?.warn('engine', `CompactionEngine not mounted: ${detail}`, { action: 'unavailable', detail })
      ctx.logger.warn(
        `magic-context dsh adapter: CompactionEngine not mounted `
          + `(${detail}); the management loop is unaffected`,
      )
    }
  } else {
    // Record the opt-out explicitly: a stale "mounted" value from an earlier
    // composition would otherwise keep claiming the seam.
    stores.setMeta('compaction_engine', 'disabled-by-config')
    journal?.info('engine', 'CompactionEngine disabled by configuration', { action: 'disabled-by-config' })
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
    if (journal === undefined) return
    const registry = (scope as unknown as {
      sessionProjections: {
        onChanged(listener: (session: { id?: string }, key: string, value: unknown) => void): () => void
      }
    }).sessionProjections
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

  journal?.info('boot', `adapter booted (tools: ${toolMode}, historian: ${liveBoolean(config.historianEnabled, true) === false ? 'off' : llm === undefined ? 'no-llm' : 'on'})`, {
    version: 'phase2',
    dbPath: stores.dbPath,
    schemaVersion: SCHEMA_VERSION,
    recoveredHistorianRuns,
    tools: { mode: toolMode, registered: config.registerTools !== false },
    engine: stores.getMeta('compaction_engine'),
    memory: stores.getMeta('memory_bridge'),
    memoryWrite: stores.getMeta('memory_write'),
    telemetry: telemetry === undefined ? 'pending (registers with webServer)' : '/mc-telemetry',
    // Resolved once for display; the tick itself resolves at decision time.
    maintenance: {
      enabled: liveBoolean(config.maintenance?.enabled, true) !== false,
      intervalMs: Math.max(60_000, liveNumber(config.maintenance?.intervalMs, 1_800_000)),
      verify: llm === undefined ? 'off (no llm)' : `${liveString(config.maintenance?.verifyProvider, '') || '∅'}/${liveString(config.maintenance?.verifyModel, '') || '∅'}`,
    },
    historian: {
      enabled: liveBoolean(config.historianEnabled, true) !== false && llm !== undefined,
      route: config.historian === undefined ? 'session-route' : `${config.historian.provider}/${config.historian.model}`,
    },
    journal: { enabled: journal !== undefined, mirror: journal?.mirrorPath, retentionDays: liveNumber(config.journal?.retentionDays, 30) },
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
    retentionDays: z.number().default(30).volatile(),
    mirror: z.boolean().default(true).volatile(),
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
