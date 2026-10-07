/**
 * The activity journal — the adapter's observability layer for the validation
 * period.
 *
 * Why it exists: the harness's `ctx.logger` output is not persisted by the
 * Desktop application (there is no plugin log file to inspect afterwards), and
 * the adapter's other tables hold *state*, not *history* — they can say what is
 * true now, never why a pass deferred or what a request cost. The journal is an
 * append-only record of decisions and outcomes, written to the adapter's own
 * SQLite database next to that state, plus an optional human-readable mirror
 * file for `tail`/grep.
 *
 * Privacy and size discipline: message text is NEVER recorded. Call sites pass
 * counts, tag numbers, token estimates, reasons and durations; every string is
 * truncated and every array capped by {@link redactData}, so a long session
 * cannot bloat the store.
 *
 * The review side lives in `scripts/mc-report.mjs`, which reads this table
 * read-only and prints per-day rollups, key metrics and health hints.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type JournalLevel = 'info' | 'warn' | 'error'

/** The canonical event kinds; the report tool groups by these. */
export type JournalKind =
  | 'boot'
  | 'session-first-seen'
  | 'pass'
  | 'drop-landed'
  | 'compartment-published'
  | 'historian'
  | 'baseline'
  | 'emergency-reclaim'
  | 'memory-recall'
  | 'memory-write'
  | 'memory-promote'
  | 'session-notice'
  | 'tool-call'
  | 'engine'
  | 'error'

export interface JournalEntry {
  readonly at: number
  readonly level: JournalLevel
  readonly kind: JournalKind
  readonly sessionId?: string
  readonly summary: string
  readonly data?: Record<string, unknown>
}

/** The store slice the journal needs (keeps this module dependency-free). */
export interface JournalStore {
  appendJournal(entry: JournalEntry): void
  listJournal(filter?: {
    since?: number
    until?: number
    sessionId?: string
    kinds?: readonly JournalKind[]
    levels?: readonly JournalLevel[]
    limit?: number
  }): JournalEntry[]
  /** Kind/level counts since a timestamp, optionally for one Session. */
  journalByKind(since?: number, sessionId?: string): Array<{ kind: string; level: JournalLevel; count: number }>
  pruneJournal(before: number): number
  journalBounds(): { rows: number; oldest?: number; newest?: number }
}

export interface JournalLogger {
  info(message: string): void
  warn(message: string): void
}

export interface JournalOptions {
  readonly stores: JournalStore
  /** Mirrors every persisted entry as one line; errors here never throw. */
  readonly mirrorPath?: string
  /** Entries below this level are dropped entirely. Default 'info'. */
  readonly level?: JournalLevel
  /** Entries older than this are pruned when the journal opens. Default 30 days. */
  readonly retentionDays?: number
  /** Rotate the mirror once it exceeds this size. Default 5 MiB. */
  readonly mirrorMaxBytes?: number
  readonly logger?: JournalLogger
  readonly now?: () => number
}

export interface Journal {
  readonly enabled: boolean
  record(level: JournalLevel, kind: JournalKind, summary: string, data?: Record<string, unknown>, sessionId?: string): void
  info(kind: JournalKind, summary: string, data?: Record<string, unknown>, sessionId?: string): void
  warn(kind: JournalKind, summary: string, data?: Record<string, unknown>, sessionId?: string): void
  error(kind: JournalKind, summary: string, data?: Record<string, unknown>, sessionId?: string): void
  /** Bounded, redacted journal tail (for /ctx-status and tests). */
  tail(limit?: number, sessionId?: string): JournalEntry[]
  /** Kind counts since a timestamp (for /ctx-status rollups). */
  byKind(since?: number): Array<{ kind: string; level: JournalLevel; count: number }>
  readonly mirrorPath?: string
}

const LEVEL_RANK: Record<JournalLevel, number> = { info: 0, warn: 1, error: 2 }

const MAX_STRING = 300
const MAX_ARRAY = 20
const MAX_DEPTH = 3

/**
 * Bound one entry's structured payload: truncate long strings, cap arrays,
 * limit nesting. Message content must never be passed here in the first place;
 * this is the safety net that keeps a slip from bloating the store.
 */
export function redactData(
  value: unknown,
  depth = 0,
): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…(${String(value.length)} chars)`
  }
  if (value === undefined) return undefined
  if (depth >= MAX_DEPTH) return '[depth]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map(item => redactData(item, depth + 1))
    return value.length > MAX_ARRAY ? [...items, `…(${String(value.length)} items)`] : items
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    let index = 0
    for (const [key, item] of Object.entries(source)) {
      if (index >= MAX_ARRAY) {
        result['…'] = 'more keys omitted'
        break
      }
      if (item === undefined) continue
      result[key] = redactData(item, depth + 1)
      index += 1
    }
    return result
  }
  return String(value)
}

/** One mirror line: `ISO LEVEL kind [session] summary {json}`. */
export function formatJournalLine(entry: JournalEntry): string {
  const iso = new Date(entry.at).toISOString()
  const session = entry.sessionId === undefined ? '' : ` ${entry.sessionId.slice(0, 12)}`
  const data = entry.data === undefined || Object.keys(entry.data).length === 0
    ? ''
    : ` ${JSON.stringify(entry.data)}`
  return `${iso} ${entry.level.toUpperCase().padEnd(5)} ${entry.kind}${session} ${entry.summary}${data}\n`
}

/** Rotate the mirror once at open so it cannot grow without bound. */
function rotateMirror(path: string, maxBytes: number): void {
  try {
    const size = statSync(path).size
    if (size > maxBytes) renameSync(path, `${path}.1`)
  } catch {
    /* missing file is the normal first-open case */
  }
}

/**
 * Open the journal. Pruning and mirror rotation happen once here; every later
 * write is a single small insert. Journal failures never propagate: they are
 * reported through the harness logger and the adapter keeps working (the
 * journal must not be able to break a turn).
 */
export function openJournal(options: JournalOptions): Journal {
  const now = options.now ?? (() => Date.now())
  const threshold = LEVEL_RANK[options.level ?? 'info']
  const retentionDays = options.retentionDays ?? 30
  const mirrorMaxBytes = options.mirrorMaxBytes ?? 5 * 1024 * 1024

  try {
    const pruned = options.stores.pruneJournal(now() - retentionDays * 24 * 60 * 60_000)
    if (pruned > 0) options.logger?.info(`magic-context journal: pruned ${String(pruned)} entries past retention`)
  } catch (error) {
    options.logger?.warn(
      `magic-context journal: retention prune failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (options.mirrorPath !== undefined) {
    try {
      mkdirSync(dirname(options.mirrorPath), { recursive: true })
      rotateMirror(options.mirrorPath, mirrorMaxBytes)
    } catch (error) {
      options.logger?.warn(
        `magic-context journal: mirror unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const write = (entry: JournalEntry): void => {
    try {
      options.stores.appendJournal(entry)
    } catch (error) {
      options.logger?.warn(
        `magic-context journal: write failed (${entry.kind}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (options.mirrorPath !== undefined) {
      try {
        appendFileSync(options.mirrorPath, formatJournalLine(entry))
      } catch {
        /* the mirror is a convenience; the database is authoritative */
      }
    }
  }

  const record = (
    level: JournalLevel,
    kind: JournalKind,
    summary: string,
    data?: Record<string, unknown>,
    sessionId?: string,
  ): void => {
    if (LEVEL_RANK[level] < threshold) return
    const entry: JournalEntry = {
      at: now(),
      level,
      kind,
      summary,
      ...sessionId === undefined ? {} : { sessionId },
      ...data === undefined ? {} : { data: redactData(data) as Record<string, unknown> },
    }
    write(entry)
    if (level === 'error') options.logger?.warn(`magic-context [${kind}] ${summary}`)
  }

  return {
    enabled: true,
    record,
    info: (kind, summary, data, sessionId) => record('info', kind, summary, data, sessionId),
    warn: (kind, summary, data, sessionId) => record('warn', kind, summary, data, sessionId),
    error: (kind, summary, data, sessionId) => record('error', kind, summary, data, sessionId),
    tail: (limit = 50, sessionId) => options.stores.listJournal({
      limit,
      ...sessionId === undefined ? {} : { sessionId },
    }),
    byKind: since => options.stores.journalByKind(since),
    ...options.mirrorPath === undefined ? {} : { mirrorPath: options.mirrorPath },
  }
}
