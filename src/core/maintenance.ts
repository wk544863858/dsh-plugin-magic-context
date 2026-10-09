/**
 * Maintenance tick — the adapter's replacement for the slice of MC's dreamer
 * that survives without a hidden agent.
 *
 * 1. TTL expiry: rows whose `expires_at` has lapsed are archived through the
 *    contract action (`archiveMemory`), so the mutation log, dedup and the
 *    authority guard all stay in the loop. MC basis: `constants.ts` TTL table
 *    (WORKFLOW_RULES 90d, KNOWN_ISSUES 30d) applied by the dreamer's expire
 *    pass; here expiry is evaluated lazily at tick time instead of cron.
 * 2. Verification: unverified rows are batched to the LLM (the same `ctx.llm`
 *    seam the historian uses). MC basis: `dreamer/verify.ts` — the verdict
 *    manifest is applied HOST-side; keep → per-memory `verified_at`
 *    (metadata only, no mutation log), stale → `updateMemory`, wrong →
 *    `archiveMemory` — i.e. the existing contract actions, never a new write
 *    kind. Each verdict may also carry an `importance` score, banked through
 *    the metadata-only `classifyMemories` (MC's classify-memories slice) to
 *    feed m[0]'s ranking. Budget: at most VERIFY_BATCH rows per tick; a failed
 *    or unparsable call is journaled and retried on a later tick (fail-open,
 *    like MC's "a timed-out batch banks what it verified" per-memory
 *    watermark).
 *
 * Scope deviation (recorded): MC's dreamer sweeps every project in the
 * shared store; the adapter only ever touches rows owned by its own project
 * identity. Other projects belong to the MC application or their own agents.
 */
import type { Journal } from './journal.ts'
import type { MemoryRecord, MemoryWriter } from './memory-write.ts'
import type { LlmSeamMessage } from './types.ts'

/** The narrow LLM seam maintenance needs (structurally `ctx.llm`). */
export interface MaintenanceLlm {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly messages: readonly LlmSeamMessage[]
    readonly maxTokens: number
    readonly sessionId: string
    readonly purpose: 'compaction'
    readonly signal?: AbortSignal
  }): AsyncIterable<unknown>
}

export interface MaintenanceDeps {
  readonly writer?: MemoryWriter
  /** Project identity to maintain (own rows only — see the scope note above). */
  readonly identity?: string
  readonly llm?: MaintenanceLlm
  /** Maintenance runs outside any session, so the route must be configured. */
  readonly route?: { readonly provider: string; readonly model: string }
  readonly sessionId: string
  readonly journal: Journal
  readonly now?: () => number
}

export interface MaintenanceOutcome {
  readonly expired: number
  readonly verified: number
  readonly updated: number
  readonly archived: number
  readonly verifyRan: boolean
  /** Set when the tick could not run at all (writer missing/read-only). */
  readonly reason?: 'writer-unavailable' | 'read-only' | 'llm-failed'
}

/** TTL rows archived per tick; the list is already capped by `listExpired`. */
const EXPIRE_BATCH = 200
/** Unverified rows judged per tick — an LLM call per tick. Sized against the
 * observed promotion inflow (peak ~165 rows/day on 2026-10-09): at the 30-min
 * cadence the old 3/tick capped the sweep at 144 rows/day — the ceiling
 * itself. 16 keeps ~6× headroom at a trivial prompt size (16 × 400-char
 * previews). */
const VERIFY_BATCH = 16
/** Per-row content budget in the verification prompt. */
const CONTENT_PREVIEW = 400
/** Output cap. Reasoning is billed against it and a heavy thinking pass can
 * consume the whole budget before emitting any text (measured: 8192 produced
 * zero deltas on one tick and three verdicts on another). 32768 is the
 * historian's ceiling — the same floor/ceiling reasoning applies here. */
const VERIFY_MAX_TOKENS = 32768

const VERIFY_INSTRUCTION = [
  'You are auditing project memories for a coding agent. For each memory, judge whether it is still true and useful for this project:',
  '- "verified": still accurate and worth keeping.',
  '- "stale": outdated or partly wrong; provide the corrected "content" (same style, self-contained).',
  '- "wrong": plain incorrect or harmful; provide a short "reason".',
  '- "skip": cannot judge from the text alone.',
  'Also score every memory with "importance" (1-100): how load-bearing is it for future sessions? Roughly: 80+ project rules/constraints, 60-79 architecture/config facts, 40-59 routine context, under 40 trivia.',
  'Judge only from general software-engineering plausibility and internal consistency; you have no file access.',
  'Reply with ONLY a JSON object: {"verdicts":[{"id":<number>,"verdict":"verified"|"stale"|"wrong"|"skip","importance"?:number,"content"?:string,"reason"?:string}]}',
].join('\n')

/** Salvage complete `{...}` objects from a truncated verdict array. A reasoning
 * model that runs out of output mid-array still yields usable leading verdicts;
 * discarding the whole call would just retry the same truncation next tick. */
function salvageObjects(inner: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(inner.slice(start, i + 1))) } catch { /* skip malformed object */ }
        start = -1
      }
    }
  }
  return out
}

/** Extract the first JSON object from a model reply (tolerates prose fences). */
function parseVerdicts(text: string): Array<{ id: number; verdict: string; importance?: number; content?: string; reason?: string }> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  const slice = text.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    const arrayStart = slice.indexOf('[')
    if (arrayStart < 0) return []
    parsed = { verdicts: salvageObjects(slice.slice(arrayStart + 1)) }
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts
  if (!Array.isArray(verdicts)) return []
  const out: Array<{ id: number; verdict: string; importance?: number; content?: string; reason?: string }> = []
  for (const item of verdicts) {
    const row = item as { id?: unknown; verdict?: unknown; importance?: unknown; content?: unknown; reason?: unknown }
    if (typeof row.id !== 'number' || typeof row.verdict !== 'string') continue
    out.push({
      id: row.id,
      verdict: row.verdict,
      ...(typeof row.importance === 'number' && Number.isFinite(row.importance) ? { importance: row.importance } : {}),
      ...(typeof row.content === 'string' && row.content.trim().length > 0 ? { content: row.content.trim() } : {}),
      ...(typeof row.reason === 'string' && row.reason.trim().length > 0 ? { reason: row.reason.trim() } : {}),
    })
  }
  return out
}

/** One LLM round trip. Returns the raw text, or the reason it produced none —
 * the reason is journaled (a bare "verify call failed" hid six live ticks
 * worth of root cause). */
async function collectText(llm: MaintenanceLlm, deps: MaintenanceDeps, userPrompt: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; why: string }> {
  const byIndex = new Map<number, string>()
  let truncated = false
  try {
    const chunks = llm.stream({
      provider: deps.route!.provider,
      model: deps.route!.model,
      // The DSH llm seam takes content BLOCKS, not a bare string (the host
      // calls content.some(...) — a string threw "content.some is not a
      // function" and failed every tick silently).
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
      maxTokens: VERIFY_MAX_TOKENS,
      sessionId: deps.sessionId,
      purpose: 'compaction',
    })
    for await (const raw of chunks) {
      const chunk = raw as { type: string; index?: number; text?: string }
      if (chunk.type === 'text-delta' && typeof chunk.index === 'number' && typeof chunk.text === 'string') {
        byIndex.set(chunk.index, (byIndex.get(chunk.index) ?? '') + chunk.text)
      } else if (chunk.type === 'finish') {
        // Same terminal-reason semantics as the historian's collector:
        // error/aborted fail with the failure detail. max-tokens is NOT fatal
        // here: the verdict list is a flat JSON array, so whatever objects made
        // it out before the cap are still worth banking (MC's "a timed-out
        // batch banks what it verified"); rows without a verdict stay
        // unverified and are retried on a later tick.
        const reason = (raw as { reason?: { kind?: string; failure?: { message?: string; code?: string } } }).reason
        if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
          const detail = reason.failure?.message ?? reason.failure?.code
          return { ok: false, why: `stream finished (${reason.kind})${detail === undefined ? '' : `: ${detail}`}` }
        }
        if (reason?.kind === 'max-tokens') truncated = true
      }
    }
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) }
  }
  const text = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('')
  if (text.length === 0) return { ok: false, why: truncated ? 'stream hit max-tokens with no text' : 'stream produced no text deltas' }
  return { ok: true, text, truncated }
}

function renderRow(row: MemoryRecord, nowMs: number): string {
  const ageDays = Math.max(0, Math.round((nowMs - row.createdAt) / 86_400_000))
  const content = row.content.length > CONTENT_PREVIEW ? row.content.slice(0, CONTENT_PREVIEW) + '…' : row.content
  return `- id ${String(row.id)} [${row.category}] (age ${String(ageDays)}d): ${content.replace(/\s+/g, ' ')}`
}

/** Run one maintenance tick. Never throws — every failure is journaled. */
export async function runMaintenanceTick(deps: MaintenanceDeps): Promise<MaintenanceOutcome> {
  const now = (deps.now ?? Date.now)()
  const writer = deps.writer
  const identity = deps.identity
  const tally = { expired: 0, verified: 0, updated: 0, archived: 0, verifyRan: false }
  if (!writer || !identity) return { ...tally, reason: 'writer-unavailable' }
  if (writer.status.readOnly === true) return { ...tally, reason: 'read-only' }

  // 1) TTL expiry — archive is the contract action, so the mutation log and
  //    authority guard stay authoritative even in bulk maintenance.
  for (const id of writer.listExpired(identity, now, EXPIRE_BATCH)) {
    const result = writer.archiveMemory({ identity, id, reason: 'ttl-expired' })
    if (result.ok) tally.expired += 1
  }

  // 2) Verification — configured route or nothing (no session to inherit).
  if (!deps.llm || !deps.route) {
    const pool = writer.stats(identity).unverified
    deps.journal.info('maintenance', `maintenance: expired ${String(tally.expired)} (verify off: no llm route; pool ${String(pool)})`, {
      expired: tally.expired,
      poolUnverified: pool,
      verify: 'off',
    })
    return { ...tally }
  }
  // The unverified filter runs in SQL (before the limit): filtering a fixed
  // render window instead let the sweep stall once its first rows were
  // verified, because verification deliberately leaves `updated_at` alone and
  // those rows keep their window slots. Recurrence (seen_count ≥ 2) jumps the
  // queue — see listMemoriesSql.
  const candidates = writer.listMemories(identity, { limit: VERIFY_BATCH, now, unverifiedOnly: true })
  if (candidates.length === 0) {
    deps.journal.info('maintenance', `maintenance: expired ${String(tally.expired)} (nothing to verify)`, {
      expired: tally.expired,
      poolUnverified: 0,
      verify: 'idle',
    })
    return { ...tally }
  }
  const prompt = VERIFY_INSTRUCTION
    + '\n\nProject identity: ' + identity + '\nMemories:\n'
    + candidates.map(row => renderRow(row, now)).join('\n')
  const call = await collectText(deps.llm, deps, prompt)
  if (!call.ok) {
    deps.journal.warn('maintenance', `maintenance: verify call failed (retried next tick): ${call.why}`, {
      candidates: candidates.length,
      why: call.why,
      route: `${deps.route!.provider}/${deps.route!.model}`,
      verify: 'failed',
    })
    return { ...tally, reason: 'llm-failed' }
  }
  const text = call.text
  const verdicts = parseVerdicts(text)
  const verifiedIds: number[] = []
  const scored: Array<{ id: number; importance: number }> = []
  const lagMs: number[] = []
  const known = new Map(candidates.map(row => [row.id, row] as const))
  let skipped = 0
  for (const verdict of verdicts) {
    const row = known.get(verdict.id)
    if (row === undefined) continue
    // A score is independent of the verdict's direction — bank it whenever the
    // model offered one; classifyMemories self-filters archived/foreign rows.
    if (verdict.importance !== undefined) scored.push({ id: verdict.id, importance: verdict.importance })
    if (verdict.verdict === 'verified') {
      verifiedIds.push(verdict.id)
      lagMs.push(now - row.createdAt)
    } else if (verdict.verdict === 'stale' && verdict.content !== undefined) {
      const result = writer.updateMemory({ identity, id: verdict.id, content: verdict.content })
      if (result.ok) {
        tally.updated += 1
        lagMs.push(now - row.createdAt)
      }
    } else if (verdict.verdict === 'wrong') {
      const result = writer.archiveMemory({ identity, id: verdict.id, reason: 'verify-wrong' })
      if (result.ok) {
        tally.archived += 1
        lagMs.push(now - row.createdAt)
      }
    } else if (verdict.verdict === 'skip') {
      skipped += 1
    }
  }
  if (verifiedIds.length > 0) tally.verified = writer.markVerified(identity, verifiedIds, now)
  // Classify scoring rides the same verdict round trip (MC's classify slice):
  // metadata-only, applied AFTER the content verdicts so a stale rewrite is
  // scored on its corrected text and archived rows self-filter through the
  // status clause. Feed m[0]'s importance ranking (memory-selection order).
  const scoredApplied = scored.length > 0 ? writer.classifyMemories(identity, scored, now) : 0
  tally.verifyRan = true
  // Telemetry anchors for the memory lane (mc-report aggregates these):
  // verification lag and the unverified pool size are the staging trigger
  // lines, and wrong-rate comes from archived/verdicts.
  const lagHours = lagMs.map(ms => ms / 3_600_000)
  const lagMaxH = lagHours.length > 0 ? Math.max(...lagHours) : undefined
  const lagAvgH = lagHours.length > 0 ? lagHours.reduce((sum, value) => sum + value, 0) / lagHours.length : undefined
  const round1 = (value: number): number => Math.round(value * 10) / 10
  const pool = writer.stats(identity).unverified
  deps.journal.info(
    'maintenance',
    `maintenance: expired ${String(tally.expired)} · verified ${String(tally.verified)}`
      + ` · updated ${String(tally.updated)} · archived ${String(tally.archived)}`
      + ` · scored ${String(scoredApplied)} · pool ${String(pool)}`
      + (call.truncated ? ` (truncated: banked ${String(verdicts.length)}/${String(candidates.length)} verdicts)` : ''),
    {
      expired: tally.expired,
      verified: tally.verified,
      updated: tally.updated,
      archived: tally.archived,
      scored: scoredApplied,
      skipped,
      candidates: candidates.length,
      verdicts: verdicts.length,
      poolUnverified: pool,
      verify: 'ran',
      ...(lagMaxH !== undefined ? { lagMaxH: round1(lagMaxH) } : {}),
      ...(lagAvgH !== undefined ? { lagAvgH: round1(lagAvgH) } : {}),
      ...call.truncated ? { truncated: true } : {},
      route: `${deps.route!.provider}/${deps.route!.model}`,
    },
  )
  return { ...tally }
}
