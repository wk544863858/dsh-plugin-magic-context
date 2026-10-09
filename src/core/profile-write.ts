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

export interface ProfileWriter {
  readonly dbPath: string
  readonly status: { readonly ok: boolean; readonly detail?: string }
  recordCandidates(input: ProfileCandidateInput): ProfileCandidateOutcome
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

export function openProfileWriter(options: ProfileWriterOptions): ProfileWriter {
  const now = options.now ?? Date.now
  const unavailable = (detail: string): ProfileWriter => {
    options.logger.warn(`magic-context profile writer disabled: ${detail} (${options.dbPath})`)
    return {
      dbPath: options.dbPath,
      status: { ok: false, detail },
      recordCandidates: () => ({ inserted: 0, skipped: 0 }),
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
        `contract version ${String(version)} is newer than this adapter understands (${String(MEMORY_SCHEMA_MAX_VERSION)})`,
      )
    }
  } catch (error) {
    db.close()
    return unavailable(`contract probe failed (${errText(error)})`)
  }

  const insert = db.prepare(INSERT_CANDIDATE)
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
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const content of kept) {
            insert.run(content, input.sessionId, start, end, timestamp)
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
        return { inserted: kept.length, skipped }
      } catch (error) {
        options.logger.warn(
          `magic-context profile candidate write failed: ${errText(error)}`,
        )
        return { inserted: 0, skipped }
      }
    },
    close: () => {
      db.close()
    },
  }
}
