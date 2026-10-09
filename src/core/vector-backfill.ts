/**
 * WP11 — filling the vector lane.
 *
 * Magic Context used to own `memory_embeddings` and refill it. That job left
 * with it, and the consequence is measurable: on 2026-10-10 the live store had
 * 1224 active memories, 820 embedded (67%), and the newest embedded id 210 rows
 * behind the newest id — a lane degrading silently, since a missing vector only
 * ever costs recall quality, never an error.
 *
 * This module writes the missing rows. Every rule below exists because the
 * failure mode here is SILENT:
 *
 *  - **Parity is a precondition, not a per-row check.** A vector written into a
 *    space this adapter cannot reproduce looks exactly like a good vector
 *    afterwards, and it degrades every read that touches it. So the shared-space
 *    gate runs first, and a closed gate aborts the WHOLE batch — never "skip the
 *    bad ones and write the rest".
 *  - **The planned space must be the proven space.** The plan re-reads the
 *    dominant id from the store; if that disagrees with the space parity was
 *    proven against, the batch is refused rather than written into whichever
 *    space happens to be dominant now.
 *  - **An empty plan does not call the embedder.** Not merely an optimisation:
 *    it is the negative control that proves "no candidates" means "no writes"
 *    rather than "the loop happened to have nothing to do".
 *  - **A zero or short vector is never stored.** Both would break cosine
 *    similarity for every query against that row, silently.
 *  - **One row never aborts the batch.** A row that fails to embed or store is
 *    counted and skipped; the rest still land, and the next tick retries the gap.
 */

import type { Journal } from './journal.ts'
import { errText } from './types.ts'

export interface BackfillPlanLike {
  readonly modelId: string
  readonly candidates: readonly number[]
  readonly total: number
}

export interface VectorBackfillDeps {
  /** Read-only plan from `vector-lane.planBackfill`. */
  readonly plan: () => BackfillPlanLike | undefined
  readonly contents: (ids: readonly number[]) => ReadonlyArray<{ readonly id: number; readonly content: string }>
  readonly embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>
  /** The embedder's dimension, checked per row before storing. */
  readonly dims: number
  readonly store: (input: {
    readonly memoryId: number
    readonly modelId: string
    readonly vector: Float32Array
  }) => { readonly ok: boolean; readonly created?: boolean }
  readonly journal: Journal
  /** Rows per tick. Bounds how much of the contract one pass touches. */
  readonly limit: number
  /**
   * The space the shared-space gate PROVED parity against, or `null` when the
   * gate closed. Writing requires this to equal the plan's model id.
   */
  readonly parityModelId: string | null
}

export type VectorBackfillReason =
  | 'parity-unproven'
  | 'parity-mismatch'
  | 'no-plan'
  | 'no-candidates'
  | 'nothing-producible'
  | 'embed-failed'

export interface VectorBackfillOutcome {
  /** Rows that did not exist in the space before this pass. */
  readonly created: number
  /** Rows already present (another writer beat us — harmless, not a failure). */
  readonly present: number
  /** Candidates whose vector was unusable (empty, wrong width, all zero). */
  readonly skipped: number
  readonly failed: number
  /** How many candidates the plan knew about, not just this batch. */
  readonly total: number
  readonly reason?: VectorBackfillReason
}

/**
 * A vector of all zeros is not "no information": cosine similarity against it is
 * undefined (0/0), which some readers turn into NaN and others into a perfect
 * match. Either way it is worse than a missing row, so it is never stored.
 */
export function isUsableVector(vector: Float32Array | undefined, dims: number): vector is Float32Array {
  if (vector === undefined || vector.length !== dims) return false
  // The whole vector must be scanned: an early `return true` on the first
  // non-zero entry would never reach a NaN or an Infinity further along, which
  // is precisely the value that ruins every cosine comparison.
  let anyNonZero = false
  for (const value of vector) {
    if (!Number.isFinite(value)) return false
    if (value !== 0) anyNonZero = true
  }
  return anyNonZero
}

export async function runVectorBackfill(deps: VectorBackfillDeps): Promise<VectorBackfillOutcome> {
  const empty = { created: 0, present: 0, skipped: 0, failed: 0, total: 0 } as const

  // (1) Parity first, for the whole batch.
  if (deps.parityModelId === null) {
    deps.journal.info('vector-lane', 'backfill skipped: shared-space parity is unproven', {
      outcome: 'backfill-parity-unproven',
      ...empty,
    })
    return { ...empty, reason: 'parity-unproven' }
  }

  const plan = deps.plan()
  if (plan === undefined) return { ...empty, reason: 'no-plan' }
  if (plan.candidates.length === 0) {
    return { ...empty, total: plan.total, reason: 'no-candidates' }
  }
  // (2) The plan's space is re-read from the store; it must be the one we proved.
  if (plan.modelId !== deps.parityModelId) {
    deps.journal.warn('vector-lane', 'backfill skipped: planned space is not the parity-proven space', {
      outcome: 'backfill-parity-mismatch',
      planned: plan.modelId,
      proven: deps.parityModelId,
    })
    return { ...empty, total: plan.total, reason: 'parity-mismatch' }
  }

  const batch = plan.candidates.slice(0, Math.max(1, deps.limit))
  const rows = deps.contents(batch).filter(row => row.content.trim().length > 0)
  if (rows.length === 0) return { ...empty, total: plan.total, reason: 'nothing-producible' }

  let vectors: readonly Float32Array[]
  try {
    vectors = await deps.embed(rows.map(row => row.content))
  } catch (error) {
    deps.journal.warn('vector-lane', `backfill embed failed: ${errText(error)}`, {
      outcome: 'backfill-embed-failed',
      attempted: rows.length,
    })
    return { ...empty, total: plan.total, reason: 'embed-failed' }
  }

  let created = 0
  let present = 0
  let skipped = 0
  let failed = 0
  for (const [index, row] of rows.entries()) {
    const vector = vectors[index]
    if (!isUsableVector(vector, deps.dims)) {
      skipped += 1
      continue
    }
    const stored = deps.store({ memoryId: row.id, modelId: plan.modelId, vector })
    if (!stored.ok) {
      failed += 1
      continue
    }
    if (stored.created === true) created += 1
    else present += 1
  }

  const outcome: VectorBackfillOutcome = {
    created,
    present,
    skipped,
    failed,
    total: plan.total,
  }
  deps.journal.info(
    'vector-lane',
    `backfill: +${String(created)} vector(s) in the dominant space`
      + `${plan.total > batch.length ? ` (${String(plan.total - batch.length)} still missing)` : ''}`,
    {
      outcome: 'backfill',
      ...outcome,
      modelId: plan.modelId,
      batch: batch.length,
      ...outcome.skipped > 0 ? { skipped: outcome.skipped } : {},
      ...outcome.failed > 0 ? { failed: outcome.failed } : {},
    },
  )
  return outcome
}
