/**
 * WP5 — the `user` domain's COLLECTION half: historian observations →
 * Magic Context's `user_memory_candidates`.
 *
 * Why a separate writer from `memory-write.ts`: candidates are not memories.
 * They are the staging pool a review pass later promotes into `user_memories`,
 * and MC keeps them in their own table with their own lifetime. Sharing the
 * memory writer's connection would couple two different fences (this one needs
 * the candidate table, the memory one needs `memories`), so it gets its own
 * open/probe/fence sequence — the same three steps, its own table.
 *
 * Deliberate properties, each with a reason:
 *
 *  - **fail-open.** A candidate that cannot be written is a missed opportunity,
 *    never a failure of the turn: the caller journals and continues. The
 *    compartment is already durable when this runs.
 *  - **fail-CLOSED on a newer contract.** If `context.db` is ahead of the
 *    version this adapter understands, the column layout of the candidate table
 *    is unknown, so the writer refuses instead of writing a guessed row. Same
 *    fence as `memory-write.ts`.
 *  - **the table is optional.** Older contracts (and every synthetic fixture
 *    that does not care about the profile lane) lack it; that is not an error,
 *    it is a lane that does not exist yet.
 *  - **no dedup across passes, dedup inside one.** MC's requirement for a
 *    promoted profile fact is cross-session RECURRENCE, so the same observation
 *    arriving in a later compartment is the evidence, not noise. Within a single
 *    batch a repeat is just the model saying the same thing twice.
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { MEMORY_SCHEMA_MAX_VERSION } from './memory-bridge.ts'
import { errText } from './types.ts'

/** Anything longer is truncated: a runaway observation must not become a row. */
export const MAX_OBSERVATION_CHARS = 600

export interface ProfileCandidateInput {
  readonly sessionId: string
  /** Raw historian observations; empty entries and duplicates are dropped here. */
  readonly observations: readonly string[]
  /** The compartment's covered range, when it has one (provenance for review). */
  readonly compartmentStart?: number | null
  readonly compartmentEnd?: number | null
}

export interface ProfileCandidateOutcome {
  readonly inserted: number
  /** Observations dropped by normalization (empty, duplicate, or not a string). */
  readonly skipped: number
}

/** One pending candidate, as the review pass reads it. */
export interface ProfileCandidateRow {
  readonly id: number
  readonly content: string
  readonly sessionId: string
  readonly compartmentStart: number | null
  readonly compartmentEnd: number | null
  readonly createdAt: number
}

/** One promoted profile row, as the render lane reads it (WP7/WP8). */
export interface ProfileRow {
  readonly id: number
  readonly content: string
  readonly promotedAt: number
  readonly sourceCandidateIds: readonly number[]
}

export interface ProfileWriter {
  readonly dbPath: string
  readonly status: { readonly ok: boolean; readonly detail?: string }
  recordCandidates(input: ProfileCandidateInput): ProfileCandidateOutcome
  /** Pending candidates, oldest first (the review pass reads a prefix). */
  listCandidates(limit: number): readonly ProfileCandidateRow[]
  countCandidates(): number
  /** TTL: drop candidates older than the cutoff. Returns how many were dropped. */
  expireCandidates(cutoffMs: number): number
  /** Consumption: drop exactly these candidate ids. Returns how many were dropped. */
  deleteCandidates(ids: readonly number[]): number
  /** The promoted profile, oldest first — the same order the render lane uses. */
  listActiveProfiles(): readonly ProfileRow[]
  /**
   * Retire a profile row — Magic Context's dismissal. The row is KEPT as
   * `status = 'dismissed'` rather than deleted: it is the record of what was
   * once injected into every session, and the audit trail would be gone with it.
   *
   * Returns whether a row actually changed state; an already-dismissed row
   * reports `false` instead of a successful no-op, so the caller can say so.
   */
  retireProfile(id: number, now: number): boolean
  /**
   * Promote one profile row. Returns its new id, or `undefined` when the write
   * did not happen (unavailable store), so the caller can tell "promoted" from
   * "silently dropped".
   */
  promoteProfile(input: {
    readonly content: string
    readonly candidateIds: readonly number[]
    readonly promotedAt: number
    readonly provenance?: string
  }): number | undefined
  close(): void
}

/**
 * Trim, drop empties and duplicates, and bound the length. Pure, so the rules
 * are testable without a database; the truncation is silent by design (a long
 * observation is still a useful candidate, just a bounded one) and the count of
 * what was dropped is reported to the caller for the journal.
 */
export function normalizeObservations(
  observations: readonly string[],
): { readonly kept: string[]; readonly skipped: number } {
  const kept: string[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const raw of observations) {
    if (typeof raw !== 'string') {
      skipped += 1
      continue
    }
    const trimmed = raw.trim()
    if (trimmed === '' || seen.has(trimmed)) {
      skipped += 1
      continue
    }
    seen.add(trimmed)
    kept.push(trimmed.length > MAX_OBSERVATION_CHARS ? trimmed.slice(0, MAX_OBSERVATION_CHARS) : trimmed)
  }
  return { kept, skipped }
}

export interface ProfileWriterOptions {
  readonly dbPath: string
  readonly logger: { info: (message: string) => void; warn: (message: string) => void }
  readonly now?: () => number
  readonly busyTimeoutMs?: number
}

const INSERT_CANDIDATE = `
  INSERT INTO user_memory_candidates(
    content, session_id, source_compartment_start, source_compartment_end, created_at
  ) VALUES(?, ?, ?, ?, ?)
`

const SELECT_CANDIDATES = `
  SELECT id, content, session_id AS sessionId,
         source_compartment_start AS compartmentStart,
         source_compartment_end AS compartmentEnd,
         created_at AS createdAt
    FROM user_memory_candidates
   ORDER BY created_at ASC, id ASC
   LIMIT ?
`

/**
 * Promotion (WP7). `status` is written explicitly rather than left to the
 * column default: the render lane reads `status = 'active'`, and a profile row
 * that arrives with any other value would be invisible while looking written.
 */
const INSERT_PROFILE = `
  INSERT INTO user_memories(
    content, status, promoted_at, source_candidate_ids, created_at, updated_at,
    source_candidate_provenance
  ) VALUES(?, 'active', ?, ?, ?, ?, ?)
`

const SELECT_PROFILES = `
  SELECT id, content, promoted_at AS promotedAt,
         source_candidate_ids AS sourceCandidateIds
    FROM user_memories
   WHERE status = 'active'
   ORDER BY promoted_at ASC, id ASC
`

export function openProfileWriter(options: ProfileWriterOptions): ProfileWriter {
  const now = options.now ?? Date.now
  const unavailable = (detail: string): ProfileWriter => {
    options.logger.warn(`magic-context profile writer disabled: ${detail} (${options.dbPath})`)
    return {
      dbPath: options.dbPath,
      status: { ok: false, detail },
      recordCandidates: () => ({ inserted: 0, skipped: 0 }),
      listCandidates: () => [],
      countCandidates: () => 0,
      expireCandidates: () => 0,
      deleteCandidates: () => 0,
      listActiveProfiles: () => [],
      retireProfile: () => false,
      promoteProfile: () => undefined,
      close: () => undefined,
    }
  }
  if (!existsSync(options.dbPath)) return unavailable('database not found')

  let db: DatabaseSync
  try {
    db = new DatabaseSync(options.dbPath)
    // Same order as the memory writer (contract §10.1): the busy timeout must
    // precede WAL, because acquiring the mode itself can need the lock.
    db.exec(`PRAGMA busy_timeout = ${String(options.busyTimeoutMs ?? 5_000)}`)
    db.exec('PRAGMA journal_mode = WAL')
  } catch (error) {
    return unavailable(`cannot open (${errText(error)})`)
  }

  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(row => row.name),
    )
    if (!tables.has('user_memory_candidates')) {
      db.close()
      return unavailable('user_memory_candidates table missing')
    }
    const row = db.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations WHERE version < 10000',
    ).get() as { version: number | null } | undefined
    const version = row?.version ?? null
    if (version !== null && version > MEMORY_SCHEMA_MAX_VERSION) {
      db.close()
      return unavailable(
        `corpus version ${String(version)} is newer than this adapter understands (${String(MEMORY_SCHEMA_MAX_VERSION)})`,
      )
    }
  } catch (error) {
    db.close()
    return unavailable(`contract probe failed (${errText(error)})`)
  }

  const insert = db.prepare(INSERT_CANDIDATE)
  const selectCandidates = db.prepare(SELECT_CANDIDATES)
  const countCandidates = db.prepare('SELECT COUNT(*) AS c FROM user_memory_candidates')
  const deleteCandidate = db.prepare('DELETE FROM user_memory_candidates WHERE id = ?')
  const expireCandidates = db.prepare('DELETE FROM user_memory_candidates WHERE created_at < ?')
  const insertProfile = db.prepare(INSERT_PROFILE)
  const selectProfiles = db.prepare(SELECT_PROFILES)
  const retireProfileStatement = db.prepare(
    "UPDATE user_memories SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'active'",
  )

  /** Run `fn` inside BEGIN IMMEDIATE, rolling back on any throw. */
  const inTransaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* the transaction may already be gone */
      }
      throw error
    }
  }

  return {
    dbPath: options.dbPath,
    status: { ok: true },
    recordCandidates: (input) => {
      const { kept, skipped } = normalizeObservations(input.observations)
      if (kept.length === 0) return { inserted: 0, skipped }
      const timestamp = now()
      const start = input.compartmentStart ?? null
      const end = input.compartmentEnd ?? null
      try {
        inTransaction(() => {
          for (const content of kept) {
            insert.run(content, input.sessionId, start, end, timestamp)
          }
        })
        return { inserted: kept.length, skipped }
      } catch (error) {
        options.logger.warn(
          `magic-context profile candidate write failed: ${errText(error)}`,
        )
        return { inserted: 0, skipped }
      }
    },
    listCandidates: (limit) => {
      if (!Number.isFinite(limit) || limit <= 0) return []
      try {
        return selectCandidates.all(limit) as unknown as ProfileCandidateRow[]
      } catch (error) {
        options.logger.warn(`magic-context profile candidate read failed: ${errText(error)}`)
        return []
      }
    },
    countCandidates: () => {
      try {
        return (countCandidates.get() as { c: number } | undefined)?.c ?? 0
      } catch {
        return 0
      }
    },
    expireCandidates: (cutoffMs) => {
      try {
        return Number(expireCandidates.run(cutoffMs).changes)
      } catch (error) {
        options.logger.warn(`magic-context profile candidate expiry failed: ${errText(error)}`)
        return 0
      }
    },
    deleteCandidates: (ids) => {
      if (ids.length === 0) return 0
      try {
        return inTransaction(() => {
          let removed = 0
          for (const id of ids) removed += Number(deleteCandidate.run(id).changes)
          return removed
        })
      } catch (error) {
        options.logger.warn(`magic-context profile candidate consumption failed: ${errText(error)}`)
        return 0
      }
    },
    listActiveProfiles: () => {
      try {
        return (selectProfiles.all() as unknown as Array<{
          id: number
          content: string
          promotedAt: number
          sourceCandidateIds: string | null
        }>).map((row) => {
          let ids: number[] = []
          try {
            const parsed: unknown = JSON.parse(row.sourceCandidateIds ?? '[]')
            if (Array.isArray(parsed)) ids = parsed.filter((id): id is number => typeof id === 'number')
          } catch {
            // A malformed provenance list is not worth failing a read over.
          }
          return { id: row.id, content: row.content, promotedAt: row.promotedAt, sourceCandidateIds: ids }
        })
      } catch (error) {
        options.logger.warn(`magic-context profile read failed: ${errText(error)}`)
        return []
      }
    },
    retireProfile: (id, nowMs) => {
      try {
        return Number(retireProfileStatement.run(nowMs, id).changes) === 1
      } catch (error) {
        options.logger.warn(`magic-context profile retirement failed: ${errText(error)}`)
        return false
      }
    },
    promoteProfile: (input) => {
      const content = input.content.trim()
      if (content === '') return undefined
      const timestamp = now()
      try {
        return inTransaction(() => {
          const result = insertProfile.run(
            content,
            input.promotedAt,
            JSON.stringify([...input.candidateIds]),
            timestamp,
            timestamp,
            input.provenance ?? null,
          )
          return Number(result.lastInsertRowid)
        })
      } catch (error) {
        options.logger.warn(`magic-context profile promotion failed: ${errText(error)}`)
        return undefined
      }
    },
    close: () => {
      db.close()
    },
  }
}
