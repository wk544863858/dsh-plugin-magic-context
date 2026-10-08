/**
 * Magic Context — i18n acceptance check (no browser, no DB).
 *
 * The client half is a hand-written bundle with no test runner, so its
 * `__diagnostics` seat is the substitute (the same pattern as
 * `mc-records-check.mjs`). This script pins the two languages end to end:
 *
 *  A. the Host notice copy is English and stays inside the host's 120-char
 *     bound (the browser dictionaries never reach model-visible text);
 *  B. the client dictionaries carry the same keys in zh/en, every key the
 *     source asks for exists, no user-facing Chinese is hardcoded outside the
 *     zh dictionary, and `apply` wires the locale namespace into every slot it
 *     registers.
 *
 * Usage: node scripts/mc-i18n-check.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CJK = /[\u4e00-\u9fff]/

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail !== undefined ? ': ' + detail : ''}`)
}

/* ───────────────────────────── A. Host notice ───────────────────────────── */

console.log('=== 宿主 notice（英文 + 长度上限）===')
const notice = await import(pathToFileURL(join(root, 'src/dsh/session-notice.ts')).href)
const base = {
  published: [],
  forceDropped: 0,
  factsPromoted: 0,
  factsSeenAgain: 0,
  baselineUpdated: false,
  tokensBefore: 1000,
  tokensAfter: 1000,
}

const compartments = notice.sessionNoticeSummary({ ...base, published: [2], tokensAfter: base.tokensBefore - 104146 })
check('published 区段 + 净回收', compartments.includes('compacted 1 compartment')
  && compartments.includes('§C2§') && compartments.includes('reclaimed 104,146 tok'), compartments)
const two = notice.sessionNoticeSummary({ ...base, published: [1, 2], tokensAfter: base.tokensBefore - 1000 })
check('复数形式', two.includes('compacted 2 compartments'), two)
const promoted = notice.sessionNoticeSummary({ ...base, factsPromoted: 9, factsSeenAgain: 2 })
check('记忆提升 + 已知条数', promoted.includes('promoted 9 memories') && promoted.includes('(2 already known)'), promoted)
const dropped = notice.sessionNoticeSummary({ ...base, forceDropped: 3, tokensAfter: base.tokensBefore - 12000 })
check('force-band 丢弃', dropped.includes('emergency-dropped 3 tool outputs') && dropped.includes('reclaimed 12,000 tok'), dropped)
check('无中文残留', [compartments, two, promoted, dropped].every((line) => !CJK.test(line)))
check('baseline-only 仍然静默', notice.sessionNoticeSummary({ ...base, tokensAfter: base.tokensBefore - 500, baselineUpdated: true }) === null)

const many = notice.sessionNoticeSummary({ ...base, published: Array.from({ length: 40 }, (_, i) => i + 1) })
check('120 字符上限', many.length <= notice.NOTICE_SUMMARY_MAX_CHARS && many.endsWith('…'),
  `${many.length} ≤ ${notice.NOTICE_SUMMARY_MAX_CHARS}`)

const appended = []
const outcome = notice.appendSessionNotice({
  session: { append: (type, data, options) => { appended.push({ type, data, options }); return 42 } },
  result: { ...base, published: [3], baselineUpdated: true, tokensAfter: base.tokensBefore - 500 },
})
check('notice 追加成功且文案为英文', outcome.ok === true
  && appended[0].data.content[0].text.includes('compacted 1 compartment')
  && appended[0].data.content[0].text.includes('Baseline refreshed (m[0] frozen point advanced)'),
  appended[0]?.data?.content?.[0]?.text)

/* ──────────────────────────── B. Client half ───────────────────────────── */

console.log('\n=== 客户端字典与接线 ===')
const CLIENT_SOURCE = readFileSync(join(root, 'src/client/index.js'), 'utf8')
let definition = null
const window = { __ModuleLoader__: { load: (def) => { definition = def } } }
new Function('window', CLIENT_SOURCE)(window)
const stubReact = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}
const api = definition.factory((name) => {
  if (name === 'react') return stubReact
  throw new Error('unexpected require: ' + name)
})
const { dictionaryKeys, dictionaryTranslator, recordOf, recordsOf, noiseLine, recordCounts } = api.__diagnostics

const keys = dictionaryKeys()
const drift = keys.zh.filter((k) => !keys.en.includes(k)).concat(keys.en.filter((k) => !keys.zh.includes(k)))
check('zh/en 键集合一致', drift.length === 0, drift.length ? drift.join(', ') : `${keys.zh.length} keys`)

// Every key the source asks for must exist in both dictionaries. `t('detail.verb.' + action)`
// is a dynamic family, so a key ending in '.' is resolved against the verb actions instead.
const asked = new Set()
const dynamic = new Set()
for (const match of CLIENT_SOURCE.matchAll(/\bt\(\s*'([^']+)'(\s*\+)?/g)) {
  if (match[2] !== undefined || match[1].endsWith('.')) dynamic.add(match[1])
  else asked.add(match[1])
}
const missing = [...asked].filter((key) => !keys.zh.includes(key) || !keys.en.includes(key))
check('源码引用的键全部已定义', missing.length === 0, missing.length ? missing.join(', ') : `${asked.size} keys`)
const verbMissing = ['write', 'update', 'archive', 'merge', 'list', 'get', 'search']
  .map((action) => 'detail.verb.' + action)
  .filter((key) => !keys.zh.includes(key) || !keys.en.includes(key))
check('动态键族 detail.verb.* 全部已定义', dynamic.has('detail.verb.') && verbMissing.length === 0,
  verbMissing.length ? verbMissing.join(', ') : [...dynamic].join(', '))

// No user-facing Chinese outside the zh dictionary (comments excluded).
const zhStart = CLIENT_SOURCE.indexOf('zh: {')
const enStart = CLIENT_SOURCE.indexOf('\n      en: {')
const withoutZh = CLIENT_SOURCE.slice(0, zhStart) + CLIENT_SOURCE.slice(enStart)
const withoutComments = withoutZh.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
check('字典之外没有硬编码中文', !CJK.test(withoutComments),
  (withoutComments.match(new RegExp(CJK.source, 'g')) || []).length + ' 处')

const en = dictionaryTranslator('en')
const zh = dictionaryTranslator('zh')
check('插值生效', en('records.folded', { n: 3 }) === '×3' && zh('records.folded', { n: 3 }) === '3 次'
  && en('detail.added', { n: '9' }) === 'added 9')
check('未知键回退为键名', en('nope.missing') === 'nope.missing')

const events = [
  { kind: 'pass', at: 1, summary: '', data: { decision: 'execute', tokensDelta: -70700, pressure: 71 } },
  { kind: 'memory-promote', at: 2, summary: '', data: { inserted: [1, 2, 3], seenAgain: [4], skipped: [5] } },
  { kind: 'tool-call', at: 3, summary: '', data: { action: 'write', ok: false, ms: 135 } },
  { kind: 'compartment-published', at: 4, summary: '', data: { nodes: 12, estTokensReclaimed: 9000 } },
  { kind: 'baseline', at: 5, summary: '', data: { mode: 'hard', bytes: 2048, estTokens: 512 } },
  { kind: 'emergency-reclaim', at: 6, summary: '', data: { dropped: 3, reason: 'pressure' } },
  { kind: 'drop-landed', at: 7, summary: '', data: { count: 4, estTokens: 1200 } },
  { kind: 'historian', at: 8, summary: '', data: { phase: 'stored', compartmentId: 3, facts: 9, nodes: 2, durationMs: 9700 } },
  { kind: 'historian', at: 9, summary: '', data: { phase: 'failed', reason: 'timeout' } },
  { kind: 'maintenance', at: 10, summary: '', data: { expired: 1, verified: 2, updated: 1 } },
  { kind: 'boot', at: 11, summary: '' },
]
const zhRecords = recordsOf(events, zh)
const enRecords = recordsOf(events, en)
check('每个分支都有记录（boot 为噪声）', zhRecords.length === events.length - 1, `${zhRecords.length} 行`)
check('英文渲染无中文残留', enRecords.every((r) => !CJK.test(r.text + r.detail)),
  enRecords.filter((r) => CJK.test(r.text + r.detail)).map((r) => r.text).join(', ') || `${enRecords.length} 行`)
check('中文渲染与旧文案一致', zhRecords[0].text === '执行回收' && zhRecords[0].detail.includes('−70.7k tok')
  && zhRecords[8].text === '历史归档失败')
check('英文标题正确', enRecords[0].text === 'Reclaim pass' && enRecords[3].text === 'Context compacted'
  && enRecords[7].text === 'Compartment stored' && enRecords[9].text === 'Maintenance sweep',
  enRecords.map((r) => r.text).join(' | '))

const noise = noiseLine([
  { kind: 'memory-recall' },
  { kind: 'memory-recall' },
  { kind: 'baseline', data: { mode: 'soft' } },
  { kind: 'baseline', data: { mode: 'hard' } },
], en)
check('噪声行英文 + 只数 soft 基线', noise === 'memories loaded ×2 · baseline refreshed ×1', noise)
check('分类计数标签跟随语言',
  recordCounts(enRecords, en).every((chip) => chip.label !== undefined && !CJK.test(chip.label))
  && recordCounts(zhRecords, zh).every((chip) => CJK.test(chip.label)),
  recordCounts(enRecords, en).map((chip) => `${chip.icon}${chip.label} ${chip.count}`).join('  '))

// `apply` wiring: namespace registration, locale on every slot, label thunks.
const registrations = []
const registered = []
const fakeCtx = {
  locale: {
    register: (ns, dicts) => { registered.push({ ns, dicts }); return () => {} },
    bind: () => en,
  },
  effect: (fn) => fn(),
  slots: { inject: (_seat, fn) => fn(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
  inject: (deps, fn) => fn({
    effect: (inner) => inner(),
    configForms: {
      get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({}) }),
      whileServed: (_ns, fn) => { fn(); return () => {} },
    },
  }),
}
api.apply(fakeCtx)
check('注入 locale 服务', api.inject.includes('locale') && api.inject.includes('slots'), api.inject.join(','))
check('注册 magic-context 命名空间（zh+en）', registered.length === 1 && registered[0].ns === 'magic-context'
  && registered[0].dicts.zh !== undefined && registered[0].dicts.en !== undefined)
check('每个槽位注册项都声明 locale', registrations.length >= 3 && registrations.every((entry) => entry.options.locale === 'magic-context'),
  registrations.map((entry) => entry.options.name).join(', '))
const labelled = registrations.filter((entry) => typeof entry.options.label === 'function')
check('槽位 label 为跟随语言的 thunk', labelled.length >= 1 && labelled.every((entry) => !CJK.test(entry.options.label())),
  labelled.map((entry) => entry.options.label()).join(' | '))
check('两个渲染槽位都拿到组件', registrations.some((entry) => entry.component !== undefined && entry.options.name === 'conversation.composer.dock'))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
