/**
 * Neutral vocabulary shared by the DSH adapter's core logic.
 *
 * NOTHING in `src/core` may import from `@deepseek-ai/*`. The DSH contact
 * surface lives entirely in `src/dsh/`; translation between the two
 * vocabularies happens there. This is the upgrade-insulation contract:
 * when DSH iterates, only `src/dsh/` changes; when Magic Context core is
 * wired in (Phase 1+), it is consumed through its existing host seams and
 * this package's stores, never through DSH types.
 */

/** Stable message identity inside one session (DSH MessageId today). */
export type NeutralMessageId = string

/** Stable tool-call identity inside one session (DSH ToolCallId today). */
export type NeutralCallId = string

/** What a §N§ tag was allocated for. */
export type TagTarget =
  | { kind: 'user-message'; messageId: NeutralMessageId }
  | { kind: 'tool-result'; callId: NeutralCallId }

/** A persisted §N§ tag allocation. */
export interface TagRecord {
  readonly sessionId: string
  readonly tagNumber: number
  readonly target: TagTarget
  readonly createdAt: number
}

/** One recorded provider usage sample (anchored to the durable event). */
export interface UsageRecord {
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly model: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly recordedAt: number
}

/**
 * A planned durable surface mutation, in neutral terms. Phase 0 implements
 * the drop placeholder; Phase 1 maps Magic Context's transform decisions
 * onto this shape before the DSH seam executes them.
 */
export type SurfaceOp =
  | {
    readonly op: 'drop-placeholder'
    readonly tagNumber: number
    /** Durable seq of the surface node being replaced. */
    readonly targetSeq: number
  }
