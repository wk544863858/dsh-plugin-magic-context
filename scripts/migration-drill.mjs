/**
 * 契约库迁移演练（P4 数据件，只读真库 + 产出副本，2026-10-10）。
 *
 * 目标：为"收编 context.db 到自有库"的立项决策产出成本与风险数据。
 * 本演练 **不做任何迁移**：VACUUM INTO 出副本 → 逐表校验和比对 →
 * FTS 查询等价抽检 → 输出耗时/体积/风险清单。
 * 用法：node scripts/migration-drill.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { relaxedFtsQuery, sanitizeFtsQuery } from '../src/core/memory-search.ts'

const CONTRACT = join(homedir(), '.local', 'share', 'cortexkit', 'magic-context', 'context.db')
const OUT_DIR = join(process.cwd(), '<tmp>')
const COPY = join(OUT_DIR, 'context-copy.db')
const TABLES = [
  'memories', 'memory_embeddings', 'user_memories', 'user_memory_candidates',
  'memory_mutation_log', 'project_state', 'workspaces', 'workspace_members',
]

function tableFingerprint(db, table) {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  const hash = createHash('sha1')
  hash.update(`${table}:${String(rows.length)}\n`)
  for (const row of rows) hash.update(JSON.stringify(row) + '\n')
  return { rows: rows.length, sha1: hash.digest('hex').slice(0, 16) }
}

const t0 = Date.now()
mkdirSync(OUT_DIR, { recursive: true })
// VACUUM INTO 是本项目既定的备份方法（真库不被修改，产物是新文件）。
const db = new DatabaseSync(CONTRACT)
db.prepare('VACUUM INTO ?').run(COPY)
db.close()
const vacuumMs = Date.now() - t0

const original = new DatabaseSync(CONTRACT, { readOnly: true })
const copy = new DatabaseSync(COPY, { readOnly: true })
const existing = TABLES.filter(table =>
  original.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined)

console.log(`== 迁移演练（${new Date().toISOString().slice(0, 19)}）==`)
console.log(`VACUUM INTO：${String(vacuumMs)}ms；体积 原库 ${(statSync(CONTRACT).size / 1048576).toFixed(1)}MB / 副本 ${(statSync(COPY).size / 1048576).toFixed(1)}MB`)
console.log('')
console.log('== 逐表校验和（原库 vs 副本，预期全等）==')
let mismatch = 0
for (const table of existing) {
  const left = tableFingerprint(original, table)
  const right = tableFingerprint(copy, table)
  const same = left.rows === right.rows && left.sha1 === right.sha1
  if (!same) mismatch += 1
  console.log(`  ${same ? '✓' : '✗'} ${table.padEnd(24)} ${String(left.rows).padStart(5)} 行  ${left.sha1} ${same ? '' : `!= ${right.sha1}`}`)
}

console.log('')
console.log('== FTS 等价抽检（10 条真实查询，原库 vs 副本）==')
const queries = [
  '插件打包 分发 导入 DSH plugin package import distribute',
  'NTFS 所有者 sandbox ACL 权限',
  '前端项目 frontend 目录路径 vue react',
  '手工录入 激励 incentive manual entry',
  'magic-context 配置页面 config page options settings',
  'ci-templates pipeline master',
  '契约冻结 contract freeze digest',
  '巡检 patrol schedule 判据',
  '向量回填 embedding backfill parity',
  '配额 quota 跳过 skip route',
]
const ftsIds = (dbe, matchValue) => dbe.prepare(
  "SELECT memories.id AS id FROM memories_fts JOIN memories ON memories.id = memories_fts.rowid"
    + " WHERE memories_fts MATCH ? AND memories.status IN ('active','permanent') ORDER BY bm25(memories_fts) LIMIT 50",
).all(matchValue).map(row => Number(row.id))
let ftsOk = 0
for (const query of queries) {
  let ids = []
  try {
    const strict = sanitizeFtsQuery(query)
    if (strict.length > 0) ids = ftsIds(original, strict)
    if (ids.length === 0) {
      const relaxed = relaxedFtsQuery(query)
      if (relaxed.length > 0) ids = ftsIds(original, relaxed)
    }
  } catch { ids = [] }
  let copyIds = []
  try {
    const strict = sanitizeFtsQuery(query)
    if (strict.length > 0) copyIds = ftsIds(copy, strict)
    if (copyIds.length === 0) {
      const relaxed = relaxedFtsQuery(query)
      if (relaxed.length > 0) copyIds = ftsIds(copy, relaxed)
    }
  } catch { copyIds = [] }
  const same = JSON.stringify(ids) === JSON.stringify(copyIds)
  if (same) ftsOk += 1
  console.log(`  ${same ? '✓' : '✗'} "${query.slice(0, 30)}…" 命中 ${String(ids.length)} 行`)
}
original.close()
copy.close()

console.log('')
console.log('== 结论与风险清单 ==')
console.log(`  校验和不一致表：${String(mismatch)}（预期 0）；FTS 等价：${String(ftsOk)}/${String(queries.length)}（预期 10/10）`)
console.log('  若全等：克隆与 FTS 重建证明无损，迁移可行性成立；正式迁移另立方案（含：')
console.log('    ① epoch 指纹重算语义 ② baseline_state 水位延续 ③ m[0] digest 首趟重算触发 HARD')
console.log('    ④ ac1a 第二向量空间的去留 ⑤ 契约冻结探测器退役/改用途 ⑥ 剥离演练在真库复跑一次')
console.log(`  副本保留在 ${COPY} 供复核，验后可删。`)
