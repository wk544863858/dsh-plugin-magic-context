import { randomUUID } from 'node:crypto'

/**
 * Channel A of "write into the live session stream": a one-off notice entry.
 *
 * The host's transcript renders every `user/message` whose `source.kind` is a
 * producer name as an injection row (event-projection.ts `contextProducer` —
 * unknown kinds stay visible by their durable kind), and `form: 'notice'`
 * renders the collapsed row with the one-line `summary` readable without
 * expanding (`ContextBody.tsx contextBody`, case 'notice'). plan-mode's mode
 * notifications use exactly this shape. The entry is a user-role message, so
 * it IS model-visible: keep it to a couple of short lines and only emit it
 * when something actually happened. The 120-char summary bound mirrors the
 * host's `boundContextSummary` (llm message.ts `CONTEXT_SUMMARY_MAX_CHARS`).
 */

/** The slice of {@link ManagementPassResult} the notice needs. */
export interface SessionNoticeResult {
  readonly published: readonly number[]
  readonly forceDropped: number
  readonly factsPromoted: number
  readonly factsSeenAgain: number
  readonly baselineUpdated: boolean
  readonly tokensBefore: number
  readonly tokensAfter: number
}

/** Structural `session.append` — the plugin cannot import host types. */
export interface SessionNoticeSession {
  append(type: string, data: unknown, options?: unknown): unknown
}

export interface SessionNoticeInput {
  readonly session: SessionNoticeSession
  readonly result: SessionNoticeResult
}

export type SessionNoticeOutcome =
  | { readonly ok: true; readonly summary: string; readonly seq: unknown }
  | { readonly ok: false; readonly reason: 'not-notable' | 'append-failed'; readonly detail?: string }

/** The host's one-line bound for `notice` summaries. */
export const NOTICE_SUMMARY_MAX_CHARS = 120

function boundSummary(summary: string): string {
  return summary.length <= NOTICE_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`
}

function grouped(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * The one-line account of a pass, or null when nothing notable happened.
 * Baseline-only refreshes (a negative token delta with no discrete action)
 * stay quiet: an execute pass runs every step while pressure is high and a
 * notice per step would spam the transcript.
 */
export function sessionNoticeSummary(result: SessionNoticeResult): string | null {
  const parts: string[] = []
  const delta = result.tokensAfter - result.tokensBefore
  if (result.forceDropped > 0) parts.push(`紧急丢弃 ${grouped(result.forceDropped)} 条工具输出`)
  if (result.published.length > 0) {
    parts.push(`压缩 ${grouped(result.published.length)} 个区段`
      + ` ${result.published.map(id => `§C${String(id)}§`).join(' ')}`
      + (delta < 0 ? ` · 回收 ${grouped(-delta)} tok` : ''))
  } else if (delta < 0 && result.forceDropped > 0) {
    parts.push(`回收 ${grouped(-delta)} tok`)
  }
  if (result.factsPromoted > 0) {
    parts.push(`记忆提升 新增 ${grouped(result.factsPromoted)} 条`
      + (result.factsSeenAgain > 0 ? `（另 ${grouped(result.factsSeenAgain)} 条已知）` : ''))
  }
  if (parts.length === 0) return null
  return boundSummary(`Magic Context · ${parts.join(' · ')}`)
}

/**
 * Append one notice entry for a management pass outcome. Never throws: a
 * broken transcript nicety must not wedge the turn (fail-open, like every
 * other best-effort surface in the adapter).
 */
export function appendSessionNotice(input: SessionNoticeInput): SessionNoticeOutcome {
  const summary = sessionNoticeSummary(input.result)
  if (summary === null) return { ok: false, reason: 'not-notable' }
  const lines: string[] = [summary]
  if (input.result.baselineUpdated) lines.push('基线已刷新（m[0] 冻结点前移）')
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'magic-context', form: 'notice', summary },
  }
  try {
    const seq = input.session.append('user/message', message, { surfaceOp: 'append' })
    return { ok: true, summary, seq }
  } catch (error) {
    return {
      ok: false,
      reason: 'append-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
