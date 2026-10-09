#!/usr/bin/env node
/**
 * `dsh-doctor` — 只读的适配器健康报告。
 *
 *   node scripts/dsh-doctor.mjs [--store <context.db>] [--adapter-dir <dir>] [--json]
 *
 * 与上游 `magic-context doctor` 的关系：上游 doctor 是**宿主感知**的，只认
 * opencode/opencode2/pi/omp（`packages/cli/src/adapters/`），没有 DSH lane，所以
 * 它查不了本适配器；但它的检查清单里有四件事在 DSH 侧同样成立、且现在没人查：
 *
 *   1. pinned 构建的 schema fence 与线上库是否一致（**裁决**，不只是打印版本）；
 *   2. 进行中的 run（上游查 compaction markers 是否收尾）；
 *   3. 最近的错误及其原因（上游查宿主日志的近期错误）；
 *   4. 本地 embedding 运行时是否真的可用（上游查 native/WASM 回退）。
 *
 * 另有一条本仓自有的检查：
 *
 *   5. 事件车道心跳：宿主改名事件字符串不会报错，只会让各车道永久安静；
 *      "挂载过却长期零 journal/usage 活动"是离线可观测的特征（启发式，只
 *      WARN 不阻断——DSH 没人用时同样安静）。
 *
 * `mc-memory-audit.mjs` 已经报了 adapter schema、MC 库 schema 与写模式等**原始值**；
 * 本脚本不重复那些数字，只补上面四类**裁决**与“下一步动作”。
 *
 * 退出码：0 = 无阻断问题；1 = 有（库比构建新、adapter schema 不一致、库缺失）。
 * 只读：以 readOnly 打开两个库，不写任何文件。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const asJson = argv.includes('--json')

const MC_STORE = value('--store', join(homedir(), '.local', 'share', 'cortexkit', 'magic-context', 'context.db'))
const ADAPTER_DIR = value('--adapter-dir', join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc'))
const ADAPTER_DB = join(ADAPTER_DIR, 'dsh-magic-context.db')
const ACTIVITY_LOG = join(ADAPTER_DIR, 'activity.log')

const source = (file, pattern) => {
  const match = pattern.exec(readFileSync(join(PKG, file), 'utf8'))
  return match === null ? undefined : Number(match[1])
}
/** 本构建接受的 MC 存储契约上限（`src/core/memory-bridge.ts`）。 */
const CEILING = source('src/core/memory-bridge.ts', /MEMORY_SCHEMA_MAX_VERSION\s*=\s*(\d+)/)
/** 适配器自有库的 schema（`src/core/stores.ts`）。 */
const ADAPTER_SCHEMA = source('src/core/stores.ts', /SCHEMA_VERSION\s*=\s*(\d+)/)
/** `memory.embedBackfill` 的缺省值（`src/dsh/memory-lane.ts`）。 */
const BACKFILL_DEFAULT = /embedBackfill,\s*(true|false)/.exec(readFileSync(join(PKG, 'src/dsh/memory-lane.ts'), 'utf8'))?.[1] === 'true'

const blocks = []
const hard = []
const open = (title) => blocks.push({ title, lines: [] })
const say = (mark, text) => blocks.at(-1).lines.push(`${mark} ${text}`)
const bad = (text) => {
  blocks.at(-1).lines.push(`✗ ${text}`)
  hard.push(text)
}
const age = (at) => {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} 小时前`
  return `${Math.round(minutes / 1440)} 天前`
}
const readOnly = (path) => new DatabaseSync(path, { readOnly: true })
const maxVersion = (db) => db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000').get()?.v

// ── 1. MC 存储：fence 裁决（不是打印版本，而是"现在能不能写、下次升级会怎样"） ──
open('1. Magic Context 存储（fence）')
if (!existsSync(MC_STORE)) {
  say('⚠', `库不存在：${MC_STORE}`)
  say(' ', '记忆写入与项目记忆检索会整体关闭；MC 侧首次运行会创建它')
} else {
  try {
    const db = readOnly(MC_STORE)
    const version = Number(maxVersion(db) ?? 0)
    db.close()
    const headroom = CEILING - version
    say(' ', `路径 ${MC_STORE}`)
    say(' ', `库 schema v${version} · 本构建上限 v${CEILING} · 余量 ${headroom}`)
    if (version > CEILING) {
      bad(`库 v${version} 比本构建上限 v${CEILING} 新 → 写路径已降级只读（ctx_memory 写入返回 ok:false）`)
      say(' ', `动作：读 MC v? 的 migration ${version}，确认无列形状变更后把 MEMORY_SCHEMA_MAX_VERSION 提到 ${version}，并同步 fence spec`)
    } else if (headroom === 0) {
      say('⚠', '已在上限：MC 下一次迁移会让写路径降级只读，直到上限跟进')
    } else {
      say('✓', `写路径可用，且还有 ${headroom} 个版本的余量`)
    }
  } catch (error) {
    bad(`打开失败：${error.message}`)
  }
}

// ── 2. 适配器自有库 ──
open('2. 适配器自有库')
if (!existsSync(ADAPTER_DB)) {
  bad(`库不存在：${ADAPTER_DB}（适配器尚未挂载过？）`)
} else {
  try {
    const db = readOnly(ADAPTER_DB)
    const meta = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value
    const journal = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM journal').get()
    db.close()
    const live = Number(meta ?? 0)
    say(' ', `${ADAPTER_DB}`)
    if (live !== ADAPTER_SCHEMA) bad(`自有库 schema v${live} ≠ 源码 v${ADAPTER_SCHEMA}（迁移未跑完或降级启动）`)
    else say('✓', `自有库 schema v${live} 与源码一致`)
    say(' ', `journal ${journal?.n ?? 0} 行 · ${journal?.first ? age(journal.first) : '-'} → ${journal?.last ? age(journal.last) : '-'}`)
  } catch (error) {
    bad(`打开失败：${error.message}`)
  }
  if (existsSync(ACTIVITY_LOG)) say(' ', `activity.log ${(statSync(ACTIVITY_LOG).size / 1024).toFixed(0)} KB`)
}

// ── 3. 事件车道心跳（静默失效检测；启发式，只 WARN 不阻断） ──
// 宿主改掉事件字符串（agent/pre-step 等）不会让适配器报错：监听器只是永远
// 不触发。可离线观测的特征是"挂载过，但 journal 与 usage 车道此后再无任何
// 行"。DSH 没人用时同样安静——所以只 WARN，请结合"DSH 是否真的在用"判读。
open('3. 事件车道心跳')
if (!existsSync(ADAPTER_DB)) {
  say(' ', '（自有库不存在，跳过）')
} else {
  try {
    const db = readOnly(ADAPTER_DB)
    const lastBoot = db.prepare("SELECT MAX(at) AS at FROM journal WHERE kind='boot'").get()?.at
    const lastJournal = db.prepare('SELECT MAX(at) AS at FROM journal').get()?.at
    const lastUsage = db.prepare('SELECT MAX(recorded_at) AS at FROM usage_records').get()?.at
    db.close()
    if (lastBoot === undefined) {
      say(' ', 'journal 无 boot 行（适配器从未挂载，或库是旧版本建的）')
    } else {
      say(' ', `最近挂载 ${age(lastBoot)} · 最近 journal 行 ${lastJournal === undefined ? '-' : age(lastJournal)} · 最近 usage 行 ${lastUsage === undefined ? '-' : age(lastUsage)}`)
      const DAY = 86_400_000
      const quiet = (lastJournal === undefined || Date.now() - lastJournal > DAY)
        && (lastUsage === undefined || Date.now() - lastUsage > DAY)
      if (quiet && Date.now() - lastBoot > DAY) {
        say('⚠', '挂载已超过 24h，之后 journal 与 usage 车道零活动——若 DSH 此期间确实在用，这是事件接缝静默失效的特征（宿主改名事件字符串？）')
        say(' ', '动作：对照 docs/dsh-plugin-upgrade-followup.md §3 逐条冒烟（preStep 注入 / postToolExecute 打标 / requestError 应急 / ctx.llm 流 / client 座位）')
      } else {
        say('✓', '车道有近期活动，事件接缝看起来连通')
      }
    }
  } catch (error) {
    say('⚠', `心跳读取失败：${error.message}`)
  }
}

// ── 4. 进行中的 run（镜像 recoverOrphanHistorianRuns 的配对规则） ──
open('4. 进行中的 run')
if (existsSync(ADAPTER_DB)) {
  try {
    const db = readOnly(ADAPTER_DB)
    const rows = db
      .prepare("SELECT at, session_id, level, data FROM journal WHERE kind='historian' ORDER BY id ASC")
      .all()
    const recentErrors = db
      .prepare("SELECT at, kind, summary, data FROM journal WHERE level='error' ORDER BY id DESC LIMIT 8")
      .all()
    const lastError = db.prepare("SELECT MAX(at) AS at FROM journal WHERE level='error'").get()?.at
    db.close()
    const parse = (raw) => {
      try {
        return raw === null || raw === undefined ? {} : JSON.parse(raw)
      } catch {
        return {}
      }
    }
    const openRuns = new Map()
    let recovered = 0
    for (const row of rows) {
      const data = parse(row.data)
      const key = row.session_id ?? '-'
      if (data.recovered === true && Date.now() - row.at < 86_400_000) recovered += 1
      if (data.phase === 'start') openRuns.set(key, row.at)
      else if (data.phase === 'done' || data.phase === 'failed') openRuns.delete(key)
    }
    say(' ', `historian 行 ${rows.length} · 当前未收尾 ${openRuns.size}`)
    if (openRuns.size === 0) say('✓', '没有悬空的 historian start')
    else {
      say('⚠', `未收尾的 session：${[...openRuns.keys()].join(', ')}`)
      say(' ', '若本进程正在执行一轮，这是正常的；只有跨挂载仍不收尾才是缺陷（挂载时会自愈）')
    }
    say(' ', `近 24h 的挂载自愈（adapter-remount）：${recovered}`)

    // ── 5. 失败尾部（上游 doctor 查"近期错误"，这里查适配器自己的 journal） ──
    blocks.push({ title: '5. 失败尾部（最近 8 条 error）', lines: [] })
    if (recentErrors.length === 0) say('✓', 'journal 无 error 行')
    else {
      for (const row of recentErrors) {
        const data = parse(row.data)
        const why = data.reason ?? data.errorName ?? data.phase ?? ''
        const summary = String(row.summary ?? '').slice(0, 110)
        say('•', `${age(row.at)} · ${row.kind} · ${summary}`)
        if (why && !summary.includes(String(why))) say(' ', `  ${String(why).slice(0, 110)}`)
      }
      if (lastError !== undefined && Date.now() - lastError < 86_400_000) {
        say('⚠', `最近一次 error 在 ${age(lastError)}——先看它的 summary，再看是否规律出现`)
      }
    }
  } catch (error) {
    bad(`journal 读取失败：${error.message}`)
  }
}

// ── 6. 全局域与画像（schema v8 的接管状态） ──
// 这一节回答"接管做完了没有"，而不是"有没有坏"：域已导入却全停用、确认队列
// 积压、候选满足复现门却没人复核——都不是故障，但都需要人看一眼。
blocks.push({ title: '6. 全局域与画像', lines: [] })
if (!existsSync(ADAPTER_DB)) {
  say(' ', '（自有库不存在，跳过）')
} else {
  try {
    const db = readOnly(ADAPTER_DB)
    const hasDomains = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='domains'")
      .get() !== undefined
    if (!hasDomains) {
      say('⚠', '自有库没有 domains 表（schema < v8）：全局域车道尚未接管')
    } else {
      const domains = db.prepare(
        `SELECT d.domain_id AS id, d.kind AS kind, d.enabled AS enabled, d.budget_tokens AS budget,
                d.cap AS cap, (SELECT COUNT(*) FROM domain_members m WHERE m.domain_id = d.domain_id) AS members
           FROM domains d ORDER BY d.kind, d.domain_id`,
      ).all()
      if (domains.length === 0) {
        say('⚠', '没有任何全局域：跨项目共享仍在走契约回落（node scripts/mc-import-workspace.mjs 幂等导入）')
      }
      for (const domain of domains) {
        const on = Number(domain.enabled) === 1
        say(on ? '✓' : ' ', `${domain.id} [${domain.kind}] ${on ? '启用' : '停用'} · budget ${domain.budget} · cap ${domain.cap} · ${domain.members} 成员`)
      }
      if (domains.length > 0 && domains.every(domain => Number(domain.enabled) === 0)) {
        say('⚠', '全部域停用：路由已就绪但未接管（确认成员后用 /ctx-global enable <domain>）')
      }
      const pendingConfirmations = db
        .prepare("SELECT COUNT(*) AS n FROM profile_confirmations WHERE state='pending'").get()?.n ?? 0
      const pendingCandidates = db
        .prepare("SELECT COUNT(*) AS n FROM global_candidates WHERE state='pending'").get()?.n ?? 0
      say(pendingConfirmations > 0 ? '⚠' : ' ', `画像确认队列待确认 ${pendingConfirmations} 条${pendingConfirmations > 0 ? '（/ctx-profile list）' : ''}`)
      say(pendingCandidates > 0 ? '⚠' : ' ', `全局候选待定 ${pendingCandidates} 条${pendingCandidates > 0 ? '（/ctx-global candidates）' : ''}`)
    }
    db.close()
  } catch (error) {
    say('⚠', `域状态读取失败：${error.message}`)
  }
}

// ── 7. embedding 车道 ──
blocks.push({ title: '7. 本地 embedding 车道', lines: [] })
say(' ', `memory.embedBackfill 缺省 = ${BACKFILL_DEFAULT ? 'true' : 'false'}（后置回填车道）`)
say(' ', '查询侧向量车道始终可用；共享向量读取前需要余弦 ≥0.99 的一致性证明')
// 真实覆盖率。以前这一节只看 activity.log 里"模型加载过没有"，看不出车道已经退化了多少：
// 召回永远"能用"，只是邻居变少——静默退化必须用数字盯。
if (existsSync(MC_STORE)) {
  const { measureVectorLane, planBackfill } = await import('../src/core/vector-lane.ts')
  const lane = measureVectorLane(MC_STORE)
  if (lane === undefined) {
    say('⚠', '向量车道不可读（缺 memories / memory_embeddings 表）')
  } else {
    say(lane.coverage >= 0.95 ? '✓' : '⚠', `覆盖率 ${(lane.coverage * 100).toFixed(1)}%：active ${lane.active} / 已嵌入 ${lane.embedded} / 缺 ${lane.missing}`)
    if (lane.frontier.unembeddedAboveFrontier > 0) {
      say('⚠', `前沿之后有 ${lane.frontier.unembeddedAboveFrontier} 条从未嵌入`
        + `（最新已嵌入 active id ${lane.frontier.newestEmbeddedMemoryId}，最新 active id ${lane.frontier.newestMemoryId}）`
        + '——回填车道无人值守，MC 停摆后没有写者')
    }
    if (lane.gapsBelowFrontier > 0) {
      say(' ', `前沿之下还有 ${lane.gapsBelowFrontier} 条缺口（内容变更会删掉 embedding，属正常churn）`)
    }
    for (const space of lane.spaces) {
      say(' ', `空间 ${space.modelId} ${space.rows} 行 / ${space.memories} 条（${(space.share * 100).toFixed(0)}%）`)
    }
    if (lane.spaces.length > 1) {
      say(' ', `存在 ${lane.spaces.length} 个空间：回填只能写 dominant（${lane.dominantModelId ?? '未知'}），`
        + '写进别的空间不会报错，只会对另一个空间的读者永久不可见')
    }
    const plan = planBackfill(MC_STORE, { limit: 1 })
    if (plan !== undefined && plan.total > 0) {
      say(' ', `待回填 ${plan.total} 条（WP11 未实现：写 memory_embeddings 属契约写入，等放行）`)
    }
  }
}
if (existsSync(ACTIVITY_LOG)) {
  const tail = readFileSync(ACTIVITY_LOG, 'utf8').split('\n').filter((l) => /embedder/i.test(l))
  const last = tail.at(-1)
  if (last === undefined) say('⚠', 'activity.log 里没有 embedder 记录（尚未加载过本地模型）')
  else if (/unavailable|degrad/i.test(last)) say('⚠', `最后一次 embedder 记录是失败：${last.slice(0, 120)}`)
  else say('✓', `最后一次 embedder 记录：${last.slice(0, 120)}`)
} else {
  say('⚠', '没有 activity.log，无法判断本地模型是否加载过')
}

// ── 输出 ──
if (asJson) {
  console.log(JSON.stringify({ store: MC_STORE, adapterDb: ADAPTER_DB, ceiling: CEILING, adapterSchema: ADAPTER_SCHEMA, blocks, hard }, null, 2))
} else {
  console.log('dsh-doctor —— 只读健康报告（不改动任何文件）\n')
  for (const block of blocks) {
    console.log(`=== ${block.title} ===`)
    for (const l of block.lines) console.log(`  ${l}`)
    console.log('')
  }
  console.log(hard.length === 0 ? '裁决：无阻断问题（0）' : `裁决：${hard.length} 个阻断问题（1）`)
  for (const h of hard) console.log(`  ✗ ${h}`)
}
process.exit(hard.length === 0 ? 0 : 1)
