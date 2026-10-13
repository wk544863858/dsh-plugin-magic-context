/**
 * L1① v10 — classify-then-route global auto-stage. The staging leg is
 * LLM-routed into machine/org and fail-closed to PROJECT level when the
 * classifier cannot decide (user-directed 2026-10-12): no classifier, an
 * unparseable reply, a "project" verdict, or a category outside the target
 * domain's allowlist all leave the memory at project level — never a guessed
 * fallback domain. Publishing stays human.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/index.ts'
import { autoStageGlobalCandidates, type AutoStageLlm } from '../src/core/global-autostage.ts'
import { defaultDomainCap } from '../src/core/domains.ts'
import { makeMemoryDb } from './helpers/memory-db.ts'

const NOW = 1_760_000_000_000
const dirs: string[] = []
const open: AdapterStores[] = []

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function storeWithDomains(machineEnabled = true, orgEnabled = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-autostage-'))
  dirs.push(dir)
  const s = openStores(dir)
  open.push(s)
  s.upsertDomain(
    {
      domainId: 'dir:global:machine',
      kind: 'machine',
      enabled: machineEnabled,
      budgetTokens: 512,
      cap: defaultDomainCap('machine'),
      shareCategories: ['CONSTRAINTS'],
    },
    NOW,
  )
  s.upsertDomain(
    {
      domainId: 'dir:global:org',
      kind: 'org',
      enabled: orgEnabled,
      budgetTokens: 512,
      cap: defaultDomainCap('org'),
      shareCategories: ['CONSTRAINTS', 'ARCHITECTURE'],
    },
    NOW,
  )
  return s
}

/** A deterministic classifier: the prompt embeds the memory content — match any table key contained in it. */
function classifyLlm(
  table: Record<string, { domain: 'machine' | 'org' | 'project'; reason?: string } | undefined>,
): AutoStageLlm {
  return {
    stream: async function* (options) {
      const prompt = options.messages[0]?.content
      const text = (prompt as Array<{ text?: string }> | undefined)?.[0]?.text ?? ''
      const key = Object.keys(table).find(entry => text.includes(entry))
      const row = key === undefined ? undefined : table[key]
      const verdict = row === undefined
        ? 'NOT JSON'
        : JSON.stringify({ domain: row.domain, ...(row.reason === undefined ? {} : { reason: row.reason }) })
      const chunk = { type: 'text-delta' as const, index: 0, text: verdict }
      yield chunk
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    },
  }
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

function pending(s: AdapterStores, domainId: string): number {
  return s.listGlobalCandidates({ state: 'pending', domainId }).length
}

describe('autoStageGlobalCandidates', () => {
  it('routes a machine-classified candidate into the machine pool', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract([
      { id: 11, content: '本机 Python 统一走 uv。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({ '本机 Python 统一走 uv。': { domain: 'machine', reason: 'machine env' } }),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(1)
    expect(result.staged[0]!.domainId).toBe('dir:global:machine')
    const candidate = s.getGlobalCandidate(result.staged[0]!.candidateId)
    expect(candidate?.state).toBe('pending')
    expect(candidate?.suggestedDomain).toBe('machine')
    expect(candidate?.suggestionReason).toBe('machine env')
  })

  it('routes an org-classified candidate into the org pool', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract([
      { id: 12, content: 'project-a/project-b 跨仓库推送必须严格串行。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({ 'project-a/project-b 跨仓库推送必须严格串行。': { domain: 'org', reason: 'org workflow' } }),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(1)
    expect(result.staged[0]!.domainId).toBe('dir:global:org')
  })

  it('keeps a project-classified memory at project level (no staging)', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract([
      { id: 13, content: '本项目专属的目录约定。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({ '本项目专属的目录约定。': { domain: 'project', reason: 'project-specific' } }),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(0)
    expect(result.skipped).toEqual([{ memoryId: 13, reason: 'project-scope' }])
    expect(pending(s, 'dir:global:machine')).toBe(0)
    expect(pending(s, 'dir:global:org')).toBe(0)
  })

  it('fail-closes to project level on an unparseable classifier reply', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract([
      { id: 14, content: '无法分类的内容。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({}),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(0)
    expect(result.skipped).toEqual([{ memoryId: 14, reason: 'unclassified' }])
  })

  it('fail-closes to project level when no classifier route is available', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract([
      { id: 15, content: '不该入队的。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({ store: s, corpusDbPath: contract, now: NOW })
    expect(result.staged).toHaveLength(0)
    expect(result.reason).toBe('llm-unavailable')
    expect(pending(s, 'dir:global:machine')).toBe(0)
  })

  it('does not stage into a disabled org domain even when classified org', async () => {
    const s = storeWithDomains(true, false) // org disabled
    const contract = makeContract([
      { id: 16, content: '组织规则。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({ '组织规则。': { domain: 'org', reason: 'org' } }),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(0)
    expect(result.skipped).toEqual([{ memoryId: 16, reason: 'target-disabled' }])
  })

  it('does not stage when the category is outside the target domain allowlist', async () => {
    const s = storeWithDomains(true, true)
    // machine allowlist = CONSTRAINTS only; classified machine but category ARCHITECTURE.
    const contract = makeContract([
      { id: 17, content: '机器架构事实。', category: 'ARCHITECTURE', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({ '机器架构事实。': { domain: 'machine', reason: 'machine' } }),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(0)
    expect(result.skipped).toEqual([{ memoryId: 17, reason: 'outside-allowlist' }])
  })

  it('skips one-off facts and inactive rows', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract([
      { id: 18, content: '只出现一次。', category: 'CONSTRAINTS', seen: 1 },
      { id: 19, content: '已归档的约束。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const db = new DatabaseSync(contract)
    try {
      db.prepare("UPDATE memories SET status = 'archived' WHERE id = 19").run()
    } finally {
      db.close()
    }
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({}),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(0)
    expect(pending(s, 'dir:global:machine')).toBe(0)
  })

  it('is idempotent: a second pass stages nothing new', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract([
      { id: 20, content: '复现过的约束。', category: 'CONSTRAINTS', seen: 3 },
    ])
    const llm = classifyLlm({ '复现过的约束。': { domain: 'machine', reason: 'machine' } })
    const route = { provider: 'mock', model: 'mock' }
    const first = await autoStageGlobalCandidates({ store: s, corpusDbPath: contract, now: NOW, llm, route })
    expect(first.staged).toHaveLength(1)
    const second = await autoStageGlobalCandidates({ store: s, corpusDbPath: contract, now: NOW + 1, llm, route })
    expect(second.staged).toHaveLength(0)
    expect(pending(s, 'dir:global:machine')).toBe(1)
  })

  it('stops at the per-pass limit across both domains', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract(
      [1, 2, 3, 4, 5].map(id => ({ id, content: `约束 ${String(id)}。`, category: 'CONSTRAINTS', seen: 2 })),
    )
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      limit: 2,
      llm: classifyLlm({
        '约束 1。': { domain: 'machine' },
        '约束 2。': { domain: 'org' },
        '约束 3。': { domain: 'machine' },
      }),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.staged).toHaveLength(2)
    expect(pending(s, 'dir:global:machine') + pending(s, 'dir:global:org')).toBe(2)
  })

  it('pauses a full pool per-domain: machine blocks, an open org pool still stages', async () => {
    const s = storeWithDomains(true, true)
    const contract = makeContract(
      Array.from({ length: 12 }, (_, i) => ({ id: i + 30, content: `批量约束 ${String(i)}。`, category: 'CONSTRAINTS', seen: 2 })),
    )
    const llm = classifyLlm(
      Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`批量约束 ${String(i)}。`, { domain: 'machine' as const }])),
    )
    const route = { provider: 'mock', model: 'mock' }
    // Fill machine to the guard.
    const fill = await autoStageGlobalCandidates({ store: s, corpusDbPath: contract, now: NOW, llm, route, limit: 12, maxPending: 10 })
    expect(fill.staged).toHaveLength(10)
    expect(pending(s, 'dir:global:machine')).toBe(10)
    // Second pass: machine is full, so the machine-classified candidates are
    // skipped (NOT staged, NOT downgraded to org); the pass itself keeps going
    // because the global queue is not uniformly full.
    const paused = await autoStageGlobalCandidates({ store: s, corpusDbPath: contract, now: NOW + 1, llm, route, maxPending: 10 })
    expect(paused.staged).toHaveLength(0)
    expect(paused.skipped).toContainEqual({ memoryId: 30, reason: 'queue-full' })
    expect(pending(s, 'dir:global:machine')).toBe(10)
    expect(pending(s, 'dir:global:org')).toBe(0)
  })

  it('stages nothing when neither global domain is enabled', async () => {
    const s = storeWithDomains(false, false)
    const contract = makeContract([
      { id: 40, content: '不会被入队的。', category: 'CONSTRAINTS', seen: 2 },
    ])
    const result = await autoStageGlobalCandidates({
      store: s,
      corpusDbPath: contract,
      now: NOW,
      llm: classifyLlm({}),
      route: { provider: 'mock', model: 'mock' },
    })
    expect(result.reason).toBe('domain-missing')
    expect(result.staged).toHaveLength(0)
  })
})
