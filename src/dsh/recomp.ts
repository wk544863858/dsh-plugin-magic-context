/**
 * `/ctx-recomp` — re-digest history that has ALREADY been compacted.
 *
 * Why it exists (upstream `recomp-orchestrator.ts`, `compartment-runner-recomp.ts`
 * and `compartment-runner-partial-recomp.ts`): the manual range picked by
 * `selectManualRange` lists every seq a compartment covers as skippable, so a
 * digest that turned out bad — wrong tier, a lost fact, a mis-read decision — can
 * never be redone. This lane re-runs the historian over the compartment's ORIGINAL
 * span and replaces the stored digest in place. The shadowed events are still in
 * the session log, which is what makes that possible (`nodesForSeqs`).
 *
 * Two deliberate differences from upstream: no surface surgery (no staging
 * promotion, no placeholder rewriting) and no compartment lease. Neither is needed
 * because this adapter renders the digest from the store — the transcript keeps its
 * placeholder and the text the model sees comes from the row, so replacing the row
 * is the whole operation. The next pass notices the changed render and refreshes
 * m[1] the way any other digest change does.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Compartment, CompartmentDraft } from '../core/compartments.ts'
import type { Journal } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { callHistorian, historianTriggerBudget, type HistorianLlm } from './historian.ts'
import { nodesForSeqs, requestContextOf, type SessionSeq, type SurfaceNode } from './seams.ts'

export const RECOMP_USAGE = 'Usage: /ctx-recomp [all | last:<n> | <startSeq>-<endSeq>]'

export interface RecompDeps {
  readonly stores: AdapterStores
  readonly policy: PressurePolicy
  readonly logger: { info(message: string): void; warn(message: string): void }
  readonly journal?: Journal
  readonly llm?: HistorianLlm
  readonly route?: { provider: string; model: string }
  readonly timeoutMs?: number
  readonly now?: () => number
  /** False when the adapter runs with the historian switched off. */
  readonly enabled?: boolean
}

/** What the command was asked to redo. */
export type RecompSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'last'; readonly count: number }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }

/**
 * Parse the command input: empty or `all`, `last:<n>`, or `<start>-<end>` over
 * surface seqs.
 * @param raw - the invocation's raw input.
 * @returns the selection, or the usage line when the input is not understood.
 */
export function parseRecompSelection(raw: string | undefined): RecompSelection | string {
  const text = (raw ?? '').trim()
  if (text.length === 0 || text === 'all') return { kind: 'all' }
  const last = /^last:(\d+)$/.exec(text)
  if (last !== null) {
    const count = Number(last[1])
    return count > 0 ? { kind: 'last', count } : RECOMP_USAGE
  }
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(text)
  if (range !== null) {
    const start = Number(range[1])
    const end = Number(range[2])
    return start <= end ? { kind: 'range', start, end } : RECOMP_USAGE
  }
  return RECOMP_USAGE
}

/**
 * Whole compartments intersecting `[start, end]`. A compartment is never split —
 * its digest covers exactly its own span — so a request that lands in the middle of
 * one takes the whole compartment (upstream's `snapRangeToCompartments`).
 * @param compartments - candidate compartments.
 * @param start - first surface seq of the requested range.
 * @param end - last surface seq of the requested range.
 * @returns the compartments to re-digest, in stored order.
 */
export function snapRangeToCompartments(
  compartments: readonly Compartment[],
  start: number,
  end: number,
): Compartment[] {
  return compartments.filter(compartment =>
    compartment.coveredStartSeq <= end && compartment.coveredEndSeq >= start)
}

/**
 * Resolve a selection against the session's LANDED compartments: only a landed
 * digest has text the model is currently reading.
 * @param stores - the adapter stores.
 * @param sessionId - the session to inspect.
 * @param selection - the parsed command input.
 * @returns the compartments to re-digest, oldest first.
 */
export function selectRecompTargets(
  stores: AdapterStores,
  sessionId: string,
  selection: RecompSelection,
): Compartment[] {
  const landed = stores
    .listCompartments(sessionId)
    .filter(compartment => compartment.landedEventSeq !== undefined)
  if (selection.kind === 'all') return landed
  if (selection.kind === 'last') return landed.slice(-selection.count)
  return snapRangeToCompartments(landed, selection.start, selection.end)
}

export interface RecompOutcome {
  readonly recompacted: readonly number[]
  readonly skipped: ReadonlyArray<{ readonly compartmentId: number; readonly reason: string }>
  readonly failed: ReadonlyArray<{ readonly compartmentId: number; readonly reason: string }>
}

/**
 * Re-digest each target's original span and replace its stored digest.
 *
 * One target's failure never aborts the others: this is a repair tool, so partial
 * progress is the point, and every outcome is journaled per compartment.
 * @param deps - stores, policy, logger, and the historian's LLM/route seams.
 * @param input - the session, its context window, and the chosen targets.
 * @returns which compartments were re-digested, skipped, or failed.
 */
export async function recompactCompartments(
  deps: RecompDeps,
  input: {
    readonly sessionId: string
    readonly session: Parameters<typeof nodesForSeqs>[0]
    readonly contextWindow?: number
    readonly signal?: AbortSignal
    readonly targets: readonly Compartment[]
  },
): Promise<RecompOutcome> {
  // `llm` is optional on the deps (the command is registered without one only
  // to report that recompaction is off), but every path below calls the
  // historian, so it is required here. Captured in a local because narrowing a
  // property does not survive the intervening calls.
  const llm = deps.llm
  if (llm === undefined) throw new Error('recompaction requires an LLM seam')
  const historianDeps = { ...deps, llm }
  const recompacted: number[] = []
  const skipped: Array<{ compartmentId: number; reason: string }> = []
  const failed: Array<{ compartmentId: number; reason: string }> = []
  // The same 5%-of-window budget (5k..50k) the automatic path uses, so an
  // oversized span digests in chunks with a merge call instead of truncating.
  const chunkTokens = historianTriggerBudget(
    input.contextWindow,
    deps.policy.historianAssumedWindow,
    deps.policy.historianMinBudgetTokens,
  )
  for (const target of input.targets) {
    // The compartment stores its covered seqs as plain numbers (they round-trip
    // through SQLite); the seam addresses surface positions with the branded
    // `SessionSeq`, so the boundary conversion is explicit here.
    const nodes: SurfaceNode[] = nodesForSeqs(input.session, target.coveredSeqs.map(seq => seq as SessionSeq))
    if (nodes.length < 2) {
      skipped.push({
        compartmentId: target.compartmentId,
        reason: 'the covered events are no longer resolvable in the session log',
      })
      continue
    }
    const tokens = nodes.reduce((total, node) => total + Math.max(1, Math.ceil(node.text.length / 4)), 0)
    try {
      const draft: CompartmentDraft = await callHistorian(historianDeps, {
        sessionId: input.sessionId,
        session: input.session,
        nodes,
        trigger: 'manual',
        chunkTokens,
        ...input.signal === undefined ? {} : { signal: input.signal },
      })
      deps.stores.replaceCompartmentDraft(input.sessionId, target.compartmentId, draft)
      recompacted.push(target.compartmentId)
      deps.journal?.info(
        'compartment-recomp',
        `compartment §C${String(target.compartmentId)}§ re-digested ${String(nodes.length)} node(s) on request`,
        {
          compartmentId: target.compartmentId,
          nodes: nodes.length,
          tokens,
          importanceBefore: target.importance,
          importanceAfter: draft.importance,
          p1Changed: draft.tiers.p1 !== target.tiers.p1,
          trigger: 'manual',
        },
        input.sessionId,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failed.push({ compartmentId: target.compartmentId, reason })
      deps.journal?.error(
        'compartment-recomp',
        `recomp failed for compartment §C${String(target.compartmentId)}§: ${reason}`,
        { compartmentId: target.compartmentId, reason, trigger: 'manual' },
        input.sessionId,
      )
    }
  }
  return { recompacted, skipped, failed }
}

/** Narrowed registration surface (keeps the package typecheck standalone). */
type CommandRegistrar = {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: {
      readonly agent: {
        readonly session: {
          readonly id: string
          snapshotEvents(): unknown[]
          surface: { nodes: readonly number[] }
        }
      }
      readonly rawInput?: string
      readonly signal?: AbortSignal
    }) => Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  }): unknown
}

/**
 * Register `/ctx-recomp` beside `/ctx-status`.
 * @param ctx - the adapter's context, carrying the `commands` service.
 * @param deps - stores, policy, logger and the historian's seams.
 */
export function registerCtxRecompCommand(ctx: Context, deps: RecompDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as
    | CommandRegistrar
    | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-recomp unavailable')
    return
  }
  commands.register({
    name: 'ctx-recomp',
    description: 'Magic Context: re-digest already-compacted history that turned out wrong.',
    input: { hint: 'all | last:<n> | <startSeq>-<endSeq>' },
    handler: async (invocation) => {
      if (deps.llm === undefined || deps.enabled === false) {
        return {
          kind: 'error',
          text: 'Magic Context: the historian is not available for this adapter, so there is nothing to re-digest.',
        }
      }
      const parsed = parseRecompSelection(invocation.rawInput)
      if (typeof parsed === 'string') return { kind: 'error', text: parsed }
      const sessionId = invocation.agent.session.id
      const targets = selectRecompTargets(deps.stores, sessionId, parsed)
      if (targets.length === 0) {
        return {
          kind: 'success',
          text: 'Magic Context: nothing to recompact — no landed compartment matches that selection.',
        }
      }
      const { contextWindow } = requestContextOf(invocation.agent.session as never)
      const outcome = await recompactCompartments(deps, {
        sessionId,
        session: invocation.agent.session as never,
        ...contextWindow === undefined ? {} : { contextWindow },
        ...invocation.signal === undefined ? {} : { signal: invocation.signal },
        targets,
      })
      const lines = [
        `Magic Context: re-digested ${String(outcome.recompacted.length)} of ${String(targets.length)} compartment(s).`,
        ...outcome.recompacted.map(id => `- §C${String(id)}§ updated`),
        ...outcome.skipped.map(row => `- §C${String(row.compartmentId)}§ skipped: ${row.reason}`),
        ...outcome.failed.map(row => `- §C${String(row.compartmentId)}§ failed: ${row.reason}`),
        'The next pre-step pass re-renders the baseline from the new digests (a HARD rebuild may follow).',
      ]
      return outcome.failed.length === 0
        ? { kind: 'success', text: lines.join('\n') }
        : { kind: 'error', text: lines.join('\n') }
    },
  })
}
