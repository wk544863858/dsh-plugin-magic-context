/**
 * Org-domain candidates (WP9, the half that writes nothing shared).
 *
 * The plan's source for org knowledge was a recurrence scan: "the same
 * normalized hash in two projects". Measured on the live store that source is
 * empty (1292 active rows / 33 projects / 0 shared hashes), so the scan is kept
 * as a MEASUREMENT and the working source is a human promotion. Both are tested
 * here, together with the two gates that protect the shared store: credential
 * shapes never cross a project boundary, and a category outside the domain's
 * allowlist is refused at approval time rather than published into invisibility.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores } from '../src/index.ts'
import { makeMemoryDb } from './helpers/memory-db.ts'
import { defaultDomainCap } from '../src/core/domains.ts'
import {
  ORG_DOMAIN_ID,
  approvalGate,
  detectGlobalCandidates,
  promoteMemoryToCandidate,
  readCorpusMemory,
  scanForCredentials,
} from '../src/core/global-domains.ts'

const NOW = 1_700_000_000_000
const dirs: string[] = []
const opened: Array<{ close(): void }> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-org-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (opened.length > 0) {
    try {
      opened.pop()!.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {
      // never mask the assertion that failed
    }
  }
})

function makeStore(enabled = false, shareCategories: readonly string[] = ['CONSTRAINTS', 'ARCHITECTURE']) {
  const store = openStores(tempDir())
  opened.push(store)
  store.upsertDomain(
    { domainId: ORG_DOMAIN_ID, kind: 'org', enabled, budgetTokens: 768, cap: defaultDomainCap('org'), shareCategories },
    NOW,
  )
  return store
}

interface MemorySeed {
  id: number
  projectPath: string
  content: string
  category?: string
  normalizedHash?: string
  status?: string
}

function makeContract(rows: MemorySeed[]): string {
  const created = makeMemoryDb({ prefix: 'mc-org-contract-', schemaVersion: 94 })
  dirs.push(created.dir)
  const db = new DatabaseSync(created.path)
  try {
    const insert = db.prepare(
      'INSERT INTO memories(id, project_path, category, content, normalized_hash, scope, shareable, '
        + 'first_seen_at, created_at, updated_at, last_seen_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const row of rows) {
      insert.run(
        row.id,
        row.projectPath,
        row.category ?? 'ARCHITECTURE',
        row.content,
        row.normalizedHash ?? `hash-${String(row.id)}`,
        'project',
        0,
        1,
        1,
        1,
        1,
        row.status ?? 'active',
      )
    }
  } finally {
    db.close()
  }
  return created.path
}

describe('credential shapes never cross a project boundary', () => {
  it('flags assignments, url userinfo, key headers and known prefixes', () => {
    expect(scanForCredentials('DB_PASSWORD=hunter2')).toContain('assign:password')
    expect(scanForCredentials('api_key: sk-abcdefghijklmnopqrstuvwx')).toContain('assign:api-key')
    expect(scanForCredentials('postgres://user:pw@host:5432/db')).toContain('url-userinfo')
    expect(scanForCredentials('-----BEGIN RSA PRIVATE KEY-----')).toContain('pem:private-key')
    expect(scanForCredentials('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('prefix:github')
    expect(scanForCredentials('AKIAIOSFODNN7EXAMPLE')).toContain('prefix:aws')
  })

  it('does not fire on the digests and paths this corpus is full of', () => {
    // The negative control that makes the rule usable: a rule that flagged long
    // hex would block nearly every real candidate.
    const ordinary = [
      'git:93eea8cdeebd2eb57f476137abf32fa0c42cd3f5 的 HEAD 是 70418d40c，契约摘要 8bd1476f9a07…',
      '共享库位于 C:\\Users\\<user>\\.local\\share\\cortexkit\\magic-context\\context.db（v94 只读）',
      'session-you need to check whether the guard fires before the recall lane runs',
      '「必须先在 plan 模式内讨论」是用户的流程要求',
      'pin memory #1298 / docs/memory-mechanisms-inventory-2026-10-09.md',
    ]
    for (const text of ordinary) expect(scanForCredentials(text), text).toEqual([])
  })
})

describe('the recurrence scan (a measurement, not the source)', () => {
  it('finds a hash seen in two different projects and records both observations', () => {
    const store = makeStore()
    const contract = makeContract([
      { id: 1, projectPath: 'git:alpha', content: 'DB access goes through the bastion', normalizedHash: 'shared' },
      { id: 2, projectPath: 'git:beta', content: 'DB access goes through the bastion', normalizedHash: 'shared' },
      { id: 3, projectPath: 'git:alpha', content: 'local-only note', normalizedHash: 'unique' },
    ])
    const scan = detectGlobalCandidates(store, { corpusDbPath: contract, now: NOW })
    expect(scan.hashes).toBe(1)
    expect(scan.upserted).toBe(1)
    const candidate = store.listGlobalCandidates({ domainId: ORG_DOMAIN_ID })[0]!
    expect(candidate.distinctIdentities).toBe(2)
    expect(candidate.observationCount).toBe(2)
    expect(candidate.category).toBe('ARCHITECTURE')
    expect(candidate.sourceMemoryId).toBe(2)
    expect(store.listCandidateObservations(candidate.id).map(row => row.identity)).toEqual(['git:alpha', 'git:beta'])
  })

  it('is idempotent and skips credential-shaped groups without storing them', () => {
    const store = makeStore()
    const contract = makeContract([
      { id: 1, projectPath: 'git:alpha', content: 'shared rule', normalizedHash: 'shared' },
      { id: 2, projectPath: 'git:beta', content: 'shared rule', normalizedHash: 'shared' },
      { id: 3, projectPath: 'git:alpha', content: 'DB_PASSWORD=hunter2', normalizedHash: 'secret' },
      { id: 4, projectPath: 'git:beta', content: 'DB_PASSWORD=hunter2', normalizedHash: 'secret' },
    ])
    const first = detectGlobalCandidates(store, { corpusDbPath: contract, now: NOW })
    expect(first.hashes).toBe(2)
    expect(first.upserted).toBe(1)
    expect(first.blocked).toBe(1)
    const second = detectGlobalCandidates(store, { corpusDbPath: contract, now: NOW + 1 })
    expect(second.upserted).toBe(1)
    expect(store.listGlobalCandidates({ domainId: ORG_DOMAIN_ID })).toHaveLength(1)
    expect(store.listGlobalCandidates({ domainId: ORG_DOMAIN_ID })[0]!.content).not.toContain('hunter2')
  })

  it('ignores rows that already live in a domain and non-active rows', () => {
    const store = makeStore()
    const contract = makeContract([
      { id: 1, projectPath: 'dir:global:org', content: 'already shared', normalizedHash: 'shared' },
      { id: 2, projectPath: 'git:alpha', content: 'already shared', normalizedHash: 'shared' },
      { id: 3, projectPath: 'git:alpha', content: 'archived', normalizedHash: 'archived', status: 'archived' },
      { id: 4, projectPath: 'git:beta', content: 'archived', normalizedHash: 'archived', status: 'archived' },
    ])
    const scan = detectGlobalCandidates(store, { corpusDbPath: contract, now: NOW })
    expect(scan.hashes).toBe(0)
    expect(store.listGlobalCandidates()).toEqual([])
  })
})

describe('human promotion', () => {
  it('records the source memory, its category and one observation', () => {
    const store = makeStore()
    const contract = makeContract([
      { id: 7, projectPath: 'git:alpha', content: 'The bastion is the only DB entry point', category: 'CONSTRAINTS' },
    ])
    const result = promoteMemoryToCandidate(store, { corpusDbPath: contract, memoryId: 7, now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidate.sourceMemoryId).toBe(7)
    expect(result.candidate.category).toBe('CONSTRAINTS')
    expect(result.candidate.firstIdentity).toBe('git:alpha')
    expect(result.candidate.distinctIdentities).toBe(1)
    expect(result.memory.content).toContain('bastion')
  })

  it('refuses a credential body and says what to do instead', () => {
    const store = makeStore()
    const contract = makeContract([{ id: 8, projectPath: 'git:alpha', content: 'prod password: hunter2' }])
    const result = promoteMemoryToCandidate(store, { corpusDbPath: contract, memoryId: 8, now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('POINTERS')
    expect(store.listGlobalCandidates()).toEqual([])
  })

  it('refuses a missing, retired, already-global or unknown-domain target', () => {
    const store = makeStore()
    const contract = makeContract([
      { id: 9, projectPath: 'git:alpha', content: 'note' },
      { id: 10, projectPath: 'dir:global:org', content: 'already shared' },
      { id: 11, projectPath: 'git:alpha', content: 'old', status: 'archived' },
    ])
    const missing = promoteMemoryToCandidate(store, { corpusDbPath: contract, memoryId: 404, now: NOW })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain('no memory #404')

    const global = promoteMemoryToCandidate(store, { corpusDbPath: contract, memoryId: 10, now: NOW })
    expect(global.ok).toBe(false)
    if (!global.ok) expect(global.error).toContain('already lives in a global domain')

    const retired = promoteMemoryToCandidate(store, { corpusDbPath: contract, memoryId: 11, now: NOW })
    expect(retired.ok).toBe(false)
    if (!retired.ok) expect(retired.error).toContain('archived, not active')

    const unknown = promoteMemoryToCandidate(
      store,
      { corpusDbPath: contract, memoryId: 9, domainId: 'dir:global:nowhere', now: NOW },
    )
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('unknown domain')
  })

  it('reads a contract memory without touching it', () => {
    const contract = makeContract([{ id: 12, projectPath: 'git:alpha', content: 'hello', category: 'NAMING' }])
    const memory = readCorpusMemory(contract, 12)!
    expect(memory.category).toBe('NAMING')
    expect(readCorpusMemory(contract, 999)).toBeUndefined()
  })
})

describe('the approval gate', () => {
  it('lets a human promotion through on one observation', () => {
    const store = makeStore()
    const contract = makeContract([
      { id: 20, projectPath: 'git:alpha', content: 'org-level rule', category: 'CONSTRAINTS' },
    ])
    const promoted = promoteMemoryToCandidate(store, { corpusDbPath: contract, memoryId: 20, now: NOW })
    expect(promoted.ok).toBe(true)
    if (!promoted.ok) return
    expect(approvalGate(store, promoted.candidate).ok).toBe(true)
  })

  it('still refuses a machine-detected one-off', () => {
    const store = makeStore()
    const candidate = store.upsertGlobalCandidate(
      { domainId: ORG_DOMAIN_ID, content: 'seen once', normalizedHash: 'h1', firstIdentity: 'git:alpha', category: 'ARCHITECTURE' },
      NOW,
    )
    store.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:alpha', sessionId: 's1' }, NOW)
    const gate = approvalGate(store, store.getGlobalCandidate(candidate.id)!)
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toContain('at least two')
  })

  it('refuses a candidate with no category (an anomaly the reviewer can act on)', () => {
    // Every real candidate inherits its category from the memory it came from,
    // so a missing one is a data anomaly. It must be refused with the anomaly
    // named — publishing it would fail the contract's NOT NULL constraint with
    // an error nobody can act on.
    const store = makeStore()
    const candidate = store.upsertGlobalCandidate(
      { domainId: ORG_DOMAIN_ID, content: 'category-less', normalizedHash: 'h9', firstIdentity: 'git:alpha' },
      NOW,
    )
    store.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:alpha', sessionId: 's1' }, NOW)
    store.recordCandidateObservation({ candidateId: candidate.id, identity: 'git:beta', sessionId: 's2' }, NOW)
    const gate = approvalGate(store, store.getGlobalCandidate(candidate.id)!)
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toContain('no category')
  })

  it('refuses a category the domain does not share, instead of publishing it invisible', () => {
    const store = makeStore(false, ['CONSTRAINTS'])
    const contract = makeContract([
      { id: 21, projectPath: 'git:alpha', content: 'naming rule', category: 'NAMING' },
    ])
    const promoted = promoteMemoryToCandidate(store, { corpusDbPath: contract, memoryId: 21, now: NOW })
    expect(promoted.ok).toBe(true)
    if (!promoted.ok) return
    const gate = approvalGate(store, promoted.candidate)
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toContain('invisible')
  })

  it('refuses a candidate that is not pending or whose content became unsafe', () => {
    const store = makeStore()
    const approved = store.upsertGlobalCandidate(
      { domainId: ORG_DOMAIN_ID, content: 'x', normalizedHash: 'h2', firstIdentity: 'git:a', category: 'ARCHITECTURE' },
      NOW,
    )
    store.recordCandidateObservation({ candidateId: approved.id, identity: 'git:a', sessionId: 's1' }, NOW)
    store.recordCandidateObservation({ candidateId: approved.id, identity: 'git:b', sessionId: 's2' }, NOW)
    store.setGlobalCandidateState(approved.id, 'approved', NOW)
    const decided = approvalGate(store, store.getGlobalCandidate(approved.id)!)
    expect(decided.ok).toBe(false)
    if (!decided.ok) expect(decided.error).toContain('approved, not pending')

    const unsafe = store.upsertGlobalCandidate(
      { domainId: ORG_DOMAIN_ID, content: 'api_key: sk-abcdefghijklmnopqrst', normalizedHash: 'h3', firstIdentity: 'git:a' },
      NOW,
    )
    const blocked = approvalGate(store, store.getGlobalCandidate(unsafe.id)!)
    expect(blocked.ok).toBe(false)
  })
})
