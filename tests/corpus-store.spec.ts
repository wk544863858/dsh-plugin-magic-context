/**
 * Own-corpus bootstrap (cutover 2026-10-13): the plugin's memory database is
 * created and owned by the adapter — upstream MC's `context.db` is never
 * opened again. These specs pin the three things the cutover stands on:
 *
 *  ① a fresh machine gets a COMPLETE corpus: every table and trigger the
 *    five openers touch (bridge / writer / profile writer / search /
 *    vector lane), plus the version row the fence reads;
 *  ② the created store is USABLE end to end: recall reads it, the writer
 *    writes and reads back through the FTS triggers, the profile writer
 *    round-trips a candidate;
 *  ③ an existing file is never touched — and a corpus NEWER than this build
 *    still fences (own lineage now: a future v96 row can only be ours).
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORPUS_IMPORT_MARKER_VERSION,
  CORPUS_SCHEMA_VERSION,
  ensureOwnCorpusStore,
} from '../src/core/corpus-store.ts'
import { openMemoryBridge } from '../src/core/memory-bridge.ts'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { openProfileWriter } from '../src/core/profile-write.ts'

const tempDirs: string[] = []
const logs: string[] = []
const silentLogger = { info: () => {}, warn: (message: string) => { logs.push(message) } }

function freshCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-corpus-'))
  tempDirs.push(dir)
  return join(dir, 'memories.db')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows: a leaked WAL handle keeps the dir locked — the temp dir is
        // disposable; leave it to the OS temp cleaner rather than failing.
      }
    }
  }
})

describe('ensureOwnCorpusStore', () => {
  it('creates the complete corpus schema with the version row the fence reads', () => {
    const path = freshCorpus()
    const result = ensureOwnCorpusStore(path)
    expect(result.outcome).toBe('created')
    expect(result.detail).toBe(`v${String(CORPUS_SCHEMA_VERSION)}`)

    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map(row => row.name),
      )
      for (const required of [
        'schema_migrations', 'memories', 'memories_fts', 'memory_embeddings',
        'memory_mutation_log', 'project_state', 'user_memories', 'user_memory_candidates',
      ]) {
        expect(tables.has(required), `table ${required}`).toBe(true)
      }
      // Upstream subsystems the openers never touch stay ABSENT — the honest
      // break: no workspaces, no authority guards, no tags/session_meta.
      for (const absent of ['workspaces', 'workspace_members', 'authority_managed', 'tags', 'session_meta']) {
        expect(tables.has(absent), `table ${absent} must not exist`).toBe(false)
      }
      const triggers = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>)
          .map(row => row.name),
      )
      for (const required of ['memories_ai', 'memories_ad', 'memories_au']) {
        expect(triggers.has(required), `trigger ${required}`).toBe(true)
      }
      const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000').get() as { v: number }
      expect(version.v).toBe(CORPUS_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('never touches an existing file, and replaces a 0-byte residue', () => {
    const path = freshCorpus()
    writeFileSync(path, 'not a database', 'utf8')
    expect(ensureOwnCorpusStore(path).outcome).toBe('exists')
    const residue = freshCorpus()
    writeFileSync(residue, '', 'utf8')
    expect(ensureOwnCorpusStore(residue).outcome).toBe('repaired-empty')
    const db = new DatabaseSync(residue, { readOnly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM memories').get()).toMatchObject({ c: 0 })
    } finally {
      db.close()
    }
  })
})

describe('the created corpus is usable end to end', () => {
  it('bridge recalls, writer promotes through the FTS triggers, profile writer round-trips', () => {
    const path = freshCorpus()
    ensureOwnCorpusStore(path)

    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    expect(bridge.status.ok).toBe(true)
    // An empty corpus recalls nothing — undefined or zero rows, never a throw.
    const before = bridge.recall({ project: 'git:corpus', budgetTokens: 4000, limit: 40, now: 1_700_000_000_000 })
    expect(before === undefined || before.rows.length === 0).toBe(true)

    let writer: ReturnType<typeof openMemoryWriter> | undefined
    let profile: ReturnType<typeof openProfileWriter> | undefined
    try {
      writer = openMemoryWriter({ dbPath: path, logger: silentLogger })
      expect(writer.status.ok).toBe(true)
      expect(writer.status.readOnly).toBeFalsy()
      const promoted = writer.promoteFacts({
        identity: 'git:corpus',
        facts: [{ category: 'CONSTRAINTS', content: 'corpus corpus-check 事实', importance: 50 }],
        sessionId: 'spec',
      })
      expect(promoted.inserted.length).toBe(1)

      const db = new DatabaseSync(path, { readOnly: true })
      try {
        // The insert trigger populated the external-content FTS index.
        const fts = db.prepare("SELECT count(*) AS c FROM memories_fts WHERE memories_fts MATCH 'corpus'").get() as { c: number }
        expect(fts.c).toBe(1)
      } finally {
        db.close()
      }

      const recallAfter = bridge.recall({ project: 'git:corpus', budgetTokens: 4000, limit: 40, now: 1_700_000_001_000 })
      expect(recallAfter?.rows.map(row => row.content)).toContain('corpus corpus-check 事实')

      profile = openProfileWriter({ dbPath: path, logger: silentLogger })
      expect(profile.status.ok).toBe(true)
      expect(profile.recordCandidates({
        sessionId: 'spec',
        observations: ['用户偏好画像行'],
      }).inserted).toBe(1)
    } finally {
      bridge.close()
      writer?.close()
      profile?.close()
    }
  })

  it('a corpus versioned past this build still fences the writer read-only', () => {
    const path = freshCorpus()
    ensureOwnCorpusStore(path)
    const bump = new DatabaseSync(path)
    try {
      bump.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)')
        .run(CORPUS_SCHEMA_VERSION + 1, 'future-own-migration', 0)
    } finally {
      bump.close()
    }

    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger })
    expect(writer.status.ok).toBe(true)
    expect(writer.status.readOnly).toBe(true)
    const refused = writer.writeMemory({
      identity: 'git:corpus',
      category: 'CONSTRAINTS',
      content: 'must be refused',
    })
    expect(refused.ok).toBe(false)

    // The import marker lane (>= 10000) never influences the fence.
    const marker = new DatabaseSync(path)
    try {
      marker.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)')
        .run(CORPUS_IMPORT_MARKER_VERSION, 'corpus-imported-from-legacy-context-db', 1_700_000_000_000)
    } finally {
      marker.close()
    }
    const writerAfterMarker = openMemoryWriter({ dbPath: path, logger: silentLogger })
    expect(writerAfterMarker.status.readOnly).toBe(true)
    writerAfterMarker.close()
    writer.close()
  })
})
