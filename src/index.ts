/**
 * Magic Context — DeepSeek Harness adapter (Phase 2: historian + baseline).
 *
 * Composition root: boot probes → seam listeners → neutral stores.
 * All DSH contact happens through `./dsh/`; all policy logic is neutral
 * (`./core`). See docs/dsh-port-feasibility-2026-10-06.md for the seam map
 * and the upgrade-insulation contract.
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
  type ContentBlock,
  type PreStepEnterDecision,
  type PreStepPayload,
  type SessionEvent,
  enumerateSurfaceToolResults,
  probeDshSeams,
  readUsageFields,
  requestContextOf,
  tagToolResultContent,
  tagUserMessage,
} from './dsh/seams.ts'
import { reclaimForEmergency } from './dsh/emergency.ts'
import { runManagementPass } from './dsh/management-pass.ts'
import type { HistorianLlm } from './dsh/historian.ts'
import { defineCtxExpandTool, defineCtxReduceTool, defineCtxMemoryTool } from './dsh/tool-bridge.ts'
import {
  buildChannel1Reminder,
  buildChannel2Reminder,
  buildDeskSection,
  decideReduceNudge,
  ReduceNudgeTracker,
} from './dsh/reduce-guidance.ts'
import { registerCtxStatusCommand } from './dsh/status-command.ts'
import { registerMagicCompactionEngine } from './dsh/compaction-engine.ts'
import { createTelemetryService } from './dsh/telemetry.ts'
import { appendSessionNotice } from './dsh/session-notice.ts'
import { detectProjectDrift } from './dsh/project-drift.ts'
import { DEFAULT_POLICY, decidePass, pressurePercent, type PressurePolicy } from './core/policy.ts'
import z from '@deepseek-ai/schemastery'
import { ensureTag, tagPrefix } from './core/tagger.ts'
import { DEFAULT_SHARE_CATEGORIES, defaultMemoryDbPath, MEMORY_SCHEMA_MAX_VERSION, openMemoryBridge, resolveIdentitySpec } from './core/memory-bridge.ts'
import { openMemoryWriter, type MemoryWriter } from './core/memory-write.ts'
import { runMaintenanceTick, type MaintenanceLlm } from './core/maintenance.ts'
import { openMemorySearch, type MemorySearch } from './core/memory-search.ts'
import { cosineSimilarity, defaultEmbeddingCacheDir, openLocalEmbedder } from './core/embedding-local.ts'
import type { MemoryFact } from './core/memory-categories.ts'
import { openJournal, recoverOrphanHistorianRuns, type Journal, type JournalLevel } from './core/journal.ts'
import { defaultDataDir, openStores, SCHEMA_VERSION, type AdapterStores } from './core/stores.ts'
import { errText, type UsageRecord } from './core/types.ts'

export interface MagicContextDshConfig {
  /** Directory for the adapter's SQLite store. Defaults under ~/.local/share. */
  dataDir?: string
  /** Master switch; false keeps the plugin loaded but fully inert. */
  enabled?: boolean
  /** Register the ctx_reduce / ctx_expand agent tools (default true). */
  registerTools?: boolean
  /** Register the /ctx-status command (default true). */
  registerStatusCommand?: boolean
  /**
   * Host-supplied tool constructor. In-tree glue (which resolves
   * @deepseek-ai/dsh-tools natively) passes it here; when absent the
   * adapter falls back to a dynamic import, which only works in loading
   * modes where that specifier is resolvable from this package.
   */
  defineTool?: MagicContextDshConfigDefineTool
  /** Explicit historian route; default is the session's last routed model. */
  historian?: { provider: string; model: string }
  /** Turn the historian's out-of-band digests off (default: on). */
  historianEnabled?: boolean
  /**
   * Write one notice entry (`user/message`, producer kind `magic-context`,
   * form `notice`) into the session stream after each management pass that
   * actually did something — publish, force-drop, or fact promotion. The
   * transcript renders it as a collapsed notice row. Default true; the entry
   * is model-visible, so it costs its own (short) tokens until compaction.
   */
  sessionNotices?: boolean
  /**
   * Project-memory recall from Magic Context's shared `context.db`. Off when
   * omitted; reads only (writes stay with Magic Context's own storage layer).
   */
  memory?: {
    /** Explicit path to context.db; defaults to the CortexKit data directory. */
    dbPath?: string
    /**
     * Identity (`git:<root-sha>` / `dir:<hash>`) OR a directory to derive it
     * from. Unset falls back to the session's cwd, so project memory works
     * with no configuration at all.
     */
    project?: string
    /** Extra identities to read shared rows from; unset uses the DB's workspace. */
    workspaceProjects?: readonly string[]
    /** Category whitelist for shared rows; unset uses the workspace's policy. */
    shareCategories?: readonly string[]
    /**
     * Promote the historian's facts into project memory (Magic Context's
     * `memory.auto_promote`). Default true when memory is configured: facts
     * only become durable knowledge through this path.
     */
    autoPromote?: boolean
    /**
     * Let the agent maintain memories through `ctx_memory` (write/update/
     * archive/merge). Default true; false keeps the tool read-only while the
     * bridge still injects existing memories.
     */
    write?: boolean
    /**
     * Backfill stored-query vectors for rows the shared store has none of
     * (the B4 lane). Default false: the query side embeds on demand anyway,
     * and the backfill costs a local model load. Intentionally undocumented
     * in the settings schema — profile-JSON only.
     */
    embedBackfill?: boolean
  }
  /**
   * Host-supplied CompactionEngine base class (in-tree glue injects it; when
   * absent the adapter resolves `@deepseek-ai/dsh-compaction` dynamically).
   */
  compactionBase?: unknown
  /** Mount the adapter's CompactionEngine on the `compaction` seam (default true when resolvable). */
  registerCompactionEngine?: boolean
  /**
   * Validation-period observability. The Desktop app does not persist the
   * harness logger, so decisions and outcomes go to the adapter's own journal
   * table plus (by default) a human-readable mirror file; see
   * scripts/mc-report.mjs for the review side.
   */
  journal?: {
    /** Turn the journal off entirely (default: on). */
    enabled?: boolean
    /** Minimum persisted level (default 'info'; 'warn' drops routine events). */
    level?: JournalLevel
    /** Retention in days, pruned when the journal opens (default 30). */
    retentionDays?: number
    /** Write the one-line text mirror (default true). */
    mirror?: boolean
  }
  /** Pressure policy overrides; unset fields keep the defaults. */
  policy?: Partial<PressurePolicy>
}

type MagicContextDshConfigDefineTool = typeof import('@deepseek-ai/dsh-tools')['defineTool']

export const name = 'magic-context-dsh-poc'

/**
 * Required host services. Declaring the injection makes the loader wait for
 * availability (a bare `ctx.get()` does not) and unlocks guarded property
 * access inside apply. A host without a tools registry or LLM seam pends this
 * plugin visibly instead of half-mounting it.
 */
export const inject = ['tools', 'llm']

/** Seam-local listener signatures (kept here so upstream renames touch one file). */
type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepEnterDecision | { kind: 'reject' }>,
) => Promise<PreStepEnterDecision | { kind: 'reject' }>

type ContentBlock0 = import('./dsh/seams.ts').ContentBlock

type PostToolDecision = {
  kind: 'accept' | 'block'
  content?: ContentBlock0[]
  value?: unknown
  feedback?: ContentBlock0[]
}

type PostToolExecuteListener = (
  exec: { readonly callId: string; readonly name: string; readonly agent?: { readonly session: { readonly id: string } } },
  result: { readonly isError: boolean; readonly content: readonly ContentBlock0[] },
  next: () => Promise<PostToolDecision>,
) => Promise<PostToolDecision>

type SessionEventListener = (
  session: { readonly id: string },
  event: SessionEvent,
) => void

type RequestErrorListener = (
  payload: {
    readonly agent: { readonly session: Parameters<typeof enumerateSurfaceToolResults>[0] }
    readonly failure: { readonly code: string }
    readonly signal: AbortSignal
  },
  next: () => Promise<{ kind: 'retry' } | undefined>,
) => Promise<{ kind: 'retry' } | undefined>

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
  /** Consecutive defers per session, keyed by reason, to log transitions only. */
  const deferStreak = new Map<string, { reason: string; count: number }>()
  /** Resolved tool-constructor path, recorded at boot for the review. */
  let toolMode = 'skipped'
  /** The LLM seam (declared inject); the historian's auxiliary call uses it. */
  const llm = (ctx as unknown as { llm?: HistorianLlm }).llm
  /** Reduce-guidance state per session (Channel 1/2 sticky bands, turn counts). */
  const reduceTracker = new ReduceNudgeTracker()
  // ── The memory.enabled gate (objective: gated memory) ─────────────────────
  // `memory` is deliberately NOT declared in the exported Config: a schemastery
  // key would be materialized for every profile and would open the bridge
  // everywhere. It therefore arrives as a plain object, and the gate is simply:
  //   absent config        → off   (no bridge, no writer, no recall, no ctx_memory)
  //   enabled: false       → off   (explicit opt-out; reported as disabled-by-config)
  //   anything else        → on
  // Read once, here, so a disabled adapter can never half-open.
  const memorySettings = config.memory
  const memoryEnabled = memorySettings !== undefined && liveBoolean(memorySettings.enabled, true)
  const memoryRecall = !memoryEnabled
    ? undefined
    : openMemoryBridge({
      ...memorySettings?.dbPath === undefined ? {} : { dbPath: memorySettings.dbPath },
      logger: ctx.logger,
    })
  if (memoryRecall !== undefined) {
    ctx.logger.info(
      `magic-context dsh adapter: memory bridge at ${memoryRecall.dbPath} `
        + `(${memoryRecall.status.ok ? `schema v${String(memoryRecall.status.schemaVersion)}` : `unavailable: ${String(memoryRecall.status.detail)}`})`,
    )
  }
  // The writer opens alongside the reader so facts can become durable
  // memories. Magic Context's default is auto-promote ON; ours follows it,
  // and every write still passes the authority guard (module-managed projects
  // are never written directly).
  const memoryWriter: MemoryWriter | undefined =
    memoryRecall === undefined || (memorySettings?.autoPromote === false && memorySettings?.write === false)
      ? undefined
      : openMemoryWriter({
        // The writer has no default of its own (it must never guess a database
        // to write into), so the caller resolves the shared path here.
        dbPath: memorySettings?.dbPath ?? memoryRecall.dbPath ?? defaultMemoryDbPath(),
        logger: ctx.logger,
      })
  if (memoryWriter !== undefined) {
    const status = memoryWriter.status
    ctx.logger.info(
      `magic-context dsh adapter: memory writer at ${memoryWriter.dbPath} `
        + `(${status.ok ? (status.readOnly === true ? 'read-only' : 'read-write') : `unavailable: ${String(status.detail)}`})`,
    )
  }

  // ── The memory search lane (ctx_memory action `search`) ───────────────────
  // A read-only twin of MC ctx_search's memory half: FTS5 + stored-vector
  // cosine with MC's 0.7/0.3 fusion (memory-search.ts). The embedder loads
  // lazily on first use; any failure degrades the lane to FTS-only instead of
  // failing the tool call.
  const memorySearch: MemorySearch | undefined =
    memoryEnabled && memoryRecall?.status.ok === true
      ? openMemorySearch({ dbPath: memorySettings?.dbPath ?? memoryRecall.dbPath, logger: ctx.logger })
      : undefined
  if (memorySearch !== undefined) {
    ctx.logger.info('magic-context dsh adapter: memory search lane open (FTS + local MiniLM)')
  }
  // B4 gates only the BACKFILL lane below; the embedder itself stays available
  // for the query-side embedding that scores the STORED vectors.
  const embedBackfill = liveBoolean(config.memory?.embedBackfill, false)
  const embedder = memorySearch === undefined
    ? undefined
    : openLocalEmbedder({
      cacheDir: defaultEmbeddingCacheDir(stores.dbPath),
      logger: { info: (message) => ctx.logger.info(message), warn: (message) => ctx.logger.warn(message) },
    })

  /**
   * Shared-vector-space state, discovered once and memoized: the query-side
   * embedder must prove cosine parity against a stored vector before the lane
   * reads shared vectors. Magic Context fences vectors per model identity
   * (embedding-identity.ts) and the store's dominant identity is whichever
   * configuration produced most rows — parity is verified, never assumed.
   */
  let sharedSpacePromise: Promise<{ modelId: string | null }> | undefined
  const resolveSharedSpace = (): Promise<{ modelId: string | null }> => {
    if (memorySearch === undefined || embedder === undefined) return Promise.resolve({ modelId: null })
    if (sharedSpacePromise === undefined) {
      sharedSpacePromise = (async () => {
        const dominant = memorySearch.dominantEmbeddingModel()
        if (dominant === undefined || dominant.dims !== embedder.dims) return { modelId: null }
        const sample = memorySearch.paritySample(dominant.modelId)
        if (sample === undefined) return { modelId: dominant.modelId }
        try {
          const [vector] = await embedder.embed([sample.content])
          if (vector === undefined) return { modelId: null }
          const parity = cosineSimilarity(vector, sample.embedding)
          ctx.logger.info(
            `magic-context memory search: shared-space parity ${parity.toFixed(4)} `
              + `against ${dominant.modelId.slice(0, 48)}`,
          )
          return parity >= 0.99 ? { modelId: dominant.modelId } : { modelId: null }
        } catch {
          return { modelId: null }
        }
      })()
    }
    return sharedSpacePromise
  }

  /** A2: per-session memory ids the injected block currently renders
   *  (MC getVisibleMemoryIds, in-memory: absent = don't filter). */
  const visibleMemoryIdsBySession = new Map<string, Set<number>>()

  /** The ctx_memory `search` closure: bridge space + shared-space gate. */
  const memorySearchForTool = memorySearch === undefined
    ? undefined
    : async (request: { query: string; limit?: number; identity: string; visibleMemoryIds?: ReadonlySet<number> }) => {
      const bridge = memoryRecall
      if (bridge === undefined) return { ok: false as const, reason: 'memory search is not available' }
      const space = bridge.searchSpace(request.identity)
      if (space === undefined) {
        return { ok: false as const, reason: 'no project identity could be resolved for this session' }
      }
      const { modelId } = await resolveSharedSpace()
      let queryEmbedding: Float32Array | null = null
      if (embedder !== undefined && modelId !== null) {
        try {
          const [vector] = await embedder.embed([request.query])
          queryEmbedding = vector ?? null
        } catch {
          queryEmbedding = null
        }
      }
      const outcome = await memorySearch.search({
        query: request.query,
        ...request.limit === undefined ? {} : { limit: request.limit },
        now: Date.now(),
        space: {
          ownIdentities: space.ownIdentities,
          foreignIdentities: space.foreignIdentities,
          shareCategories: space.shareCategories ?? [...DEFAULT_SHARE_CATEGORIES],
        },
        queryEmbedding,
        queryModelId: modelId,
        ...request.visibleMemoryIds === undefined ? {} : { visibleMemoryIds: request.visibleMemoryIds },
        // B4: the in-memory fill lane is off unless memory.embedBackfill —
        // scoring then uses only the store's persisted vectors.
        ...embedBackfill && embedder !== undefined ? {
          embedTexts: async (texts: readonly string[]) => {
            const vectors = await embedder.embed(texts)
            return vectors.length === texts.length ? vectors : null
          },
        } : {},
      })
      return outcome.ok
        ? { ok: true as const, text: outcome.text, hits: outcome.hits.map(hit => ({ id: hit.id })) }
        : { ok: false as const, reason: outcome.reason }
    }

  /**
   * One wording for the writer's state, used by both the boot log and the
   * `memory_write` meta the GUI (plugin page / telemetry badge) reads.
   * A contract-version fence keeps `status.ok === true` because reads still
   * work, so `readOnly` must be checked explicitly — otherwise a fully
   * read-only writer would advertise itself as `read-write` (measured on a
   * real-store copy whose schema_migrations was raised to v95).
   */
  const describeMemoryWrite = (): string => {
    const status = memoryWriter?.status
    if (status === undefined) {
      return memorySettings === undefined ? 'off' : memoryEnabled ? 'off' : 'disabled-by-config'
    }
    if (!status.ok) return `unavailable: ${String(status.detail)}`
    if (status.readOnly === true) {
      return `read-only: ${String(status.detail ?? 'contract version is newer than the adapter understands')}`
    }
    return `read-write${memorySettings?.autoPromote === false ? ' (promotion off)' : ' auto-promote'}`
  }

  const disposers: Array<() => void> = []
  const on = (name: string, listener: unknown): void => {
    disposers.push((ctx.on as unknown as (n: string, l: unknown) => () => void).call(ctx, name, listener))
  }

  // ── §N§ tags on the admitted user batch (Phase 0) ──────────────────────────
  on(DSH_EVENTS.preStep, async (payload: PreStepPayload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const sessionId = payload.agent.session.id
    const messages = decision.messages.map((message) => {
      const firstText = message.content.find(block => block.type === 'text')
      if (firstText !== undefined && typeof firstText.text === 'string' && /^§\d+§/.test(firstText.text)) {
        return message
      }
      // Fail-open: this runs BEFORE the guarded section below, and a closed
      // store (mid-remount) must degrade to an untagged message, never fail
      // the turn (measured live: `database is not open` here interrupted a
      // session across a plugin reload).
      try {
        const tag = ensureTag(stores, sessionId, { kind: 'user-message', messageId: message.id })
        return tagUserMessage(message, tagPrefix, tag)
      } catch (error) {
        ctx.logger.warn(
          `magic-context: message tagging skipped (${errText(error)})`,
        )
        return message
      }
    })
    // Reduce guidance (desk section + Channel 1/2) is wired through the
    // SystemPrompt service below — a static section and a dynamic context —
    // not by rewriting messages here. The only preStep duty is the REAL USER
    // TURN counter the sticky refire gap needs: observing the newest message
    // id is idempotent per step, so repeated preSteps on one turn count once.
    if (liveBoolean(config.reduceGuidance, true)) {
      try {
        const newest = messages.at(-1)
        if (newest !== undefined) reduceTracker.observeUserMessage(sessionId, newest.id)
      } catch {
        // counting is advisory; never fail the turn for it
      }
    }

    // Cross-project drift observation: the turn's own text is the only signal
    // DSH gives about WHERE work is happening (there is no per-turn working
    // directory). Foreign git roots in the newest message get one warn-level
    // journal row per turn — the data that quantifies how often cross-project
    // sessions actually happen (and whether facts land in the wrong project).
    try {
      const newestMessage = messages.at(-1)
      const driftText = newestMessage === undefined
        ? ''
        : newestMessage.content
          .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
          .join('\n')
      if (driftText.length >= 8) {
        const drift = detectProjectDrift(driftText, payload.agent.session.header.cwd)
        if (drift !== undefined) {
          journal?.warn('project-drift', `cross-project work observed (${String(drift.foreignRoots.length)} foreign root(s))`, {
            sessionRoot: drift.sessionRoot,
            foreignRoots: drift.foreignRoots,
          }, sessionId)
        }
      }
    } catch {
      // observation only; never fail the turn for it
    }

    // Register the session's project identity for the maintenance sweep HERE,
    // not only in the pass-execute branch: a quiet conversation never crosses
    // the compaction threshold, and the sweep then had no identity to serve —
    // every tick spun empty (measured live 18:24, zero maintenance rows after
    // a remount despite an active session).
    try {
      const projectSpec = config.memory?.project ?? payload.agent.session.header.cwd
      const memoryIdentity = projectSpec === undefined ? undefined : resolveIdentitySpec(projectSpec)
      if (memoryIdentity !== undefined) {
        seenIdentities.add(memoryIdentity)
        sessionIdentity.set(sessionId, memoryIdentity)
        if (sessionIdentity.size > 512) {
          const oldest = sessionIdentity.keys().next().value
          if (oldest !== undefined) sessionIdentity.delete(oldest)
        }
      }
    } catch {
      // registration is advisory; never fail the turn for it
    }

    // ── Pressure decision + the execute-band management pass (Phase 1 + 2) ──
    // The session surface is only mutated inside the execute band: that is
    // the one permission under which a priced bust buys reclaim (MC's
    // "drops land on the next bust cycle", translated to durable surface).
    try {
      if (!seenSessions.has(sessionId)) {
        seenSessions.add(sessionId)
        journal?.info('session-first-seen', 'session first seen by the adapter', {
          turn: payload.turn,
          step: payload.step,
        }, sessionId)
      }
      const latest = stores.latestUsage(sessionId)
      const context = requestContextOf(payload.agent.session)
      const pressure = pressurePercent(latest, context.contextWindow)
      // Live thresholds: a settings-form edit reaches this pass immediately.
      const policy = activePolicy()
      const pass = decidePass({ latest, pressure, now: Date.now(), policy })
      const usage = latest === undefined ? undefined : {
        input: latest.inputTokens ?? 0,
        cacheRead: latest.cacheReadTokens ?? 0,
        cacheWrite: latest.cacheWriteTokens ?? 0,
      }
      const basePassData = {
        reason: pass.reason,
        pressure: pressure === undefined ? undefined : Number(pressure.toFixed(1)),
        contextWindow: context.contextWindow,
        route: context.provider === undefined || context.model === undefined
          ? undefined
          : `${context.provider}/${context.model}`,
        usage,
      }
      if (pass.kind === 'execute') {
        // The project identity is resolved once per pass (the git lookup is
        // cached for the process). An explicit `git:`/`dir:` value is already
        // an identity; only a directory has to be resolved.
        const projectSpec = config.memory?.project ?? payload.agent.session.header.cwd
        const memoryIdentity = projectSpec === undefined
          ? undefined
          : resolveIdentitySpec(projectSpec)
        // The maintenance sweep maintains every identity this process has
        // actually served (the configured project is added unconditionally),
        // and the session→identity map scopes the telemetry panel's stats to
        // the project the viewed conversation is working on.
        if (memoryIdentity !== undefined) {
          seenIdentities.add(memoryIdentity)
          if (sessionId !== undefined) {
            sessionIdentity.set(sessionId, memoryIdentity)
            if (sessionIdentity.size > 512) {
              const oldest = sessionIdentity.keys().next().value
              if (oldest !== undefined) sessionIdentity.delete(oldest)
            }
          }
        }
        const memories = memoryRecall?.recall({
          ...projectSpec === undefined ? {} : { project: projectSpec },
          workspaceProjects: config.memory?.workspaceProjects,
          shareCategories: config.memory?.shareCategories,
          budgetTokens: policy.memoryBudgetTokens,
          limit: policy.memoryLimit,
          // B2 (MC m0_compose.rs:104-116): the frozen prefix evaluates expiry
          // against the HARD-rebuild clock — a row expiring mid-cycle must not
          // bust the cache. The next HARD rebuild re-composes with a live clock
          // and freezes the new time.
          now: stores.baselineState(sessionId)?.frozenAt ?? Date.now(),
          // The additive lane: everything above the stored watermark is an
          // in-session addition and renders in m[1], keeping m[0] byte-stable.
          ...stores.baselineState(sessionId)?.maxMemoryId === undefined
            ? {}
            : { maxMemoryId: stores.baselineState(sessionId)?.maxMemoryId },
        })
        // A2 (MC getVisibleMemoryIds): the ids the injected block renders NOW
        // are what ctx_memory search suppresses as already-visible. Replaced
        // per pass, process-memory only, fail-open when absent.
        if (memories !== undefined) {
          visibleMemoryIdsBySession.delete(sessionId)
          visibleMemoryIdsBySession.set(sessionId, new Set<number>([
            ...memories.rows.map(row => row.id),
            ...memories.newRows.map(row => row.id),
          ]))
          if (visibleMemoryIdsBySession.size > 256) {
            const oldest = visibleMemoryIdsBySession.keys().next().value
            if (oldest !== undefined) visibleMemoryIdsBySession.delete(oldest)
          }
        }
        // The watermark is read straight from the store, so a HARD rebuild can
        // freeze it even when this pass recalled no rows at all (the first
        // pass of a fresh session, which is exactly when it matters).
        const currentMaxMemoryId = memoryRecall?.maxMemoryId(projectSpec) ?? 0
        // The NON-additive lane (contract §6): `memory_mutation_log` rows above
        // the frozen cursor render as `<memory-updates>` in the m[1] region, so
        // an update/archive/supersede reaches the model without rebuilding m[0].
        // `afterId` is the cursor frozen by the last HARD rebuild (0 for a
        // session that never folded), and the epoch fingerprint is passed on
        // EVERY pass: management-pass only flags an epoch change when both the
        // previous fingerprint and this one are present.
        const mutations = memoryRecall?.mutations({
          ...projectSpec === undefined ? {} : { project: projectSpec },
          workspaceProjects: config.memory?.workspaceProjects,
          shareCategories: config.memory?.shareCategories,
          afterId: stores.baselineState(sessionId)?.maxMemoryMutationId ?? 0,
          limit: policy.memoryLimit,
          now: Date.now(),
        })
        if (memories !== undefined && (memories.lines.length > 0 || memories.newLines.length > 0)) {          journal?.info(
            'memory-recall',
            `recalled ${String(memories.rows.length)} project memories into m[0]`
              + `${memories.newLines.length > 0 ? `, ${String(memories.newLines.length)} new in m[1]` : ''}`,
            {
              rows: memories.rows.length,
              newRows: memories.newLines.length,
              digest: memories.digest.slice(0, 12),
              budgetTokens: policy.memoryBudgetTokens,
              estTokens: memories.lines.reduce((total, line) => total + Math.ceil(line.length / 4), 0),
              identity: memories.identity,
              maxMemoryId: memories.currentMaxMemoryId,
              workspace: memories.workspace,
              members: memories.members?.length,
              projects: [...new Set(memories.rows.map(row => row.projectPath.slice(0, 24)))],
            },
            sessionId,
          )
        }
        const outcome = runManagementPass({
          session: payload.agent.session,
          sessionId,
          stores,
          policy,
          logger: ctx.logger,
          pass,
          pressure,
          ...journal === undefined ? {} : { journal },
          ...context.provider === undefined || context.model === undefined
            ? {}
            : { route: { provider: context.provider, model: context.model } },
          ...context.contextWindow === undefined ? {} : { contextWindow: context.contextWindow },
          ...liveBoolean(config.historianEnabled, true) === false || llm === undefined
            ? {}
            : {
              historian: {
                llm,
                ...config.historian === undefined ? {} : { route: config.historian },
              },
            },
          ...memoryRecall === undefined
            ? {}
            : {
              memories: {
                digest: memories?.digest ?? '',
                lines: memories?.lines ?? [],
                newLines: memories?.newLines ?? [],
                // An `update` on a memory that is still above the watermark
                // writes a mutation-log row without changing the id, so the row
                // would otherwise render once in `<new-memories>` (current
                // content) and again in `<memory-updates>` (same content).
                // Passing the ids lets the renderer suppress the duplicate.
                newMemoryIds: memories?.newRows.map(row => row.id) ?? [],
                // MC only announces a mutation whose target is a row the m[0]
                // baseline actually rendered (inject-compartments.ts:2843-2848):
                // mutations for budget-truncated rows would be phantom pointers.
                baselineIds: memories?.rows.map(row => row.id) ?? [],
                // A1: the pre-budget visible set — the authority for forced
                // rows in `<memory-updates>`/`<new-memories>`
                // (inject-compartments.ts:2822-2869).
                eligibleIds: memories?.eligibleIds ?? [],
                eligibleRows: memories?.eligibleRows ?? [],
                maxMemoryId: currentMaxMemoryId,
              },
            },
          // `cursor` is deliberately the CURRENT max mutation id, not the paged
          // read cursor: on a HARD rebuild m[0] swallows everything up to now,
          // so freezing a partial page would re-render rows it already folded.
          ...mutations === undefined
            ? {}
            : {
              memoryUpdates: {
                updates: mutations.updates,
                cursor: mutations.currentCursor,
                projectEpochFingerprint: mutations.projectEpochFingerprint,
              },
            },
          ...memoryWriter === undefined || memoryIdentity === undefined || config.memory?.autoPromote === false
            ? {}
            : { memoryPromote: (promote: { identity: string; facts: readonly MemoryFact[]; sessionId: string }) => memoryWriter.promoteFacts(promote), memoryIdentity },
        })
        journal?.info('pass', `execute (${pass.reason}) at ${pressure?.toFixed(1) ?? '?'}%`, {
          decision: 'execute',
          ...basePassData,
          landed: outcome.landedDrops,
          published: outcome.published,
          forceDropped: outcome.forceDropped,
          baseline: outcome.baselineUpdated ? 'refreshed' : 'unchanged',
          historianStarted: outcome.historianStarted,
          // Net reclaim proof: surface estimate before/after this pass.
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
          tokensDelta: outcome.tokensAfter - outcome.tokensBefore,
          factsPromoted: outcome.factsPromoted,
          factsSeenAgain: outcome.factsSeenAgain,
        }, sessionId)
        // Channel A of the live session stream: one notice entry per pass
        // that actually did something (publish / force-drop / promotion).
        // `appendSessionNotice` is fail-open and quiet on nothing-notable.
        if (liveBoolean(config.sessionNotices, true)) {
          const notice = appendSessionNotice({ session: payload.agent.session, result: outcome })
          if (notice.ok) {
            journal?.info('session-notice', notice.summary, { seq: notice.seq }, sessionId)
          } else if (notice.reason === 'append-failed') {
            journal?.warn('session-notice', `notice append failed: ${notice.detail ?? '?'}`, {
              detail: notice.detail,
            }, sessionId)
          }
        }
        deferStreak.delete(sessionId)
      } else {
        // Defer passes repeat every step: record the reason TRANSITIONS only,
        // carrying how many consecutive defers shared the current reason, so
        // the journal stays reviewable instead of flooding.
        const streak = deferStreak.get(sessionId)
        if (streak === undefined || streak.reason !== pass.reason) {
          deferStreak.set(sessionId, { reason: pass.reason, count: 1 })
          journal?.info('pass', `defer (${pass.reason}) at ${pressure?.toFixed(1) ?? '?'}%`, {
            decision: 'defer',
            ...basePassData,
            consecutive: 1,
          }, sessionId)
        } else {
          streak.count += 1
        }
      }
    } catch (error) {
      const detail = errText(error)
      journal?.error('error', `management pass failed: ${detail}`, { scope: 'pre-step', detail }, sessionId)
      // A failed management pass must never wedge the turn: log and continue
      // with the tagged messages (MC per-turn fail-open). The next pass
      // re-decides from durable state.
      ctx.logger.warn(`magic-context: management pass failed (continuing): ${detail}`)
    }

    return { ...decision, messages }
  })

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
  // Desk section: a STATIC prompt section (identical bytes every assembly, so
  // the system prompt stays prefix-cache stable). Channel 1/2: a DYNAMIC
  // context whose provider re-measures the unstamped tail at every assembly
  // and renders the MC reminder copy only when a band fires — an empty text
  // contributes nothing. Both live in the calling scope; dispose on teardown.
  if (liveBoolean(config.reduceGuidance, true)) {
    ctx.inject(['systemPrompt'], (scope) => {
      const systemPrompt = (scope as unknown as {
        systemPrompt: {
          section(section: { name: string; text: string; order?: number }): () => void
          context(context: { name: string; order: number; text: (assembly: unknown) => string }): () => void
        }
      }).systemPrompt
      scope.effect(() => systemPrompt.section({
        name: 'magic-context-desk',
        text: buildDeskSection(memoryEnabled),
        order: 900,
      }))
      scope.effect(() => systemPrompt.context({
        name: 'magic-context-reduce',
        order: 910,
        text: (assembly: unknown) => {
          try {
            const agent = (assembly as { agent?: { session?: { id: string } } }).agent
            const sessionId = agent?.session?.id
            if (sessionId === undefined) return ''
            const tagged = enumerateSurfaceToolResults(agent!.session, callId =>
              stores.getTag(sessionId, { kind: 'tool-result', callId }))
              .filter(node => node.tagNumber !== undefined)
            if (tagged.length === 0) return ''
            const tailToolTokens = tagged.reduce((total, node) => total + Math.ceil(node.textLength / 4), 0)
            const undropped = tagged.filter(node => !node.isPlaceholder)
            const undroppedTokens = undropped.reduce((total, node) => total + Math.ceil(node.textLength / 4), 0)
            const state = reduceTracker.state(sessionId)
            const nudge = decideReduceNudge({
              tailToolTokens,
              undroppedTokens,
              realUserTurnCount: state.realUserTurnCount,
              ...state.lastBand === undefined ? {} : { lastBand: state.lastBand },
              lastOrdinal: state.lastOrdinal,
              ...state.lastOrdinalTurn === undefined ? {} : { lastOrdinalTurn: state.lastOrdinalTurn },
            })
            reduceTracker.record(sessionId, nudge, 0)
            if (!nudge.fire || nudge.level === undefined) return ''
            const hints = undropped.slice(0, 4).map(node => ({ tagNumber: node.tagNumber as number }))
            const reminder = nudge.level === 'channel2'
              ? buildChannel2Reminder(undroppedTokens, undropped.length, hints)
              : buildChannel1Reminder(nudge.level, undroppedTokens, undropped.length, hints, nudge.sticky)
            journal?.info('pass', `reduce nudge (${nudge.level})`, {
              decision: 'reduce-nudge',
              band: nudge.band,
              tailToolTokens,
              undroppedTokens,
            }, sessionId)
            return reminder
          } catch {
            // A closed store mid-remount must degrade to no reminder.
            return ''
          }
        },
      }))
    })
  }

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
        registrar.register(defineCtxMemoryTool({
          ...defineTool === undefined ? {} : { defineTool },
          ...journal === undefined ? {} : { journal },
          ...memoryWriter === undefined || config.memory?.write === false ? {} : { writer: memoryWriter },
          ...memorySearchForTool === undefined ? {} : { search: memorySearchForTool },
          // A2: ctx_memory search suppresses rows this session's injected
          // block already renders (MC getVisibleMemoryIds).
          visibleMemoryIdsOf: exec => {
            const sessionId = exec?.agent?.session?.id
            return sessionId === undefined ? undefined : visibleMemoryIdsBySession.get(sessionId)
          },
          resolveIdentity: exec => {
            const spec = config.memory?.project ?? exec?.agent?.session.header.cwd
            return spec === undefined ? undefined : resolveIdentitySpec(spec)
          },
          // The `project` argument's resolver: an explicit absolute path (another
          // project the model is working on) through the same normalizer. DSH has
          // no per-turn working directory, so the model naming the project is the
          // only cross-project scoping signal we have.
          resolveIdentityOf: spec => {
            try {
              return resolveIdentitySpec(spec)
            } catch {
              return undefined
            }
          },
          recall: (request, exec) => {
            // The read path must resolve the SAME identity the writes use. The
            // tool hands us the identity it already resolved (`request.identity`,
            // set by tool-bridge); otherwise fall back to the configured project
            // or this run's cwd, resolved through the same normalizer.
            //
            // This closure used to reference a free `exec` — and because `&&`
            // binds tighter than `?:`, `config.memory?.project === undefined &&
            // exec.agent...` evaluated the right-hand side in the DEFAULT
            // configuration, throwing `ReferenceError: exec is not defined` on
            // every ctx_memory call (measured live). Configuring memory.project
            // short-circuited it, which is why the tests never saw it.
            const spec = (request as { identity?: string }).identity
              ?? config.memory?.project
              ?? (exec === undefined ? undefined : exec.agent?.session.header.cwd)
            const project = spec === undefined ? undefined : resolveIdentitySpec(spec)
            // A fenced/unreadable store must say so: `{ empty: true }` would read
            // as "this project has no memories", which is a different fact.
            if (!memoryRecall.status.ok) {
              return { lines: [], digest: 'unavailable', reason: String(memoryRecall.status.detail) }
            }
            const recalled = memoryRecall.recall({
              ...project === undefined ? {} : { project },
              workspaceProjects: config.memory?.workspaceProjects,
              shareCategories: config.memory?.shareCategories,
              budgetTokens: activePolicy().memoryBudgetTokens,
              limit: request.limit ?? activePolicy().memoryLimit,
              now: Date.now(),
              ...request.query === undefined ? {} : { query: request.query },
            })
            if (recalled === undefined) return undefined
            // Explicit-retrieval telemetry (contract §9.1): hand back the ids the
            // agent actually received so the tool can bump `retrieval_count`.
            // The automatic m[0]/m[1] injection does NOT pass through here, so it
            // can never inflate the counter.
            return {
              lines: recalled.lines,
              digest: recalled.digest,
              ids: [...recalled.rows, ...recalled.newRows].map(row => row.id),
            }
          },
        }))
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
    ctx.logger.info('magic-context dsh adapter: /ctx-status registered')
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
      memoryStats: (sessionId?: string) => {
        if (memoryWriter === undefined) return undefined
        const identity = config.memory?.project
          ?? (sessionId !== undefined ? sessionIdentity.get(sessionId) : undefined)
          ?? [...seenIdentities][0]
        if (identity === undefined) return undefined
        try {
          const stats = memoryWriter.stats(identity)
          return { total: stats.rows, verified: stats.verified, unverified: stats.unverified }
        } catch {
          return undefined
        }
      },
      maintenanceLast: () => maintenanceLast,
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

  // ---- Maintenance tick (the adapter's slice of MC's dreamer) ----------------
  // TTL expiry always runs when the writer is writable; LLM verification needs
  // an explicit `maintenance.verifyRoute` because a tick has no session to
  // inherit a route from. The sweep covers the configured project plus every
  // identity this process resolved for a session. Fail-open end to end: a
  // broken tick journals and waits for the next one.
  const seenIdentities = new Set<string>()
  /** Session → project identity, so panel stats answer for the viewed project. */
  const sessionIdentity = new Map<string, string>()
  /** Newest maintenance tally, surfaced by the telemetry panel (dreamer KPI). */
  let maintenanceLast: { at: number; expired: number; verified: number; updated: number; archived: number } | undefined
  let maintenanceBusy = false
  const runMaintenance = async (): Promise<void> => {
    if (maintenanceBusy || adapterDisposed || stores.closed || journal === undefined) return
    if (liveBoolean(config.maintenance?.enabled, true) === false) return
    maintenanceBusy = true
    try {
      const identities = new Set<string>()
      if (config.memory?.project !== undefined) identities.add(config.memory.project)
      for (const identity of seenIdentities) identities.add(identity)
      for (const identity of identities) {
        const verifyProvider = liveString(config.maintenance?.verifyProvider, '')
        const verifyModel = liveString(config.maintenance?.verifyModel, '')
        const routeReady = verifyProvider.length > 0 && verifyModel.length > 0
        const outcome = await runMaintenanceTick({
          writer: memoryWriter,
          identity,
          sessionId: 'mc-maintenance',
          journal,
          ...(llm === undefined || !routeReady ? {} : { llm: llm as unknown as MaintenanceLlm, route: { provider: verifyProvider, model: verifyModel } }),
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
    } catch (error) {
      journal.error('maintenance', `maintenance tick failed: ${errText(error)}`)
    } finally {
      maintenanceBusy = false
    }
  }
  const maintenanceTimer = setInterval(() => { void runMaintenance() }, Math.max(60_000, liveNumber(config.maintenance?.intervalMs, 1_800_000)))
  const maintenanceFirst = setTimeout(() => { void runMaintenance() }, 60_000)
  ;(maintenanceTimer as unknown as { unref?: () => void }).unref?.()
  ;(maintenanceFirst as unknown as { unref?: () => void }).unref?.()
  disposers.push(() => {
    clearInterval(maintenanceTimer)
    clearTimeout(maintenanceFirst)
  })

  // The occupancy gauge the native meter shows, from the SAME source: the
  // host's `contextPressure` projection. projectedTokens is the last
  // request's prompt-side usage plus the surface's signed movement since the
  // sample — the answer for the NEXT request, not the last-request bill our
  // pass ledger carries (the two read differently and the user noticed).
  // Every distinct reading lands once in the journal; telemetry serves the
  // newest to the panel so both gauges agree.
  ctx.inject(['sessionProjections'], (scope) => {
    if (journal === undefined) return
    const registry = (scope as unknown as {
      sessionProjections: {
        onChanged(listener: (session: { id?: string }, key: string, value: unknown) => void): () => void
      }
    }).sessionProjections
    const lastBySession = new Map<string, string>()
    const disposeListener = registry.onChanged((session, key, value) => {
      try {
        if (key !== 'contextPressure') return
        const reading = value as { projectedTokens?: number; pressureTokens?: number; contextWindow?: number }
        const signature = JSON.stringify([reading.projectedTokens, reading.pressureTokens, reading.contextWindow])
        const sid = typeof session?.id === 'string' ? session.id : ''
        if (lastBySession.get(sid) === signature) return
        lastBySession.set(sid, signature)
        if (lastBySession.size > 64) {
          const oldest = lastBySession.keys().next().value
          if (oldest !== undefined) lastBySession.delete(oldest)
        }
        const used = reading.projectedTokens ?? reading.pressureTokens ?? 0
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

/** Same as {@link liveNumber} for strings (volatile enums such as log level). */
function liveString(value: unknown, fallback: string): string {
  const resolved = liveValue(value)
  return typeof resolved === 'string' && resolved.length > 0 ? resolved : fallback
}

/**
 * Unwrap a schemastery volatile reference chain. Nested config objects wrap
 * each level, so `config.a?.b?.c` can hand back a reference whose `.get()`
 * is itself a reference — one dereference is not always enough (measured:
 * `maintenance.verifyProvider` printed `[object Object]` with single unwrap).
 */
function liveValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return liveValue((value as { get(): unknown }).get())
  }
  return value
}

/** Read a value that may be a plain number or a volatile reference. */
function liveNumber(value: unknown, fallback: number): number {
  const resolved = liveValue(value)
  return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : fallback
}

/** Same as {@link liveNumber} for booleans (volatile toggles). */
function liveBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    const current = (value as { get(): unknown }).get()
    if (typeof current === 'boolean') return current
  }
  return fallback
}

/**
 * The effective pressure policy, evaluated AT THE DECISION POINT.
 *
 * This is what makes a settings-form edit take effect without a restart: the
 * form writes a volatile value, the loader commits it into the reference, and
 * the next pass re-reads it here.
 */
export function policyOf(configured: Partial<PressurePolicy> | undefined): PressurePolicy {
  const raw = (configured ?? {}) as Record<string, unknown>
  const policy: PressurePolicy = { ...DEFAULT_POLICY }
  for (const key of Object.keys(DEFAULT_POLICY) as Array<keyof PressurePolicy>) {
    const value = raw[key]
    if (value === undefined) continue
    const fallback = DEFAULT_POLICY[key]
    if (typeof fallback === 'number') {
      policy[key] = liveNumber(value, fallback) as never
    } else if (typeof fallback === 'boolean') {
      policy[key] = liveBoolean(value, fallback) as never
    } else {
      policy[key] = value as never
    }
  }
  return policy
}

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
