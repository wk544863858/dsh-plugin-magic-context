/**
 * D1 — the fresh-machine contract-store bootstrap.
 *
 * Distribution shape: an offline tgz onto machines WITHOUT upstream Magic
 * Context. Until now that machine got a silently dead memory lane (0-byte
 * store, no fence, no tables). These specs walk the four shapes the opener can
 * meet: nothing there (bootstrap), a real store (hands off), a 0-byte residue
 * (replace), a foreign database (hands off) — plus the end-to-end proof that a
 * bootstrapped store is writable through the REAL writer.
 */
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureContractStore } from '../src/core/contract-bootstrap.ts'
import { openMemoryWriter } from '../src/core/memory-write.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-boot-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function tableNames(path: string): Set<string> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all().map(r => String(r.name)),
    )
  } finally {
    db.close()
  }
}

describe('ensureContractStore', () => {
  it('bootstraps a missing store (nested path included) into a v94 contract shape', () => {
    const target = join(tempDir(), 'cortexkit', 'magic-context', 'context.db')
    const result = ensureContractStore(target)
    expect(result.outcome).toBe('bootstrapped')
    expect(result.detail).toBe('v94')

    const tables = tableNames(target)
    expect(tables.has('memories')).toBe(true)
    expect(tables.has('user_memories')).toBe(true)
    expect(tables.has('user_memory_candidates')).toBe(true)
    expect(tables.has('memory_embeddings')).toBe(true)
    expect(tables.has('schema_migrations')).toBe(true)
    const db = new DatabaseSync(target, { readOnly: true })
    try {
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(94)
      // the authority guard trio ships as part of the contract shape
      const triggers = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()?.n
      expect(Number(triggers)).toBeGreaterThanOrEqual(3)
    } finally {
      db.close()
    }
  })

  it('writes through the REAL writer on a bootstrapped store', () => {
    const target = join(tempDir(), 'context.db')
    expect(ensureContractStore(target).outcome).toBe('bootstrapped')
    const writer = openMemoryWriter({ dbPath: target })
    try {
      expect(writer.status.ok).toBe(true)
      const result = writer.writeMemory({
        identity: 'git:bootstrap-test',
        category: 'ARCHITECTURE',
        content: 'the fresh-machine lane works end to end',
      })
      expect(result.ok).toBe(true)
      const row = writer.getMemory('git:bootstrap-test', result.id)
      expect(row?.content).toContain('fresh-machine')
    } finally {
      writer.close()
    }
  })

  it('never touches an existing store, whatever its shape', () => {
    const target = join(tempDir(), 'context.db')
    // A foreign database with one unrelated table.
    const foreign = new DatabaseSync(target)
    foreign.exec('CREATE TABLE totally_unrelated(id INTEGER)')
    foreign.prepare('INSERT INTO totally_unrelated(id) VALUES(7)').run()
    foreign.close()
    const before = statSync(target)

    const result = ensureContractStore(target)
    expect(result.outcome).toBe('exists')
    expect(statSync(target).size).toBe(before.size)
    expect(tableNames(target).has('totally_unrelated')).toBe(true)
  })

  it('replaces a 0-byte residue left by a failed opener', () => {
    const target = join(tempDir(), 'context.db')
    writeFileSync(target, '')
    expect(statSync(target).size).toBe(0)

    const result = ensureContractStore(target)
    expect(result.outcome).toBe('repaired-empty')
    expect(tableNames(target).has('memories')).toBe(true)
  })
})
