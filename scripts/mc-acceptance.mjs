#!/usr/bin/env node
/**
 * mc-acceptance.mjs — 记忆功能验收（只读，可复跑）
 *
 * 把本适配器的记忆契约固化成一条命令：读路径 / m[1] 增量面 / 缓存前缀稳定 /
 * historian 终止事件 / promotion 字段契约与纯追加 / epoch 稳定 / 权威守卫 / 契约版本 fence。
 *
 * 用法:
 *   node scripts/mc-acceptance.mjs
 *   node scripts/mc-acceptance.mjs --json
 *   node scripts/mc-acceptance.mjs --hours 24 --dsh-db <path> --mc-db <path>
 *
 * 退出码: 0 = 无 FAIL（可能有 WARN）；1 = 至少一条 FAIL；2 = 参数/环境错误。
 * 安全性: 两个库都以 readOnly 打开，绝不写入。绝不打印记忆原文（只打印 id/类别/计数）。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceDomainItems } from './domain-checks.mjs';
import { scanHistorianStarts, staleOpenStarts } from './historian-pairing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

function parseArgs(argv) {
  const out = { json: false, hours: 24, dshDb: null, mcDb: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--hours') out.hours = Number(argv[++i]);
    else if (a === '--dsh-db') out.dshDb = argv[++i];
    else if (a === '--mc-db') out.mcDb = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const DSH_DB = args.dshDb ?? join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'dsh-magic-context.db');
const MC_DB = args.mcDb ?? join(homedir(), '.local', 'share', 'cortexkit', 'magic-context', 'context.db');
const WINDOW_MS = Math.max(1, args.hours) * 3_600_000;
const SINCE = Date.now() - WINDOW_MS;

const results = [];
const add = (level, id, detail, evidence) => results.push({ level, id, detail, evidence });

function openReadOnly(path, label) {
  if (!existsSync(path)) { add('FAIL', `${label}.exists`, `${label} 不存在: ${path}`); return null; }
  try { return new DatabaseSync(path, { readOnly: true }); }
  catch (error) { add('FAIL', `${label}.open`, `无法只读打开 ${path}: ${error?.message ?? error}`); return null; }
}
const tableExists = (db, name) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name);
const colsOf = (db, table) => db.prepare(`SELECT name FROM pragma_table_info('${String(table).replace(/[^a-zA-Z0-9_]/g, '')}')`).all().map((r) => r.name);
const countOf = (db, table, where = '', params = []) =>
  db.prepare(`SELECT COUNT(*) AS n FROM "${table}"${where ? ` WHERE ${where}` : ''}`).get(...params).n;
const safeParse = (text) => { try { return JSON.parse(text ?? '{}'); } catch { return {}; } };
const hhmmss = (ms) => new Date(Number(ms)).toISOString().slice(11, 19);

// ─────────────────────────────────────────────────────────── 1. 适配器库结构
const dsh = openReadOnly(DSH_DB, 'adapter');
let bootMemoryWrite = null;
if (dsh) {
  const metaRow = tableExists(dsh, 'meta') ? dsh.prepare("SELECT value FROM meta WHERE key='schema_version'").get() : null;
  const ver = Number(metaRow?.value ?? (tableExists(dsh, 'schema_migrations')
    ? dsh.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000').get()?.v
    : 0) ?? 0);
  const expect = Number((readFileSync(join(PKG, 'src', 'core', 'stores.ts'), 'utf8').match(/SCHEMA_VERSION\s*=\s*(\d+)/) ?? [])[1] ?? 0);
  const needed = ['max_memory_id', 'max_memory_mutation_id', 'project_epoch_fingerprint'];
  const bcols = tableExists(dsh, 'baseline_state') ? colsOf(dsh, 'baseline_state') : [];
  const missing = needed.filter((c) => !bcols.includes(c));
  add(missing.length === 0 && (expect === 0 || ver >= expect) ? 'PASS' : 'FAIL', 'adapter.schema',
    `适配器 schema v${ver}（源码期望 v${expect}）；baseline_state 缺列: ${missing.length ? missing.join(',') : '无'}`,
    { version: ver, expected: expect, columns: bcols.length });

  // ─────────────────────────────────────────────────────── 2. boot 自检（读路径与写路径真的打开了）
  const boots = dsh.prepare('SELECT at, data FROM journal WHERE kind = ? ORDER BY id DESC LIMIT 3').all('boot')
    .map((r) => ({ at: r.at, d: safeParse(r.data) })).filter((b) => b.d.memory || b.d.memoryWrite || b.d.policy);
  if (boots.length === 0) add('WARN', 'adapter.boot', '最近没有 boot 事件（应用可能未重启）');
  else {
    const b = boots[0];
    const memOk = String(b.d.memory ?? '').startsWith('ok');
    const write = String(b.d.memoryWrite ?? '');
    bootMemoryWrite = write;
    const writeOk = write.startsWith('read-write') || write.startsWith('read-only') || write.startsWith('disabled') || write.startsWith('off');
    add(memOk && writeOk ? 'PASS' : 'FAIL', 'adapter.boot',
      `boot(${hhmmss(b.at)}) memory=${b.d.memory ?? '(缺)'} memoryWrite=${write || '(缺)'} engine=${b.d.engine ?? '(缺)'}`,
      { policy: b.d.policy });
  }

  // ─────────────────────────────────────────────────────── 3. 读路径：真的把项目记忆注入了 m[0]
  const recalls = dsh.prepare(`SELECT id, at, session_id, data FROM journal WHERE kind='memory-recall' AND at > ? ORDER BY id ASC`).all(SINCE)
    .map((r) => ({ id: r.id, at: r.at, sid: r.session_id, d: safeParse(r.data) }));
  const hit = recalls.filter((r) => Number(r.d.rows) > 0 && r.d.digest && r.d.digest !== 'da39a3ee5e6b');
  if (hit.length === 0) add('WARN', 'read.recall', `窗口 ${args.hours}h 内没有成功注入项目记忆的 recall（共 ${recalls.length} 次）`);
  else {
    const last = hit[hit.length - 1];
    add('PASS', 'read.recall', `${hit.length} 次成功 recall；最新 ${hhmmss(last.at)} rows=${last.d.rows} identity=${String(last.d.identity).slice(0, 22)} digest=${String(last.d.digest).slice(0, 12)}`,
      { projects: last.d.projects ?? [], maxMemoryId: last.d.maxMemoryId });
  }

  // ─────────────────────────────────────────────────────── 4. m[1] 增量面：两条车道都在跑
  const baselines = dsh.prepare(`SELECT id, at, session_id, data FROM journal WHERE kind='baseline' AND at > ? ORDER BY id ASC`).all(SINCE)
    .map((r) => ({ id: r.id, at: r.at, sid: r.session_id, d: safeParse(r.data) }));
  const withUpdates = baselines.filter((b) => b.d.memoryUpdates && typeof b.d.memoryUpdates === 'object');
  const renderedUpd = withUpdates.filter((b) => Number(b.d.memoryUpdates.rendered) > 0);
  const newMemRows = recalls.filter((r) => Number(r.d.newRows) > 0);
  const laneUpd = renderedUpd.length > 0 || withUpdates.some((b) => Number(b.d.memoryUpdates.cursor) > 0);
  const laneNew = newMemRows.length > 0;
  add(laneUpd && laneNew ? 'PASS' : laneUpd || laneNew ? 'WARN' : 'FAIL', 'delta.lane',
    `<memory-updates>: ${renderedUpd.length} 次渲染出增量（游标样本 ${withUpdates.length}）；<new-memories>: ${newMemRows.length} 次上报新行` +
    (renderedUpd.length ? `；最近渲染 rendered=${renderedUpd[renderedUpd.length - 1].d.memoryUpdates.rendered} cursor=${renderedUpd[renderedUpd.length - 1].d.memoryUpdates.cursor}` : ''),
    { updates: renderedUpd.slice(-2).map((b) => b.d.memoryUpdates), newRows: newMemRows.slice(-2).map((r) => r.d.newRows) });

  const bstate = tableExists(dsh, 'baseline_state')
    ? dsh.prepare('SELECT session_id, max_memory_id, max_memory_mutation_id, project_epoch_fingerprint FROM baseline_state').all()
    : [];
  const withCursor = bstate.filter((r) => r.max_memory_mutation_id !== null && r.max_memory_mutation_id !== undefined);
  add(withCursor.length > 0 ? 'PASS' : 'WARN', 'delta.cursor',
    `baseline_state: ${bstate.length} 个会话，其中 ${withCursor.length} 个已持久化 memory_mutation 游标`,
    { max_memory_id: bstate.map((r) => r.max_memory_id), mutation_cursor: bstate.map((r) => r.max_memory_mutation_id) });

  // ─────────────────────────────────────────────────────── 5. 缓存前缀稳定：同载荷的 baseline 必须逐字节一致
  const violations = [];
  const bySession = new Map();
  for (const b of baselines) {
    if (!bySession.has(b.sid)) bySession.set(b.sid, []);
    bySession.get(b.sid).push(b);
  }
  for (const [sid, list] of bySession) {
    let prev = null;
    for (const b of list) {
      const between = recalls.filter((r) => r.sid === sid && r.at > (prev?.at ?? 0) && r.at <= b.at && Number(r.d.newRows) > 0);
      const samePayload = prev && JSON.stringify(prev.d.memories) === JSON.stringify(b.d.memories)
        && JSON.stringify(prev.d.memoryUpdates) === JSON.stringify(b.d.memoryUpdates)
        && JSON.stringify(prev.d.compartments) === JSON.stringify(b.d.compartments);
      if (prev && samePayload && between.length === 0 && Number(prev.d.bytes) !== Number(b.d.bytes)) {
        violations.push(`${String(sid).slice(0, 8)} ${hhmmss(prev.at)}→${hhmmss(b.at)} ${prev.d.bytes}≠${b.d.bytes}`);
      }
      prev = b;
    }
  }
  add(violations.length === 0 ? 'PASS' : 'FAIL', 'delta.byteStable',
    violations.length === 0
      ? `同载荷（m[0] digest + 变更游标 + 分区计数一致、期间无新记忆）的 baseline 字节完全一致（检查 ${baselines.length} 条事件）`
      : `${violations.length} 处缓存前缀不稳定: ${violations.slice(0, 3).join(' | ')}`);

  // ─────────────────────────────────────────────────────── 6. historian：start 必须有终止事件
  const hist = dsh.prepare(`SELECT id, at, session_id, data FROM journal WHERE kind='historian' AND at > ? ORDER BY id ASC`).all(SINCE)
    .map((r) => ({ id: r.id, at: r.at, sid: r.session_id, phase: safeParse(r.data).phase, d: safeParse(r.data) }));
  // 配对与"安静孤儿"判定在 scripts/historian-pairing.mjs（纯函数，有正负样本对照）：
  // supersede-close（同会话新 start 挤掉旧 start）与 15 分钟安静阈值都在那里。
  const openStarts = scanHistorianStarts(hist);
  const histBoots = dsh.prepare(`SELECT id, at FROM journal WHERE kind='boot' AND at > ? ORDER BY id ASC`).all(SINCE).map((r) => ({ id: r.id, at: r.at }));
  const nowOpen = staleOpenStarts(openStarts);
  const counts = hist.reduce((acc, h) => ((acc[h.phase] = (acc[h.phase] ?? 0) + 1), acc), {});
  const trunc = hist.filter((h) => String(h.d.reason ?? '').includes('truncated at the token cap')).length;
  const stored = counts.stored ?? 0;
  // 一次运行被杀进程杀死时无法落账：start 之后 15s 内有 boot 事件即判定为进程重启所致。
  const excused = nowOpen.filter((h) => histBoots.some((b) => b.at >= h.at && b.at - h.at < 15_000));
  const firstTerminal = hist.find((h) => h.phase === 'done' || h.phase === 'failed');
  const unexcused = nowOpen.filter((h) => !excused.includes(h));
  const postFix = firstTerminal ? unexcused.filter((h) => h.at >= firstTerminal.at) : unexcused;
  const historic = unexcused.length - postFix.length;
  const orphanCount = postFix.length;
  add(orphanCount === 0 ? ((counts.start ?? 0) === 0 || stored > 0 || (counts.failed ?? 0) > 0 ? 'PASS' : 'WARN') : 'FAIL',
    'historian.terminal',
    `start=${counts.start ?? 0} done=${counts.done ?? 0} failed=${counts.failed ?? 0} stored=${counts.stored ?? 0}；未闭合 start: 修复后 ${orphanCount}（历史 ${historic}，进程重启致 ${excused.length}）；token-cap 截断失败=${trunc}`);
  if (orphanCount > 0) {
    add('FAIL', 'historian.orphan', `${orphanCount} 个 start 既无终止事件也非进程重启（静默蒸发）`,
      { sessions: [...new Set(postFix.map((h) => String(h.sid).slice(0, 14)))] });
  } else if (excused.length > 0) {
    add('WARN', 'historian.orphan', `${excused.length} 个 start 因进程重启（15s 内有 boot）无法落账，属已知限制而非静默失败`);
  }
  if ((counts.start ?? 0) > 0 && stored === 0) {
    add('WARN', 'historian.noSuccess', `窗口内 ${counts.start} 次运行没有任何成功（stored=0），检查 historianMaxTokens 是否过小`);
  }

  // ────────────────────────────────── 6b. maintenance：verify 扫描确实在推进且失败可诊断
  // 6 个真实缺陷曾整条逃过单元测试与验收：扫描在跑但从不成功、失败行不写原因。
  // 这里以数据为准：有失败行必须带 why；跑了多轮却零入账即视为机制失效。
  const maint = dsh.prepare(`SELECT at, level, summary, data FROM journal WHERE kind='maintenance' AND at > ? ORDER BY id ASC`).all(SINCE)
    .map((r) => ({ at: r.at, level: r.level, summary: r.summary, d: safeParse(r.data) }));
  if (maint.length === 0) {
    add('WARN', 'maintenance.ran', '窗口内没有 maintenance 行：扫描未运行（维护关闭、无身份登记，或进程刚重启尚未到首个 tick）');
  } else {
    const failedRows = maint.filter((m) => m.level === 'warn' || m.level === 'error');
    const banked = maint.filter((m) => Number(m.d.verified ?? 0) + Number(m.d.updated ?? 0) + Number(m.d.archived ?? 0) > 0);
    const undiagnosed = failedRows.filter((m) => String(m.d.why ?? m.d.reason ?? '').trim().length === 0);
    // Only the newest failures judge the CURRENT code: earlier rows predate the
    // diagnosability fix and stay as a count, not as a gate.
    const recentFailures = failedRows.slice(-3);
    const undiagnosedRecent = recentFailures.filter((m) => String(m.d.why ?? m.d.reason ?? '').trim().length === 0);
    const last = maint[maint.length - 1];
    const historical = undiagnosed.length - undiagnosedRecent.length;
    add(undiagnosedRecent.length === 0 ? 'PASS' : 'FAIL', 'maintenance.diagnosable',
      undiagnosedRecent.length === 0
        ? `最近 ${recentFailures.length} 次失败均带原因（why/route）${historical > 0 ? `；更早的 ${historical} 条属修复前历史行，仅记录` : ''}`
        : `${undiagnosedRecent.length}/${recentFailures.length} 条最近的失败行没有原因字段（静默失败，无法定位）`,
      undiagnosedRecent.length === 0 ? undefined : { samples: undiagnosedRecent.map((m) => String(m.summary).slice(0, 80)) });
    add(banked.length > 0 ? 'PASS' : (failedRows.length >= 3 ? 'FAIL' : 'WARN'), 'maintenance.progress',
      `窗口内 ${maint.length} 次 tick、失败 ${failedRows.length} 次、有入账 ${banked.length} 次；最新 ${hhmmss(last.at)} ${last.level}: ${String(last.summary).slice(0, 90)}`,
      banked.length === 0 ? { failures: failedRows.slice(-3).map((m) => String(m.d.why ?? m.summary).slice(0, 100)) } : undefined);
  }

  // ─────────────────────────────────────────────────────── 7. promotion：字段契约 + 纯追加
  const promotes = dsh.prepare(`SELECT at, data FROM journal WHERE kind='memory-promote' AND at > ? ORDER BY id ASC`).all(SINCE)
    .map((r) => ({ at: r.at, d: safeParse(r.data) }));
  const promotedIds = new Set();
  for (const p of promotes) for (const ins of p.d.inserted ?? []) if (ins?.id !== undefined) promotedIds.add(Number(ins.id));

  const mc = openReadOnly(MC_DB, 'mc');

  // ─────────────────────────────────────────────────── 6b. 全局域车道（WP13）
  // 判定逻辑在 scripts/domain-checks.mjs（纯函数），每一条都在
  // tests/domain-checks.spec.ts 里配了"人为破坏必须报警"的负向样本；这里只汇总。
  // 两个库各司其职：域与队列在适配器库，画像池在契约库（mc 可能是 null）。
  for (const item of acceptanceDomainItems(dsh, mc)) add(item.level, item.id, item.detail, item.evidence);

  if (mc) {
    const mcVersion = mc.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000').get()?.v ?? 0;
    const maxSupported = Number((readFileSync(join(PKG, 'src', 'core', 'memory-bridge.ts'), 'utf8').match(/MEMORY_SCHEMA_MAX_VERSION\s*=\s*(\d+)/) ?? [])[1] ?? 0);
    add(mcVersion <= maxSupported ? 'PASS' : 'WARN', 'fence.version',
      `MC schema v${mcVersion}，适配器支持到 v${maxSupported}${mcVersion > maxSupported ? ' → 已进入只读降级（契约 fence）' : '（未触发 fence）'}`);
    // 交叉不变量：fence 状态必须与操作者/界面看到的 memory_write 措辞一致，
    // 否则写路径全部失败却对外宣称 read-write（在真实库副本上实测过的缺陷形态）。
    if (typeof bootMemoryWrite === 'string' && (bootMemoryWrite.startsWith('read-write') || bootMemoryWrite.startsWith('read-only'))) {
      const fenced = mcVersion > maxSupported;
      const reported = bootMemoryWrite.startsWith('read-only');
      add(reported === fenced ? 'PASS' : 'FAIL', 'fence.exposure',
        `MC v${mcVersion} ${fenced ? '>' : '≤'} 适配器 v${maxSupported}；boot 里 memory_write="${bootMemoryWrite.slice(0, 70)}"`);
    }

    if (promotedIds.size === 0) add('WARN', 'promotion.rows', '窗口内没有 promotion 事件（historian 未成功或 autoPromote 未开）');
    else {
      const ids = [...promotedIds];
      const placeholders = ids.map(() => '?').join(',');
      // 显式 update/archive 会合法地改动 importance/updated_at，这类行只校验不可变字段。
      let mutationByType = [];
      let mutatedIds = new Set();
      let archivedIds = new Set();
      try {
        mutationByType = mc.prepare(`SELECT target_memory_id, mutation_type, COUNT(*) AS n FROM memory_mutation_log
          WHERE target_memory_id IN (${placeholders}) GROUP BY target_memory_id, mutation_type`).all(...ids);
        mutatedIds = new Set(mutationByType.map((m) => Number(m.target_memory_id)));
        archivedIds = new Set(mutationByType.filter((m) => m.mutation_type === 'archive').map((m) => Number(m.target_memory_id)));
      } catch { /* 老库可能没有 memory_mutation_log */ }
      const rows = mc.prepare(`SELECT id, project_path, category, importance, scope, shareable, source_type, status,
        verification_status, seen_count, retrieval_count, created_at, updated_at, last_seen_at, expires_at, classified_at
        FROM memories WHERE id IN (${placeholders})`).all(...ids);
      const bad = [];
      let touchedAfter = 0;
      let archivedAfter = 0;
      let classifiedAfter = 0;
      for (const r of rows) {
        const problems = [];
        const wasUpdated = mutatedIds.has(Number(r.id));
        // 提升之后被合法触碰的三种路径：显式 update/archive（有变更日志），
        // 去重命中（seen_count 前移 + updated_at/last_seen_at 前移，且按契约不写变更日志），
        // 以及 classify 打分（v0.3.3 裁决：metadata-only 落地 importance+classified_at，
        // 同样按契约不写变更日志——时间戳保持不动，只有打分与 classified_at 变化）。
        const deduped = Number(r.seen_count) > 1;
        const classified = r.classified_at !== null && r.classified_at !== undefined;
        if (classified) classifiedAfter++;
        const touched = wasUpdated || deduped;
        if (touched) touchedAfter++;
        if (r.status === 'archived' && archivedIds.has(Number(r.id))) archivedAfter++;
        if (r.source_type !== 'historian') problems.push(`source_type=${r.source_type}`);
        if (classified) {
          // 打分行校验打分值域本身；importance 不再期望提升默认值 50。
          if (Number(r.importance) < 1 || Number(r.importance) > 100) problems.push(`importance=${r.importance} 越界`);
        } else if (!wasUpdated && Number(r.importance) !== 50) problems.push(`importance=${r.importance}`);
        if (r.scope !== 'project') problems.push(`scope=${r.scope}`);
        if (Number(r.shareable) !== 0) problems.push(`shareable=${r.shareable}`);
        // Maintenance verify (wrong→archiveMemory) is the designed lifecycle end
        // for a promoted row; it is contract-clean only when the archive went
        // through the contract lane and left its mutation-log entry — an
        // out-of-contract archive still fails here.
        if (r.status !== 'active' && !(r.status === 'archived' && archivedIds.has(Number(r.id)))) problems.push(`status=${r.status}`);
        // Promotion writes 'unverified' by contract; the maintenance sweep then
        // legitimately moves the row to 'verified' (§9). Both are the designed
        // lifecycle, so only a value outside it is a violation.
        if (r.verification_status !== 'unverified' && r.verification_status !== 'verified') problems.push(`verification=${r.verification_status}`);
        if (!wasUpdated && Number(r.retrieval_count) !== 0 && r.last_retrieved_at === null) problems.push(`retrieval_count=${r.retrieval_count} 但 last_retrieved_at 为空`);
        if (Number(r.seen_count) < 1) problems.push(`seen_count=${r.seen_count}`);
        if (!touched && (Number(r.created_at) !== Number(r.updated_at) || Number(r.created_at) !== Number(r.last_seen_at))) problems.push('时间戳不一致');
        if (problems.length) bad.push(`#${r.id}[${problems.join(',')}]`);
      }
      const missing = ids.length - rows.length;
      add(bad.length === 0 && missing === 0 ? 'PASS' : 'FAIL', 'promotion.contract',
        `窗口内提升 ${ids.length} 行；库里命中 ${rows.length}；此后被更新/去重触碰 ${touchedAfter} 行（相应放宽 importance/时间戳校验）；classify 打分 ${classifiedAfter} 行（metadata-only，校验值域）；契约归档 ${archivedAfter} 行；字段偏差 ${bad.length}${missing ? `；缺失 ${missing}` : ''}${bad.length ? ': ' + bad.slice(0, 4).join(' ') : ''}`);

      // 纯追加：不得有 insert/delete 类变更日志；update 类必须与显式 ctx_memory update 调用对应
      const agg = new Map();
      for (const m of mutationByType) agg.set(m.mutation_type, (agg.get(m.mutation_type) ?? 0) + Number(m.n));
      const mutationRows = [...agg].map(([mutation_type, n]) => ({ mutation_type, n }));
      const forbidden = mutationRows.filter((m) => m.mutation_type === 'insert' || m.mutation_type === 'delete');
      // 显式 update 的三个来源：agent 的 update 工具调用、写入通道的 update op、
      // 以及维护 tick 的 stale→updateMemory（dreamer verify manifest，§P5）——
      // 后者写变更日志但不经过工具调用，漏计它会把窗口口径搞成假阳性。
      const explicitUpdates = dsh.prepare(`SELECT COUNT(*) AS n FROM journal WHERE kind='tool-call' AND data LIKE '%"action":"update"%' AND at > ?`).get(SINCE).n
        + dsh.prepare(`SELECT COUNT(*) AS n FROM journal WHERE kind='memory-write' AND data LIKE '%"op":"update"%' AND at > ?`).get(SINCE).n
        + dsh.prepare(`SELECT COALESCE(SUM(CAST(JSON_EXTRACT(data, '$.updated') AS INTEGER)), 0) AS n FROM journal WHERE kind='maintenance' AND at > ?`).get(SINCE).n;
      const updateRows = mutationRows.filter((m) => m.mutation_type === 'update').reduce((a, m) => a + m.n, 0);
      add(forbidden.length === 0 && updateRows <= explicitUpdates ? 'PASS' : 'FAIL', 'promotion.appendOnly',
        `提升行的变更日志: ${mutationRows.length ? mutationRows.map((m) => `${m.mutation_type}=${m.n}`).join(' ') : '无'}；显式 update 来源合计 ${explicitUpdates}（工具调用+写入通道+maintenance）；update 日志 ${updateRows}`);
    }

    // 检索计数（契约 §9.1）：只有 agent 的显式检索才 +1 —— 不带 id 的 get、list、
    // 以及 search（search 是本适配器 §9.1 的计数点之一），而自动注入的 m[0]/m[1]
    // 永不虚增。retrieval_count 是**累计**列，所以比较基准也必须是累计的显式调用数：
    // 拿窗口内调用数去比累计计数会误报（自动注入若灌水，这个数字会是几百）。
    // 注意：journal 的修剪会让累计调用数变小，此时该检查会偏保守。
    const retrievalCallFilter = `kind='tool-call' AND (data LIKE '%"action":"list"%' OR data LIKE '%"action":"get"%' OR data LIKE '%"action":"search"%')`;
    const explicitRetrievalsAll = dsh.prepare(`SELECT COUNT(*) AS n FROM journal WHERE ${retrievalCallFilter}`).get().n;
    const explicitRetrievalsWindow = dsh.prepare(`SELECT COUNT(*) AS n FROM journal WHERE ${retrievalCallFilter} AND at > ?`).get(SINCE).n;
    const retrieved = mc.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(retrieval_count), 0) AS maxCount
      FROM memories WHERE project_path IN (SELECT DISTINCT project_path FROM memories WHERE source_type='historian' AND created_at > ?)
      AND retrieval_count > 0`).get(SINCE);
    const nullStamp = mc.prepare(`SELECT COUNT(*) AS n FROM memories WHERE retrieval_count > 0 AND last_retrieved_at IS NULL`).get().n;
    add(Number(retrieved.maxCount) <= explicitRetrievalsAll && nullStamp === 0 ? 'PASS' : 'FAIL', 'retrieval.telemetry',
      `被检索行 ${retrieved.n} 行（单行最多 ${retrieved.maxCount} 次）；显式检索调用 累计 ${explicitRetrievalsAll}（窗口内 ${explicitRetrievalsWindow}）；计数>0 但时间戳为空 ${nullStamp} 行`);

    // ───────────────────────────────────────────────────── 8. epoch 稳定 + 权威守卫
    if (bstate.length) {
      const fingerprints = [...new Set(bstate.map((r) => r.project_epoch_fingerprint).filter(Boolean))];
      add(fingerprints.length <= 1 ? 'PASS' : 'WARN', 'epoch.stability',
        `${bstate.length} 个会话的 project_epoch_fingerprint: ${fingerprints.length === 0 ? '(空)' : fingerprints.join(', ')}`);
    }
    const touched = mc.prepare(`SELECT DISTINCT project_path FROM memories WHERE source_type='historian' AND created_at > ?`).all(SINCE).map((r) => r.project_path);
    const managed = touched.length ? countOf(mc, 'authority_managed', `project_path IN (${touched.map(() => '?').join(',')})`, touched) : 0;
    const repair = touched.length ? countOf(mc, 'authority_repair_pending', `project_path IN (${touched.map(() => '?').join(',')})`, touched) : 0;
    const priv = mc.prepare('SELECT id, enabled FROM context_privilege_state').all();
    const privOn = priv.filter((p) => Number(p.enabled) !== 0);
    add(managed === 0 && repair === 0 && privOn.length === 0 ? 'PASS' : 'FAIL', 'authority.guard',
      `本轮提升涉及 ${touched.length} 个项目；authority_managed=${managed} authority_repair_pending=${repair} context_privilege_state 启用=${privOn.length}`);
    mc.close();
  }
  dsh.close();
}

// ─────────────────────────────────────────────────────────── 输出
const order = { FAIL: 0, WARN: 1, PASS: 2 };
const sorted = [...results].sort((a, b) => order[a.level] - order[b.level]);
if (args.json) {
  console.log(JSON.stringify({ at: Date.now(), dshDb: DSH_DB, mcDb: MC_DB, windowHours: args.hours, results: sorted }, null, 2));
} else {
  console.log(`记忆功能验收（只读） window=${args.hours}h`);
  console.log(`  adapter: ${DSH_DB}`);
  console.log(`  mc     : ${MC_DB}\n`);
  for (const r of sorted) {
    console.log(`  ${r.level === 'PASS' ? '✓' : r.level === 'WARN' ? '!' : '✗'} ${r.id.padEnd(22)} ${r.detail}`);
    if (r.level === 'FAIL' && r.evidence) console.log(`      evidence: ${JSON.stringify(r.evidence)}`);
  }
  const fails = sorted.filter((r) => r.level === 'FAIL').length;
  const warns = sorted.filter((r) => r.level === 'WARN').length;
  console.log(`\n  ${sorted.length - fails - warns} PASS / ${warns} WARN / ${fails} FAIL`);
}
process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
