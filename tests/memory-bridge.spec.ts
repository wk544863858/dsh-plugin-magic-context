/**
 * Memory-bridge units: the read-only half of Magic Context's shared
 * `context.db`, against a synthetic database built from the documented
 * storage contract (schema_migrations fence, memories columns, sharing rules).
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMORY_SCHEMA_MAX_VERSION,
  defaultMemoryDbPath,
  directoryIdentity,
  openMemoryBridge,
  renderMemoryLine,
  resolveProjectIdentity,
} from '<path>'
import { makeMemoryDb as makeBareMemoryDb } from './helpers/memory-db'

const tempDirs: string[] = []

function makeDb(schemaVersion: number, rows: Array<{
  project: string
  category: string
  content: string
  importance?: number
  status?: string
  shareable?: number
  scope?: string
  expiresAt?: number | null
  updatedAt?: number
  lastSeenAt?: number
}>): string {
  const { path, dir } = makeBareMemoryDb({ prefix: 'mc-mem-', schemaVersion })
  tempDirs.push(dir)
  const db = new DatabaseSync(path)
  rows.forEach((row, index) => {
    db.prepare(
      `INSERT INTO memories(project_path, category, content, normalized_hash, importance, scope, shareable, status,
                            expires_at, first_seen_at, created_at, updated_at, last_seen_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.project,
      row.category,
      row.content,
      `hash-${index + 1}`,
      row.importance ?? 50,
      row.scope ?? 'project',
      row.shareable ?? 0,
      row.status ?? 'active',
      row.expiresAt ?? null,
      row.updatedAt ?? 1000,
      row.updatedAt ?? 1000,
      row.updatedAt ?? 1000,
      row.lastSeenAt ?? row.updatedAt ?? 1000,
    )
  })
  db.close()
  return path
}

const silentLogger = { info: () => {}, warn: () => {} }

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* OS temp sweep covers residue */
    }
  }
})

describe('memory bridge (read-only recall)', () => {
  it('recalls own rows by identity, skipping expired and archived ones', () => {
    const path = makeDb(94, [
      { project: 'git:mine', category: 'ARCHITECTURE', content: 'layered modules', importance: 60 },
      { project: 'git:mine', category: 'PROJECT_RULES', content: 'always format', importance: 90, status: 'permanent' },
      { project: 'git:mine', category: 'CONSTRAINTS', content: 'stale one', expiresAt: 500 },
      { project: 'git:mine', category: 'CONSTRAINTS', content: 'archived one', status: 'archived' },
      { project: 'git:other', category: 'CONSTRAINTS', content: 'foreign private' },
    ])
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    try {
      expect(bridge.status.ok).toBe(true)
      expect(bridge.status.schemaVersion).toBe(94)
      const recall = bridge.recall({ project: 'git:mine', budgetTokens: 8000, limit: 40, now: 1000 })
      expect(recall).toBeDefined()
      const contents = recall!.rows.map(row => row.content)
      expect(contents).toContain('layered modules')
      expect(contents).toContain('always format')
      expect(contents).not.toContain('stale one')
      expect(contents).not.toContain('archived one')
      expect(contents).not.toContain('foreign private')
      // priority: permanent first
      expect(recall!.rows[0]!.content).toBe('always format')
      // digest identity changes with the row set
      expect(recall!.digest).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      bridge.close()
    }
  })

  it('includes workspace-shared rows only for whitelisted categories', () => {
    const path = makeDb(94, [
      { project: 'git:mine', category: 'ARCHITECTURE', content: 'own row' },
      { project: 'git:sibling', category: 'CONSTRAINTS', content: 'shared constraint', shareable: 1 },
      { project: 'git:sibling', category: 'PROJECT_RULES', content: 'not whitelisted', shareable: 1 },
      { project: 'git:sibling', category: 'CONSTRAINTS', content: 'not shared', shareable: 0 },
    ])
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    try {
      const recall = bridge.recall({
        project: 'git:mine',
        workspaceProjects: ['git:sibling'],
        shareCategories: ['CONSTRAINTS'],
        budgetTokens: 8000,
        limit: 40,
        now: 1000,
      })
      const contents = recall!.rows.map(row => row.content)
      expect(contents).toContain('own row')
      expect(contents).toContain('shared constraint')
      expect(contents).not.toContain('not whitelisted')
      expect(contents).not.toContain('not shared')
    } finally {
      bridge.close()
    }
  })

  it('honors the token budget and the row limit', () => {
    const path = makeDb(94, Array.from({ length: 5 }, (_unused, index) => ({
      project: 'git:mine',
      category: 'CONSTRAINTS',
      content: `constraint ${index} ${'x'.repeat(200)}`,
      importance: 50,
    })))
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    try {
      const limited = bridge.recall({ project: 'git:mine', budgetTokens: 8000, limit: 2, now: 1000 })
      expect(limited!.rows.length).toBe(2)
      const budgeted = bridge.recall({ project: 'git:mine', budgetTokens: 60, limit: 40, now: 1000 })
      expect(budgeted!.rows.length).toBe(1)
    } finally {
      bridge.close()
    }
  })

  it('filters by keyword for the ctx_memory tool', () => {
    const path = makeDb(94, [
      { project: 'git:mine', category: 'CONFIG_VALUES', content: 'the port is 8080' },
      { project: 'git:mine', category: 'NAMING', content: 'files use kebab-case' },
    ])
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    try {
      const recall = bridge.recall({ project: 'git:mine', budgetTokens: 8000, limit: 40, now: 1000, query: 'PORT' })
      expect(recall!.rows.map(row => row.content)).toEqual(['the port is 8080'])
      expect(bridge.recall({ project: 'git:mine', budgetTokens: 8000, limit: 40, now: 1000, query: 'nothing' }))
        .toBeUndefined()
    } finally {
      bridge.close()
    }
  })

  it('fails closed on a newer schema and on a missing database', () => {
    const newer = makeDb(MEMORY_SCHEMA_MAX_VERSION + 1, [{ project: 'git:mine', category: 'CONSTRAINTS', content: 'x' }])
    const blocked = openMemoryBridge({ dbPath: newer, logger: silentLogger })
    try {
      expect(blocked.status.ok).toBe(false)
      expect(blocked.status.detail).toMatch(/newer than the adapter understands/)
      expect(blocked.recall({ project: 'git:mine', budgetTokens: 10, limit: 1, now: 0 })).toBeUndefined()
    } finally {
      blocked.close()
    }
    const missing = openMemoryBridge({ dbPath: join(tmpdir(), 'mc-mem-does-not-exist', 'context.db'), logger: silentLogger })
    expect(missing.status.ok).toBe(false)
    expect(missing.status.detail).toMatch(/not found/)
    missing.close()
  })

  it('matches a directory through the identity fallback and renders lines', () => {
    const dir = join(tmpdir(), 'Some Project')
    const path = makeDb(94, [{ project: directoryIdentity(dir), category: 'CONSTRAINTS', content: 'dir identified' }])
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    try {
      const recall = bridge.recall({ project: dir, budgetTokens: 8000, limit: 40, now: 1000 })
      expect(recall!.rows.map(row => row.content)).toEqual(['dir identified'])
      expect(renderMemoryLine(recall!.rows[0]!)).toBe('- [CONSTRAINTS] dir identified')
      expect(recall!.lines[0]).toContain('dir identified')
    } finally {
      bridge.close()
    }
  })

  it('defaults the path into the CortexKit data directory', () => {
    expect(defaultMemoryDbPath()).toMatch(/cortexkit[\\/]magic-context[\\/]context\.db$/)
  })

  it('hashes directories exactly like Magic Context (path.resolve, no separator rewrite)', () => {
    const directory = join(tmpdir(), 'Identity Project')
    const canonical = resolve(directory)
    const expected = `dir:${createHash('md5').update(canonical, 'utf8').digest('hex').slice(0, 12)}`
    expect(directoryIdentity(directory)).toBe(expected)
    // The regression this guards: a forward-slash canonicalisation produces a
    // different digest on Windows and silently orphans non-git memories.
    const wrong = `dir:${createHash('md5').update(canonical.replace(/\\/g, '/'), 'utf8').digest('hex').slice(0, 12)}`
    if (canonical.includes('\\')) expect(directoryIdentity(directory)).not.toBe(wrong)
  })

  it('resolves git identities and falls back to the directory hash', () => {
    // The harness checkout is a git repository (or a plain directory: both are
    // valid outcomes, but the two must never be confused).
    const repo = resolve(process.cwd())
    const identity = resolveProjectIdentity(repo)
    if (identity.startsWith('git:')) {
      expect(identity).toMatch(/^git:[0-9a-f]{40}$/)
    } else {
      expect(identity).toBe(directoryIdentity(repo))
    }
    const bare = mkdtempSync(join(tmpdir(), 'mc-mem-nogit-'))
    tempDirs.push(bare)
    expect(resolveProjectIdentity(bare)).toBe(directoryIdentity(bare))
  })

  it('pulls workspace peers and the workspace share policy out of the database', () => {
    const mine = 'git:mine0000000000000000000000000000000000'
    const peer = 'git:peer0000000000000000000000000000000000'
    const path = makeDbWorkspaced({
      ownRows: [
        { project: mine, category: 'ARCHITECTURE', content: 'own architecture' },
        { project: mine, category: 'CONSTRAINTS', content: 'own constraint' },
      ],
      peerRows: [
        { project: peer, category: 'CONSTRAINTS', content: 'peer constraint', shareable: 1 },
        { project: peer, category: 'ARCHITECTURE', content: 'peer architecture', shareable: 1 },
      ],
      workspace: { name: 'code', shareCategories: ['CONSTRAINTS'], members: [mine, peer] },
    })
    const bridge = openMemoryBridge({ dbPath: path, logger: silentLogger })
    try {
      // No workspaceProjects in the request: membership and the category
      // whitelist come from Magic Context's own tables.
      const recall = bridge.recall({ project: mine, budgetTokens: 8000, limit: 40, now: 1000 })
      const contents = recall!.rows.map(row => row.content)
      expect(contents).toContain('own architecture')
      expect(contents).toContain('peer constraint')
      expect(contents).not.toContain('peer architecture')
      expect(recall!.workspace).toBe('code')
      expect(recall!.members).toEqual([peer])
      expect(recall!.identity).toBe(mine)
    } finally {
      bridge.close()
    }
  })
})

/**
 * A shared database with Magic Context's workspace tables, so the adapter's
 * membership-derived sharing can be exercised without hand-listing peers.
 */
function makeDbWorkspaced(input: {
  ownRows: Array<{ project: string; category: string; content: string; shareable?: number }>
  peerRows: Array<{ project: string; category: string; content: string; shareable?: number }>
  workspace: { name: string; shareCategories: string[]; members: string[] }
}): string {
  const { path, dir } = makeBareMemoryDb({ prefix: 'mc-mem-ws-', schemaVersion: 94, workspaces: true })
  tempDirs.push(dir)
  const db = new DatabaseSync(path)
  const insert = db.prepare(
    `INSERT INTO memories(project_path, category, content, normalized_hash, scope, shareable, status,
                          first_seen_at, created_at, updated_at, last_seen_at)
     VALUES(?, ?, ?, ?, 'project', ?, 'active', 1000, 1000, 1000, 1000)`,
  )
  for (const [index, row] of [...input.ownRows, ...input.peerRows].entries()) {
    insert.run(row.project, row.category, row.content, `hash-${index + 1}`, row.shareable ?? 0)
  }
  db.prepare('INSERT INTO workspaces(id, name, share_categories, created_at, updated_at) VALUES(1, ?, ?, 0, 0)')
    .run(input.workspace.name, JSON.stringify(input.workspace.shareCategories))
  for (const member of input.workspace.members) {
    db.prepare('INSERT INTO workspace_members(workspace_id, project_path, added_at) VALUES(1, ?, 0)').run(member)
  }
  db.close()
  return path
}
