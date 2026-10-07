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

/** The one error-to-text spelling: every catch that logs or journals a
 * failure composes its message through this, never by re-testing the shape. */
export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
