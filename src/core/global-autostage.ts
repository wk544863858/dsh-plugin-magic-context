/**
 * L1① — machine-domain auto-stage (2026-10-12, user-approved).
 *
 * The machine domain's maintenance used to be fully manual: a human spotted a
 * machine-relevant fact, typed `promote`, then typed `approve`. The staging leg
 * is reversible (pending candidate, TTL, no sharing), so it can be automated —
 * THIS module scans the contract store once per maintenance tick and promotes
 * qualifying memories into the machine domain's candidate pool. Publishing
 * stays human (the approve gate is untouched; candidates staged here still need
 * an explicit approve).
 *
 * Eligibility — deliberately narrow, all checked per memory:
 *  - the machine domain row exists AND is enabled (else this module is inert);
 *  - `status='active'`, `scope='project'`, not already a domain identity;
 *  - category ∈ the domain's CURRENT shareCategories allowlist;
 *  - `seen_count >= 2` — the memory recurred within its project (MC's own
 *    promotion-door analog). approvalGate skips recurrence for
 *    source-memory-backed candidates, so the staging-time bar is where the
 *    machine-detected recurrence signal lives;
 *  - no credential body (promoteMemoryToCandidate refuses those; the refusal
 *    is surfaced once per pass, not per tick).
 *
 * Guards: at most `limit` new candidates per pass (default 3) and none at all
 * while the pending queue holds `maxPending` (default 10) — the domain cap
 * bounds published rows, this bounds the review queue. Idempotent: the
 * candidate upsert keys on (domain, normalized_hash), so re-running a pass
 * stages nothing new.
 */
import { DatabaseSync } from 'node:sqlite'
import { promoteMemoryToCandidate } from './global-domains.ts'
import type { AdapterStores } from './stores.ts'

export interface AutoStageOutcome {
  /** Newly staged candidates this pass (upserts of already-staged rows excluded). */
  readonly staged: ReadonlyArray<{ readonly candidateId: number; readonly memoryId: number }>
  /** Memories examined and refused, one readable reason each (deduplicated). */
  readonly skipped: ReadonlyArray<{ readonly memoryId: number; readonly reason: string }>
  /** Set instead of scanning when the preconditions fail (domain off, queue full). */
  readonly reason?: 'domain-missing' | 'domain-disabled' | 'queue-full'
}

const DEFAULT_LIMIT = 3
const DEFAULT_MAX_PENDING = 10

export function autoStageMachineCandidates(input: {
  store: AdapterStores
  contractDbPath: string
  /** Per-pass ceiling on NEW candidates. */
  limit?: number
  /** Pending-queue depth at which staging pauses entirely. */
  maxPending?: number
  now: number
}): AutoStageOutcome {
  const machine = input.store.listDomains().find(domain => domain.kind === 'machine')
  if (machine === undefined) return { staged: [], skipped: [], reason: 'domain-missing' }
  if (!machine.enabled) return { staged: [], skipped: [], reason: 'domain-disabled' }
  const pending = input.store.listGlobalCandidates({ state: 'pending', domainId: machine.domainId })
  if (pending.length >= (input.maxPending ?? DEFAULT_MAX_PENDING)) {
    return { staged: [], skipped: [], reason: 'queue-full' }
  }
  const limit = input.limit ?? DEFAULT_LIMIT

  interface ScanRow {
    readonly id: number
  }
  let scan: ScanRow[]
  try {
    const db = new DatabaseSync(input.contractDbPath, { readOnly: true })
    try {
      const categories = JSON.stringify(machine.shareCategories)
      scan = db
        .prepare(
          `SELECT id FROM memories
           WHERE status = 'active' AND scope = 'project' AND seen_count >= 2
             AND category IN (SELECT value FROM json_each(?))
             AND project_path NOT LIKE 'dir:global:%' AND project_path NOT LIKE 'git:global:%'
           ORDER BY updated_at DESC LIMIT 50`,
        )
        .all(categories) as unknown as ScanRow[]
    } finally {
      db.close()
    }
  } catch {
    // A readable contract store is a precondition; the bridge and writer both
    // already report their own view of the same file — stay silent here.
    return { staged: [], skipped: [], reason: 'domain-missing' }
  }

  const staged: Array<{ candidateId: number; memoryId: number }> = []
  const skipped: Array<{ memoryId: number; reason: string }> = []
  const seenRefusals = new Set<string>()
  // Exact "created this pass" detection: everything the pool already holds
  // (pending or otherwise) is known before the loop; the upsert is idempotent
  // per (domain, hash), so a re-scan returns the SAME row and must not count.
  const known = new Set(input.store.listGlobalCandidates({ domainId: machine.domainId }).map(c => c.id))
  for (const row of scan) {
    if (staged.length >= limit) break
    const result = promoteMemoryToCandidate(input.store, {
      contractDbPath: input.contractDbPath,
      memoryId: row.id,
      domainId: machine.domainId,
      now: input.now,
    })
    if (result.ok) {
      if (!known.has(result.candidate.id)) {
        known.add(result.candidate.id)
        staged.push({ candidateId: result.candidate.id, memoryId: row.id })
      }
      continue
    }
    // Refusals repeat verbatim every pass (inactive memory, credentials, …);
    // surface each distinct reason once per memory, but never spam per tick.
    const key = `${String(row.id)}:${result.error}`
    if (!seenRefusals.has(key)) skipped.push({ memoryId: row.id, reason: result.error })
    seenRefusals.add(key)
  }
  return { staged, skipped }
}
