/**
 * Maintenance tick — the adapter's slice of MC's dreamer without a hidden
 * agent. Expiry archives through the contract action (mutation log + authority
 * guard stay authoritative); verification applies MC verify's host-side
 * manifest: keep → per-memory `verified_at` (metadata only, no mutation log),
 * stale → `updateMemory`, wrong → `archiveMemory`. MC basis:
 * packages/plugin/src/features/magic-context/dreamer/verify.ts, constants.ts.
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { memorySample, runMaintenanceTick } from '../src/core/maintenance.ts'
import type { Journal, JournalEntry, JournalKind, JournalLevel } from '../src/core/journal.ts'
import { makeMemoryDb } from './helpers/memory-db'
import { scriptLlm } from './helpers/llm-fake'

const T0 = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const OWN = 'git:own-project'
const OTHER = 'git:other-project'
const silentLogger = { info: () => {}, warn: () => {} }

describe('memorySample (the tick live-memory sentinel)', () => {
  it('reports the four figures in MB, rounded to 0.1', () => {
    const sample = memorySample({
      rss: 734_003_200,
      heapUsed: 123_456_789,
      heapTotal: 250_000_000,
      external: 10_485_760,
    })
    expect(sample).toEqual({ rssMb: 700, heapUsedMb: 117.7, heapTotalMb: 238.4, externalMb: 10 })
  })
})

const tempDirs: string[] = []

function createDb(schemaVersion = 95): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-maintenance-', schemaVersion, mutationLog: true, projectState: true,
  })
  tempDirs.push(dir)
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
  readonly importance: number
  readonly classifiedAt: number | null
  readonly updatedAt: number
}

function rowSnapshot(path: string, id: number): RowSnapshot {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare(
      'SELECT status, content, verified_at, verification_status, importance, classified_at, updated_at FROM memories WHERE id = ?',
    ).get(id) as {
      status: string
      content: string
      verified_at: number | null
      verification_status: string
      importance: number
      classified_at: number | null
      updated_at: number
    }
    return {
      status: row.status,
      content: row.content,
      verifiedAt: row.verified_at,
      verificationStatus: row.verification_status,
      importance: row.importance,
      classifiedAt: row.classified_at,
      updatedAt: row.updated_at,
    }
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

/** One scripted answer for every call (or a thrown Error from the first
 * `next()`). The strict request-shape enforcement lives in helpers/llm-fake. */
const fakeLlm = (reply: string | Error): { stream(options: { messages: readonly { content: unknown }[] }): AsyncIterable<unknown> } =>
  scriptLlm([reply]).llm as { stream(options: { messages: readonly { content: unknown }[] }): AsyncIterable<unknown> }

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
    // One past the contract ceiling (`MEMORY_SCHEMA_MAX_VERSION`): bump both when
    // the adapter accepts a new MC schema, or this stops fencing anything.
    const path = createDb(96)
    seedRow(path, { category: 'KNOWN_ISSUES', content: 'expired under a fenced store', expiresAt: T0 - DAY_MS })
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
          { id: keep, verdict: 'verified', importance: 85 },
          { id: stale, verdict: 'stale', content: 'new value 20', importance: 55 },
          { id: wrong, verdict: 'wrong', reason: 'contradicts the code', importance: 40 },
          { id: skip, verdict: 'skip', importance: 10 },
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
      // Classify scoring rides the same round trip: importance + classified_at
      // banked metadata-only; the stale rewrite is scored on its corrected text
      // (update clears classified_at, the scoring pass restores it) and the
      // archived wrong row self-filters out of the scoring UPDATE.
      expect(rowSnapshot(path, keep)).toMatchObject({ importance: 85, classifiedAt: T0 })
      expect(rowSnapshot(path, stale)).toMatchObject({ importance: 55, classifiedAt: T0 })
      expect(rowSnapshot(path, skip)).toMatchObject({ importance: 10, classifiedAt: T0 })
      const last = journal.entries.at(-1)
      expect(last?.kind).toBe('maintenance')
      expect(last?.data?.scored).toBe(3)
      expect(last?.data?.skipped).toBe(1)
      expect(last?.data?.verify).toBe('ran')
      expect(last?.data?.lagMaxH).toBe(0)
      expect(last?.data?.lagAvgH).toBe(0)
      // Pool after the tick: stale (still unverified) + skip = 2.
      expect(last?.data?.poolUnverified).toBe(2)
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

  it('banks the provider usage sample into the payload (dream token anchor)', async () => {
    const path = createDb()
    const id = seedRow(path, { category: 'ARCHITECTURE', content: 'usage sample', verificationStatus: 'unverified' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    const journal = fakeJournal()
    const llm = {
      async *stream(options: { messages: readonly { content: unknown }[] }) {
        const content = options.messages[0]?.content
        if (!Array.isArray(content)) throw new TypeError('content.some is not a function')
        yield { type: 'text-delta', index: 0, text: verdictReply([{ id, verdict: 'verified', importance: 70 }]) }
        // Same chunk the real seam emits (historian's capture shape): numeric
        // fields are kept, non-numeric noise is dropped.
        yield { type: 'usage', usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 'not-a-number' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
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
      expect(outcome.verifyRan).toBe(true)
      const last = journal.entries.at(-1)
      expect(last?.data?.usage).toEqual({ inputTokens: 1234, outputTokens: 56 })
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

  it('recurrence (seen_count ≥ 2) jumps the sweep queue', async () => {
    const path = createDb()
    // 16 fillers fill the whole batch; the repeated fact is seeded LAST, so
    // MC's render order (category ASC, updated_at DESC, id ASC) would leave it
    // outside a 16-row window — only the recurrence-first sweep order finds it.
    for (let i = 0; i < 16; i += 1) {
      seedRow(path, { category: 'ARCHITECTURE', content: `filler ${String(i)}`, verificationStatus: 'unverified' })
    }
    const repeat = seedRow(path, { category: 'ARCHITECTURE', content: 'repeated fact', verificationStatus: 'unverified' })
    const db = new DatabaseSync(path)
    try {
      db.prepare('UPDATE memories SET seen_count = 3 WHERE id = ?').run(repeat)
    } finally {
      db.close()
    }
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    let prompt = ''
    const llm = {
      async *stream(options: { messages: readonly { content: unknown }[] }) {
        const content = options.messages[0]?.content
        if (!Array.isArray(content)) throw new TypeError('content.some is not a function')
        prompt = String((content[0] as { text?: string }).text ?? '')
        yield { type: 'text-delta', index: 0, text: verdictReply([{ id: repeat, verdict: 'verified', importance: 80 }]) }
      },
    }
    try {
      const outcome = await runMaintenanceTick({
        writer,
        identity: OWN,
        sessionId: 'mc-maintenance',
        journal: fakeJournal(),
        llm,
        route: ROUTE,
        now: () => T0,
      })
      expect(outcome).toMatchObject({ verifyRan: true, verified: 1 })
      expect(rowSnapshot(path, repeat).verificationStatus).toBe('verified')
      // The repeated fact made the batch; the filler that render order would
      // have preferred did not.
      expect(prompt).toContain(`id ${String(repeat)} `)
      expect(prompt).not.toContain('id 16 ')
    } finally {
      writer.close()
    }
  })
})

describe('classifyMemories — metadata-only scoring slice', () => {
  it('banks clamped importance + classified_at without touching updated_at or the mutation log', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const row = seedRow(path, { category: 'ARCHITECTURE', content: 'scored row' })
      const before = rowSnapshot(path, row)
      const applied = writer.classifyMemories(OWN, [
        { id: row, importance: 500 },
        { id: 404, importance: 50 }, // absent id — self-filters through ownership
      ], T0 + 1)
      expect(applied).toBe(1)
      const after = rowSnapshot(path, row)
      expect(after.importance).toBe(100) // clamped to MC's 1..100 band
      expect(after.classifiedAt).toBe(T0 + 1)
      expect(after.updatedAt).toBe(before.updatedAt) // metadata only
      expect(mutationCount(path, 'update')).toBe(0) // no mutation log for a score
    } finally {
      writer.close()
    }
  })

  it('skips archived rows and yields zero on a fenced writer', async () => {
    const path = createDb()
    const dead = seedRow(path, { category: 'ARCHITECTURE', content: 'archived row', status: 'archived' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.classifyMemories(OWN, [{ id: dead, importance: 90 }], T0 + 1)).toBe(0)
      const fencedPath = createDb(96)
      const fencedWriter = openMemoryWriter({ dbPath: fencedPath, logger: silentLogger, now: () => T0 })
      try {
        const fenced = seedRow(fencedPath, { category: 'ARCHITECTURE', content: 'fenced row' })
        expect(fencedWriter.status.readOnly).toBe(true)
        expect(fencedWriter.classifyMemories(OWN, [{ id: fenced, importance: 90 }], T0 + 1)).toBe(0)
      } finally {
        fencedWriter.close()
      }
    } finally {
      writer.close()
    }
  })
})