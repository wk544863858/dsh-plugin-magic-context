#!/usr/bin/env node
/**
 * domain-reconcile.mjs — 域行对账与修复（CLI）
 *
 * 「发布是复制不是镜像」：人类批准的候选被发布成域行（corpus 的 `memories` 表，
 * `project_path` = `dir:global:org` / `dir:global:machine`），但源记忆之后被改写或
 * 归档时不会传播到域行，也没有任何对账。这个脚本就是那道对账，加上人类门控的修复。
 *
 * 两条红线，代码里强约束（不是靠注释）：
 *
 *   1. **本工具绝不发布。** 域行的发布与撤销是人工门控。改写后的源只会被
 *      **暂存成一条 pending 候选**（供 `/ctx-global candidates` 人工审批），域行一律
 *      不动；源已亡才归档域行（`status='archived'`，软删除）。修复只经
 *      `DomainRepairPort` 的两个写口 —— `src/core/domain-reconcile.ts` 里连 publish
 *      seam 都没有。
 *   2. **默认只读。** 不传 `--write` 时只会 SELECT 并打印报表，一行都不写。`--write`
 *      还必须带 `--backup <path>`，而且这里会**真的去验证**那份备份（见
 *      `checkBackupGate`）：没有可用的备份就拒绝写，因为归档域行唯一的回滚手段
 *      就是库外备份。
 *
 * 用法：
 *   node scripts/domain-reconcile.mjs                      # 只读报表（中文）
 *   node scripts/domain-reconcile.mjs --json                # 同一份事实，机器可读
 *   node scripts/domain-reconcile.mjs --write --backup <dir|file>
 *   node scripts/domain-reconcile.mjs --adapter-db <path> --corpus-db <path>   # 合成库/演练
 *
 * 写入范围（`--write` 时，每步一个事务）：
 *   - 归档域行：`UPDATE memories SET status='archived'`（+ 一条 `memory_mutation_log`
 *     的 `archive` 增量，与 `src/core/memory-write.ts` 的 archive 写路径同形 —— 否则
 *     域身份的变更水位看不见这次撤销）。
 *   - 暂存候选：`INSERT INTO global_candidates(... state='pending')` + 一条观测行。
 *     已存在 `(domain_id, normalized_hash)` 时**不写**：adapter 的 upsert 会连
 *     approved 候选的 content 一起改写，所以这里只插新行。
 *
 * 幂等：同一分歧重复 `--write` 不产生重复候选（`(domain_id, normalized_hash)` 去重，
 * 由 `planRepair` 与写口各把一道）。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { applyRepair, auditDomainDivergences, planRepair } from '../src/core/domain-reconcile.ts'
import { parseFlags, stringFlag } from './cli-flags.mjs'

const BASE_DIR = join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc')
export const ADAPTER_DB = join(BASE_DIR, 'dsh-magic-context.db')
export const CORPUS_DB = join(BASE_DIR, 'memories.db')

/** 域身份的 corpus `project_path` 前缀（与 global-domains.ts 同源）。 */
const DOMAIN_PREFIXES = ['dir:global:', 'git:global:']

const KNOWN_FLAGS = ['write', 'backup', 'json', 'adapter-db', 'corpus-db']

/** 一个可选的备份命令提示：`VACUUM INTO` 需要一个不存在的目标文件。 */
const BACKUP_ONE_LINER = 'node --input-type=module -e "import { DatabaseSync } from \'node:sqlite\'; '
  + 'const d = new DatabaseSync(process.argv[1], { readOnly: true }); '
  + 'd.prepare(\'VACUUM INTO ?\').run(process.argv[2]); d.close()"'

function errText(error) {
  return error instanceof Error ? error.message : String(error)
}

function shortHash(hash) {
  return hash.length <= 12 ? hash : `${hash.slice(0, 12)}…`
}

function isDomainIdentity(projectPath) {
  return DOMAIN_PREFIXES.some(prefix => projectPath.startsWith(prefix))
}

/**
 * 只读读齐对账要的三份快照 —— 普通数组，`src/core/domain-reconcile.ts` 里不开库。
 * 三个 SELECT，两个只读连接，读完就关。
 */
export function collectSnapshots(input) {
  const adapter = new DatabaseSync(input.adapterDbPath, { readOnly: true })
  let candidateRows
  try {
    candidateRows = adapter
      .prepare(
        'SELECT id, domain_id AS domainId, normalized_hash AS normalizedHash, state, category, '
          + 'source_memory_id AS sourceMemoryId FROM global_candidates ORDER BY id',
      )
      .all()
  } finally {
    adapter.close()
  }
  const candidates = candidateRows.map(row => ({
    id: Number(row.id),
    domainId: String(row.domainId),
    normalizedHash: String(row.normalizedHash),
    state: String(row.state),
    category: row.category === null ? '' : String(row.category),
    sourceMemoryId: row.sourceMemoryId === null ? null : Number(row.sourceMemoryId),
  }))

  // 只在被引用的 id 上读源记忆：读全表没有意义，还会把正文无谓地带进内存。
  const sourceIds = [...new Set(candidates
    .map(candidate => candidate.sourceMemoryId)
    .filter(id => typeof id === 'number' && Number.isInteger(id) && id > 0))].sort((left, right) => left - right)

  const corpus = new DatabaseSync(input.corpusDbPath, { readOnly: true })
  let domainRows
  let sourceMemories
  try {
    domainRows = corpus
      .prepare(
        'SELECT id, project_path AS domainId, normalized_hash AS normalizedHash, status, category '
          + 'FROM memories WHERE project_path LIKE \'dir:global:%\' OR project_path LIKE \'git:global:%\'',
      )
      .all()
      .map(row => ({
        id: Number(row.id),
        domainId: String(row.domainId),
        normalizedHash: String(row.normalizedHash),
        status: String(row.status),
        category: String(row.category),
      }))
    sourceMemories = sourceIds.length === 0
      ? []
      : corpus
        .prepare(
          'SELECT id, status, normalized_hash AS normalizedHash, category, content, project_path AS projectPath '
            + `FROM memories WHERE id IN (${sourceIds.map(() => '?').join(', ')})`,
        )
        .all(...sourceIds)
        .map(row => ({
          id: Number(row.id),
          status: String(row.status),
          normalizedHash: String(row.normalizedHash),
          category: String(row.category),
          content: String(row.content),
          projectPath: String(row.projectPath),
        }))
  } finally {
    corpus.close()
  }

  return {
    candidates,
    domainRows,
    sourceMemories,
    /** 机器检测来的候选（没有源记忆可对）：它们不参与分歧判定。 */
    candidatesWithoutSource: candidates.filter(candidate => candidate.sourceMemoryId === null).length,
    sourceIdsLoaded: sourceIds.length,
  }
}

/**
 * 备份闸门。不强约束就没意义：`--write` 必须先有一份**能验证**的备份。
 *
 * `--backup` 可以是文件（本次计划只写一个库时）或目录（两个库都要写时，目录里要按
 * 源库同名各放一份）。每份备份都要能被只读打开、且带上目标库的标志表 —— 一个空文件
 * 或别的库冒充备份，在这里就被拒。
 */
export function checkBackupGate(backupPath, needed) {
  if (needed.length === 0) return { ok: true, detail: '本次计划没有写入动作' }
  const refuse = error => ({ ok: false, error: `${error}\n先备份（VACUUM INTO 不会覆盖已存在的文件）：\n${backupCommands(backupPath, needed)}` })

  if (backupPath === undefined || backupPath.length === 0) {
    return refuse('拒绝写入：--write 必须先做库外备份，并把它交给 --backup <path>（备份是对账工具唯一的回滚手段）')
  }
  const resolved = resolve(backupPath)
  if (!existsSync(resolved)) return refuse(`拒绝写入：--backup 指向的路径不存在：${resolved}`)

  let stat
  try {
    stat = statSync(resolved)
  } catch (error) {
    return refuse(`拒绝写入：--backup 路径不可读：${resolved}（${errText(error)}）`)
  }

  if (stat.isDirectory()) {
    for (const need of needed) {
      const file = join(resolved, basename(need.dbPath))
      if (!existsSync(file)) return refuse(`拒绝写入：备份目录 ${resolved} 里缺少 ${basename(need.dbPath)}`)
      const check = validateBackupFile(file, need.marker)
      if (!check.ok) return refuse(check.error)
    }
    return { ok: true, detail: `备份目录 ${resolved}（${needed.map(need => basename(need.dbPath)).join(', ')}）` }
  }
  if (needed.length > 1) {
    return refuse('拒绝写入：本次计划同时写 adapter 与 corpus 两个库，--backup 必须是一个目录（两份备份按源库同名放进去）')
  }
  const check = validateBackupFile(resolved, needed[0].marker)
  if (!check.ok) return refuse(check.error)
  return { ok: true, detail: `备份文件 ${resolved}` }
}

/** 逐库给出可直接粘贴的备份命令（多库时备份进同一个目录）。 */
function backupCommands(backupPath, needed) {
  const given = backupPath === undefined || backupPath.length === 0 ? null : resolve(backupPath)
  let asDirectory = needed.length > 1 || given === null
  if (given !== null) {
    try {
      asDirectory = asDirectory || statSync(given).isDirectory()
    } catch {
      /* 路径还不存在：单库时按文件处理 */
    }
  }
  return needed
    .map(need => {
      const destination = asDirectory ? join(given ?? '<备份目录>', basename(need.dbPath)) : given
      return `  ${BACKUP_ONE_LINER} "${need.dbPath}" "${destination}"`
    })
    .join('\n')
}

function validateBackupFile(file, marker) {
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    return { ok: false, error: `拒绝写入：备份不可读：${file}（${errText(error)}）` }
  }
  if (!stat.isFile() || stat.size === 0) return { ok: false, error: `拒绝写入：备份不是非空文件：${file}` }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    return { ok: false, error: `拒绝写入：备份无法作为 SQLite 库打开：${file}（${errText(error)}）` }
  }
  try {
    const row = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(marker)
    if (row === undefined) {
      return { ok: false, error: `拒绝写入：备份 ${file} 里没有 ${marker} 表 —— 这不像 ${marker} 所在库的备份` }
    }
  } catch (error) {
    return { ok: false, error: `拒绝写入：备份 ${file} 无法查询（${errText(error)}）` }
  } finally {
    db.close()
  }
  return { ok: true }
}

function hasTable(db, name) {
  try {
    return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  } catch {
    return false
  }
}

/** corpus 的写口：只归档，且只归档域身份下的行。 */
export function createCorpusPort(db, now) {
  const logMutation = hasTable(db, 'memory_mutation_log')
  return {
    archiveDomainRow(rowId) {
      const row = db.prepare('SELECT id, project_path, status FROM memories WHERE id = ?').get(rowId)
      if (row === undefined) return { ok: false, error: `corpus 里没有记忆 #${String(rowId)}` }
      const projectPath = String(row.project_path)
      if (!isDomainIdentity(projectPath)) {
        return { ok: false, error: `记忆 #${String(rowId)} 属于 ${projectPath}，不是域行 —— 拒绝对账工具碰它` }
      }
      if (String(row.status) === 'archived') return { ok: true, changed: false }
      db.exec('BEGIN IMMEDIATE')
      try {
        const updated = db
          .prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'archived'")
          .run(now, rowId)
        if (logMutation) {
          db.prepare(
            'INSERT INTO memory_mutation_log(project_path, mutation_type, target_memory_id, superseded_by_id, '
              + 'category, new_content, queued_at) VALUES(?, ?, ?, NULL, NULL, NULL, ?)',
          ).run(projectPath, 'archive', rowId, now)
        }
        db.exec('COMMIT')
        return { ok: true, changed: Number(updated.changes) > 0 }
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 事务可能已被 SQLite 自己回滚 */
        }
        return { ok: false, error: errText(error) }
      }
    },
  }
}

/**
 * adapter 的写口：只暂存 pending 候选，绝不发布、绝不复用已存在的键。
 *
 * 两处刻意的克制：已存在 `(domain_id, normalized_hash)` 直接返回它（`created:false`）
 * 而不用 `upsertGlobalCandidate` —— 那个 upsert 在冲突时会把 `content` 改写掉，连
 * approved 候选也不例外；观测行则与 `promoteMemoryToCandidate` 同形，让复核卡片
 * 看得出来这条提案是从哪条源记忆来的。
 */
export function createAdapterPort(db, now, corpus) {
  return {
    stageCandidate(input) {
      const domain = db.prepare('SELECT domain_id FROM domains WHERE domain_id = ?').get(input.domainId)
      if (domain === undefined) return { ok: false, error: `unknown domain '${input.domainId}'` }
      const existing = db
        .prepare('SELECT id, state FROM global_candidates WHERE domain_id = ? AND normalized_hash = ?')
        .get(input.domainId, input.normalizedHash)
      if (existing !== undefined) {
        // 同键候选默认只读复用。唯一例外 = **死批准**：它在 corpus 里的已发布副本已经不是
        // active/permanent（被归档），却永久占着唯一键，挡住这份当前文本唯一诚实的提案。
        // 此时原地重新提审（content/state 回 pending），既不发布、也不 DELETE（2026-10-16 用户裁决）。
        // 活批准与人工拒绝一律不动：前者说明文本已在库里，后者是人说过的"不"。
        // 死活要问 corpus（memories 表不在 adapter 库里），所以这个口必须拿到 corpus 连接。
        if (existing.state === 'approved') {
          const live = corpus
            .prepare("SELECT id FROM memories WHERE project_path = ? AND normalized_hash = ? AND status IN ('active','permanent')")
            .get(input.domainId, input.normalizedHash)
          if (live === undefined) {
            db.prepare(
              'UPDATE global_candidates SET content = ?, category = ?, source_memory_id = ?, first_identity = ?, '
                + "suggested_domain = ?, suggestion_reason = ?, state = 'pending', updated_at = ? WHERE id = ?",
            ).run(
              input.content,
              input.category,
              input.sourceMemoryId,
              input.sourceIdentity,
              input.suggestedDomain,
              input.reason,
              now,
              existing.id,
            )
            return { ok: true, candidateId: Number(existing.id), created: false, reproposed: true }
          }
        }
        return { ok: true, candidateId: Number(existing.id), created: false }
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        const inserted = db
          .prepare(
            'INSERT INTO global_candidates(domain_id, content, normalized_hash, first_identity, session_id, '
              + 'compartment_start, compartment_end, distinct_identities, observation_count, category, source_memory_id, '
              + 'suggested_domain, suggestion_reason, state, created_at, updated_at) '
              + "VALUES(?, ?, ?, ?, NULL, NULL, NULL, 0, 0, ?, ?, ?, ?, 'pending', ?, ?)",
          )
          .run(
            input.domainId,
            input.content,
            input.normalizedHash,
            input.sourceIdentity,
            input.category,
            input.sourceMemoryId,
            input.suggestedDomain,
            input.reason,
            now,
            now,
          )
        const candidateId = Number(inserted.lastInsertRowid)
        db.prepare(
          'INSERT INTO global_candidate_observations(candidate_id, identity, session_id, compartment_start, '
            + 'compartment_end, observations, first_seen_at, last_seen_at) VALUES(?, ?, ?, NULL, NULL, 1, ?, ?)',
        ).run(candidateId, input.sourceIdentity, `memory:${String(input.sourceMemoryId)}`, now, now)
        db.prepare('UPDATE global_candidates SET distinct_identities = 1, observation_count = 1, updated_at = ? WHERE id = ?')
          .run(now, candidateId)
        db.exec('COMMIT')
        return { ok: true, candidateId, created: true }
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 事务可能已被 SQLite 自己回滚 */
        }
        return { ok: false, error: errText(error) }
      }
    },
  }
}

/** `journal: domain-reconcile …` —— 一行一条，正文永不入账。 */
export function renderJournalLine(entry) {
  const data = Object.keys(entry.data).length === 0 ? '' : ` ${JSON.stringify(entry.data)}`
  return `journal: domain-reconcile [${entry.action}] ${entry.summary}${data}`
}

export function renderReport({ report, plan, mode, adapterDbPath, corpusDbPath }) {
  const lines = []
  lines.push(`域行对账（${mode === 'write' ? '写入模式' : '只读'}）：adapter=${adapterDbPath}  corpus=${corpusDbPath}`)
  lines.push(
    `候选 checked=${String(report.checked)} · healthy=${String(report.healthy)} · unlinked=${String(report.unlinked)}`
      + ` · 分歧=${String(report.divergences.length)}`,
  )
  // 「已覆盖」不是分歧：源已改写，但它现在的文本在同一个域里已经有活着的域行（已发布）或
  // 待审候选（已暂存）。没有这一栏，修完的域会被永久报成分歧、每跑一次就重复提案一遍。
  if (report.covered.length > 0) {
    lines.push(`已覆盖 ${String(report.covered.length)} 条（源已改写，但当前文本已在同域被处理：不计分歧、无需修复）：`)
    for (const item of report.covered) {
      const via = item.via === 'published' ? `域行 #${String(item.coveredBy)}` : `待审候选 #${String(item.coveredBy)}`
      lines.push(`  候选 #${String(item.candidateId)}（域行 #${String(item.domainRowId)} 是旧文本）→ 当前文本见 ${via}`)
    }
  }
  if (report.unlinked > 0) {
    lines.push(`未关联 ${String(report.unlinked)} 条（没有 (domain_id, normalized_hash) 对应的域行：pending/rejected 从未发布过，不算故障）`)
    lines.push(`  ${report.unlinkedCandidateIds.map(id => `#${String(id)}`).join(' ')}`)
  } else {
    lines.push('未关联 0 条：每条候选都能在 corpus 里找到自己的域行')
  }
  if (report.skippedArchivedDomainRows.length > 0) {
    lines.push(`域行已归档 ${String(report.skippedArchivedDomainRows.length)} 条（跳过，不计分歧）：`)
    for (const skipped of report.skippedArchivedDomainRows) {
      lines.push(`  候选 #${String(skipped.candidateId)} → 域行 #${String(skipped.domainRowId)}`)
    }
  }
  if (report.divergences.length === 0) {
    lines.push('分歧 0 条：已发布的域行与它们的源记忆一致')
  } else {
    lines.push(`分歧明细 ${String(report.divergences.length)} 条：`)
    for (const divergence of report.divergences) {
      const source = divergence.sourceNormalizedHash === null
        ? '源记忆已不存在'
        : `源现哈希 ${shortHash(divergence.sourceNormalizedHash)}`
      lines.push(
        `  #${String(divergence.candidateId)} ${divergence.kind} 域 ${divergence.domainId}`
          + ` 域行 #${String(divergence.domainRowId)} 源记忆 #${String(divergence.sourceMemoryId)}`
          + `（候选哈希 ${shortHash(divergence.publishedNormalizedHash)} → ${source}）`,
      )
    }
  }
  lines.push(mode === 'write' ? '修复计划（待应用）：' : '修复计划（只读：以下动作未被执行）：')
  lines.push(plan.archiveRowIds.length === 0
    ? '  归档域行 0 条'
    : `  归档域行 ${String(plan.archiveRowIds.length)} 条（status='archived'，软删除）：${plan.archiveRowIds.map(id => `#${String(id)}`).join(' ')}`)
  lines.push(plan.stageCandidates.length === 0
    ? '  暂存候选 0 条'
    : `  暂存候选 ${String(plan.stageCandidates.length)} 条（pending，等人工审批；本工具绝不发布）：`)
  for (const proposal of plan.stageCandidates) {
    const rows = proposal.derivedFrom.map(item => `#${String(item.domainRowId)}`).join(' ')
    lines.push(
      `    域 ${proposal.domainId} 源记忆 #${String(proposal.sourceMemoryId)} 哈希 ${shortHash(proposal.normalizedHash)}`
        + ` 代替域行 ${rows}`,
    )
  }
  for (const item of plan.unrepairable) {
    lines.push(`  ⚠ 无法修复：候选 #${String(item.candidateId)}（${item.kind}）—— ${item.reason}`)
  }
  return lines
}

function toJsonDivergence(divergence) {
  return {
    kind: divergence.kind,
    candidateId: divergence.candidateId,
    domainId: divergence.domainId,
    domainRowId: divergence.domainRowId,
    sourceMemoryId: divergence.sourceMemoryId,
    publishedNormalizedHash: divergence.publishedNormalizedHash,
    sourceNormalizedHash: divergence.sourceNormalizedHash,
    sourceCategory: divergence.sourceCategory,
    sourceIdentity: divergence.sourceIdentity,
    // 正文不入 JSON：这份输出常被贴进日志，正文只留在库里。
    sourceContentLength: divergence.sourceContent === null ? null : divergence.sourceContent.length,
  }
}

export function toJsonPayload({ mode, adapterDbPath, corpusDbPath, snapshot, report, plan, backup, applied, journal }) {
  return {
    mode,
    adapterDb: adapterDbPath,
    corpusDb: corpusDbPath,
    backup: backup ?? null,
    snapshot: {
      candidates: snapshot.candidates.length,
      candidatesWithoutSource: snapshot.candidatesWithoutSource,
      domainRows: snapshot.domainRows.length,
      sourceMemories: snapshot.sourceMemories.length,
    },
    audit: {
      checked: report.checked,
      healthy: report.healthy,
      unlinked: report.unlinked,
      unlinkedCandidateIds: report.unlinkedCandidateIds,
      skippedArchivedDomainRows: report.skippedArchivedDomainRows,
      covered: report.covered,
      divergences: report.divergences.map(toJsonDivergence),
    },
    plan: {
      archiveRowIds: plan.archiveRowIds,
      stageCandidates: plan.stageCandidates.map(proposal => ({
        domainId: proposal.domainId,
        normalizedHash: proposal.normalizedHash,
        category: proposal.category,
        sourceMemoryId: proposal.sourceMemoryId,
        sourceIdentity: proposal.sourceIdentity,
        suggestedDomain: proposal.suggestedDomain,
        reason: proposal.reason,
        derivedFrom: proposal.derivedFrom,
        contentLength: proposal.content.length,
      })),
      unrepairable: plan.unrepairable,
    },
    applied: applied ?? null,
    journal: journal ?? [],
  }
}

const USAGE = [
  '用法: node scripts/domain-reconcile.mjs [--write --backup <dir|file>] [--json]',
  '      [--adapter-db <path>] [--corpus-db <path>]',
  '',
  '  默认只读：只 SELECT + 打印报表，绝不改库。',
  '  --write            应用修复计划（归档源已亡的域行；改写后的源只暂存候选，不发布）',
  '                     同键候选默认不动；唯一例外是"死批准"（已发布副本已归档）——原地重新提审',
  '  --backup <path>    --write 的强制前提：库外备份，文件或目录（两个库都要写时用目录）',
  '  --json             输出同一份事实的 JSON（不含记忆正文）',
  '  --adapter-db / --corpus-db  指向别的库（演练 / 合成库）',
].join('\n')

/**
 * CLI 主体。`deps.applyRepair` 是测试缝：只读模式下它永远不该被调用，用例把探针塞进来
 * 就能证明这一点（`tests/domain-reconcile.spec.ts` 用例 ⑥）。
 *
 * @returns {number} 进程退出码（0 成功；2 用法或备份闸门拒绝；1 库不可读）
 */
export function runReconcile(options = {}) {
  const argv = options.argv ?? process.argv.slice(2)
  const log = options.log ?? (line => console.log(line))
  const warn = options.warn ?? (line => console.error(line))
  const now = options.now ?? Date.now()
  const deps = options.deps ?? {}
  const apply = deps.applyRepair ?? applyRepair

  const parsed = parseFlags(argv, KNOWN_FLAGS)
  if (parsed.unknown.length > 0) {
    warn(`未知参数: ${parsed.unknown.join(', ')}；--help 查看用法`)
    return 2
  }
  if (parsed.help) {
    log(USAGE)
    return 0
  }
  const adapterDbPath = stringFlag(parsed.flags, 'adapter-db') ?? ADAPTER_DB
  const corpusDbPath = stringFlag(parsed.flags, 'corpus-db') ?? CORPUS_DB
  const backupPath = stringFlag(parsed.flags, 'backup')
  const write = parsed.flags.has('write')
  const asJson = parsed.flags.has('json')
  const mode = write ? 'write' : 'read-only'

  let snapshot
  try {
    snapshot = collectSnapshots({ adapterDbPath, corpusDbPath })
  } catch (error) {
    warn(`库不可读：${errText(error)}`)
    return 1
  }
  const report = auditDomainDivergences(snapshot)
  const plan = planRepair(report)

  if (!write) {
    if (asJson) {
      log(JSON.stringify(toJsonPayload({ mode, adapterDbPath, corpusDbPath, snapshot, report, plan, applied: null, journal: [] }), null, 2))
      return 0
    }
    for (const line of renderReport({ report, plan, mode, adapterDbPath, corpusDbPath })) log(line)
    if (report.divergences.length > 0) {
      log('只读模式：未写任何库。要应用上面的计划：--write --backup <path>（先 VACUUM INTO 备份）。')
    }
    return 0
  }

  // 备份闸门在**开写连接之前**：拒绝写入必须一分钱都不花。
  const needed = []
  if (plan.archiveRowIds.length > 0) needed.push({ dbPath: corpusDbPath, marker: 'memories' })
  if (plan.stageCandidates.length > 0) needed.push({ dbPath: adapterDbPath, marker: 'global_candidates' })

  // 先把计划摆出来（写入模式下也一样），拒绝时才不会只给一句错误。
  if (!asJson) {
    for (const line of renderReport({ report, plan, mode, adapterDbPath, corpusDbPath })) log(line)
  }

  const gate = checkBackupGate(backupPath, needed)
  if (!gate.ok) {
    warn(gate.error)
    return 2
  }
  if (needed.length === 0) {
    log('本次计划没有写入动作：无需备份，也未开写连接。')
    if (asJson) log(JSON.stringify(toJsonPayload({ mode, adapterDbPath, corpusDbPath, snapshot, report, plan, applied: null, journal: [] }), null, 2))
    return 0
  }

  const journalEntries = []
  const emitJournal = entry => {
    journalEntries.push(entry)
    const line = renderJournalLine(entry)
    if (asJson) warn(line)
    else log(line)
  }

  const corpus = new DatabaseSync(corpusDbPath)
  const adapter = new DatabaseSync(adapterDbPath)
  let applied
  try {
    corpus.exec('PRAGMA busy_timeout = 5000')
    adapter.exec('PRAGMA busy_timeout = 5000')
    applied = apply(plan, { ...createCorpusPort(corpus, now), ...createAdapterPort(adapter, now, corpus) }, { now, journal: emitJournal })
  } catch (error) {
    warn(`写入失败：${errText(error)}`)
    return 1
  } finally {
    corpus.close()
    adapter.close()
  }

  if (asJson) {
    log(JSON.stringify(toJsonPayload({
      mode, adapterDbPath, corpusDbPath, snapshot, report, plan,
      backup: gate.detail, applied, journal: journalEntries,
    }), null, 2))
    return 0
  }
  log(`备份：${gate.detail}`)
  log(`已应用：归档 ${String(applied.archived.length)} 条 · 暂存 ${String(applied.staged.length)} 条 · 拒绝 ${String(applied.archiveRefusals.length + applied.stageRefusals.length)} 条`)
  for (const row of applied.staged) {
    const how = row.created ? '（新建）' : row.reproposed ? '（重新提审：原批准副本已归档，键被它占着）' : '（已存在，未重复写入）'
    log(`  暂存候选 #${String(row.candidateId)}${how} · 域 ${row.domainId} · 源记忆 #${String(row.sourceMemoryId)}`)
  }
  for (const refusal of applied.stageRefusals) {
    log(`  暂存被拒：域 ${refusal.domainId} · 哈希 ${shortHash(refusal.normalizedHash)} —— ${refusal.error}`)
  }
  for (const refusal of applied.archiveRefusals) {
    log(`  归档未生效：域行 #${String(refusal.rowId)} —— ${refusal.error}`)
  }
  log('已暂存的候选仍需人工审批才会发布（/ctx-global candidates）—— 本工具不会代劳。')
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runReconcile()
}
