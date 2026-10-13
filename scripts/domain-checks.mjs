#!/usr/bin/env node
/**
 * domain-checks.mjs — 全局域车道的判据（纯函数，只读）
 *
 * 为什么单独成文件而不是写在 doctor / acceptance 里：本仓纪律 ④「判据先自证」——
 * 一条判据只有在"人为破坏后确实报警"时才成立。真库实测只能证明"此刻没坏"，证明不了
 * "坏了会报"。这里的判定逻辑不碰文件、不打印、不退出，测试用合成库逐条做**正负样本
 * 对照**（`tests/domain-checks.spec.ts`）；doctor 与 acceptance 只负责打印。
 *
 * 两个消费者，两种语气（同一份事实）：
 *   - `doctorDomainFindings(db)` → 诊断：ok / info / warn，warn 不阻断，是"需要人看一眼"。
 *   - `acceptanceDomainItems(db)` → 验收：PASS / WARN / FAIL，FAIL 阻断 gate。
 *
 * 安全性：全部语句都是 SELECT；不写库、不打印记忆正文、不触碰共享契约库的写路径。
 */

const LEVEL_OK = 'ok'
const LEVEL_INFO = 'info'
const LEVEL_WARN = 'warn'

/** 表存在性，任何异常都按"不存在"处理（旧库/损坏库不该让诊断崩掉）。 */
function hasTable(db, name) {
  try {
    return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  } catch {
    return false
  }
}

function count(db, table, where = '') {
  if (!hasTable(db, table)) return 0
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"${where ? ` WHERE ${where}` : ''}`).get()?.n ?? 0)
  } catch {
    return 0
  }
}

/**
 * The one read both consumers share. Tolerant by construction: every field is
 * present even when the schema predates v8, so callers never branch on
 * `undefined` and a missing table can never be mistaken for "zero domains".
 *
 * This reads the **adapter** store only. The profile pool lives in the contract
 * store, which is a different database — see `readProfilePool`.
 */
export function readDomainSummary(db, now = Date.now()) {
  const summary = {
    present: hasTable(db, 'domains'),
    domains: [],
    pendingConfirmations: 0,
    pendingCandidates: 0,
    /** Age of the OLDEST pending candidate in days; null when the queue is empty. */
    pendingCandidateAgeDays: null,
  }
  if (!summary.present) return summary
  try {
    summary.domains = db
      .prepare(
        `SELECT d.domain_id AS id, d.kind AS kind, d.enabled AS enabled, d.budget_tokens AS budget,
                d.cap AS cap,
                (SELECT COUNT(*) FROM domain_members m WHERE m.domain_id = d.domain_id) AS members
           FROM domains d ORDER BY d.kind, d.domain_id`,
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        enabled: Number(row.enabled) === 1,
        budget: Number(row.budget),
        cap: Number(row.cap),
        members: Number(row.members),
      }))
  } catch {
    summary.domains = []
  }
  summary.pendingConfirmations = count(db, 'profile_confirmations', "state='pending'")
  summary.pendingCandidates = count(db, 'global_candidates', "state='pending'")
  if (summary.pendingCandidates > 0) {
    // `created_at` is when the candidate was first seen (the upsert refreshes
    // `updated_at`, never this one), so ">N days unhandled" is an age, not a
    // last-touch. An unreadable timestamp yields null, which the red line reads
    // as "not proven old" — a failed read must never manufacture an alarm.
    try {
      const row = db.prepare("SELECT MIN(created_at) AS oldest FROM global_candidates WHERE state='pending'").get()
      const oldest = Number(row?.oldest ?? 0)
      if (oldest > 0) summary.pendingCandidateAgeDays = Math.floor((now - oldest) / 86_400_000)
    } catch {
      summary.pendingCandidateAgeDays = null
    }
  }
  return summary
}

/**
 * The profile pool, read from the CONTRACT store. Kept separate from
 * `readDomainSummary` on purpose: mixing the two databases is how a check ends
 * up reporting "no user_memories table" against a store that was never supposed
 * to have one — a false alarm the paired-sample tests caught on the first run.
 */
export function readProfilePool(contractDb) {
  if (contractDb === undefined || contractDb === null) return null
  const table = hasTable(contractDb, 'user_memories')
  return { table, active: table ? count(contractDb, 'user_memories', "status='active'") : 0 }
}

/** 一个启用的域却没有任何成员 ⇒ 它看不到任何项目：配置病态，不是"还没接管"。 */
export function enabledDomainsWithoutMembers(summary) {
  return summary.domains.filter((domain) => domain.enabled && domain.members === 0)
}

/**
 * Doctor's section 6, as data. Ordering is the contract: the table check, then
 * one line per domain, then the aggregate warnings — so a reader can scan it.
 */
export function doctorDomainFindings(db) {
  const summary = readDomainSummary(db)
  const findings = []
  const push = (level, text) => findings.push({ level, text })

  if (!summary.present) {
    push(LEVEL_WARN, '自有库没有 domains 表（schema < v8）：全局域车道尚未接管')
    return findings
  }
  if (summary.domains.length === 0) {
    push(LEVEL_WARN, '没有任何全局域：跨项目共享未配置（/ctx-global create <domain> --kind org|machine 建域）')
  }
  for (const domain of summary.domains) {
    push(
      domain.enabled ? LEVEL_OK : LEVEL_INFO,
      `${domain.id} [${domain.kind}] ${domain.enabled ? '启用' : '停用'} · budget ${domain.budget} · cap ${domain.cap} · ${domain.members} 成员`,
    )
  }
  if (summary.domains.length > 0 && summary.domains.every((domain) => !domain.enabled)) {
    push(LEVEL_WARN, '全部域停用：路由已就绪但未接管（确认成员后用 /ctx-global enable <domain>）')
  }
  for (const domain of enabledDomainsWithoutMembers(summary)) {
    push(LEVEL_WARN, `${domain.id} 已启用却没有任何成员：它看不到任何项目（members 导入是否失败？）`)
  }
  push(
    summary.pendingConfirmations > 0 ? LEVEL_WARN : LEVEL_INFO,
    `画像确认队列待确认 ${summary.pendingConfirmations} 条${summary.pendingConfirmations > 0 ? '（/ctx-profile list）' : ''}`,
  )
  push(
    summary.pendingCandidates > 0 ? LEVEL_WARN : LEVEL_INFO,
    `全局候选待定 ${summary.pendingCandidates} 条${summary.pendingCandidates > 0 ? '（/ctx-global candidates）' : ''}`,
  )
  return findings
}

/**
 * Backlog thresholds — ONE source for both tiers, because two constants that
 * disagree is exactly how a reader stops knowing which line they are looking at.
 *
 * - `early`: a queue this deep means nobody is draining it. A nudge, not a verdict.
 * - `redLine`: the design's own trigger (platform-takeover §7) — candidates past
 *   this depth AND past this age are "must handle", not "watch".
 *
 * They do not conflict: the early tier fires long before the red line, and a
 * deep-but-FRESH queue is precisely the case the red line must not fire on.
 */
export const BACKLOG_THRESHOLDS = {
  early: { confirmations: 5, candidates: 10 },
  redLine: { candidates: 50, ageDays: 7 },
}

/**
 * Acceptance items for the domain lane. Each one is a claim that can fail, and
 * each has a synthetic negative sample in `tests/domain-checks.spec.ts`.
 *
 * `adapterDb` supplies the domains and the two queues; `contractDb` supplies the
 * profile pool (a different database). When the contract handle is missing the
 * profile item says so rather than answering from the wrong store.
 */
export function acceptanceDomainItems(adapterDb, contractDb = null, now = Date.now()) {
  const summary = readDomainSummary(adapterDb, now)
  const pool = readProfilePool(contractDb)
  const items = []
  const add = (level, id, detail, evidence) => items.push({ level, id, detail, evidence })

  add(
    summary.present ? 'PASS' : 'FAIL',
    'domain.schema',
    summary.present
      ? `全局域表存在（${String(summary.domains.length)} 个域）`
      : '自有库没有 domains 表：schema 未到 v8，域车道完全缺失',
    { domains: summary.domains.length },
  )

  const withMembers = summary.domains.filter((domain) => domain.members > 0)
  add(
    withMembers.length > 0 ? 'PASS' : 'WARN',
    'domain.members',
    withMembers.length > 0
      ? `${String(withMembers.length)} 个域有成员（${withMembers.map((d) => `${d.id}=${String(d.members)}`).join(', ')}）`
      : '没有任何域拥有成员（/ctx-global add <domain> <identity> 加成员）',
    { members: summary.domains.map((d) => ({ id: d.id, members: d.members })) },
  )

  const enabled = summary.domains.filter((domain) => domain.enabled)
  add(
    enabled.length > 0 ? 'PASS' : 'WARN',
    'domain.enabled',
    enabled.length > 0
      ? `${String(enabled.length)} 个域已启用：${enabled.map((d) => d.id).join(', ')}`
      : '全部域停用：能力就绪但跨项目共享未接管（每个域开关默认 off 是刻意的，确认成员后再开）',
    { enabled: enabled.map((d) => d.id) },
  )

  const orphaned = enabledDomainsWithoutMembers(summary)
  add(
    orphaned.length === 0 ? 'PASS' : 'WARN',
    'domain.enabled-without-members',
    orphaned.length === 0
      ? '没有"已启用却零成员"的域'
      : `${String(orphaned.length)} 个域已启用却零成员：${orphaned.map((d) => d.id).join(', ')}（启用了也看不到任何项目）`,
    { domains: orphaned.map((d) => d.id) },
  )

  const early = BACKLOG_THRESHOLDS.early
  const backlog = summary.pendingConfirmations
  add(
    backlog > early.confirmations ? 'WARN' : 'PASS',
    'domain.confirmation-backlog',
    backlog > early.confirmations
      ? `画像确认队列积压 ${String(backlog)} 条（>${String(early.confirmations)}）：约束型内容未确认就不会生效，堆积等于白采集（/ctx-profile list）`
      : `画像确认队列 ${String(backlog)} 条，未积压`,
    { pending: backlog, threshold: early.confirmations },
  )

  const candidates = summary.pendingCandidates
  add(
    candidates > early.candidates ? 'WARN' : 'PASS',
    'domain.candidate-backlog',
    candidates > early.candidates
      ? `全局候选积压 ${String(candidates)} 条（>${String(early.candidates)}，提前提醒）：复核通道没有在推进（/ctx-global candidates）`
      : `全局候选 ${String(candidates)} 条，未积压`,
    { pending: candidates, threshold: early.candidates },
  )

  // The design's own red line, and a TWO-axis one on purpose: depth alone is a
  // queue being filled faster than it drains, age alone is one stubborn item.
  // Only "deep AND old" means the lane must be handled (or retired) now.
  const redLine = BACKLOG_THRESHOLDS.redLine
  const age = summary.pendingCandidateAgeDays
  const overRedLine = candidates > redLine.candidates && age !== null && age > redLine.ageDays
  const ageText = age === null ? '无（队列空或时间戳不可读）' : `${String(age)} 天`
  add(
    overRedLine ? 'FAIL' : 'PASS',
    'domain.candidate-redline',
    overRedLine
      ? `全局候选越过设计红线：${String(candidates)} 条（>${String(redLine.candidates)}）且最老 ${ageText}（>${String(redLine.ageDays)} 天）——必须处理：复核/拒绝，或退役该域（/ctx-global candidates）`
      : `全局候选 ${String(candidates)} 条 · 最老 ${ageText}：未越红线（需同时 >${String(redLine.candidates)} 条且 >${String(redLine.ageDays)} 天）`,
    { pending: candidates, oldestDays: age, thresholds: redLine },
  )

  if (pool === null) {
    add('WARN', 'domain.profile-pool', '契约库未打开，无法判定画像池（先看上面 contract.* 的 FAIL）', { active: null })
  } else {
    add(
      pool.table && pool.active > 0 ? 'PASS' : 'WARN',
      'domain.profile-pool',
      pool.table
        ? `画像池 active ${String(pool.active)} 行`
        : '契约没有 user_memories 表：画像车道无源',
      { active: pool.active, table: pool.table },
    )
  }

  return items
}
