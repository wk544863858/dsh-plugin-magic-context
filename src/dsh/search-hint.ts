/**
 * Auto-search hint — proactive recall (upstream `auto-search-hint.ts` +
 * `auto-search-runner.ts`).
 *
 * When a new user turn arrives, optionally search this project's memories with the
 * user's OWN words and append a short "you may recall something related" entry to
 * the session stream. The hint deliberately fragments and compresses: the goal is
 * to nudge the agent into running its memory search for full context, not to hand
 * it the answer. Guardrails are upstream's: ≤3 fragments, ~80 chars each, ≤800
 * chars total.
 *
 * Two deliberate differences from upstream:
 *
 * - **Carrier.** Upstream appends the hint to the user message itself. DSH has one
 *   surface shared by the model and the UI, so editing the user's message would
 *   rewrite what they typed; the adapter appends a separate magic-context entry at
 *   the tail instead (`appendMagicContextEntry`). The cache property is the same —
 *   a node appended for this turn is not in the provider's cached prefix.
 * - **Headless-surface guard.** The tail append happens inside the `agent/pre-step`
 *   waterfall, which on a fresh session's first step runs BEFORE the host writes
 *   `step/start` and the first `system/message` (host agent-loop: waterfall →
 *   turn/start → step/start → system commits → admitted batch). The hint would
 *   become surface node 0, and the loader's `foldSurface` then rejects the whole
 *   log ("requires a protected first surface head") on every later replay — the
 *   2026-10-09 corruption incident, 10/10 logs with the hint as the early node.
 *   `planSearchHint` therefore refuses to append while the surface is still empty
 *   (`surfaceNodes === 0`); any non-empty surface has the head as node 0 and a
 *   tail append is safe forever after.
 * - **FTS-only search.** `lane.searchForSession` skips the embedding request, so a
 *   cold local model cannot delay the turn the hint is meant to inform. The
 *   stored-vector lane remains available to `ctx_search`, where the agent asked
 *   for it.
 *
 * Fail-open everywhere: a hint is an optimisation, and no turn may fail over it.
 */
import type { MemorySearchHit } from '../core/memory-search.ts'
import type { Journal } from '../core/journal.ts'
import { appendMagicContextEntry, type SessionNoticeSession } from './session-notice.ts'

/** Upstream's limits (auto-search-hint.ts). */
export const HINT_MAX_FRAGMENTS = 3
export const HINT_FRAGMENT_CHARS = 80
export const HINT_MAX_CHARS = 800
/** Upstream's deadline is 3s; local FTS is milliseconds, so this is a backstop. */
export const HINT_TIMEOUT_MS = 2_000

export interface SearchHintOptions {
  readonly maxFragments?: number
  readonly fragmentChars?: number
}

function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

/**
 * Render the hint entry, or null when there is nothing worth saying.
 * @param hits - ranked memory hits from the FTS lane.
 * @param options - fragment count and per-fragment character cap.
 * @returns the `<ctx-search-hint>` block, bounded by {@link HINT_MAX_CHARS}.
 */
export function buildSearchHint(
  hits: readonly MemorySearchHit[],
  options: SearchHintOptions = {},
): string | null {
  const maxFragments = Math.max(1, options.maxFragments ?? HINT_MAX_FRAGMENTS)
  const fragmentChars = Math.max(20, options.fragmentChars ?? HINT_FRAGMENT_CHARS)
  const lines = hits
    .slice(0, maxFragments)
    .map(hit => truncate(`[${hit.category}] ${hit.preview}`, fragmentChars))
    .filter(fragment => fragment.length > 0)
  if (lines.length === 0) return null
  const header = lines.length === 1
    ? 'Your memory may contain 1 related fragment:'
    : `Your memory may contain ${String(lines.length)} related fragments:`
  const footer = 'If the fragments above seem relevant to the current request, you may run ctx_search '
    + 'to retrieve full context. Otherwise ignore.'
  const body = [header, ...lines.map(line => `- ${line}`), footer].join('\n')
  const wrapped = `<ctx-search-hint>\n${body}\n</ctx-search-hint>`
  if (wrapped.length <= HINT_MAX_CHARS) return wrapped
  const overflow = wrapped.length - HINT_MAX_CHARS
  const trimmed = body.slice(0, Math.max(0, body.length - overflow - 1)).trimEnd()
  return `<ctx-search-hint>\n${trimmed}…\n</ctx-search-hint>`
}

/**
 * One hint per user turn. preStep runs once per model request, so a turn with
 * tool calls would otherwise append the same hint at every step.
 */
export class SearchHintTracker {
  private readonly turns = new Map<string, string>()

  /**
   * Claim the right to hint for one turn.
   * @param sessionId - the session the turn belongs to.
   * @param turnKey - the newest user message id (stable across this turn's steps).
   * @returns true when this turn has not been hinted yet.
   */
  claim(sessionId: string, turnKey: string): boolean {
    if (this.turns.get(sessionId) === turnKey) return false
    this.turns.set(sessionId, turnKey)
    if (this.turns.size > 64) {
      const oldest = this.turns.keys().next().value
      if (oldest !== undefined) this.turns.delete(oldest)
    }
    return true
  }

  /** Forget a session (its hints restart from scratch). */
  forget(sessionId: string): void {
    this.turns.delete(sessionId)
  }
}

export interface SearchHintDeps {
  /** `lane.searchForSession`; undefined turns the lane off. */
  readonly search: ((session: unknown, query: string, limit: number) => Promise<readonly MemorySearchHit[]>) | undefined
  readonly journal?: Journal
  readonly tracker?: SearchHintTracker
  readonly minChars?: number
  readonly limit?: number
  readonly timeoutMs?: number
  readonly now?: () => number
}

export type SearchHintOutcome =
  | { readonly action: 'hinted'; readonly hits: number; readonly text: string }
  | { readonly action: 'quiet'; readonly reason: 'too-short' | 'not-a-prompt' | 'already-hinted' | 'no-hits' | 'lane-off' | 'surface-headless' }
  | { readonly action: 'failed'; readonly reason: 'timeout' | 'search-failed' | 'append-failed' }

/** Bound a promise so a slow search can never hold the turn. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Decide whether this turn gets a hint, and append it when it does.
 *
 * Every outcome is journaled as `search-hint` so the thresholds can be tuned from
 * telemetry rather than guessed at.
 * @param deps - the search closure, journal, and knobs.
 * @param input - the session, the user's text, and this turn's key.
 * @returns what happened, for callers that want to log or assert.
 */
export async function planSearchHint(
  deps: SearchHintDeps,
  input: {
    readonly sessionId: string
    readonly session: SessionNoticeSession
    readonly text: string
    readonly turnKey: string
    /**
     * `session.surface.nodes.length` read by the caller. The protected-head
     * guard: `0` means the first `system/message` is not on the log yet, so a
     * tail append would take surface node 0 and the loader would reject the
     * log on replay. Omitted (unknown) keeps the legacy behavior — the
     * production caller always reads the surface, and a host drift there
     * throws into the pre-step fail-open band, which also skips the hint.
     */
    readonly surfaceNodes?: number
  },
): Promise<SearchHintOutcome> {
  const now = deps.now ?? Date.now
  const record = (outcome: SearchHintOutcome, detail: Record<string, unknown> = {}): SearchHintOutcome => {
    deps.journal?.info(
      'search-hint',
      `auto-search hint: ${outcome.action === 'quiet' ? outcome.reason : outcome.action}`,
      { action: outcome.action, ...'reason' in outcome ? { reason: outcome.reason } : {}, ...detail, trigger: 'pre-step' },
      input.sessionId,
    )
    return outcome
  }
  if (deps.search === undefined) return record({ action: 'quiet', reason: 'lane-off' })
  // Correctness gate before every tuning signal: a headless surface must not
  // be appended to regardless of what the text would have scored.
  if (input.surfaceNodes === 0) return record({ action: 'quiet', reason: 'surface-headless' }, { surfaceNodes: 0 })
  const text = input.text.trim()
  const minChars = deps.minChars ?? 24
  // A command or one of our own hints is never a prompt, however short: the
  // length gate below must not answer for them.
  if (text.startsWith('/') || text.includes('<ctx-search-hint>')) {
    return record({ action: 'quiet', reason: 'not-a-prompt' })
  }
  if (text.length < minChars) return record({ action: 'quiet', reason: 'too-short' }, { chars: text.length })
  if (deps.tracker !== undefined && !deps.tracker.claim(input.sessionId, input.turnKey)) {
    return record({ action: 'quiet', reason: 'already-hinted' })
  }
  const queries = text.slice(0, 400)
  const started = now()
  let hits: readonly MemorySearchHit[]
  try {
    const found = await withDeadline(deps.search(input.session, queries, deps.limit ?? 5), deps.timeoutMs ?? HINT_TIMEOUT_MS)
    if (found === undefined) return record({ action: 'failed', reason: 'timeout' }, { ms: now() - started })
    hits = found
  } catch (error) {
    return record(
      { action: 'failed', reason: 'search-failed' },
      { detail: error instanceof Error ? error.message : String(error) },
    )
  }
  const hint = buildSearchHint(hits)
  if (hint === null) return record({ action: 'quiet', reason: 'no-hits' }, { ms: now() - started })
  const appended = appendMagicContextEntry(
    input.session,
    hint,
    `Magic Context · ${String(hits.length)} possible memory match(es) — ctx_search for full context`,
  )
  if (!appended.ok) {
    return record({ action: 'failed', reason: 'append-failed' }, { detail: appended.detail })
  }
  return record({ action: 'hinted', hits: hits.length, text: hint }, { ms: now() - started, chars: hint.length })
}
