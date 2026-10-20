/**
 * 域行对账与修复：纯函数用例 + 合成库上的 CLI 用例。
 *
 * 这份 spec 的八条要求（对应人工裁定的验收清单）：
 *   ① 健康  ② 源行不存在  ③ 源行已归档  ④ 源行已改写  ⑤ 未关联不算故障
 *   ⑥ 只读：applyRepair 不被调用、库一行不改
 *   ⑦ 修复路径绝不发布（用一个会抛错的 publish seam 反证）
 *   ⑧ 幂等：同一分歧重复 plan / apply 不重复暂存
 *
 * 之外还钉住三件在实测数据上会咬人的事：域行已归档时跳过（归档行不计入 `healthy`）、
 * `permanent` 源算活着、以及 `--write` 的备份闸门（没有可验证
 * 的备份就拒绝写，一行都不写）。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRepair,
  auditDomainDivergences,
  planRepair,
} from '../src/core/domain-reconcile.ts'
import type {
  DomainDivergence,
  DomainReconcileInput,
  DomainReconcileReport,
  DomainRepairPort,
  ReconcileCandidate,
  ReconcileDomainRow,
  ReconcileSourceMemory,
  RepairPlan,
  StageCandidatePlan,
} from '../src/core/domain-reconcile.ts'
import { checkBackupGate, collectSnapshots, runReconcile } from '../scripts/domain-reconcile.mjs'
import { makeMemoryDb } from './helpers/memory-db'

const NOW = 1_800_000_000_000
const ORG = 'dir:global:org'
const MACHINE = 'dir:global:machine'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    } catch {
      // 清理失败不能遮住断言
    }
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function candidate(input: Partial<ReconcileCandidate> & { id: number }): ReconcileCandidate {
  return {
    domainId: ORG,
    normalizedHash: 'hash-1',
    state: 'approved',
    category: 'CONSTRAINTS',
    sourceMemoryId: 100,
    ...input,
  }
}

function domainRow(input: Partial<ReconcileDomainRow> & { id: number }): ReconcileDomainRow {
  return { domainId: ORG, normalizedHash: 'hash-1', status: 'active', category: 'CONSTRAINTS', ...input }
}

function sourceMemory(input: Partial<ReconcileSourceMemory> & { id: number }): ReconcileSourceMemory {
  return {
    status: 'active',
    normalizedHash: 'hash-1',
    category: 'CONSTRAINTS',
    content: '源记忆正文',
    projectPath: 'dir:abc',
    ...input,
  }
}

function audit(input: Partial<DomainReconcileInput>): DomainReconcileReport {
  return auditDomainDivergences({ candidates: [], domainRows: [], sourceMemories: [], ...input })
}

function kinds(report: DomainReconcileReport): string[] {
  return report.divergences.map(divergence => divergence.kind)
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：对账
// ─────────────────────────────────────────────────────────────────────────────

describe('auditDomainDivergences', () => {
  it('① 域行与源记忆一致 ⇒ healthy', () => {
    const report = audit({
      candidates: [candidate({ id: 1 })],
      domainRows: [domainRow({ id: 10 })],
      sourceMemories: [sourceMemory({ id: 100 })],
    })
    expect(report).toMatchObject({ checked: 1, healthy: 1, unlinked: 0 })
    expect(report.divergences).toEqual([])
    expect(report.skippedArchivedDomainRows).toEqual([])
  })

  it('② 源行不存在 ⇒ source-missing（源已亡）', () => {
    const report = audit({
      candidates: [candidate({ id: 1 })],
      domainRows: [domainRow({ id: 10 })],
      sourceMemories: [],
    })
    expect(kinds(report)).toEqual(['source-missing'])
    const divergence = report.divergences[0] as DomainDivergence
    expect(divergence).toMatchObject({ candidateId: 1, domainId: ORG, domainRowId: 10, sourceMemoryId: 100 })
    expect(divergence.sourceNormalizedHash).toBeNull()
    expect(divergence.sourceContent).toBeNull()
    expect(report).toMatchObject({ healthy: 0, unlinked: 0 })
  })

  it('③ 源行已归档 ⇒ source-archived', () => {
    const report = audit({
      candidates: [candidate({ id: 1 })],
      domainRows: [domainRow({ id: 10 })],
      // 哈希仍然一致：分歧不在文本，而在源已经撤了
      sourceMemories: [sourceMemory({ id: 100, status: 'archived' })],
    })
    expect(kinds(report)).toEqual(['source-archived'])
    expect(report.divergences[0]?.sourceContent).toBe('源记忆正文')
  })

  it("③' 源是 'permanent' ⇒ 活着，不算源已亡", () => {
    const report = audit({
      candidates: [candidate({ id: 1 })],
      domainRows: [domainRow({ id: 10 })],
      sourceMemories: [sourceMemory({ id: 100, status: 'permanent' })],
    })
    expect(report.divergences).toEqual([])
    expect(report.healthy).toBe(1)
  })

  it('④ 源行已改写 ⇒ source-rewritten，且带上源现状（供修复提案）', () => {
    const report = audit({
      candidates: [candidate({ id: 3, normalizedHash: 'hash-old', sourceMemoryId: 1311 })],
      domainRows: [domainRow({ id: 1431, normalizedHash: 'hash-old' })],
      sourceMemories: [
        sourceMemory({ id: 1311, normalizedHash: 'hash-new', content: '改写后的正文', projectPath: 'dir:p' }),
      ],
    })
    expect(kinds(report)).toEqual(['source-rewritten'])
    expect(report.divergences[0]).toMatchObject({
      candidateId: 3,
      domainRowId: 1431,
      sourceMemoryId: 1311,
      publishedNormalizedHash: 'hash-old',
      sourceNormalizedHash: 'hash-new',
      sourceContent: '改写后的正文',
      sourceIdentity: 'dir:p',
    })
  })

  it("④' 源已改写但当前文本已发布（同域活域行）⇒ 记为 covered，不是分歧", () => {
    const report = audit({
      candidates: [candidate({ id: 3, normalizedHash: 'hash-old', sourceMemoryId: 1311 })],
      domainRows: [
        domainRow({ id: 1431, normalizedHash: 'hash-old' }),
        domainRow({ id: 1432, normalizedHash: 'hash-new' }),
      ],
      sourceMemories: [sourceMemory({ id: 1311, normalizedHash: 'hash-new' })],
    })
    expect(kinds(report)).toEqual([])
    expect(report.covered).toEqual([
      { candidateId: 3, domainRowId: 1431, sourceMemoryId: 1311, via: 'published', coveredBy: 1432 },
    ])
    expect(report).toMatchObject({ checked: 1, healthy: 1, unlinked: 0 })
    // 已覆盖 ⇒ 没有任何修复动作（否则每跑一次就重复提案一遍）
    expect(planRepair(report)).toEqual({ archiveRowIds: [], stageCandidates: [], unrepairable: [] })
  })

  it("④'' 源已改写但当前文本已有待审候选 ⇒ covered(staged)：稳态靠这一条收口", () => {
    const report = audit({
      candidates: [
        candidate({ id: 3, normalizedHash: 'hash-old', sourceMemoryId: 1311 }),
        candidate({ id: 218, normalizedHash: 'hash-new', state: 'pending', sourceMemoryId: 1311 }),
      ],
      domainRows: [domainRow({ id: 1431, normalizedHash: 'hash-old' })],
      sourceMemories: [sourceMemory({ id: 1311, normalizedHash: 'hash-new' })],
    })
    expect(report.covered).toEqual([
      { candidateId: 3, domainRowId: 1431, sourceMemoryId: 1311, via: 'staged', coveredBy: 218 },
    ])
    expect(report.divergences).toEqual([])
    // 那条 pending 自己还没发布 ⇒ unlinked，不算故障
    expect(report).toMatchObject({ checked: 2, healthy: 1, unlinked: 1 })
  })

  it("④''' 「批准」不是覆盖：副本已被归档的同键候选挡不住分歧（实测数据的形状）", () => {
    const report = audit({
      candidates: [
        candidate({ id: 3, normalizedHash: 'hash-old', sourceMemoryId: 1311 }),
        candidate({ id: 1, normalizedHash: 'hash-new', sourceMemoryId: 1311 }),
      ],
      domainRows: [
        domainRow({ id: 1431, normalizedHash: 'hash-old' }),
        domainRow({ id: 1420, normalizedHash: 'hash-new', status: 'archived' }),
      ],
      sourceMemories: [sourceMemory({ id: 1311, normalizedHash: 'hash-new' })],
    })
    expect(kinds(report)).toEqual(['source-rewritten'])
    expect(report.covered).toEqual([])
    // 候选 #1 自己的域行已归档 ⇒ 那条链接算 healthy（跳过）
    expect(report).toMatchObject({ checked: 2, healthy: 1, unlinked: 0 })
  })

  it("④'''' 源已改写但同键文本已被人工拒绝 ⇒ covered(declined)：拒绝是决定，不是待办", () => {
    const report = audit({
      candidates: [
        candidate({ id: 14, normalizedHash: 'hash-old', sourceMemoryId: 1549 }),
        candidate({ id: 218, normalizedHash: 'hash-new', state: 'rejected', sourceMemoryId: 1549 }),
      ],
      domainRows: [domainRow({ id: 1552, normalizedHash: 'hash-old' })],
      sourceMemories: [sourceMemory({ id: 1549, normalizedHash: 'hash-new' })],
    })
    expect(report.covered).toEqual([
      { candidateId: 14, domainRowId: 1552, sourceMemoryId: 1549, via: 'declined', coveredBy: 218 },
    ])
    expect(report.divergences).toEqual([])
    // 人工拒绝过的文本不再进修复计划（否则每跑一次就重新提案一遍）
    expect(planRepair(report)).toEqual({ archiveRowIds: [], stageCandidates: [], unrepairable: [] })
  })

  it('⑤ 没有域行 ⇒ unlinked：pending/rejected 从未发布过，不算故障', () => {
    const report = audit({
      candidates: [
        candidate({ id: 11, normalizedHash: 'never', state: 'rejected' }),
        candidate({ id: 97, normalizedHash: 'never-either', state: 'pending', sourceMemoryId: null }),
        candidate({ id: 1 }),
      ],
      domainRows: [domainRow({ id: 10 })],
      sourceMemories: [sourceMemory({ id: 100 })],
    })
    expect(report).toMatchObject({ checked: 3, healthy: 1, unlinked: 2 })
    expect(report.unlinkedCandidateIds).toEqual([11, 97])
    expect(report.divergences).toEqual([])
    // 未关联与未批准都不进修复计划
    expect(planRepair(report)).toEqual({ archiveRowIds: [], stageCandidates: [], unrepairable: [] })
  })

  it('⑤\' 未批准的候选即使关联上域行也不判分歧（它不是那条域行的权威）', () => {
    const report = audit({
      candidates: [candidate({ id: 5, state: 'rejected' })],
      domainRows: [domainRow({ id: 10 })],
      sourceMemories: [sourceMemory({ id: 100, normalizedHash: 'hash-moved-on' })],
    })
    expect(report.divergences).toEqual([])
    expect(report).toMatchObject({ checked: 1, healthy: 1, unlinked: 0 })
  })

  it('域行本身已归档 ⇒ 跳过、不计分歧（归档行不计入 healthy）', () => {
    const report = audit({
      candidates: [
        candidate({ id: 1, normalizedHash: 'hash-a' }),          // 域行已归档 → 跳过
        candidate({ id: 2, normalizedHash: 'hash-b', sourceMemoryId: 200 }), // 健康
        candidate({ id: 3, normalizedHash: 'hash-c', sourceMemoryId: 300 }), // 源已改写
      ],
      domainRows: [
        domainRow({ id: 1420, normalizedHash: 'hash-a', status: 'archived' }),
        domainRow({ id: 1421, normalizedHash: 'hash-b' }),
        domainRow({ id: 1431, normalizedHash: 'hash-c' }),
      ],
      sourceMemories: [
        sourceMemory({ id: 100, normalizedHash: 'hash-a' }),
        sourceMemory({ id: 200, normalizedHash: 'hash-b' }),
        sourceMemory({ id: 300, normalizedHash: 'hash-c-new' }),
      ],
    })
    expect(report).toMatchObject({ checked: 3, healthy: 2, unlinked: 0 })
    expect(kinds(report)).toEqual(['source-rewritten'])
    expect(report.skippedArchivedDomainRows).toEqual([{ candidateId: 1, domainRowId: 1420 }])
    // 已撤回的域行不进修复计划：它没有可归档/可暂存的东西
    expect(planRepair(report).archiveRowIds).toEqual([])
  })

  it('分类是穷尽的：checked = healthy + unlinked + 分歧数', () => {
    const report = audit({
      candidates: [
        candidate({ id: 1 }), // healthy
        candidate({ id: 2, normalizedHash: 'h2', sourceMemoryId: 200 }), // archived 域行 → 跳过（healthy）
        candidate({ id: 3, normalizedHash: 'h3', sourceMemoryId: 300 }), // 源已改写
        candidate({ id: 4, normalizedHash: 'h4', state: 'pending', sourceMemoryId: null }), // unlinked
      ],
      domainRows: [
        domainRow({ id: 10 }),
        domainRow({ id: 20, normalizedHash: 'h2', status: 'archived' }),
        domainRow({ id: 30, normalizedHash: 'h3' }),
      ],
      sourceMemories: [
        sourceMemory({ id: 100 }),
        sourceMemory({ id: 200, normalizedHash: 'h2' }),
        sourceMemory({ id: 300, normalizedHash: 'h3-new' }),
      ],
    })
    expect(report.checked).toBe(report.healthy + report.unlinked + report.divergences.length)
    expect(report).toMatchObject({ checked: 4, healthy: 2, unlinked: 1 })
    expect(kinds(report)).toEqual(['source-rewritten'])
  })

  it('同哈希多行时按 category 对齐，否则取最小 id（读序无关）', () => {
    const withCategory = audit({
      candidates: [candidate({ id: 1, category: 'CONFIG_VALUES' })],
      domainRows: [
        domainRow({ id: 10, category: 'CONSTRAINTS' }),
        domainRow({ id: 11, category: 'CONFIG_VALUES' }),
      ],
      sourceMemories: [sourceMemory({ id: 100, normalizedHash: 'hash-new' })],
    })
    expect(withCategory.divergences[0]?.domainRowId).toBe(11)

    const noCategory = audit({
      candidates: [candidate({ id: 1, category: 'ARCHITECTURE' })],
      domainRows: [
        domainRow({ id: 12, category: 'CONSTRAINTS' }),
        domainRow({ id: 10, category: 'CONFIG_VALUES' }),
      ],
      sourceMemories: [sourceMemory({ id: 100, normalizedHash: 'hash-new' })],
    })
    expect(noCategory.divergences[0]?.domainRowId).toBe(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：修复计划
// ─────────────────────────────────────────────────────────────────────────────

function divergentReport(): DomainReconcileReport {
  return audit({
    candidates: [
      candidate({ id: 3, normalizedHash: 'hash-old', sourceMemoryId: 1311 }),
      candidate({ id: 14, domainId: MACHINE, normalizedHash: 'hash-machine', category: 'CONFIG_VALUES', sourceMemoryId: 1549 }),
    ],
    domainRows: [
      domainRow({ id: 1431, normalizedHash: 'hash-old' }),
      domainRow({ id: 1552, domainId: MACHINE, normalizedHash: 'hash-machine', category: 'CONFIG_VALUES' }),
    ],
    sourceMemories: [
      sourceMemory({ id: 1311, normalizedHash: 'hash-new', content: '改写后的正文', category: 'CONSTRAINTS' }),
      sourceMemory({ id: 1549, normalizedHash: 'hash-machine-new', content: '机器域新正文', category: 'CONFIG_VALUES' }),
    ],
  })
}

describe('planRepair', () => {
  it('源已亡 ⇒ 只归档域行，不暂存候选', () => {
    const report = audit({
      candidates: [candidate({ id: 1 })],
      domainRows: [domainRow({ id: 10 })],
      sourceMemories: [sourceMemory({ id: 100, status: 'archived' })],
    })
    const plan = planRepair(report)
    expect(plan.archiveRowIds).toEqual([10])
    expect(plan.stageCandidates).toEqual([])
    expect(plan.unrepairable).toEqual([])
  })

  it('源已改写 ⇒ 只暂存候选，绝不归档域行', () => {
    const plan = planRepair(divergentReport())
    expect(plan.archiveRowIds).toEqual([])
    expect(plan.stageCandidates).toHaveLength(2)
    const [first, second] = plan.stageCandidates as [StageCandidatePlan, StageCandidatePlan]
    expect(first).toMatchObject({
      domainId: ORG,
      content: '改写后的正文',
      normalizedHash: 'hash-new',
      category: 'CONSTRAINTS',
      sourceMemoryId: 1311,
      sourceIdentity: 'dir:abc',
      suggestedDomain: 'org',
    })
    expect(first.reason).toContain('domain-reconcile')
    expect(first.derivedFrom).toEqual([{ candidateId: 3, domainRowId: 1431, sourceMemoryId: 1311 }])
    expect(second).toMatchObject({ domainId: MACHINE, normalizedHash: 'hash-machine-new', suggestedDomain: 'machine' })
  })

  it('同一 (domain_id, 源哈希) 只出一个提案，被折叠的对账证据仍完整保留', () => {
    const report = audit({
      candidates: [
        candidate({ id: 1, normalizedHash: 'hash-a', sourceMemoryId: 100 }),
        candidate({ id: 2, normalizedHash: 'hash-b', category: 'CONFIG_VALUES', sourceMemoryId: 200 }),
      ],
      domainRows: [
        domainRow({ id: 10, normalizedHash: 'hash-a' }),
        domainRow({ id: 20, normalizedHash: 'hash-b', category: 'CONFIG_VALUES' }),
      ],
      sourceMemories: [
        sourceMemory({ id: 100, normalizedHash: 'hash-shared', content: '同一个新正文' }),
        sourceMemory({ id: 200, normalizedHash: 'hash-shared', content: '同一个新正文', category: 'CONFIG_VALUES' }),
      ],
    })
    const plan = planRepair(report)
    expect(plan.stageCandidates).toHaveLength(1)
    expect(plan.stageCandidates[0]?.derivedFrom).toEqual([
      { candidateId: 1, domainRowId: 10, sourceMemoryId: 100 },
      { candidateId: 2, domainRowId: 20, sourceMemoryId: 200 },
    ])
    expect(plan.archiveRowIds).toEqual([])
  })

  it('同一份对账重复 plan ⇒ 完全一致（幂等的前提）', () => {
    const report = divergentReport()
    expect(planRepair(report)).toEqual(planRepair(report))
    expect(JSON.stringify(planRepair(report))).toBe(JSON.stringify(planRepair(divergentReport())))
  })

  it('改写类分歧缺了源正文时进 unrepairable，绝不静默缩短计划', () => {
    const report: DomainReconcileReport = {
      checked: 1,
      healthy: 0,
      unlinked: 0,
      unlinkedCandidateIds: [],
      skippedArchivedDomainRows: [],
      divergences: [{
        kind: 'source-rewritten',
        candidateId: 3,
        domainId: ORG,
        domainRowId: 1431,
        sourceMemoryId: 1311,
        publishedNormalizedHash: 'hash-old',
        // 分类说是改写，却没带正文：宁可报出来，也不猜一条提案
        sourceNormalizedHash: 'hash-new',
        sourceCategory: null,
        sourceIdentity: 'dir:p',
        sourceContent: null,
      }],
    }
    const plan = planRepair(report)
    expect(plan.stageCandidates).toEqual([])
    expect(plan.archiveRowIds).toEqual([])
    expect(plan.unrepairable).toHaveLength(1)
    expect(plan.unrepairable[0]).toMatchObject({ candidateId: 3, domainId: ORG, kind: 'source-rewritten' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：应用修复（两个写口，没有第三个）
// ─────────────────────────────────────────────────────────────────────────────

describe('applyRepair', () => {
  it('⑦ 修复路径绝不发布：会抛错的 publish seam 也不会被调用', () => {
    const report = audit({
      candidates: [
        candidate({ id: 3, normalizedHash: 'hash-old', sourceMemoryId: 1311 }), // 改写 → 暂存
        candidate({ id: 9, domainId: MACHINE, normalizedHash: 'hash-dead', category: 'CONFIG_VALUES', sourceMemoryId: 999 }),
      ],
      domainRows: [
        domainRow({ id: 1431, normalizedHash: 'hash-old' }),
        domainRow({ id: 1552, domainId: MACHINE, normalizedHash: 'hash-dead', category: 'CONFIG_VALUES' }),
      ],
      sourceMemories: [sourceMemory({ id: 1311, normalizedHash: 'hash-new', content: '改写后的正文' })],
    })
    const plan = planRepair(report)
    expect(plan.archiveRowIds).toEqual([1552])

    const calls = { publish: 0, archive: 0, stage: 0 }
    const port = {
      archiveDomainRow: () => {
        calls.archive += 1
        return { ok: true as const, changed: true }
      },
      stageCandidate: () => {
        calls.stage += 1
        return { ok: true as const, candidateId: 900, created: true }
      },
      // 反证：对账工具只要碰一下发布，用例就炸在这里
      publishDomainMemory: () => {
        calls.publish += 1
        throw new Error('发布是人工门禁：对账工具不得调用 publish')
      },
      publishGlobalCandidate: () => {
        calls.publish += 1
        throw new Error('发布是人工门禁：对账工具不得调用 publish')
      },
    }
    expect(() => applyRepair(plan, port)).not.toThrow()
    expect(calls).toEqual({ publish: 0, archive: 1, stage: 1 })
    // 改写那条的域行没有被碰过
    expect(plan.archiveRowIds).not.toContain(1431)
  })

  it('⑧ 幂等：同一分歧重复 apply，第二次不再新建候选', () => {
    const report = divergentReport()
    const staged = new Map<string, number>()
    const port: DomainRepairPort = {
      archiveDomainRow: () => ({ ok: true, changed: false }),
      stageCandidate: input => {
        const key = `${input.domainId}\u0000${input.normalizedHash}`
        const existing = staged.get(key)
        if (existing !== undefined) return { ok: true, candidateId: existing, created: false }
        const id = 500 + staged.size
        staged.set(key, id)
        return { ok: true, candidateId: id, created: true }
      },
    }
    const first = applyRepair(planRepair(report), port)
    const second = applyRepair(planRepair(report), port)
    expect(first.staged.map(item => item.created)).toEqual([true, true])
    expect(second.staged.map(item => item.created)).toEqual([false, false])
    expect(second.staged.map(item => item.candidateId)).toEqual(first.staged.map(item => item.candidateId))
    expect(staged.size).toBe(2)
  })

  it('写口拒绝时如实记账，不假装成功；journal 逐条留痕', () => {
    const plan = planRepair(divergentReport())
    const entries: Array<{ action: string; summary: string }> = []
    const port = {
      archiveDomainRow: () => ({ ok: true as const, changed: false }),
      stageCandidate: (input: StageCandidatePlan) => input.domainId === MACHINE
        ? { ok: false as const, error: 'unknown domain' }
        : { ok: true as const, candidateId: 42, created: true },
    }
    const outcome = applyRepair(
      { ...plan, archiveRowIds: [7] },
      port,
      { now: NOW, journal: entry => entries.push({ action: entry.action, summary: entry.summary }) },
    )
    expect(outcome.archived).toEqual([])
    expect(outcome.archiveRefusals).toEqual([{ rowId: 7, error: 'already archived (idempotent re-run)' }])
    expect(outcome.staged).toHaveLength(1)
    expect(outcome.stageRefusals).toHaveLength(1)
    expect(outcome.stageRefusals[0]?.error).toBe('unknown domain')
    expect(outcome.unrepairable).toEqual([])
    expect(entries.map(entry => entry.action)).toEqual(['refuse', 'stage', 'refuse'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CLI：合成库上的读写
// ─────────────────────────────────────────────────────────────────────────────

const ADAPTER_DDL = `
  CREATE TABLE domains(domain_id TEXT PRIMARY KEY, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE global_candidates(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id TEXT NOT NULL,
    content TEXT NOT NULL,
    normalized_hash TEXT NOT NULL,
    first_identity TEXT NOT NULL,
    session_id TEXT,
    compartment_start INTEGER,
    compartment_end INTEGER,
    distinct_identities INTEGER NOT NULL DEFAULT 1,
    observation_count INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','expired')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    category TEXT,
    source_memory_id INTEGER,
    suggested_domain TEXT,
    suggestion_reason TEXT,
    UNIQUE(domain_id, normalized_hash)
  );
  CREATE TABLE global_candidate_observations(
    candidate_id INTEGER NOT NULL REFERENCES global_candidates(id) ON DELETE CASCADE,
    identity TEXT NOT NULL,
    session_id TEXT NOT NULL,
    compartment_start INTEGER,
    compartment_end INTEGER,
    observations INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(candidate_id, identity, session_id)
  );
`

interface Seed {
  readonly adapterPath: string
  readonly corpusPath: string
  /** 源被改写的候选：hash-old → 源现在 hash-new。 */
  readonly sourceRewritten: number
  readonly liveRowRewritten: number
  /** 源已归档的候选：域行应当被归档。 */
  readonly sourceArchived: number
  readonly liveRowArchived: number
}

function withDb<T>(path: string, run: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(path)
  try {
    return run(db)
  } finally {
    db.close()
  }
}

function insertCandidate(path: string, row: {
  domainId: string
  content: string
  normalizedHash: string
  state: string
  category: string
  sourceMemoryId: number
}): number {
  return withDb(path, db => Number(db.prepare(
    'INSERT INTO global_candidates(domain_id, content, normalized_hash, first_identity, distinct_identities, '
      + 'observation_count, state, created_at, updated_at, category, source_memory_id) '
      + 'VALUES(?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)',
  ).run(row.domainId, row.content, row.normalizedHash, 'dir:origin', row.state, NOW, NOW, row.category, row.sourceMemoryId).lastInsertRowid))
}

function insertMemory(path: string, row: {
  projectPath: string
  category: string
  content: string
  normalizedHash: string
  status?: string
}): number {
  return withDb(path, db => Number(db.prepare(
    'INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, '
      + 'updated_at, last_seen_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(row.projectPath, row.category, row.content, row.normalizedHash, NOW, NOW, NOW, NOW, row.status ?? 'active').lastInsertRowid))
}

/** 库 1：一条源改写（→ 只暂存）、一条源归档（→ 归档域行）。 */
function seedDivergentBanks(): Seed {
  const adapterPath = join(tempDir('mc-reconcile-adapter-'), 'dsh-magic-context.db')
  withDb(adapterPath, db => {
    db.exec(ADAPTER_DDL)
    const domain = db.prepare('INSERT INTO domains(domain_id, kind, enabled) VALUES(?, ?, 1)')
    domain.run(ORG, 'org')
    domain.run(MACHINE, 'machine')
  })

  const corpus = makeMemoryDb({ prefix: 'mc-reconcile-corpus-', schemaVersion: 95, fts: true, mutationLog: true })
  dirs.push(corpus.dir)
  const sourceRewritten = insertMemory(corpus.path, {
    projectPath: 'dir:origin',
    category: 'CONSTRAINTS',
    content: '源记忆改写后的正文',
    normalizedHash: 'hash-rw-new',
  })
  const sourceArchived = insertMemory(corpus.path, {
    projectPath: 'dir:origin',
    category: 'CONFIG_VALUES',
    content: '已归档源的正文',
    normalizedHash: 'hash-ar-source',
    status: 'archived',
  })
  const liveRowRewritten = insertMemory(corpus.path, {
    projectPath: ORG,
    category: 'CONSTRAINTS',
    content: '发布时的旧正文',
    normalizedHash: 'hash-rw-old',
  })
  const liveRowArchived = insertMemory(corpus.path, {
    projectPath: ORG,
    category: 'CONFIG_VALUES',
    content: '源已亡的域行正文',
    normalizedHash: 'hash-ar-old',
  })

  insertCandidate(adapterPath, {
    domainId: ORG,
    content: '发布时的旧正文',
    normalizedHash: 'hash-rw-old',
    state: 'approved',
    category: 'CONSTRAINTS',
    sourceMemoryId: sourceRewritten,
  })
  insertCandidate(adapterPath, {
    domainId: ORG,
    content: '源已亡的域行正文',
    normalizedHash: 'hash-ar-old',
    state: 'approved',
    category: 'CONFIG_VALUES',
    sourceMemoryId: sourceArchived,
  })

  return { adapterPath, corpusPath: corpus.path, sourceRewritten, liveRowRewritten, sourceArchived, liveRowArchived }
}

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, log: (line: string) => out.push(line), warn: (line: string) => err.push(line) }
}

function countCandidates(path: string): number {
  return withDb(path, db => Number(db.prepare('SELECT COUNT(*) AS n FROM global_candidates').get()?.n ?? 0))
}

interface StubRow {
  id: number
  domain_id: string
  state: string
  content: string
  category: string
  first_identity: string
  source_memory_id: number
  suggested_domain: string | null
  suggestion_reason: string | null
  distinct_identities: number
  observation_count: number
}

function candidateByHash(path: string, hash: string): StubRow | undefined {
  return withDb(path, db => db.prepare('SELECT * FROM global_candidates WHERE normalized_hash = ?').get(hash) as StubRow | undefined)
}

function mutationRows(path: string): Array<{ project_path: string; mutation_type: string; target_memory_id: number }> {
  return withDb(path, db => (db.prepare('SELECT project_path, mutation_type, target_memory_id FROM memory_mutation_log').all() as unknown as Array<{ project_path: string; mutation_type: string; target_memory_id: number }>)
    .map(row => ({ ...row })))
}

function observationRows(path: string, candidateId: number): Array<{ identity: string; session_id: string }> {
  return withDb(path, db => (db.prepare('SELECT identity, session_id FROM global_candidate_observations WHERE candidate_id = ?').all(candidateId) as unknown as Array<{ identity: string; session_id: string }>)
    .map(row => ({ ...row })))
}

function memoryStatus(path: string, id: number): string | undefined {
  const row = withDb(path, db => db.prepare('SELECT status FROM memories WHERE id = ?').get(id) as { status: string } | undefined)
  return row?.status
}

describe('scripts/domain-reconcile.mjs（合成库）', () => {
  it('⑥ 只读：applyRepair 不被调用，两个库一行不改', () => {
    const seed = seedDivergentBanks()
    const before = countCandidates(seed.adapterPath)
    const { out, err, log, warn } = io()
    let applyCalls = 0
    const exit = runReconcile({
      argv: ['--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log,
      warn,
      deps: {
        applyRepair: () => {
          applyCalls += 1
          throw new Error('只读模式不得调用 applyRepair')
        },
      },
    })

    expect(exit).toBe(0)
    expect(applyCalls).toBe(0)
    expect(err).toEqual([])
    expect(countCandidates(seed.adapterPath)).toBe(before)
    expect(memoryStatus(seed.corpusPath, seed.liveRowArchived)).toBe('active')
    expect(memoryStatus(seed.corpusPath, seed.liveRowRewritten)).toBe('active')
    const text = out.join('\n')
    expect(text).toContain('候选 checked=2 · healthy=0 · unlinked=0 · 分歧=2')
    expect(text).toContain('source-rewritten')
    expect(text).toContain('source-archived')
    expect(text).toContain('只读模式：未写任何库')
    // 报表只给 id 与哈希，不吐正文
    expect(text).not.toContain('源记忆改写后的正文')
    expect(text).not.toContain('已归档源的正文')
  })

  it('⑥\' --json 输出同一份事实且不带记忆正文', () => {
    const seed = seedDivergentBanks()
    const { out, log } = io()
    const exit = runReconcile({
      argv: ['--json', '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log,
      warn: () => {},
    })
    expect(exit).toBe(0)
    const text = out.join('\n')
    const payload = JSON.parse(text) as {
      mode: string
      audit: { checked: number; healthy: number; unlinked: number; divergences: Array<{ kind: string }> }
      plan: { archiveRowIds: number[]; stageCandidates: Array<{ normalizedHash: string; contentLength: number }> }
    }
    expect(payload.mode).toBe('read-only')
    expect(payload.audit.checked).toBe(2)
    expect(payload.audit.divergences.map(item => item.kind)).toEqual(['source-rewritten', 'source-archived'])
    expect(payload.plan.archiveRowIds).toEqual([seed.liveRowArchived])
    expect(payload.plan.stageCandidates).toHaveLength(1)
    expect(payload.plan.stageCandidates[0]?.normalizedHash).toBe('hash-rw-new')
    expect(payload.plan.stageCandidates[0]?.contentLength).toBe('源记忆改写后的正文'.length)
    expect(text).not.toContain('源记忆改写后的正文')
  })

  it('--write 没有可验证的备份 ⇒ 拒绝写入（exit 2），一行都没写', () => {
    const seed = seedDivergentBanks()
    const before = countCandidates(seed.adapterPath)
    const noBackup = io()
    expect(runReconcile({
      argv: ['--write', '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log: noBackup.log,
      warn: noBackup.warn,
    })).toBe(2)
    expect(noBackup.err.join('\n')).toContain('拒绝写入')
    expect(noBackup.err.join('\n')).toContain('VACUUM INTO')

    // 备份路径不存在
    const missing = io()
    expect(runReconcile({
      argv: ['--write', '--backup', join(tempDir('mc-reconcile-nope-'), 'nope.db'), '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log: missing.log,
      warn: missing.warn,
    })).toBe(2)
    expect(missing.err.join('\n')).toContain('路径不存在')

    // 空文件冒充备份（单库场景才会走到“非空文件”这一条判据）
    const emptyDir = tempDir('mc-reconcile-empty-')
    const emptyFile = join(emptyDir, 'empty.db')
    writeFileSync(emptyFile, '')
    const empty = io()
    expect(runReconcile({
      argv: ['--write', '--backup', emptyFile, '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log: empty.log,
      warn: empty.warn,
    })).toBe(2)
    expect(empty.err.join('\n')).toContain('必须是一个目录')
    const emptyGate = checkBackupGate(emptyFile, [{ dbPath: seed.adapterPath, marker: 'global_candidates' }])
    expect(emptyGate.ok).toBe(false)
    expect(String(emptyGate.error)).toContain('非空文件')

    expect(countCandidates(seed.adapterPath)).toBe(before)
    expect(memoryStatus(seed.corpusPath, seed.liveRowArchived)).toBe('active')
    expect(memoryStatus(seed.corpusPath, seed.liveRowRewritten)).toBe('active')
  })

  it('--write 备份目录缺一份 ⇒ 拒绝；两个库都要写时必须给目录', () => {
    const seed = seedDivergentBanks()
    const backupDir = tempDir('mc-reconcile-backup-partial-')
    copyFileSync(seed.corpusPath, join(backupDir, basename(seed.corpusPath)))
    const { err, log, warn } = io()
    expect(runReconcile({
      argv: ['--write', '--backup', backupDir, '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log,
      warn,
    })).toBe(2)
    expect(err.join('\n')).toContain('缺少')
    // 单文件备份只够覆盖一个库
    const gate = checkBackupGate(join(backupDir, basename(seed.corpusPath)), [
      { dbPath: seed.corpusPath, marker: 'memories' },
      { dbPath: seed.adapterPath, marker: 'global_candidates' },
    ])
    expect(gate.ok).toBe(false)
  })

  it('--write + 可验证备份 ⇒ 归档源已亡的域行、暂存改写候选；重跑幂等', () => {
    const seed = seedDivergentBanks()
    const backupDir = tempDir('mc-reconcile-backup-full-')
    copyFileSync(seed.corpusPath, join(backupDir, basename(seed.corpusPath)))
    copyFileSync(seed.adapterPath, join(backupDir, basename(seed.adapterPath)))

    const calls: number[] = []
    const run = () => {
      const { out, err, log, warn } = io()
      const exit = runReconcile({
        argv: ['--write', '--backup', backupDir, '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
        now: NOW,
        log,
        warn,
        deps: {
          applyRepair: (plan: RepairPlan, port: DomainRepairPort, options: { now?: number }) => {
            calls.push(1)
            return applyRepair(plan, port, options)
          },
        },
      })
      return { exit, out: out.join('\n'), err: err.join('\n') }
    }

    const first = run()
    expect(first.exit).toBe(0)
    expect(first.err).toBe('')
    expect(calls).toHaveLength(1)

    // 归档：域行软删除 + 变更日志一条 archive 增量
    expect(memoryStatus(seed.corpusPath, seed.liveRowArchived)).toBe('archived')
    expect(memoryStatus(seed.corpusPath, seed.liveRowRewritten)).toBe('active')
    expect(mutationRows(seed.corpusPath)).toEqual([
      { project_path: ORG, mutation_type: 'archive', target_memory_id: seed.liveRowArchived },
    ])

    // 暂存：一条 pending 候选，正文来自源现状，带来源与观测行
    const stub = candidateByHash(seed.adapterPath, 'hash-rw-new')
    expect(stub).toMatchObject({
      domain_id: ORG,
      state: 'pending',
      content: '源记忆改写后的正文',
      category: 'CONSTRAINTS',
      source_memory_id: seed.sourceRewritten,
      first_identity: 'dir:origin',
      suggested_domain: 'org',
      distinct_identities: 1,
      observation_count: 1,
    })
    expect(String(stub?.suggestion_reason)).toContain('domain-reconcile')
    expect(observationRows(seed.adapterPath, Number(stub?.id))).toEqual([
      { identity: 'dir:origin', session_id: `memory:${String(seed.sourceRewritten)}` },
    ])

    expect(countCandidates(seed.adapterPath)).toBe(3)
    expect(first.out).toContain('journal: domain-reconcile [archive]')
    expect(first.out).toContain('journal: domain-reconcile [stage]')
    expect(first.out).toContain('已应用：归档 1 条 · 暂存 1 条 · 拒绝 0 条')

    // 重跑：同一分歧已被「已覆盖」收口 ⇒ 计划为空，连 applyRepair 都不再被调用
    const second = run()
    expect(second.exit).toBe(0)
    expect(countCandidates(seed.adapterPath)).toBe(3)
    expect(second.out).toContain('已覆盖 1 条')
    expect(second.out).toContain('候选 checked=3 · healthy=2 · unlinked=1 · 分歧=0')
    expect(second.out).toContain('本次计划没有写入动作')
    expect(calls).toHaveLength(1)
    // 重跑时：候选 2 的域行已归档 → 跳过（healthy），新暂存的 pending 候选还没有域行（unlinked）
    expect(second.out).toContain('域行已归档 1 条')
  })

  it('--write 撞上"死批准"（已发布副本已归档）⇒ 用它自己的键原地重新提审，不新建、不 DELETE', () => {
    const seed = seedDivergentBanks()
    // 实测数据里就是这个形状：候选已批准，但它的域行已被归档 —— 键被占着，什么都没发布
    const staleId = insertCandidate(seed.adapterPath, {
      domainId: ORG,
      content: '已批准候选的正文，但副本已被撤回',
      normalizedHash: 'hash-rw-new',
      state: 'approved',
      category: 'CONSTRAINTS',
      sourceMemoryId: seed.sourceRewritten,
    })
    const backupDir = tempDir('mc-reconcile-backup-repropose-')
    copyFileSync(seed.corpusPath, join(backupDir, basename(seed.corpusPath)))
    copyFileSync(seed.adapterPath, join(backupDir, basename(seed.adapterPath)))

    const { out, err, log, warn } = io()
    const exit = runReconcile({
      argv: ['--write', '--backup', backupDir, '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log,
      warn,
    })
    expect(exit, err.join('\n')).toBe(0)
    const reproposed = candidateByHash(seed.adapterPath, 'hash-rw-new')
    expect(reproposed).toMatchObject({
      id: staleId,                       // 同一行：幂等、保 id、保观测历史
      state: 'pending',
      content: '源记忆改写后的正文',      // 换成源现状，等人工审批
      source_memory_id: seed.sourceRewritten,
    })
    expect(countCandidates(seed.adapterPath)).toBe(3)  // 没有新建行
    expect(out.join('\n')).toContain('（重新提审：原批准副本已归档，键被它占着）')
  })

  it('--write 撞上"活批准"（同键域行还活着）⇒ 已被覆盖，什么都不动', () => {
    const seed = seedDivergentBanks()
    // 当前文本在域里已经有一条活着的域行 ⇒ covered(published)，连暂存都不会尝试
    insertMemory(seed.corpusPath, {
      projectPath: ORG,
      category: 'CONSTRAINTS',
      content: '当前文本的活域行',
      normalizedHash: 'hash-rw-new',
    })
    const protectedId = insertCandidate(seed.adapterPath, {
      domainId: ORG,
      content: '已批准候选的正文，谁都不许动',
      normalizedHash: 'hash-rw-new',
      state: 'approved',
      category: 'CONSTRAINTS',
      sourceMemoryId: seed.sourceRewritten,
    })
    const backupDir = tempDir('mc-reconcile-backup-live-')
    copyFileSync(seed.corpusPath, join(backupDir, basename(seed.corpusPath)))
    copyFileSync(seed.adapterPath, join(backupDir, basename(seed.adapterPath)))

    const { out, log, warn } = io()
    expect(runReconcile({
      argv: ['--write', '--backup', backupDir, '--adapter-db', seed.adapterPath, '--corpus-db', seed.corpusPath],
      now: NOW,
      log,
      warn,
    })).toBe(0)

    const kept = candidateByHash(seed.adapterPath, 'hash-rw-new')
    expect(kept).toMatchObject({ id: protectedId, state: 'approved', content: '已批准候选的正文，谁都不许动' })
    expect(countCandidates(seed.adapterPath)).toBe(3)
    const text = out.join('\n')
    expect(text).toContain('已覆盖 1 条')
    expect(text).toContain('暂存候选 0 条')
  })

  it('collectSnapshots 只读读齐三份快照，不改库', () => {
    const seed = seedDivergentBanks()
    const before = countCandidates(seed.adapterPath)
    const snapshot = collectSnapshots({ adapterDbPath: seed.adapterPath, corpusDbPath: seed.corpusPath }) as {
      candidates: unknown[]
      domainRows: unknown[]
      sourceMemories: unknown[]
      candidatesWithoutSource: number
    }
    expect(snapshot.candidates).toHaveLength(2)
    expect(snapshot.domainRows).toHaveLength(2)
    expect(snapshot.sourceMemories).toHaveLength(2)
    expect(snapshot.candidatesWithoutSource).toBe(0)
    expect(countCandidates(seed.adapterPath)).toBe(before)
  })

  it('未知参数 / --help 不落到“默认干活”', () => {
    const { err, log, warn } = io()
    expect(runReconcile({ argv: ['--dry-run'], log, warn })).toBe(2)
    expect(err.join('\n')).toContain('未知参数')
    const help = io()
    expect(runReconcile({ argv: ['--help'], log: help.log, warn: help.warn })).toBe(0)
    expect(help.out.join('\n')).toContain('默认只读')
  })
})

describe('checkBackupGate', () => {
  it('没有写入动作时不需要备份；文件与目录两种形态都认', () => {
    const seed = seedDivergentBanks()
    expect(checkBackupGate(undefined, []).ok).toBe(true)

    const backupDir = tempDir('mc-reconcile-gate-')
    copyFileSync(seed.corpusPath, join(backupDir, basename(seed.corpusPath)))
    copyFileSync(seed.adapterPath, join(backupDir, basename(seed.adapterPath)))
    const both = [
      { dbPath: seed.corpusPath, marker: 'memories' },
      { dbPath: seed.adapterPath, marker: 'global_candidates' },
    ]
    expect(checkBackupGate(backupDir, both).ok).toBe(true)
    // 拿 corpus 的备份冒充 adapter 的：标志表对不上就拒
    expect(checkBackupGate(join(backupDir, basename(seed.corpusPath)), [
      { dbPath: seed.adapterPath, marker: 'global_candidates' },
    ]).ok).toBe(false)
    expect(checkBackupGate(join(backupDir, basename(seed.adapterPath)), [
      { dbPath: seed.adapterPath, marker: 'global_candidates' },
    ]).ok).toBe(true)
    expect(checkBackupGate(undefined, [{ dbPath: seed.adapterPath, marker: 'global_candidates' }]).ok).toBe(false)
  })
})
