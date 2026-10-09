/**
 * The preStep band: the real-user-turn counter, cross-project drift
 * observation, maintenance identity registration, and the pressure decision
 * with its execute-band management pass. Moved verbatim out of index.ts; the
 * closure locals the body used are now the destructured fields of
 * {@link PreStepDeps} so the moved code keeps its names.
 *
 * Admission stamps nothing. §N§ handles belong to tool results (index.ts, on
 * `tools/post-execute`), the only content the reclaim lanes can resolve — a
 * handle on a user message or on a host-injected context node is dead weight
 * that also leaks into the record and the derived title (see preStepListener).
 *
 * Also home to the reduce-guidance SystemPrompt injection (the desk section
 * and the Channel 1/2 dynamic context) — the other half of the guidance band.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterStores } from '../core/stores.ts'
import type { Journal } from '../core/journal.ts'
import { decidePass, pressurePercent, pressureWindowTokens, type PressurePolicy } from '../core/policy.ts'
import { PROFILE_M0_BUDGET_TOKENS, resolveIdentitySpec } from '../core/memory-bridge.ts'
import type { MemoryFact } from '../core/memory-categories.ts'
import { errText } from '../core/types.ts'
import {
  DSH_EVENTS,
  type PreStepEnterDecision,
  type PreStepPayload,
  type Session,
  type UserMessage,
  enumerateSurfaceToolResults,
  requestContextOf,
  wireStrandedResults,
} from './seams.ts'
import { runManagementPass } from './management-pass.ts'
import type { HistorianLlm } from './historian.ts'
import {
  buildChannel1Reminder,
  buildChannel2Reminder,
  buildDeskSection,
  decideReduceNudge,
  type ReduceNudgeTracker,
} from './reduce-guidance.ts'
import { appendSessionNotice } from './session-notice.ts'
import { detectProjectDrift } from './project-drift.ts'
import type { MagicContextDshConfig } from './config.ts'
import type { MemoryLane } from './memory-lane.ts'
import { liveBoolean } from './volatile.ts'
import { planSearchHint, type SearchHintTracker } from './search-hint.ts'

/** Identities shared by the preStep, the maintenance sweep and the panel. */
export interface PreStepProjects {
  /** Every identity this process has actually served (sweep scope). */
  seenIdentities: Set<string>
  /** Session → project identity, so panel stats answer for the viewed project. */
  sessionIdentity: Map<string, string>
}

export interface PreStepDeps {
  ctx: Context
  config: MagicContextDshConfig
  stores: AdapterStores
  journal: Journal | undefined
  /** The LLM seam (declared inject); the historian's auxiliary call uses it. */
  llm: HistorianLlm | undefined
  reduceTracker: ReduceNudgeTracker
  lane: MemoryLane
  projects: PreStepProjects
  /** Sessions already announced, so the journal gets exactly one first-seen row. */
  seenSessions: Set<string>
  /** Live thresholds: a settings-form edit reaches the next pass immediately. */
  activePolicy: () => PressurePolicy
  /** Auto-search hint state: one hint per user turn, shared across preSteps. */
  searchHints?: SearchHintTracker
}

/**
 * The newest REAL user prompt in this request, for the auto-search hint. Host
 * context nodes and this adapter's own entries are user-role messages too, so they
 * are skipped by their markers instead of by role alone.
 */
function latestUserPromptText(
  messages: readonly unknown[],
): { readonly text: string; readonly turnKey: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { id?: unknown; role?: unknown; content?: unknown } | undefined
    if (message === undefined || message.role !== 'user' || !Array.isArray(message.content)) continue
    const text = (message.content as Array<{ type?: string; text?: unknown }>)
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
    if (text.trim().length === 0) continue
    if (text.includes('<magic-context>') || text.startsWith('Magic Context ·')) continue
    return { text, turnKey: typeof message.id === 'string' ? message.id : text.slice(0, 64) }
  }
  return undefined
}

/** The seam-local listener shape (kept here so upstream renames touch one file). */
export type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepEnterDecision | { kind: 'reject' }>,
) => Promise<PreStepEnterDecision | { kind: 'reject' }>

export function preStepListener(deps: PreStepDeps): PreStepListener {
  const { ctx, config, stores, journal, llm, reduceTracker, lane, projects, seenSessions, activePolicy } = deps
  const { seenIdentities, sessionIdentity } = projects
  const { memoryRecall, memoryWriter, profileWriter, visibleMemoryIdsBySession } = lane
  /** Consecutive defers per session, keyed by reason, to log transitions only. */
  const deferStreak = new Map<string, { reason: string; count: number }>()
  /** One-shot flag: a drifted pre-step payload must warn once, not every step. */
  let payloadDriftWarned = false

  return async (payload: PreStepPayload, next): Promise<PreStepEnterDecision | { kind: 'reject' }> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    // Shape-tolerant identity read: this line sits BEFORE every fail-open band
    // below, so a host refactor that drops `agent` from the pre-step payload
    // (the agent dispatcher injects it today) would otherwise throw into the
    // host's waterfall and fail the whole turn. Skipping this step's adapter
    // work degrades to "adapter idle" instead; the doctor heartbeat is what
    // surfaces the drift durably.
    const sessionId = payload.agent?.session?.id
    if (sessionId === undefined) {
      if (!payloadDriftWarned) {
        payloadDriftWarned = true
        journal?.error('error', 'pre-step payload has no agent.session.id — adapter bands skipped this step (host payload drift?)', { scope: 'pre-step' })
      }
      return decision
    }
    // Admission stamps NOTHING — deliberately. The reclaim lanes (ctx_reduce /
    // ctx_expand, drop landing, emergency reclaim) resolve tags against surface
    // TOOL RESULTS only, so a handle on a user message or on a host-injected
    // context node (runtime-context, skill-catalog, time-context) could never be
    // acted on: ctx_reduce would answer "no such tool-output tag on the current
    // surface". Unlike opencode/pi — which stamp a throwaway per-call array, so
    // the stamp never reaches the record — DSH has ONE surface shared by the
    // model and the UI, and no wire-only seam. A dead handle is therefore not
    // free: it shows up in the conversation transcript, and `session-title`
    // derives its deterministic fallback from the first `source: 'user'`
    // message, so it becomes the session title too (measured live: seq 9
    // `§1§ …` -> seq 15 `title: "§1§ 一个新的问题：现在会话"`). Only tool
    // results carry handles; the stream is untouched.
    const messages = decision.messages
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

    // Auto-search hint (upstream `auto-search-runner`): one hint per user turn,
    // built from the user's own words. Awaited, because the hint has to ride
    // the request it was computed for, but every path is fail-open and the
    // search carries its own deadline.
    //
    // The hint does NOT append to the session here. This waterfall band runs
    // BEFORE the host writes step/start and the first system/message, so a
    // direct append on a fresh session's first step took surface node 0 and the
    // loader rejected the log on replay (the 2026-10-09 protected-head
    // incident). The hint instead travels inside the admitted batch: the
    // appendix below joins `decision.messages`, which the host persists after
    // its own system-prompt commits — the head always lands first, on every
    // turn, and the hint still rides this request. First-half stopgap (skip
    // while the surface was headless) retired by this carrier change.
    let hintAppendix: UserMessage | undefined
    if (deps.searchHints !== undefined && liveBoolean(config.searchHint, true)) {
      try {
        const prompt = latestUserPromptText(messages)
        if (prompt !== undefined) {
          const outcome = await planSearchHint(
            {
              search: lane.searchForSession,
              tracker: deps.searchHints,
              ...journal === undefined ? {} : { journal },
            },
            { sessionId, session: payload.agent.session, text: prompt.text, turnKey: prompt.turnKey },
          )
          if (outcome.action === 'hinted') hintAppendix = outcome.message
        }
      } catch {
        // a hint is an optimisation; never fail the turn for it
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
      // Live thresholds: a settings-form edit reaches this pass immediately.
      const policy = activePolicy()
      // A route that discloses no window is scheduled against the assumed one:
      // an undefined denominator defers 'no-window' on every step, so the
      // execute band — and every drop waiting behind it — would never open.
      const pressureWindow = pressureWindowTokens(context.contextWindow, policy)
      const pressure = pressurePercent(latest, pressureWindow)
      const pass = decidePass({
        latest,
        pressure,
        now: Date.now(),
        policy,
        // Iron rule: a stranded tool_result 400s every strict-provider request,
        // so it forces the execute band regardless of pressure.
        wireDefects: wireStrandedResults(payload.agent.session).length,
      })
      const usage = latest === undefined ? undefined : {
        input: latest.inputTokens ?? 0,
        cacheRead: latest.cacheReadTokens ?? 0,
        cacheWrite: latest.cacheWriteTokens ?? 0,
      }
      const basePassData = {
        reason: pass.reason,
        pressure: pressure === undefined ? undefined : Number(pressure.toFixed(1)),
        // The denominator the decision actually used, flagged when it was the
        // assumption rather than the route's own reading.
        contextWindow: pressureWindow,
        ...context.contextWindow === undefined ? { contextWindowAssumed: true } : {},
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
          // S(t) decay scoring (schema v7): the sidecar stats + live config;
          // `enabled` inside gates the ranking takeover, stats always ride.
          ...memoryIdentity === undefined ? {} : { scoring: lane.memoryScoring(memoryIdentity) },
        })
        // WP8: the user profile. Its own read with its own watermark — the
        // profile is unaffected by project identity, and this lane can be
        // switched off (`memory.global.user.render`, default true) without
        // touching memory recall at all.
        const profileEnabled = liveBoolean(config.memory?.global?.user?.render, true)
        const profile = !profileEnabled || memoryRecall === undefined
          ? undefined
          : memoryRecall.profileRecall({
            // Frozen-prefix discipline, same as memory recall: the m[0] profile
            // evaluates against the HARD-rebuild clock, not a live one.
            now: stores.baselineState(sessionId)?.frozenAt ?? Date.now(),
            budgetTokens: PROFILE_M0_BUDGET_TOKENS,
            ...stores.baselineState(sessionId)?.profileWatermark === undefined
              ? {}
              : { maxId: stores.baselineState(sessionId)?.profileWatermark },
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
        // S(t) sidecar (schema v7): recall injections strengthen the rows for
        // future ranking, and the orphan sweep drops stats rows whose memory
        // left the visible pool. Shadow collection — runs whether or not the
        // ranking takeover is enabled. Fail-open: scoring stats are advisory.
        if (memories !== undefined && memoryIdentity !== undefined) {
          try {
            const statsNow = Date.now()
            for (const row of memories.rows) stores.recordMemoryEvent(memoryIdentity, row.id, 'injection', statsNow)
            for (const row of memories.newRows) stores.recordMemoryEvent(memoryIdentity, row.id, 'injection', statsNow)
            const knownIds = new Set<number>(memories.eligibleIds)
            for (const row of memories.newRows) knownIds.add(row.id)
            stores.pruneMemoryStats(memoryIdentity, [...knownIds])
          } catch {
            /* scoring stats are advisory */
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
        if (profile !== undefined && (profile.lines.length > 0 || profile.newLines.length > 0)) {
          journal?.info(
            'profile-recall',
            `injected ${String(profile.lines.length)} profile row(s) into m[0]`
              + `${profile.newLines.length > 0 ? `, ${String(profile.newLines.length)} new in m[1]` : ''}`,
            {
              rows: profile.rows.length,
              newRows: profile.newRows.length,
              digest: profile.digest.slice(0, 12),
              watermark: stores.baselineState(sessionId)?.profileWatermark,
              currentMaxId: profile.currentMaxId,
              estTokens: profile.lines.reduce((total, line) => total + Math.ceil(line.length / 4), 0),
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
          ...profile === undefined ? {} : { profile },
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
          // WP5: the `user` domain's collection switch — read LIVE, so it can be
          // flipped without a remount, and default OFF because this lane stages
          // rows in the shared contract. The historian journals what it staged
          // (including what normalization dropped), so the switch's effect is
          // visible from the journal rather than inferred from the pool size.
          ...profileWriter === undefined || profileWriter.status.ok !== true
            || !liveBoolean(config.memory?.global?.user?.collect, false)
            ? {}
            : {
              profileCollect: (collect: {
                sessionId: string
                observations: readonly string[]
                compartmentStart: number | null
                compartmentEnd: number | null
              }) => profileWriter.recordCandidates(collect),
            },
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
        // `appendSessionNotice` is fail-open, quiet on nothing-notable, and
        // refuses a headless surface (an out-of-band append before the host
        // wrote surface node 0 would make the log unloadable — 2026-10-09
        // incident; see docs/dsh-surface-write-audit-2026-10-09.md). A refusal
        // means the execute band opened on a headless surface, which should be
        // impossible (no surface ⇒ no usage and no wire defects ⇒ defer), so it
        // is journaled as an anomaly rather than silently dropped.
        if (liveBoolean(config.sessionNotices, true)) {
          const notice = appendSessionNotice({ session: payload.agent.session, result: outcome })
          if (notice.ok) {
            journal?.info('session-notice', notice.summary, { seq: notice.seq }, sessionId)
          } else if (notice.reason === 'headless-surface') {
            journal?.warn('session-notice', 'notice suppressed: session surface has no protected head yet', {
              reason: notice.reason,
            }, sessionId)
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

    return { ...decision, messages: hintAppendix === undefined ? messages : [...messages, hintAppendix] }
  }
}

/**
 * Reduce guidance through the SystemPrompt service (MC parity): a STATIC desk
 * section (identical bytes every assembly, so the system prompt stays
 * prefix-cache stable) plus a DYNAMIC context whose provider re-measures the
 * unstamped tail at every assembly and renders the MC reminder copy only when
 * a band fires — an empty text contributes nothing. The listeners dispose with
 * the inject fiber (a scope reload re-runs the whole inject).
 */
export function injectReduceGuidance(deps: PreStepDeps): void {
  const { ctx, config, stores, journal, reduceTracker, lane } = deps
  if (liveBoolean(config.reduceGuidance, true) === false) return
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = (scope as unknown as {
      systemPrompt: {
        section(section: { name: string; text: string; order?: number }): () => void
        context(context: { name: string; order: number; text: (assembly: unknown) => string }): () => void
      }
    }).systemPrompt
    scope.effect(() => systemPrompt.section({
      name: 'magic-context-desk',
      text: buildDeskSection(lane.memoryEnabled),
      order: 900,
    }))
    scope.effect(() => systemPrompt.context({
      name: 'magic-context-reduce',
      order: 910,
      text: (assembly: unknown) => {
        try {
          const agent = (assembly as { agent?: { session?: Session } }).agent
          const session = agent?.session
          if (session === undefined) return ''
          const sessionId = session.id
          const tagged = enumerateSurfaceToolResults(session, callId =>
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
