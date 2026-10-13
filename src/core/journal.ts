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
import { errText } from './types.ts'

export type JournalLevel = 'info' | 'warn' | 'error'

/** The canonical event kinds; the report tool groups by these. */
export type JournalKind =
  | 'boot'
  | 'config-drift'
  | 'session-first-seen'
  | 'pass'
  | 'drop-landed'
  | 'compartment-published'
  | 'compartment-recomp'
  | 'compartment-guard'
  | 'force-path'
  | 'memory-stats'
  | 'historian'
  | 'baseline'
  | 'emergency-reclaim'
  | 'wire-repair'
  | 'memory-recall'
  | 'profile-recall'
  | 'vector-lane'
  | 'search-hint'
  | 'memory-promote'
  | 'global-review'
  | 'maintenance'
  | 'session-notice'
  | 'project-drift'
  | 'context-pressure'
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
  /**
   * Mirrors every persisted entry as one line; errors here never throw. May be
   * a GETTER: volatile settings commits never remount the plugin, so the live
   * wrapper (dsh/live-journal.ts) hands a function here and an edit applies to
   * the very next write. Each distinct path is prepared (mkdir + rotate) once.
   */
  readonly mirrorPath?: string | (() => string | undefined)
  /**
   * Entries below this level are dropped entirely. Default 'info'. May be a
   * getter for the same reason as {@link mirrorPath}.
   */
  readonly level?: JournalLevel | (() => JournalLevel)
  /** Entries older than this are pruned when the journal opens. Default 30 days. */
  readonly retentionDays?: number
  /** Rotate the mirror once it exceeds this size. Default 5 MiB. */
  readonly mirrorMaxBytes?: number
  readonly logger?: JournalLogger
  readonly now?: () => number
}

/**
 * Close the historian runs a previous mount left open. An hmr remount (or an
 * app restart) disposes the stores while a run is in flight, so its `start`
 * row never gets a terminal sibling — indistinguishable from a wedged run and
 * a standing acceptance failure. At mount time no run of the NEW composition
 * can be in flight yet, so every still-open start predates this process and
 * gets exactly one synthetic terminal (`kind: 'adapter-remount'`). The audit
 * invariant — start + exactly one terminal — is restored, not rewritten:
 * the original start row stays untouched.
 *
 * @returns the number of recovered runs.
 */
export function recoverOrphanHistorianRuns(stores: JournalStore, journal: Journal): number {
  const recovered: Array<{ entry: JournalEntry; sessionId?: string }> = []
  try {
    const rows = stores.listJournal({ kinds: ['historian'], limit: 10_000 })
    // Pass 1: starts already banked by a previous mount carry
    // `recoveredStartAt` on their synthetic terminal. The markers sit at the
    // journal tail — after the historic rows they repair — so they must be
    // collected BEFORE pairing, or the supersede branch would re-report the
    // same historic double-start on every remount.
    const alreadyRecovered = new Set<string>()
    for (const row of rows) {
      const data = row.data as { phase?: unknown; recoveredStartAt?: unknown } | undefined
      if (data?.phase === 'failed' && typeof data.recoveredStartAt === 'number') {
        alreadyRecovered.add(`${row.sessionId ?? '-'}:${String(data.recoveredStartAt)}`)
      }
    }
    // Pass 2: the pairing scan (chronological).
    const open = new Map<string, JournalEntry>()
    for (const row of [...rows].reverse()) {
      const phase = (row.data as { phase?: unknown } | undefined)?.phase
      const key = row.sessionId ?? '-'
      if (phase === 'start') {
        // A second start in one session means the first was superseded while
        // still open — the pairing maps would silently overwrite it (the same
        // shape the acceptance audit counts as a silent evaporate), so the
        // superseded start is recovered right here.
        const previous = open.get(key)
        if (previous !== undefined && !alreadyRecovered.has(`${key}:${String(previous.at)}`)) {
          recovered.push({ entry: previous, sessionId: row.sessionId })
        }
        open.set(key, row)
      } else if (phase === 'done' || phase === 'failed') {
        open.delete(key)
      }
    }
    for (const [key, start] of open) {
      if (!alreadyRecovered.has(`${key}:${String(start.at)}`)) {
        recovered.push({ entry: start, sessionId: key === '-' ? undefined : key })
      }
    }
  } catch {
    return 0
  }
  let count = 0
  for (const { entry: start, sessionId } of recovered) {
    try {
      journal.error(
        'historian',
        'historian run failed (adapter-remount): a previous mount was disposed before this run finished',
        {
          phase: 'failed',
          kind: 'adapter-remount',
          reason: 'the adapter remounted (hmr or restart) while the run was in flight',
          recovered: true,
          recoveredStartAt: start.at,
        },
        sessionId,
      )
      count += 1
    } catch {
      /* a failing recovery must never block the mount */
    }
  }
  return count
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
  const retentionDays = options.retentionDays ?? 30
  const mirrorMaxBytes = options.mirrorMaxBytes ?? 5 * 1024 * 1024
  const resolveLevel = (): JournalLevel => {
    if (typeof options.level !== 'function') return options.level ?? 'info'
    return options.level() ?? 'info'
  }
  const resolveMirror = (): string | undefined => {
    const path = typeof options.mirrorPath === 'function' ? options.mirrorPath() : options.mirrorPath
    return typeof path === 'string' && path.length > 0 ? path : undefined
  }
  /** Each distinct mirror path is prepared (mkdir + rotate) exactly once. */
  const preparedMirrors = new Set<string>()
  const prepareMirror = (path: string): void => {
    if (preparedMirrors.has(path)) return
    preparedMirrors.add(path)
    try {
      mkdirSync(dirname(path), { recursive: true })
      rotateMirror(path, mirrorMaxBytes)
    } catch (error) {
      options.logger?.warn(
        `magic-context journal: mirror unavailable: ${errText(error)}`,
      )
    }
  }

  try {
    const pruned = options.stores.pruneJournal(now() - retentionDays * 24 * 60 * 60_000)
    if (pruned > 0) options.logger?.info(`magic-context journal: pruned ${String(pruned)} entries past retention`)
  } catch (error) {
    options.logger?.warn(
      `magic-context journal: retention prune failed: ${errText(error)}`,
    )
  }

  const write = (entry: JournalEntry): void => {
    try {
      options.stores.appendJournal(entry)
    } catch (error) {
      options.logger?.warn(
        `magic-context journal: write failed (${entry.kind}): ${errText(error)}`,
      )
    }
    const mirror = resolveMirror()
    if (mirror !== undefined) {
      prepareMirror(mirror)
      try {
        appendFileSync(mirror, formatJournalLine(entry))
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
    if (LEVEL_RANK[level] < LEVEL_RANK[resolveLevel()]) return
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
    /** Live: follows a getter-backed `mirrorPath` option without a reopen. */
    get mirrorPath() { return resolveMirror() },
  }
}
