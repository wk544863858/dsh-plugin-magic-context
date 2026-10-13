import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryWriteResult } from '../src/core/memory-write.ts'
import {
  isWritableMemoryCategory,
  normalizedMemoryHash,
  openMemoryWriter,
} from '../src/core/memory-write.ts'
import { V2_MEMORY_CATEGORIES } from '../src/core/memory-categories.ts'
import { makeMemoryDb } from './helpers/memory-db'

const OWN = 'git:1111111111111111111111111111111111111111'
const OTHER = 'git:2222222222222222222222222222222222222222'

const T0 = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
/** MC's storage version, and the version this adapter understands. */
const SCHEMA_VERSION = 94
const WRITER_SOURCE = fileURLToPath(new URL('../src/core/memory-write.ts', import.meta.url))

const tempDirs: string[] = []

const silentLogger = { info: () => {}, warn: () => {} }

/**
 * Where `openMemoryWriter` applies each §10.1 pragma, in contract order.
 * `busy_timeout` and `foreign_keys` are per-connection, so no second connection
 * can observe them; only a source-level assertion can pin their order.
 */
function pragmaPositions(): { busyTimeout: number; foreignKeys: number; journalMode: number } {
  const source = readFileSync(WRITER_SOURCE, 'utf8')
  return {
    busyTimeout: source.indexOf('PRAGMA busy_timeout'),
    foreignKeys: source.indexOf('PRAGMA foreign_keys'),
    journalMode: source.indexOf('PRAGMA journal_mode'),
  }
}

function collectingLogger(): { readonly messages: string[]; info: (m: string) => void; warn: (m: string) => void } {
  const messages: string[] = []
  return {
    messages,
    info: (message: string) => { messages.push(`info:${message}`) },
    warn: (message: string) => { messages.push(`warn:${message}`) },
  }
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function createDb(): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-mw-', schemaVersion: SCHEMA_VERSION,
    mutationLog: true, projectState: true, fts: true, artefacts: true,
  })
  tempDirs.push(dir)
  return path
}

/** A trimmed database: no authority tables, no embedding/verification tables. */
function createTrimmedDb(): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-mw-trim-', schemaVersion: SCHEMA_VERSION, mutationLog: true, projectState: true,
  })
  tempDirs.push(dir)
  return path
}

function run(path: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(path)
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

function query<T>(path: string, sql: string, ...params: Array<string | number | null>): T[] {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(sql).all(...params) as unknown as T[]
  } finally {
    db.close()
  }
}

function one<T>(path: string, sql: string, ...params: Array<string | number | null>): T | undefined {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(sql).get(...params) as unknown as T | undefined
  } finally {
    db.close()
  }
}

function count(path: string, sql: string, ...params: Array<string | number | null>): number {
  return one<{ c: number }>(path, sql, ...params)?.c ?? 0
}

function seedProjectState(path: string, identity: string, epoch: number): void {
  run(
    path,
    'INSERT INTO project_state(project_path, project_memory_epoch, project_user_profile_version, updated_at) VALUES(?, ?, 0, 0)',
    identity,
    epoch,
  )
}

interface SeedMemory {
  readonly project: string
  readonly category: string
  readonly content: string
  readonly importance?: number
  readonly shareable?: number
  readonly seenCount?: number
  readonly retrievalCount?: number
  readonly status?: string
  readonly expiresAt?: number | null
  readonly updatedAt?: number
  readonly supersededBy?: number | null
  readonly mergedFrom?: string | null
}

function seedMemory(path: string, row: SeedMemory): number {
  const db = new DatabaseSync(path)
  try {
    const result = db.prepare(
      `INSERT INTO memories(
         project_path, category, content, normalized_hash, importance, scope, shareable,
         source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
         last_seen_at, status, expires_at, verification_status, superseded_by_memory_id, merged_from)
       VALUES(?, ?, ?, ?, ?, 'project', ?, 'agent', ?, ?, 0, 0, ?, ?, ?, ?, 'unverified', ?, ?)`,
    ).run(
      row.project,
      row.category,
      row.content,
      normalizedMemoryHash(row.content),
      row.importance ?? 50,
      row.shareable ?? 0,
      row.seenCount ?? 1,
      row.retrievalCount ?? 0,
      row.updatedAt ?? 1000,
      row.updatedAt ?? 1000,
      row.status ?? 'active',
      row.expiresAt ?? null,
      row.supersededBy ?? null,
      row.mergedFrom ?? null,
    )
    return Number(result.lastInsertRowid)
  } finally {
    db.close()
  }
}

function createdId(result: MemoryWriteResult): number {
  if (!result.ok) throw new Error(`expected a write success, got ${result.reason}: ${result.detail}`)
  return result.id
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* the OS temp sweep covers residue */
    }
  }
})

describe('promotion invariants (contract §9)', () => {
  it('A1: repeated promotion of one fact keeps one row and bumps seen_count', () => {
    const path = createDb()
    const clock = { value: T0 }
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => clock.value })
    try {
      // Case and whitespace variants collapse onto the same normalized hash.
      expect(normalizedMemoryHash('Always run the tests')).toBe(
        normalizedMemoryHash('  always   RUN\tthe\ntests  '),
      )

      const first = writer.promoteFacts({
        identity: OWN,
        facts: [{ category: 'CONSTRAINTS', content: 'Always run the tests' }],
      })
      expect(first.inserted).toHaveLength(1)
      expect(first.seenAgain).toHaveLength(0)

      clock.value = T0 + 5_000
      const second = writer.promoteFacts({
        identity: OWN,
        facts: [{ category: 'CONSTRAINTS', content: '  always   RUN\tthe\ntests  ' }],
      })
      expect(second.inserted).toHaveLength(0)
      expect(second.seenAgain).toEqual([{ id: first.inserted[0]!.id, category: 'CONSTRAINTS' }])
      expect(writer.stats(OWN).rows).toBe(1)

      const rows = query<{
        seen_count: number
        first_seen_at: number
        created_at: number
        last_seen_at: number
        updated_at: number
        normalized_hash: string
      }>(path, 'SELECT seen_count, first_seen_at, created_at, last_seen_at, updated_at, normalized_hash FROM memories WHERE project_path = ?', OWN)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({
        seen_count: 2,
        first_seen_at: T0,
        created_at: T0,
        last_seen_at: T0 + 5_000,
        updated_at: T0 + 5_000,
        normalized_hash: normalizedMemoryHash('Always run the tests'),
      })
      expect(rows[0]!.normalized_hash).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      writer.close()
    }
  })

  it('A2: promotion is a pure append — no mutation log row, no project_state row', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.stats(OWN)).toEqual({ rows: 0, mutationLog: 0, epoch: 0, verified: 0, unverified: 0 })
      const outcome = writer.promoteFacts({
        identity: OWN,
        facts: [{ category: 'ARCHITECTURE', content: 'layered modules with a core seam' }],
      })
      expect(outcome.inserted).toHaveLength(1)
      expect(writer.stats(OWN)).toEqual({ rows: 1, mutationLog: 0, epoch: 0, verified: 0, unverified: 1 })
      expect(count(path, 'SELECT COUNT(*) AS c FROM memory_mutation_log')).toBe(0)
      expect(count(path, 'SELECT COUNT(*) AS c FROM project_state WHERE project_path = ?', OWN)).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('A3: promotion only touches the target project', () => {
    const path = createDb()
    seedProjectState(path, OWN, 3)
    seedProjectState(path, OTHER, 3)
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      writer.promoteFacts({ identity: OWN, facts: [{ category: 'NAMING', content: 'kebab-case files' }] })
      writer.promoteFacts({ identity: OTHER, facts: [{ category: 'NAMING', content: 'snake_case modules' }] })

      const otherBefore = writer.stats(OTHER)
      expect(otherBefore).toEqual({ rows: 1, mutationLog: 0, epoch: 3, verified: 0, unverified: 1 })

      writer.promoteFacts({ identity: OWN, facts: [{ category: 'NAMING', content: 'one more naming rule' }] })

      expect(writer.stats(OWN)).toEqual({ rows: 2, mutationLog: 0, epoch: 3, verified: 0, unverified: 2 })
      expect(writer.stats(OTHER)).toEqual(otherBefore)
    } finally {
      writer.close()
    }
  })

  it('A4: invalid facts are skipped without aborting the batch', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const outcome = writer.promoteFacts({
        identity: OWN,
        facts: [
          { category: 'CONSTRAINTS', content: 'only this one is valid' },
          { category: 'CONSTRAINTS', content: '   ' },
          { category: 'NOT_A_CATEGORY', content: 'not in the vocabulary' },
          { category: 42 as unknown as string, content: 'category is not a string' },
        ],
      })
      expect(outcome.inserted).toHaveLength(1)
      expect(outcome.seenAgain).toHaveLength(0)
      expect(outcome.skipped.map(entry => entry.reason)).toEqual([
        'empty-content',
        'category-not-promotable',
        'category-not-promotable',
      ])
      expect(writer.stats(OWN).rows).toBe(1)
      // The batch still surfaces a watermark, so the publication is not stalled.
      expect(outcome.maxMemoryId).toBeGreaterThan(0)
    } finally {
      writer.close()
    }
  })

  it('A6: the category decides expires_at', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      writer.promoteFacts({
        identity: OWN,
        facts: [
          { category: 'WORKFLOW_RULES', content: 'rotate the logs weekly' },
          { category: 'KNOWN_ISSUES', content: 'the CI job is flaky' },
          ...V2_MEMORY_CATEGORIES.map(category => ({ category, content: `v2 fact for ${category}` })),
        ],
      })
      expect(one<{ expires_at: number | null }>(path, 'SELECT expires_at FROM memories WHERE project_path = ? AND category = ?', OWN, 'WORKFLOW_RULES')?.expires_at)
        .toBe(T0 + 90 * DAY_MS)
      expect(one<{ expires_at: number | null }>(path, 'SELECT expires_at FROM memories WHERE project_path = ? AND category = ?', OWN, 'KNOWN_ISSUES')?.expires_at)
        .toBe(T0 + 30 * DAY_MS)
      for (const category of V2_MEMORY_CATEGORIES) {
        expect(one<{ expires_at: number | null }>(path, 'SELECT expires_at FROM memories WHERE project_path = ? AND category = ?', OWN, category)?.expires_at)
          .toBeNull()
      }
      expect(writer.stats(OWN).rows).toBe(2 + V2_MEMORY_CATEGORIES.length)
    } finally {
      writer.close()
    }
  })
})

describe('agent write path (contract §11)', () => {
  it('writeMemory inserts an agent row and only bumps seen_count on a duplicate hash', () => {
    const path = createDb()
    const clock = { value: T0 }
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => clock.value })
    try {
      const created = writer.writeMemory({
        identity: OWN,
        category: 'PROJECT_RULES',
        content: 'Never rewrite published history',
      })
      expect(created).toEqual({ ok: true, id: expect.any(Number), created: true, seenCount: 1 })
      const id = createdId(created)
      expect(writer.getMemory(OWN, id)).toMatchObject({
        id,
        projectPath: OWN,
        category: 'PROJECT_RULES',
        content: 'Never rewrite published history',
        normalizedHash: normalizedMemoryHash('Never rewrite published history'),
        importance: 50,
        scope: 'project',
        shareable: 0,
        sourceType: 'agent',
        status: 'active',
        verificationStatus: 'unverified',
        seenCount: 1,
        retrievalCount: 0,
        supersededByMemoryId: null,
        mergedFrom: null,
        expiresAt: null,
        firstSeenAt: T0,
        createdAt: T0,
        updatedAt: T0,
        lastSeenAt: T0,
      })

      clock.value = T0 + 1_000
      const again = writer.writeMemory({
        identity: OWN,
        category: 'PROJECT_RULES',
        content: '  never   REWRITE published history ',
      })
      expect(again).toMatchObject({ ok: true, id, created: false, seenCount: 2 })
      expect(writer.stats(OWN)).toEqual({ rows: 1, mutationLog: 0, epoch: 0, verified: 0, unverified: 1 })
      expect(writer.getMemory(OWN, id)).toMatchObject({
        seenCount: 2,
        firstSeenAt: T0,
        lastSeenAt: T0 + 1_000,
        updatedAt: T0 + 1_000,
      })
    } finally {
      writer.close()
    }
  })

  it('writeMemory refuses invalid categories, empty content and reserved source types', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.writeMemory({ identity: OWN, category: 'NOPE', content: 'x' }))
        .toMatchObject({ ok: false, reason: 'invalid-category' })
      expect(writer.writeMemory({ identity: OWN, category: 'WORKFLOW_RULES', content: 'legacy category' }))
        .toMatchObject({ ok: false, reason: 'invalid-category' })
      expect(writer.writeMemory({ identity: OWN, category: 'NAMING', content: '   ' }))
        .toMatchObject({ ok: false, reason: 'empty-content' })
      expect(writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'reserved', sourceType: 'user' }))
        .toMatchObject({ ok: false, reason: 'source-type-reserved' })
      expect(writer.writeMemory({ identity: '', category: 'NAMING', content: 'no identity' }))
        .toMatchObject({ ok: false, reason: 'invalid-argument' })
      expect(writer.stats(OWN).rows).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('updateMemory rewrites content/category/importance and logs one update delta', () => {
    const path = createDb()
    const clock = { value: T0 }
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => clock.value })
    try {
      const id = createdId(writer.writeMemory({
        identity: OWN,
        category: 'ARCHITECTURE',
        content: 'old architecture note',
        importance: 40,
      }))
      // Simulate post-classify state so the resets that still fire are observable.
      run(path, "UPDATE memories SET shareable = 1, classified_at = 123, mural_cue = 'cue', mural_cue_hash = 'h', mural_cue_at = 5, mural_cue_rejection_count = 3 WHERE id = ?", id)
      run(path, "INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES(?, X'00', 'test-model')", id)
      // Both artefact tables now mirror the live contract, including the two
      // NOT NULL columns the fixture used to omit — an insert that only worked
      // because the fixture was lax proved nothing about the real store.
      run(path, "INSERT INTO memory_verifications(memory_id, file_path, verified_at, mapped_at, mapping_origin) VALUES(?, ?, 0, 0, 'test')", id, 'src/a.ts')

      clock.value = T0 + 60_000
      const updated = writer.updateMemory({
        identity: OWN,
        id,
        content: 'new architecture note',
        category: 'CONSTRAINTS',
        importance: 77,
      })
      expect(updated).toMatchObject({ ok: true, id })

      const row = writer.getMemory(OWN, id)
      expect(row).toMatchObject({
        content: 'new architecture note',
        category: 'CONSTRAINTS',
        importance: 77,
        normalizedHash: normalizedMemoryHash('new architecture note'),
        updatedAt: T0 + 60_000,
        // WP4 divergence from MC §4.3. The score-derived state still clears
        // (see the classified_at/mural_cue assertion below), but `shareable` is
        // now OURS to maintain: with no classify task left to re-score the row,
        // the reset would silently withdraw a shared memory from every other
        // project's view. `tests/memory-sharing.spec.ts` owns that contract.
        shareable: 1,
        seenCount: 1,
      })
      expect(one<Record<string, number | string | null>>(
        path,
        'SELECT classified_at, mural_cue, mural_cue_hash, mural_cue_at, mural_cue_rejection_count FROM memories WHERE id = ?',
        id,
      )).toEqual({
        classified_at: null,
        mural_cue: null,
        mural_cue_hash: null,
        mural_cue_at: null,
        mural_cue_rejection_count: 0,
      })
      // The update delta carries the new category and content, and nothing else.
      expect(query<Record<string, unknown>>(
        path,
        'SELECT mutation_type, target_memory_id, superseded_by_id, category, new_content FROM memory_mutation_log ORDER BY id',
      )).toEqual([{
        mutation_type: 'update',
        target_memory_id: id,
        superseded_by_id: null,
        category: 'CONSTRAINTS',
        new_content: 'new architecture note',
      }])
      // Content changes invalidate the classify/verify artefacts (§4.5).
      expect(count(path, 'SELECT COUNT(*) AS c FROM memory_embeddings')).toBe(0)
      expect(count(path, 'SELECT COUNT(*) AS c FROM memory_verifications')).toBe(0)
      expect(writer.stats(OWN).epoch).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('updateMemory refuses foreign, archived, unknown and duplicate targets', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const first = createdId(writer.writeMemory({ identity: OWN, category: 'ARCHITECTURE', content: 'first note' }))
      const second = createdId(writer.writeMemory({ identity: OWN, category: 'ARCHITECTURE', content: 'second note' }))
      const archived = createdId(writer.writeMemory({ identity: OWN, category: 'ARCHITECTURE', content: 'archived note' }))
      const foreign = seedMemory(path, { project: OTHER, category: 'ARCHITECTURE', content: 'foreign note' })

      expect(writer.updateMemory({ identity: OWN, id: 9_999, content: 'no such row' }))
        .toMatchObject({ ok: false, reason: 'not-found' })
      expect(writer.updateMemory({ identity: OWN, id: foreign, content: 'not mine' }))
        .toMatchObject({ ok: false, reason: 'not-owned' })
      expect(writer.updateMemory({ identity: OWN, id: second, content: 'first note' }))
        .toMatchObject({ ok: false, reason: 'duplicate' })
      expect(writer.updateMemory({ identity: OWN, id: first, content: '   ' }))
        .toMatchObject({ ok: false, reason: 'empty-content' })
      expect(writer.updateMemory({ identity: OWN, id: first, content: 'x', category: 'NOT_A_CATEGORY' }))
        .toMatchObject({ ok: false, reason: 'invalid-category' })
      expect(writer.updateMemory({ identity: OWN, id: first, content: 'x', category: 'WORKFLOW_RULES' }))
        .toMatchObject({ ok: false, reason: 'invalid-category' })

      writer.archiveMemory({ identity: OWN, id: archived })
      expect(writer.updateMemory({ identity: OWN, id: archived, content: 'resurrect' }))
        .toMatchObject({ ok: false, reason: 'archived-or-superseded' })

      // Only the archive is on the log: every refusal rolled back.
      expect(writer.stats(OWN).mutationLog).toBe(1)
      expect(writer.getMemory(OWN, first)?.content).toBe('first note')
      // The foreign row was never touched, and stays invisible to this project.
      expect(writer.getMemory(OTHER, foreign)?.content).toBe('foreign note')
    } finally {
      writer.close()
    }
  })

  it('archiveMemory stores the reason and appends the archive delta', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const id = createdId(writer.writeMemory({ identity: OWN, category: 'CONFIG_VALUES', content: 'the port was 8080' }))
      run(path, "UPDATE memories SET metadata_json = '{\"source\":\"dreamer\"}' WHERE id = ?", id)

      expect(writer.archiveMemory({ identity: OWN, id, reason: '  stale config  ' }))
        .toMatchObject({ ok: true, id })
      const row = writer.getMemory(OWN, id)
      expect(row?.status).toBe('archived')
      // `archive_reason` is merged over the existing object (contract §11.5).
      expect(JSON.parse(row!.metadataJson!)).toEqual({ source: 'dreamer', archive_reason: 'stale config' })

      expect(query<Record<string, unknown>>(
        path,
        'SELECT mutation_type, target_memory_id, superseded_by_id, category, new_content FROM memory_mutation_log ORDER BY id',
      )).toEqual([{
        mutation_type: 'archive',
        target_memory_id: id,
        superseded_by_id: null,
        category: null,
        new_content: null,
      }])

      // Re-archiving is refused and adds nothing.
      expect(writer.archiveMemory({ identity: OWN, id })).toMatchObject({ ok: false, reason: 'archived-or-superseded' })
      expect(writer.stats(OWN).mutationLog).toBe(1)
      // Archived rows stay visible to their own project's `get`.
      expect(writer.getMemory(OWN, id)?.status).toBe('archived')
    } finally {
      writer.close()
    }
  })

  it('archiveMemory can supersede, logging a superseded delta', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const canonical = createdId(writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'files use kebab-case' }))
      const redundant = createdId(writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'filenames are kebab-cased' }))

      expect(writer.archiveMemory({ identity: OWN, id: redundant, supersededBy: canonical }))
        .toMatchObject({ ok: true, id: redundant })
      expect(writer.getMemory(OWN, redundant)).toMatchObject({
        status: 'archived',
        supersededByMemoryId: canonical,
      })
      expect(query<Record<string, unknown>>(
        path,
        'SELECT mutation_type, target_memory_id, superseded_by_id FROM memory_mutation_log ORDER BY id',
      )).toEqual([{
        mutation_type: 'superseded',
        target_memory_id: redundant,
        superseded_by_id: canonical,
      }])
    } finally {
      writer.close()
    }
  })

  it('mergeMemory aggregates the canonical target and supersedes every source', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const target = seedMemory(path, {
        project: OWN,
        category: 'CONSTRAINTS',
        content: 'constraint A',
        seenCount: 2,
        retrievalCount: 1,
        updatedAt: T0 - 10,
      })
      const sourceB = seedMemory(path, {
        project: OWN,
        category: 'CONSTRAINTS',
        content: 'constraint B',
        seenCount: 3,
        retrievalCount: 2,
        status: 'permanent',
      })
      const sourceC = seedMemory(path, {
        project: OWN,
        category: 'CONSTRAINTS',
        content: 'constraint C',
        seenCount: 1,
        retrievalCount: 0,
        mergedFrom: JSON.stringify([99]),
      })

      const mergedFrom = [target, sourceB, sourceC, 99].sort((left, right) => left - right)
      const merged = writer.mergeMemory({
        identity: OWN,
        targetId: target,
        sourceIds: [sourceB, sourceC],
        content: 'constraint A + B + C',
      })
      expect(merged).toEqual({ ok: true, id: target, superseded: [sourceB, sourceC], mergedFrom })

      expect(writer.getMemory(OWN, target)).toMatchObject({
        content: 'constraint A + B + C',
        normalizedHash: normalizedMemoryHash('constraint A + B + C'),
        seenCount: 6,
        retrievalCount: 3,
        status: 'permanent',
        shareable: 0,
        mergedFrom: JSON.stringify(mergedFrom),
      })
      for (const source of [sourceB, sourceC]) {
        expect(writer.getMemory(OWN, source)).toMatchObject({
          status: 'archived',
          supersededByMemoryId: target,
        })
      }

      expect(query<Record<string, unknown>>(
        path,
        'SELECT mutation_type, target_memory_id, superseded_by_id, category, new_content FROM memory_mutation_log ORDER BY id',
      )).toEqual([
        { mutation_type: 'superseded', target_memory_id: sourceB, superseded_by_id: target, category: null, new_content: null },
        { mutation_type: 'superseded', target_memory_id: sourceC, superseded_by_id: target, category: null, new_content: null },
        { mutation_type: 'update', target_memory_id: target, superseded_by_id: null, category: 'CONSTRAINTS', new_content: 'constraint A + B + C' },
      ])
    } finally {
      writer.close()
    }
  })

  it('mergeMemory refuses cross-category, archived, foreign, duplicate and unknown ids', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const a = seedMemory(path, { project: OWN, category: 'CONSTRAINTS', content: 'constraint A' })
      const b = seedMemory(path, { project: OWN, category: 'NAMING', content: 'naming B' })
      const archived = seedMemory(path, { project: OWN, category: 'CONSTRAINTS', content: 'archived C', status: 'archived' })
      const foreign = seedMemory(path, { project: OTHER, category: 'CONSTRAINTS', content: 'foreign D' })

      expect(writer.mergeMemory({ identity: OWN, targetId: a, sourceIds: [b], content: 'cross' }))
        .toMatchObject({ ok: false, reason: 'category-mismatch' })
      expect(writer.mergeMemory({ identity: OWN, targetId: a, sourceIds: [b], content: 'cross', category: 'NAMING' }))
        .toMatchObject({ ok: false, reason: 'category-mismatch' })
      expect(writer.mergeMemory({ identity: OWN, targetId: a, sourceIds: [archived], content: 'revive' }))
        .toMatchObject({ ok: false, reason: 'archived-or-superseded' })
      expect(writer.mergeMemory({ identity: OWN, targetId: a, sourceIds: [foreign], content: 'foreign' }))
        .toMatchObject({ ok: false, reason: 'not-owned' })
      expect(writer.mergeMemory({ identity: OWN, targetId: a, sourceIds: [9_999], content: 'missing' }))
        .toMatchObject({ ok: false, reason: 'not-found' })
      expect(writer.mergeMemory({ identity: OWN, targetId: a, sourceIds: [a], content: 'self' }))
        .toMatchObject({ ok: false, reason: 'invalid-argument' })
      const source = seedMemory(path, { project: OWN, category: 'CONSTRAINTS', content: 'constraint E' })
      // A row outside the affected set already owns the merged content hash.
      seedMemory(path, { project: OWN, category: 'CONSTRAINTS', content: 'already here' })
      expect(writer.mergeMemory({ identity: OWN, targetId: a, sourceIds: [source], content: 'already here' }))
        .toMatchObject({ ok: false, reason: 'duplicate' })

      expect(writer.stats(OWN).mutationLog).toBe(0)
      expect(writer.getMemory(OWN, a)).toMatchObject({ content: 'constraint A', status: 'active' })
      expect(writer.getMemory(OWN, b)).toMatchObject({ content: 'naming B', status: 'active' })
    } finally {
      writer.close()
    }
  })

  it('getMemory and listMemories stay inside the project and the lifecycle', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const own = createdId(writer.writeMemory({ identity: OWN, category: 'ARCHITECTURE', content: 'own row' }))
      const archived = createdId(writer.writeMemory({ identity: OWN, category: 'ARCHITECTURE', content: 'archived row' }))
      writer.archiveMemory({ identity: OWN, id: archived })
      const foreign = seedMemory(path, { project: OTHER, category: 'ARCHITECTURE', content: 'foreign row' })
      seedMemory(path, { project: OWN, category: 'KNOWN_ISSUES', content: 'expired row', expiresAt: T0 - 1 })
      seedMemory(path, { project: OWN, category: 'NAMING', content: 'older own row', updatedAt: T0 - 100 })
      seedMemory(path, { project: OWN, category: 'NAMING', content: 'newer own row', updatedAt: T0 + 100 })

      expect(writer.getMemory(OWN, own)?.content).toBe('own row')
      expect(writer.getMemory(OWN, foreign)).toBeUndefined()
      expect(writer.getMemory(OTHER, foreign)?.content).toBe('foreign row')
      expect(writer.getMemory(OWN, 0)).toBeUndefined()
      expect(writer.getMemory(OWN, archived)?.status).toBe('archived')

      const listed = writer.listMemories(OWN, { now: T0 })
      expect(listed.map(row => row.content)).toEqual([
        'own row',
        'newer own row',
        'older own row',
      ])
      expect(listed.map(row => row.category)).toEqual(['ARCHITECTURE', 'NAMING', 'NAMING'])
      expect(listed.every(row => row.status === 'active')).toBe(true)

      expect(writer.listMemories(OWN, { now: T0, limit: 1 }).map(row => row.content)).toEqual(['own row'])
      expect(writer.listMemories(OWN, { now: T0, limit: 0 })).toEqual([])
      expect(writer.listMemories(OTHER, { now: T0 }).map(row => row.content)).toEqual(['foreign row'])
    } finally {
      writer.close()
    }
  })

  it('opens with busy_timeout, foreign_keys and WAL in that order', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, busyTimeoutMs: 250, now: () => T0 })
    try {
      // The status also reports the contract version it read (task-9's fence);
      // the open itself must still be a plain success.
      expect(writer.status).toMatchObject({ ok: true, contractVersion: SCHEMA_VERSION })
      expect(writer.status.readOnly).toBeUndefined()
      // WAL is database-level and persistent, so a separate connection sees it.
      expect(one<{ journal_mode: string }>(path, 'PRAGMA journal_mode')?.journal_mode).toBe('wal')
      // The other two are per-connection: assert §10.1's ORDER at the source.
      const positions = pragmaPositions()
      expect(positions.busyTimeout).toBeGreaterThanOrEqual(0)
      expect(positions.foreignKeys).toBeGreaterThan(positions.busyTimeout)
      expect(positions.journalMode).toBeGreaterThan(positions.foreignKeys)
    } finally {
      writer.close()
    }
  })

  it('works on a database without the authority, embedding or verification tables', () => {
    const path = createTrimmedDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(true)
      const id = createdId(writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'trimmed schema row' }))
      expect(writer.updateMemory({ identity: OWN, id, content: 'trimmed schema row, updated' }))
        .toMatchObject({ ok: true, id })
      expect(writer.getMemory(OWN, id)?.content).toBe('trimmed schema row, updated')
      expect(writer.stats(OWN).mutationLog).toBe(1)
    } finally {
      writer.close()
    }
  })

  it('returns an unavailable writer when the database does not exist', () => {
    const path = join(makeTempDir('mc-mw-missing-'), 'absent.db')
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger })
    try {
      expect(writer.status).toMatchObject({ ok: false })
      expect(writer.status.detail).toMatch(/not found/)
      expect(writer.writeMemory({ identity: OWN, category: 'NAMING', content: 'x' }))
        .toMatchObject({ ok: false, reason: 'unavailable' })
      expect(writer.updateMemory({ identity: OWN, id: 1, content: 'x' }))
        .toMatchObject({ ok: false, reason: 'unavailable' })
      expect(writer.archiveMemory({ identity: OWN, id: 1 }))
        .toMatchObject({ ok: false, reason: 'unavailable' })
      expect(writer.mergeMemory({ identity: OWN, targetId: 1, sourceIds: [2], content: 'x' }))
        .toMatchObject({ ok: false, reason: 'unavailable' })
      expect(writer.getMemory(OWN, 1)).toBeUndefined()
      expect(writer.listMemories(OWN)).toEqual([])
    } finally {
      writer.close()
    }
  })
})

describe('taxonomy helpers', () => {
  it('accepts exactly the v2 categories for agent writes', () => {
    for (const category of V2_MEMORY_CATEGORIES) {
      expect(isWritableMemoryCategory(category)).toBe(true)
    }
    for (const legacy of [
      'ARCHITECTURE_DECISIONS',
      'CONFIG_DEFAULTS',
      'USER_PREFERENCES',
      'USER_DIRECTIVES',
      'ENVIRONMENT',
      'WORKFLOW_RULES',
      'KNOWN_ISSUES',
      'not-a-category',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isWritableMemoryCategory(legacy)).toBe(false)
    }
    expect(normalizedMemoryHash('  Mixed   CASE  ')).toBe(normalizedMemoryHash('mixed case'))
  })
})
