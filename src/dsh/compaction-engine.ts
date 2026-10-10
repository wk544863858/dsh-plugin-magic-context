/**
 * The compaction seam — Magic Context's answer to DSH's `ctx.compaction`.
 *
 * DSH's built-in engine summarizes a span into a checkpoint when pressure
 * rises. Magic Context's promise is the opposite: the transform never makes a
 * model call, reclaim is deterministic (drops + compartment publishing), and
 * the historian's digest is written out of band. This engine therefore
 *
 *  - `compactIfNeeded` (the pressure path): runs the adapter's management
 *    pass and returns null — no checkpoint is written, because the reclaim
 *    lanes and the historian own pressure handling;
 *  - `compactNow` / `compactRegion` (the MANUAL path, `/compact`): a user
 *    explicitly asked, so the engine writes a real checkpoint — it summarizes
 *    the span with the historian and appends the documented protocol
 *    (`compaction/start` → `compaction/summary` → the replacing
 *    `user/message` → `compaction/end`), which is the one place a summary
 *    legitimately enters the surface.
 *
 * The engine class is built from an INJECTED base class: the adapter's
 * runtime keeps zero static @deepseek-ai imports, and the in-tree glue (or a
 * dynamic import in a proper package install) supplies the seam class.
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { compactedPlaceholder, estimateTokens, type CompartmentDraft } from '../core/compartments.ts'
import type { Journal } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { errText } from '../core/types.ts'
import { callHistorian, type HistorianLlm } from './historian.ts'
import { runManagementPass } from './management-pass.ts'
import {
  compactCheckpointSource,
  enumerateSurfaceNodes,
  replaceSurfaceRange,
  syntheticNodeId,
  type ContentBlock,
  type Session,
  type SurfaceNode,
} from './seams.ts'

export interface CompactionEngineDeps {
  /** The CompactionEngine base class (injected or dynamically imported). */
  readonly base: unknown
  readonly stores: AdapterStores
  readonly policy: PressurePolicy
  /**
   * Live policy resolver: when present, every engine method re-resolves the
   * policy at its use point, so a settings-form threshold edit reaches the
   * engine path without a remount (volatile commits never remount — the
   * "dead option" audit, 2026-10-10). Absent falls back to the snapshot
   * {@link policy}, which is what tests and stand-alone constructions pass.
   */
  readonly activePolicy?: () => PressurePolicy
  readonly logger: { info(message: string): void; warn(message: string): void }
  readonly llm?: HistorianLlm
  readonly route?: { provider: string; model: string }
  /** Validation-period activity journal (optional). */
  readonly journal?: Journal
  /**
   * True once the composition that created this engine has been disposed
   * (hmr reload, remount). A stale engine instance can keep receiving host
   * calls after its stores were closed — those calls must no-op, never throw:
   * an error escaping `compactIfNeeded` lands in the middle of a host step
   * and interrupts the session (measured live as `database is not open`).
   */
  readonly isDisposed?: () => boolean
}

/**
 * What {@link registerMagicCompactionEngine} hands back: the mounted fiber.
 * `dispose()` unmounts the engine from `ctx.compaction`, which is what lets
 * the composition follow a runtime `registerCompactionEngine` toggle off.
 */
export interface EngineHandle {
  readonly dispose: () => Promise<void>
}

/** A structurally complete `CompactionResult` (the seam's result shape). */
interface CheckpointResult {
  readonly compactionId: string
  readonly sourceCommandId?: string
  readonly startSeq: number
  readonly summarySeq: number
  readonly endSeq: number
  readonly summary: ContentBlock[]
  readonly shadowedRange: { start: number; end: number }
  readonly shadowedSeqs: number[]
  readonly shadowedTokenCount: number
}

function digestText(draft: CompartmentDraft): string {
  const lines = [draft.tiers.p1]
  if (draft.facts.length > 0) {
    lines.push(`facts: ${draft.facts.map(fact =>
      fact.category.length === 0 ? fact.content : `[${fact.category}] ${fact.content}`).join(' | ')}`)
  }
  if (draft.events.length > 0) lines.push(`events: ${draft.events.join(' | ')}`)
  return lines.join('\n')
}

/** Map an explicit surface span (first/last node seqs, either order) to nodes. */
function regionNodes(nodes: readonly SurfaceNode[], start: number, end: number): SurfaceNode[] {
  const first = nodes.findIndex(node => node.seq === start)
  const last = nodes.findIndex(node => node.seq === end)
  if (first === -1 || last === -1) return []
  const [from, to] = first <= last ? [first, last] : [last, first]
  return nodes.slice(from, to + 1)
}

/**
 * Create and mount the adapter's CompactionEngine. Awaiting the returned
 * promise settles once the service is provided (or rejects when another
 * engine already owns `ctx.compaction`). The returned handle's `dispose()`
 * unmounts the engine, so the caller can follow a runtime toggle off.
 */
export async function registerMagicCompactionEngine(
  ctx: Context,
  deps: CompactionEngineDeps,
): Promise<EngineHandle> {
  const base = deps.base as new (ctx: unknown, config?: unknown) => {
    compactIfNeeded(agent: unknown, trigger: unknown, signal: AbortSignal): Promise<CheckpointResult | null>
    compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<CheckpointResult | null>
    compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<CheckpointResult>
  }
  /** The live policy at the use point (snapshot fallback: see deps). */
  const policyNow = (): PressurePolicy => deps.activePolicy?.() ?? deps.policy

  const sessionOf = (agent: unknown): Session => {
    const session = (agent as { session?: Session }).session
    if (session === undefined) throw new Error('compaction agent carries no session')
    return session
  }

  /** The manual checkpoint: summarize the span, then write the protocol. */
  const writeCheckpoint = async (input: {
    readonly session: Session
    readonly nodes: readonly SurfaceNode[]
    readonly sourceCommandId?: string
    readonly signal?: AbortSignal
  }): Promise<CheckpointResult> => {
    if (deps.llm === undefined) throw new Error('no LLM seam available for a manual compaction')
    const sessionId = input.session.id
    const systemSeq = enumerateSurfaceNodes(input.session).find(node => node.role === 'system')?.seq
    const draft = await callHistorian(
      {
        policy: policyNow(),
        llm: deps.llm,
        logger: deps.logger,
        ...deps.journal === undefined ? {} : { journal: deps.journal },
        ...deps.route === undefined ? {} : { route: deps.route },
      },
      {
        sessionId,
        session: input.session,
        nodes: input.nodes,
        trigger: 'manual',
        ...deps.route === undefined ? {} : { route: deps.route },
        ...input.signal === undefined ? {} : { signal: input.signal },
        ...systemSeq === undefined ? {} : { systemSeq },
      },
    )
    const compactionId = `mc-${randomUUID()}`
    const summary: ContentBlock[] = [{
      type: 'text',
      text: `${compactedPlaceholder(0).replace('§C0§', '§checkpoint§')}\n${digestText(draft)}`,
    }]
    const shadowedSeqs = input.nodes.map(node => node.seq)
    const first = input.nodes[0] as SurfaceNode
    const last = input.nodes[input.nodes.length - 1] as SurfaceNode
    const shadowedTokenCount = input.nodes.reduce((total, node) => total + estimateTokens(node.text), 0)
    // `Session.append` accepts an options argument only for *surface* event
    // types; `compaction/*` are not among them, so these appends take two.
    const startEvent = input.session.append('compaction/start', {
      compactionId,
      ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
      turn: null,
    } as never)
    const summaryEvent = input.session.append('compaction/summary', {
      compactionId,
      ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
      summary,
      shadowedRange: { start: first.seq, end: last.seq },
      shadowedSeqs,
      shadowedTokenCount,
      provider: deps.route?.provider ?? 'unknown',
      model: deps.route?.model ?? 'unknown',
      maxTokens: policyNow().historianMaxTokens,
      rawOutput: summary,
      llmStreamCall: true,
    } as never)
    // The replacement is appended synchronously after its metering event —
    // the shared shadow-price protocol the session documents.
    replaceSurfaceRange(
      input.session,
      first.seq,
      last.seq,
      summary,
      shadowedSeqs,
      syntheticNodeId('mc-checkpoint'),
      compactCheckpointSource(compactionId, input.sourceCommandId),
    )
    const endEvent = input.session.append('compaction/end', {
      compactionId,
      ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
      turn: null,
    } as never)
    deps.logger.info(
      `magic-context compaction: checkpoint over ${String(input.nodes.length)} nodes `
        + `(~${String(shadowedTokenCount)} tokens, importance ${String(draft.importance)})`,
    )
    deps.journal?.info('engine', `manual checkpoint over ${String(input.nodes.length)} nodes (~${String(shadowedTokenCount)} tokens)`, {
      action: 'checkpoint',
      compactionId,
      sourceCommandId: input.sourceCommandId,
      nodes: input.nodes.length,
      shadowedTokenCount,
      importance: draft.importance,
      startSeq: startEvent.seq,
      endSeq: endEvent.seq,
    }, sessionId)
    return {
      compactionId,
      ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary,
      shadowedRange: { start: first.seq, end: last.seq },
      shadowedSeqs,
      shadowedTokenCount,
    }
  }

  const EngineClass = class MagicContextCompactionEngine extends base {
    static inject: string[] = []

    constructor(engineCtx: unknown, config?: unknown) {
      super(engineCtx, config)
    }

    /** A stale engine (remounted composition) must no-op, never touch closed stores. */
    private usable(): boolean {
      return deps.stores.closed !== true && deps.isDisposed?.() !== true
    }

    /** The pressure path: reclaim, never a checkpoint (Magic Context's promise). */
    async compactIfNeeded(agent: unknown): Promise<CheckpointResult | null> {
      if (!this.usable()) return null
      const session = sessionOf(agent)
      const sessionId = session.id
      try {
        runManagementPass({
          session,
          sessionId,
          stores: deps.stores,
          policy: policyNow(),
          logger: deps.logger,
          pass: { kind: 'execute', reason: 'execute-threshold' },
          pressure: undefined,
          ...deps.llm === undefined ? {} : {
            historian: {
              llm: deps.llm,
              ...deps.route === undefined ? {} : { route: deps.route },
            },
          },
        })
      } catch (error) {
        // A failing pass must never escape into the host's step: warn, record,
        // and let the session continue (the next threshold still retries).
        const detail = errText(error)
        deps.logger.warn(`magic-context compaction: management pass failed (${detail}); session continues`)
        deps.journal?.warn('engine', `management pass failed: ${detail}`, {
          action: 'pass-failed',
          sessionId,
        }, sessionId)
      }
      return null
    }

    /** `/compact`: the user asked, so a real checkpoint is written. */
    async compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<CheckpointResult | null> {
      if (!this.usable()) return null
      const session = sessionOf(agent)
      const nodes = enumerateSurfaceNodes(session)
      const range = selectManualRange(nodes, deps.stores, session.id, policyNow())
      if (range.length === 0) return null
      return writeCheckpoint({
        session,
        nodes: range,
        ...sourceCommandId === undefined ? {} : { sourceCommandId },
        signal,
      })
    }

    async compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<CheckpointResult> {
      if (!this.usable()) throw new Error('compaction engine is shutting down')
      const session = sessionOf(agent)
      const nodes = regionNodes(enumerateSurfaceNodes(session), start, end)
      if (nodes.length === 0) throw new Error('compaction region contains no current surface nodes')
      return writeCheckpoint({
        session,
        nodes,
        ...signal === undefined ? {} : { signal },
      })
    }
  }

  return await ctx.plugin(EngineClass, {})
}

/** The manual range: the same eligibility rules, without the token gate. */
function selectManualRange(
  nodes: readonly SurfaceNode[],
  stores: AdapterStores,
  sessionId: string,
  policy: PressurePolicy,
): SurfaceNode[] {
  const covered = stores.coveredSeqs(sessionId)
  const baselineNodeSeq = stores.baselineState(sessionId)?.nodeSeq
  const skippable = (node: SurfaceNode): boolean =>
    node.role === 'system'
    || node.seq === baselineNodeSeq
    || covered.has(node.seq)
    || node.isPlaceholder
    || /^\[(?:dropped|compacted|checkpoint) §/.test(node.text.trim().slice(0, 24))
    || !node.hasText
  let start = 0
  while (start < nodes.length && skippable(nodes[start] as SurfaceNode)) start += 1
  if (start >= nodes.length) return []
  let cut = Math.max(start, nodes.length - Math.max(0, policy.historianProtectedNodes))
  while (cut > start && (nodes[cut] as SurfaceNode | undefined)?.role === 'tool') cut -= 1
  const slice = nodes.slice(start, cut)
  return slice.length >= Math.max(2, policy.historianMinNodes) ? slice : []
}
