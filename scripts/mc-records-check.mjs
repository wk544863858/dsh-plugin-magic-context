// 用**真实 journal 数据**验证客户端「操作记录」分类，并打印主界面即将显示的内容。
// 不走浏览器：用 new Function 评估 client/index.js 的模块外壳，注入 stub React，
// 调 __diagnostics 映射真实事件。用法：node records-check.mjs [adapterDb]
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLIENT = '<path>';
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
const { recordOf, recordsOf, recordCounts, noiseLine, dictionaryKeys, dictionaryTranslator } = api.__diagnostics;

// 取每类 kind 的最新一行 + 最近 80 行，覆盖所有分类分支。
const db = new DatabaseSync(DB, { readOnly: true });
const newest = db.prepare('SELECT at, level, kind, summary, data FROM journal ORDER BY id DESC LIMIT 80').all();
const perKind = db.prepare('SELECT at, level, kind, summary, data FROM journal WHERE id IN (SELECT MAX(id) FROM journal GROUP BY kind, level)').all();
db.close();
const rows = [...newest, ...perKind].map((r) => ({
  at: r.at, level: r.level, kind: r.kind, summary: r.summary,
  ...(r.data === null || r.data === undefined ? {} : { data: JSON.parse(r.data) }),
}));

console.log(`=== 用 ${rows.length} 条真实 journal 行映射出的「操作记录」（面板会这样显示）===\n`);
const records = recordsOf(rows);
for (const record of records.slice(0, 22)) {
  const meta = { write: ['🧠', '写入记忆'], read: ['🔎', '加载记忆'], reclaim: ['✂️', '压缩上下文'], drop: ['🗑️', '丢弃上下文'], archive: ['🧭', '历史归档'], error: ['⚠️', '失败'] }[record.category];
  const detail = (record.detail !== '' ? record.detail : String(record.summary ?? '')) + (record.count > 1 ? ' ×' + record.count : '');
  console.log(`  ${meta[0]} ${meta[1].padEnd(7)} │ ${record.text.padEnd(12)} │ ${detail.slice(0, 74)}`);
}
console.log(`\n=== 分类计数 chips ===`);
console.log('  ' + recordCounts(records).map((e) => `${e.icon}${e.label} ${e.count}`).join('   '));
console.log(`\n=== 折叠的噪声 ===\n  ${noiseLine(rows)}`);

// ── 断言
const byKind = (kind, predicate) => rows.filter((r) => r.kind === kind && (predicate === undefined || predicate(r)));
const mustMap = [
  ...byKind('memory-promote'),
  ...byKind('memory-recall'),
  ...byKind('compartment-published'),
  ...byKind('baseline'),
  ...byKind('emergency-reclaim'),
  ...byKind('historian', (r) => r.level === 'error'),
  ...byKind('tool-call', (r) => ['write', 'update', 'archive', 'merge', 'list', 'get'].includes(r.data?.action)),
];
const unmapped = mustMap.filter((r) => recordOf(r) === null);
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
const promote = records.find((r) => r.text === '记忆提升');
check('promotion 记录带真实条数', promote !== undefined && /新增 \d+/.test(promote.detail), promote?.detail ?? '(无样本)');
const recall = records.find((r) => r.text === '加载记忆');
check('recall 记录带 m[0]/m[1] 条数', recall !== undefined && /m\[0\]/.test(recall.detail), recall?.detail ?? '(无样本)');

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
