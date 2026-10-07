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
 *    kind. Budget: at most VERIFY_BATCH rows per tick; a failed or unparsable
 *    call is journaled and retried on a later tick (fail-open, like MC's
 *    "a timed-out batch banks what it verified" per-memory watermark).
 *
 * Scope deviation (recorded): MC's dreamer sweeps every project in the
 * shared store; the adapter only ever touches rows owned by its own project
 * identity. Other projects belong to the MC application or their own agents.
 */
import type { Journal } from './journal.ts'
import type { MemoryRecord, MemoryWriter } from './memory-write.ts'

/** The narrow LLM seam maintenance needs (structurally `ctx.llm`). */
export interface MaintenanceLlm {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly messages: readonly unknown[]
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
/** Unverified rows judged per tick — small on purpose (LLM call per tick). */
const VERIFY_BATCH = 3
/** Per-row content budget in the verification prompt. */
const CONTENT_PREVIEW = 400
const VERIFY_MAX_TOKENS = 2048

const VERIFY_INSTRUCTION = [
  'You are auditing project memories for a coding agent. For each memory, judge whether it is still true and useful for this project:',
  '- "verified": still accurate and worth keeping.',
  '- "stale": outdated or partly wrong; provide the corrected "content" (same style, self-contained).',
  '- "wrong": plain incorrect or harmful; provide a short "reason".',
  '- "skip": cannot judge from the text alone.',
  'Judge only from general software-engineering plausibility and internal consistency; you have no file access.',
  'Reply with ONLY a JSON object: {"verdicts":[{"id":<number>,"verdict":"verified"|"stale"|"wrong"|"skip","content"?:string,"reason"?:string}]}',
].join('\n')

/** Extract the first JSON object from a model reply (tolerates prose fences). */
function parseVerdicts(text: string): Array<{ id: number; verdict: string; content?: string; reason?: string }> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts
  if (!Array.isArray(verdicts)) return []
  const out: Array<{ id: number; verdict: string; content?: string; reason?: string }> = []
  for (const item of verdicts) {
    const row = item as { id?: unknown; verdict?: unknown; content?: unknown; reason?: unknown }
    if (typeof row.id !== 'number' || typeof row.verdict !== 'string') continue
    out.push({
      id: row.id,
      verdict: row.verdict,
      ...(typeof row.content === 'string' && row.content.trim().length > 0 ? { content: row.content.trim() } : {}),
      ...(typeof row.reason === 'string' && row.reason.trim().length > 0 ? { reason: row.reason.trim() } : {}),
    })
  }
  return out
}

/** One LLM round trip; returns the raw text or undefined on any failure. */
async function collectText(llm: MaintenanceLlm, deps: MaintenanceDeps, userPrompt: string): Promise<string | undefined> {
  const byIndex = new Map<number, string>()
  try {
    const chunks = llm.stream({
      provider: deps.route!.provider,
      model: deps.route!.model,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: VERIFY_MAX_TOKENS,
      sessionId: deps.sessionId,
      purpose: 'compaction',
    })
    for await (const raw of chunks) {
      const chunk = raw as { type: string; index?: number; text?: string }
      if (chunk.type === 'text-delta' && typeof chunk.index === 'number' && typeof chunk.text === 'string') {
        byIndex.set(chunk.index, (byIndex.get(chunk.index) ?? '') + chunk.text)
      } else if (chunk.type === 'finish') {
        const reason = (raw as { reason?: { kind?: string } }).reason?.kind
        if (reason === 'error' || reason === 'aborted' || reason === 'max-tokens') return undefined
      }
    }
  } catch {
    return undefined
  }
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('')
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
    deps.journal.info('maintenance', `maintenance: expired ${String(tally.expired)} (verify off: no llm route)`, {
      expired: tally.expired,
    })
    return { ...tally }
  }
  const candidates = writer.listMemories(identity, { limit: 64, now })
    .filter(row => row.verificationStatus === 'unverified')
    .slice(0, VERIFY_BATCH)
  if (candidates.length === 0) {
    deps.journal.info('maintenance', `maintenance: expired ${String(tally.expired)} (nothing to verify)`, {
      expired: tally.expired,
    })
    return { ...tally }
  }
  const prompt = VERIFY_INSTRUCTION
    + '\n\nProject identity: ' + identity + '\nMemories:\n'
    + candidates.map(row => renderRow(row, now)).join('\n')
  const text = await collectText(deps.llm, deps, prompt)
  if (text === undefined) {
    deps.journal.warn('maintenance', 'maintenance: verify call failed (retried next tick)', { candidates: candidates.length })
    return { ...tally, reason: 'llm-failed' }
  }
  const verdicts = parseVerdicts(text)
  const verifiedIds: number[] = []
  const known = new Set(candidates.map(row => row.id))
  for (const verdict of verdicts) {
    if (!known.has(verdict.id)) continue
    if (verdict.verdict === 'verified') verifiedIds.push(verdict.id)
    else if (verdict.verdict === 'stale' && verdict.content !== undefined) {
      const result = writer.updateMemory({ identity, id: verdict.id, content: verdict.content })
      if (result.ok) tally.updated += 1
    } else if (verdict.verdict === 'wrong') {
      const result = writer.archiveMemory({ identity, id: verdict.id, reason: 'verify-wrong' })
      if (result.ok) tally.archived += 1
    }
  }
  if (verifiedIds.length > 0) tally.verified = writer.markVerified(identity, verifiedIds, now)
  tally.verifyRan = true
  deps.journal.info(
    'maintenance',
    `maintenance: expired ${String(tally.expired)} · verified ${String(tally.verified)}`
      + ` · updated ${String(tally.updated)} · archived ${String(tally.archived)}`,
    {
      expired: tally.expired,
      verified: tally.verified,
      updated: tally.updated,
      archived: tally.archived,
      candidates: candidates.length,
      verdicts: verdicts.length,
    },
  )
  return { ...tally }
}
