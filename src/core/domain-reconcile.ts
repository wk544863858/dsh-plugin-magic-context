/**
 * Domain-row reconciliation — "publishing is a copy, not a mirror".
 *
 * A human approval publishes a candidate into the shared contract store under a
 * domain identity (`dir:global:org` / `dir:global:machine`), and that is where
 * the lane stops: the published row is a COPY. When the source memory is later
 * rewritten or archived, nothing propagates, and nothing notices. Measured on
 * the live store (2026-10-16): 27 candidates, 21 linked to a domain row, 3 of
 * those stale.
 *
 * This module is the missing audit plus the repair PLAN — never the repair's
 * dangerous half:
 *
 *   - `source-rewritten` → stage a NEW pending candidate for that domain, so a
 *     human can approve republishing the source's current text. Nothing is
 *     published here, and the stale row is deliberately left standing.
 *   - `source-archived` / `source-missing` → archive the domain row
 *     (`status='archived'`, never a DELETE). A withdrawal is as much a human
 *     decision as a publish, so it only ever happens behind an explicit
 *     `--write`.
 *
 * The red line this file exists to keep: **the reconciler must never publish.**
 * It therefore has no seam for it at all — {@link DomainRepairPort} carries
 * exactly two writes (archive one row, stage one candidate) and `applyRepair`
 * can do nothing else with them. `tests/domain-reconcile.spec.ts` proves the line
 * by handing `applyRepair` a publish function that throws.
 *
 * Everything here is pure: plain arrays in, plain data out, no database, no
 * filesystem, no printing. `scripts/domain-reconcile.mjs` owns the SQL, the
 * backup gate and the Chinese report; the module is what can be tested.
 */

/** Why a published domain row no longer agrees with the memory it came from. */
export type DomainDivergenceKind = 'source-missing' | 'source-archived' | 'source-rewritten'

/**
 * The contract's "still there" vocabulary. `permanent` is a live status (the
 * promotion path can set it), so a predicate named `status !== 'active'` would
 * read every permanent source as dead and propose withdrawing healthy rows.
 * The corpus holds only `active`/`archived` today; the second value is here so
 * the audit cannot misfire the day one appears.
 */
const ALIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'permanent'])

function isAlive(status: string): boolean {
  return ALIVE_STATUSES.has(status)
}

/** One row of the adapter's `global_candidates`, as the audit needs it. */
export interface ReconcileCandidate {
  readonly id: number
  /** The domain identity the candidate belongs to (`dir:global:org`). */
  readonly domainId: string
  readonly normalizedHash: string
  /** `pending` / `approved` / `rejected` / `expired`. */
  readonly state: string
  readonly category: string
  /**
   * `source_memory_id`. Absent/null for a machine-detected candidate: there is
   * no source to drift from, so such a candidate can never diverge.
   */
  readonly sourceMemoryId?: number | null
}

/** One corpus `memories` row that lives under a domain identity. */
export interface ReconcileDomainRow {
  readonly id: number
  /** The corpus `project_path` — i.e. the domain identity. */
  readonly domainId: string
  readonly normalizedHash: string
  readonly status: string
  readonly category: string
}

/** One corpus memory the candidates were promoted from. */
export interface ReconcileSourceMemory {
  readonly id: number
  readonly status: string
  readonly normalizedHash: string
  readonly category: string
  readonly content: string
  /** The project the source lives in — provenance for a staged proposal. */
  readonly projectPath: string
}

/** The audit's whole input: three arrays, nothing else. */
export interface DomainReconcileInput {
  readonly candidates: readonly ReconcileCandidate[]
  readonly domainRows: readonly ReconcileDomainRow[]
  /**
   * The source rows referenced by `candidates[].sourceMemoryId`. A source that
   * is referenced but absent from this array is `source-missing` — the audit
   * must be able to tell "not loaded" from "not there", so the CLI loads every
   * referenced id and the audit never reaches for one it was not given.
   */
  readonly sourceMemories: readonly ReconcileSourceMemory[]
}

/** One domain row that disagrees with its source. */
export interface DomainDivergence {
  readonly kind: DomainDivergenceKind
  readonly candidateId: number
  readonly domainId: string
  readonly domainRowId: number
  readonly sourceMemoryId: number
  /** The hash the domain row was published from (the candidate's own hash). */
  readonly publishedNormalizedHash: string
  /** What the source says NOW — null only for `source-missing`. */
  readonly sourceNormalizedHash: string | null
  readonly sourceCategory: string | null
  readonly sourceIdentity: string | null
  /**
   * The source's current text. Carried so {@link planRepair} can be a pure
   * function of the report; callers must NOT print it (the operator scripts in
   * this repository never echo memory bodies).
   */
  readonly sourceContent: string | null
}

export interface DomainReconcileReport {
  /** Every candidate the audit was given. */
  readonly checked: number
  /**
   * Linked, and no divergence raised. This deliberately includes the links
   * whose domain row is already archived (semantics 3: a row that is already
   * withdrawn cannot disagree) — `skippedArchivedDomainRows` says how many, so
   * the number is never silently padded.
   */
  readonly healthy: number
  /** No domain row under `(domain_id, normalized_hash)`: never published. */
  readonly unlinked: number
  readonly unlinkedCandidateIds: readonly number[]
  readonly skippedArchivedDomainRows: readonly {
    readonly candidateId: number
    readonly domainRowId: number
  }[]
  /**
   * A source-rewritten link whose CURRENT text is already handled elsewhere in
   * the same domain: published (an alive row under the source's hash) or queued
   * (a pending candidate under it). These are NOT divergences — nothing is
   * missing and no repair is possible — but they are reported separately, so
   * "covered" can never be mistaken for "the stale copy agreed".
   *
   * Without this, a repaired domain could never reach a steady state: the stale
   * (candidate, row) pair keeps its old hash forever, so every run would
   * re-propose a candidate the human already approved.
   */
  readonly covered: readonly {
    readonly candidateId: number
    readonly domainRowId: number
    readonly sourceMemoryId: number
    readonly via: 'published' | 'staged'
    /** The row id (published) or candidate id (staged) doing the covering. */
    readonly coveredBy: number
  }[]
  readonly divergences: readonly DomainDivergence[]
}

export interface StageCandidatePlan {
  readonly domainId: string
  /** The source's CURRENT text — what a human would be approving. */
  readonly content: string
  readonly normalizedHash: string
  readonly category: string
  readonly sourceMemoryId: number
  /** `first_identity` for the staged candidate: where the knowledge lives. */
  readonly sourceIdentity: string
  /** `suggested_domain` for the staged candidate ('org' / 'machine' / null). */
  readonly suggestedDomain: 'org' | 'machine' | null
  /** English, one line: the review card renders it as the "why" of the card. */
  readonly reason: string
  /**
   * Every stale (candidate, row) pair this one proposal speaks for. Normally
   * one; two divergences collapse only when two sources in the same domain
   * normalized to identical text, and the contract's unique key can hold just
   * one candidate for that pair anyway.
   */
  readonly derivedFrom: readonly {
    readonly candidateId: number
    readonly domainRowId: number
    readonly sourceMemoryId: number
  }[]
}

export interface RepairPlan {
  /** Domain rows to withdraw. Every id appears once, ascending. */
  readonly archiveRowIds: readonly number[]
  /** Candidates to stage as `pending`. Never published by this module. */
  readonly stageCandidates: readonly StageCandidatePlan[]
  /**
   * Divergences with no safe repair available (a rewrite whose source text the
   * audit could not carry). Reported rather than dropped: a silently shortened
   * plan is how a repair run looks complete while leaving work undone.
   */
  readonly unrepairable: readonly {
    readonly candidateId: number
    readonly domainId: string
    readonly kind: DomainDivergenceKind
    readonly reason: string
  }[]
}

const KEY_SEP = '\u0000'

/** `(domain_id, normalized_hash)` as one map key. NUL cannot occur in either. */
function linkKey(domainId: string, normalizedHash: string): string {
  return `${domainId}${KEY_SEP}${normalizedHash}`
}

/**
 * The one row a candidate is linked to.
 *
 * The contract allows the same hash twice under one domain when the categories
 * differ (`UNIQUE(project_path, category, normalized_hash)`), so "the" row needs
 * a rule: the one whose category matches the candidate's, else the lowest id.
 * Deterministic on purpose — the audit must not depend on read order.
 */
function pickDomainRow(rows: readonly ReconcileDomainRow[] | undefined, category: string): ReconcileDomainRow | undefined {
  if (rows === undefined || rows.length === 0) return undefined
  const exact = rows.filter(row => row.category === category)
  const pool = exact.length > 0 ? exact : rows
  return pool.reduce((lowest, row) => (row.id < lowest.id ? row : lowest), pool[0] as ReconcileDomainRow)
}

type Verdict =
  | { readonly outcome: 'unlinked' }
  | { readonly outcome: 'healthy' }
  | { readonly outcome: 'skipped-archived-row'; readonly domainRowId: number }
  | { readonly outcome: 'covered'; readonly covered: DomainReconcileReport['covered'][number] }
  | { readonly outcome: 'divergence'; readonly divergence: DomainDivergence }

/**
 * Is the source's CURRENT text already handled under this domain?
 *
 * Two honest forms of coverage: an ALIVE domain row holding that text, or a
 * PENDING candidate proposing it (the design's own repair — a rewrite stages a
 * proposal rather than republishing). A merely `approved` candidate proves
 * nothing: approval is a state flag, and the point of this audit is that the
 * copy it produced may since have been withdrawn (live case #1420, archived).
 */
function findCoverage(
  domainId: string,
  sourceNormalizedHash: string,
  rowsByKey: ReadonlyMap<string, readonly ReconcileDomainRow[]>,
  candidatesByKey: ReadonlyMap<string, readonly ReconcileCandidate[]>,
): { readonly via: 'published' | 'staged'; readonly coveredBy: number } | undefined {
  const key = linkKey(domainId, sourceNormalizedHash)
  for (const row of rowsByKey.get(key) ?? []) {
    if (isAlive(row.status)) return { via: 'published', coveredBy: row.id }
  }
  for (const candidate of candidatesByKey.get(key) ?? []) {
    if (candidate.state === 'pending') return { via: 'staged', coveredBy: candidate.id }
  }
  return undefined
}

function makeDivergence(
  kind: DomainDivergenceKind,
  candidate: ReconcileCandidate,
  row: ReconcileDomainRow,
  sourceMemoryId: number,
  source: ReconcileSourceMemory | undefined,
): DomainDivergence {
  return {
    kind,
    candidateId: candidate.id,
    domainId: candidate.domainId,
    domainRowId: row.id,
    sourceMemoryId,
    publishedNormalizedHash: candidate.normalizedHash,
    sourceNormalizedHash: source?.normalizedHash ?? null,
    sourceCategory: source?.category ?? null,
    sourceIdentity: source?.projectPath ?? null,
    sourceContent: source?.content ?? null,
  }
}

/**
 * Classify one candidate. Exhaustive by construction: `checked` always equals
 * `healthy + unlinked + divergences.length` (the spec asserts it).
 */
function classifyCandidate(
  candidate: ReconcileCandidate,
  rowsByKey: ReadonlyMap<string, readonly ReconcileDomainRow[]>,
  sourcesById: ReadonlyMap<number, ReconcileSourceMemory>,
  candidatesByKey: ReadonlyMap<string, readonly ReconcileCandidate[]>,
): Verdict {
  const row = pickDomainRow(rowsByKey.get(linkKey(candidate.domainId, candidate.normalizedHash)), candidate.category)
  if (row === undefined) return { outcome: 'unlinked' }
  // A domain row that is already withdrawn cannot disagree with anything: the
  // reviewer is looking at a fact nobody can see any more (semantics 3). It
  // still counts as a healthy LINK — the number is reported separately so it is
  // never silently padded.
  if (!isAlive(row.status)) {
    return { outcome: 'skipped-archived-row', domainRowId: row.id }
  }
  // Only an approved candidate is the authority for a published row; a rejected
  // or still-pending one has never published anything, so it cannot be stale.
  if (candidate.state !== 'approved') return { outcome: 'healthy' }
  const sourceMemoryId = candidate.sourceMemoryId
  // Machine-detected candidate: the link itself is the whole comparison, and
  // there is no source that could have moved on.
  if (sourceMemoryId === null || sourceMemoryId === undefined) return { outcome: 'healthy' }
  const source = sourcesById.get(sourceMemoryId)
  if (source === undefined) {
    return { outcome: 'divergence', divergence: makeDivergence('source-missing', candidate, row, sourceMemoryId, undefined) }
  }
  if (!isAlive(source.status)) {
    return { outcome: 'divergence', divergence: makeDivergence('source-archived', candidate, row, sourceMemoryId, source) }
  }
  if (source.normalizedHash !== candidate.normalizedHash) {
    // The source moved on. Before calling that a divergence, ask whether its
    // CURRENT text is already handled under this domain — otherwise a repaired
    // domain could never settle (the stale pair keeps its old hash forever).
    const coverage = findCoverage(candidate.domainId, source.normalizedHash, rowsByKey, candidatesByKey)
    if (coverage !== undefined) {
      return {
        outcome: 'covered',
        covered: {
          candidateId: candidate.id,
          domainRowId: row.id,
          sourceMemoryId,
          via: coverage.via,
          coveredBy: coverage.coveredBy,
        },
      }
    }
    return { outcome: 'divergence', divergence: makeDivergence('source-rewritten', candidate, row, sourceMemoryId, source) }
  }
  return { outcome: 'healthy' }
}

/**
 * The read-only half: what disagrees with what.
 *
 * `checked` counts every candidate given, which is the whole queue — rejected
 * and pending candidates land in `unlinked` because they were never published.
 * That is not a fault (the live store's 6 unlinked candidates are exactly 5
 * rejected + 1 pending), so every caller must print `unlinked` as a note, never
 * as an alarm.
 */
export function auditDomainDivergences(input: DomainReconcileInput): DomainReconcileReport {
  const rowsByKey = new Map<string, ReconcileDomainRow[]>()
  for (const row of input.domainRows) {
    const key = linkKey(row.domainId, row.normalizedHash)
    const bucket = rowsByKey.get(key)
    if (bucket === undefined) rowsByKey.set(key, [row])
    else bucket.push(row)
  }
  const sourcesById = new Map<number, ReconcileSourceMemory>()
  for (const memory of input.sourceMemories) sourcesById.set(memory.id, memory)
  // Every candidate, by key: coverage can come from a DIFFERENT candidate than
  // the one being classified (the proposal staged for this very rewrite).
  const candidatesByKey = new Map<string, ReconcileCandidate[]>()
  for (const candidate of input.candidates) {
    const key = linkKey(candidate.domainId, candidate.normalizedHash)
    const bucket = candidatesByKey.get(key)
    if (bucket === undefined) candidatesByKey.set(key, [candidate])
    else bucket.push(candidate)
  }

  let checked = 0
  let healthy = 0
  let unlinked = 0
  const unlinkedCandidateIds: number[] = []
  const skippedArchivedDomainRows: Array<{ candidateId: number; domainRowId: number }> = []
  const covered: Array<DomainReconcileReport['covered'][number]> = []
  const divergences: DomainDivergence[] = []

  for (const candidate of input.candidates) {
    checked += 1
    const verdict = classifyCandidate(candidate, rowsByKey, sourcesById, candidatesByKey)
    if (verdict.outcome === 'unlinked') {
      unlinked += 1
      unlinkedCandidateIds.push(candidate.id)
    } else if (verdict.outcome === 'healthy') {
      healthy += 1
    } else if (verdict.outcome === 'skipped-archived-row') {
      healthy += 1
      skippedArchivedDomainRows.push({ candidateId: candidate.id, domainRowId: verdict.domainRowId })
    } else if (verdict.outcome === 'covered') {
      // Nothing to repair, so nothing keeps it out of `healthy`; listed anyway.
      healthy += 1
      covered.push(verdict.covered)
    } else {
      divergences.push(verdict.divergence)
    }
  }

  return {
    checked,
    healthy,
    unlinked,
    unlinkedCandidateIds,
    skippedArchivedDomainRows,
    covered: covered.slice().sort((left, right) => left.candidateId - right.candidateId),
    divergences: divergences.slice().sort((left, right) => left.candidateId - right.candidateId),
  }
}

/** `dir:global:machine` → 'machine'. Anything else → null (never guessed). */
function suggestedDomainFor(domainId: string): 'org' | 'machine' | null {
  if (domainId.endsWith(':machine')) return 'machine'
  if (domainId.endsWith(':org')) return 'org'
  return null
}

/** The one-line "why" the review card shows for a staged proposal. */
export function reconcileReason(divergence: {
  readonly domainId: string
  readonly domainRowId: number
  readonly sourceMemoryId: number
  readonly publishedNormalizedHash: string
}): string {
  return `domain-reconcile: the published copy under ${divergence.domainId} is stale — source memory `
    + `#${String(divergence.sourceMemoryId)} was rewritten after domain row #${String(divergence.domainRowId)} `
    + `was published from hash ${divergence.publishedNormalizedHash}; approving republishes the current text `
    + '(the stale row is left in place for a human to withdraw).'
}

/**
 * Turn a report into the exact writes a repair would perform. Pure, and still
 * not applied: the CLI decides, and only `--write` gets there.
 *
 * Two rules are load-bearing:
 *
 *   1. **A rewrite never archives.** The stale row is a fact somebody approved;
 *      the proposal adds a new one and leaves the old decision visible.
 *   2. **One proposal per unique key.** The adapter's unique index is
 *      `(domain_id, normalized_hash)`, so a second idempotent write of the same
 *      proposal would upsert the first one's row — and that upsert rewrites
 *      `content` even for an APPROVED candidate. Collapsing here (and again at
 *      the write seam) is what makes a repeated `--write` a no-op.
 */
export function planRepair(report: DomainReconcileReport): RepairPlan {
  const archiveRowIds: number[] = []
  const archiveSeen = new Set<number>()
  const stageCandidates: StageCandidatePlan[] = []
  const stageIndex = new Map<string, number>()
  const unrepairable: Array<{ candidateId: number; domainId: string; kind: DomainDivergenceKind; reason: string }> = []

  const archive = (rowId: number): void => {
    if (archiveSeen.has(rowId)) return
    archiveSeen.add(rowId)
    archiveRowIds.push(rowId)
  }

  for (const divergence of report.divergences) {
    if (divergence.kind !== 'source-rewritten') {
      archive(divergence.domainRowId)
      continue
    }
    const { sourceContent, sourceNormalizedHash, sourceCategory, sourceIdentity } = divergence
    if (sourceContent === null || sourceNormalizedHash === null || sourceCategory === null || sourceIdentity === null) {
      unrepairable.push({
        candidateId: divergence.candidateId,
        domainId: divergence.domainId,
        kind: divergence.kind,
        reason: 'the audit classified this as a rewrite but carried no source text — refusing to guess a proposal',
      })
      continue
    }
    const key = linkKey(divergence.domainId, sourceNormalizedHash)
    const existing = stageIndex.get(key)
    const derived = { candidateId: divergence.candidateId, domainRowId: divergence.domainRowId, sourceMemoryId: divergence.sourceMemoryId }
    if (existing !== undefined) {
      const kept = stageCandidates[existing] as StageCandidatePlan
      stageCandidates[existing] = { ...kept, derivedFrom: [...kept.derivedFrom, derived] }
      continue
    }
    stageIndex.set(key, stageCandidates.length)
    stageCandidates.push({
      domainId: divergence.domainId,
      content: sourceContent,
      normalizedHash: sourceNormalizedHash,
      category: sourceCategory,
      sourceMemoryId: divergence.sourceMemoryId,
      sourceIdentity,
      suggestedDomain: suggestedDomainFor(divergence.domainId),
      reason: reconcileReason(divergence),
      derivedFrom: [derived],
    })
  }

  archiveRowIds.sort((left, right) => left - right)
  return { archiveRowIds, stageCandidates, unrepairable }
}

export type ArchiveOutcome =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }

export type StageOutcome =
  | {
    readonly ok: true
    readonly candidateId: number
    readonly created: boolean
    /**
     * The key was held by a DEAD approval (its published copy is no longer
     * alive) and the port re-proposed it in place instead of inserting. The
     * module only carries the flag into the report; the decision is the port's.
     */
    readonly reproposed?: boolean
  }
  | { readonly ok: false; readonly error: string }

/**
 * The write port a repair needs — and the complete list of what a repair may do.
 *
 * There is deliberately no publish method: publishing is a human gate, and a
 * type that cannot express it cannot be talked into it. Satisfied structurally
 * by the CLI's SQL, in the same spirit as `global-domains.ts`'s
 * `DomainWritePort`.
 */
export interface DomainRepairPort {
  /**
   * Withdraw one domain row: `status='archived'`. `changed: false` means the row
   * was already archived (an idempotent re-run), not that nothing was asked.
   */
  archiveDomainRow(rowId: number): ArchiveOutcome
  /**
   * Land a pending candidate for human review. MUST NOT publish.
   *
   * An existing row under `(domain_id, normalized_hash)` is never overwritten
   * blindly — the adapter's upsert rewrites `content` even for an APPROVED
   * candidate. A live approval and a human rejection are left exactly as they
   * are; an already-pending proposal is returned as `created: false`. The one
   * exception is a DEAD approval (its published copy archived): its key blocks
   * the only honest proposal for that text, so the port may re-propose it in
   * place and flag `reproposed`.
   */
  stageCandidate(input: StageCandidatePlan): StageOutcome
}

export interface RepairJournalEntry {
  readonly at: number
  readonly action: 'archive' | 'stage' | 'refuse'
  readonly summary: string
  readonly data: Record<string, unknown>
}

/** Where {@link applyRepair} narrates what it did. Never a message body. */
export type RepairJournalSink = (entry: RepairJournalEntry) => void

export interface RepairOutcome {
  /** Domain rows actually flipped to `archived`, in plan order. */
  readonly archived: readonly number[]
  /** Rows the port refused (or that were already archived). */
  readonly archiveRefusals: readonly { readonly rowId: number; readonly error: string }[]
  readonly staged: readonly {
    readonly domainId: string
    readonly normalizedHash: string
    readonly sourceMemoryId: number
    readonly candidateId: number
    readonly created: boolean
    /** True when a dead approval's key was re-proposed in place. */
    readonly reproposed: boolean
  }[]
  readonly stageRefusals: readonly {
    readonly domainId: string
    readonly normalizedHash: string
    readonly sourceMemoryId: number
    readonly error: string
  }[]
  /** Echoed from the plan so one printed outcome carries the whole story. */
  readonly unrepairable: RepairPlan['unrepairable']
}

/**
 * Apply a plan through the injected port. This is the only function that writes,
 * and the only two things it can write are the two the port exposes.
 *
 * Withdrawals run first, then proposals: a refusal while staging must not leave
 * a half-applied plan looking complete, and the two sets are disjoint by
 * construction (one divergence is either a rewrite or a dead source, never
 * both). Every action is reported individually — a partial run prints as a
 * partial run.
 */
export function applyRepair(
  plan: RepairPlan,
  port: DomainRepairPort,
  options: { readonly now?: number; readonly journal?: RepairJournalSink } = {},
): RepairOutcome {
  const at = options.now ?? Date.now()
  const journal = options.journal
  const archived: number[] = []
  const archiveRefusals: Array<{ rowId: number; error: string }> = []
  const staged: Array<{ domainId: string; normalizedHash: string; sourceMemoryId: number; candidateId: number; created: boolean; reproposed: boolean }> = []
  const stageRefusals: Array<{ domainId: string; normalizedHash: string; sourceMemoryId: number; error: string }> = []

  for (const rowId of plan.archiveRowIds) {
    const result = port.archiveDomainRow(rowId)
    if (result.ok) {
      if (result.changed) archived.push(rowId)
      else archiveRefusals.push({ rowId, error: 'already archived (idempotent re-run)' })
      journal?.({
        at,
        action: result.changed ? 'archive' : 'refuse',
        summary: result.changed
          ? `archived domain row #${String(rowId)} (its source memory is gone)`
          : `domain row #${String(rowId)} was already archived`,
        data: { rowId, changed: result.changed },
      })
    } else {
      archiveRefusals.push({ rowId, error: result.error })
      journal?.({ at, action: 'refuse', summary: `archive refused for domain row #${String(rowId)}`, data: { rowId, error: result.error } })
    }
  }

  for (const proposal of plan.stageCandidates) {
    const result = port.stageCandidate(proposal)
    if (result.ok) {
      const reproposed = result.reproposed === true
      staged.push({
        domainId: proposal.domainId,
        normalizedHash: proposal.normalizedHash,
        sourceMemoryId: proposal.sourceMemoryId,
        candidateId: result.candidateId,
        created: result.created,
        reproposed,
      })
      journal?.({
        at,
        action: 'stage',
        summary: result.created
          ? `staged candidate #${String(result.candidateId)} for ${proposal.domainId} (awaiting human approval)`
          : reproposed
            ? `re-proposed dead candidate #${String(result.candidateId)} for ${proposal.domainId} (its published copy is archived; awaiting human approval again)`
            : `candidate #${String(result.candidateId)} already staged for ${proposal.domainId}`,
        data: {
          candidateId: result.candidateId,
          domainId: proposal.domainId,
          normalizedHash: proposal.normalizedHash,
          sourceMemoryId: proposal.sourceMemoryId,
          derivedFrom: proposal.derivedFrom,
          created: result.created,
          reproposed,
        },
      })
    } else {
      stageRefusals.push({
        domainId: proposal.domainId,
        normalizedHash: proposal.normalizedHash,
        sourceMemoryId: proposal.sourceMemoryId,
        error: result.error,
      })
      journal?.({
        at,
        action: 'refuse',
        summary: `staging refused for ${proposal.domainId}`,
        data: { domainId: proposal.domainId, normalizedHash: proposal.normalizedHash, error: result.error },
      })
    }
  }

  return { archived, archiveRefusals, staged, stageRefusals, unrepairable: plan.unrepairable }
}
