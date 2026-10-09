/**
 * WP4 — this adapter owns `shareable`.
 *
 * MC clears `shareable` on every content change (§4.3), because its classify
 * judgement was scored against the OLD text. That is coherent only while MC's
 * classify task owns the flag and will re-score the row. From WP4 on there is no
 * classify task: without a restore, rewriting an org memory would drop it out of
 * every other project's view and rewriting a shared fact would quietly stop it
 * crossing projects — a withdrawal nobody asked for, with no error anywhere.
 *
 * The hazard is proved, not assumed: "the §4.3 reset really does clear it" runs
 * the reset statement itself and asserts the value goes to 0. Without that case
 * these tests would pass even if the reset never fired, i.e. even if the restore
 * were dead code.
 *
 * The other direction is the one that leaks, so it gets its own assertions: an
 * edit or a merge must NEVER promote a private row into a shared one.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizedMemoryHash, openMemoryWriter, sharingToRestore } from '../src/core/memory-write.ts'
import { makeMemoryDb } from './helpers/memory-db'

const OWN = 'git:1111111111111111111111111111111111111111'
const PARTNER = 'git:2222222222222222222222222222222222222222'
const ORG = 'dir:global:org'
const SCHEMA_VERSION = 94
const T0 = 1_700_000_000_000

const silentLogger = { info: () => {}, warn: () => {} }
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

function createDb(prefix = 'mc-share-'): string {
  const { path, dir } = makeMemoryDb({
    prefix, schemaVersion: SCHEMA_VERSION, mutationLog: true, projectState: true, fts: true,
  })
  tempDirs.push(dir)
  return path
}

function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

interface SeedRow {
  readonly project: string
  readonly content: string
  readonly category?: string
  readonly scope?: string
  readonly shareable?: number
  readonly status?: string
}

function seed(path: string, row: SeedRow): number {
  return withDb(path, db => Number(db.prepare(
    `INSERT INTO memories(
       project_path, category, content, normalized_hash, importance, scope, shareable,
       source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
       last_seen_at, status, expires_at, verification_status, superseded_by_memory_id, merged_from)
     VALUES(?, ?, ?, ?, 50, ?, ?, 'agent', 1, 0, 0, 0, 0, 0, ?, NULL, 'unverified', NULL, NULL)`,
  ).run(
    row.project,
    row.category ?? 'CONSTRAINTS',
    row.content,
    normalizedMemoryHash(row.content),
    row.scope ?? 'project',
    row.shareable ?? 0,
    row.status ?? 'active',
  ).lastInsertRowid))
}

interface SharingRow {
  readonly scope: string
  readonly shareable: number
  readonly content: string
}

function readRow(path: string, id: number): SharingRow | undefined {
  return withDb(path, db => db.prepare('SELECT scope, shareable, content FROM memories WHERE id = ?')
    .get(id) as SharingRow | undefined)
}

const writerFor = (path: string) => openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })

describe('sharingToRestore — the one-directional rule', () => {
  it('restores a row that was shared', () => {
    expect(sharingToRestore({ shareable: 1 })).toBe(1)
  })

  it('never promotes a row that was not shared', () => {
    // The leaking direction. An edit must not be able to widen visibility.
    expect(sharingToRestore({ shareable: 0 })).toBeUndefined()
  })

  it('treats an absent row as nothing to restore', () => {
    expect(sharingToRestore(undefined)).toBeUndefined()
    expect(sharingToRestore(null)).toBeUndefined()
  })
})

describe('the §4.3 reset really is a hazard (negative control)', () => {
  it('clears shareable on its own, so the restore is load-bearing', () => {
    const path = createDb('mc-share-hazard-')
    const id = seed(path, { project: ORG, content: 'org fact', scope: 'universe', shareable: 1 })
    expect(readRow(path, id)?.shareable).toBe(1)

    // The reset statement as MC writes it; if this ever stopped clearing the
    // flag, the restore below would be dead code and this test would say so.
    withDb(path, db => db.prepare(
      'UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ?, shareable = 0, classified_at = NULL WHERE id = ?',
    ).run('org fact v2', normalizedMemoryHash('org fact v2'), T0, id))
    expect(readRow(path, id)?.shareable).toBe(0)
  })
})

describe('update preserves sharing', () => {
  it('keeps a rewritten org row visible to the organisation', () => {
    const path = createDb()
    const id = seed(path, { project: ORG, content: 'org fact', scope: 'universe', shareable: 1 })
    const writer = writerFor(path)
    try {
      expect(writer.updateMemory({ identity: ORG, id, content: 'org fact, revised' }).ok).toBe(true)
    } finally {
      writer.close()
    }
    const row = readRow(path, id)
    expect(row?.content).toBe('org fact, revised')
    expect(row?.shareable).toBe(1)
    expect(row?.scope).toBe('universe')
  })

  it('leaves the rewritten row matching the foreign-visibility predicate', () => {
    const path = createDb('mc-share-visible-')
    const id = seed(path, { project: ORG, content: 'org fact', scope: 'universe', shareable: 1 })
    const writer = writerFor(path)
    try {
      writer.updateMemory({ identity: ORG, id, content: 'org fact, revised' })
    } finally {
      writer.close()
    }
    // The reader-side predicate from memory-bridge: a rewritten row must still
    // satisfy all four clauses, not just `shareable`.
    const visible = withDb(path, db => db.prepare(
      `SELECT COUNT(*) AS c FROM memories
        WHERE id = ? AND status = 'active' AND shareable = 1
          AND scope IN ('project','ecosystem','universe') AND project_path <> ?`,
    ).get(id, PARTNER) as { c: number })
    expect(visible.c).toBe(1)
  })

  it('never promotes a private row', () => {
    const path = createDb('mc-share-private-')
    const id = seed(path, { project: OWN, content: 'private fact', scope: 'project', shareable: 0 })
    const writer = writerFor(path)
    try {
      expect(writer.updateMemory({ identity: OWN, id, content: 'private fact, revised' }).ok).toBe(true)
    } finally {
      writer.close()
    }
    expect(readRow(path, id)?.shareable).toBe(0)
  })
})

describe('merge preserves sharing', () => {
  it('keeps a shared target shared', () => {
    const path = createDb('mc-share-merge-')
    const target = seed(path, { project: ORG, content: 'org canonical', scope: 'universe', shareable: 1 })
    const source = seed(path, { project: ORG, content: 'org duplicate', scope: 'project', shareable: 0 })
    const writer = writerFor(path)
    try {
      const result = writer.mergeMemory({
        identity: ORG,
        targetId: target,
        sourceIds: [source],
        content: 'org canonical, merged',
      })
      expect(result.ok).toBe(true)
    } finally {
      writer.close()
    }
    const row = readRow(path, target)
    expect(row?.content).toBe('org canonical, merged')
    expect(row?.shareable).toBe(1)
  })

  it('never promotes a private target, even when a shared row is absorbed', () => {
    const path = createDb('mc-share-merge-neg-')
    const target = seed(path, { project: OWN, content: 'private canonical', scope: 'project', shareable: 0 })
    const source = seed(path, { project: OWN, content: 'private duplicate', scope: 'project', shareable: 1 })
    const writer = writerFor(path)
    try {
      const result = writer.mergeMemory({
        identity: OWN,
        targetId: target,
        sourceIds: [source],
        content: 'private canonical, merged',
      })
      expect(result.ok).toBe(true)
    } finally {
      writer.close()
    }
    expect(readRow(path, target)?.shareable).toBe(0)
  })
})

describe('a refused write leaves no half state', () => {
  it('keeps content and sharing intact when the update is rejected as a duplicate', () => {
    const path = createDb('mc-share-rollback-')
    const id = seed(path, { project: ORG, content: 'org fact', scope: 'universe', shareable: 1 })
    seed(path, { project: ORG, content: 'org other fact' })
    const writer = writerFor(path)
    try {
      const result = writer.updateMemory({ identity: ORG, id, content: 'org other fact' })
      expect(result.ok).toBe(false)
    } finally {
      writer.close()
    }
    const row = readRow(path, id)
    // The transaction rolled back whole: the reset never happened either.
    expect(row?.content).toBe('org fact')
    expect(row?.shareable).toBe(1)
    expect(row?.scope).toBe('universe')
  })
})
