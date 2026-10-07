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
 *    `maxMemoryId` watermark in m[1], never by rebuilding m[0];
 *  - module-managed projects (`authority_managed`) are never written directly.
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
 * `memory_mutation_log` deltas for `update`/`archive`/`superseded`, the §4.5
 * clear-on-content-change invariants, and the §8.4 authority guard hardened
 * with the `context_privilege_state` probe. It never bumps
 * `project_memory_epoch` (contract §5.2: in-session mutations route through
 * m[1]) and never touches `context_privilege_state`, FTS or the embedding
 * tables beyond invalidation.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { MEMORY_SCHEMA_MAX_VERSION, normalizeMemoryContent } from './memory-bridge.ts'
import { V2_MEMORY_CATEGORIES, isPromotableCategory, resolveExpiresAt } from './memory-categories.ts'

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
  /** Whether the project is module-managed and was therefore left untouched. */
  readonly authorityBlocked: boolean
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
  /** The project is module-managed; the TS write path yields (contract §8.4). */
  | 'authority-blocked'
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
  | 'contract-version-unsupported'
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
  readonly contractVersion?: number
  /**
   * True when `contractVersion > MEMORY_SCHEMA_MAX_VERSION`: every write is
   * refused with `contract-version-unsupported`, reads keep working.
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
 * correctness (contract §9.1): a fenced/authority-blocked/database failure is
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

export interface MemoryWriter {
  readonly dbPath: string
  readonly status: MemoryWriterStatus
  /** Promote historian facts for one project (idempotent, append-only). */
  promoteFacts(input: {
    readonly identity: string
    readonly facts: readonly MemoryFact[]
    readonly sessionId?: string
  }): PromoteOutcome
  /** Highest memory id visible to a project (0 when it has none). */
  maxMemoryId(identity: string): number
  /** True when Magic Context's module authority owns this project's memories. */
  isAuthorityManaged(identity: string): boolean
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
   * keeps the mutation log and authority guard in the loop.
   */
  listExpired(identity: string, now: number, limit?: number): readonly number[]
  /**
   * Maintenance: bank per-memory `verified_at` for rows the verifier judged
   * still-true (MC dreamer verify: per-memory verified_at, no global
   * watermark; metadata only — no mutation log, no content change).
   */
  markVerified(identity: string, ids: readonly number[], verifiedAt: number): number
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

/** `list` (§11.6): injectable rows of one project, in MC's render order. */
const LIST_MEMORIES = `
  SELECT ${MEMORY_SELECT_COLUMNS} FROM memories
   WHERE project_path = ? AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?)
   ORDER BY category ASC, updated_at DESC, id ASC
`

/** The trigger's RAISE text (§8.4) — the database-level second gate. */
const AUTHORITY_ABORT_TEXT = 'context.db memory writes are managed by the Rust module'

/** MC's `ModuleMemoryAuthorityError` text (§8.4), reused for the pre-write yield. */
function authorityYieldDetail(identity: string): string {
  return `memory writes for module-managed project ${identity} must use the Rust ctx_memory module facade`
}

/** True when SQLite aborted the statement through the authority guard trigger. */
function isAuthorityAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(AUTHORITY_ABORT_TEXT)
}

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
 * Open the shared memory database read-write. Missing file / newer schema /
 * authority problems disable writing with a warning instead of throwing: the
 * adapter must never break a turn because memory is unavailable.
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
        authorityBlocked: true,
      }),
      maxMemoryId: () => 0,
      isAuthorityManaged: () => true,
      stats: () => ({ rows: 0, mutationLog: 0, epoch: 0 }),
      writeMemory: () => refused,
      updateMemory: () => refused,
      archiveMemory: () => refused,
      mergeMemory: () => refused,
      getMemory: () => undefined,
      listMemories: () => [],
      listExpired: () => [],
      markVerified: () => 0,
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
    return unavailable(`cannot open (${error instanceof Error ? error.message : String(error)})`)
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
    const hasAuthority = tables.has('authority_managed') || tables.has('authority_repair_pending')

    // Contract fence: MC's storage version, read exactly like the bridge reads
    // it (main lane `version < 10000`). A NEWER database downgrades this writer
    // to read-only — the adapter must not write rows a storage layer it does
    // not understand may interpret differently. An absent table means a legacy
    // or trimmed database, which keeps today's (unfenced) behaviour.
    const contractVersion = (() => {
      if (!tables.has('schema_migrations')) return undefined
      try {
        const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE version < 10000')
          .get() as { version: number | null } | undefined
        return row?.version ?? undefined
      } catch {
        return undefined
      }
    })()
    const contractFenced = contractVersion !== undefined && contractVersion > MEMORY_SCHEMA_MAX_VERSION
    if (contractFenced) {
      options.logger.warn(
        `magic-context memory: contract v${String(contractVersion)} is newer than the adapter understands `
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
    const maxId = db.prepare('SELECT MAX(id) AS id FROM memories WHERE project_path = ?')
    const authorityManaged = hasAuthority
      ? db.prepare(
        `SELECT 1 AS hit FROM authority_managed WHERE project_path = ?
         UNION ALL SELECT 1 AS hit FROM authority_repair_pending WHERE project_path = ?
         LIMIT 1`,
      )
      : undefined
    const statsRows = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE project_path = ?')
    const statsMutations = db.prepare('SELECT COUNT(*) AS c FROM memory_mutation_log WHERE project_path = ?')
    const statsEpoch = db.prepare('SELECT project_memory_epoch AS e FROM project_state WHERE project_path = ?')
    // Verification coverage for the telemetry panel: the dreamer slice's own KPI.
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
    const appendMutation = db.prepare(APPEND_MUTATION)
    const listMemoriesAll = db.prepare(LIST_MEMORIES)
    const listMemoriesLimited = db.prepare(`${LIST_MEMORIES} LIMIT ?`)
    // The guard's second half: sees whether the trigger is armed. The privileged
    // writer flips this inside its own IMMEDIATE transaction, so a second
    // connection can only ever observe `enabled = 0` (contract §8.4).
    const privilegeState = tables.has('context_privilege_state')
      ? db.prepare('SELECT enabled FROM context_privilege_state WHERE id = 1')
      : undefined
    // Content changes invalidate the classify/verify artefacts (§4.5). Both
    // tables are absent on trimmed databases, hence the table guard.
    const deleteEmbeddings = tables.has('memory_embeddings')
      ? db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?')
      : undefined
    const deleteVerifications = tables.has('memory_verifications')
      ? db.prepare('DELETE FROM memory_verifications WHERE memory_id = ?')
      : undefined

    const isAuthorityManaged = (identity: string): boolean => {
      if (authorityManaged === undefined) return false
      try {
        return authorityManaged.get(identity, identity) !== undefined
      } catch {
        // A malformed/absent authority schema must not block a normal write.
        return false
      }
    }
    const maxFor = (identity: string): number => {
      const row = maxId.get(identity) as { id: number | null } | undefined
      return row?.id ?? 0
    }

    /**
     * The trigger's `WHEN` clause, probed on the connection: managed/repair-
     * pending is necessary, `COALESCE(enabled, 0) = 0` is what actually arms the
     * abort. We never write `context_privilege_state` to change the answer.
     */
    const privilegeWindowOpen = (): boolean => {
      if (privilegeState === undefined) return false
      try {
        const row = privilegeState.get() as { enabled: number } | undefined
        return (row?.enabled ?? 0) !== 0
      } catch {
        return false
      }
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
      const detail = error instanceof Error ? error.message : String(error)
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
      'contract-version-unsupported',
      `Magic Context schema v${String(contractVersion)} is newer than the adapter understands `
        + `(v${String(MEMORY_SCHEMA_MAX_VERSION)}); the memory write path is READ-ONLY. `
        + 'Update the adapter before writing.',
    )

    /**
     * The §8.4 pre-write yield. A managed project is never written from the TS
     * path — even if the privilege window is open, because that window belongs
     * to the Rust module's own transaction protocol.
     */
    const authorityYield = (identity: string): MemoryWriteFailure | undefined => {
      if (!isAuthorityManaged(identity)) return undefined
      const armed = !privilegeWindowOpen()
      options.logger.warn(
        `magic-context memory: ${identity} is module-managed (context_privilege_state guard ${armed ? 'armed' : 'disarmed'}); the TypeScript write path yields`,
      )
      return { ok: false, reason: 'authority-blocked', detail: authorityYieldDetail(identity) }
    }

    /**
     * `BEGIN IMMEDIATE` (contract §10.2): a read-then-write must take the write
     * lock up front, and SQLite does not honour `busy_timeout` while upgrading.
     * An authority ABORT raised between our probe and the write is converted to
     * a refusal — the trigger winning the race is a "yield", not a crash.
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
        if (isAuthorityAbort(error)) {
          options.logger.warn(
            `magic-context memory: the authority guard refused the write (${AUTHORITY_ABORT_TEXT})`,
          )
          return { ok: false, reason: 'authority-blocked', detail: AUTHORITY_ABORT_TEXT }
        }
        throw error
      }
    }

    const writerStatus: MemoryWriterStatus = contractFenced
      ? {
        ok: true,
        readOnly: true,
        detail: `Magic Context schema v${String(contractVersion)} is newer than the adapter understands `
          + `(v${String(MEMORY_SCHEMA_MAX_VERSION)}); the memory write path is READ-ONLY.`,
        ...(contractVersion === undefined ? {} : { contractVersion }),
      }
      : { ok: true, ...(contractVersion === undefined ? {} : { contractVersion }) }

    return {
      dbPath: options.dbPath,
      status: writerStatus,
      isAuthorityManaged,
      maxMemoryId: identity => {
        try {
          return maxFor(identity)
        } catch {
          return 0
        }
      },
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
          authorityBlocked: false,
        }
        if (contractFenced) {
          options.logger.warn(
            `magic-context memory: promotion refused, schema v${String(contractVersion)} is newer than `
              + `the adapter understands (v${String(MEMORY_SCHEMA_MAX_VERSION)})`,
          )
          return { ...outcomeBase, authorityBlocked: true, maxMemoryId: maxFor(input.identity) }
        }
        if (isAuthorityManaged(input.identity)) {
          options.logger.info(
            `magic-context memory: ${input.identity} is module-managed; promotion skipped`,
          )
          return { ...outcomeBase, authorityBlocked: true, maxMemoryId: maxFor(input.identity) }
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
        if (contractFenced) return fenceRefusal('write')
        const blocked = authorityYield(input.identity)
        if (blocked !== undefined) return blocked
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
            const result = insertAgentMemory.run(
              input.identity,
              category,
              input.content,
              hash,
              input.importance ?? 50,
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
        if (contractFenced) return fenceRefusal('update')
        const blocked = authorityYield(input.identity)
        if (blocked !== undefined) return blocked
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
        if (contractFenced) return fenceRefusal('archive')
        const blocked = authorityYield(input.identity)
        if (blocked !== undefined) return blocked
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
        if (contractFenced) return fenceRefusal('merge')
        const blocked = authorityYield(input.identity)
        if (blocked !== undefined) return blocked
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
          if (limit !== undefined) {
            if (!Number.isInteger(limit) || limit <= 0) return []
            return asMemoryRecords(listMemoriesLimited.all(identity, cutoff, limit))
          }
          return asMemoryRecords(listMemoriesAll.all(identity, cutoff))
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
        if (contractFenced) {
          options.logger.warn(
            `magic-context memory: retrieval telemetry refused, schema v${String(contractVersion)} is newer `
              + `than the adapter understands (v${String(MEMORY_SCHEMA_MAX_VERSION)})`,
          )
          return { ok: false, recorded, skipped: requested, reason: 'contract-version-unsupported' }
        }
        if (isAuthorityManaged(input.identity)) {
          return { ok: false, recorded, skipped: requested, reason: 'authority-blocked' }
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
          const detail = error instanceof Error ? error.message : String(error)
          options.logger.warn(`magic-context memory: retrieval telemetry failed: ${detail}`)
          return { ok: false, recorded, skipped: skipped(), reason: 'database-error' }
        }
      },
      listExpired: (identity, nowAt, limit = 200) => {
        try {
          if (contractFenced) return []
          const rows = db.prepare(
            `SELECT id FROM memories`
            + ` WHERE project_path = ? AND status IN ('active','permanent')`
            + ` AND expires_at IS NOT NULL AND expires_at <= ?`
            + ` ORDER BY id ASC LIMIT ?`,
          ).all(identity, nowAt, Math.max(1, Math.min(500, limit))) as Array<{ id: number }>
          return rows.map(row => row.id)
        } catch (error) {
          options.logger.warn(`magic-context memory: listExpired failed: ${error instanceof Error ? error.message : String(error)}`)
          return []
        }
      },
      markVerified: (identity, ids, verifiedAt) => {
        if (ids.length === 0) return 0
        try {
          if (contractFenced) return 0
          if (isAuthorityManaged(identity)) return 0
          const stamp = runImmediate<{ ok: true; changed: number }>(() => {
            const statement = db.prepare(
              `UPDATE memories SET verified_at = ? WHERE project_path = ? AND id = ?`
                + ` AND status IN ('active','permanent')`,
            )
            let changed = 0
            for (const id of ids) {
              changed += statement.run(verifiedAt, identity, id).changes
            }
            return { ok: true, changed }
          })
          return stamp.ok ? stamp.changed : 0
        } catch (error) {
          options.logger.warn(`magic-context memory: markVerified failed: ${error instanceof Error ? error.message : String(error)}`)
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
    return unavailable(`probe failed (${error instanceof Error ? error.message : String(error)})`)
  }
}
