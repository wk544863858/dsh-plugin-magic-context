#!/usr/bin/env node
/**
 * mc-report.mjs — magic-context · DeepSeek Harness 适配器「验证期复盘报告」工具
 *
 * 用途：在验证期确认插件是否按设计工作，并在事后复盘。数据源是适配器自己的
 *       SQLite 库（v4 观测层 journal 表为主，v1–v3 的表为辅）。
 *
 * 只读：数据库始终以 `new DatabaseSync(path, { readOnly: true })` 打开，
 *       不执行任何 INSERT / UPDATE / DELETE / DDL，也不切换 journal_mode。
 * 容错：库不存在、被锁、表/列缺失、data 里 JSON 损坏，都只打印中文说明并
 *       以 0 退出；只有命令行参数错误才以 2 退出。
 *
 * 用法示例：
 *   node scripts/mc-report.mjs
 *   node scripts/mc-report.mjs --days 1 --limit 100
 *   node scripts/mc-report.mjs --session session-xxx --kinds pass,historian
 *   node scripts/mc-report.mjs --db D:\tmp\t.db --json > review.json
 *   node scripts/mc-report.mjs --help
 *
 * 零依赖：只用 node:sqlite / node:fs / node:path / node:os。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

// ─────────────────────────── 常量 ───────────────────────────

/** 默认库路径：与适配器 defaultDataDir() 保持一致。 */
const DEFAULT_DB_PATH = join(
  homedir(),
  '.local',
  'share',
  'cortexkit',
  'magic-context-dsh-poc',
  'dsh-magic-context.db',
)

/** 时间窗内一次性读入的最大行数（防止超大库把内存吃满）。 */
const MAX_WINDOW_ROWS = 50000

/** 按天表格里固定展示的主要 kind（只保留窗口内真实出现过的）。 */
const MAJOR_KINDS = [
  'pass',
  'drop-landed',
  'compartment-published',
  'wire-repair',
  'historian',
  'baseline',
  'emergency-reclaim',
  'memory-recall',
  'memory-write',
  'memory-promote',
  'project-drift',
  'tool-call',
  'engine',
  'error',
]

/** 会话短 id 展示长度。 */
const SHORT_SESSION_LEN = 8

/** 最近事件里 data 的文本截断长度。 */
const DATA_TEXT_LIMIT = 200

const USAGE = `用法:
  node scripts/mc-report.mjs [选项]

选项:
  --db <path>        SQLite 库路径
                     默认 ${DEFAULT_DB_PATH}
  --days <n>         时间窗天数，条件为 at >= now - n * 86400000（默认 7）
  --session <id>     只统计该会话（会话级行数、时间窗汇总、指标、最近事件）
  --kinds a,b        只显示这些 kind 的「最近事件」明细（汇总与关键指标不受影响）
  --limit <n>        最近事件条数（默认 40）
  --json             输出单个 JSON 对象（同样的分节，便于归档）
  --help, -h         打印本用法并以 0 退出

示例:
  node scripts/mc-report.mjs
  node scripts/mc-report.mjs --days 1 --limit 100
  node scripts/mc-report.mjs --session session-abc --kinds pass,error
  node scripts/mc-report.mjs --json > mc-review.json

退出码:
  0  报告已生成（包括库不存在 / 表缺失 / 被锁等所有容错情况）
  2  命令行参数错误

只读承诺: 本工具以只读方式打开数据库，不执行任何写操作，也不会修改 journal_mode。
`

// ─────────────────────────── 参数解析 ───────────────────────────

function parseIntArg(raw, flag) {
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return { ok: false, error: `${flag} 需要一个非负整数，收到 "${raw}"` }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${flag} 数值过大: ${raw}` }
  return { ok: true, value }
}

/** 解析 CLI；返回 { ok, opts } 或 { ok:false, error }。 */
function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB_PATH,
    dbExplicit: false,
    days: 7,
    session: null,
    kinds: null,
    limit: 40,
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i]
    if (arg === '--help' || arg === '-h') return { ok: true, opts: { ...opts, help: true } }

    let inline = null
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 2) {
        inline = arg.slice(eq + 1)
        arg = arg.slice(0, eq)
      }
    }

    const takeValue = (flag) => {
      if (inline !== null) return { ok: true, value: inline }
      const next = argv[i + 1]
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        return { ok: false, error: `${flag} 缺少取值` }
      }
      i += 1
      return { ok: true, value: next }
    }

    switch (arg) {
      case '--db': {
        const r = takeValue('--db')
        if (!r.ok) return r
        if (String(r.value).trim() === '') return { ok: false, error: '--db 需要一个非空路径' }
        opts.db = resolve(String(r.value))
        opts.dbExplicit = true
        break
      }
      case '--days': {
        const r = takeValue('--days')
        if (!r.ok) return r
        const n = parseIntArg(r.value, '--days')
        if (!n.ok) return n
        opts.days = n.value
        break
      }
      case '--limit': {
        const r = takeValue('--limit')
        if (!r.ok) return r
        const n = parseIntArg(r.value, '--limit')
        if (!n.ok) return n
        opts.limit = n.value
        break
      }
      case '--session': {
        const r = takeValue('--session')
        if (!r.ok) return r
        const value = String(r.value).trim()
        if (value === '') return { ok: false, error: '--session 需要一个非空会话 id' }
        opts.session = value
        break
      }
      case '--kinds': {
        const r = takeValue('--kinds')
        if (!r.ok) return r
        const list = String(r.value)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
        if (list.length === 0) return { ok: false, error: '--kinds 需要至少一个 kind，例如 --kinds pass,error' }
        opts.kinds = list
        break
      }
      case '--json': {
        if (inline !== null) return { ok: false, error: '--json 不接受取值' }
        opts.json = true
        break
      }
      default:
        return { ok: false, error: `未知参数 ${arg}` }
    }
  }

  return { ok: true, opts }
}

// ─────────────────────────── 格式化小工具（无 ANSI 颜色） ───────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地时间 YYYY-MM-DD HH:mm:ss。 */
function fmtLocal(ms) {
  const n = toNum(ms)
  if (n === null) return '-'
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return '-'
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/** 本地日期 YYYY-MM-DD。 */
function fmtLocalDate(ms) {
  const s = fmtLocal(ms)
  return s === '-' ? '-' : s.slice(0, 10)
}

/** 时区偏移，例如 +08:00。 */
function fmtOffset() {
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/** 千分位整数。 */
function fmtInt(value) {
  const n = toNum(value)
  if (n === null) return '-'
  const negative = n < 0
  const text = String(Math.trunc(Math.abs(n)))
  const grouped = text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return negative ? `-${grouped}` : grouped
}

/** 字节数 → 人类可读。 */
function fmtBytes(value) {
  const n = toNum(value)
  if (n === null) return '-'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/** 毫秒时长 → 人类可读。 */
function fmtDuration(ms) {
  const n = toNum(ms)
  if (n === null) return '-'
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`
  if (n < 3600000) return `${(n / 60000).toFixed(1)} min`
  return `${(n / 3600000).toFixed(1)} h`
}

/** 距今天数/小时。 */
function fmtAgo(ms, now) {
  const n = toNum(ms)
  if (n === null) return '-'
  const delta = now - n
  if (delta < 0) return `未来 ${fmtDuration(-delta)}`
  return `${fmtDuration(delta)} 前`
}

/** 数字强制转换（兼容 bigint / 字符串 / null）。 */
function toNum(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 字符串安全化。 */
function toText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** 显示宽度：CJK 全角按 2 计，保证中文列不错位。 */
function dispWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115f)
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

function padEndWidth(text, width) {
  const s = String(text)
  const delta = width - dispWidth(s)
  return delta > 0 ? s + ' '.repeat(delta) : s
}

function padStartWidth(text, width) {
  const s = String(text)
  const delta = width - dispWidth(s)
  return delta > 0 ? ' '.repeat(delta) + s : s
}

/** 截断到 limit 个字符。 */
function truncate(text, limit) {
  const s = toText(text)
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}…`
}

/** 会话短 id：去掉 session- 前缀后取前若干字符。 */
function shortSession(id) {
  const s = toText(id)
  if (s === '') return '-'
  const body = s.startsWith('session-') ? s.slice('session-'.length) : s
  return body.length <= SHORT_SESSION_LEN ? body : body.slice(0, SHORT_SESSION_LEN)
}

/** 渲染定宽表格：rows 为字符串数组的数组，aligns 为 'l' | 'r'。 */
function renderTable(headers, rows, aligns, widths) {
  const w = headers.map((h, idx) => {
    let width = Math.max(dispWidth(h), dispWidth(widths?.[idx] ?? ''))
    for (const row of rows) width = Math.max(width, dispWidth(row[idx] ?? ''))
    return width
  })
  const line = (cells) =>
    cells
      .map((cell, idx) => (aligns[idx] === 'r' ? padStartWidth(cell ?? '', w[idx]) : padEndWidth(cell ?? '', w[idx])))
      .join('  ')
      .replace(/\s+$/, '')
  const out = [line(headers), line(w.map((width) => '─'.repeat(width)))]
  for (const row of rows) out.push(line(row))
  return out
}

/** JSON 解析容错。 */
function parseData(raw) {
  const text = toText(raw)
  if (text.trim() === '') return { ok: true, value: null, empty: true }
  try {
    return { ok: true, value: JSON.parse(text), empty: false }
  } catch (error) {
    return { ok: false, value: null, empty: false, error: toText(error?.message ?? error) }
  }
}

// ─────────────────────────── 只读数据库访问 ───────────────────────────

/**
 * 以只读方式打开数据库。任何失败都返回 { db: null, error }，绝不抛栈。
 * 注意：这里绝不执行 PRAGMA / DDL / DML。
 */
function openReadOnly(dbPath) {
  let sizeBytes = null
  let isFile = false
  try {
    const st = statSync(dbPath)
    isFile = st.isFile()
    sizeBytes = isFile ? st.size : null
  } catch (error) {
    return { db: null, sizeBytes: null, isFile: false, error: `无法读取文件属性: ${toText(error?.message ?? error)}` }
  }
  if (!isFile) {
    return { db: null, sizeBytes, isFile: false, error: '目标不是一个普通文件（可能传入了目录）' }
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    // 探针：确认这个文件真的能被当作 SQLite 库解析（只读 SELECT，不写任何东西）。
    let valid = true
    let schemaError = null
    try {
      db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()
    } catch (error) {
      valid = false
      schemaError = toText(error?.message ?? error)
    }
    return { db, sizeBytes, isFile: true, valid, schemaError, error: null }
  } catch (error) {
    const message = toText(error?.message ?? error)
    const hint =
      /unable to open|CANTOPEN|locked|busy/i.test(message)
        ? '；若该库处于 WAL 模式且 -shm/-wal 不可写，或数据库正被插件进程独占，只读打开会失败。'
          + '请确认写入方已退出、同目录的 *.db-shm 存在且可写后重试（本工具不会写库）。'
        : ''
    return { db: null, sizeBytes, isFile: true, error: `只读打开失败: ${message}${hint}` }
  }
}

/** 统一的容错查询：返回 { ok, rows, error }。 */
function query(db, sql, params = []) {
  if (db === null) return { ok: false, rows: [], error: '数据库未打开' }
  try {
    const stmt = db.prepare(sql)
    const rows = params.length > 0 ? stmt.all(...params) : stmt.all()
    return { ok: true, rows: Array.isArray(rows) ? rows : [], error: null }
  } catch (error) {
    return { ok: false, rows: [], error: toText(error?.message ?? error) }
  }
}

function scalar(db, sql, params = []) {
  const r = query(db, sql, params)
  if (!r.ok || r.rows.length === 0) return null
  const first = r.rows[0]
  const key = Object.keys(first)[0]
  return key === undefined ? null : first[key]
}

function tableExists(db, name) {
  if (db === null) return false
  const r = query(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])
  return r.ok && r.rows.length > 0
}

/** 通过表值函数 pragma_table_info 读取列名（只读，不使用 PRAGMA 语句）。 */
function columnsOf(db, table) {
  const r = query(db, 'SELECT name FROM pragma_table_info(?)', [table])
  if (!r.ok) return []
  return r.rows.map((row) => toText(row.name)).filter((s) => s !== '')
}

/** 在一张表上按可用列构造 SELECT，返回行；表缺失时返回 ok:false。 */
function selectRows(db, table, wantColumns, { where = null, params = [], orderBy = null, limit = null } = {}) {
  if (!tableExists(db, table)) return { ok: false, rows: [], error: `表 ${table} 不存在` }
  const available = columnsOf(db, table)
  const cols = wantColumns.filter((c) => available.includes(c))
  const selectList = cols.length > 0 ? cols.join(', ') : '*'
  let sql = `SELECT ${selectList} FROM ${table}`
  if (where !== null) sql += ` WHERE ${where}`
  if (orderBy !== null) sql += ` ORDER BY ${orderBy}`
  if (limit !== null) sql += ` LIMIT ${Number(limit)}`
  const r = query(db, sql, params)
  return { ok: r.ok, rows: r.rows, error: r.error }
}

/** 行数统计（可按会话过滤；缺列时退化为全表计数）。 */
function countRows(db, table, { session = null, extraWhere = null, extraParams = [] } = {}) {
  if (!tableExists(db, table)) return { ok: false, count: null, error: `表 ${table} 不存在` }
  const available = columnsOf(db, table)
  const conditions = []
  const params = []
  if (session !== null && available.includes('session_id')) {
    conditions.push('session_id = ?')
    params.push(session)
  }
  if (extraWhere !== null) {
    conditions.push(extraWhere)
    params.push(...extraParams)
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const value = scalar(db, `SELECT COUNT(*) AS n FROM ${table}${where}`, params)
  return { ok: true, count: toNum(value) ?? 0, error: null }
}

// ─────────────────────────── 报告构建 ───────────────────────────

const now = Date.now()

function buildCounts(db, opts, notes) {
  const tables = [
    ['tags', 'tags'],
    ['usage_records', 'usage_records'],
    ['compartments', 'compartments'],
    ['compartment_counters', 'compartment_counters'],
    ['tag_counters', 'tag_counters'],
    ['baseline_state', 'baseline_state'],
  ]

  const tableCounts = {}
  for (const [label, table] of tables) {
    const r = countRows(db, table)
    tableCounts[label] = r.ok ? r.count : null
    if (!r.ok) notes.push(`表 ${table} 不存在或无法读取，相关计数显示为 "-"。`)
  }

  const all = countRows(db, 'pending_drops')
  const unlanded = countRows(db, 'pending_drops', { extraWhere: 'landed_event_seq IS NULL' })
  const tableCountsPending = {
    total: all.ok ? all.count : null,
    unlanded: unlanded.ok ? unlanded.count : null,
  }

  // 会话清单：from journal 优先，其次其余各表 session_id 的并集。
  const sessions = new Map()
  if (tableExists(db, 'journal')) {
    const r = query(
      db,
      'SELECT session_id AS sid, COUNT(*) AS n FROM journal GROUP BY session_id ORDER BY n DESC',
    )
    if (r.ok) {
      for (const row of r.rows) {
        const sid = toText(row.sid)
        if (sid !== '') sessions.set(sid, toNum(row.n) ?? 0)
      }
    }
  }
  for (const table of ['tags', 'usage_records', 'compartments', 'pending_drops', 'baseline_state']) {
    if (!tableExists(db, table)) continue
    if (!columnsOf(db, table).includes('session_id')) continue
    const r = query(db, `SELECT DISTINCT session_id AS sid FROM ${table}`)
    if (!r.ok) continue
    for (const row of r.rows) {
      const sid = toText(row.sid)
      if (sid !== '' && !sessions.has(sid)) sessions.set(sid, null)
    }
  }

  let journalTotal = null
  let journalFirstAt = null
  let journalLastAt = null
  const hasJournal = tableExists(db, 'journal')
  const tableCount = toNum(scalar(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")) ?? null
  if (hasJournal) {
    journalTotal = toNum(scalar(db, 'SELECT COUNT(*) AS n FROM journal')) ?? 0
    journalFirstAt = toNum(scalar(db, 'SELECT MIN(at) AS n FROM journal'))
    journalLastAt = toNum(scalar(db, 'SELECT MAX(at) AS n FROM journal'))
  } else {
    notes.push('journal 表不存在：该库的适配器版本早于 v4 观测层，无法给出时间窗汇总与关键指标。')
  }
  if (tableCount === 0) {
    notes.push('库中没有任何表：可能是空文件、尚未初始化，或根本不是 SQLite 数据库。')
  }

  // meta 全表
  const meta = {}
  const metaOrder = []
  if (tableExists(db, 'meta')) {
    const r = query(db, 'SELECT key, value FROM meta ORDER BY key')
    if (r.ok) {
      for (const row of r.rows) {
        const key = toText(row.key)
        meta[key] = toText(row.value)
        metaOrder.push(key)
      }
    } else {
      notes.push(`读取 meta 表失败: ${r.error}`)
    }
  } else {
    notes.push('meta 表不存在（库可能是空文件或尚未完成初始化）。')
  }

  return {
    hasJournal,
    tableCount,
    journalTotal,
    journalFirstAt,
    journalLastAt,
    tableCounts,
    pendingDrops: tableCountsPending,
    sessionIds: [...sessions.keys()],
    sessionJournalCounts: Object.fromEntries([...sessions.entries()].map(([k, v]) => [k, v])),
    meta,
    metaOrder,
  }
}

/** 读取时间窗内的 journal 行，并做 JSON 容错解析。 */
function loadWindowRows(db, opts, notes) {
  if (!tableExists(db, 'journal')) {
    return { rows: [], truncated: false, parseFailures: 0, atMissing: false, skippedNoAt: 0, error: null }
  }
  const available = columnsOf(db, 'journal')
  if (!available.includes('at')) {
    notes.push('journal 表缺少 at 列，无法按时间窗统计。')
    return { rows: [], truncated: false, parseFailures: 0, atMissing: true, skippedNoAt: 0, error: null }
  }
  const since = now - opts.days * 86400000
  const conditions = ['at >= ?']
  const params = [since]
  if (opts.session !== null) {
    if (available.includes('session_id')) {
      conditions.push('session_id = ?')
      params.push(opts.session)
    } else {
      notes.push('journal 表缺少 session_id 列，--session 过滤已忽略。')
    }
  }
  const order = available.includes('id') ? 'at DESC, id DESC' : 'at DESC'
  const r = selectRows(db, 'journal', ['id', 'at', 'level', 'kind', 'session_id', 'summary', 'data'], {
    where: conditions.join(' AND '),
    params,
    orderBy: order,
    limit: MAX_WINDOW_ROWS,
  })
  if (!r.ok) {
    notes.push(`读取 journal 时间窗失败: ${r.error}`)
    return { rows: [], truncated: false, parseFailures: 0, atMissing: false, skippedNoAt: 0, error: r.error }
  }

  const totalInWindow = toNum(
    scalar(
      db,
      `SELECT COUNT(*) AS n FROM journal WHERE ${conditions.join(' AND ')}`,
      params,
    ),
  )
  const truncated = totalInWindow !== null && totalInWindow > r.rows.length
  if (truncated) {
    notes.push(
      `时间窗内 journal 行数 ${fmtInt(totalInWindow)} 超过单次读取上限 ${fmtInt(MAX_WINDOW_ROWS)}，`
        + '汇总与指标基于最近的那部分行；请缩小 --days 后重跑以获得完整统计。',
    )
  }

  let parseFailures = 0
  let skippedNoAt = 0
  const rows = []
  for (const raw of r.rows) {
    const at = toNum(raw.at)
    if (at === null) {
      skippedNoAt += 1
      continue
    }
    const parsed = parseData(raw.data)
    if (!parsed.ok) parseFailures += 1
    rows.push({
      id: toNum(raw.id),
      at,
      level: toText(raw.level).toLowerCase(),
      kind: toText(raw.kind),
      sessionId: raw.session_id === null || raw.session_id === undefined ? null : toText(raw.session_id),
      summary: toText(raw.summary),
      dataRaw: toText(raw.data),
      data: parsed.ok ? parsed.value : null,
      dataOk: parsed.ok,
    })
  }
  return { rows, truncated, parseFailures, atMissing: false, skippedNoAt, error: null }
}

/** 第 2 节：按 kind / 按天汇总。 */
function summarizeWindow(rows) {
  const byKindMap = new Map()
  const byDayMap = new Map()
  let earliest = null
  let latest = null

  for (const row of rows) {
    const entry = byKindMap.get(row.kind) ?? { kind: row.kind, info: 0, warn: 0, error: 0, other: 0, total: 0 }
    if (row.level === 'info') entry.info += 1
    else if (row.level === 'warn') entry.warn += 1
    else if (row.level === 'error') entry.error += 1
    else entry.other += 1
    entry.total += 1
    byKindMap.set(row.kind, entry)

    const date = fmtLocalDate(row.at)
    const day = byDayMap.get(date) ?? { date, counts: {}, total: 0 }
    day.counts[row.kind] = (day.counts[row.kind] ?? 0) + 1
    day.total += 1
    byDayMap.set(date, day)

    if (earliest === null || row.at < earliest) earliest = row.at
    if (latest === null || row.at > latest) latest = row.at
  }

  const byKind = [...byKindMap.values()].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind))
  const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const levelTotals = { info: 0, warn: 0, error: 0, other: 0 }
  for (const entry of byKind) {
    levelTotals.info += entry.info
    levelTotals.warn += entry.warn
    levelTotals.error += entry.error
    levelTotals.other += entry.other
  }
  return { byKind, byDay, total: rows.length, earliest, latest, levelTotals }
}

/** 第 3 节：从 journal.data 聚合关键指标。 */
function computeMetrics(rows) {
  const m = {
    parseFailures: 0,
    pass: {
      total: 0,
      execute: 0,
      defer: 0,
      other: 0,
      deferReasons: {},
      executeReasons: {},
      pressures: [],
      contextWindows: [],
      usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
      totalLanded: 0,
      totalPublished: 0,
      forceDropped: 0,
      historianStarted: 0,
      baselineSeen: {},
      // Net-reclaim proof (pass.data.tokensBefore/tokensAfter/tokensDelta).
      reclaimSamples: 0,
      reclaimingPasses: 0,
      tokensBeforeTotal: 0,
      tokensAfterTotal: 0,
      tokensDeltaTotal: 0,
    },
    dropLanded: { events: 0, tags: 0, estTokens: 0 },
    drift: { events: 0, roots: new Set(), sessionRoots: new Set() },
    compartments: { published: 0, coveredTokens: 0, nodes: 0 },
    baseline: { total: 0, hard: 0, soft: 0, unchanged: 0, other: 0, deltaSum: 0, bytesSum: 0 },
    historian: {
      start: 0,
      done: 0,
      failed: 0,
      // Remount recoveries are synthetic terminals the host writes for runs a
      // rebuild killed (the client renders them as dim bookkeeping). Counting
      // them as failures pushed the rate to 81.8% on 2026-10-08's window — a
      // number about MY rebuilds, not about the historian.
      recovered: 0,
      other: 0,
      durations: [],
      tokens: 0,
      importance: {},
      attempts: 0,
      usageInput: 0,
      usageOutput: 0,
      failures: [],
    },
    emergency: { events: 0, dropped: 0, protected: 0, retried: 0 },
    wire: { events: 0, swept: 0, remaining: 0 },
    toolCall: { total: 0, byTool: {}, queued: 0, restored: 0, refused: 0, refuseReasons: {}, durations: [] },
    memoryRecall: { total: 0, rows: 0, budgetTokens: 0, usedTokens: 0 },
    engine: { total: 0, byAction: {} },
    // 记忆车道维护（dreamer 替身）：verify 节奏、wrong 率、lag 与 pool 是
    // staging 扳机的三个观测锚点（见 buildHealth 的阈值提示）。
    maintenance: {
      ticks: 0, ran: 0, failed: 0, idleOrOff: 0,
      expired: 0, verified: 0, updated: 0, archived: 0, scored: 0, skipped: 0,
      verdicts: 0,
      poolLast: null,
      lagMaxList: [],
      lagAvgList: [],
    },
    memoryLane: { promoteEvents: 0, promotions: 0, seenAgain: 0 },
    errors: [],
    otherKinds: {},
  }

  const bump = (obj, key) => {
    const k = key === '' ? '(空)' : key
    obj[k] = (obj[k] ?? 0) + 1
  }

  for (const row of rows) {
    if (!row.dataOk) {
      m.parseFailures += 1
      if (row.level === 'error') {
        m.errors.push({ at: row.at, kind: row.kind, summary: row.summary, level: row.level })
      }
      continue
    }
    const d = row.data !== null && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {}

    if (row.level === 'error') {
      m.errors.push({ at: row.at, kind: row.kind, summary: row.summary, level: row.level })
    }

    /** Kinds whose metrics are plain numeric sums (see the switch's default arm). */
const SUMMED_KINDS = {
  'compartment-published': { group: 'compartments', counter: 'published', sums: ['coveredTokens', 'nodes'] },
  'emergency-reclaim': { group: 'emergency', counter: 'events', sums: ['dropped', 'protected', 'retried'] },
  'wire-repair': { group: 'wire', counter: 'events', sums: ['swept', 'remaining'] },
  'memory-recall': { group: 'memoryRecall', counter: 'total', sums: ['rows', 'budgetTokens', 'usedTokens'] },
}
switch (row.kind) {
      case 'pass': {
        m.pass.total += 1
        const decision = toText(d.decision)
        if (decision === 'execute') {
          m.pass.execute += 1
          if (toText(d.reason) !== '') bump(m.pass.executeReasons, toText(d.reason))
        } else if (decision === 'defer') {
          m.pass.defer += 1
          bump(m.pass.deferReasons, toText(d.reason))
        } else {
          m.pass.other += 1
        }
        const pressure = toNum(d.pressure)
        if (pressure !== null) m.pass.pressures.push(pressure)
        const cw = toNum(d.contextWindow)
        if (cw !== null) m.pass.contextWindows.push(cw)
        const usage = d.usage !== null && typeof d.usage === 'object' ? d.usage : {}
        m.pass.usage.input += toNum(usage.input) ?? 0
        m.pass.usage.cacheRead += toNum(usage.cacheRead) ?? 0
        m.pass.usage.cacheWrite += toNum(usage.cacheWrite) ?? 0
        // Accept both the canonical keys and the earlier aliases, so a writer
        // change can never silently zero these counts in the review.
        const landed = Array.isArray(d.landed) ? d.landed : Array.isArray(d.landedTags) ? d.landedTags : null
        if (landed !== null) m.pass.totalLanded += landed.length
        const published = Array.isArray(d.published) ? d.published : Array.isArray(d.publishedCompartments) ? d.publishedCompartments : null
        if (published !== null) m.pass.totalPublished += published.length
        // Net-reclaim proof: the surface estimate the pass reports before/after.
        const before = toNum(d.tokensBefore)
        const after = toNum(d.tokensAfter)
        const delta = toNum(d.tokensDelta)
        if (before !== null && after !== null) {
          m.pass.reclaimSamples += 1
          m.pass.tokensBeforeTotal += before
          m.pass.tokensAfterTotal += after
          m.pass.tokensDeltaTotal += delta === null ? after - before : delta
          if (delta === null ? after - before : delta < 0) m.pass.reclaimingPasses += 1
        }
        const fd = toNum(d.forceDropped)
        if (fd !== null) m.pass.forceDropped += fd
        if (d.historianStarted === true) m.pass.historianStarted += 1
        if (typeof d.baseline === 'string' || typeof d.baseline === 'number') bump(m.pass.baselineSeen, String(d.baseline))
        break
      }
      case 'drop-landed': {
        m.dropLanded.events += 1
        if (Array.isArray(d.tags)) m.dropLanded.tags += d.tags.length
        else m.dropLanded.tags += toNum(d.count) ?? 0
        m.dropLanded.estTokens += toNum(d.estTokens) ?? toNum(d.estTokensReclaimed) ?? 0
        break
      }
      case 'project-drift': {
        m.drift.events += 1
        const roots = Array.isArray(d.foreignRoots) ? d.foreignRoots : []
        for (const root of roots) if (typeof root === 'string') m.drift.roots.add(root)
        if (typeof d.sessionRoot === 'string') m.drift.sessionRoots.add(d.sessionRoot)
        break
      }
      case 'baseline': {
        m.baseline.total += 1
        const mode = toText(d.mode)
        if (mode === 'hard') m.baseline.hard += 1
        else if (mode === 'soft') m.baseline.soft += 1
        else if (mode === 'unchanged') m.baseline.unchanged += 1
        else m.baseline.other += 1
        const comp = d.compartments !== null && typeof d.compartments === 'object' ? d.compartments : {}
        m.baseline.deltaSum += toNum(comp.delta) ?? 0
        m.baseline.bytesSum += toNum(d.bytes) ?? 0
        break
      }
      case 'historian': {
        const phase = toText(d.phase)
        const remountTerminal = phase === 'failed' && toText(d.kind) === 'adapter-remount'
        if (phase === 'start') m.historian.start += 1
        else if (phase === 'done') m.historian.done += 1
        else if (remountTerminal) m.historian.recovered += 1
        else if (phase === 'failed') m.historian.failed += 1
        else m.historian.other += 1
        const duration = toNum(d.durationMs)
        if (duration !== null) m.historian.durations.push(duration)
        m.historian.tokens += toNum(d.tokens) ?? 0
        const importance = d.importance
        if (importance !== null && importance !== undefined && typeof importance !== 'object') {
          bump(m.historian.importance, String(importance))
        } else if (importance !== null && typeof importance === 'object') {
          bump(m.historian.importance, JSON.stringify(importance).slice(0, 32))
        }
        m.historian.attempts += toNum(d.attempts) ?? 0
        const usage = d.usage !== null && typeof d.usage === 'object' ? d.usage : {}
        m.historian.usageInput += toNum(usage.inputTokens) ?? 0
        m.historian.usageOutput += toNum(usage.outputTokens) ?? 0
        if (phase === 'failed' && !remountTerminal) {
          // `kind` + `reason` are what a failed row actually carries (reading
          // `d.error` printed an empty column for every failure). The 2026-10-08
          // review added finishReason/outputChars/partialChars/attemptCaps: an
          // "invalid JSON" is a cut stream when finishReason says 'none' or the
          // output stopped at the cap, and a model problem when it says 'stop'.
          const finish = toText(d.finishReason)
          const partial = toNum(d.partialChars)
          const output = toNum(d.outputChars)
          const caps = Array.isArray(d.attemptCaps) ? d.attemptCaps.map((c) => String(c)).join('/') : ''
          m.historian.failures.push({
            at: row.at,
            kind: toText(d.kind) || toText(d.error),
            reason: toText(d.reason) || toText(d.error),
            stage: toText(d.stage),
            attempts: toNum(d.attempts),
            detail: [
              finish !== '' ? `finish=${finish}` : '',
              partial !== null ? `partial=${String(partial)}` : '',
              output !== null ? `output=${String(output)}` : '',
              caps !== '' ? `caps=${caps}` : '',
            ].filter((part) => part !== '').join(' '),
          })
        }
        break
      }

      case 'tool-call': {
        m.toolCall.total += 1
        bump(m.toolCall.byTool, toText(d.tool))
        if (Array.isArray(d.queued)) m.toolCall.queued += d.queued.length
        else m.toolCall.queued += toNum(d.queued) ?? 0
        if (Array.isArray(d.restored)) m.toolCall.restored += d.restored.length
        else m.toolCall.restored += toNum(d.restored) ?? 0
        if (Array.isArray(d.refused)) {
          m.toolCall.refused += d.refused.length
          for (const item of d.refused) {
            const reason = item !== null && typeof item === 'object' ? toText(item.reason) : toText(item)
            bump(m.toolCall.refuseReasons, reason)
          }
        } else {
          m.toolCall.refused += toNum(d.refused) ?? 0
        }
        const ms = toNum(d.ms)
        if (ms !== null) m.toolCall.durations.push(ms)
        break
      }

      case 'engine': {
        m.engine.total += 1
        bump(m.engine.byAction, toText(d.action))
        break
      }

      case 'maintenance': {
        m.maintenance.ticks += 1
        // 新 payload 带 verify 模式；旧行按 why/verdicts/route 兜底归类，
        // 这样 7 天窗口里的历史行也能被正确分桶。
        const mode = toText(d.verify) !== '' ? toText(d.verify)
          : toText(d.why) !== '' ? 'failed'
            : toNum(d.verdicts) !== null || toNum(d.verified) !== null || toText(d.route) !== '' ? 'ran' : 'idle-or-off'
        if (mode === 'ran') m.maintenance.ran += 1
        else if (mode === 'failed') m.maintenance.failed += 1
        else m.maintenance.idleOrOff += 1
        for (const field of ['expired', 'verified', 'updated', 'archived', 'scored', 'skipped', 'verdicts']) {
          const value = toNum(d[field])
          if (value !== null) m.maintenance[field] += value
        }
        const pool = toNum(d.poolUnverified)
        if (pool !== null) m.maintenance.poolLast = pool
        const lagMax = toNum(d.lagMaxH)
        if (lagMax !== null) m.maintenance.lagMaxList.push(lagMax)
        const lagAvg = toNum(d.lagAvgH)
        if (lagAvg !== null) m.maintenance.lagAvgList.push(lagAvg)
        break
      }

      case 'memory-promote': {
        m.memoryLane.promoteEvents += 1
        if (Array.isArray(d.inserted)) m.memoryLane.promotions += d.inserted.length
        if (Array.isArray(d.seenAgain)) m.memoryLane.seenAgain += d.seenAgain.length
        break
      }

      default: {
        // Kinds whose metrics are plain numeric sums are table-driven.
        const summed = SUMMED_KINDS[row.kind]
        if (summed === undefined) {
          bump(m.otherKinds, row.kind)
          break
        }
        const bucket = m[summed.group]
        bucket[summed.counter] += 1
        for (const field of summed.sums) bucket[field] += toNum(d[field]) ?? 0
        break
      }
    }
  }

  const avg = (list) => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length)
  const max = (list) => (list.length === 0 ? null : list.reduce((a, b) => Math.max(a, b), -Infinity))

  m.pass.avgPressure = avg(m.pass.pressures)
  m.pass.maxPressure = max(m.pass.pressures)
  m.pass.lastContextWindow = m.pass.contextWindows.length > 0 ? m.pass.contextWindows[0] : null
  m.historian.avgDurationMs = avg(m.historian.durations)
  m.historian.maxDurationMs = max(m.historian.durations)
  // The rate over CONCLUDED runs: a run a rebuild killed is an interrupt, not a
// historian failure, so neither side of the ratio counts it. (Before this,
// `failed` included 543 synthetic remount terminals and the rate read 81.8%.)
  const concluded = m.historian.done + m.historian.failed
  m.historian.failureRate = concluded > 0 ? m.historian.failed / concluded : null
  m.toolCall.avgMs = avg(m.toolCall.durations)
  m.memoryRecall.avgUsedTokens = m.memoryRecall.total > 0 ? m.memoryRecall.usedTokens / m.memoryRecall.total : null
  m.maintenance.lagMaxH = max(m.maintenance.lagMaxList)
  m.maintenance.lagAvgH = avg(m.maintenance.lagAvgList)
  m.maintenance.judged = m.maintenance.verified + m.maintenance.updated + m.maintenance.archived
  m.maintenance.wrongRate = m.maintenance.judged > 0 ? m.maintenance.archived / m.maintenance.judged : null
  return m
}

/** 第 5 节：健康提示（启发式，命中才输出）。 */
function buildHealth(ctx) {
  const { db, opened, dbExists, openError, valid, schemaError, counts, summary, metrics, opts, windowError } = ctx
  const hints = []
  const push = (code, message) => hints.push({ code, message })

  if (!opened) {
    push(
      'db-not-openable',
      ctx.dbExists
        ? `数据库存在但无法以只读方式打开：${toText(ctx.openError)}`
        : '数据库不存在（插件可能尚未在此机器上运行过，或 --db 路径不对）。',
    )
    return hints
  }

  if (valid === false) {
    push('db-not-sqlite', `文件无法解析为 SQLite 数据库：${toText(schemaError)}（--db 指向的文件是否正确？）`)
  } else if (!counts.hasJournal) {
    if (counts.tableCount === 0) {
      push('db-empty', '库中没有任何表（空文件、未初始化的库，或不是 SQLite 数据库），无法复盘运行事件。')
    } else {
      push(
        'no-journal-table',
        `journal 表不存在（插件版本早于 v4 观测层）；库内现有 ${fmtInt(counts.tableCount)} 张表，`
          + '无法复盘运行事件。',
      )
    }
  } else {
    if (counts.journalTotal === 0) {
      push('journal-empty', 'journal 表存在但没有任何行（插件可能从未启动或从未写入观测事件）。')
    }
    if (summary.total === 0) {
      push('window-empty', `时间窗（最近 --days ${opts.days} 天）内没有任何 journal 事件。`)
    } else {
      if (metrics.pass.total === 0) {
        push('no-pass', '窗口内没有任何 pass 事件（插件可能未激活，或管理通道从未被调用）。')
      } else if (metrics.pass.execute === 0) {
        push('no-execute-pass', '窗口内没有任何 execute pass（插件可能未激活或压力始终低于阈值）。')
      }
      const hist = metrics.historian
      if (hist.start + hist.done + hist.failed + hist.recovered === 0) {
        push('historian-never-ran', 'historian 从未运行（窗口内没有 phase=start/done/failed 事件）。')
      }
      if (hist.failureRate !== null && hist.failureRate > 0.2) {
        push(
          'historian-failure-rate',
          `historian 失败率 ${(hist.failureRate * 100).toFixed(1)}% > 20%（done=${hist.done}, failed=${hist.failed}`
          + `${hist.recovered > 0 ? `, 另有重建补记 ${hist.recovered} 不计入` : ''}）。`,
        )
      }
      // 记忆车道扳机线（staging 启用条件的三项观测锚点，命中才提示）。
      const maint = metrics.maintenance
      if (maint.judged >= 10 && maint.wrongRate !== null && maint.wrongRate > 0.3) {
        push(
          'verify-wrong-rate',
          `verify wrong 率 ${(maint.wrongRate * 100).toFixed(1)}% > 30%（judged ${maint.judged}，wrong ${maint.archived}）`
            + '——晋升质量或判定器需要复核。',
        )
      }
      if (maint.lagMaxH !== null && maint.lagMaxH > 24) {
        push(
          'verify-lag-high',
          `verify lag 最大 ${maint.lagMaxH.toFixed(1)}h > 24h——清洗跟不上进水（staging 扳机条件之一）。`,
        )
      }
      if (metrics.memoryLane.promotions > opts.days * 300) {
        push(
          'promotion-rate-high',
          `窗口内晋升 ${metrics.memoryLane.promotions} 行 > 300 行/天 × ${opts.days} 天——进水超预期（staging 扳机条件之一）。`,
        )
      }
      if (metrics.errors.length > 0) {
        push('error-events', `窗口内存在 ${metrics.errors.length} 条 level=error 事件，请查看第 3 节“错误事件”。`)
      }
      if (metrics.parseFailures > 0) {
        push('data-json-broken', `有 ${metrics.parseFailures} 条 journal.data 不是合法 JSON，已按空对象处理。`)
      }
    }
    if (counts.journalLastAt !== null) {
      const ageMs = now - counts.journalLastAt
      if (ageMs > 86400000) {
        push('stale-journal', `最新 journal 事件距今 ${fmtDuration(ageMs)}（超过 24h），插件可能已停止活动。`)
      }
    }
  }

  const unlanded = counts.pendingDrops.unlanded
  if (unlanded !== null && unlanded > 0) {
    push('pending-drops-unlanded', `pending_drops 有 ${unlanded} 项未落地（回收带未开）。`)
  }
  if (opts.session !== null && counts.hasJournal && summary.total === 0) {
    push('session-no-data', `会话 ${shortSession(opts.session)} 在时间窗内没有数据（id 是否写错，或该会话由旧版本写入）。`)
  }
  if (windowError !== null && windowError !== undefined) {
    push('window-read-error', `读取时间窗失败：${windowError}`)
  }
  return hints
}

// ─────────────────────────── 文本渲染 ───────────────────────────

const REPORT_WIDTH = 78

function header(title) {
  const prefix = `── ${title} `
  const fill = Math.max(3, REPORT_WIDTH - dispWidth(prefix))
  return `\n${prefix}${'─'.repeat(fill)}`
}

function kv(key, value, keyWidth = 22) {
  return `  ${padEndWidth(key, keyWidth)}: ${value}`
}

function renderText(payload) {
  const { db, counts, metrics, recent, health, notes, window: win } = payload
  const opts = payload.filters
  const summary = payload.windowSummary
  const lines = []

  lines.push('=== magic-context 验证期复盘报告 ===')
  lines.push(`生成时间: ${payload.generatedAtLocal} (UTC${fmtOffset()})`)
  lines.push(
    `时间窗  : 最近 ${win.days} 天，at >= ${fmtLocal(win.since)}（${fmtInt(win.since)}）`
    + `${win.truncated ? '  [已截断]' : ''}`,
  )
  lines.push(
    `过滤    : 会话=${opts.session === null ? '全部' : opts.session}`
    + `；明细 kind=${opts.kinds === null ? '全部' : opts.kinds.join(',')}`
    + `；最近事件上限=${opts.limit}`,
  )

  // ── 1. 库与状态 ──
  lines.push(header('1. 库与状态'))
  lines.push(kv('数据库路径', db.path))
  if (db.exists) {
    if (db.sizeBytes === null) {
      lines.push(kv('文件', '存在（大小为未知，或不是普通文件）'))
    } else {
      lines.push(kv('文件', `存在，${fmtBytes(db.sizeBytes)}（${fmtInt(db.sizeBytes)} 字节）`))
    }
    lines.push(kv('打开方式', db.opened ? '只读 readOnly: true（本工具不写库）' : '未打开'))
    if (db.opened && db.valid === false) {
      lines.push(kv('可解析性', `不是有效的 SQLite 库：${db.schemaError ?? '未知原因'}`))
    }
  } else {
    lines.push(kv('文件', '不存在'))
  }
  if (db.error !== null) lines.push(kv('打开结果', db.error))

  lines.push('  [meta 全表]')
  const metaKeys = counts.metaOrder
  if (metaKeys.length === 0) {
    lines.push('    （无 meta 行）')
  } else {
    const highlight = ['adapter_version', 'schema_version', 'compaction_engine', 'memory_bridge']
    for (const key of metaKeys) {
      const mark = highlight.includes(key) ? '*' : ' '
      lines.push(`   ${mark} ${padEndWidth(key, 20)} = ${counts.meta[key]}`)
    }
    lines.push('    （* 为关键键）')
  }

  lines.push(
    kv(
      'journal',
      counts.hasJournal
        ? `${fmtInt(counts.journalTotal)} 行；最早 ${fmtLocal(counts.journalFirstAt)}；`
          + `最新 ${fmtLocal(counts.journalLastAt)}（${fmtAgo(counts.journalLastAt, now)}）`
        : '表不存在',
    ),
  )
  const t = counts.tableCounts
  const cell = (key) => (t[key] === null ? '-' : fmtInt(t[key]))
  lines.push(kv('tags', cell('tags')))
  lines.push(kv('usage_records', cell('usage_records')))
  lines.push(kv('compartments', `${cell('compartments')}（含计数表 ${cell('compartment_counters')} 行）`))
  lines.push(
    kv(
      'pending_drops',
      counts.pendingDrops.total === null
        ? '-'
        : `${fmtInt(counts.pendingDrops.total)} 行，其中未落地 ${fmtInt(counts.pendingDrops.unlanded)} 行`,
    ),
  )
  lines.push(kv('baseline_state', cell('baseline_state')))
  lines.push(kv('出现过的会话数', counts.sessionIds.length === 0 ? '0' : `${counts.sessionIds.length}`))
  if (opts.session !== null) {
    lines.push('  （第 1 节为整库统计；--session 过滤作用于第 2–5 节。）')
  }
  for (const sid of counts.sessionIds.slice(0, 10)) {
    const n = counts.sessionJournalCounts[sid]
    lines.push(`    - ${sid}${n === null || n === undefined ? '' : `（journal ${fmtInt(n)} 行）`}`)
  }
  if (counts.sessionIds.length > 10) lines.push(`    …… 其余 ${counts.sessionIds.length - 10} 个会话省略`)

  // ── 2. 时间窗汇总 ──
  lines.push(header('2. 时间窗汇总'))
  if (!counts.hasJournal) {
    lines.push('  journal 表不存在，跳过本节。')
  } else if (summary.total === 0) {
    lines.push('  窗口内没有任何事件。')
  } else {
    lines.push(
      `  窗口内事件 ${fmtInt(summary.total)} 条`
      + `（info ${fmtInt(summary.levelTotals.info)} / warn ${fmtInt(summary.levelTotals.warn)}`
      + ` / error ${fmtInt(summary.levelTotals.error)}`
      + `${summary.levelTotals.other > 0 ? ` / 其他 ${fmtInt(summary.levelTotals.other)}` : ''}）；`
      + `实际范围 ${fmtLocal(summary.earliest)} ~ ${fmtLocal(summary.latest)}`,
    )
    lines.push('')
    const kindRows = summary.byKind.map((e) => [
      e.kind,
      fmtInt(e.total),
      fmtInt(e.info),
      fmtInt(e.warn),
      fmtInt(e.error),
      e.other > 0 ? fmtInt(e.other) : '',
    ])
    kindRows.push([
      '合计',
      fmtInt(summary.total),
      fmtInt(summary.levelTotals.info),
      fmtInt(summary.levelTotals.warn),
      fmtInt(summary.levelTotals.error),
      summary.levelTotals.other > 0 ? fmtInt(summary.levelTotals.other) : '',
    ])
    for (const line of renderTable(
      ['kind', '总数', 'info', 'warn', 'error', '其他'],
      kindRows,
      ['l', 'r', 'r', 'r', 'r', 'r'],
    )) {
      lines.push(`  ${line}`)
    }

    // 按天表格
    lines.push('')
    const dayKinds = MAJOR_KINDS.filter((k) => summary.byKind.some((e) => e.kind === k))
    if (dayKinds.length === 0) {
      lines.push('  （窗口内的 kind 均不在主要 kind 列表内，按天表格省略。）')
    } else {
      lines.push(`  按天（只列主要 kind，共 ${dayKinds.length} 列）:`)
      const headers = ['日期', ...dayKinds, '合计']
      const rows = summary.byDay.map((day) => [
        day.date,
        ...dayKinds.map((k) => {
          const n = day.counts[k] ?? 0
          return n === 0 ? '' : fmtInt(n)
        }),
        fmtInt(day.total),
      ])
      for (const line of renderTable(headers, rows, ['l', ...dayKinds.map(() => 'r'), 'r'])) {
        lines.push(`  ${line}`)
      }
    }
  }

  // ── 3. 关键指标 ──
  lines.push(header('3. 关键指标（来自 journal.data）'))
  if (!counts.hasJournal || summary.total === 0) {
    lines.push('  无可用 journal 数据，跳过本节。')
  } else {
    const p = metrics.pass
    lines.push(
      `  pass          : 共 ${fmtInt(p.total)}（execute ${fmtInt(p.execute)} / defer ${fmtInt(p.defer)}`
      + `${p.other > 0 ? ` / 未标注决策 ${fmtInt(p.other)}` : ''}）`,
    )
    lines.push(`    defer 原因  : ${renderDistribution(p.deferReasons)}`)
    if (Object.keys(p.executeReasons).length > 0) {
      lines.push(`    execute 原因: ${renderDistribution(p.executeReasons)}`)
    }
    lines.push(
      `    压力/窗口   : 平均压力 ${fmtFixed(p.avgPressure, 3)}，最大 ${fmtFixed(p.maxPressure, 3)}`
      + `；contextWindow 最近值 ${p.lastContextWindow === null ? '-' : fmtInt(p.lastContextWindow)}`,
    )
    lines.push(
      `    pass 记账   : usage input ${fmtInt(p.usage.input)} / cacheRead ${fmtInt(p.usage.cacheRead)}`
      + ` / cacheWrite ${fmtInt(p.usage.cacheWrite)}；landed ${fmtInt(p.totalLanded)} 项，`
      + `published ${fmtInt(p.totalPublished)} 项，forceDropped ${fmtInt(p.forceDropped)}，`
      + `historianStarted ${fmtInt(p.historianStarted)} 次`,
    )
    if (p.reclaimSamples > 0) {
      const average = Math.round(p.tokensDeltaTotal / p.reclaimSamples)
      lines.push(
        `    净回收      : ${fmtInt(p.reclaimSamples)} 个 pass 上报了上下文占用变化；`
        + `平均每次 ${p.tokensDeltaTotal <= 0 ? '-' : '+'}${fmtInt(Math.abs(average))} tokens`
        + `（收缩 pass ${fmtInt(p.reclaimingPasses)} 个），`
        + `合计 ${fmtInt(p.tokensBeforeTotal)} → ${fmtInt(p.tokensAfterTotal)}`,
      )
    } else if (p.execute > 0) {
      lines.push('    净回收      : 无样本（执行 pass 未上报 tokensBefore/tokensAfter，无法证明实际省了 token）')
    }
    if (Object.keys(p.baselineSeen).length > 0) {
      lines.push(`    pass 里的 baseline 值: ${renderDistribution(p.baselineSeen)}`)
    }

    lines.push(
      `  drop-landed   : ${fmtInt(metrics.dropLanded.events)} 次，累计标签 ${fmtInt(metrics.dropLanded.tags)} 个，`
      + `估算 token ${fmtInt(metrics.dropLanded.estTokens)}`,
    )
    if (metrics.drift.events > 0) {
      const roots = [...metrics.drift.roots]
      lines.push(
        `  project-drift : ${fmtInt(metrics.drift.events)} 次，外来根 ${fmtInt(roots.length)} 个`
        + `（会话根 ${fmtInt(metrics.drift.sessionRoots.size)} 个）`
        + `；样本 ${roots.slice(0, 3).join('、')}${roots.length > 3 ? ' …' : ''}`,
      )
    }
    lines.push(
      `  compartment   : 发布 ${fmtInt(metrics.compartments.published)} 个，消化 tokens ${fmtInt(metrics.compartments.coveredTokens)}，`
      + `覆盖节点 ${fmtInt(metrics.compartments.nodes)}`,
    )

    const b = metrics.baseline
    lines.push(
      `  baseline      : 共 ${fmtInt(b.total)}（hard ${fmtInt(b.hard)} / soft ${fmtInt(b.soft)}`
      + ` / unchanged ${fmtInt(b.unchanged)}${b.other > 0 ? ` / 其他 ${fmtInt(b.other)}` : ''}）`
      + `；compartments.delta 累计 ${fmtInt(b.deltaSum)}，bytes 累计 ${fmtInt(b.bytesSum)}`,
    )

    const h = metrics.historian
    lines.push(
      `  historian     : start ${fmtInt(h.start)} / done ${fmtInt(h.done)} / failed ${fmtInt(h.failed)}`
      + `${h.recovered > 0 ? ` / 重挂载补记 ${fmtInt(h.recovered)}` : ''}`
      + `${h.other > 0 ? ` / 其他 ${fmtInt(h.other)}` : ''}`
      + `；失败率 ${h.failureRate === null ? '-' : `${(h.failureRate * 100).toFixed(1)}%`}`
      + `${h.recovered > 0 ? '（实时失败率，已排除重建补记）' : ''}`,
    )
    lines.push(
      `    耗时        : 平均 ${fmtDuration(h.avgDurationMs)}，最大 ${fmtDuration(h.maxDurationMs)}（样本 ${h.durations.length}）`
      + `；累计 tokens ${fmtInt(h.tokens)}，importance 分布 ${renderDistribution(h.importance)}`,
    )
    lines.push(
      `    其他        : attempts 累计 ${fmtInt(h.attempts)}，usage input ${fmtInt(h.usageInput)} / output ${fmtInt(h.usageOutput)}`,
    )
    if (h.failures.length > 0) {
      lines.push('    最近失败    :')
      for (const failure of h.failures.slice(-5)) {
        const where = failure.stage !== '' ? `${failure.stage} ` : ''
        const why = failure.detail !== '' ? ` [${failure.detail}]` : ''
        lines.push(`      ${fmtLocal(failure.at)}  ${failure.kind || '-'}  attempts=${failure.attempts ?? '-'}  ${where}${truncate(failure.reason, 100)}${why}`)
      }
    }

    const e = metrics.emergency
    lines.push(
      `  emergency     : ${fmtInt(e.events)} 次，丢弃总数 ${fmtInt(e.dropped)}，保护 ${fmtInt(e.protected)}，重试 ${fmtInt(e.retried)}`,
    )

    if (metrics.wire.events > 0) {
      const w = metrics.wire
      lines.push(
        `  wire-repair   : ${fmtInt(w.events)} 次，清扫 ${fmtInt(w.swept)}，剩余 ${fmtInt(w.remaining)}`,
      )
    }

    const tc = metrics.toolCall
    lines.push(
      `  tool-call     : 共 ${fmtInt(tc.total)} 次；ctx_reduce ${fmtInt(tc.byTool['ctx_reduce'] ?? 0)}`
      + ` / ctx_expand ${fmtInt(tc.byTool['ctx_expand'] ?? 0)}`
      + ` / ctx_memory ${fmtInt(tc.byTool['ctx_memory'] ?? 0)}`,
    )
    lines.push(
      `    队列        : 排队 ${fmtInt(tc.queued)}，恢复 ${fmtInt(tc.restored)}，拒绝 ${fmtInt(tc.refused)}`
      + `；平均耗时 ${fmtDuration(tc.avgMs)}；拒绝原因 ${renderDistribution(tc.refuseReasons)}`,
    )

    const mr = metrics.memoryRecall
    lines.push(
      `  memory-recall : ${fmtInt(mr.total)} 次，召回行 ${fmtInt(mr.rows)}，`
      + `使用 tokens ${fmtInt(mr.usedTokens)} / 预算 ${fmtInt(mr.budgetTokens)}（平均每次 ${fmtFixed(mr.avgUsedTokens, 1)}）`,
    )
    const mt = metrics.maintenance
    if (mt.ticks > 0) {
      lines.push(
        `  maintenance   : ${fmtInt(mt.ticks)} 拍（ran ${fmtInt(mt.ran)} / idle-off ${fmtInt(mt.idleOrOff)} / failed ${fmtInt(mt.failed)}），`
        + `judged ${fmtInt(mt.judged)}（verified ${fmtInt(mt.verified)} / updated ${fmtInt(mt.updated)}`
        + ` / wrong ${fmtInt(mt.archived)}＝${mt.wrongRate === null ? '-' : `${(mt.wrongRate * 100).toFixed(1)}%`}），`
        + `scored ${fmtInt(mt.scored)}，lag 最大 ${fmtFixed(mt.lagMaxH, 1)}h / 平均 ${fmtFixed(mt.lagAvgH, 1)}h，`
        + `pool 最新 ${mt.poolLast === null ? '-' : fmtInt(mt.poolLast)}`,
      )
    }
    const lane = metrics.memoryLane
    if (lane.promoteEvents > 0) {
      lines.push(
        `  记忆进水      : promote ${fmtInt(lane.promoteEvents)} 次，新行 ${fmtInt(lane.promotions)}`
        + `（seen-again ${fmtInt(lane.seenAgain)}），约 ${fmtFixed(lane.promotions / Math.max(opts.days, 1), 1)} 行/天`,
      )
    }
    if (metrics.engine.total > 0) {
      lines.push(`  engine        : ${fmtInt(metrics.engine.total)} 次；action 分布 ${renderDistribution(metrics.engine.byAction)}`)
    }
    if (Object.keys(metrics.otherKinds).length > 0) {
      lines.push(`  未知/其他 kind: ${renderDistribution(metrics.otherKinds)}`)
    }

    lines.push('  [错误事件 level=error]')
    if (metrics.errors.length === 0) {
      lines.push('    （无）')
    } else {
      const rows = metrics.errors
        .slice()
        .sort((a, b2) => a.at - b2.at)
        .map((err) => [fmtLocal(err.at), err.kind, truncate(err.summary, 90)])
      for (const line of renderTable(['本地时间', 'kind', 'summary'], rows, ['l', 'l', 'l'])) {
        lines.push(`    ${line}`)
      }
    }
  }

  // ── 4. 最近事件 ──
  lines.push(header('4. 最近事件'))
  lines.push(
    `  条数 ${fmtInt(recent.length)}（上限 ${opts.limit}`
    + `${opts.kinds === null ? '' : `，kind 过滤 ${opts.kinds.join(',')}`}）`,
  )
  if (recent.length === 0) {
    lines.push('  （无）')
  } else {
    const rows = recent.map((row) => [
      fmtLocal(row.at),
      row.level === '' ? '-' : row.level,
      row.kind === '' ? '-' : row.kind,
      shortSession(row.sessionId),
      truncate(row.summary, 120),
    ])
    for (const line of renderTable(
      ['本地时间', 'level', 'kind', '会话', 'summary'],
      rows,
      ['l', 'l', 'l', 'l', 'l'],
    )) {
      lines.push(`  ${line}`)
    }
    const withData = recent.filter((row) => row.dataRaw !== '')
    if (withData.length > 0) {
      lines.push('')
      lines.push(`  data 明细（紧凑 JSON，截断到 ${DATA_TEXT_LIMIT} 字符）:`)
      for (const row of withData) {
        lines.push(`    ${fmtLocal(row.at)} ${row.kind}: ${truncate(row.dataRaw, DATA_TEXT_LIMIT)}`)
      }
    }
  }

  // ── 5. 健康提示 ──
  lines.push(header('5. 健康提示'))
  if (health.length === 0) {
    lines.push('  （未命中任何启发式告警）')
  } else {
    for (const hint of health) lines.push(`  [!] ${hint.message}`)
  }

  if (notes.length > 0) {
    lines.push(header('说明（容错路径）'))
    for (const note of notes) lines.push(`  - ${note}`)
  }

  lines.push('')
  return lines.join('\n')
}

/** 分布对象 → "key=n（xx%）" 串。 */
function renderDistribution(dist) {
  const entries = Object.entries(dist ?? {})
  if (entries.length === 0) return '（无）'
  const total = entries.reduce((sum, [, n]) => sum + (toNum(n) ?? 0), 0)
  return entries
    .sort((a, b) => (toNum(b[1]) ?? 0) - (toNum(a[1]) ?? 0))
    .slice(0, 6)
    .map(([key, n]) => {
      const value = toNum(n) ?? 0
      const pct = total > 0 ? ` (${((value / total) * 100).toFixed(0)}%)` : ''
      return `${key}=${fmtInt(value)}${pct}`
    })
    .join('，')
}

function fmtFixed(value, digits) {
  const n = toNum(value)
  return n === null ? '-' : n.toFixed(digits)
}

// ─────────────────────────── 主流程 ───────────────────────────

function buildReport(opts) {
  const notes = []
  const since = now - opts.days * 86400000
  const opened = existsSync(opts.db)
  const open = opened
    ? openReadOnly(opts.db)
    : { db: null, sizeBytes: null, error: '文件不存在（插件可能尚未在此机器上运行过）' }

  const db = open.db
  const dbSection = {
    path: opts.db,
    defaultPath: DEFAULT_DB_PATH,
    exists: opened,
    opened: db !== null,
    valid: typeof open.valid === 'boolean' ? open.valid : null,
    schemaError: open.schemaError ?? null,
    sizeBytes: open.sizeBytes,
    readOnly: true,
    error: open.error ?? null,
  }
  if (db !== null && open.valid === false) {
    notes.push(`该文件无法解析为 SQLite 数据库（${open.schemaError ?? '未知原因'}），后续查询结果不可信。`)
  }

  let counts = {
    hasJournal: false,
    journalTotal: null,
    journalFirstAt: null,
    journalLastAt: null,
    tableCounts: {},
    pendingDrops: { total: null, unlanded: null },
    sessionIds: [],
    sessionJournalCounts: {},
    meta: {},
    metaOrder: [],
  }
  let summary = { byKind: [], byDay: [], total: 0, earliest: null, latest: null, levelTotals: { info: 0, warn: 0, error: 0, other: 0 } }
  let metrics = computeMetrics([])
  let windowInfo = { rows: [], truncated: false, parseFailures: 0, atMissing: false, skippedNoAt: 0, error: null }

  if (db !== null) {
    try {
      counts = buildCounts(db, opts, notes)
    } catch (error) {
      notes.push(`读取库状态时出错: ${toText(error?.message ?? error)}`)
    }
    try {
      windowInfo = loadWindowRows(db, opts, notes)
      summary = summarizeWindow(windowInfo.rows)
      metrics = computeMetrics(windowInfo.rows)
      if (windowInfo.atMissing) windowInfo.error = windowInfo.error ?? 'journal 缺少 at 列'
      if (windowInfo.skippedNoAt > 0) notes.push(`有 ${windowInfo.skippedNoAt} 条 journal 行的 at 为空或非法，已跳过。`)
    } catch (error) {
      notes.push(`聚合 journal 数据时出错: ${toText(error?.message ?? error)}`)
    }
  } else if (opened) {
    notes.push('数据库未能以只读方式打开，报告仅包含文件层面的信息。')
  }

  // 最近事件（按 --limit / --kinds 过滤）
  const recent = []
  if (db !== null && counts.hasJournal) {
    const available = columnsOf(db, 'journal')
    const conditions = []
    const params = []
    if (opts.session !== null && available.includes('session_id')) {
      conditions.push('session_id = ?')
      params.push(opts.session)
    }
    if (opts.kinds !== null && available.includes('kind')) {
      conditions.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`)
      params.push(...opts.kinds)
    }
    const orderBy = available.includes('id') ? 'at DESC, id DESC' : 'at DESC'
    const r = selectRows(db, 'journal', ['id', 'at', 'level', 'kind', 'session_id', 'summary', 'data'], {
      where: conditions.length > 0 ? conditions.join(' AND ') : null,
      params,
      orderBy,
      limit: opts.limit,
    })
    if (!r.ok) {
      notes.push(`读取最近事件失败: ${r.error}`)
    } else {
      for (const raw of r.rows) {
        const parsed = parseData(raw.data)
        recent.push({
          at: toNum(raw.at),
          atLocal: fmtLocal(raw.at),
          level: toText(raw.level).toLowerCase(),
          kind: toText(raw.kind),
          sessionId: raw.session_id === null || raw.session_id === undefined ? null : toText(raw.session_id),
          summary: toText(raw.summary),
          data: parsed.ok ? parsed.value : null,
          dataRaw: toText(raw.data),
          dataParseError: parsed.ok ? null : parsed.error,
        })
      }
    }
  } else if (db !== null && !counts.hasJournal) {
    notes.push('journal 表不存在，最近事件为空。')
  }

  const health = buildHealth({
    db,
    opened: db !== null,
    dbExists: dbSection.exists,
    openError: dbSection.error,
    valid: dbSection.valid,
    schemaError: dbSection.schemaError,
    counts,
    summary,
    metrics,
    opts,
    windowError: windowInfo.error,
  })

  const payload = {
    tool: 'mc-report',
    toolVersion: 1,
    generatedAt: now,
    generatedAtLocal: fmtLocal(now),
    timezoneOffset: fmtOffset(),
    window: { days: opts.days, since, sinceLocal: fmtLocal(since), truncated: windowInfo.truncated },
    filters: { session: opts.session, kinds: opts.kinds, limit: opts.limit, json: opts.json },
    db: dbSection,
    counts: {
      hasJournal: counts.hasJournal,
      journalTotal: counts.journalTotal,
      journalFirstAt: counts.journalFirstAt,
      journalLastAt: counts.journalLastAt,
      journal: {
        rows: counts.journalTotal,
        firstAt: counts.journalFirstAt,
        firstAtLocal: fmtLocal(counts.journalFirstAt),
        lastAt: counts.journalLastAt,
        lastAtLocal: fmtLocal(counts.journalLastAt),
        ageMs: counts.journalLastAt === null ? null : now - counts.journalLastAt,
      },
      tables: counts.tableCounts,
      tableCounts: counts.tableCounts,
      pendingDrops: counts.pendingDrops,
      sessions: { count: counts.sessionIds.length, ids: counts.sessionIds, journalRows: counts.sessionJournalCounts },
      sessionIds: counts.sessionIds,
      sessionJournalCounts: counts.sessionJournalCounts,
      meta: counts.meta,
      metaOrder: counts.metaOrder,
    },
    windowSummary: {
      total: summary.total,
      earliest: summary.earliest,
      earliestLocal: fmtLocal(summary.earliest),
      latest: summary.latest,
      latestLocal: fmtLocal(summary.latest),
      levels: summary.levelTotals,
      levelTotals: summary.levelTotals,
      byKind: summary.byKind,
      byDay: summary.byDay,
      truncated: windowInfo.truncated,
      skippedInvalidAt: windowInfo.skippedNoAt,
    },
    metrics,
    recent,
    health,
    notes,
  }

  if (db !== null) {
    try {
      db.close()
    } catch {
      /* 关闭失败不影响报告 */
    }
  }
  return payload
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    process.stderr.write(`参数错误: ${parsed.error}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (parsed.opts.help) {
    process.stdout.write(USAGE)
    process.exitCode = 0
    return
  }

  try {
    // 构建与渲染都包在同一个兜底里：任何未预期异常都不能抛栈崩溃。
    const payload = buildReport(parsed.opts)
    if (parsed.opts.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else {
      process.stdout.write(`${renderText(payload)}\n`)
    }
    process.exitCode = 0
  } catch (error) {
    const message = toText(error?.stack ?? error?.message ?? error)
    if (parsed.opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'mc-report',
            error: '报告生成失败（未预期异常）',
            detail: message,
            db: { path: parsed.opts.db },
          },
          null,
          2,
        )}\n`,
      )
    } else {
      process.stdout.write(`报告生成失败（未预期异常，已安全退出）:\n${message}\n`)
    }
    process.exitCode = 0
  }
}

main()
