// 用**真实 journal 数据**验证客户端「操作记录」分类，并打印主界面即将显示的内容。
// 不走浏览器：用 new Function 评估 client/index.js 的模块外壳，注入 stub React，
// 调 __diagnostics 映射真实事件。用法：node scripts/mc-records-check.mjs [adapterDb]
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The client half this check evaluates: derived from the script's own location. */
const CLIENT = join(HERE, '..', 'src', 'client', 'index.js');
const DB = process.argv[2] ?? join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'dsh-magic-context.db');

let definition = null;
const window = { __ModuleLoader__: { load: (def) => { definition = def } } };
new Function('window', readFileSync(CLIENT, 'utf8'))(window);
if (definition === null || typeof definition.factory !== 'function') {
  console.error('client bundle did not register a module');
  process.exit(2);
}
const stubReact = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};
const api = definition.factory((name) => {
  if (name === 'react') return stubReact;
  throw new Error('unexpected require: ' + name);
});
const { recordOf, recordsOf, recordCounts, noiseLine, dictionaryKeys, dictionaryTranslator, recordCategories } = api.__diagnostics;
// The panel's own category table (icon + label key), NOT a hand-copied mirror:
// the mirror had drifted (`maintain` was added to the client and the copy was
// not), and the script crashed on a category it did not know instead of saying
// so. Labels come from the shipped zh dictionary for the same reason.
const zh = dictionaryTranslator('zh');

// 取每类 kind 的最新一行 + 最近 80 行，覆盖所有分类分支。
const db = new DatabaseSync(DB, { readOnly: true });
const newest = db.prepare('SELECT at, level, kind, summary, data FROM journal ORDER BY id DESC LIMIT 80').all();
const perKind = db.prepare('SELECT at, level, kind, summary, data FROM journal WHERE id IN (SELECT MAX(id) FROM journal GROUP BY kind, level)').all();
// `tool-call` is one kind with many flavours, and the newest row of that kind is
// almost always a ctx_memory call — so sampling per kind left the reclamation
// lane (ctx_reduce/ctx_expand) out entirely and its assertions were vacuous.
// One newest row per flavour keeps the check honest.
const perFlavour = db.prepare(`SELECT at, level, kind, summary, data FROM journal
  WHERE id IN (SELECT MAX(id) FROM journal WHERE kind = 'tool-call'
    GROUP BY json_extract(data, '$.tool'), json_extract(data, '$.action'))`).all();
db.close();
const rows = [...newest, ...perKind, ...perFlavour].map((r) => ({
  at: r.at, level: r.level, kind: r.kind, summary: r.summary,
  ...(r.data === null || r.data === undefined ? {} : { data: JSON.parse(r.data) }),
}));

console.log(`=== 用 ${rows.length} 条真实 journal 行映射出的「操作记录」（面板会这样显示）===\n`);
const records = recordsOf(rows);
for (const record of records.slice(0, 22)) {
  const meta = recordCategories[record.category] ?? { icon: '❔', labelKey: 'category.' + record.category };
  const detail = (record.detail !== '' ? record.detail : String(record.summary ?? '')) + (record.count > 1 ? ' ×' + record.count : '');
  console.log(`  ${meta.icon} ${zh(meta.labelKey).padEnd(7)} │ ${record.text.padEnd(12)} │ ${detail.slice(0, 74)}`);
}
console.log(`\n=== 分类计数 chips ===`);
console.log('  ' + recordCounts(records).map((e) => `${e.icon}${e.label} ${e.count}`).join('   '));
console.log(`\n=== 折叠的噪声 ===\n  ${noiseLine(rows)}`);

// ── 断言
const byKind = (kind, predicate) => rows.filter((r) => r.kind === kind && (predicate === undefined || predicate(r)));
// Kinds the panel shows as records. `memory-recall` and a SOFT `baseline` are
// NOT here on purpose: they are folded into the noise line (NOISE_KINDS in the
// client), which is what keeps the panel readable on a busy session. A HARD
// rebuild IS a record — the client maps it to a priced cache bust
// (`case 'baseline'`) and `noiseLine` counts only soft ones — so the split has
// to follow `data.mode`, not the kind alone. Demanding it by kind alone passed
// only while no hard row happened to sit in the newest-80 sample window.
const hardBaseline = byKind('baseline', (r) => r.data?.mode === 'hard');
const softBaseline = byKind('baseline', (r) => r.data?.mode !== 'hard');
const mustMap = [
  ...byKind('memory-promote'),
  ...byKind('compartment-published'),
  ...byKind('emergency-reclaim'),
  ...byKind('historian', (r) => r.level === 'error'),
  ...byKind('maintenance'),
  ...byKind('tool-call', (r) => ['write', 'update', 'archive', 'merge', 'list', 'get', 'search'].includes(r.data?.action)),
  // The reclamation lane: rows carry `tool` and tag arrays, no `action` — the
  // client dropped these until the panel learned to render them.
  ...byKind('tool-call', (r) => ['ctx_reduce', 'ctx_expand'].includes(r.data?.tool)),
];
const foldedKinds = [...byKind('memory-recall'), ...softBaseline];
const unmapped = mustMap.filter((r) => recordOf(r) === null);
const notFolded = foldedKinds.filter((r) => recordOf(r) !== null);
const deferPasses = byKind('pass', (r) => r.data?.decision !== 'execute').filter((r) => recordOf(r) !== null);
const noiseKindsMapped = rows.filter((r) => ['boot', 'session-first-seen', 'engine'].includes(r.kind) && recordOf(r) !== null);
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ': ' + detail : ''}`); };
console.log('\n=== 断言 ===');
check('关键操作行全部被映射成记录', unmapped.length === 0, unmapped.length ? unmapped.map((r) => r.kind).join(', ') : `${mustMap.length} 行`);
check('非 execute 的 pass 不进入记录列表', deferPasses.length === 0, `${deferPasses.length} 行泄漏`);
check('boot/session/engine 噪声不进入记录列表', noiseKindsMapped.length === 0, `${noiseKindsMapped.length} 行泄漏`);
check('分类计数之和等于记录数', recordCounts(records).reduce((a, e) => a + e.count, 0) === records.length,
  `${recordCounts(records).reduce((a, e) => a + e.count, 0)} vs ${records.length}`);
check('每条记录都有分类/文案/时间', records.every((r) => typeof r.category === 'string' && typeof r.text === 'string' && typeof r.at === 'number'));
const unknownCategories = [...new Set(records.map((r) => r.category))].filter((c) => recordCategories[c] === undefined);
check('每个分类都在面板的分类表里（防镜像漂移）', unknownCategories.length === 0,
  unknownCategories.length ? unknownCategories.join(', ') : `${new Set(records.map((r) => r.category)).size} 类`);
const promote = records.find((r) => r.text === '记忆提升');
check('promotion 记录带真实条数', promote !== undefined && /新增 \d+/.test(promote.detail), promote?.detail ?? '(无样本)');
// The folded half of the design: recall and SOFT baseline are noise, and the
// noise line names them with their counts instead of vanishing silently.
check('recall/soft baseline 折叠为噪声而不是记录', notFolded.length === 0, `${notFolded.length} 行泄漏`);
check('HARD 基线重建仍是记录（priced cache bust）',
  hardBaseline.every((r) => recordOf(r)?.category === 'reclaim'),
  `${hardBaseline.length} 行`);
const noise = noiseLine(rows);
const recallRows = byKind('memory-recall').length;
const softBaselineRows = softBaseline.length;
check('噪声行点名加载记忆与基线刷新', (recallRows === 0 || noise.includes('加载记忆')) && (softBaselineRows === 0 || noise.includes('基线刷新')),
  noise);

// ── i18n：字典键集合必须对齐，英文渲染不得回退到中文
const keys = dictionaryKeys();
const keyDrift = keys.zh.filter((k) => !keys.en.includes(k)).concat(keys.en.filter((k) => !keys.zh.includes(k)));
check('zh/en 字典键集合一致', keyDrift.length === 0, keyDrift.length ? keyDrift.join(', ') : `${keys.zh.length} keys`);
const en = dictionaryTranslator('en');
const enRecords = recordsOf(rows, en);
const cjk = /[\u4e00-\u9fff]/;
check('英文渲染不含中文残留', enRecords.every((r) => !cjk.test(r.text + r.detail)),
  enRecords.filter((r) => cjk.test(r.text + r.detail)).map((r) => r.text).join(', ') || `${enRecords.length} 行`);
check('参数插值生效', en('records.folded', { n: 3 }) === '×3' && en('detail.added', { n: '9' }) === 'added 9');
check('未知键回退为键名', en('nope.missing') === 'nope.missing');
console.log('\n=== 英文渲染（en 字典）===');
for (const record of enRecords.slice(0, 6)) console.log(`  ${record.category.padEnd(9)} │ ${record.text.padEnd(20)} │ ${record.detail.slice(0, 56)}`);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAIL'}`);
process.exit(failures === 0 ? 0 : 1);
