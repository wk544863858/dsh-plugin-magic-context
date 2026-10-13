/**
 * Workspace → domain import (WP2).
 *
 * The import is the one place where data crosses from the frozen contract into
 * the adapter's own domain table, so the assertions are about the properties
 * that make it safe to run: it is idempotent, it is reversible, it refuses
 * ambiguous input rather than guessing, it refuses identities that would never
 * match at activation time, and — importantly — it does NOT switch the domain
 * on. Moving data and enabling behaviour must stay separate acts.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores } from '../src/index.ts'
import {
  ORG_DOMAIN_ID,
  WORKSPACE_IMPORT_META_KEY,
  importWorkspacePlan,
  readWorkspacePlan,
  rollbackWorkspaceImport,
  summarizePlan,
  workspacePlanFingerprint,
} from '../src/core/domain-import.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/mc-import-workspace.mjs', import.meta.url))

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-import-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const NOW = 1_700_000_000_000

function makeContract(path: string, workspaces: Array<{ name: string; members: string[] }>): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE workspaces(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
      );
      CREATE TABLE workspace_members(
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        display_path TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, project_path)
      );
    `)
    const insertWorkspace = db.prepare(
      'INSERT INTO workspaces(name, created_at, updated_at, share_categories) VALUES(?, ?, ?, ?)',
    )
    const insertMember = db.prepare(
      'INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES(?, ?, ?, ?, ?)',
    )
    for (const workspace of workspaces) {
      const id = Number(insertWorkspace.run(workspace.name, 1, 1, '["CONSTRAINTS"]').lastInsertRowid)
      for (const identity of workspace.members) {
        insertMember.run(id, identity, identity.slice(-8), `/code/${identity.slice(-6)}`, 1)
      }
    }
  } finally {
    db.close()
  }
}

describe('readWorkspacePlan', () => {
  it('takes the only workspace when none is named', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [{ name: 'code', members: ['git:aaa', 'git:bbb'] }])
    const plan = readWorkspacePlan(contract)
    expect(plan.workspaceName).toBe('code')
    expect(plan.members.map(m => m.identity)).toEqual(['git:aaa', 'git:bbb'])
  })

  it('refuses to guess between several workspaces', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [
      { name: 'code', members: ['git:aaa'] },
      { name: 'personal', members: ['git:zzz'] },
    ])
    expect(() => readWorkspacePlan(contract)).toThrow(/name one with --workspace/)
    expect(readWorkspacePlan(contract, 'personal').members.map(m => m.identity)).toEqual(['git:zzz'])
    expect(() => readWorkspacePlan(contract, 'nope')).toThrow(/no workspace named/)
  })

  it('refuses an empty contract', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [])
    expect(() => readWorkspacePlan(contract)).toThrow(/no workspaces/)
  })
})

describe('importWorkspacePlan', () => {
  it('creates the org domain DISABLED, with its members and a fingerprint', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [{ name: 'code', members: ['git:aaa', 'git:bbb', 'git:ccc'] }])
    const plan = readWorkspacePlan(contract)
    const store = openStores(join(dir, 'adapter'))
    try {
      const result = importWorkspacePlan(store, plan, { now: NOW })
      expect(result.domainId).toBe(ORG_DOMAIN_ID)
      expect(result.membersAfter).toBe(3)
      expect(result.changed).toBe(true)
      // Importing is not enabling.
      expect(store.getDomain(ORG_DOMAIN_ID)?.enabled).toBe(false)
      // Birth allowlist is the explicit org default, not the dormant
      // workspace's fail-closed inherit — symmetric with machine.
      expect([...(store.getDomain(ORG_DOMAIN_ID)?.shareCategories ?? [])].sort())
        .toEqual(['ARCHITECTURE', 'CONFIG_VALUES', 'CONSTRAINTS'])
      expect(store.activeDomainIdentities('git:aaa')).toEqual([])
      expect(store.getMeta(WORKSPACE_IMPORT_META_KEY)).toBe(workspacePlanFingerprint(plan))
    } finally {
      store.close()
    }
  })

  it('is idempotent: a re-run adds nothing and reports changed=false', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [{ name: 'code', members: ['git:aaa', 'git:bbb'] }])
    const plan = readWorkspacePlan(contract)
    const store = openStores(join(dir, 'adapter'))
    try {
      importWorkspacePlan(store, plan, { now: NOW, enable: true })
      const second = importWorkspacePlan(store, plan, { now: NOW + 1, enable: true })
      expect(second.membersBefore).toBe(2)
      expect(second.membersAfter).toBe(2)
      expect(second.changed).toBe(false)
      expect(store.listDomainMembers(ORG_DOMAIN_ID)).toHaveLength(2)
      // With --enable the domain really does activate.
      expect(store.activeDomainIdentities('git:aaa').map(d => d.kind)).toEqual(['org'])
    } finally {
      store.close()
    }
  })

  it('rolls back cleanly and can be re-imported', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [{ name: 'code', members: ['git:aaa', 'git:bbb'] }])
    const plan = readWorkspacePlan(contract)
    const store = openStores(join(dir, 'adapter'))
    try {
      importWorkspacePlan(store, plan, { now: NOW, enable: true })
      expect(rollbackWorkspaceImport(store, NOW + 1)).toBe(2)
      expect(store.listDomainMembers(ORG_DOMAIN_ID)).toEqual([])
      expect(store.getDomain(ORG_DOMAIN_ID)?.enabled).toBe(false)
      expect(store.getMeta(WORKSPACE_IMPORT_META_KEY)).toBe('')
      const again = importWorkspacePlan(store, plan, { now: NOW + 2 })
      expect(again.changed).toBe(true)
      expect(again.membersAfter).toBe(2)
    } finally {
      store.close()
    }
  })

  it('refuses a member with an empty identity', () => {
    const dir = tempDir()
    const store = openStores(join(dir, 'adapter'))
    try {
      expect(() => importWorkspacePlan(
        store,
        { workspaceId: 1, workspaceName: 'code', shareCategories: [], members: [{ identity: '  ', displayName: 'x', displayPath: 'x' }] },
        { now: NOW },
      )).toThrow(/empty identity/)
    } finally {
      store.close()
    }
  })
})

describe('summarizePlan', () => {
  it('classifies identities by prefix so a dry run can refuse bare paths', () => {
    expect(summarizePlan({
      workspaceId: 1,
      workspaceName: 'code',
      shareCategories: [],
      members: [
        { identity: 'git:a', displayName: '', displayPath: '' },
        { identity: 'dir:b', displayName: '', displayPath: '' },
        { identity: 'E:/raw/path', displayName: '', displayPath: '' },
      ],
    })).toEqual({ total: 3, git: 1, dir: 1, other: 1 })
  })
})

describe('mc-import-workspace CLI', () => {
  it('dry-runs without writing, then imports for real', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [{ name: 'code', members: ['git:aaa', 'git:bbb'] }])
    const adapterDir = join(dir, 'adapter')

    const dry = spawnSync(
      process.execPath,
      [SCRIPT, '--dry-run', '--db', contract, '--data-dir', adapterDir],
      { encoding: 'utf8' },
    )
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain('dry run: nothing written')
    expect(existsSync(join(adapterDir, 'dsh-magic-context.db'))).toBe(false)

    const real = spawnSync(process.execPath, [SCRIPT, '--db', contract, '--data-dir', adapterDir], { encoding: 'utf8' })
    expect(real.status).toBe(0)
    expect(real.stdout).toContain('changed=true')
    expect(existsSync(join(adapterDir, 'dsh-magic-context.db'))).toBe(true)

    const store = openStores(adapterDir)
    try {
      expect(store.listDomainMembers(ORG_DOMAIN_ID)).toHaveLength(2)
      expect(store.getDomain(ORG_DOMAIN_ID)?.enabled).toBe(false)
    } finally {
      store.close()
    }

    const rollback = spawnSync(
      process.execPath,
      [SCRIPT, '--rollback', '--db', contract, '--data-dir', adapterDir],
      { encoding: 'utf8' },
    )
    expect(rollback.status).toBe(0)
    expect(rollback.stdout).toContain('removed 2 member(s)')
  })

  it('refuses a bare-path identity instead of importing something that can never activate', () => {
    const dir = tempDir()
    const contract = join(dir, 'contract.db')
    makeContract(contract, [{ name: 'code', members: ['git:aaa', '<path>'] }])
    const run = spawnSync(
      process.execPath,
      [SCRIPT, '--db', contract, '--data-dir', join(dir, 'adapter')],
      { encoding: 'utf8' },
    )
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('refusing to import bare-path identities')
  })
})
