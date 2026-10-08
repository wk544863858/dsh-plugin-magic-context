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

// ── 3. 进行中的 run（镜像 recoverOrphanHistorianRuns 的配对规则） ──
open('3. 进行中的 run')
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

    // ── 4. 失败尾部（上游 doctor 查"近期错误"，这里查适配器自己的 journal） ──
    blocks.push({ title: '4. 失败尾部（最近 8 条 error）', lines: [] })
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

// ── 5. embedding 车道 ──
blocks.push({ title: '5. 本地 embedding 车道', lines: [] })
say(' ', `memory.embedBackfill 缺省 = ${BACKFILL_DEFAULT ? 'true' : 'false'}（后置回填车道）`)
say(' ', '查询侧向量车道始终可用；共享向量读取前需要余弦 ≥0.99 的一致性证明')
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
