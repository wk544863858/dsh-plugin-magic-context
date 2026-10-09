import { randomUUID } from 'node:crypto'
import { magicContextSource } from './seams.ts'

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
 *
 * The copy is English on purpose. The locale service is a browser-side layer
 * (`@deepseek-ai/dsh-client-locale`); no Host package consumes the stored
 * `locale.preference`, and every shipped Host surface (compaction, commands,
 * agent instructions) writes English — these rows sit in that same
 * model-visible stream, where a mid-session language flip would also churn the
 * cached prefix. The user-facing translation lives in the browser half's
 * `magic-context` dictionaries instead.
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

/**
 * Structural `session.append` — the plugin cannot import host types.
 *
 * `surface` carries the one precondition this class needs. DSH has exactly two
 * shapes of durable surface write and they bear different safety obligations
 * (audit: `docs/dsh-surface-write-audit-2026-10-09.md`):
 *
 * - **append-type** (this file; the auto-search hint before 0.4.2): legal only
 *   once the session's first `system/message` is on the log. The host writes it
 *   as surface node 0 of the first step, so a record appended before that
 *   becomes node 0 itself, and the loader's `foldSurface` rejects the whole log
 *   on every replay ("requires a protected first surface head") — the
 *   2026-10-09 corruption incident.
 * - **replace-type** (`replaceSurfaceRange`, `replaceToolResultContent`): safe
 *   by construction, because a replacement needs an existing target node, which
 *   cannot exist on a headless surface.
 *
 * A caller that cannot expose the surface degrades to the unguarded behavior;
 * the production caller passes the host session, which has the getter.
 */
export interface SessionNoticeSession {
  append(type: string, data: unknown, options?: unknown): unknown
  readonly surface?: { readonly nodes: readonly unknown[] }
}

export interface SessionNoticeInput {
  readonly session: SessionNoticeSession
  readonly result: SessionNoticeResult
}

export type SessionNoticeOutcome =
  | { readonly ok: true; readonly summary: string; readonly seq: unknown }
  | { readonly ok: false; readonly reason: 'not-notable' | 'headless-surface' | 'append-failed'; readonly detail?: string }

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

/** `1 compartment` / `2 compartments`; the notice carries no plural-rule table. */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
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
  if (result.forceDropped > 0) {
    parts.push(`emergency-dropped ${grouped(result.forceDropped)} `
      + plural(result.forceDropped, 'tool output', 'tool outputs'))
  }
  if (result.published.length > 0) {
    parts.push(`compacted ${grouped(result.published.length)} `
      + plural(result.published.length, 'compartment', 'compartments')
      + ` ${result.published.map(id => `§C${String(id)}§`).join(' ')}`
      + (delta < 0 ? ` · reclaimed ${grouped(-delta)} tok` : ''))
  } else if (delta < 0 && result.forceDropped > 0) {
    parts.push(`reclaimed ${grouped(-delta)} tok`)
  }
  if (result.factsPromoted > 0) {
    parts.push(`promoted ${grouped(result.factsPromoted)} `
      + plural(result.factsPromoted, 'memory', 'memories')
      + (result.factsSeenAgain > 0 ? ` (${grouped(result.factsSeenAgain)} already known)` : ''))
  }
  if (parts.length === 0) return null
  return boundSummary(`Magic Context · ${parts.join(' · ')}`)
}

/**
 * Append one magic-context entry to the live stream. The single home of the entry
 * shape: a user-role message carrying the plugin source, appended with
 * `surfaceOp: 'append'` so the host accepts it as a normal tail node.
 *
 * Refuses on a headless surface: an out-of-band append before the host has
 * written surface node 0 (the first `system/message`) would take that position
 * itself and make the log unloadable on replay (2026-10-09 incident; the class
 * rule lives in {@link SessionNoticeSession}).
 *
 * Never throws: a broken transcript nicety must not wedge the turn.
 * @param session - the session whose stream is appended to.
 * @param text - the model-visible body (keep it short; it becomes context).
 * @param summary - the one-line collapsed row the transcript shows.
 * @returns the appended seq, or the refusal/append failure.
 */
export function appendMagicContextEntry(
  session: SessionNoticeSession,
  text: string,
  summary: string,
): { readonly ok: true; readonly seq: unknown }
  | { readonly ok: false; readonly reason: 'headless-surface'; readonly detail?: undefined }
  | { readonly ok: false; readonly reason: 'append-failed'; readonly detail: string } {
  if (session.surface !== undefined && session.surface.nodes.length === 0) {
    return { ok: false, reason: 'headless-surface' }
  }
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: magicContextSource(boundSummary(summary)),
  }
  try {
    return { ok: true, seq: session.append('user/message', message, { surfaceOp: 'append' }) }
  } catch (error) {
    return { ok: false, reason: 'append-failed', detail: error instanceof Error ? error.message : String(error) }
  }
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
  if (input.result.baselineUpdated) lines.push('Baseline refreshed (m[0] frozen point advanced)')
  const appended = appendMagicContextEntry(input.session, lines.join('\n'), summary)
  if (!appended.ok) {
    return appended.reason === 'headless-surface'
      ? { ok: false, reason: 'headless-surface' }
      : { ok: false, reason: 'append-failed', detail: appended.detail }
  }
  return { ok: true, summary, seq: appended.seq }
}
