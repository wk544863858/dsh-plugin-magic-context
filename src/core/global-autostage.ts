/**
 * L1① v10 — classify-then-route machine/org auto-stage (2026-10-12, user-
 * directed). The previous leg scanned the contract store and mechanically
 * promoted every qualifying memory into the MACHINE domain — and that default
 * was wrong in both directions: an organisation workflow ("project-a/project-b must
 * deploy serially") got routed to machine because the SQL rule cannot read
 * content, and a classification failure silently assumed machine. The user's
 * correction: the LLM decides the domain, and when it cannot, the memory STAYS
 * AT PROJECT LEVEL — never a guessed fallback domain (machine or org can both
 * be "seen" by other projects, so guessing either one hides the misstep).
 *
 * Flow per maintenance tick:
 *  1. scan recurred, allowlisted, non-global project memories (union of the
 *     ENABLED global domains' shareCategories — machine and org together, so
 *     neither audience is invisible to the classifier);
 *  2. one LLM call per candidate: {"domain": "machine"|"org"|"project",
 *     "reason": "<one line>"};
 *  3. route: machine → machine pool, org → org pool (only when that domain is
 *     enabled AND the candidate's category is on its current allowlist —
 *     otherwise NOT staged); project / unparseable / no-LLM → NOT staged.
 *
 * The suggestion rides the candidate row (`suggested_domain` +
 * `suggestion_reason`), so the review card can show what the classifier said
 * and the human can overrule it (the card's "publish to another domain"
 * option). Publishing stays human — this leg only fills the pools.
 */
import { DatabaseSync } from 'node:sqlite'
import type { LlmSeamMessage } from './types.ts'
import type { AdapterStores } from './stores.ts'

/** The narrow LLM seam classification needs (same shape maintenance uses). */
export interface AutoStageLlm {
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

export interface AutoStageOutcome {
  /** Newly staged candidates this pass (upserts of already-staged rows excluded). */
  readonly staged: ReadonlyArray<{
    readonly candidateId: number
    readonly memoryId: number
    readonly domainId: string
  }>
  /** Memories examined and refused, one readable reason each (deduplicated). */
  readonly skipped: ReadonlyArray<{ readonly memoryId: number; readonly reason: string }>
  /** Set instead of scanning when the preconditions fail (no domain, no LLM, every pool full). */
  readonly reason?: 'domain-missing' | 'llm-unavailable' | 'queue-full'
}

const DEFAULT_LIMIT = 3
const DEFAULT_MAX_PENDING = 10
const CLASSIFY_MAX_TOKENS = 2048

const CLASSIFY_INSTRUCTION = [
  'You are classifying a recurring project memory for possible global promotion. Judge which audience it belongs to:',
  '- "machine": useful to every project on THIS machine — local tooling, local conventions, machine environment facts.',
  '- "org": an organisation-wide rule or workflow that every member project should follow.',
  '- "project": project-specific only; must NOT be promoted.',
  'Reply with ONLY a JSON object: {"domain":"machine"|"org"|"project","reason":"<one line>"}',
].join('\n')

/** Extract the classification from a raw model reply; undefined on unparseable/absent. */
function parseClassification(
  text: string,
): { readonly domain: 'machine' | 'org' | 'project'; readonly reason?: string } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  const record = parsed as { domain?: unknown; reason?: unknown }
  const domain = record.domain
  if (domain !== 'machine' && domain !== 'org' && domain !== 'project') return undefined
  const reason = typeof record.reason === 'string' && record.reason.trim() !== '' ? record.reason.trim() : undefined
  return { domain, ...(reason === undefined ? {} : { reason }) }
}

async function classify(
  llm: AutoStageLlm,
  route: { readonly provider: string; readonly model: string },
  row: { readonly id: number; readonly content: string; readonly category: string },
  sessionId: string,
): Promise<{ readonly domain: 'machine' | 'org' | 'project'; readonly reason?: string } | undefined> {
  const prompt = CLASSIFY_INSTRUCTION
    + '\n\nMemory content:\n' + row.content.slice(0, 600).replace(/\s+/g, ' ')
    + '\nCategory: ' + row.category
  let text = ''
  try {
    const chunks = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: CLASSIFY_MAX_TOKENS,
      sessionId,
      purpose: 'compaction',
    })
    for await (const raw of chunks) {
      const chunk = raw as { type: string; index?: number; text?: string }
      if (chunk.type === 'text-delta' && typeof chunk.index === 'number' && typeof chunk.text === 'string') {
        text += chunk.text
      }
    }
  } catch {
    return undefined
  }
  return parseClassification(text)
}

export async function autoStageGlobalCandidates(input: {
  store: AdapterStores
  corpusDbPath: string
  /** Per-pass ceiling on NEW candidates. */
  limit?: number
  /** Pending-queue depth at which staging pauses entirely (default 10). */
  maxPending?: number
  now: number
  /** Absent or route absent → NOTHING is staged (project-level stays, never a guessed domain). */
  llm?: AutoStageLlm
  route?: { readonly provider: string; readonly model: string }
}): Promise<AutoStageOutcome> {
  const enabled = input.store.listDomains()
    .filter(domain => domain.enabled && (domain.kind === 'machine' || domain.kind === 'org'))
  if (enabled.length === 0) return { staged: [], skipped: [], reason: 'domain-missing' }
  if (input.llm === undefined || input.route === undefined) {
    // The user's fail-closed direction: without a classifier nothing moves —
    // the memories stay at project level instead of being silently guessed
    // into a domain.
    return { staged: [], skipped: [], reason: 'llm-unavailable' }
  }
  const limit = input.limit ?? DEFAULT_LIMIT
  const maxPending = input.maxPending ?? DEFAULT_MAX_PENDING

  // The queue guard is domain-level: each pool pauses independently when IT is
  // full (a full org pool must not starve the machine pool). When EVERY
  // enabled target pool is full the whole pass pauses up front.
  const queueGuard = (domainId: string): boolean =>
    input.store.listGlobalCandidates({ state: 'pending', domainId }).length >= maxPending
  if (enabled.every(domain => queueGuard(domain.domainId))) {
    return { staged: [], skipped: [], reason: 'queue-full' }
  }

  interface ScanRow {
    readonly id: number
    readonly content: string
    readonly category: string
  }
  let scan: ScanRow[]
  try {
    const db = new DatabaseSync(input.corpusDbPath, { readOnly: true })
    try {
      const categories = JSON.stringify(enabled.flatMap(domain => [...domain.shareCategories]))
      scan = db.prepare(
        `SELECT id, content, category FROM memories
         WHERE status = 'active' AND scope = 'project' AND seen_count >= 2
           AND category IN (SELECT value FROM json_each(?))
           AND project_path NOT LIKE 'dir:global:%' AND project_path NOT LIKE 'git:global:%'
         ORDER BY updated_at DESC LIMIT 50`,
      ).all(categories) as unknown as ScanRow[]
    } finally {
      db.close()
    }
  } catch {
    return { staged: [], skipped: [], reason: 'domain-missing' }
  }

  const staged: Array<{ candidateId: number; memoryId: number; domainId: string }> = []
  const skipped: Array<{ memoryId: number; reason: string }> = []
  const seenRefusals = new Set<string>()
  const sessionId = 'mc-maintenance'
  // Exact "created this pass" detection: everything already in any pool is
  // known before the loop; the upsert is idempotent per (domain, hash), so a
  // re-scan returns the SAME row and must not count as new.
  const known = new Set(input.store.listGlobalCandidates().map(candidate => candidate.id))
  for (const row of scan) {
    if (staged.length >= limit) break
    const verdict = await classify(input.llm, input.route, row, sessionId)
    if (verdict === undefined || verdict.domain === 'project') {
      const reason = verdict === undefined ? 'unclassified' : 'project-scope'
      if (!seenRefusals.has(`${String(row.id)}:${reason}`)) {
        skipped.push({ memoryId: row.id, reason })
        seenRefusals.add(`${String(row.id)}:${reason}`)
      }
      continue
    }
    const target = enabled.find(domain => domain.kind === verdict.domain)
    if (target === undefined) {
      if (!seenRefusals.has(`${String(row.id)}:target-disabled`)) {
        skipped.push({ memoryId: row.id, reason: 'target-disabled' })
        seenRefusals.add(`${String(row.id)}:target-disabled`)
      }
      continue
    }
    if (queueGuard(target.domainId)) {
      if (!seenRefusals.has(`${String(row.id)}:queue-full`)) {
        skipped.push({ memoryId: row.id, reason: 'queue-full' })
        seenRefusals.add(`${String(row.id)}:queue-full`)
      }
      continue
    }
    if (!target.shareCategories.includes(row.category)) {
      if (!seenRefusals.has(`${String(row.id)}:outside-allowlist`)) {
        skipped.push({ memoryId: row.id, reason: 'outside-allowlist' })
        seenRefusals.add(`${String(row.id)}:outside-allowlist`)
      }
      continue
    }
    const result = promoteMemoryToCandidate(
      input.store,
      { corpusDbPath: input.corpusDbPath, memoryId: row.id, domainId: target.domainId, now: input.now },
      verdict.domain,
      verdict.reason,
    )
    if (result.ok) {
      if (!known.has(result.candidate.id)) {
        known.add(result.candidate.id)
        staged.push({ candidateId: result.candidate.id, memoryId: row.id, domainId: target.domainId })
      }
      continue
    }
    const key = `${String(row.id)}:${result.error}`
    if (!seenRefusals.has(key)) {
      skipped.push({ memoryId: row.id, reason: result.error })
      seenRefusals.add(key)
    }
  }
  return { staged, skipped }
}

function promoteMemoryToCandidate(
  store: AdapterStores,
  options: { corpusDbPath: string; memoryId: number; domainId: string; now: number },
  suggestedDomain: 'machine' | 'org',
  suggestionReason: string | undefined,
): { readonly ok: true; readonly candidate: { readonly id: number } } | { readonly ok: false; readonly error: string } {
  const memory = readCorpusMemory(options.corpusDbPath, options.memoryId)
  if (memory === undefined) return { ok: false, error: 'no memory in shared store' }
  if (memory.status !== 'active') return { ok: false, error: `memory is ${memory.status}` }
  const candidate = store.upsertGlobalCandidate(
    {
      domainId: options.domainId,
      content: memory.content,
      normalizedHash: memory.normalizedHash,
      firstIdentity: memory.projectPath,
      category: memory.category,
      sourceMemoryId: memory.id,
      suggestedDomain,
      ...(suggestionReason === undefined ? {} : { suggestionReason }),
    },
    options.now,
  )
  store.recordCandidateObservation(
    { candidateId: candidate.id, identity: memory.projectPath, sessionId: `memory:${String(memory.id)}` },
    options.now,
  )
  const refreshed = store.getGlobalCandidate(candidate.id) ?? candidate
  return { ok: true, candidate: refreshed }
}

function readCorpusMemory(
  corpusDbPath: string,
  memoryId: number,
): { readonly id: number; readonly content: string; readonly category: string; readonly normalizedHash: string; readonly projectPath: string; readonly status: string } | undefined {
  try {
    const db = new DatabaseSync(corpusDbPath, { readOnly: true })
    try {
      const row = db.prepare(
        'SELECT id, content, category, normalized_hash, project_path, status FROM memories WHERE id = ?',
      ).get(memoryId) as Record<string, unknown> | undefined
      if (row === undefined) return undefined
      return {
        id: Number(row.id),
        content: String(row.content),
        category: String(row.category),
        normalizedHash: String(row.normalized_hash),
        projectPath: String(row.project_path),
        status: String(row.status),
      }
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}
