/**
 * Emergency reclaim — the DSH spelling of Magic Context's ≥95% emergency
 * band. Runs under the `agent/request-error` waterfall after a
 * CONTEXT_WINDOW_EXCEEDED failure: drop reclaimable tool-result nodes beyond
 * the protected window, worst-tier and oldest first, and let the caller retry
 * when the surface replacement generation advanced (the compaction-basic
 * recovery pattern: durable surface progress is the retry proof).
 *
 * P2-C1/C2 — the protection model moved from a fixed node count to MC's
 * token-quality scheme:
 *   - window: the newest tagged results are protected while their cumulative
 *     estimate fits `clamp(contextWindow × 5%, 8k, 64k)` tokens
 *     (selection.rs protection window, m0_compose side clamps);
 *   - count floor: the newest `policy.protectedToolResults` nodes stay
 *     protected even when one huge result alone exceeds the window;
 *   - tiers (emergency-drop.ts:54-55 / selection.rs:1185): T1 navigation
 *     (read/task/…) drops last, T2 edit-class drops next, T3 everything else
 *     drops first — oldest first within a tier.
 * Unknown context window → count-floor-only behavior (the pre-C1 semantics).
 */
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { dropPlaceholderContent, replaceToolResultContent, type SurfaceToolNode } from './seams.ts'
import type { PressurePolicy } from '../core/policy.ts'

export interface EmergencyReclaimResult {
  /** Nodes replaced with placeholders, tier order then oldest first. */
  readonly dropped: ReadonlyArray<{ seq: SessionSeq; tagNumber: number }>
  /** Nodes shielded by the protected window (newest first within the window). */
  readonly protectedCount: number
  /** The token estimate of the protected window, when a window applied. */
  readonly protectedTokens?: number
}

/** MC emergency-drop.ts:54-55 — T1 keeps longest, T2 medium, T3 default. */
const T1_TOOLS = new Set(['read', 'todowrite', 'task'])
const T2_TOOLS = new Set(['edit', 'write', 'apply_patch', 'grep', 'glob'])

export type ToolTier = 1 | 2 | 3

/** MC normalizeToolName: lowercase; strip the `mcp_` provider prefix. */
export function normalizeToolName(toolName: string | null): string {
  const lowered = (toolName ?? '').toLowerCase().trim()
  return lowered.startsWith('mcp_') ? lowered.slice(4) : lowered
}

export function resolveToolTier(toolName: string | null): ToolTier {
  const name = normalizeToolName(toolName)
  if (T1_TOOLS.has(name)) return 1
  if (T2_TOOLS.has(name)) return 2
  return 3
}

/** clamp(contextWindow × 5%, 8k, 64k) — undefined when the window is unknown. */
export function protectionWindowTokens(contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined
  }
  return Math.min(64_000, Math.max(8_000, Math.round(contextWindow * 0.05)))
}

/** MC's token estimate for a text length in characters (≈4 chars/token). */
function tokensFor(textLength: number): number {
  return Math.ceil(textLength / 4)
}

/**
 * Drop reclaimable tool results. A node is reclaimable when it carries an
 * adapter tag, is not already a placeholder, and sits outside the protected
 * window: the newest results whose cumulative estimate fits the token window,
 * plus at least the newest `policy.protectedToolResults` tagged nodes.
 */
export function reclaimForEmergency(
  session: Session,
  nodes: readonly SurfaceToolNode[],
  policy: PressurePolicy,
  contextWindow?: number,
): EmergencyReclaimResult {
  const tagged = nodes.filter(node => node.tagNumber !== undefined && !node.isPlaceholder)
  const windowTokens = protectionWindowTokens(contextWindow)

  // Walk newest → oldest: inside the token window, or within the count floor,
  // a node is protected; the first node past both bounds ends the window.
  const protectedSeqs = new Set<SessionSeq>()
  let protectedTokens = 0
  for (let index = tagged.length - 1; index >= 0; index -= 1) {
    const node = tagged[index] as SurfaceToolNode
    const cost = tokensFor(node.textLength)
    const withinWindow = windowTokens !== undefined && protectedTokens + cost <= windowTokens
    if (withinWindow || tagged.length - 1 - index < policy.protectedToolResults) {
      protectedSeqs.add(node.seq)
      protectedTokens += cost
      continue
    }
    break
  }

  // Drop order: worst tier first, oldest first inside a tier.
  const reclaimable = tagged
    .filter(node => !protectedSeqs.has(node.seq))
    .sort((left, right) =>
      resolveToolTier(right.toolName ?? null) - resolveToolTier(left.toolName ?? null)
      || left.seq - right.seq)
  const dropped: Array<{ seq: SessionSeq; tagNumber: number }> = []
  for (const node of reclaimable) {
    const tagNumber = node.tagNumber
    if (tagNumber === undefined) continue
    replaceToolResultContent(session, node.seq, dropPlaceholderContent(tagNumber))
    dropped.push({ seq: node.seq, tagNumber })
  }
  return {
    dropped,
    protectedCount: tagged.length - reclaimable.length,
    ...windowTokens === undefined ? {} : { protectedTokens },
  }
}
