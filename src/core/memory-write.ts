/**
 * The memory WRITE path — the other half of Magic Context's memory feature.
 *
 * This module writes into Magic Context's shared `context.db`, so every
 * statement and default here is a replication of MC's storage contract, not an
 * invention. The contract (verified against `packages/plugin/src/features/
 * magic-context/memory/promotion.ts`, `storage-memory.ts` and the live v94
 * schema) is:
 *
 *  - identity: `git:<root-commit-sha>` / `dir:<md5(path.resolve(dir))[:12]>`;
 *  - hash: `md5(content.toLowerCase().replace(/\s+/g,' ').trim())`, the
 *    dedup key is `UNIQUE(project_path, category, normalized_hash)`;
 *  - a duplicate fact only bumps `seen_count` + `last_seen_at`/`updated_at`
 *    (never resurrects an archived row, because the UNIQUE covers all statuses);
 *  - a new row is `importance = 50`, `scope = 'project'`, `shareable = 0`,
 *    `source_type = 'historian'`, `status = 'active'`, `verification_status =
 *    'unverified'`, `seen_count = 1`, `retrieval_count = 0`, all four
 *    timestamps equal to `now`, and `expires_at` only for the TTL categories;
 *  - promotion is a PURE APPEND: it writes neither `memory_mutation_log` nor
 *    `project_memory_epoch`. New rows become visible through the
 *    `maxMemoryId` watermark in m[1], never by rebuilding m[0].
 *
 * Deliberate divergence, recorded for the review: MC promotes inside the
 * compartment publish transaction, so a failed promotion rolls the publish
 * back. Our compartments are already durable when promotion runs, so we
 * fail-open, journal the error, and let a later pass retry from the stored
 * facts — reclaim must not stall on a memory bug, and no fact is lost.
 *
 * The agent write path below (`writeMemory` / `updateMemory` / `archiveMemory`
 * / `mergeMemory` / `getMemory` / `listMemories`) replicates §11 of the same
 * contract and adds the non-additive machinery promotion deliberately omits:
 * `memory_mutation_log` deltas for `update`/`archive`/`superseded` and the
 * §4.5 clear-on-content-change invariants. It never bumps
 * `project_memory_epoch` (contract §5.2: in-session mutations route through
 * m[1]) and never touches FTS or the embedding tables beyond invalidation.
 * (The §8.4 module-authority guard was retired with the 2026-10-13 corpus
 * cutover — no authority tables exist in the own corpus.)
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { MEMORY_SCHEMA_MAX_VERSION, normalizeMemoryContent } from './memory-bridge.ts'
import { V2_MEMORY_CATEGORIES, isPromotableCategory, resolveExpiresAt } from './memory-categories.ts'
import { errText } from './types.ts'

/** MC's `normalize-hash.ts`: md5 of the whitespace/case-normalized content. */
export function normalizedMemoryHash(content: string): string {
  return createHash('md5').update(normalizeMemoryContent(content), 'utf8').digest('hex')
}

export interface MemoryFact {
  readonly category: string
  readonly content: string
}

export interface PromoteOutcome {
  readonly identity: string
  readonly inserted: ReadonlyArray<{ id: number; category: string; content: string }>
  readonly seenAgain: ReadonlyArray<{ id: number; category: string }>
  /** Facts MC would silently drop, with the reason (never an error). */
  readonly skipped: ReadonlyArray<{ category: string; content: string; reason: string }>
  /** Highest memory id for this project after the write (the new watermark). */
  readonly maxMemoryId: number
}

/**
 * One `memories` row through the contract's read projection (§11.1). Numeric
 * columns that legacy rows may hold as NULL keep the NULL (`seen_count`,
 * `retrieval_count`); the COALESCE defaults are applied only where MC's own
 * projection applies them (`importance`, `scope`, `shareable`).
 */
export interface MemoryRecord {
  readonly id: number
  readonly projectPath: string
  readonly category: string
  readonly content: string
  readonly normalizedHash: string
  readonly importance: number
  readonly scope: string
  readonly shareable: number
  readonly sourceSessionId: string | null
  readonly sourceType: string | null
  readonly seenCount: number | null
  readonly retrievalCount: number | null
  readonly firstSeenAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSeenAt: number
  readonly lastRetrievedAt: number | null
  readonly status: string
  readonly expiresAt: number | null
  readonly verificationStatus: string | null
  readonly verifiedAt: number | null
  readonly supersededByMemoryId: number | null
  readonly mergedFrom: string | null
  readonly metadataJson: string | null
}

export type MemoryWriteFailureReason =
  /** The writer never attached to the database (missing file, probe failure). */
  | 'unavailable'
  | 'invalid-argument'
  | 'invalid-category'
  | 'empty-content'
  /** `source_type = 'user'` is reserved for the dashboard (contract §1.3). */
  | 'source-type-reserved'
  | 'not-found'
  /** The row exists but belongs to another project identity (§8.1 OWNED). */
  | 'not-owned'
  | 'archived-or-superseded'
  /** The normalized hash already exists on another row (§2.3). */
  | 'duplicate'
  | 'category-mismatch'
  /**
   * `schema_migrations` reports a version above {@link MEMORY_SCHEMA_MAX_VERSION}:
   * Magic Context has moved on, so the adapter downgrades to read-only rather
   * than writing rows a newer storage layer may not accept.
   */
  | 'corpus-version-unsupported'
  /**
   * The contract lacks the table this write needs (a trimmed or older shape,
   * e.g. no `memory_embeddings`). Distinct from a version problem: the store is
   * readable and current, it simply has nothing to write into.
   */
  | 'unsupported'
  | 'database-error'

export interface MemoryWriteFailure {
  readonly ok: false
  readonly reason: MemoryWriteFailureReason
  readonly detail: string
}

export interface MemoryWriteSuccess {
  readonly ok: true
  readonly id: number
  /** `writeMemory` only: false when the hash already existed and only `seen_count` advanced. */
  readonly created?: boolean
  /** `writeMemory` only: the row's `seen_count` after the call. */
  readonly seenCount?: number
}

export type MemoryWriteResult = MemoryWriteSuccess | MemoryWriteFailure

export interface MemoryMergeSuccess {
  /** The canonical (target) memory id. */
  readonly ok: true
  readonly id: number
  /** Source ids archived with `superseded_by_memory_id = id`. */
  readonly superseded: readonly number[]
  /** The aggregated `merged_from` id set, ascending and deduplicated (§11.4). */
  readonly mergedFrom: readonly number[]
}

export type MemoryMergeResult = MemoryMergeSuccess | MemoryWriteFailure

/** `write` — the agent-authored memory (contract §11.1). */
export interface WriteMemoryInput {
  /** Resolved identity (`git:<sha>` / `dir:<hash>`), never a raw path (§1.4). */
  readonly identity: string
  /** Must be one of `V2_MEMORY_CATEGORIES` (§3.1). */
  readonly category: string
  readonly content: string
  /** Defaults to 50 (§1.2). */
  readonly importance?: number
  readonly sessionId?: string | null
  /** Defaults to `'agent'`; `'user'` is rejected (§1.3). */
  readonly sourceType?: string
  /** Absolute epoch ms; defaults to the category TTL mapped by `resolveExpiresAt`. */
  readonly expiresAt?: number | null
  readonly metadataJson?: string | null
}

/** `update` — content, category and (adapter extension) importance (§11.3). */
export interface UpdateMemoryInput {
  readonly identity: string
  readonly id: number
  readonly content: string
  /** Omitted = keep the row's category; an explicit value must be a v2 category. */
  readonly category?: string
  /** Omitted = keep the row's importance. Adapter extension over MC's update SQL. */
  readonly importance?: number
}

/** `archive` — with an optional reason and/or supersede link (§11.5). */
export interface ArchiveMemoryInput {
  readonly identity: string
  readonly id: number
  /** Stored as `metadata_json.archive_reason` (merged over any existing object). */
  readonly reason?: string
  /** When set the row is superseded by this id and the delta is `superseded`. */
  readonly supersededBy?: number
}

/** `merge` — one existing canonical target plus one or more absorbed sources (§11.4). */
export interface MergeMemoryInput {
  readonly identity: string
  readonly targetId: number
  readonly sourceIds: readonly number[]
  /** The merged canonical content (required by MC's merge action). */
  readonly content: string
  /** Omitted = the (single) category shared by every affected row. */
  readonly category?: string
}

export interface ListMemoriesOptions {
  /** Rows returned; omitted = every injectable row. */
  readonly limit?: number
  /** Frozen expiry cutoff (§4.4); defaults to the writer's `now()`. */
  readonly now?: number
  /**
   * Keep only rows whose verification is still pending. The maintenance sweep
   * needs this at SQL level: filtering a fixed 64-row render window after the
   * fact stalls forever once those rows are verified (they keep their place —
   * verification deliberately does not touch `updated_at`), leaving every row
   * outside the window unreachable.
   */
  readonly unverifiedOnly?: boolean
}

/** The v2 taxonomy is the only category set the agent write path accepts (§3.1). */
export function isWritableMemoryCategory(category: unknown): category is string {
  return typeof category === 'string' && (V2_MEMORY_CATEGORIES as readonly string[]).includes(category)
}

export interface MemoryWriterLogger {
  info(message: string): void
  warn(message: string): void
}

export interface MemoryWriterOptions {
  readonly dbPath: string
  readonly logger: MemoryWriterLogger
  /** SQLite busy timeout while another host (OpenCode's MC) holds the write lock. */
  readonly busyTimeoutMs?: number
  readonly now?: () => number
}

/** The writer's own health, surfaced by /ctx-status and the telemetry summary. */
export interface MemoryWriterStatus {
  readonly ok: boolean
  readonly detail?: string
  /** MC's `schema_migrations` version observed at open (undefined = table absent). */
  readonly corpusVersion?: number
  /**
   * True when `corpusVersion > MEMORY_SCHEMA_MAX_VERSION`: every write is
   * refused with `corpus-version-unsupported`, reads keep working.
   */
  readonly readOnly?: boolean
}

/** Explicit retrieval telemetry (contract §9.1). */
export interface MemoryRetrievalInput {
  readonly identity: string
  /** Rows the agent explicitly retrieved. */
  readonly ids: readonly number[]
}

/**
 * `retrieval_count` / `last_retrieved_at` telemetry. Telemetry is not
 * correctness (contract §9.1): a fenced/database failure is
 * reported, never thrown, and never fails the tool call that triggered it.
 */
export type MemoryRetrievalOutcome =
  | { readonly ok: true; readonly recorded: readonly number[]; readonly skipped: readonly number[] }
  | {
    readonly ok: false
    readonly recorded: readonly number[]
    readonly skipped: readonly number[]
    readonly reason: MemoryWriteFailureReason
  }

/** WP9/WP10 domain publish: the row id, and whether this call created it. */
export type DomainPublishResult =
  | { readonly ok: true; readonly id: number; readonly created: boolean }
  | MemoryWriteFailure

/** WP11 vector write: the memory id, and whether a row was actually added. */
export type EmbeddingStoreResult =
  | { readonly ok: true; readonly id: number; readonly created: boolean }
  | MemoryWriteFailure

export interface MemoryWriter {
  readonly dbPath: string
  readonly status: MemoryWriterStatus
  /** Promote historian facts for one project (idempotent, append-only). */
  promoteFacts(input: {
    readonly identity: string
    readonly facts: readonly MemoryFact[]
    readonly sessionId?: string
  }): PromoteOutcome
  /** Read-only counters used by the observability layer and the tests. */
  stats(identity: string): {
    readonly rows: number
    readonly mutationLog: number
    readonly epoch: number
    /** Verification coverage (the dreamer slice's KPI): verified_at banked vs pending. */
    readonly verified: number
    readonly unverified: number
  }
  /**
   * `write`: dedup on `(project_path, category, normalized_hash)` inside one
   * `BEGIN IMMEDIATE`; a hit bumps `seen_count` only. Additive — no mutation
   * log row, no epoch bump (contract §6.2, §11.1).
   */
  writeMemory(input: WriteMemoryInput): MemoryWriteResult
  /** `update`: content/category/importance + the §4.5 clears, plus an `update` delta. */
  updateMemory(input: UpdateMemoryInput): MemoryWriteResult
  /**
   * WP9/WP10: insert (or re-encounter) one DOMAIN memory under a synthetic
   * identity, with `scope`/`shareable` written explicitly so peer projects can
   * actually read it. Idempotent on the contract's
   * `UNIQUE(project_path, category, normalized_hash)`: a repeat bumps
   * `seen_count` and reports `created: false` rather than duplicating the row.
   */
  publishDomainMemory(input: {
    readonly identity: string
    readonly category: string
    readonly content: string
    readonly importance?: number
  }): DomainPublishResult
  /**
   * Live rows under a domain identity (`active`/`permanent`). Read-only, and the
   * ONLY input to the approval gate's admission check: a domain's `cap` is
   * derived from its token budget, so without this count the number was
   * displayed and never enforced (2026-10-16).
   */
  countDomainMemories(identity: string): number
  /**
   * WP11: the content behind a backfill plan's ids, in the order asked.
   * Unscoped by identity on purpose — a vector is a property of the row, not of
   * the project that happens to read it.
   */
  readContents(ids: readonly number[]): ReadonlyArray<{ readonly id: number; readonly content: string }>
  /**
   * WP11: store one vector under `modelId`. This is the ONLY writer of
   * `memory_embeddings`, and the caller must have proved shared-space parity
   * first (see `vector-lane.ts` / the lane's shared-space gate): a vector in a
   * space this adapter cannot reproduce is a poison pill for every read.
   */
  storeEmbedding(input: {
    readonly memoryId: number
    readonly modelId: string
    readonly vector: Float32Array
  }): EmbeddingStoreResult
  /** `archive`: `status = 'archived'` (± reason/supersede) plus an `archive`/`superseded` delta. */
  archiveMemory(input: ArchiveMemoryInput): MemoryWriteResult
  /** `merge`: sources superseded into the aggregated target; `superseded` + `update` deltas. */
  mergeMemory(input: MergeMemoryInput): MemoryMergeResult
  /** `get`: one row owned by `identity` (archived rows included), else undefined (§8.1). */
  getMemory(identity: string, id: number): MemoryRecord | undefined
  /** `list`: injectable rows of `identity`, in MC's render order (§11.6). */
  listMemories(identity: string, options?: ListMemoriesOptions): readonly MemoryRecord[]
  /**
   * Explicit-retrieval telemetry (§9.1): `retrieval_count + 1` and a fresh
   * `last_retrieved_at` for rows the agent explicitly retrieved, in one
   * `BEGIN IMMEDIATE`. Never touches `seen_count` (that is write dedup) and
   * never throws: a fenced, module-managed or failing database is reported.
   */
  recordRetrieval(input: MemoryRetrievalInput): MemoryRetrievalOutcome
  /**
   * Maintenance: ids of this project's active rows whose TTL has lapsed
   * (`expires_at <= now`). The caller archives them through `archiveMemory`
   * (the contract action — expiry is a plain archive with a reason), which
   * keeps the mutation log in the loop.
   */
  listExpired(identity: string, now: number, limit?: number): readonly number[]
  /**
   * Maintenance: bank per-memory `verified_at` for rows the verifier judged
   * still-true (MC dreamer verify: per-memory verified_at, no global
   * watermark; metadata only — no mutation log, no content change).
   */
  markVerified(identity: string, ids: readonly number[], verifiedAt: number): number
  /**
   * Maintenance/classify: bank an importance score with `classified_at` (MC's
   * classify-memories slice). Metadata only — no mutation log, no `updated_at`,
   * embeddings/verifications untouched: a score is not a content change, so
   * the §4.5 clears must not fire. Clamped to MC's 1..100 band. Returns the
   * number of rows actually scored (archived/superseded and foreign rows
   * self-filter through the WHERE clause).
   */
  classifyMemories(
    identity: string,
    entries: ReadonlyArray<{ readonly id: number; readonly importance: number }>,
    classifiedAt: number,
  ): number
  close(): void
}

const INSERT_MEMORY = `
  INSERT INTO memories(
    project_path, category, content, normalized_hash, importance, scope, shareable,
    source_session_id, source_type, seen_count, retrieval_count,
    first_seen_at, created_at, updated_at, last_seen_at,
    status, expires_at, verification_status
  ) VALUES(?, ?, ?, ?, 50, 'project', 0, ?, 'historian', 1, 0, ?, ?, ?, ?, 'active', ?, 'unverified')
`

/**
 * WP9/WP10 — a DOMAIN memory: owned by a synthetic domain identity and readable
 * by every peer project.
 *
 * The two columns that make it visible are written explicitly:
 * `scope = 'universe'` and `shareable = 1`. Every other insert path here leaves
 * them to the schema (`'project'` / `0`), which is correct for a project fact
 * and would make a domain row invisible to the very projects it exists for —
 * published, and seen by nobody.
 *
 * `expires_at` is NULL on purpose. The contract's TTL categories are the two
 * legacy ones; organisation knowledge does not rot, and a domain row that
 * silently expired would take its visibility with it.
 *
 * `source_type = 'user'` records that a HUMAN published it (the approval gate),
 * not the historian: MC reserves the distinction and it is the only way to tell
 * afterwards which rows were machine-derived.
 */
const INSERT_DOMAIN_MEMORY = `
  INSERT INTO memories(
    project_path, category, content, normalized_hash, importance, scope, shareable,
    source_session_id, source_type, seen_count, retrieval_count,
    first_seen_at, created_at, updated_at, last_seen_at,
    status, expires_at, verification_status
  ) VALUES(?, ?, ?, ?, ?, 'universe', 1, ?, 'user', 1, 0, ?, ?, ?, ?, 'active', NULL, 'unverified')
`

/**
 * MC's `getMemorySelectColumns` (§11.1), verbatim column list and aliases.
 * Every reader/writer below projects through this so a row always comes back
 * in the same shape the storage layer would return.
 */
const MEMORY_SELECT_COLUMNS = `
  memories.id AS id,
  memories.project_path AS projectPath,
  memories.category AS category,
  memories.content AS content,
  memories.normalized_hash AS normalizedHash,
  COALESCE(memories.importance, 50) AS importance,
  COALESCE(memories.scope, 'project') AS scope,
  COALESCE(memories.shareable, 0) AS shareable,
  memories.source_session_id AS sourceSessionId,
  memories.source_type AS sourceType,
  memories.seen_count AS seenCount,
  memories.retrieval_count AS retrievalCount,
  memories.first_seen_at AS firstSeenAt,
  memories.created_at AS createdAt,
  memories.updated_at AS updatedAt,
  memories.last_seen_at AS lastSeenAt,
  memories.last_retrieved_at AS lastRetrievedAt,
  memories.status AS status,
  memories.expires_at AS expiresAt,
  memories.verification_status AS verificationStatus,
  memories.verified_at AS verifiedAt,
  memories.superseded_by_memory_id AS supersededByMemoryId,
  memories.merged_from AS mergedFrom,
  memories.metadata_json AS metadataJson
`

/** The 21-value agent INSERT (§11.1): 13 bound parameters, the rest literals. */
const INSERT_AGENT_MEMORY = `
  INSERT INTO memories
    (project_path, category, content, normalized_hash, importance,
     source_session_id, source_type, seen_count, retrieval_count,
     first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at,
     status, expires_at, verification_status, verified_at,
     superseded_by_memory_id, merged_from, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, NULL,
          'active', ?, 'unverified', NULL, NULL, NULL, ?)
`

/**
 * `seen_count` bump for content duplicates. `COALESCE` matches the Rust
 * facade's NULL-tolerant form (contract §9.2); the promotion statement above
 * keeps MC's literal `seen_count + 1` untouched.
 */
const BUMP_SEEN_COUNT = `
  UPDATE memories SET seen_count = COALESCE(seen_count, 0) + 1, last_seen_at = ?, updated_at = ? WHERE id = ?
`

/**
 * Explicit-retrieval telemetry (contract §9.1).
 *
 * DELIBERATE DIVERGENCE from MC's `updateMemoryRetrievalCount` statement,
 * which also writes `updated_at = ?`. Here `updated_at` is load-bearing:
 * `memory-bridge.ts` composes the m[0] pool digest from `id:updated_at` and
 * renders the pool in `updated_at DESC` order, so bumping it on every read
 * would rebuild the cached prefix and reorder the injected block — precisely
 * the cache break the m[0]/m[1] split exists to prevent. MC's own comment
 * calls this counter "telemetry, not correctness", so the counter and
 * `last_retrieved_at` move while `updated_at` deliberately does not.
 */
const BUMP_RETRIEVAL_COUNT = `
  UPDATE memories SET retrieval_count = COALESCE(retrieval_count, 0) + 1, last_retrieved_at = ? WHERE id = ?
`

/** Ownership probe for id-addressed writes (§8.1 OWNED). */
const SELECT_OWNER = 'SELECT project_path AS projectPath FROM memories WHERE id = ?'

/**
 * `update` (§11.3 tool-layer content/category, Rust facade's connected
 * clears) plus `importance` so the tool layer can re-rank a memory. The
 * `shareable = 0` reset is MC's fail-closed invariant (§4.3): the classify
 * judgement was scored against the old content.
 */
const UPDATE_MEMORY_CONTENT = `
  UPDATE memories
     SET content = ?, category = ?, normalized_hash = ?, updated_at = ?,
         importance = COALESCE(?, importance),
         shareable = 0, classified_at = NULL,
         mural_cue = NULL, mural_cue_hash = NULL, mural_cue_at = NULL,
         mural_cue_rejection_count = 0
   WHERE id = ?
`

const ARCHIVE_MEMORY = `
  UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?
`

const ARCHIVE_MEMORY_WITH_REASON = `
  UPDATE memories SET status = 'archived', metadata_json = ?, updated_at = ? WHERE id = ?
`

/** Merge/archive source that is being replaced by another memory (§11.4). */
const SUPERSEDE_MEMORY = `
  UPDATE memories
     SET status = 'archived', superseded_by_memory_id = ?,
         metadata_json = COALESCE(?, metadata_json), updated_at = ?
   WHERE id = ?
`

/** Classify scoring (metadata only — see the interface note): the importance
 * score plus the `classified_at` stamp, ownership- and status-scoped. */
const CLASSIFY_MEMORY = `
  UPDATE memories SET importance = ?, classified_at = ?
   WHERE project_path = ? AND id = ? AND status IN ('active','permanent')
`

/** Merge target (canonical) aggregation (§11.4). */
const MERGE_MEMORY_TARGET = `
  UPDATE memories
     SET content = ?, normalized_hash = ?, seen_count = ?, retrieval_count = ?,
         merged_from = ?, status = ?, updated_at = ?, shareable = 0, classified_at = NULL
   WHERE id = ?
`

/** The mutation-log primitive (§6.2): `update` / `archive` / `superseded`. */
const APPEND_MUTATION = `
  INSERT INTO memory_mutation_log
    (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`

/**
 * The restore half of §4.3 (WP4 — this adapter becomes the owner of sharing).
 *
 * MC clears `shareable` on every content change, because its classify judgement
 * was scored against the old text. That is coherent while MC's classify task
 * owns the flag and will re-score the row. Once this adapter owns sharing,
 * nothing re-scores it: a rewritten org memory would drop out of every other
 * project's view, and a rewritten shared fact would quietly stop crossing
 * projects — a withdrawal nobody asked for.
 *
 * `scope` needs no restore: neither reset statement touches it. The
 * `AND shareable = 0` guard only keeps the write a no-op when something already
 * put the value back; the DECISION to restore is made before the mutation runs
 * (see {@link sharingToRestore}), never by the guard.
 */
const RESTORE_SHARING = 'UPDATE memories SET shareable = ? WHERE id = ? AND shareable = 0'

/**
 * Whether a content mutation must put a row's sharing back, and to what value.
 *
 * One-directional on purpose: a row that WAS shared (`shareable = 1`) keeps its
 * sharing; a row that was not is never promoted. The reverse direction is the
 * one that leaks — an edit must never be able to widen visibility.
 *
 * `shareable` is read through the §11.1 projection, which COALESCEs a legacy
 * NULL to 0, so a NULL row is treated as private rather than unknown.
 */
export function sharingToRestore(row: { readonly shareable: number } | undefined | null): number | undefined {
  if (row === null || row === undefined) return undefined
  return row.shareable === 1 ? 1 : undefined
}

/** `list` (§11.6): injectable rows of one project, in MC's render order. */
const listMemoriesSql = (unverifiedOnly: boolean, recurrenceFirst = false): string =>
  `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories
   WHERE project_path = ? AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?)`
  + (unverifiedOnly ? ` AND verification_status = 'unverified'` : '')
  + (recurrenceFirst
    ? // Sweep-internal order, maintenance only — the §11.6 render order above is
      // untouched. A fact re-derived across sessions (seen_count ≥ 2) is the
      // strongest keep-evidence short of the verdict itself, so the sweep
      // adjudicates it first.
      ' ORDER BY COALESCE(seen_count, 0) >= 2 DESC, category ASC, updated_at DESC, id ASC'
    : ' ORDER BY category ASC, updated_at DESC, id ASC')

const LIST_MEMORIES = listMemoriesSql(false)

/** Candidates for the maintenance sweep: the ORDER BY window stays the same,
 * but the unverified filter is applied BEFORE the limit, so verification
 * progress always advances through the whole project — and recurrence jumps
 * the queue (see listMemoriesSql). */
const LIST_MEMORIES_UNVERIFIED = listMemoriesSql(true, true)

// (The 2026-10-13 corpus cutover removed the module-managed authority guard:
//  the own corpus carries no authority tables and no Rust module exists —
//  the writer's §8.4 yield/abort translation went with it.)

/**
 * Merge an `archive_reason` into `metadata_json` exactly like MC's
 * `mergeMemoryMetadata` (§11.5): a malformed object is replaced by a fresh one.
 */
function mergeArchiveMetadata(raw: string | null, reason: string): string {
  let base: Record<string, unknown> = {}
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>
      }
    } catch {
      // A malformed object is discarded, not propagated.
    }
  }
  return JSON.stringify({ ...base, archive_reason: reason })
}

/** Parse a `merged_from` JSON array of ids, tolerating NULL/malformed values. */
function parseMergedFrom(raw: string | null): number[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is number => typeof value === 'number' && Number.isInteger(value))
  } catch {
    return []
  }
}

/**
 * `StatementSync` hands back raw SQL rows (`Record<string, SQLOutputValue>`);
 * `MEMORY_SELECT_COLUMNS` pins the shape, which TypeScript cannot see through
 * that record type, so every read funnels through these two casts.
 */
function asMemoryRecord(row: unknown): MemoryRecord | undefined {
  return row as MemoryRecord | undefined
}

function asMemoryRecords(rows: unknown): MemoryRecord[] {
  return rows as MemoryRecord[]
}

/**
 * Open the memory corpus read-write. Missing file / newer schema disable
 * writing with a warning instead of throwing: the adapter must never break a
 * turn because memory is unavailable.
 */
export function openMemoryWriter(options: MemoryWriterOptions): MemoryWriter {
  const now = options.now ?? Date.now
  const unavailable = (detail: string): MemoryWriter => {
    options.logger.warn(`magic-context memory writer disabled: ${detail} (${options.dbPath})`)
    const refused: MemoryWriteFailure = { ok: false, reason: 'unavailable', detail }
    const noTelemetry: MemoryRetrievalOutcome = {
      ok: false,
      recorded: [],
      skipped: [],
      reason: 'unavailable',
    }
    return {
      dbPath: options.dbPath,
      status: { ok: false, detail },
      promoteFacts: input => ({
        identity: input.identity,
        inserted: [],
        seenAgain: [],
        skipped: [],
        maxMemoryId: 0,
      }),
      stats: () => ({ rows: 0, mutationLog: 0, epoch: 0, verified: 0, unverified: 0 }),
      writeMemory: () => refused,
      publishDomainMemory: () => refused,
      countDomainMemories: () => 0,
      readContents: () => [],
      storeEmbedding: () => refused,
      updateMemory: () => refused,
      archiveMemory: () => refused,
      mergeMemory: () => refused,
      getMemory: () => undefined,
      listMemories: () => [],
      listExpired: () => [],
      markVerified: () => 0,
      classifyMemories: () => 0,
      recordRetrieval: () => noTelemetry,
      close: () => undefined,
    }
  }
  if (!existsSync(options.dbPath)) return unavailable('database not found')

  let db: DatabaseSync
  try {
    db = new DatabaseSync(options.dbPath)
    // Connection order is load-bearing (contract §10.1): the busy timeout must
    // precede WAL (acquiring the mode itself can need the lock), and
    // foreign_keys must be ON before the first read/write or the
    // `memory_embeddings` cascade is a no-op. WAL is a database-level,
    // persistent setting, so re-applying it is a harmless no-op.
    db.exec(`PRAGMA busy_timeout = ${String(options.busyTimeoutMs ?? 5_000)}`)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
  } catch (error) {
    return unavailable(`cannot open (${errText(error)})`)
  }

  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(row => row.name),
    )
    if (!tables.has('memories')) {
      db.close()
      return unavailable('memories table missing')
    }

    // Contract fence: MC's storage version, read exactly like the bridge reads
    // it (main lane `version < 10000`). A NEWER database downgrades this writer
    // to read-only — the adapter must not write rows a storage layer it does
    // not understand may interpret differently. An absent table means a legacy
    // or trimmed database, which keeps today's (unfenced) behaviour.
    const corpusVersion = (() => {
      if (!tables.has('schema_migrations')) return undefined
      try {
        const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE version < 10000')
          .get() as { version: number | null } | undefined
        return row?.version ?? undefined
      } catch {
        return undefined
      }
    })()
    const corpusFenced = corpusVersion !== undefined && corpusVersion > MEMORY_SCHEMA_MAX_VERSION
    if (corpusFenced) {
      options.logger.warn(
        `magic-context memory: corpus v${String(corpusVersion)} is newer than the adapter understands `
          + `(v${String(MEMORY_SCHEMA_MAX_VERSION)}); the writer is READ-ONLY and every write is refused`,
      )
    }

    const byHash = db.prepare(
      'SELECT id, status FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?',
    )
    const bumpSeen = db.prepare(
      'UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ?',
    )
    const insert = db.prepare(INSERT_MEMORY)
    const insertDomain = db.prepare(INSERT_DOMAIN_MEMORY)
    const maxId = db.prepare('SELECT MAX(id) AS id FROM memories WHERE project_path = ?')
    const statsRows = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE project_path = ?')
    const statsMutations = db.prepare('SELECT COUNT(*) AS c FROM memory_mutation_log WHERE project_path = ?')
    const statsEpoch = db.prepare('SELECT project_memory_epoch AS e FROM project_state WHERE project_path = ?')
    // Verification coverage for the telemetry panel: the dreamer slice's own KPI.
    // Admission cap input: the live rows of ONE domain identity. `permanent`
    // counts too — a permanent row occupies the domain exactly like an active one.
    const countDomainRows = db.prepare(
      "SELECT COUNT(*) AS c FROM memories WHERE project_path = ? AND status IN ('active','permanent')",
    )
    const statsVerification = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS verified,
         COALESCE(SUM(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END), 0) AS unverified
       FROM memories WHERE project_path = ? AND status IN ('active','permanent')`,
    )

    // Agent write path (contract §11). Prepared once; the whole projection is
    // required, so a pre-v94 database disables the writer at probe time rather
    // than failing mid-write.
    const selectByHash = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?`,
    )
    const selectById = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?`)
    const insertAgentMemory = db.prepare(INSERT_AGENT_MEMORY)
    const bumpSeenCount = db.prepare(BUMP_SEEN_COUNT)
    const bumpRetrieval = db.prepare(BUMP_RETRIEVAL_COUNT)
    const selectOwner = db.prepare(SELECT_OWNER)
    const updateMemoryContent = db.prepare(UPDATE_MEMORY_CONTENT)
    const archiveMemory = db.prepare(ARCHIVE_MEMORY)
    const archiveMemoryWithReason = db.prepare(ARCHIVE_MEMORY_WITH_REASON)
    const supersedeMemory = db.prepare(SUPERSEDE_MEMORY)
    const mergeMemoryTarget = db.prepare(MERGE_MEMORY_TARGET)
    const restoreSharing = db.prepare(RESTORE_SHARING)
    const appendMutation = db.prepare(APPEND_MUTATION)
    const listMemoriesAll = db.prepare(LIST_MEMORIES)
    const listMemoriesLimited = db.prepare(`${LIST_MEMORIES} LIMIT ?`)
    const listUnverifiedAll = db.prepare(LIST_MEMORIES_UNVERIFIED)
    const listUnverifiedLimited = db.prepare(`${LIST_MEMORIES_UNVERIFIED} LIMIT ?`)
    // Content changes invalidate the classify/verify artefacts (§4.5). Both
    // tables are absent on trimmed databases, hence the table guard.
    const deleteEmbeddings = tables.has('memory_embeddings')
      ? db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?')
      : undefined
    // WP11: the vector backfill is the only writer of this table. Both
    // statements are prepared together so "can I read the table" and "can I
    // write it" can never disagree.
    const selectEmbedding = tables.has('memory_embeddings')
      ? db.prepare('SELECT 1 AS one FROM memory_embeddings WHERE memory_id = ? AND model_id = ?')
      : undefined
    const insertEmbeddingStatement = tables.has('memory_embeddings')
      ? db.prepare('INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES(?, ?, ?)')
      : undefined
    const deleteVerifications = tables.has('memory_verifications')
      ? db.prepare('DELETE FROM memory_verifications WHERE memory_id = ?')
      : undefined

    const maxFor = (identity: string): number => {
      const row = maxId.get(identity) as { id: number | null } | undefined
      return row?.id ?? 0
    }

    /** A refused write: logged, never thrown (the caller owns the turn). */
    const refusal = (
      operation: string,
      reason: MemoryWriteFailureReason,
      detail: string,
    ): MemoryWriteFailure => {
      options.logger.info(`magic-context memory: ${operation} refused (${reason}): ${detail}`)
      return { ok: false, reason, detail }
    }

    const databaseFailure = (operation: string, error: unknown): MemoryWriteFailure => {
      const detail = errText(error)
      options.logger.warn(`magic-context memory: ${operation} failed: ${detail}`)
      return { ok: false, reason: 'database-error', detail }
    }

    /**
     * The contract fence: a database newer than the adapter understands stays
     * READ-ONLY. Reads (`getMemory`/`listMemories`/`stats`) keep working; every
     * mutation — including promotion — is refused with a diagnosable reason.
     */
    const fenceRefusal = (operation: string): MemoryWriteFailure => refusal(
      operation,
      'corpus-version-unsupported',
      `corpus schema v${String(corpusVersion)} is newer than the adapter understands `
        + `(v${String(MEMORY_SCHEMA_MAX_VERSION)}); the memory write path is READ-ONLY. `
        + 'Update the adapter before writing.',
    )

    /**
     * `BEGIN IMMEDIATE` (contract §10.2): a read-then-write must take the write
     * lock up front, and SQLite does not honour `busy_timeout` while upgrading.
     */
    const runImmediate = <T>(body: () => T): T | MemoryWriteFailure => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const value = body()
        db.exec('COMMIT')
        return value
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* the transaction may already be gone */
        }
        throw error
      }
    }

    const writerStatus: MemoryWriterStatus = corpusFenced
      ? {
        ok: true,
        readOnly: true,
        detail: `corpus schema v${String(corpusVersion)} is newer than the adapter understands `
          + `(v${String(MEMORY_SCHEMA_MAX_VERSION)}); the memory write path is READ-ONLY.`,
        ...(corpusVersion === undefined ? {} : { corpusVersion }),
      }
      : { ok: true, ...(corpusVersion === undefined ? {} : { corpusVersion }) }

    return {
      dbPath: options.dbPath,
      status: writerStatus,
      stats: identity => {
        try {
          const coverage = statsVerification.get(identity) as { verified: number; unverified: number }
          return {
            rows: (statsRows.get(identity) as { c: number }).c,
            mutationLog: (statsMutations.get(identity) as { c: number }).c,
            epoch: ((statsEpoch.get(identity) as { e: number } | undefined)?.e) ?? 0,
            verified: Number(coverage.verified),
            unverified: Number(coverage.unverified),
          }
        } catch {
          return { rows: 0, mutationLog: 0, epoch: 0, verified: 0, unverified: 0 }
        }
      },
      promoteFacts: (input) => {
        const outcomeBase = {
          identity: input.identity,
          inserted: [] as Array<{ id: number; category: string; content: string }>,
          seenAgain: [] as Array<{ id: number; category: string }>,
          skipped: [] as Array<{ category: string; content: string; reason: string }>,
        }
        if (corpusFenced) {
          options.logger.warn(
            `magic-context memory: promotion refused, schema v${String(corpusVersion)} is newer than `
              + `the adapter understands (v${String(MEMORY_SCHEMA_MAX_VERSION)})`,
          )
          return { ...outcomeBase, maxMemoryId: maxFor(input.identity) }
        }
        // Validated first, so an invalid fact neither aborts the batch nor
        // leaves a half-written row behind.
        const accepted: Array<{ category: string; content: string; hash: string }> = []
        for (const fact of input.facts) {
          const category = typeof fact.category === 'string' ? fact.category : ''
          const content = typeof fact.content === 'string' ? fact.content : ''
          if (!isPromotableCategory(category)) {
            outcomeBase.skipped.push({ category, content, reason: 'category-not-promotable' })
            continue
          }
          if (content.trim().length === 0) {
            outcomeBase.skipped.push({ category, content, reason: 'empty-content' })
            continue
          }
          accepted.push({ category, content, hash: normalizedMemoryHash(content) })
        }
        if (accepted.length === 0) return { ...outcomeBase, maxMemoryId: maxFor(input.identity) }

        const timestamp = now()
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const fact of accepted) {
            const existing = byHash.get(input.identity, fact.category, fact.hash) as
              | { id: number; status: string | null }
              | undefined
            if (existing !== undefined) {
              bumpSeen.run(timestamp, timestamp, existing.id)
              outcomeBase.seenAgain.push({ id: existing.id, category: fact.category })
              continue
            }
            const expiresAt = resolveExpiresAt(fact.category, timestamp)
            const result = insert.run(
              input.identity,
              fact.category,
              fact.content,
              fact.hash,
              input.sessionId ?? null,
              timestamp,
              timestamp,
              timestamp,
              timestamp,
              expiresAt ?? null,
            )
            outcomeBase.inserted.push({
              id: Number(result.lastInsertRowid),
              category: fact.category,
              content: fact.content,
            })
          }
          db.exec('COMMIT')
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            /* the transaction may already be gone */
          }
          throw error
        }
        return { ...outcomeBase, maxMemoryId: maxFor(input.identity) }
      },
      writeMemory: (input) => {
        if (typeof input.identity !== 'string' || input.identity.length === 0) {
          return refusal('write', 'invalid-argument', 'a resolved project identity is required')
        }
        if (!isWritableMemoryCategory(input.category)) {
          return refusal(
            'write',
            'invalid-category',
            `Unknown memory category '${String(input.category)}'. The agent write path accepts only: ${V2_MEMORY_CATEGORIES.join(', ')}.`,
          )
        }
        if (typeof input.content !== 'string' || input.content.trim().length === 0) {
          return refusal('write', 'empty-content', "Error: 'content' is required when action is 'write'.")
        }
        const sourceType = input.sourceType ?? 'agent'
        if (sourceType === 'user') {
          return refusal(
            'write',
            'source-type-reserved',
            'sourceType "user" is reserved for future dashboard manual entry and cannot be written by agent paths',
          )
        }
        if (corpusFenced) return fenceRefusal('write')
        const category = input.category
        const hash = normalizedMemoryHash(input.content)
        const timestamp = now()
        try {
          return runImmediate<MemoryWriteResult>(() => {
            const existing = asMemoryRecord(selectByHash.get(input.identity, category, hash))
            if (existing !== undefined) {
              bumpSeenCount.run(timestamp, timestamp, existing.id)
              const after = asMemoryRecord(selectById.get(existing.id))
              return { ok: true, id: existing.id, created: false, seenCount: after?.seenCount ?? 1 }
            }
            const expiresAt = input.expiresAt ?? resolveExpiresAt(category, timestamp) ?? null
            // Clamp to MC's 1..100 band (storage-memory.ts:1132-1135) so an
            // out-of-range tool argument can't skew ranking on either side.
            const importance = Math.min(100, Math.max(1, input.importance ?? 50))
            const result = insertAgentMemory.run(
              input.identity,
              category,
              input.content,
              hash,
              importance,
              input.sessionId ?? null,
              sourceType,
              timestamp,
              timestamp,
              timestamp,
              timestamp,
              expiresAt,
              input.metadataJson ?? null,
            )
            return { ok: true, id: Number(result.lastInsertRowid), created: true, seenCount: 1 }
          })
        } catch (error) {
          return databaseFailure('write', error)
        }
      },
      publishDomainMemory: (input) => {
        const content = input.content.trim()
        if (content.length === 0) {
          return refusal('publish-domain', 'invalid-argument', 'Error: a domain memory needs content.')
        }
        if (!isWritableMemoryCategory(input.category)) {
          return refusal(
            'publish-domain',
            'invalid-argument',
            `Error: '${input.category}' is not a writable memory category.`,
          )
        }
        if (input.identity.trim().length === 0) {
          return refusal('publish-domain', 'invalid-argument', 'Error: a domain memory needs an identity.')
        }
        if (corpusFenced) return fenceRefusal('publish-domain')
        const hash = normalizedMemoryHash(content)
        try {
          const outcome = runImmediate<DomainPublishResult>(() => {
            // The contract's UNIQUE(project_path, category, normalized_hash)
            // makes republishing idempotent: the row is already visible, so the
            // only honest change is the recurrence counter.
            const existing = byHash.get(input.identity, input.category, hash) as { id: number } | undefined
            if (existing !== undefined) {
              const timestamp = now()
              bumpSeen.run(timestamp, timestamp, existing.id)
              return { ok: true, id: existing.id, created: false }
            }
            const timestamp = now()
            const result = insertDomain.run(
              input.identity,
              input.category,
              content,
              hash,
              Math.max(1, Math.min(100, Math.round(input.importance ?? 50))),
              `domain:${input.identity}`,
              timestamp,
              timestamp,
              timestamp,
              timestamp,
            )
            return { ok: true, id: Number(result.lastInsertRowid), created: true }
          })
          return outcome
        } catch (error) {
          return databaseFailure('publish-domain', error)
        }
      },
      countDomainMemories: (identity) => {
        try {
          return Number((countDomainRows.get(identity) as { c: number }).c)
        } catch {
          // Never a gate the publisher cannot evaluate: an unreadable count is
          // reported as an empty domain, and the write below fails on its own
          // terms if it cannot proceed.
          return 0
        }
      },
      readContents: (ids) => {
        const out: Array<{ id: number; content: string }> = []
        for (const id of ids) {
          try {
            const row = selectById.get(id) as { id: number; content: string } | undefined
            if (row !== undefined) out.push({ id: Number(row.id), content: String(row.content) })
          } catch {
            // A row that cannot be read is simply not a backfill candidate.
          }
        }
        return out
      },
      storeEmbedding: (input) => {
        if (input.modelId.trim() === '') {
          return refusal('store-embedding', 'invalid-argument', 'Error: an embedding needs a model id.')
        }
        if (input.vector.length === 0) {
          return refusal('store-embedding', 'invalid-argument', 'Error: an embedding needs at least one dimension.')
        }
        if (corpusFenced) return fenceRefusal('store-embedding')
        if (selectEmbedding === undefined || insertEmbeddingStatement === undefined) {
          return refusal(
            'store-embedding',
            'unsupported',
            'Error: this contract has no memory_embeddings table, so the vector lane cannot be filled.',
          )
        }
        try {
          return runImmediate<EmbeddingStoreResult>(() => {
            // The contract keys this table `(memory_id, model_id)`; checking
            // first makes the outcome deterministic and gives an honest
            // `created`, and the key makes a concurrent second writer harmless.
            if (selectEmbedding.get(input.memoryId, input.modelId) !== undefined) {
              return { ok: true, id: input.memoryId, created: false }
            }
            insertEmbeddingStatement.run(
              input.memoryId,
              Buffer.from(input.vector.buffer, input.vector.byteOffset, input.vector.byteLength),
              input.modelId,
            )
            return { ok: true, id: input.memoryId, created: true }
          })
        } catch (error) {
          return databaseFailure('store-embedding', error)
        }
      },
      updateMemory: (input) => {
        if (!Number.isInteger(input.id) || input.id <= 0) {
          return refusal(
            'update',
            'invalid-argument',
            "Error: 'ids' must contain exactly one integer memory ID when action is 'update'.",
          )
        }
        if (typeof input.content !== 'string' || input.content.trim().length === 0) {
          return refusal('update', 'empty-content', "Error: 'content' is required when action is 'update'.")
        }
        if (input.category !== undefined && !isWritableMemoryCategory(input.category)) {
          return refusal('update', 'invalid-category', `Unknown memory category '${String(input.category)}'.`)
        }
        if (corpusFenced) return fenceRefusal('update')
        const hash = normalizedMemoryHash(input.content)
        try {
          return runImmediate<MemoryWriteResult>(() => {
            const row = asMemoryRecord(selectById.get(input.id))
            if (row === undefined) {
              return refusal('update', 'not-found', `Error: Memory with ID ${input.id} was not found.`)
            }
            if (row.projectPath !== input.identity) {
              // Not leaking existence: a foreign row reads as absent (§8.3).
              return refusal('update', 'not-owned', `Error: Memory with ID ${input.id} was not found.`)
            }
            if (row.status === 'archived' || row.supersededByMemoryId !== null) {
              return refusal(
                'update',
                'archived-or-superseded',
                `Error: Memory with ID ${input.id} is archived or superseded; restore it before updating.`,
              )
            }
            const category = input.category ?? row.category
            // Dedup inside the transaction, excluding the row itself (§11.3).
            const duplicate = asMemoryRecord(selectByHash.get(input.identity, category, hash))
            if (duplicate !== undefined && duplicate.id !== row.id) {
              return refusal(
                'update',
                'duplicate',
                `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
              )
            }
            const timestamp = now()
            updateMemoryContent.run(
              input.content,
              category,
              hash,
              timestamp,
              input.importance ?? null,
              row.id,
            )
            // §4.3 cleared `shareable`; put back what this edit did not decide to
            // change, decided from the row as it was read inside this transaction.
            const restore = sharingToRestore(row)
            if (restore !== undefined) restoreSharing.run(restore, row.id)
            deleteEmbeddings?.run(row.id)
            deleteVerifications?.run(row.id)
            appendMutation.run(input.identity, 'update', row.id, null, category, input.content, timestamp)
            return { ok: true, id: row.id }
          })
        } catch (error) {
          return databaseFailure('update', error)
        }
      },
      archiveMemory: (input) => {
        if (!Number.isInteger(input.id) || input.id <= 0) {
          return refusal(
            'archive',
            'invalid-argument',
            "Error: 'ids' must contain at least one integer memory ID when action is 'archive'.",
          )
        }
        if (input.supersededBy !== undefined && (!Number.isInteger(input.supersededBy) || input.supersededBy <= 0)) {
          return refusal('archive', 'invalid-argument', "Error: 'supersededBy' must be an integer memory ID.")
        }
        if (corpusFenced) return fenceRefusal('archive')
        const reason = typeof input.reason === 'string' && input.reason.trim().length > 0
          ? input.reason.trim()
          : undefined
        try {
          return runImmediate<MemoryWriteResult>(() => {
            const row = asMemoryRecord(selectById.get(input.id))
            if (row === undefined) {
              return refusal('archive', 'not-found', `Error: Memory with ID ${input.id} was not found.`)
            }
            if (row.projectPath !== input.identity) {
              return refusal('archive', 'not-owned', `Error: Memory with ID ${input.id} was not found.`)
            }
            if (row.status === 'archived' || row.supersededByMemoryId !== null) {
              return refusal(
                'archive',
                'archived-or-superseded',
                `Error: Memory with ID ${input.id} is archived or superseded; restore it before archiving.`,
              )
            }
            const timestamp = now()
            const metadata = reason === undefined ? null : mergeArchiveMetadata(row.metadataJson, reason)
            if (input.supersededBy !== undefined) {
              supersedeMemory.run(input.supersededBy, metadata, timestamp, row.id)
            } else if (metadata !== null) {
              archiveMemoryWithReason.run(metadata, timestamp, row.id)
            } else {
              archiveMemory.run(timestamp, row.id)
            }
            appendMutation.run(
              input.identity,
              input.supersededBy === undefined ? 'archive' : 'superseded',
              row.id,
              input.supersededBy ?? null,
              null,
              null,
              timestamp,
            )
            return { ok: true, id: row.id }
          })
        } catch (error) {
          return databaseFailure('archive', error)
        }
      },
      mergeMemory: (input) => {
        if (!Number.isInteger(input.targetId) || input.targetId <= 0) {
          return refusal(
            'merge',
            'invalid-argument',
            "Error: 'ids' must include at least two integer memory IDs when action is 'merge'.",
          )
        }
        if (
          input.sourceIds.length === 0
          || input.sourceIds.some(id => !Number.isInteger(id) || id <= 0)
        ) {
          return refusal(
            'merge',
            'invalid-argument',
            "Error: 'ids' must include at least two integer memory IDs when action is 'merge'.",
          )
        }
        const sourceIds = [...new Set(input.sourceIds)].filter(id => id !== input.targetId)
        if (sourceIds.length === 0) {
          return refusal(
            'merge',
            'invalid-argument',
            "Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.",
          )
        }
        if (typeof input.content !== 'string' || input.content.trim().length === 0) {
          return refusal('merge', 'empty-content', "Error: 'content' is required when action is 'merge'.")
        }
        if (input.category !== undefined && !isWritableMemoryCategory(input.category)) {
          return refusal('merge', 'invalid-category', `Unknown memory category '${String(input.category)}'.`)
        }
        if (corpusFenced) return fenceRefusal('merge')
        const hash = normalizedMemoryHash(input.content)
        try {
          return runImmediate<MemoryMergeResult>(() => {
            const target = asMemoryRecord(selectById.get(input.targetId))
            if (target === undefined) {
              return refusal('merge', 'not-found', `Error: Memory with ID ${input.targetId} was not found.`)
            }
            const sources: MemoryRecord[] = []
            for (const id of sourceIds) {
              const row = asMemoryRecord(selectById.get(id))
              if (row === undefined) {
                return refusal('merge', 'not-found', `Error: Memory with ID ${id} was not found.`)
              }
              sources.push(row)
            }
            // Every affected row must be OWNED and primary-mutable (§8.1, §8.2).
            const foreign = [target, ...sources].find(row => row.projectPath !== input.identity)
            if (foreign !== undefined) {
              return refusal('merge', 'not-owned', `Error: Memory with ID ${foreign.id} was not found.`)
            }
            const stale = [target, ...sources].find(
              row => row.status === 'archived' || row.supersededByMemoryId !== null,
            )
            if (stale !== undefined) {
              return refusal(
                'merge',
                'archived-or-superseded',
                `Error: Memory with ID ${stale.id} is archived or superseded; restore it before merging.`,
              )
            }
            // Cross-category merge is structurally refused (§3.3).
            const categories = [...new Set([target, ...sources].map(row => row.category))]
            if (categories.length > 1) {
              return refusal(
                'merge',
                'category-mismatch',
                `Error: Cannot merge memories from different categories (${categories.join(', ')}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`,
              )
            }
            const category = input.category ?? target.category
            if (category !== target.category) {
              return refusal(
                'merge',
                'category-mismatch',
                `Error: Cannot merge memories from different categories (${target.category}, ${category}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`,
              )
            }
            const duplicate = asMemoryRecord(selectByHash.get(input.identity, category, hash))
            if (duplicate !== undefined && ![target, ...sources].some(row => row.id === duplicate.id)) {
              return refusal(
                'merge',
                'duplicate',
                `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
              )
            }
            const timestamp = now()
            // Aggregation rules (§11.4): sums of the non-negative counters, the
            // permanent flag OR-ed, and the id set unioned with each source's
            // own `merged_from` chain.
            const counters = [target, ...sources]
            const seenCount = counters.reduce((sum, row) => sum + Math.max(row.seenCount ?? 0, 0), 0)
            const retrievalCount = counters.reduce((sum, row) => sum + Math.max(row.retrievalCount ?? 0, 0), 0)
            const status = counters.some(row => row.status === 'permanent') ? 'permanent' : 'active'
            const mergedFrom = [...new Set([
              ...counters.map(row => row.id),
              ...sources.flatMap(row => parseMergedFrom(row.mergedFrom)),
            ])].sort((left, right) => left - right)
            mergeMemoryTarget.run(
              input.content,
              hash,
              seenCount,
              retrievalCount,
              JSON.stringify(mergedFrom),
              status,
              timestamp,
              target.id,
            )
            // Same §4.3 restore as `update`: the merge target keeps whatever
            // sharing it had, and a private target is never promoted by a merge.
            const restoreTarget = sharingToRestore(target)
            if (restoreTarget !== undefined) restoreSharing.run(restoreTarget, target.id)
            for (const source of sources) {
              supersedeMemory.run(target.id, null, timestamp, source.id)
              appendMutation.run(input.identity, 'superseded', source.id, target.id, null, null, timestamp)
            }
            if (input.content !== target.content || category !== target.category) {
              appendMutation.run(
                input.identity,
                'update',
                target.id,
                null,
                category,
                input.content,
                timestamp,
              )
            }
            return { ok: true, id: target.id, superseded: sources.map(row => row.id), mergedFrom }
          })
        } catch (error) {
          return databaseFailure('merge', error)
        }
      },
      getMemory: (identity, id) => {
        if (!Number.isInteger(id) || id <= 0) return undefined
        try {
          const row = asMemoryRecord(selectById.get(id))
          if (row === undefined || row.projectPath !== identity) return undefined
          return row
        } catch {
          return undefined
        }
      },
      listMemories: (identity, listOptions) => {
        try {
          const cutoff = listOptions?.now ?? now()
          const limit = listOptions?.limit
          const all = listOptions?.unverifiedOnly === true ? listUnverifiedAll : listMemoriesAll
          const limited = listOptions?.unverifiedOnly === true ? listUnverifiedLimited : listMemoriesLimited
          if (limit !== undefined) {
            if (!Number.isInteger(limit) || limit <= 0) return []
            return asMemoryRecords(limited.all(identity, cutoff, limit))
          }
          return asMemoryRecords(all.all(identity, cutoff))
        } catch {
          return []
        }
      },
      /**
       * Explicit-retrieval telemetry (§9.1). Never throws and never fails the
       * caller: telemetry is not correctness, so a fenced or module-managed
       * database reports `{ok:false, reason}` instead of raising, and rows the
       * caller does not own are skipped rather than counted.
       */
      recordRetrieval: (input) => {
        // `skipped` is always derived as "requested minus recorded", so it keeps
        // the caller's order and cannot disagree with `recorded`.
        const requested = [...new Set(input.ids)]
        const countable = requested.filter(id => Number.isInteger(id) && id > 0)
        const recorded: number[] = []
        if (typeof input.identity !== 'string' || input.identity.length === 0) {
          return { ok: false, recorded, skipped: requested, reason: 'invalid-argument' }
        }
        if (countable.length === 0) return { ok: true, recorded, skipped: requested }
        if (corpusFenced) {
          options.logger.warn(
            `magic-context memory: retrieval telemetry refused, schema v${String(corpusVersion)} is newer `
              + `than the adapter understands (v${String(MEMORY_SCHEMA_MAX_VERSION)})`,
          )
          return { ok: false, recorded, skipped: requested, reason: 'corpus-version-unsupported' }
        }
        const skipped = (): number[] => requested.filter(id => !recorded.includes(id))
        try {
          const outcome = runImmediate<{ ok: true }>(() => {
            const timestamp = now()
            for (const id of countable) {
              const owner = selectOwner.get(id) as { projectPath: string } | undefined
              if (owner === undefined || owner.projectPath !== input.identity) continue
              bumpRetrieval.run(timestamp, id)
              recorded.push(id)
            }
            return { ok: true }
          })
          if (!outcome.ok) return { ok: false, recorded, skipped: skipped(), reason: outcome.reason }
          return { ok: true, recorded, skipped: skipped() }
        } catch (error) {
          const detail = errText(error)
          options.logger.warn(`magic-context memory: retrieval telemetry failed: ${detail}`)
          return { ok: false, recorded, skipped: skipped(), reason: 'database-error' }
        }
      },
      listExpired: (identity, nowAt, limit = 200) => {
        try {
          if (corpusFenced) return []
          const rows = db.prepare(
            `SELECT id FROM memories`
            + ` WHERE project_path = ? AND status IN ('active','permanent')`
            + ` AND expires_at IS NOT NULL AND expires_at <= ?`
            + ` ORDER BY id ASC LIMIT ?`,
          ).all(identity, nowAt, Math.max(1, Math.min(500, limit))) as Array<{ id: number }>
          return rows.map(row => row.id)
        } catch (error) {
          options.logger.warn(`magic-context memory: listExpired failed: ${errText(error)}`)
          return []
        }
      },
      markVerified: (identity, ids, verifiedAt) => {
        if (ids.length === 0) return 0
        try {
          if (corpusFenced) return 0
          const stamp = runImmediate<{ ok: true; changed: number }>(() => {
            // MC writes verification_status and verified_at as a pair
            // (storage-memory.ts:464) — writing only verified_at left rows
            // that MC still read as unverified (audit R1).
            const statement = db.prepare(
              `UPDATE memories SET verification_status = 'verified', verified_at = ?`
                + ` WHERE project_path = ? AND id = ? AND status IN ('active','permanent')`,
            )
            let changed = 0
            for (const id of ids) {
              // node:sqlite reports `changes` as `number | bigint`.
              changed += Number(statement.run(verifiedAt, identity, id).changes)
            }
            return { ok: true, changed }
          })
          return stamp.ok ? stamp.changed : 0
        } catch (error) {
          options.logger.warn(`magic-context memory: markVerified failed: ${errText(error)}`)
          return 0
        }
      },
      classifyMemories: (identity, entries, classifiedAt) => {
        if (entries.length === 0) return 0
        try {
          if (corpusFenced) return 0
          const scored = runImmediate<{ ok: true; changed: number }>(() => {
            const statement = db.prepare(CLASSIFY_MEMORY)
            let changed = 0
            for (const entry of entries) {
              if (!Number.isInteger(entry.id) || entry.id <= 0) continue
              // Same 1..100 clamp as writeMemory (storage-memory.ts:1132-1135),
              // so an out-of-range verdict can't skew m[0] ranking either side.
              const importance = Math.min(100, Math.max(1, Math.round(entry.importance)))
              changed += Number(statement.run(importance, classifiedAt, identity, entry.id).changes)
            }
            return { ok: true, changed }
          })
          return scored.ok ? scored.changed : 0
        } catch (error) {
          options.logger.warn(`magic-context memory: classifyMemories failed: ${errText(error)}`)
          return 0
        }
      },
      close: () => db.close(),
    }
  } catch (error) {
    try {
      db.close()
    } catch {
      /* best effort */
    }
    return unavailable(`probe failed (${errText(error)})`)
  }
}
