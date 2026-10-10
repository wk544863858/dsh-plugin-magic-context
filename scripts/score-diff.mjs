/**
 * S(t) 排序离线 diff（2026-10-10，风险 1 的"数据先行"）。
 *
 * 用途：`memory.scoring.enabled` 开关翻转前，用**同一份真实数据**对比两份 m[0]
 * 名单（现状=MC 优先序 vs 候选=S(t) 降序），回答"开排序到底换进/换出什么"。
 * 只读：契约库经 openMemoryBridge（readOnly + v95 fence），sidecar 只读直查。
 *
 * 用法：
 *   node scripts/score-diff.mjs [--project <identity|dir>] [--budget 8000] [--limit 40] [--json]
 * 不给 --project 时取 cwd 的 git/dir 身份（与 lane 的 resolveProjectIdentity 同源）。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openMemoryBridge, resolveIdentitySpec, resolveProjectIdentity } from '../src/core/memory-bridge.ts'
import { DEFAULT_MEMORY_SCORING, scoreMemory } from '../src/core/memory-scoring.ts'
import { parseFlags, stringFlag } from './cli-flags.mjs'

const ADAPTER_DB = join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'dsh-magic-context.db')

/**
 * 离场行分类：被 S(t) 规则"退役"（localArchived 或 score < archiveThreshold，
 * 仍可检索但不再注入）还是被"挤掉"（预算竞争失败）。
 */
export function classifyDeparted(rows, statsById, config, now) {
  return rows.map(row => {
    const stat = statsById.get(Number(row.id))
    const score = scoreMemory(
      {
        importance: row.importance,
        category: row.category,
        hits: stat?.hits ?? 0,
        ...(stat?.lastHitAt === undefined ? {} : { lastHitAt: stat.lastHitAt }),
      },
      config,
      now,
    )
    const retired = stat?.localArchived === true || score < config.archiveThreshold
    return { id: Number(row.id), category: row.category, importance: row.importance ?? null, score, retired, hits: stat?.hits ?? 0 }
  })
}

function loadStatsById() {
  const statsById = new Map()
  try {
    const db = new DatabaseSync(ADAPTER_DB, { readOnly: true })
    try {
      const rows = db.prepare('SELECT memory_id, hits, last_hit_at, local_archived FROM memory_stats').all()
      for (const row of rows) {
        statsById.set(Number(row.memory_id), {
          hits: Number(row.hits) || 0,
          ...(Number(row.last_hit_at) > 0 ? { lastHitAt: Number(row.last_hit_at) } : {}),
          localArchived: Number(row.local_archived) === 1,
        })
      }
    } finally { db.close() }
  } catch {
    // sidecar 缺席时按零命中算 —— S(t) 退化为 importance 排序，照常可比。
  }
  return statsById
}

function fmtRow(row) {
  return `  #${String(row.id)} [${row.category}] importance ${row.importance === null || row.importance === undefined ? '?' : String(row.importance)}`
    + ` · hits ${String(row.hits ?? 0)} · score ${row.score === undefined ? '?' : row.score.toFixed(1)}`
    + `${row.retired === true ? ' · 退役(阈值)' : ''}`
}

function main() {
  const parsed = parseFlags(process.argv.slice(2), ['project', 'budget', 'limit', 'json'])
  if (parsed.unknown.length > 0) {
    console.error(`未知参数: ${parsed.unknown.join(', ')}；--help 查看用法`)
    process.exit(2)
  }
  if (parsed.help) {
    console.log('用法: node scripts/score-diff.mjs [--project <identity|dir>] [--budget 8000] [--limit 40] [--json]')
    process.exit(0)
  }
  const projectSpec = stringFlag(parsed.flags, 'project')
  const project = (projectSpec !== undefined ? resolveIdentitySpec(projectSpec) : undefined)
    || resolveProjectIdentity(process.cwd())
  if (project === undefined || project.length === 0) {
    console.error('无法解析项目身份（cwd 无 git remote 且未给 --project）')
    process.exit(2)
  }
  const budgetTokens = Number(stringFlag(parsed.flags, 'budget')) || 8000
  const limit = Number(stringFlag(parsed.flags, 'limit')) || 40
  const asJson = parsed.flags.has('json')

  const bridge = openMemoryBridge({ logger: { warn: (m) => console.error(m) } })
  if (!bridge.status.ok) {
    console.error(`契约库不可用: ${bridge.status.detail}`)
    process.exit(1)
  }
  const statsById = loadStatsById()
  const config = { ...DEFAULT_MEMORY_SCORING, enabled: true }
  const base = { project, budgetTokens, limit, now: Date.now() }
  const current = bridge.recall(base)
  const scored = bridge.recall({ ...base, scoring: { config, statsById } })
  bridge.close()

  const currentIds = new Set((current?.rows ?? []).map(row => Number(row.id)))
  const scoredIds = new Set((scored?.rows ?? []).map(row => Number(row.id)))
  const both = [...currentIds].filter(id => scoredIds.has(id))
  const departed = (current?.rows ?? []).filter(row => !scoredIds.has(Number(row.id)))
  const entered = (scored?.rows ?? []).filter(row => !currentIds.has(Number(row.id)))
  const classified = classifyDeparted(departed, statsById, config, base.now)
  const retiredCount = classified.filter(row => row.retired).length

  if (asJson) {
    console.log(JSON.stringify({
      project, budgetTokens, limit, statsRows: statsById.size,
      current: currentIds.size, scored: scoredIds.size, overlap: both.length,
      departed: classified, entered: entered.map(row => ({ id: Number(row.id), category: row.category })),
    }, null, 2))
    return
  }

  console.log(`S(t) 排序 diff（project ${project}，预算 ${String(budgetTokens)} tok / ${String(limit)} 行，sidecar ${String(statsById.size)} 行）`)
  console.log(`  现状(MC 优先序) ${String(currentIds.size)} 行 vs 候选(S(t) 降序) ${String(scoredIds.size)} 行；重叠 ${String(both.length)}`)
  console.log(`  换出 ${String(departed.length)} 行（其中退役 ${String(retiredCount)}：score<${String(config.archiveThreshold)} 或 localArchived，仍可检索）`)
  for (const row of classified.slice(0, 20)) console.log(fmtRow(row))
  if (classified.length > 20) console.log(`  … 其余 ${String(classified.length - 20)} 行省略（--json 看全量）`)
  console.log(`  换入 ${String(entered.length)} 行`)
  for (const row of entered.slice(0, 20)) {
    const stat = statsById.get(Number(row.id))
    const score = scoreMemory({ importance: row.importance, category: row.category, hits: stat?.hits ?? 0, ...(stat?.lastHitAt === undefined ? {} : { lastHitAt: stat.lastHitAt }) }, config, base.now)
    console.log(fmtRow({ ...row, hits: stat?.hits ?? 0, score }))
  }
  if (entered.length > 20) console.log(`  … 其余 ${String(entered.length - 20)} 行省略`)
  console.log(departed.length === 0 && entered.length === 0
    ? '  结论：两份名单完全一致 —— 开关翻转对当前池无影响。'
    : `  结论：翻转将替换 ${String(departed.length)} 行（含退役 ${String(retiredCount)}）。复核换入行的正确性后再决定。`)
}

main()
