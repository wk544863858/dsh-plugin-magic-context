/**
 * Maintenance tick — the adapter's slice of MC's dreamer without a hidden
 * agent. Expiry archives through the contract action (mutation log + authority
 * guard stay authoritative); verification applies MC verify's host-side
 * manifest: keep → per-memory `verified_at` (metadata only, no mutation log),
 * stale → `updateMemory`, wrong → `archiveMemory`. MC basis:
 * packages/plugin/src/features/magic-context/dreamer/verify.ts, constants.ts.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryWriter } from '<path>'
import { runMaintenanceTick } from '<path>'
import type { Journal, JournalEntry, JournalKind, JournalLevel } from '<path>'

const T0 = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const OWN = 'git:own-project'
const OTHER = 'git:other-project'
const silentLogger = { info: () => {}, warn: () => {} }

const tempDirs: string[] = []

/** Magic Context's `memories` DDL (contract §1.1, verbatim). */
const MEMORIES_DDL = `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    normalized_hash TEXT NOT NULL,
    importance INTEGER,
    scope TEXT NOT NULL DEFAULT 'project',
    shareable INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT,
    source_type TEXT DEFAULT 'historian',
    seen_count INTEGER DEFAULT 1,
    retrieval_count INTEGER DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_retrieved_at INTEGER,
    status TEXT DEFAULT 'active',
    expires_at INTEGER,
    verification_status TEXT DEFAULT 'unverified',
    verified_at INTEGER,
    classified_at INTEGER,
    superseded_by_memory_id INTEGER,
    merged_from TEXT,
    metadata_json TEXT,
    mural_cue TEXT,
    mural_cue_hash TEXT,
    mural_cue_at INTEGER,
    mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_path, category, normalized_hash)
  );
`

const SUPPORT_DDL = `
  CREATE TABLE memory_mutation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
    target_memory_id INTEGER NOT NULL,
    superseded_by_id INTEGER,
    category TEXT,
    new_content TEXT,
    queued_at INTEGER NOT NULL
  );
  CREATE TABLE project_state (
    project_path TEXT PRIMARY KEY,
    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER);
`

const AUTHORITY_DDL = `
  CREATE TABLE authority_managed (
    project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL);
  CREATE TABLE authority_repair_pending (
    project_path TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
  CREATE TABLE context_privilege_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)));
  INSERT INTO context_privilege_state(id, enabled) VALUES(1, 0);

  CREATE TRIGGER memories_authority_guard_insert
  BEFORE INSERT ON memories
  WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
    AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
  BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;

  CREATE TRIGGER memories_authority_guard_update
  BEFORE UPDATE ON memories
  WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
     OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
    AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
  BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;

  CREATE TRIGGER memories_authority_guard_delete
  BEFORE DELETE ON memories
  WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
    AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
  BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
`

function createDb(schemaVersion = 94): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-maintenance-'))
  tempDirs.push(dir)
  const path = join(dir, 'context.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(MEMORIES_DDL)
    db.exec(SUPPORT_DDL)
    db.exec(AUTHORITY_DDL)
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, 0)').run(schemaVersion)
  } finally {
    db.close()
  }
  return path
}

interface SeedRow {
  readonly category: string
  readonly content: string
  readonly project?: string
  readonly expiresAt?: number | null
  readonly status?: string
  readonly verificationStatus?: string
}

function seedRow(path: string, row: SeedRow): number {
  const db = new DatabaseSync(path)
  try {
    const result = db.prepare(
      `INSERT INTO memories(
         project_path, category, content, normalized_hash, importance, scope, shareable,
         source_session_id, source_type, seen_count, retrieval_count,
         first_seen_at, created_at, updated_at, last_seen_at,
         status, expires_at, verification_status
       ) VALUES(?, ?, ?, ?, 50, 'project', 0, NULL, 'historian', 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.project ?? OWN,
      row.category,
      row.content,
      row.content.toLowerCase(),
      T0,
      T0,
      T0,
      T0,
      row.status ?? 'active',
      row.expiresAt ?? null,
      row.verificationStatus ?? 'unverified',
    )
    return Number(result.lastInsertRowid)
  } finally {
    db.close()
  }
}

interface RowSnapshot {
  readonly status: string
  readonly content: string
  readonly verifiedAt: number | null
  readonly verificationStatus: string
}

function rowSnapshot(path: string, id: number): RowSnapshot {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare(
      'SELECT status, content, verified_at, verification_status FROM memories WHERE id = ?',
    ).get(id) as { status: string; content: string; verified_at: number | null; verification_status: string }
    return { status: row.status, content: row.content, verifiedAt: row.verified_at, verificationStatus: row.verification_status }
  } finally {
    db.close()
  }
}

function mutationCount(path: string, type: string): number {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM memory_mutation_log WHERE mutation_type = ?').get(type) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

function fakeJournal(): Journal & { readonly entries: JournalEntry[] } {
  const entries: JournalEntry[] = []
  const push = (level: JournalLevel, kind: JournalKind, summary: string, data?: Record<string, unknown>): void => {
    entries.push({ seq: entries.length + 1, at: T0, level, kind, sessionId: null, summary, data: data ?? {} })
  }
  return {
    entries,
    enabled: true,
    record: (level, kind, summary, data) => push(level, kind, summary, data),
    info: (kind, summary, data) => push('info', kind, summary, data),
    warn: (kind, summary, data) => push('warn', kind, summary, data),
    error: (kind, summary, data) => push('error', kind, summary, data),
    tail: () => entries,
    byKind: () => [],
  } as Journal & { readonly entries: JournalEntry[] }
}

/** A one-shot LLM that replies with the given text (or throws). It enforces the
 * shape the real host requires: message content must be a BLOCK ARRAY, because
 * the host calls content.some(...) — a bare string threw "content.some is not
 * a function" and failed every live tick before this assertion existed. */
function fakeLlm(reply: string | Error): { stream(options: { messages: readonly { content: unknown }[] }): AsyncGenerator<unknown> } {
  return {
    async *stream(options) {
      const content = options.messages[0]?.content
      if (!Array.isArray(content) || typeof (content as { some?: unknown }).some !== 'function') {
        throw new TypeError('content.some is not a function')
      }
      if (reply instanceof Error) throw reply
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const verdictReply = (verdicts: unknown): string => JSON.stringify({ verdicts })

const ROUTE = { provider: 'deepseek', model: 'test-model' }

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* the OS temp sweep covers residue */
    }
  }
})

describe('maintenance tick — TTL expiry (dreamer expire slice)', () => {
  it('archives expired rows through the archive contract action', async () => {
    const path = createDb()
    const expired = seedRow(path, { category: 'KNOWN_ISSUES', content: 'stale issue', expiresAt: T0 - DAY_MS })
    const future = seedRow(path, { category: 'WORKFLOW_RULES', content: 'fresh rule', expiresAt: T0 + 30 * DAY_MS })
    const timeless = seedRow(path, { category: 'ARCHITECTURE', content: 'no ttl' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    const journal = fakeJournal()
    try {
      const outcome = await runMaintenanceTick({ writer, identity: OWN, sessionId: 'mc-maintenance', journal, now: () => T0 })
      expect(outcome).toMatchObject({ expired: 1, verifyRan: false })
      expect(rowSnapshot(path, expired).status).toBe('archived')
      expect(rowSnapshot(path, future).status).toBe('active')
      expect(rowSnapshot(path, timeless).status).toBe('active')
      // Expiry IS an archive: the mutation log must show it.
      expect(mutationCount(path, 'archive')).toBe(1)
      expect(journal.entries.at(-1)?.kind).toBe('maintenance')
    } finally {
      writer.close()
    }
  })

  it('sweeps only its own project identity', async () => {
    const path = createDb()
    seedRow(path, { category: 'KNOWN_ISSUES', content: 'mine expiring', expiresAt: T0 - DAY_MS })
    seedRow(path, { project: OTHER, category: 'KNOWN_ISSUES', content: 'theirs expiring', expiresAt: T0 - DAY_MS })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = await runMaintenanceTick({ writer, identity: OWN, sessionId: 'mc-maintenance', journal: fakeJournal(), now: () => T0 })
      expect(outcome.expired).toBe(1)
      const db = new DatabaseSync(path)
      try {
        const theirs = db.prepare(`SELECT status FROM memories WHERE project_path = ?`).get(OTHER) as { status: string }
        expect(theirs.status).toBe('active')
      } finally {
        db.close()
      }
    } finally {
      writer.close()
    }
  })

  it('a read-only (fenced) writer short-circuits before any sweep', async () => {
    const path = createDb(95)
    seedRow(path, { category: 'KNOWN_ISSUES', content: 'expired under v95', expiresAt: T0 - DAY_MS })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.readOnly).toBe(true)
      const outcome = await runMaintenanceTick({ writer, identity: OWN, sessionId: 'mc-maintenance', journal: fakeJournal(), now: () => T0 })
      expect(outcome.reason).toBe('read-only')
      expect(rowSnapshot(path, 1).status).toBe('active')
    } finally {
      writer.close()
    }
  })
})

describe('maintenance tick — verification (dreamer verify slice)', () => {
  it('applies the manifest: keep→verified_at, stale→update, wrong→archive, skip untouched', async () => {
    const path = createDb()
    const keep = seedRow(path, { category: 'ARCHITECTURE', content: 'still true', verificationStatus: 'unverified' })
    const stale = seedRow(path, { category: 'CONFIG_VALUES', content: 'old value 10', verificationStatus: 'unverified' })
    const wrong = seedRow(path, { category: 'CONSTRAINTS', content: 'plainly wrong', verificationStatus: 'unverified' })
    const skip = seedRow(path, { category: 'NAMING', content: 'unclear', verificationStatus: 'unverified' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    const journal = fakeJournal()
    try {
      const outcome = await runMaintenanceTick({
        writer,
        identity: OWN,
        sessionId: 'mc-maintenance',
        journal,
        llm: fakeLlm(verdictReply([
          { id: keep, verdict: 'verified' },
          { id: stale, verdict: 'stale', content: 'new value 20' },
          { id: wrong, verdict: 'wrong', reason: 'contradicts the code' },
          { id: skip, verdict: 'skip' },
        ])),
        route: ROUTE,
        now: () => T0,
      })
      expect(outcome).toMatchObject({ verifyRan: true, verified: 1, updated: 1, archived: 1, expired: 0 })
      // Keep: per-memory verified_at banked, metadata only — status untouched.
      expect(rowSnapshot(path, keep)).toMatchObject({ status: 'active', verifiedAt: T0 })
      expect(mutationCount(path, 'update')).toBe(1)
      expect(rowSnapshot(path, stale)).toMatchObject({ status: 'active', content: 'new value 20' })
      expect(mutationCount(path, 'archive')).toBe(1)
      expect(rowSnapshot(path, wrong).status).toBe('archived')
      expect(rowSnapshot(path, skip)).toMatchObject({ status: 'active', verifiedAt: null })
      expect(journal.entries.at(-1)?.kind).toBe('maintenance')
    } finally {
      writer.close()
    }
  })

  it('banks the verdicts a truncated (max-tokens) reply still carried', async () => {
    const path = createDb()
    const banked = seedRow(path, { category: 'ARCHITECTURE', content: 'still true', verificationStatus: 'unverified' })
    const cut = seedRow(path, { category: 'CONFIG_VALUES', content: 'old value 10', verificationStatus: 'unverified' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    const journal = fakeJournal()
    // Strict JSON.parse fails (the array and object never close) — the salvage
    // scanner must still recover the one complete verdict object.
    const truncated = '{"verdicts":[{"id":' + String(banked) + ',"verdict":"verified"},{"id":'
      + String(cut) + ',"verdict":"stale","content":"old value 1'
    const llm = {
      async *stream(options: { messages: readonly { content: unknown }[] }) {
        const content = options.messages[0]?.content
        if (!Array.isArray(content)) throw new TypeError('content.some is not a function')
        yield { type: 'text-delta', index: 0, text: truncated }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      },
    }
    try {
      const outcome = await runMaintenanceTick({
        writer,
        identity: OWN,
        sessionId: 'mc-maintenance',
        journal,
        llm,
        route: ROUTE,
        now: () => T0,
      })
      expect(outcome).toMatchObject({ verifyRan: true, verified: 1, updated: 0, archived: 0 })
      expect(rowSnapshot(path, banked).verificationStatus).toBe('verified')
      // The row whose verdict was cut off stays unverified for a later tick.
      expect(rowSnapshot(path, cut)).toMatchObject({ status: 'active', verificationStatus: 'unverified' })
      const last = journal.entries.at(-1)
      expect(last?.data?.truncated).toBe(true)
      expect(last?.data?.verdicts).toBe(1)
    } finally {
      writer.close()
    }
  })

  it('reaches unverified rows even when verified rows fill the render window', async () => {
    const path = createDb()
    // 70 verified rows sort BEFORE the candidate in MC's render order
    // (category ASC). Filtering a fixed 64-row window after the fact stalls
    // here forever; the SQL-level filter must still find the one candidate.
    for (let i = 0; i < 70; i += 1) {
      seedRow(path, { category: 'ARCHITECTURE', content: `done ${String(i)}`, verificationStatus: 'verified' })
    }
    const target = seedRow(path, { category: 'WORKFLOW_RULES', content: 'never judged', verificationStatus: 'unverified' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = await runMaintenanceTick({
        writer,
        identity: OWN,
        sessionId: 'mc-maintenance',
        journal: fakeJournal(),
        llm: fakeLlm(verdictReply([{ id: target, verdict: 'verified' }])),
        route: ROUTE,
        now: () => T0,
      })
      expect(outcome).toMatchObject({ verifyRan: true, verified: 1 })
      expect(rowSnapshot(path, target).verificationStatus).toBe('verified')
    } finally {
      writer.close()
    }
  })

  it('an LLM failure is fail-open: nothing mutates, the tick reports llm-failed', async () => {
    const path = createDb()
    const id = seedRow(path, { category: 'ARCHITECTURE', content: 'unsure', verificationStatus: 'unverified' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    const journal = fakeJournal()
    try {
      const outcome = await runMaintenanceTick({
        writer,
        identity: OWN,
        sessionId: 'mc-maintenance',
        journal,
        llm: fakeLlm(new Error('provider down')),
        route: ROUTE,
        now: () => T0,
      })
      expect(outcome.reason).toBe('llm-failed')
      expect(rowSnapshot(path, id).verifiedAt).toBeNull()
      // Diagnosability is part of the contract: six live ticks failed with a
      // row that named no cause, which is why the string/budget bugs hid.
      const failure = journal.entries.at(-1)
      expect(failure?.level).toBe('warn')
      expect(String(failure?.data?.why)).toContain('provider down')
      expect(failure?.data?.route).toBe('deepseek/test-model')
      expect(failure?.data?.candidates).toBe(1)
    } finally {
      writer.close()
    }
  })

  it('an unparseable reply banks nothing', async () => {
    const path = createDb()
    const id = seedRow(path, { category: 'ARCHITECTURE', content: 'unsure', verificationStatus: 'unverified' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = await runMaintenanceTick({
        writer,
        identity: OWN,
        sessionId: 'mc-maintenance',
        journal: fakeJournal(),
        llm: fakeLlm('I cannot judge these memories without file access.'),
        route: ROUTE,
        now: () => T0,
      })
      expect(outcome.verifyRan).toBe(true)
      expect(outcome.verified).toBe(0)
      expect(rowSnapshot(path, id).verifiedAt).toBeNull()
    } finally {
      writer.close()
    }
  })

  it('verifies only unverified rows and unknown ids are ignored', async () => {
    const path = createDb()
    const fresh = seedRow(path, { category: 'ARCHITECTURE', content: 'needs checking', verificationStatus: 'unverified' })
    seedRow(path, { category: 'ARCHITECTURE', content: 'already verified', verificationStatus: 'verified' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = await runMaintenanceTick({
        writer,
        identity: OWN,
        sessionId: 'mc-maintenance',
        journal: fakeJournal(),
        // 99 is not a candidate id — the manifest must drop it silently.
        llm: fakeLlm(verdictReply([{ id: 99, verdict: 'verified' }, { id: fresh, verdict: 'verified' }])),
        route: ROUTE,
        now: () => T0,
      })
      expect(outcome.verified).toBe(1)
      expect(rowSnapshot(path, fresh).verifiedAt).toBe(T0)
    } finally {
      writer.close()
    }
  })
})
