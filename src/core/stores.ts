/**
 * The adapter's own SQLite stores, on `node:sqlite` (no native addons: the
 * DSH desktop host is an Electron RunAsNode process where ABI-compiled
 * modules are not portable; node:sqlite is built in on Node >= 22.19).
 *
 * Schema discipline mirrors Magic Context's storage layer: a version fence
 * that fails closed when the database is newer than this build knows, and a
 * forward-only migration chain. (The Phase 1+ plan of moving these rows into
 * the shared context.db was superseded 2026-10-13: the corpus became the
 * plugin's own memories.db, and this store stays the adapter's runtime side.)
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Compartment, CompartmentDraft } from './compartments.ts'
import type { JournalEntry, JournalKind, JournalLevel } from './journal.ts'
import type { MemoryFact } from './memory-categories.ts'
import type { DomainKind } from './domains.ts'
import { parseShareCategories, serializeShareCategories } from './domains.ts'
import type { TagRecord, TagTarget, UsageRecord } from './types.ts'

export const SCHEMA_VERSION = 10

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
  /**
   * Schema v8: the highest `user_memories.id` folded into m[0]. Profile rows
   * above it render in m[1] `<new-user-profile>` instead of forcing a HARD
   * rebuild — the same additive-watermark shape as `maxMemoryId`, but for the
   * profile table, which Magic Context versioned globally instead.
   */
  readonly profileWatermark?: number
  /**
   * Schema v8: the profile's m[0] content digest (ordered `id:updated_at` of
   * the active rows at or below `profileWatermark`). A change means a profile
   * row was rewritten or retired — which the adapter DOES treat as HARD,
   * unlike Magic Context, whose version bump deliberately never folded m[0]
   * and therefore kept injecting stale `<user-profile>` text indefinitely.
   */
  readonly profileM0Digest?: string
  readonly updatedAt: number
}

/**
 * One S(t) sidecar row: per-project, per-shared-memory usage the ADAPTER
 * tracks for its own decay scoring. The shared memory store is never written
 * for this (writer-contract discipline) — these columns exist only here.
 */
export interface MemoryStatRow {
  readonly projectIdentity: string
  readonly memoryId: number
  readonly hits: number
  readonly lastHitAt?: number
  readonly injections: number
  readonly lastInjectedAt?: number
  /** Adapter-local injection retirement; still searchable, just not injected. */
  readonly localArchived: boolean
  readonly updatedAt: number
}

/**
 * Schema v8: one global domain. `cap` is DERIVED from a token target (see
 * core/domains.ts `deriveDomainCap`) rather than picked, so budget pressure and
 * the admission limit can never disagree.
 */
export interface DomainRow {
  readonly domainId: string
  readonly kind: DomainKind
  readonly enabled: boolean
  readonly budgetTokens: number
  readonly cap: number
  /**
   * The category allowlist for the domain's shared rows, in the contract's
   * fail-closed convention: a malformed value or an unknown category shares
   * NOTHING (only a missing column falls back to `["CONSTRAINTS"]`). Empty
   * array = share no foreign categories at all.
   */
  readonly shareCategories: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Schema v8: which project identities activate a domain. */
export interface DomainMemberRow {
  readonly domainId: string
  readonly identity: string
  readonly addedAt: number
}

/** Schema v8: a cross-project candidate for `org` / `machine`. */
export interface GlobalCandidateRow {
  readonly id: number
  readonly domainId: string
  readonly content: string
  readonly normalizedHash: string
  readonly firstIdentity: string
  readonly sessionId?: string
  readonly compartmentStart?: number
  readonly compartmentEnd?: number
  /** Distinct project identities that independently observed this candidate. */
  readonly distinctIdentities: number
  readonly observationCount: number
  /** v9: the category it will be published under; absent for scan-detected rows. */
  readonly category?: string
  /** v9: the project memory a human promotion came from. */
  readonly sourceMemoryId?: number
  /**
   * v10: the LLM classification that routed this candidate into its domain
   * (`project` rows are never staged, so an absent value here means the row
   * predates classification — a human promotion or an older auto-stage).
   */
  readonly suggestedDomain?: 'machine' | 'org'
  /** v10: the classifier's one-line reason, carried into the review card. */
  readonly suggestionReason?: string
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired'
  readonly createdAt: number
  readonly updatedAt: number
}

/** Schema v8: one independent observation behind a global candidate. */
export interface CandidateObservationRow {
  readonly candidateId: number
  readonly identity: string
  readonly sessionId: string
  readonly compartmentStart?: number
  readonly compartmentEnd?: number
  readonly observations: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
}

/**
 * Schema v8: the directive-shaped confirmation queue. A candidate that reads
 * like an instruction ("always do X") may not enter the profile until the human
 * answers the question — the blast radius of a hallucinated behavioural rule is
 * every session on the machine, not just a stale note.
 */
export interface ProfileConfirmationRow {
  readonly id: number
  /** The `user_memory_candidates.id` in the SHARED store (no FK by design). */
  readonly contractCandidateId: number
  readonly question: string
  readonly content: string
  readonly state: 'pending' | 'approved' | 'rejected'
  readonly createdAt: number
  readonly decidedAt?: number
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
   * Terminal publish refusal (schema v7): the compartment KEEPS its
   * covered-seq claims (the span IS digested — it just does not pay for its
   * render), but it is never published and never retried.
   */
  markCompartmentRejected(sessionId: string, compartmentId: number, reason: string): void
  /**
   * Retire a drifted draft (schema v7): unlike a rejection the covered-seq
   * claims are RELEASED, so the next historian run re-digests the span
   * including the nodes that entered it after drafting.
   */
  supersedeCompartment(sessionId: string, compartmentId: number, reason: string): void
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
  /**
   * Delete §N§ registry rows older than the cutoff; returns the number removed.
   * The tags table only ever grows (one row per tagged target), so this is its
   * retention valve. Registry rows that old belong to compacted spans, and
   * `tag_counters` is never touched — numbers stay monotonic per session, so a
   * re-tag of a pruned target simply allocates the next fresh number.
   */
  pruneTags(before: number): number
  /** S(t) sidecar: record one search hit or recall injection (upsert + bump). */
  recordMemoryEvent(projectIdentity: string, memoryId: number, kind: 'hit' | 'injection', now: number): void
  /** S(t) sidecar rows for one identity, narrowed to `memoryIds` when given. */
  listMemoryStats(projectIdentity: string, memoryIds?: readonly number[]): MemoryStatRow[]
  /** Delete sidecar rows whose memory id is no longer known; returns rows removed. */
  pruneMemoryStats(projectIdentity: string, keepIds: readonly number[]): number
  /** Row count plus the oldest/newest timestamps. */
  journalBounds(): { rows: number; oldest?: number; newest?: number }

  // ---- schema v8: global domains ------------------------------------------
  /**
   * Insert or update a domain definition. `cap` is DERIVED by the caller
   * (core/domains.ts), never passed in from a UI, so the admission limit and
   * the token budget cannot drift apart.
   */
  upsertDomain(domain: { domainId: string; kind: DomainKind; enabled: boolean; budgetTokens: number; cap: number; shareCategories: readonly string[] }, now: number): void
  listDomains(): DomainRow[]
  getDomain(domainId: string): DomainRow | undefined
  setDomainEnabled(domainId: string, enabled: boolean, now: number): void
  addDomainMember(domainId: string, identity: string, now: number): void
  removeDomainMember(domainId: string, identity: string): void
  /** All members, or one domain's members. */
  listDomainMembers(domainId?: string): DomainMemberRow[]
  /**
   * The identities this project activates, resolved from the adapter's own
   * store. Callers MUST use this result both for the recall predicate AND for
   * the visibility watermark: a watermark computed over a wider set silently
   * swallows later visible rows (the phantom `<new-memories>` failure).
   */
  activeDomainIdentities(identity: string): Array<{ domainId: string; kind: DomainKind; identity: string }>
  /** Upsert by (domainId, normalizedHash), refreshing content and weight. */
  upsertGlobalCandidate(
    candidate: {
      domainId: string
      content: string
      normalizedHash: string
      firstIdentity: string
      sessionId?: string
      compartmentStart?: number
      compartmentEnd?: number
      category?: string
      sourceMemoryId?: number
      /** v10: the LLM classification that routed this candidate (optional — human promotions carry none). */
      suggestedDomain?: 'machine' | 'org'
      suggestionReason?: string
    },
    now: number,
  ): GlobalCandidateRow
  getGlobalCandidate(id: number): GlobalCandidateRow | undefined
  listGlobalCandidates(filter?: { domainId?: string; state?: GlobalCandidateRow['state'] }): GlobalCandidateRow[]
  setGlobalCandidateState(id: number, state: GlobalCandidateRow['state'], now: number): void
  /** One independent observation; the (candidate, identity, session) triple collapses. */
  recordCandidateObservation(
    observation: {
      candidateId: number
      identity: string
      sessionId: string
      compartmentStart?: number
      compartmentEnd?: number
    },
    now: number,
  ): void
  listCandidateObservations(candidateId: number): CandidateObservationRow[]
  /** Queue a directive-shaped candidate until a human answers the question. */
  enqueueProfileConfirmation(
    input: { contractCandidateId: number; question: string; content: string },
    now: number,
  ): ProfileConfirmationRow
  listProfileConfirmations(state?: ProfileConfirmationRow['state']): ProfileConfirmationRow[]
  decideProfileConfirmation(id: number, state: 'approved' | 'rejected', now: number): void
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
  {
    // v7: the fusion additions (borrowed from mon3stera/dsh-magic-context
    // @0.1.0, audited 2026-10-09; see docs/ for the fusion plan).
    //  - compartments.landed_reason: a TERMINAL non-publish outcome.
    //    `not-shrinkable`: the publish guard proved the digest does not pay
    //    for its own baseline render. `superseded-entrants`: substantive
    //    nodes entered the positional range after drafting. A reasoned row
    //    is never published and never retried (listUnlandedCompartments
    //    excludes it), ending the old rejected-draft-retried-forever shape.
    //  - compartments.superseded: retires a drifted draft AND RELEASES its
    //    covered-seq claims, so the next historian run re-digests the whole
    //    span (originals plus the entrants) instead of leaking it.
    //  - memory_stats: the S(t) scoring sidecar. Hits/injections for rows of
    //    the SHARED memory store are tracked HERE, adapter-local — the
    //    shared store is never written for scoring (writer-contract
    //    discipline: only the bridge's contract actions touch it).
    version: 7,
    up: (db) => {
      db.exec(`
        ALTER TABLE compartments ADD COLUMN landed_reason TEXT;
        ALTER TABLE compartments ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE memory_stats(
          project_identity TEXT NOT NULL,
          memory_id INTEGER NOT NULL,
          hits INTEGER NOT NULL DEFAULT 0,
          last_hit_at INTEGER,
          injections INTEGER NOT NULL DEFAULT 0,
          last_injected_at INTEGER,
          local_archived INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_identity, memory_id)
        );
        CREATE INDEX memory_stats_archived ON memory_stats(project_identity, local_archived);
      `)
    },
  },
  {
    // v8: the global-domain substrate (docs/dsh-plugin-execution-plan-2026-10-09.md,
    // WP1). Magic Context, its dashboard and every other host are being removed,
    // so the adapter becomes the sole owner of: which global domains exist, which
    // project identities activate them, the cross-project candidate pool for
    // org/machine, and the confirmation queue that directive-shaped profile
    // candidates must pass through. All of it lives HERE (the adapter's own
    // store) because the shared `context.db` contract is frozen.
    //
    //  - domains: one row per global domain. `cap` is DERIVED from a token
    //    target by the caller, so the admission limit and the budget cannot
    //    drift apart.
    //  - domain_members: the activation rule, replacing the contract's
    //    workspace tables (which have no writer left once the dashboard goes).
    //  - global_candidates / global_candidate_observations: the cross-project
    //    recurrence gate — a fact promoted to a global domain must have been
    //    observed independently by at least two DIFFERENT project identities.
    //  - profile_confirmations: the human gate for directive-shaped content.
    //    Unconfirmed entries never enter the injected pool.
    //  - baseline_state.profile_watermark / profile_m0_digest: the additive
    //    watermark and the m[0] content digest for the profile, so a new
    //    profile row rides the m[1] delta while a rewritten or retired one
    //    forces a HARD rebuild (deliberately unlike Magic Context, which kept
    //    serving a stale m[0] profile block).
    version: 8,
    up: (db) => {
      db.exec(`
        CREATE TABLE domains(
          domain_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('user','org','machine')),
          enabled INTEGER NOT NULL DEFAULT 0,
          budget_tokens INTEGER NOT NULL,
          cap INTEGER NOT NULL,
          share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE domain_members(
          domain_id TEXT NOT NULL REFERENCES domains(domain_id) ON DELETE CASCADE,
          identity TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY(domain_id, identity)
        );
        CREATE INDEX domain_members_identity ON domain_members(identity);
        CREATE TABLE global_candidates(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain_id TEXT NOT NULL,
          content TEXT NOT NULL,
          normalized_hash TEXT NOT NULL,
          first_identity TEXT NOT NULL,
          session_id TEXT,
          compartment_start INTEGER,
          compartment_end INTEGER,
          distinct_identities INTEGER NOT NULL DEFAULT 1,
          observation_count INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','expired')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX global_candidates_domain_hash ON global_candidates(domain_id, normalized_hash);
        CREATE INDEX global_candidates_state ON global_candidates(domain_id, state);
        CREATE TABLE global_candidate_observations(
          candidate_id INTEGER NOT NULL REFERENCES global_candidates(id) ON DELETE CASCADE,
          identity TEXT NOT NULL,
          session_id TEXT NOT NULL,
          compartment_start INTEGER,
          compartment_end INTEGER,
          observations INTEGER NOT NULL DEFAULT 1,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY(candidate_id, identity, session_id)
        );
        CREATE INDEX global_observations_identity ON global_candidate_observations(identity);
        CREATE TABLE profile_confirmations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contract_candidate_id INTEGER NOT NULL,
          question TEXT NOT NULL,
          content TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
          created_at INTEGER NOT NULL,
          decided_at INTEGER
        );
        CREATE INDEX profile_confirmations_state ON profile_confirmations(state);
        ALTER TABLE baseline_state ADD COLUMN profile_watermark INTEGER;
        ALTER TABLE baseline_state ADD COLUMN profile_m0_digest TEXT;
      `)
    },
  },
  {
    // v9: what a global candidate will be published AS.
    //
    // v8 stored a candidate's content and hash but not its category, because the
    // only intended source was the historian's recurrence scan. Naming the
    // category up front matters for two reasons: the category decides whether
    // the row will be visible at all once published (per-domain allowlist), and
    // `source_memory_id` keeps the provenance so a reviewer can see which
    // project memory a candidate came from. Both are nullable: a candidate
    // created by the recurrence scan has no single source memory, and a human
    // promotion always has one.
    version: 9,
    up: (db) => {
      db.exec(`
        ALTER TABLE global_candidates ADD COLUMN category TEXT;
        ALTER TABLE global_candidates ADD COLUMN source_memory_id INTEGER;
      `)
    },
  },
  {
    // v10: the LLM domain classification that routes an auto-staged candidate
    // into machine or org — and, when classification fails, leaves the memory
    // at PROJECT level (nothing staged). `suggested_domain` and
    // `suggestion_reason` ride the candidate row so the review card can show
    // the classifier's verdict and the operator can overrule it (the card's
    // "publish to another domain" option). Both nullable: a human promotion or
    // a pre-v10 auto-stage has no suggestion.
    version: 10,
    up: (db) => {
      db.exec(`
        ALTER TABLE global_candidates ADD COLUMN suggested_domain TEXT;
        ALTER TABLE global_candidates ADD COLUMN suggestion_reason TEXT;
      `)
    },
  },
]

export class StoreAheadOfAdapterError extends Error {
  // Declared explicitly rather than as constructor parameter properties: the
  // scripts in scripts/ load this module with plain Node (type stripping), and
  // parameter properties are not erasable syntax. Keeping the class erasable
  // lets migration tooling reuse the real store instead of re-implementing its
  // SQL — one source of truth for the adapter schema.
  readonly dbVersion: number
  readonly adapterVersion: number

  constructor(dbVersion: number, adapterVersion: number) {
    super(
      `magic-context dsh adapter: store schema v${dbVersion} is newer than this build supports (v${adapterVersion}); `
        + 'update the adapter (or roll it back together with its database) before continuing',
    )
    this.name = 'StoreAheadOfAdapterError'
    this.dbVersion = dbVersion
    this.adapterVersion = adapterVersion
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
    landed_reason: string | null; superseded: number
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
    ...row.landed_reason === null ? {} : { landedReason: row.landed_reason },
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
    (db.prepare('SELECT * FROM compartments WHERE session_id = ? AND landed_event_seq IS NULL '
        + 'AND superseded = 0 AND landed_reason IS NULL ORDER BY compartment_id')
      .all(sessionId) as unknown as CompartmentRow[]).map(toCompartment)

  const markCompartmentLanded = (sessionId: string, compartmentId: number, landedEventSeq: number): void => {
    db.prepare(
      'UPDATE compartments SET landed_event_seq = ? WHERE session_id = ? AND compartment_id = ?',
    ).run(landedEventSeq, sessionId, compartmentId)
  }

  const markCompartmentRejected = (sessionId: string, compartmentId: number, reason: string): void => {
    db.prepare(
      'UPDATE compartments SET landed_reason = ? WHERE session_id = ? AND compartment_id = ? '
        + 'AND landed_event_seq IS NULL',
    ).run(reason, sessionId, compartmentId)
  }

  const supersedeCompartment = (sessionId: string, compartmentId: number, reason: string): void => {
    db.prepare(
      'UPDATE compartments SET superseded = 1, landed_reason = ? WHERE session_id = ? AND compartment_id = ?',
    ).run(reason, sessionId, compartmentId)
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
    // Superseded drafts release their claims: their span (originals plus the
    // nodes that drifted in) goes back into the historian's eligibility pool.
    const rows = db.prepare('SELECT covered_seqs FROM compartments WHERE session_id = ? AND superseded = 0')
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
    profile_watermark: number | null; profile_m0_digest: string | null
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
      ...row.profile_watermark === null ? {} : { profileWatermark: row.profile_watermark },
      ...row.profile_m0_digest === null ? {} : { profileM0Digest: row.profile_m0_digest },
      updatedAt: row.updated_at,
    }
  }

  const saveBaselineState = (state: BaselineState): void => {
    db.prepare(
      'INSERT INTO baseline_state(session_id, epoch, node_seq, provider, model, frozen_at, memories_digest, '
        + 'max_memory_id, max_memory_mutation_id, project_epoch_fingerprint, profile_watermark, profile_m0_digest, updated_at) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, node_seq = excluded.node_seq, '
        + 'provider = excluded.provider, model = excluded.model, frozen_at = excluded.frozen_at, '
        + 'memories_digest = excluded.memories_digest, max_memory_id = excluded.max_memory_id, '
        + 'max_memory_mutation_id = excluded.max_memory_mutation_id, '
        + 'project_epoch_fingerprint = excluded.project_epoch_fingerprint, '
        + 'profile_watermark = excluded.profile_watermark, '
        + 'profile_m0_digest = excluded.profile_m0_digest, '
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
      state.profileWatermark ?? null,
      state.profileM0Digest ?? null,
      state.updatedAt,
    )
  }

  // ---- schema v8: global domains ------------------------------------------
  //
  // `domain_id` IS the provider identity used in the shared store (for example
  // `dir:global:org`), so activation needs no second mapping: the row that says
  // "this domain exists" carries the exact `project_path` its memories live
  // under. The `kind` column is the closed three-value label used for
  // presentation, budgets and policy.

  interface DomainDbRow {
    domain_id: string; kind: string; enabled: number
    budget_tokens: number; cap: number; share_categories: string
    created_at: number; updated_at: number
  }

  const toDomain = (row: DomainDbRow): DomainRow => ({
    domainId: row.domain_id,
    kind: row.kind as DomainKind,
    enabled: row.enabled !== 0,
    budgetTokens: row.budget_tokens,
    cap: row.cap,
    shareCategories: parseShareCategories(row.share_categories),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const upsertDomain = (
    domain: {
      domainId: string
      kind: DomainKind
      enabled: boolean
      budgetTokens: number
      cap: number
      shareCategories: readonly string[]
    },
    now: number,
  ): void => {
    // serializeShareCategories rejects an unknown category here, at the write,
    // rather than letting a row become permanently invisible later.
    const shareCategories = serializeShareCategories(domain.shareCategories)
    db.prepare(
      'INSERT INTO domains(domain_id, kind, enabled, budget_tokens, cap, share_categories, created_at, updated_at) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(domain_id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled, '
        + 'budget_tokens = excluded.budget_tokens, cap = excluded.cap, '
        + 'share_categories = excluded.share_categories, updated_at = excluded.updated_at',
    ).run(domain.domainId, domain.kind, domain.enabled ? 1 : 0, domain.budgetTokens, domain.cap, shareCategories, now, now)
  }

  const listDomains = (): DomainRow[] =>
    (db.prepare('SELECT * FROM domains ORDER BY kind, domain_id').all() as unknown as DomainDbRow[]).map(toDomain)

  const getDomain = (domainId: string): DomainRow | undefined => {
    const row = db.prepare('SELECT * FROM domains WHERE domain_id = ?').get(domainId) as DomainDbRow | undefined
    return row === undefined ? undefined : toDomain(row)
  }

  const setDomainEnabled = (domainId: string, enabled: boolean, now: number): void => {
    db.prepare('UPDATE domains SET enabled = ?, updated_at = ? WHERE domain_id = ?').run(enabled ? 1 : 0, now, domainId)
  }

  const addDomainMember = (domainId: string, identity: string, now: number): void => {
    db.prepare(
      'INSERT INTO domain_members(domain_id, identity, added_at) VALUES(?, ?, ?) '
        + 'ON CONFLICT(domain_id, identity) DO NOTHING',
    ).run(domainId, identity, now)
  }

  const removeDomainMember = (domainId: string, identity: string): void => {
    db.prepare('DELETE FROM domain_members WHERE domain_id = ? AND identity = ?').run(domainId, identity)
  }

  const listDomainMembers = (domainId?: string): DomainMemberRow[] => {
    const rows = (domainId === undefined
      ? db.prepare('SELECT * FROM domain_members ORDER BY domain_id, identity').all()
      : db.prepare('SELECT * FROM domain_members WHERE domain_id = ? ORDER BY identity').all(domainId)) as unknown as Array<{
      domain_id: string; identity: string; added_at: number
    }>
    return rows.map(row => ({ domainId: row.domain_id, identity: row.identity, addedAt: row.added_at }))
  }

  const activeDomainIdentities = (
    identity: string,
  ): Array<{ domainId: string; kind: DomainKind; identity: string }> => {
    const rows = db.prepare(
      'SELECT d.domain_id AS domain_id, d.kind AS kind FROM domain_members m '
        + 'JOIN domains d ON d.domain_id = m.domain_id '
        + 'WHERE m.identity = ? AND d.enabled = 1 ORDER BY d.kind, d.domain_id',
    ).all(identity) as unknown as Array<{ domain_id: string; kind: string }>
    return rows.map(row => ({ domainId: row.domain_id, kind: row.kind as DomainKind, identity: row.domain_id }))
  }

  interface GlobalCandidateDbRow {
    id: number; domain_id: string; content: string; normalized_hash: string; first_identity: string
    session_id: string | null; compartment_start: number | null; compartment_end: number | null
    distinct_identities: number; observation_count: number; state: string
    category: string | null; source_memory_id: number | null
    suggested_domain: string | null; suggestion_reason: string | null
    created_at: number; updated_at: number
  }

  const toGlobalCandidate = (row: GlobalCandidateDbRow): GlobalCandidateRow => ({
    id: row.id,
    domainId: row.domain_id,
    content: row.content,
    normalizedHash: row.normalized_hash,
    firstIdentity: row.first_identity,
    ...row.session_id === null ? {} : { sessionId: row.session_id },
    ...row.compartment_start === null ? {} : { compartmentStart: row.compartment_start },
    ...row.compartment_end === null ? {} : { compartmentEnd: row.compartment_end },
    distinctIdentities: row.distinct_identities,
    observationCount: row.observation_count,
    ...row.category === null ? {} : { category: row.category },
    ...row.source_memory_id === null ? {} : { sourceMemoryId: row.source_memory_id },
    ...row.suggested_domain === null ? {} : { suggestedDomain: row.suggested_domain as 'machine' | 'org' },
    ...row.suggestion_reason === null ? {} : { suggestionReason: row.suggestion_reason },
    state: row.state as GlobalCandidateRow['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const getGlobalCandidateByHash = (domainId: string, normalizedHash: string): GlobalCandidateRow | undefined => {
    const row = db
      .prepare('SELECT * FROM global_candidates WHERE domain_id = ? AND normalized_hash = ?')
      .get(domainId, normalizedHash) as GlobalCandidateDbRow | undefined
    return row === undefined ? undefined : toGlobalCandidate(row)
  }

  /** Recompute the recurrence weight from the observation rows (never from a counter the caller passes). */
  const refreshCandidateWeight = (candidateId: number, now: number): void => {
    db.prepare(
      'UPDATE global_candidates SET '
        + 'distinct_identities = (SELECT COUNT(*) FROM global_candidate_observations WHERE candidate_id = ?), '
        + 'observation_count = (SELECT COALESCE(SUM(observations), 0) FROM global_candidate_observations WHERE candidate_id = ?), '
        + 'updated_at = ? WHERE id = ?',
    ).run(candidateId, candidateId, now, candidateId)
  }

  const upsertGlobalCandidate = (
    candidate: {
      domainId: string
      content: string
      normalizedHash: string
      firstIdentity: string
      sessionId?: string
      compartmentStart?: number
      compartmentEnd?: number
      category?: string
      sourceMemoryId?: number
      suggestedDomain?: 'machine' | 'org'
      suggestionReason?: string
    },
    now: number,
  ): GlobalCandidateRow => {
    db.prepare(
      'INSERT INTO global_candidates(domain_id, content, normalized_hash, first_identity, session_id, '
        + 'compartment_start, compartment_end, distinct_identities, observation_count, category, source_memory_id, '
        + 'suggested_domain, suggestion_reason, '
        + "state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'pending', ?, ?) "
        + 'ON CONFLICT(domain_id, normalized_hash) DO UPDATE SET content = excluded.content, '
        // A later sighting that does not carry the metadata must not erase it.
        + 'category = COALESCE(excluded.category, global_candidates.category), '
        + 'source_memory_id = COALESCE(excluded.source_memory_id, global_candidates.source_memory_id), '
        + 'suggested_domain = COALESCE(excluded.suggested_domain, global_candidates.suggested_domain), '
        + 'suggestion_reason = COALESCE(excluded.suggestion_reason, global_candidates.suggestion_reason), '
        + 'updated_at = excluded.updated_at, '
        + "state = CASE WHEN global_candidates.state = 'expired' THEN 'pending' ELSE global_candidates.state END",
    ).run(
      candidate.domainId,
      candidate.content,
      candidate.normalizedHash,
      candidate.firstIdentity,
      candidate.sessionId ?? null,
      candidate.compartmentStart ?? null,
      candidate.compartmentEnd ?? null,
      candidate.category ?? null,
      candidate.sourceMemoryId ?? null,
      candidate.suggestedDomain ?? null,
      candidate.suggestionReason ?? null,
      now,
      now,
    )
    const row = getGlobalCandidateByHash(candidate.domainId, candidate.normalizedHash)
    if (row === undefined) throw new Error('magic-context dsh adapter: global candidate upsert did not land')
    return row
  }

  const getGlobalCandidate = (id: number): GlobalCandidateRow | undefined => {
    const row = db.prepare('SELECT * FROM global_candidates WHERE id = ?').get(id) as
      | GlobalCandidateDbRow
      | undefined
    return row === undefined ? undefined : toGlobalCandidate(row)
  }

  const listGlobalCandidates = (
    filter?: { domainId?: string; state?: GlobalCandidateRow['state'] },
  ): GlobalCandidateRow[] => {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter?.domainId !== undefined) {
      where.push('domain_id = ?')
      params.push(filter.domainId)
    }
    if (filter?.state !== undefined) {
      where.push('state = ?')
      params.push(filter.state)
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    const rows = db
      .prepare(`SELECT * FROM global_candidates${clause} ORDER BY updated_at DESC, id DESC`)
      .all(...params) as unknown as GlobalCandidateDbRow[]
    return rows.map(toGlobalCandidate)
  }

  const setGlobalCandidateState = (id: number, state: GlobalCandidateRow['state'], now: number): void => {
    db.prepare('UPDATE global_candidates SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id)
  }

  const recordCandidateObservation = (
    observation: {
      candidateId: number
      identity: string
      sessionId: string
      compartmentStart?: number
      compartmentEnd?: number
    },
    now: number,
  ): void => {
    db.exec('BEGIN')
    try {
      db.prepare(
        'INSERT INTO global_candidate_observations(candidate_id, identity, session_id, compartment_start, '
          + 'compartment_end, observations, first_seen_at, last_seen_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?) '
          + 'ON CONFLICT(candidate_id, identity, session_id) DO UPDATE SET observations = observations + 1, '
          + 'last_seen_at = excluded.last_seen_at',
      ).run(
        observation.candidateId,
        observation.identity,
        observation.sessionId,
        observation.compartmentStart ?? null,
        observation.compartmentEnd ?? null,
        now,
        now,
      )
      refreshCandidateWeight(observation.candidateId, now)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const listCandidateObservations = (candidateId: number): CandidateObservationRow[] =>
    (db.prepare(
      'SELECT * FROM global_candidate_observations WHERE candidate_id = ? ORDER BY identity, session_id',
    ).all(candidateId) as unknown as Array<{
      candidate_id: number; identity: string; session_id: string
      compartment_start: number | null; compartment_end: number | null
      observations: number; first_seen_at: number; last_seen_at: number
    }>).map(row => ({
      candidateId: row.candidate_id,
      identity: row.identity,
      sessionId: row.session_id,
      ...row.compartment_start === null ? {} : { compartmentStart: row.compartment_start },
      ...row.compartment_end === null ? {} : { compartmentEnd: row.compartment_end },
      observations: row.observations,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }))

  interface ProfileConfirmationDbRow {
    id: number; contract_candidate_id: number; question: string; content: string
    state: string; created_at: number; decided_at: number | null
  }

  const toProfileConfirmation = (row: ProfileConfirmationDbRow): ProfileConfirmationRow => ({
    id: row.id,
    contractCandidateId: row.contract_candidate_id,
    question: row.question,
    content: row.content,
    state: row.state as ProfileConfirmationRow['state'],
    createdAt: row.created_at,
    ...row.decided_at === null ? {} : { decidedAt: row.decided_at },
  })

  const enqueueProfileConfirmation = (
    input: { contractCandidateId: number; question: string; content: string },
    now: number,
  ): ProfileConfirmationRow => {
    // Idempotent per pending candidate: a retried historian pass must not
    // produce a second question for the same observation.
    const existing = db.prepare(
      "SELECT * FROM profile_confirmations WHERE contract_candidate_id = ? AND state = 'pending'",
    ).get(input.contractCandidateId) as ProfileConfirmationDbRow | undefined
    if (existing !== undefined) return toProfileConfirmation(existing)
    const inserted = db.prepare(
      "INSERT INTO profile_confirmations(contract_candidate_id, question, content, state, created_at) "
        + "VALUES(?, ?, ?, 'pending', ?) RETURNING *",
    ).get(input.contractCandidateId, input.question, input.content, now) as unknown as ProfileConfirmationDbRow
    return toProfileConfirmation(inserted)
  }

  const listProfileConfirmations = (state?: ProfileConfirmationRow['state']): ProfileConfirmationRow[] => {
    const rows = (state === undefined
      ? db.prepare('SELECT * FROM profile_confirmations ORDER BY created_at, id').all()
      : db.prepare('SELECT * FROM profile_confirmations WHERE state = ? ORDER BY created_at, id').all(state)) as unknown as ProfileConfirmationDbRow[]
    return rows.map(toProfileConfirmation)
  }

  const decideProfileConfirmation = (id: number, state: 'approved' | 'rejected', now: number): void => {
    db.prepare('UPDATE profile_confirmations SET state = ?, decided_at = ? WHERE id = ?').run(state, now, id)
  }

  return {
    dbPath,
    upsertDomain,
    listDomains,
    getDomain,
    setDomainEnabled,
    addDomainMember,
    removeDomainMember,
    listDomainMembers,
    activeDomainIdentities,
    upsertGlobalCandidate,
    getGlobalCandidate,
    listGlobalCandidates,
    setGlobalCandidateState,
    recordCandidateObservation,
    listCandidateObservations,
    enqueueProfileConfirmation,
    listProfileConfirmations,
    decideProfileConfirmation,
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
    markCompartmentRejected,
    supersedeCompartment,
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
    pruneTags: (before) => {
      const result = db.prepare('DELETE FROM tags WHERE created_at < ?').run(before)
      return Number(result.changes)
    },
    recordMemoryEvent: (projectIdentity, memoryId, kind, now) => {
      // Two statements on purpose: the upsert seeds the row, the bump applies
      // the one counter the event names. ≤ ~46 events per pass (memoryLimit +
      // search rows), so the extra prepare is noise next to correctness.
      db.prepare(
        'INSERT INTO memory_stats(project_identity, memory_id, updated_at) VALUES(?, ?, ?) '
          + 'ON CONFLICT(project_identity, memory_id) DO NOTHING',
      ).run(projectIdentity, memoryId, now)
      if (kind === 'hit') {
        db.prepare(
          'UPDATE memory_stats SET hits = hits + 1, last_hit_at = ?, updated_at = ? '
            + 'WHERE project_identity = ? AND memory_id = ?',
        ).run(now, now, projectIdentity, memoryId)
      } else {
        db.prepare(
          'UPDATE memory_stats SET injections = injections + 1, last_injected_at = ?, updated_at = ? '
            + 'WHERE project_identity = ? AND memory_id = ?',
        ).run(now, now, projectIdentity, memoryId)
      }
    },
    listMemoryStats: (projectIdentity, memoryIds) => {
      const toStat = (row: {
        project_identity: string; memory_id: number; hits: number; last_hit_at: number | null
        injections: number; last_injected_at: number | null; local_archived: number; updated_at: number
      }): MemoryStatRow => ({
        projectIdentity: row.project_identity,
        memoryId: row.memory_id,
        hits: row.hits,
        ...row.last_hit_at === null ? {} : { lastHitAt: row.last_hit_at },
        injections: row.injections,
        ...row.last_injected_at === null ? {} : { lastInjectedAt: row.last_injected_at },
        localArchived: row.local_archived !== 0,
        updatedAt: row.updated_at,
      })
      if (memoryIds !== undefined && memoryIds.length === 0) return []
      if (memoryIds === undefined) {
        return (db.prepare('SELECT * FROM memory_stats WHERE project_identity = ?')
          .all(projectIdentity) as Array<Parameters<typeof toStat>[0]>).map(toStat)
      }
      const out: MemoryStatRow[] = []
      // Chunked IN lists stay under SQLite's bound-parameter ceiling.
      for (let index = 0; index < memoryIds.length; index += 500) {
        const chunk = memoryIds.slice(index, index + 500)
        const placeholders = chunk.map(() => '?').join(', ')
        const rows = db.prepare(
          `SELECT * FROM memory_stats WHERE project_identity = ? AND memory_id IN (${placeholders})`,
        ).all(projectIdentity, ...chunk) as Array<Parameters<typeof toStat>[0]>
        out.push(...rows.map(toStat))
      }
      return out
    },
    // NOTE: no setter for `local_archived` any more — it had zero production
    // callers from birth (2026-10-10 TTL 排查定案), and S(t) retirement is
    // computed live at recall (memory-bridge pick) and live in the report
    // meter. The column + the read in pick() stay as a manual-retire hook.
    pruneMemoryStats: (projectIdentity, keepIds) => {
      // One statement: orphans are rows whose memory_id left the known pool.
      // keepIds is the project's whole visible pool (memoryLimit-bounded
      // rendering aside, pools stay in the hundreds — well under SQLite's
      // bound-parameter ceiling).
      if (keepIds.length === 0) {
        const result = db.prepare('DELETE FROM memory_stats WHERE project_identity = ?').run(projectIdentity)
        return Number(result.changes)
      }
      const placeholders = keepIds.map(() => '?').join(', ')
      const result = db.prepare(
        `DELETE FROM memory_stats WHERE project_identity = ? AND memory_id NOT IN (${placeholders})`,
      ).run(projectIdentity, ...keepIds)
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
