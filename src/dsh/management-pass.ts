/**
 * The management pass — everything the adapter does inside the execute band,
 * in one place, in Magic Context's order:
 *
 *   1. land queued ctx_reduce marks as `[dropped §N§]` placeholders;
 *   2. publish historian compartments as `[compacted §C<n>§]` range
 *      replacements (the digest itself travels in the baseline node);
 *   3. force reclaim when pressure reaches the force band;
 *   4. refresh the m[0]/m[1] baseline node — but ONLY when its rendered
 *      content actually changed (a no-op pass must not bust the cache);
 *   5. fire the historian out of band (it writes a store row; nothing on the
 *      wire changes because of it).
 *
 * All surface work happens here and only here: the execute band is the one
 * bust permission, and every step above is a durable mutation that spends it.
 */
import {
  compactedPlaceholder,
  estimateTokens,
  findBaselineRange,
  renderBaseline,
  renderCompartment,
  renderMemoryUpdates,
  stripBaseline,
  type Compartment,
  type MemoryUpdateLine,
} from '../core/compartments.ts'
import type { Journal } from '../core/journal.ts'
import type { MemoryFact } from '../core/memory-categories.ts'
import { renderMemoryLine, type MemoryRow, type ProfileRecallResult } from '../core/memory-bridge.ts'
import type { PassDecision, PressurePolicy } from '../core/policy.ts'
import type { AdapterStores, BaselineState } from '../core/stores.ts'
import { errText } from '../core/types.ts'
import { reclaimForEmergency } from './emergency.ts'
import { runHistorian, type HistorianDeps, type HistorianLlm } from './historian.ts'
import {
  dropPlaceholderContent,
  enumerateSurfaceNodes,
  enumerateSurfaceToolResults,
  magicContextSource,
  pairingClosedWindow,
  replaceSurfaceRange,
  replaceToolResultContent,
  syntheticNodeId,
  wireStrandedResults,
  type ContentBlock,
  type Session,
  type SessionSeq,
  type SurfaceNode,
} from './seams.ts'

export interface ManagementPassLogger {
  info(message: string): void
  warn(message: string): void
}

export interface ManagementPassInput {
  readonly session: Session
  readonly sessionId: string
  readonly stores: AdapterStores
  readonly policy: PressurePolicy
  readonly logger: ManagementPassLogger
  readonly pass: Extract<PassDecision, { kind: 'execute' }>
  readonly pressure: number | undefined
  /** Route + window facts for the historian's auxiliary call. */
  readonly route?: { provider: string; model: string }
  readonly contextWindow?: number
  /** The historian's seam; omitted disables historian firing (tests, hosts). */
  readonly historian?: { readonly llm: HistorianLlm; readonly now?: () => number; readonly route?: { provider: string; model: string } }
  /** Validation-period activity journal (optional). */
  readonly journal?: Journal
  /** Project memories to inject (already rendered, in MC render order). */
  readonly memories?: {
    readonly digest: string
    readonly lines: readonly string[]
    /** Memories written after the m[0] watermark → rendered in m[1]. */
    readonly newLines?: readonly string[]
    /** Ids of {@link newLines}, so `<memory-updates>` cannot duplicate them. */
    readonly newMemoryIds?: readonly number[]
    /**
     * Ids actually rendered in the m[0] baseline this pass (recall rows).
     * `<memory-updates>` announces only mutations whose target is one of
     * them — MC inject-compartments.ts:2843-2848 — so a budget-truncated
     * row never earns a phantom `<updated>`/`<removed>` pointer.
     */
    readonly baselineIds?: readonly number[]
    /**
     * A1: every currently-visible memory id (pre-budget) — MC's
     * `eligibleMemoryIds`. Supplied, `<memory-updates>` collects forced rows
     * (a superseded replacement, a visibility flip) up to
     * MAX_FORCED_MEMORIES_PER_DELTA and they render in `<new-memories>`
     * regardless of the delta budget.
     */
    readonly eligibleIds?: readonly number[]
    /** Visible rows themselves, for rendering the forced lines. */
    readonly eligibleRows?: readonly MemoryRow[]
    /** The watermark to freeze when this pass performs a HARD rebuild. */
    readonly maxMemoryId?: number
  }
  /**
   * The non-additive change lane: Magic Context's `memory_mutation_log` delta
   * (read through `MemoryBridge.mutations`). Rendered as `<memory-updates>` in
   * the m[1] region; a HARD rebuild freezes the cursor and swallows the delta
   * into m[0], exactly like `maxMemoryId`.
   */
  readonly memoryUpdates?: {
    readonly updates: readonly MemoryUpdateLine[]
    /** `MAX(mutation id)` now — frozen as the cursor on a HARD rebuild. */
    readonly cursor?: number
    /** Epoch fingerprint; a change forces the HARD rebuild + cursor reset. */
    readonly projectEpochFingerprint?: string
  }
  /**
   * WP8: the user profile (`user_memories`, read through
   * `MemoryBridge.profileRecall`). It is the one global lane with no activation
   * rule, so it renders in m[0] above the project memories — and, unlike Magic
   * Context, a rewrite or a dismissal of a rendered row DOES fold m[0]: serving
   * a stale profile block forever is worse than one rebuild.
   */
  readonly profile?: ProfileRecallResult
  /** Historian fact promotion into the shared memory store (optional). */
  readonly memoryPromote?: (input: {
    readonly identity: string
    readonly facts: readonly MemoryFact[]
    readonly sessionId: string
  }) => {
    readonly inserted: ReadonlyArray<{ id: number; category: string }>
    readonly seenAgain: ReadonlyArray<{ id: number }>
    readonly skipped: ReadonlyArray<{ category: string; reason: string }>
    readonly authorityBlocked: boolean
  }
  /** The project identity facts belong to (required for promotion). */
  readonly memoryIdentity?: string
  /**
   * WP5: the `user` domain's candidate sink, handed to the historian. Present
   * only when the lane is switched on (`memory.global.user.collect`, default
   * off); the historian calls it after the compartment is durable and swallows
   * its failures, so a candidate problem can never cost a digest.
   */
  readonly profileCollect?: (input: {
    readonly sessionId: string
    readonly observations: readonly string[]
    readonly compartmentStart: number | null
    readonly compartmentEnd: number | null
  }) => { readonly inserted: number; readonly skipped: number } | void
  readonly now?: () => number
}

export interface ManagementPassResult {
  readonly landedDrops: readonly number[]
  readonly published: readonly number[]
  readonly forceDropped: number
  /** Stranded tool/results swept off the wire this pass (the iron-rule repair). */
  readonly wireRepaired: number
  readonly baselineUpdated: boolean
  readonly historianStarted: boolean
  /**
   * Net reclaim proof: the estimate of the whole current surface before and
   * after this pass. Without it a review can only show that reclaim ACTIONS
   * happened, never that the prompt actually got smaller.
   */
  readonly tokensBefore: number
  readonly tokensAfter: number
  /** Facts newly written to project memory during this pass's publishes. */
  readonly factsPromoted: number
  /** Facts that deduplicated against existing rows (seen_count bumped). */
  readonly factsSeenAgain: number
  /** v7 publish-guard supersedes this pass took (enforce mode only). */
  readonly guardSuperseded: readonly number[]
  /** v7 publish-guard rejections this pass took (enforce mode only). */
  readonly guardRejected: readonly number[]
}

/** Estimated tokens of every current surface node. */
function surfaceTokens(session: Session): number {
  return enumerateSurfaceNodes(session).reduce((total, node) => total + (node.hasText ? estimateTokens(node.text) : 0), 0)
}

/** The baseline block currently carried by a node, when it has one. */
function baselineBlockOf(text: string): string | undefined {
  const range = findBaselineRange(text)
  return range === undefined ? undefined : text.slice(range.start, range.end)
}

/** Compose the baseline block ahead of the node's own (baseline-free) content. */
function composeBaselineContent(node: SurfaceNode, block: string): ContentBlock[] {
  const stripped = stripBaseline(node.text)
  const content: ContentBlock[] = [{ type: 'text', text: block }]
  if (stripped.length > 0) content.push({ type: 'text', text: stripped })
  return content
}

/** Split stored compartments into the frozen m[0] set and the m[1] delta. */
export function splitBaselineSets(
  compartments: readonly Compartment[],
  state: BaselineState | undefined,
): { baseline: Compartment[]; delta: Compartment[] } {
  if (state === undefined) return { baseline: [...compartments], delta: [] }
  return {
    baseline: compartments.filter(compartment => compartment.createdAt <= state.frozenAt),
    delta: compartments.filter(compartment => compartment.createdAt > state.frozenAt),
  }
}

/**
 * Publish unlanded compartments: replace each covered span with one
 * `[compacted §C<n>§]` node citing the originals. A compartment whose covered
 * nodes are already shadowed is marked landed with seq 0 ("nothing to
 * replace") so the pass does not retry forever.
 */
/** The subset of the pass input the publish lane actually reads. */
type PublishCompartmentsInput = Pick<
  ManagementPassInput,
  'session' | 'sessionId' | 'stores' | 'policy' | 'journal' | 'now' | 'memoryPromote' | 'memoryIdentity'
>

function publishCompartments(input: PublishCompartmentsInput): {
  ids: number[]
  factsPromoted: number
  factsSeenAgain: number
  guardSuperseded: number[]
  guardRejected: number[]
} {
  const published: number[] = []
  let factsPromoted = 0
  let factsSeenAgain = 0
  const guardSuperseded: number[] = []
  const guardRejected: number[] = []
  const baselineNodeSeq = input.stores.baselineState(input.sessionId)?.nodeSeq
  for (const compartment of input.stores.listUnlandedCompartments(input.sessionId)) {
    const covered = new Set(compartment.coveredSeqs)
    // The host shadows every node in the POSITIONAL range between the two
    // endpoints, not the subset the compartment covered
    // (`host: packages/core/session/src/surface.ts:433`, asserted at `:363`).
    // Citing only the covered subset threw on the first node that had entered
    // the range since the compartment was drafted, and that threw the whole
    // pass — every pass, so nothing ever landed. Enumerate the live surface here
    // (the snapshot at the call site predates the previous replacement) and cite
    // the whole range.
    const live = enumerateSurfaceNodes(input.session)
    const positions: number[] = []
    live.forEach((node, index) => {
      if (covered.has(node.seq)) positions.push(index)
    })
    if (positions.length === 0 || (baselineNodeSeq !== undefined && covered.has(baselineNodeSeq))) {
      input.stores.markCompartmentLanded(input.sessionId, compartment.compartmentId, 0)
      continue
    }
    const rawFirst = positions[0] as number
    const rawLast = positions[positions.length - 1] as number
    // Drop placeholders re-sequence a result to the surface tail while its
    // tool_use stays inside the covered span; a range that cuts between them
    // strands the result and the next provider request fails validation
    // (live 2026-10-09). Widen to tool-pairing closure before cutting.
    const span = pairingClosedWindow(live, rawFirst, rawLast)
    const range = live.slice(span.first, span.last + 1)
    // m[0] is frozen at the head of the surface: folding it into a compartment
    // would leave the next refresh rewriting an unrelated `user` node as the
    // baseline. Defer instead; the guard clears once the surface moves on.
    if (baselineNodeSeq !== undefined && range.some(node => node.seq === baselineNodeSeq)) {
      input.journal?.warn(
        'compartment-published',
        `compartment §C${String(compartment.compartmentId)}§ deferred: its range now contains the m[0] baseline node`,
        {
          compartmentId: compartment.compartmentId,
          reason: 'baseline-in-range',
          nodes: range.length,
        },
        input.sessionId,
      )
      continue
    }
    // ── The publish guard (fusion v7, from mon3stera's landing checks) ──────
    // Two failure shapes the tolerant positional range cannot see:
    //  1. Drift — substantive nodes entered the positional range since the
    //     draft was captured; publishing would shadow content the digest
    //     never saw.
    //  2. No-gain — the digest's own render (its baseline line, at its
    //     natural tier, plus the placeholder) costs at least as much as the
    //     span it would reclaim.
    // `observe` (the shipped default) journals the verdict and publishes
    // anyway — one observation window decides whether enforce earns its
    // keep. `enforce` acts: drift SUPERCedes the draft (claims released, the
    // next historian run re-digests originals plus entrants — the mon3stera
    // SurfaceChangedError, translated to re-digest instead of discard);
    // no-gain REJECTS it (terminal: the span stays on the wire, honestly).
    const guardMode = input.policy.compartmentGuardMode === 'enforce'
      || input.policy.compartmentGuardMode === 'off'
      ? input.policy.compartmentGuardMode
      : 'observe'
    if (guardMode !== 'off') {
      const now = input.now?.() ?? Date.now()
      const entrantTokens = range
        .filter(node => !covered.has(node.seq) && !node.isPlaceholder && node.hasText)
        .reduce((total, node) => total + estimateTokens(node.text), 0)
      const reclaimedTokens = range.reduce(
        (total, node) => total + (node.hasText ? estimateTokens(node.text) : 0),
        0,
      )
      const renderCost = estimateTokens(renderCompartment(compartment, now))
        + estimateTokens(compactedPlaceholder(compartment.compartmentId))
      const verdict = entrantTokens > input.policy.compartmentEntrantTokens
        ? 'substantive-entrants'
        : renderCost >= reclaimedTokens
          ? 'not-shrinkable'
          : 'ok'
      if (verdict !== 'ok') {
        const acted = guardMode === 'enforce'
        if (acted && verdict === 'substantive-entrants') {
          input.stores.supersedeCompartment(input.sessionId, compartment.compartmentId, 'superseded-entrants')
          guardSuperseded.push(compartment.compartmentId)
        } else if (acted && verdict === 'not-shrinkable') {
          input.stores.markCompartmentRejected(input.sessionId, compartment.compartmentId, 'not-shrinkable')
          guardRejected.push(compartment.compartmentId)
        }
        input.journal?.[acted ? 'warn' : 'info'](
          'compartment-guard',
          `compartment §C${String(compartment.compartmentId)}§ ${verdict} (${acted ? 'enforce' : 'observe'})`,
          {
            compartmentId: compartment.compartmentId,
            verdict,
            mode: guardMode,
            entrantTokens,
            entrantBudget: input.policy.compartmentEntrantTokens,
            reclaimedTokens,
            renderCost,
          },
          input.sessionId,
        )
        if (acted) continue
      }
    }
    const first = range[0] as SurfaceNode
    const last = range[range.length - 1] as SurfaceNode
    // A host validator refusal here (2026-10-08 live incident: the pre-fix
    // shadow list missed range entrants, 69 journal errors across 2 sessions —
    // the same poisoned draft threw on EVERY pass) must be terminal for THIS
    // draft, never a retry loop, and must never starve the drafts behind it:
    // retire it as rejected (covered claims stay claimed, no re-digest flood;
    // the span stays on the wire, honestly) and let the loop move on.
    let landedSeq: SessionSeq
    try {
      landedSeq = replaceSurfaceRange(
        input.session,
        first.seq,
        last.seq,
        [{ type: 'text', text: compactedPlaceholder(compartment.compartmentId) }],
        range.map(node => node.seq),
        syntheticNodeId(`mc-compacted-${String(compartment.compartmentId)}`),
        magicContextSource(
          `Magic Context · compartment §C${String(compartment.compartmentId)}§ replaced ${String(range.length)} node(s) on the wire`,
        ),
      )
    } catch (error) {
      input.stores.markCompartmentRejected(input.sessionId, compartment.compartmentId, 'replace-failed')
      input.journal?.error(
        'compartment-published',
        `compartment §C${String(compartment.compartmentId)}§ replace refused; retired as rejected (span stays on the wire)`,
        {
          compartmentId: compartment.compartmentId,
          reason: 'replace-failed',
          nodes: range.length,
          error: errText(error),
        },
        input.sessionId,
      )
      continue
    }
    input.stores.markCompartmentLanded(input.sessionId, compartment.compartmentId, landedSeq)
    published.push(compartment.compartmentId)
    input.journal?.info(
      'compartment-published',
      `compartment §C${String(compartment.compartmentId)}§ replaced ${String(range.length)} nodes on the wire`,
      {
        compartmentId: compartment.compartmentId,
        nodes: range.length,
        coveredTokens: compartment.coveredTokens,
        estTokensReclaimed: range.reduce((total, node) => total + estimateTokens(node.text), 0),
        nodeSeq: landedSeq,
        importance: compartment.importance,
        ...((span.first !== rawFirst || span.last !== rawLast)
          ? { pairingClosure: { rawFirst, rawLast, first: span.first, last: span.last } }
          : {}),
      },
      input.sessionId,
    )
    // Magic Context promotes the compartment's facts in the same publish step
    // (`compartment-runner-incremental.ts:1077`). Ours is not one SQLite
    // transaction (the compartment store and the memory store are different
    // databases and different owners), so a failure is journaled and the facts
    // stay durably in the compartment row for a later retry — reclaim must not
    // stall on a memory problem.
    if (input.memoryPromote !== undefined && input.memoryIdentity !== undefined && compartment.facts.length > 0) {
      try {
        const outcome = input.memoryPromote({
          identity: input.memoryIdentity,
          facts: compartment.facts,
          sessionId: input.sessionId,
        })
        factsPromoted += outcome.inserted.length
        factsSeenAgain += outcome.seenAgain.length
        input.journal?.info(
          'memory-promote',
          `promoted ${String(outcome.inserted.length)} fact(s) into project memory`
            + `${outcome.seenAgain.length > 0 ? `, ${String(outcome.seenAgain.length)} already known` : ''}`
            + `${outcome.authorityBlocked ? ' (module-managed project: left untouched)' : ''}`,
          {
            compartmentId: compartment.compartmentId,
            identity: input.memoryIdentity,
            inserted: outcome.inserted.map(row => ({ id: row.id, category: row.category })),
            seenAgain: outcome.seenAgain.map(row => row.id),
            skipped: outcome.skipped,
            authorityBlocked: outcome.authorityBlocked,
          },
          input.sessionId,
        )
      } catch (error) {
        const detail = errText(error)
        input.journal?.error('error', `memory promotion failed: ${detail}`, {
          scope: 'memory-promote',
          detail,
          compartmentId: compartment.compartmentId,
        }, input.sessionId)
      }
    }
  }
  return { ids: published, factsPromoted, factsSeenAgain, guardSuperseded, guardRejected }
}

/**
 * Publish ready compartments OUTSIDE a management pass — the provider-overflow
 * path (index.ts `agent/request-error`) lands the bank before it drops tool
 * results: one replacement reclaims a whole digested span, an emergency drop
 * only individual tool results, and the request has already failed once, so
 * the bust cannot lose more than the failed retry did.
 *
 * The request-error lane is a forced execute band in everything but name —
 * the same exception family as the wire-repair iron rule (the provider
 * rejected the wire as-is). Same surface discipline as the pass's publish
 * lane (pairing closure, m[0]-baseline guard, the v7 publish guard). NO
 * baseline refresh and NO fact promotion here: both belong to the next
 * execute pass, the facts stay durable in the compartment row, and the
 * promotion retry is idempotent (seen-again dedup).
 */
export function publishReadyCompartments(
  input: Pick<ManagementPassInput, 'session' | 'sessionId' | 'stores' | 'policy' | 'journal' | 'now'>,
): { ids: number[]; guardSuperseded: number[]; guardRejected: number[] } {  const outcome = publishCompartments(input)
  return { ids: outcome.ids, guardSuperseded: outcome.guardSuperseded, guardRejected: outcome.guardRejected }
}

/**
 * Refresh the baseline node: the first current `user` node carries the
 * m[0]/m[1] block ahead of its own content. Returns whether the surface
 * changed. A HARD rebuild (no state yet, route change, memory-digest change)
 * freezes m[0] again and empties the delta; otherwise the delta grows.
 */
function refreshBaseline(
  input: ManagementPassInput,
  nodes: readonly SurfaceNode[],
): boolean {
  const now = input.now?.() ?? Date.now()
  const compartments = input.stores.listCompartments(input.sessionId)
  const memories = input.memories
  const profile = input.profile
  const updates = input.memoryUpdates
  const previous = input.stores.baselineState(input.sessionId)
  const routeChanged = previous !== undefined
    && (previous.provider !== input.route?.provider || previous.model !== input.route?.model)
  const memoriesChanged = previous !== undefined
    && previous.memoriesDigest !== undefined
    && memories !== undefined
    && previous.memoriesDigest !== memories.digest
  // The external-writer signal: Magic Context bumps
  // `project_state.project_memory_epoch` when a dashboard edit (or a workspace
  // /identity change) invalidates a running session's snapshot. Both the m[0]
  // pool AND the mutation cursor were built against the old epoch, so this is
  // a HARD rebuild — reusing the old cursor would render a misaligned delta.
  const epochChanged = previous !== undefined
    && previous.projectEpochFingerprint !== undefined
    && updates?.projectEpochFingerprint !== undefined
    && previous.projectEpochFingerprint !== updates.projectEpochFingerprint
  // One-time upgrade fold: a baseline written before the cursor column existed
  // cannot order its delta, so the first pass that actually has pending change
  // rows folds them into m[0] and stamps the cursor instead of rendering a
  // delta read from zero.
  const cursorUpgrade = previous !== undefined
    && previous.maxMemoryMutationId === undefined
    && updates !== undefined
    && updates.updates.length > 0
  // WP8: the profile's fold trigger. An entry ABOVE the frozen watermark is an
  // addition and rides m[1] without touching the prefix. A row AT or below it
  // being rewritten or dismissed changes the digest — and here, unlike Magic
  // Context whose version bump deliberately never folded m[0], the stale block
  // is rebuilt: a profile the agent keeps reading after it was retracted is
  // worse than one cache bust. The `''` sentinel recorded by an emptying fold
  // keeps a switched-off profile from rebuilding on every later pass.
  const profileChanged = previous !== undefined && (
    profile === undefined
      ? previous.profileM0Digest !== undefined && previous.profileM0Digest !== ''
      : previous.profileM0Digest === undefined
        ? true
        : previous.profileM0Digest !== profile.digest
  )
  const hard = previous === undefined || routeChanged || memoriesChanged || epochChanged || cursorUpgrade || profileChanged
  // Freeze targets for a HARD fold. Falling back to the previous values keeps a
  // pass that has no mutation lane (bridge unavailable) from rewinding them.
  const frozenCursor = updates?.cursor ?? previous?.maxMemoryMutationId
  const frozenEpochFingerprint = updates?.projectEpochFingerprint ?? previous?.projectEpochFingerprint
  const state: BaselineState = hard
    ? {
      sessionId: input.sessionId,
      epoch: (previous?.epoch ?? 0) + 1,
      ...previous?.nodeSeq === undefined ? {} : { nodeSeq: previous.nodeSeq },
      ...input.route === undefined ? {} : { provider: input.route.provider, model: input.route.model },
      frozenAt: now,
      ...memories === undefined ? {} : { memoriesDigest: memories.digest },
      // The watermark moves only on a HARD rebuild: everything written since
      // the previous fold becomes part of the frozen m[0] pool here.
      ...memories?.maxMemoryId === undefined ? {} : { maxMemoryId: memories.maxMemoryId },
      // WP8: the profile freeze. The digest recorded is the FOLD digest (every
      // active row), because this fold renders the whole profile and the next
      // pass's pool is exactly that set — recording the pool digest here would
      // buy a second, useless rebuild.
      profileM0Digest: profile?.foldDigest ?? '',
      ...profile === undefined
        ? previous?.profileWatermark === undefined ? {} : { profileWatermark: previous.profileWatermark }
        : { profileWatermark: profile.currentMaxId },
      // Same rule for the mutation cursor (§7.5 step 4): folding m[0] bakes the
      // pending updates in, so the `<memory-updates>` block disappears.
      ...frozenCursor === undefined ? {} : { maxMemoryMutationId: frozenCursor },
      ...frozenEpochFingerprint === undefined ? {} : { projectEpochFingerprint: frozenEpochFingerprint },
      updatedAt: now,
    }
    : { ...(previous as BaselineState), updatedAt: now }

  const sets = hard
    ? { baseline: compartments, delta: [] as Compartment[] }
    : splitBaselineSets(compartments, previous)
  // A1 (MC inject-compartments.ts:2822-2869): collect the forced ids first,
  // render their lines from the eligible rows, and hand both to renderBaseline.
  const forcedRender = renderMemoryUpdates(hard ? [] : updates?.updates ?? [], {
    ...memories?.newMemoryIds === undefined ? {} : { renderedIds: new Set(memories.newMemoryIds) },
    ...memories?.baselineIds === undefined ? {} : { baselineIds: new Set(memories.baselineIds) },
    ...memories?.eligibleIds === undefined ? {} : { eligibleIds: new Set(memories.eligibleIds) },
  })
  const forcedRowsById = new Set((memories?.eligibleRows ?? []).map(row => row.id))
  const forcedMemoryLines = forcedRender.forcedMemoryIds
    .filter(id => forcedRowsById.has(id))
    .map(id => renderMemoryLine((memories?.eligibleRows ?? []).find(row => row.id === id)!))
  // WP8: a HARD fold swallows the profile delta (the whole profile becomes
  // m[0]); a soft pass renders the pool in m[0] and the new entries in m[1].
  const profilePoolLines = hard
    ? [...(profile?.lines ?? []), ...(profile?.newLines ?? [])]
    : profile?.lines ?? []
  const profileDeltaLines = hard ? [] : profile?.newLines ?? []
  const block = renderBaseline({
    now,
    baseline: sets.baseline,
    delta: sets.delta,
    memories: memories?.lines ?? [],
    ...profilePoolLines.length === 0 ? {} : { profileLines: profilePoolLines },
    ...profileDeltaLines.length === 0 ? {} : { newProfileLines: profileDeltaLines },
    ...memories?.newLines === undefined ? {} : { newMemories: memories.newLines },
    ...memories?.newMemoryIds === undefined ? {} : { newMemoryIds: memories.newMemoryIds },
    ...memories?.baselineIds === undefined ? {} : { baselineIds: memories.baselineIds },
    ...memories?.eligibleIds === undefined ? {} : { eligibleIds: memories.eligibleIds },
    ...(forcedMemoryLines.length > 0 ? { forcedMemoryLines } : {}),
    // A HARD fold swallows the delta: the changes are part of the rebuilt m[0].
    // Otherwise the pending (post-cursor) changes render in m[1].
    ...hard || updates === undefined ? {} : { memoryUpdates: updates.updates },
    budgetTokens: input.policy.baselineTokens,
  })
  if (block.length === 0) return false

  // The baseline rides the first ordinary user node — never a compaction
  // checkpoint (host or engine). Attaching it to a checkpoint let that
  // checkpoint's own text ride inside m[0] forever: every later refresh
  // re-emitted the foreign summary and rewrote the node, and the GUI lost the
  // card it correlates by `source.kind === 'compact-checkpoint'` + compactionId.
  const target = nodes.find(node => node.role === 'user' && node.sourceKind !== 'compact-checkpoint')
  if (target === undefined) return false
  if (baselineBlockOf(target.text) === block) {
    // Byte-identical: no durable mutation, no priced bust (MC's defer pass).
    if (state.nodeSeq !== target.seq || state.updatedAt !== previous?.updatedAt) {
      input.stores.saveBaselineState({
        ...state,
        nodeSeq: target.seq,
        ...input.route === undefined ? {} : { provider: input.route.provider, model: input.route.model },
        ...memories === undefined ? {} : { memoriesDigest: memories.digest },
      })
    }
    return false
  }
  const landedSeq = replaceSurfaceRange(
    input.session,
    target.seq,
    target.seq,
    composeBaselineContent(target, block),
    [target.seq],
    syntheticNodeId('mc-baseline'),
    magicContextSource(
      `Magic Context · baseline ${hard ? 'HARD rebuild' : 'soft refresh'} `
        + `(m[0] ${String(sets.baseline.length)} · m[1] ${String(sets.delta.length)} · ${String(memories?.lines.length ?? 0)} memories)`,
    ),
  )
  input.stores.saveBaselineState({
    ...state,
    nodeSeq: landedSeq,
    ...input.route === undefined ? {} : { provider: input.route.provider, model: input.route.model },
    ...memories === undefined ? {} : { memoriesDigest: memories.digest },
  })
  input.journal?.info(
    'baseline',
    `baseline ${hard ? 'HARD rebuild' : 'soft refresh'} (epoch ${String(state.epoch)})`,
    {
      mode: hard ? 'hard' : 'soft',
      epoch: state.epoch,
      nodeSeq: landedSeq,
      compartments: { baseline: sets.baseline.length, delta: sets.delta.length },
      memories: { rows: memories?.lines.length ?? 0, digest: memories?.digest.slice(0, 12) },
      profile: {
        rows: profile?.lines.length ?? 0,
        newRows: hard ? 0 : profile?.newLines.length ?? 0,
        digest: profile?.digest.slice(0, 12),
        watermark: state.profileWatermark,
      },
      memoryUpdates: {
        pending: updates?.updates.length ?? 0,
        rendered: hard ? 0 : updates?.updates.length ?? 0,
        cursor: state.maxMemoryMutationId,
        epochFingerprint: state.projectEpochFingerprint,
      },
      bytes: block.length,
      estTokens: estimateTokens(block),
      ...memoriesChanged ? { reason: 'memory-digest-changed' } : {},
      ...profileChanged ? { reason: 'profile-digest-changed' } : {},
      ...routeChanged ? { reason: 'route-changed' } : {},
      ...epochChanged ? { reason: 'project-memory-epoch-changed' } : {},
      ...cursorUpgrade ? { reason: 'mutation-cursor-upgrade' } : {},
      ...previous === undefined ? { reason: 'first-baseline' } : {},
    },
    input.sessionId,
  )
  return true
}

/** Upper bound of wire repairs per pass, so a pathological surface cannot monopolize the bust. */
const WIRE_REPAIR_CAP = 16

/**
 * The iron-rule repair: sweep live `tool/result` nodes whose tool_use left
 * the wire. One of them 400s every strict-provider request — the only adapter
 * failure mode that can take the whole conversation down — so they are
 * replaced with a tiny user note no matter what else this pass does. The
 * original content stays recoverable in the event log (the replacement cites
 * it); only the wire copy goes.
 * @returns the number of results swept this pass.
 */
function repairWirePairing(input: ManagementPassInput): number {
  const stranded = wireStrandedResults(input.session)
  if (stranded.length === 0) return 0
  const sweep = stranded.slice(0, WIRE_REPAIR_CAP)
  for (const defect of sweep) {
    replaceSurfaceRange(
      input.session,
      defect.seq,
      defect.seq,
      [{ type: 'text', text: '[magic-context] removed a tool result whose call left the wire' }],
      [defect.seq],
      syntheticNodeId(`mc-wire-repair-${String(defect.seq)}`),
      magicContextSource(`Magic Context · wire repair · removed stranded tool result ${String(defect.seq)}`),
    )
  }
  input.journal?.warn(
    'wire-repair',
    `swept ${String(sweep.length)} stranded tool result(s) off the wire`,
    {
      swept: sweep.length,
      seqs: sweep.map(defect => defect.seq),
      callIds: sweep.map(defect => defect.callId),
      remaining: stranded.length - sweep.length,
    },
    input.sessionId,
  )
  return sweep.length
}

/**
 * Run the management pass. Every step is independently guarded: a failure in
 * one must not wedge the turn (MC per-turn fail-open), and the next pass
 * re-decides from durable state.
 */
export function runManagementPass(input: ManagementPassInput): ManagementPassResult {
  const landedDrops: number[] = []
  let wireRepaired = 0
  const tokensBefore = surfaceTokens(input.session)
  const result: ManagementPassResult = {
    landedDrops,
    published: [],
    forceDropped: 0,
    wireRepaired: 0,
    baselineUpdated: false,
    historianStarted: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    factsPromoted: 0,
    factsSeenAgain: 0,
    guardSuperseded: [],
    guardRejected: [],
  }

  // 1. Queued ctx_reduce marks.
  try {
    const toolNodes = enumerateSurfaceToolResults(input.session, callId =>
      input.stores.getTag(input.sessionId, { kind: 'tool-result', callId }))
    for (const tag of input.stores.listPendingDrops(input.sessionId)) {
      const node = toolNodes.find(candidate => candidate.tagNumber === tag)
      if (node === undefined) continue
      if (node.isPlaceholder) {
        input.stores.markDropLanded(input.sessionId, tag, node.seq)
        continue
      }
      const landedSeq = replaceToolResultContent(input.session, node.seq, dropPlaceholderContent(tag))
      input.stores.markDropLanded(input.sessionId, tag, landedSeq)
      landedDrops.push(tag)
    }
    if (landedDrops.length > 0) {
      const textBySeq = new Map(enumerateSurfaceNodes(input.session).map(node => [node.seq, node.text]))
      input.journal?.info(
        'drop-landed',
        `landed ${String(landedDrops.length)} drop(s): ${landedDrops.map(tag => `§${String(tag)}§`).join(', ')}`,
        {
          tags: landedDrops,
          count: landedDrops.length,
          estTokens: landedDrops.reduce((total, tag) => {
            const node = toolNodes.find(candidate => candidate.tagNumber === tag)
            const text = node === undefined ? undefined : textBySeq.get(node.seq)
            return total + (text === undefined ? 0 : estimateTokens(text))
          }, 0),
        },
        input.sessionId,
      )
    }

    // 1.5 Wire-pairing repair (the iron rule): sweep stranded results off the
    // wire before anything else reads the surface.
    wireRepaired = repairWirePairing(input)

    // 3. Force-band reclaim (before publishing, so a compartment range that
    //    lost its content to a drop still replaces the same nodes).
    let forceDropped = 0
    if (input.pressure !== undefined && input.pressure >= input.policy.forceThreshold) {
      const generationBefore = input.session.surface.replaceGeneration
      const reclaim = reclaimForEmergency(input.session, toolNodes, input.policy)
      forceDropped = reclaim.dropped.length
      if (forceDropped > 0) {
        input.journal?.warn(
          'emergency-reclaim',
          `force band: dropped ${String(forceDropped)} tool output(s) beyond the protected window`,
          {
            dropped: forceDropped,
            protected: reclaim.protectedCount,
            reason: 'force-threshold',
            pressure: input.pressure,
            generationBefore,
            generationAfter: input.session.surface.replaceGeneration,
          },
          input.sessionId,
        )
      }
    }

    // 2 + 4: publish compartments, then refresh the baseline over the result.
    const nodes = enumerateSurfaceNodes(input.session)
    const { ids: published, factsPromoted, factsSeenAgain, guardSuperseded, guardRejected } = publishCompartments(input)
    const afterPublish = published.length === 0 ? nodes : enumerateSurfaceNodes(input.session)
    const baselineUpdated = refreshBaseline(input, afterPublish)

    // 5. Fire the historian out of band; it only writes a store row.
    let historianStarted = false
    if (input.historian !== undefined) {
      const deps: HistorianDeps = {
        stores: input.stores,
        policy: input.policy,
        llm: input.historian.llm,
        logger: input.logger,
        ...input.journal === undefined ? {} : { journal: input.journal },
        ...input.historian.route === undefined ? {} : { route: input.historian.route },
        ...input.historian.now === undefined ? {} : { now: input.historian.now },
        ...input.profileCollect === undefined ? {} : { profileCollect: input.profileCollect },
      }
      void runHistorian(deps, {
        sessionId: input.sessionId,
        session: input.session,
        nodes: enumerateSurfaceNodes(input.session),
        ...input.stores.baselineState(input.sessionId)?.nodeSeq === undefined
          ? {}
          : { baselineNodeSeq: input.stores.baselineState(input.sessionId)?.nodeSeq as SessionSeq },
        ...input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow },
        ...input.route === undefined ? {} : { route: input.route },
      }).catch((error: unknown) => {
        const why = errText(error)
        input.logger.warn(
          `magic-context historian failed (continuing): ${why}`,
        )
        // runHistorian journals its own terminal events; this row fires only
        // if the promise itself rejects — a bug in the guard plumbing. Better
        // a phase-less error row than a silent failure.
        input.journal?.error('error', `historian promise rejected: ${why}`, {
          scope: 'historian-unhandled',
          detail: why,
          errorName: error instanceof Error ? error.name : typeof error,
        }, input.sessionId)
      })
      historianStarted = true
    }

    input.logger.info(
      `magic-context: execute pass (${input.pass.reason}) pressure=${input.pressure?.toFixed(1) ?? '?'}% `
        + `landed=[${landedDrops.map(tag => `§${String(tag)}§`).join(', ')}] `
        + `published=[${published.map(id => `§C${String(id)}§`).join(', ')}] `
        + `forceDropped=${String(forceDropped)} baseline=${baselineUpdated ? 'refreshed' : 'unchanged'} `
        + `tokens ${String(tokensBefore)}→${String(surfaceTokens(input.session))}`,
    )
    return {
      ...result,
      published,
      forceDropped,
      wireRepaired,
      baselineUpdated,
      historianStarted,
      tokensAfter: surfaceTokens(input.session),
      factsPromoted,
      factsSeenAgain,
      guardSuperseded,
      guardRejected,
    }
  } catch (error) {
    // A failed management pass must never wedge the turn: log and continue
    // with the tagged messages (MC per-turn fail-open). The journal row is
    // what makes the failure diagnosable — the logger line alone is why a
    // run of silent failures could survive unnoticed (test-design audit P1-3).
    const why = errText(error)
    input.logger.warn(
      `magic-context: management pass failed (continuing): ${why}`,
    )
    input.journal?.error('error', `management pass failed: ${why}`, {
      scope: 'management-pass',
      detail: why,
      errorName: error instanceof Error ? error.name : typeof error,
      pressure: input.pressure,
      trigger: input.pass.reason,
    }, input.sessionId)
    return result
  }
}