/**
 * L1① — machine-domain auto-stage. The staging leg of machine maintenance is
 * reversible (pending candidates, no sharing), so the maintenance tick may do
 * it — but only narrowly: allowlisted categories, recurred facts, a tiny per-
 * pass ceiling, and a full-queue pause. Publishing stays human.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/index.ts'
import { autoStageMachineCandidates } from '../src/core/global-autostage.ts'
import { defaultDomainCap } from '../src/core/domains.ts'
import { makeMemoryDb } from './helpers/memory-db.ts'

const NOW = 1_760_000_000_000
const dirs: string[] = []
const open: AdapterStores[] = []

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function storeWithMachine(enable = true) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-autostage-'))
  dirs.push(dir)
  const s = openStores(dir)
  open.push(s)
  s.upsertDomain(
    {
      domainId: 'dir:global:machine',
      kind: 'machine',
      enabled: enable,
      budgetTokens: 512,
      cap: defaultDomainCap('machine'),
      shareCategories: ['CONSTRAINTS'],
    },
    NOW,
  )
  return s
}

interface Row {
  readonly id: number
  readonly content: string
  readonly category: string
  readonly seen: number
}

function makeContract(rows: Row[]): string {
  const created = makeMemoryDb({ prefix: 'mc-autostage-', schemaVersion: 94 })
  dirs.push(created.dir)
  const db = new DatabaseSync(created.path)
  try {
    const insert = db.prepare(
      'INSERT INTO memories(id, project_path, category, content, normalized_hash, scope, shareable, '
        + 'seen_count, first_seen_at, created_at, updated_at, last_seen_at, status) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    rows.forEach((row, index) => {
      insert.run(
        row.id,
        'git:proj',
        row.category,
        row.content,
        `hash-${String(row.id)}`,
        'project',
        0,
        row.seen,
        1,
        1,
        10 + index,
        1,
        'active',
      )
    })
  } finally {
    db.close()
  }
  return created.path
}

function pending(s: ReturnType<typeof openStores>): number {
  return s.listGlobalCandidates({ state: 'pending', domainId: 'dir:global:machine' }).length
}

describe('autoStageMachineCandidates', () => {
  it('stages a recurred allowlisted memory as a pending machine candidate', () => {
    const s = storeWithMachine()
    const contract = makeContract([
      { id: 11, content: '本机 Python 统一走 uv。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW })
    expect(result.staged).toHaveLength(1)
    expect(result.staged[0]!.memoryId).toBe(11)
    const candidate = s.getGlobalCandidate(result.staged[0]!.candidateId)
    expect(candidate?.state).toBe('pending')
    expect(candidate?.domainId).toBe('dir:global:machine')
    expect(candidate?.sourceMemoryId).toBe(11)
  })

  it('skips one-off facts, foreign categories, and inactive rows', () => {
    const s = storeWithMachine()
    const contract = makeContract([
      { id: 12, content: '只出现过一次的事实。', category: 'CONSTRAINTS', seen: 1 },
      { id: 13, content: '普通项目级架构事实。', category: 'ARCHITECTURE', seen: 2 },
      { id: 14, content: '已归档的约束。', category: 'CONSTRAINTS', seen: 2 },
    ])
    // makeContract always writes status='active'; retire #14 by hand.
    const db = new DatabaseSync(contract)
    try {
      db.prepare("UPDATE memories SET status = 'archived' WHERE id = 14").run()
    } finally {
      db.close()
    }
    const result = autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW })
    expect(result.staged).toHaveLength(0)
    expect(pending(s)).toBe(0)
  })

  it('is idempotent: a second pass stages nothing new', () => {
    const s = storeWithMachine()
    const contract = makeContract([
      { id: 15, content: '复现过的约束。', category: 'CONSTRAINTS', seen: 3 },
    ])
    autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW })
    expect(pending(s)).toBe(1)
    const second = autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW + 1 })
    expect(second.staged).toHaveLength(0)
    expect(pending(s)).toBe(1)
  })

  it('stops at the per-pass limit', () => {
    const s = storeWithMachine()
    const contract = makeContract(
      [1, 2, 3, 4, 5].map(id => ({ id, content: `约束 ${String(id)}。`, category: 'CONSTRAINTS', seen: 2 })),
    )
    const result = autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW, limit: 2 })
    expect(result.staged).toHaveLength(2)
    expect(pending(s)).toBe(2)
  })

  it('pauses entirely once the pending queue is full', () => {
    const s = storeWithMachine()
    const contract = makeContract(
      Array.from({ length: 12 }, (_, i) => ({ id: i + 20, content: `批量约束 ${String(i)}。`, category: 'CONSTRAINTS', seen: 2 })),
    )
    // Fill the queue to the guard by staging without a limit.
    autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW, limit: 10, maxPending: 10 })
    expect(pending(s)).toBe(10)
    const paused = autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW + 1, maxPending: 10 })
    expect(paused.reason).toBe('queue-full')
    expect(paused.staged).toHaveLength(0)
    expect(pending(s)).toBe(10)
  })

  it('is inert for a missing or disabled machine domain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-autostage-off-'))
    dirs.push(dir)
    const s = openStores(dir)
    open.push(s)
    const contract = makeContract([
      { id: 40, content: '不会被入队的约束。', category: 'CONSTRAINTS', seen: 2 },
    ])
    expect(autoStageMachineCandidates({ store: s, contractDbPath: contract, now: NOW }).reason).toBe('domain-missing')
    const disabled = storeWithMachine(false)
    expect(autoStageMachineCandidates({ store: disabled, contractDbPath: contract, now: NOW }).reason).toBe('domain-disabled')
    expect(pending(disabled)).toBe(0)
  })
})
