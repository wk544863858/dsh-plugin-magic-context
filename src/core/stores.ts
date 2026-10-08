/**
 * The adapter's own SQLite stores, on `node:sqlite` (no native addons: the
 * DSH desktop host is an Electron RunAsNode process where ABI-compiled
 * modules are not portable; node:sqlite is built in on Node >= 22.19).
 *
 * Schema discipline mirrors Magic Context's storage layer: a version fence
 * that fails closed when the database is newer than this build knows, and a
 * forward-only migration chain. The eventual Phase 1+ plan moves these rows
 * into the shared `context.db` (harness='dsh') — the store interface below
 * is deliberately shaped so that move is a backend swap, not a redesign.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Compartment, CompartmentDraft } from './compartments.ts'
import type { JournalEntry, JournalKind, JournalLevel } from './journal.ts'
import type { MemoryFact } from './memory-categories.ts'
import type { TagRecord, TagTarget, UsageRecord } from './types.ts'

export const SCHEMA_VERSION = 6

/** The m[0]/m[1] baseline identity for one session. */
export interface BaselineState {
  readonly sessionId: string
  /** Bumped on every HARD rebuild (m[0] frozen again). */
  readonly epoch: number
  /** The surface node carrying the composed baseline, once one landed. */
  readonly nodeSeq?: number
  /** The routed provider/model the baseline was built for (route change ⇒ HARD). */
  readonly provider?: string
  readonly model?: string
  /** Timestamp of the last HARD rebuild; m[1] holds compartments newer than this. */
  readonly frozenAt: number
  /** Identity of the injected project-memory digest (change ⇒ HARD). */
  readonly memoriesDigest?: string
  /**
   * Magic Context's additive-memory watermark: memories with `id` above it are
   * rendered in m[1] (`<new-memories>`) instead of m[0], so a new memory never
   * rebuilds the cached prefix. Frozen at every HARD rebuild.
   */
  readonly maxMemoryId?: number
  /**
   * Magic Context's mutation-log watermark (its
   * `session_meta.cached_m0_max_memory_mutation_id`): the highest
   * `memory_mutation_log.id` folded into m[0]. Rows above it render in m[1]
   * `<memory-updates>`; a HARD rebuild advances it, so the deltas disappear
   * once they are baked into the frozen prefix (contract §5.3, §7.5).
   */
  readonly maxMemoryMutationId?: number
  /**
   * The project's `project_state.project_memory_epoch` identity (a fingerprint
   * over the project and its workspace peers). A change means an external
   * writer moved the memory epoch, so the m[0] snapshot AND the mutation
   * cursor are invalid: the pass rebuilds hard and re-freezes both.
   */
  readonly projectEpochFingerprint?: string
  readonly updatedAt: number
}

export interface AdapterStores {
  readonly dbPath: string
  /** Fails closed (returns null) when the persisted version is ahead. */
  allocateTag(sessionId: string, target: TagTarget, now: number): number
  getTag(sessionId: string, target: TagTarget): number | undefined
  listTags(sessionId: string): TagRecord[]
  recordUsage(record: UsageRecord): void
  listUsage(sessionId: string): UsageRecord[]
  /** Newest usage row by seq, or undefined before the first response. */
  latestUsage(sessionId: string): UsageRecord | undefined
  queueDrop(sessionId: string, tagNumber: number, now: number): void
  /** Pending (not yet landed) drop tag numbers, oldest first. */
  listPendingDrops(sessionId: string): number[]
  markDropLanded(sessionId: string, tagNumber: number, landedEventSeq: number): void
  /** Store one validated historian digest for a covered span. */
  allocateCompartment(
    sessionId: string,
    draft: CompartmentDraft,
    covered: { startSeq: number; endSeq: number; seqs: readonly number[]; tokens: number },
    baselineEpoch: number,
    now: number,
  ): Compartment
  listCompartments(sessionId: string): Compartment[]
  /** Compartments whose reclaim placeholder has not landed yet. */
  listUnlandedCompartments(sessionId: string): Compartment[]
  markCompartmentLanded(sessionId: string, compartmentId: number, landedEventSeq: number): void
  /**
   * Replace a stored compartment's DIGEST (tiers, importance, facts, events)
   * while keeping its identity, coverage and landed placeholder. The recomp lane
   * re-digests history that already left the surface, so no row may be re-added:
   * only the text the model sees changes.
   */
  replaceCompartmentDraft(sessionId: string, compartmentId: number, draft: CompartmentDraft): void
  /** Every surface seq already digested by a compartment (historian eligibility). */
  coveredSeqs(sessionId: string): Set<number>
  baselineState(sessionId: string): BaselineState | undefined
  saveBaselineState(state: BaselineState): void
  /** Free-form diagnostics written by the composition root (observable facts). */
  setMeta(key: string, value: string): void
  getMeta(key: string): string | undefined
  /** Append one activity-journal entry (the validation-period audit trail). */
  appendJournal(entry: JournalEntry): void
  /** Newest-first journal query; every filter is optional. */
  listJournal(filter?: {
    since?: number
    until?: number
    sessionId?: string
    kinds?: readonly JournalKind[]
    levels?: readonly JournalLevel[]
    limit?: number
  }): JournalEntry[]
  /**
   * Kind/level counts since a timestamp (journal rollups).
   * @param since - count entries at or after this time; every entry when omitted.
   * @param sessionId - restrict the rollup to one Session; every Session when omitted.
   */
  journalByKind(since?: number, sessionId?: string): Array<{ kind: string; level: JournalLevel; count: number }>
  /** Delete entries older than the cutoff; returns the number removed. */
  pruneJournal(before: number): number
  /** Row count plus the oldest/newest timestamps. */
  journalBounds(): { rows: number; oldest?: number; newest?: number }
  close(): void
  /**
   * True once `close()` ran. A remounted adapter (hmr reload) closes the old
   * composition's stores while a stale engine or in-flight caller may still
   * hold the old object — the flag lets those callers no-op instead of dying
   * on `database is not open`.
   */
  readonly closed: boolean
}

export function defaultDataDir(): string {
  return join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc')
}

interface Migration {
  readonly version: number
  readonly up: (db: DatabaseSync) => void
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE meta(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE tags(
          session_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          tag_number INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, target_kind, target_id)
        );
        CREATE TABLE tag_counters(
          session_id TEXT PRIMARY KEY,
          next_tag INTEGER NOT NULL
        );
        CREATE TABLE usage_records(
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          turn INTEGER NOT NULL,
          step INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          recorded_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, seq)
        );
      `)
    },
  },
  {
    // v2: the agent-facing drop queue (ctx_reduce marks, the execute band
    // lands) — Magic Context's pending_ops vocabulary on the DSH adapter.
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE pending_drops(
          session_id TEXT NOT NULL,
          tag_number INTEGER NOT NULL,
          queued_at INTEGER NOT NULL,
          landed_event_seq INTEGER,
          PRIMARY KEY(session_id, tag_number)
        );
      `)
    },
  },
  {
    // v3: the historian's compartments and the m[0]/m[1] baseline identity.
    // A compartment is a durable digest of a covered surface span; it lands
    // as a `[compacted §C<n>§]` placeholder on the next execute band, and its
    // text is injected through the composed baseline node.
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE compartments(
          session_id TEXT NOT NULL,
          compartment_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          covered_start_seq INTEGER NOT NULL,
          covered_end_seq INTEGER NOT NULL,
          covered_seqs TEXT NOT NULL,
          covered_tokens INTEGER NOT NULL,
          importance INTEGER NOT NULL,
          tier_p1 TEXT NOT NULL,
          tier_p2 TEXT NOT NULL,
          tier_p3 TEXT NOT NULL,
          tier_p4 TEXT NOT NULL,
          facts TEXT NOT NULL,
          events TEXT NOT NULL,
          baseline_epoch INTEGER NOT NULL,
          landed_event_seq INTEGER,
          PRIMARY KEY(session_id, compartment_id)
        );
        CREATE TABLE compartment_counters(
          session_id TEXT PRIMARY KEY,
          next_compartment INTEGER NOT NULL
        );
        CREATE TABLE baseline_state(
          session_id TEXT PRIMARY KEY,
          epoch INTEGER NOT NULL,
          node_seq INTEGER,
          provider TEXT,
          model TEXT,
          frozen_at INTEGER NOT NULL,
          memories_digest TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    // v4: the activity journal — the validation-period audit trail. The
    // harness logger is not persisted by the Desktop app, so decisions and
    // outcomes get their own append-only table (see core/journal.ts).
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE journal(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          level TEXT NOT NULL,
          kind TEXT NOT NULL,
          session_id TEXT,
          summary TEXT NOT NULL,
          data TEXT
        );
        CREATE INDEX journal_at ON journal(at);
        CREATE INDEX journal_kind ON journal(kind);
        CREATE INDEX journal_session ON journal(session_id, at);
      `)
    },
  },
  {
    // v5: the additive-memory watermark (Magic Context's `maxMemoryId`), so a
    // newly written memory surfaces in m[1] `<new-memories>` instead of
    // changing the recall digest and forcing a HARD rebuild of m[0].
    version: 5,
    up: (db) => {
      db.exec('ALTER TABLE baseline_state ADD COLUMN max_memory_id INTEGER')
    },
  },
  {
    // v6: the m[1] *mutation* delta lane. `max_memory_mutation_id` is Magic
    // Context's `cached_m0_max_memory_mutation_id` (watermark into the shared
    // `memory_mutation_log`); `project_epoch_fingerprint` is the
    // `project_state.project_memory_epoch` identity the baseline was built
    // against. Both are additive columns: an existing v5 database is upgraded
    // in place, and rows written before this version simply have NULL there
    // (the pass folds them once, see management-pass.ts).
    version: 6,
    up: (db) => {
      db.exec(`
        ALTER TABLE baseline_state ADD COLUMN max_memory_mutation_id INTEGER;
        ALTER TABLE baseline_state ADD COLUMN project_epoch_fingerprint TEXT;
      `)
    },
  },
]

export class StoreAheadOfAdapterError extends Error {
  constructor(
    public readonly dbVersion: number,
    public readonly adapterVersion: number,
  ) {
    super(
      `magic-context dsh adapter: store schema v${dbVersion} is newer than this build supports (v${adapterVersion}); `
        + 'update the adapter (or roll it back together with its database) before continuing',
    )
    this.name = 'StoreAheadOfAdapterError'
  }
}

function targetKey(target: TagTarget): { kind: string; id: string } {
  return target.kind === 'user-message'
    ? { kind: 'user-message', id: target.messageId }
    : { kind: 'tool-result', id: target.callId }
}

export function openStores(dataDir: string): AdapterStores {
  const dbPath = join(dataDir, 'dsh-magic-context.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  let closed = false

  let persisted = 0
  const hasMetaTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (hasMetaTable !== undefined) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    persisted = row === undefined ? 0 : Number(row.value)
    if (!Number.isInteger(persisted) || persisted < 0) {
      db.close()
      throw new Error(`magic-context dsh adapter: invalid persisted schema version ${String(row?.value)}`)
    }
  }
  if (persisted > SCHEMA_VERSION) {
    db.close()
    throw new StoreAheadOfAdapterError(persisted, SCHEMA_VERSION)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= persisted) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(migration.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }

  const allocateTag = (sessionId: string, target: TagTarget, now: number): number => {
    const { kind, id } = targetKey(target)
    const existing = db
      .prepare('SELECT tag_number FROM tags WHERE session_id = ? AND target_kind = ? AND target_id = ?')
      .get(sessionId, kind, id) as { tag_number: number } | undefined
    if (existing !== undefined) return existing.tag_number
    const insert = db.prepare(
      'INSERT INTO tags(session_id, target_kind, target_id, tag_number, created_at) VALUES(?, ?, ?, ?, ?)',
    )
    const bump = db.prepare(
      'INSERT INTO tag_counters(session_id, next_tag) VALUES(?, 2) ON CONFLICT(session_id) DO UPDATE SET next_tag = next_tag + 1 RETURNING next_tag - 1',
    )
    db.exec('BEGIN')
    try {
      const allocated = bump.get(sessionId) as { 'next_tag - 1': number } | undefined
      const tagNumber = allocated === undefined ? 1 : allocated['next_tag - 1']
      insert.run(sessionId, kind, id, tagNumber, now)
      db.exec('COMMIT')
      return tagNumber
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const getTag = (sessionId: string, target: TagTarget): number | undefined => {
    const { kind, id } = targetKey(target)
    const row = db
      .prepare('SELECT tag_number FROM tags WHERE session_id = ? AND target_kind = ? AND target_id = ?')
      .get(sessionId, kind, id) as { tag_number: number } | undefined
    return row?.tag_number
  }

  const usageColumns = 'session_id, seq, turn, step, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, recorded_at'
  const recordUsage = (record: UsageRecord): void => {
    db.exec('BEGIN')
    try {
      db.prepare(
        `INSERT OR IGNORE INTO usage_records(${usageColumns}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.sessionId,
        record.seq,
        record.turn,
        record.step,
        record.provider,
        record.model,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.cacheReadTokens ?? null,
        record.cacheWriteTokens ?? null,
        record.recordedAt,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const listUsage = (sessionId: string): UsageRecord[] =>
    (db.prepare(`SELECT * FROM usage_records WHERE session_id = ? ORDER BY seq`).all(sessionId) as Array<{
      session_id: string; seq: number; turn: number; step: number; provider: string; model: string
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null
      recorded_at: number
    }>).map(row => ({
      sessionId: row.session_id,
      seq: row.seq,
      turn: row.turn,
      step: row.step,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      cacheReadTokens: row.cache_read_tokens ?? undefined,
      cacheWriteTokens: row.cache_write_tokens ?? undefined,
      recordedAt: row.recorded_at,
    }))

  const listTags = (sessionId: string): TagRecord[] =>
    (db.prepare('SELECT * FROM tags WHERE session_id = ? ORDER BY tag_number').all(sessionId) as Array<{
      session_id: string; target_kind: string; target_id: string; tag_number: number; created_at: number
    }>).map(row => ({
      sessionId: row.session_id,
      tagNumber: row.tag_number,
      target: row.target_kind === 'user-message'
        ? { kind: 'user-message', messageId: row.target_id }
        : { kind: 'tool-result', callId: row.target_id },
      createdAt: row.created_at,
    }))

  const latestUsage = (sessionId: string): UsageRecord | undefined => {
    const row = db.prepare(
      'SELECT * FROM usage_records WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
    ).get(sessionId) as {
      session_id: string; seq: number; turn: number; step: number; provider: string; model: string
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null
      recorded_at: number
    } | undefined
    if (row === undefined) return undefined
    return {
      sessionId: row.session_id,
      seq: row.seq,
      turn: row.turn,
      step: row.step,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      cacheReadTokens: row.cache_read_tokens ?? undefined,
      cacheWriteTokens: row.cache_write_tokens ?? undefined,
      recordedAt: row.recorded_at,
    }
  }

  const queueDrop = (sessionId: string, tagNumber: number, now: number): void => {
    db.prepare(
      'INSERT INTO pending_drops(session_id, tag_number, queued_at) VALUES(?, ?, ?) '
        + 'ON CONFLICT(session_id, tag_number) DO UPDATE SET queued_at = excluded.queued_at '
        + 'WHERE landed_event_seq IS NOT NULL',
    ).run(sessionId, tagNumber, now)
  }

  const listPendingDrops = (sessionId: string): number[] =>
    (db.prepare(
      'SELECT tag_number FROM pending_drops WHERE session_id = ? AND landed_event_seq IS NULL ORDER BY queued_at, tag_number',
    ).all(sessionId) as Array<{ tag_number: number }>).map(row => row.tag_number)

  const markDropLanded = (sessionId: string, tagNumber: number, landedEventSeq: number): void => {
    db.prepare(
      'UPDATE pending_drops SET landed_event_seq = ? WHERE session_id = ? AND tag_number = ?',
    ).run(landedEventSeq, sessionId, tagNumber)
  }

  interface CompartmentRow {
    session_id: string; compartment_id: number; created_at: number
    covered_start_seq: number; covered_end_seq: number; covered_seqs: string
    covered_tokens: number; importance: number
    tier_p1: string; tier_p2: string; tier_p3: string; tier_p4: string
    facts: string; events: string; baseline_epoch: number; landed_event_seq: number | null
  }

  const toCompartment = (row: CompartmentRow): Compartment => ({
    sessionId: row.session_id,
    compartmentId: row.compartment_id,
    createdAt: row.created_at,
    coveredStartSeq: row.covered_start_seq,
    coveredEndSeq: row.covered_end_seq,
    coveredSeqs: JSON.parse(row.covered_seqs) as number[],
    coveredTokens: row.covered_tokens,
    importance: row.importance,
    tiers: { p1: row.tier_p1, p2: row.tier_p2, p3: row.tier_p3, p4: row.tier_p4 },
    facts: JSON.parse(row.facts) as MemoryFact[],
    events: JSON.parse(row.events) as string[],
    baselineEpoch: row.baseline_epoch,
    ...row.landed_event_seq === null ? {} : { landedEventSeq: row.landed_event_seq },
  })

  const allocateCompartment: AdapterStores['allocateCompartment'] = (
    sessionId,
    draft,
    covered,
    baselineEpoch,
    now,
  ) => {
    db.exec('BEGIN')
    try {
      const bumped = db.prepare(
        'INSERT INTO compartment_counters(session_id, next_compartment) VALUES(?, 2) '
          + 'ON CONFLICT(session_id) DO UPDATE SET next_compartment = next_compartment + 1 '
          + 'RETURNING next_compartment - 1',
      ).get(sessionId) as { 'next_compartment - 1': number } | undefined
      const compartmentId = bumped === undefined ? 1 : bumped['next_compartment - 1']
      db.prepare(
        'INSERT INTO compartments(session_id, compartment_id, created_at, covered_start_seq, covered_end_seq, '
          + 'covered_seqs, covered_tokens, importance, tier_p1, tier_p2, tier_p3, tier_p4, facts, events, baseline_epoch) '
          + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        sessionId,
        compartmentId,
        now,
        covered.startSeq,
        covered.endSeq,
        JSON.stringify([...covered.seqs]),
        covered.tokens,
        draft.importance,
        draft.tiers.p1,
        draft.tiers.p2,
        draft.tiers.p3,
        draft.tiers.p4,
        JSON.stringify([...draft.facts]),
        JSON.stringify([...draft.events]),
        baselineEpoch,
      )
      db.exec('COMMIT')
      return {
        sessionId,
        compartmentId,
        createdAt: now,
        coveredStartSeq: covered.startSeq,
        coveredEndSeq: covered.endSeq,
        coveredSeqs: [...covered.seqs],
        coveredTokens: covered.tokens,
        importance: draft.importance,
        tiers: draft.tiers,
        facts: [...draft.facts],
        events: [...draft.events],
        baselineEpoch,
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const listCompartments = (sessionId: string): Compartment[] =>
    (db.prepare('SELECT * FROM compartments WHERE session_id = ? ORDER BY compartment_id')
      .all(sessionId) as unknown as CompartmentRow[]).map(toCompartment)

  const listUnlandedCompartments = (sessionId: string): Compartment[] =>
    (db.prepare('SELECT * FROM compartments WHERE session_id = ? AND landed_event_seq IS NULL ORDER BY compartment_id')
      .all(sessionId) as unknown as CompartmentRow[]).map(toCompartment)

  const markCompartmentLanded = (sessionId: string, compartmentId: number, landedEventSeq: number): void => {
    db.prepare(
      'UPDATE compartments SET landed_event_seq = ? WHERE session_id = ? AND compartment_id = ?',
    ).run(landedEventSeq, sessionId, compartmentId)
  }

  const replaceCompartmentDraft = (sessionId: string, compartmentId: number, draft: CompartmentDraft): void => {
    db.prepare(
      'UPDATE compartments SET importance = ?, tier_p1 = ?, tier_p2 = ?, tier_p3 = ?, tier_p4 = ?, facts = ?, events = ? '
        + 'WHERE session_id = ? AND compartment_id = ?',
    ).run(
      draft.importance,
      draft.tiers.p1,
      draft.tiers.p2,
      draft.tiers.p3,
      draft.tiers.p4,
      JSON.stringify([...draft.facts]),
      JSON.stringify([...draft.events]),
      sessionId,
      compartmentId,
    )
  }

  const coveredSeqs = (sessionId: string): Set<number> => {
    const rows = db.prepare('SELECT covered_seqs FROM compartments WHERE session_id = ?')
      .all(sessionId) as Array<{ covered_seqs: string }>
    const seqs = new Set<number>()
    for (const row of rows) {
      for (const seq of JSON.parse(row.covered_seqs) as number[]) seqs.add(seq)
    }
    return seqs
  }

  interface BaselineRow {
    session_id: string; epoch: number; node_seq: number | null
    provider: string | null; model: string | null; frozen_at: number
    memories_digest: string | null; max_memory_id: number | null
    max_memory_mutation_id: number | null; project_epoch_fingerprint: string | null
    updated_at: number
  }

  const baselineState = (sessionId: string): BaselineState | undefined => {
    const row = db.prepare('SELECT * FROM baseline_state WHERE session_id = ?').get(sessionId) as
      | BaselineRow
      | undefined
    if (row === undefined) return undefined
    return {
      sessionId: row.session_id,
      epoch: row.epoch,
      ...row.node_seq === null ? {} : { nodeSeq: row.node_seq },
      ...row.provider === null ? {} : { provider: row.provider },
      ...row.model === null ? {} : { model: row.model },
      frozenAt: row.frozen_at,
      ...row.memories_digest === null ? {} : { memoriesDigest: row.memories_digest },
      ...row.max_memory_id === null ? {} : { maxMemoryId: row.max_memory_id },
      ...row.max_memory_mutation_id === null ? {} : { maxMemoryMutationId: row.max_memory_mutation_id },
      ...row.project_epoch_fingerprint === null ? {} : { projectEpochFingerprint: row.project_epoch_fingerprint },
      updatedAt: row.updated_at,
    }
  }

  const saveBaselineState = (state: BaselineState): void => {
    db.prepare(
      'INSERT INTO baseline_state(session_id, epoch, node_seq, provider, model, frozen_at, memories_digest, '
        + 'max_memory_id, max_memory_mutation_id, project_epoch_fingerprint, updated_at) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, node_seq = excluded.node_seq, '
        + 'provider = excluded.provider, model = excluded.model, frozen_at = excluded.frozen_at, '
        + 'memories_digest = excluded.memories_digest, max_memory_id = excluded.max_memory_id, '
        + 'max_memory_mutation_id = excluded.max_memory_mutation_id, '
        + 'project_epoch_fingerprint = excluded.project_epoch_fingerprint, '
        + 'updated_at = excluded.updated_at',
    ).run(
      state.sessionId,
      state.epoch,
      state.nodeSeq ?? null,
      state.provider ?? null,
      state.model ?? null,
      state.frozenAt,
      state.memoriesDigest ?? null,
      state.maxMemoryId ?? null,
      state.maxMemoryMutationId ?? null,
      state.projectEpochFingerprint ?? null,
      state.updatedAt,
    )
  }

  return {
    dbPath,
    allocateTag,
    getTag,
    listTags,
    recordUsage,
    listUsage,
    latestUsage,
    queueDrop,
    listPendingDrops,
    markDropLanded,
    allocateCompartment,
    listCompartments,
    listUnlandedCompartments,
    markCompartmentLanded,
    replaceCompartmentDraft,
    coveredSeqs,
    baselineState,
    saveBaselineState,
    setMeta: (key, value) => {
      db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value)
    },
    getMeta: (key) => {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
      return row?.value
    },
    appendJournal: (entry) => {
      db.prepare('INSERT INTO journal(at, level, kind, session_id, summary, data) VALUES(?, ?, ?, ?, ?, ?)')
        .run(
          entry.at,
          entry.level,
          entry.kind,
          entry.sessionId ?? null,
          entry.summary,
          entry.data === undefined ? null : JSON.stringify(entry.data),
        )
    },
    listJournal: (filter = {}) => {
      const clauses: string[] = []
      const parameters: Array<string | number> = []
      if (filter.since !== undefined) {
        clauses.push('at >= ?')
        parameters.push(filter.since)
      }
      if (filter.until !== undefined) {
        clauses.push('at <= ?')
        parameters.push(filter.until)
      }
      if (filter.sessionId !== undefined) {
        clauses.push('session_id = ?')
        parameters.push(filter.sessionId)
      }
      if (filter.kinds !== undefined && filter.kinds.length > 0) {
        clauses.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`)
        parameters.push(...filter.kinds)
      }
      if (filter.levels !== undefined && filter.levels.length > 0) {
        clauses.push(`level IN (${filter.levels.map(() => '?').join(', ')})`)
        parameters.push(...filter.levels)
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      const limit = filter.limit === undefined ? '' : ` LIMIT ${String(Math.max(1, Math.floor(filter.limit)))}`
      const rows = db.prepare(`SELECT * FROM journal${where} ORDER BY id DESC${limit}`)
        .all(...parameters) as Array<{
        at: number; level: string; kind: string; session_id: string | null; summary: string; data: string | null
      }>
      return rows.map((row) => {
        let data: Record<string, unknown> | undefined
        if (row.data !== null) {
          try {
            data = JSON.parse(row.data) as Record<string, unknown>
          } catch {
            data = { unparsable: true }
          }
        }
        return {
          at: row.at,
          level: row.level as JournalLevel,
          kind: row.kind as JournalKind,
          summary: row.summary,
          ...row.session_id === null ? {} : { sessionId: row.session_id },
          ...data === undefined ? {} : { data },
        }
      })
    },
    journalByKind: (since, sessionId) => {
      const clauses: string[] = []
      const parameters: Array<string | number> = []
      if (since !== undefined) {
        clauses.push('at >= ?')
        parameters.push(since)
      }
      if (sessionId !== undefined) {
        clauses.push('session_id = ?')
        parameters.push(sessionId)
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      return db.prepare(
        `SELECT kind, level, COUNT(*) AS count FROM journal${where} GROUP BY kind, level ORDER BY count DESC`,
      ).all(...parameters) as Array<{ kind: string; level: JournalLevel; count: number }>
    },
    pruneJournal: (before) => {
      const result = db.prepare('DELETE FROM journal WHERE at < ?').run(before)
      return Number(result.changes)
    },
    journalBounds: () => {
      const row = db.prepare('SELECT COUNT(*) AS rows, MIN(at) AS oldest, MAX(at) AS newest FROM journal')
        .get() as { rows: number; oldest: number | null; newest: number | null }
      return {
        rows: row.rows,
        ...row.oldest === null ? {} : { oldest: row.oldest },
        ...row.newest === null ? {} : { newest: row.newest },
      }
    },
    get closed() {
      return closed
    },
    close: () => {
      closed = true
      db.close()
    },
  }
}
