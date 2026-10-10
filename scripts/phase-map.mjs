/**
 * The phase map — which specs gate which phase, and what each phase still
 * cannot see.
 *
 * The execution plan requires a stage gate: work may only move to the next
 * phase when the current phase's suite is green. A suite is only a gate if
 * nothing can fall out of it, so this table is asserted against the filesystem
 * (tests/phase-map.spec.ts): every spec in the repository must belong to at
 * least one phase, every path listed here must exist, and every phase must name
 * its blind spots.
 *
 * `blind` is not decoration. A green phase suite that quietly covers nothing is
 * the failure mode this file exists to prevent, so the runner prints the blind
 * list on every run — pass or fail.
 *
 * Phase 0 is the plugin's existing regression suite: everything that shipped
 * before the takeover work. It gates every later phase, because new lanes must
 * not break the old ones.
 */

/** Phase 0: the behaviour that already shipped, before any of the takeover work. */
const PHASE_BASE = [
  'tests/phase-map.spec.ts',
  'tests/client-pure.spec.ts',
  'tests/compaction-engine.spec.ts',
  'tests/compartments.spec.ts',
  'tests/config-schema.spec.ts',
  'tests/context-pressure.spec.ts',
  'tests/embedding-wasm.spec.ts',
  'tests/emergency-drop.spec.ts',
  'tests/historian-chunking.spec.ts',
  'tests/historian-terminal.spec.ts',
  'tests/host-drift-tolerance.spec.ts',
  'tests/journal.spec.ts',
  'tests/maintenance-wiring.spec.ts',
  'tests/maintenance.spec.ts',
  'tests/management-pass-fail.spec.ts',
  'tests/memory-bridge.spec.ts',
  'tests/memory-gate-fence.spec.ts',
  'tests/memory-promotion.spec.ts',
  'tests/memory-retrieval-wiring.spec.ts',
  'tests/memory-scoring.spec.ts',
  'tests/memory-search.spec.ts',
  'tests/memory-tool-bridge.spec.ts',
  'tests/memory-write.spec.ts',
  'tests/phase1.spec.ts',
  'tests/phase2.spec.ts',
  'tests/poc.spec.ts',
  'tests/probe.spec.ts',
  'tests/project-drift.spec.ts',
  'tests/publish-guard.spec.ts',
  'tests/publish-pairing.spec.ts',
  'tests/recomp.spec.ts',
  'tests/reduce-guidance.spec.ts',
  'tests/search-hint-carrier.spec.ts',
  'tests/search-hint.spec.ts',
  'tests/session-notice.spec.ts',
  'tests/store-fusion.spec.ts',
  'tests/tags-retention.spec.ts',
  'tests/telemetry.spec.ts',
  'tests/wire-repair.spec.ts',
]

/** Phase A: the substrate. Contract frozen, adapter schema v8, domains activate. */
const PHASE_A = [
  'tests/contract-freeze.spec.ts',
  'tests/store-schema-v8.spec.ts',
  'tests/domain-import.spec.ts',
  'tests/domain-visibility.spec.ts',
  'tests/memory-delta.spec.ts',
  'tests/memory-sharing.spec.ts',
]

/**
 * Phase B: the `user` domain. Collection and review WRITE the frozen contract
 * and stay behind their own switches (`memory.global.user.collect` / `.review`,
 * both default off), so the specs below use a synthetic contract database.
 */
const PHASE_B = [
  'tests/directive-detect.spec.ts',
  'tests/profile-collection.spec.ts',
  'tests/profile-collection-run.spec.ts',
  'tests/profile-confirmation.spec.ts',
  'tests/profile-render.spec.ts',
  'tests/profile-review.spec.ts',
]

/** Phase C: org/machine domains. Publishing writes the contract. */
const PHASE_C = [
  'tests/org-domain.spec.ts',
  'tests/domain-publish.spec.ts',
  'tests/machine-domain.spec.ts',
]

/** Phase D: the operating loop — commands, telemetry, backfill, drill. */
const PHASE_D = [
  'tests/command-surface.spec.ts',
  'tests/vector-lane.spec.ts',
  'tests/vector-backfill.spec.ts',
  'tests/report-classify.spec.ts',
  'tests/domain-checks.spec.ts',
  'tests/cli-flags.spec.ts',
  'tests/route-health.spec.ts',
  'tests/report-hits.spec.ts',
  'tests/strip-drill.spec.ts',
]

export const PHASES = [
  {
    id: '0',
    title: '0 基线回归（接管前已发布的行为）',
    specs: PHASE_BASE,
    checks: [],
    blind: ['不含接管新增的域/画像/命令车道——那四条见 A–D'],
  },
  {
    id: 'a',
    title: 'A 地基（契约冻结 / schema v8 / 域激活）',
    specs: PHASE_A,
    /** Extra commands that must pass for the gate, run after the specs. */
    checks: [{ label: 'contract freeze', script: 'scripts/mc-contract-freeze.mjs', args: ['verify', '--allow-missing'] }],
    blind: [
      'WP4 共享属性维护已在合成库验证；真库首次共享行更新尚未执行',
      'A-7 双源对照（memory.domains.source=contract 与 adapter 的召回/水位结果一致）**无用例**：'
      + '两条路径都已实现（memory-lane 的 domainSource 分支），但没有测试证明它们等价，'
      + '所以"回滚杠杆"目前只是代码存在而非经过验证',
    ],
  },
  {
    id: 'b',
    title: 'B user 域（画像）',
    specs: PHASE_B,
    checks: [],
    blind: [
      'WP5/WP7 已实现并有用例，但开关默认 off：真机端到端（真实会话产出候选 → 评审 → 注入）尚未跑过',
      'B-8 端到端（合成会话全链路可 journal 回溯）仍缺',
    ],
  },
  {
    id: 'c',
    title: 'C org / machine 域',
    specs: PHASE_C,
    checks: [],
    blind: [
      '三个域都有实现与用例，但真库上只导入过 org 成员（machine 默认 off，user 写侧默认 off）',
      '复现检测在真实语料上是空门（1292 行 / 33 项目 / 0 共享 hash）——见 global-domain-source-finding',
      '真库上尚未发布过任何域行（可见性/退役/改写均在合成契约库上验证）',
      'C-7 产品判据埋点（域命中按"域 × 不同项目数"统计）**无实现**：'
      + '注入侧数据其实已在 journal 的 memory-recall.projects 里（域身份行会出现在该列表），'
      + '但 mc-report / doctor 都没有把它聚合成域命中视图，也没有测试；'
      + '⇒ WP9 的"2 周内无 ≥2 项目命中就停止投入"这条产品判据目前**无法从遥测得出**',
    ],
  },
  {
    id: 'd',
    title: 'D 运维面（命令 / 观测 / 回填 / 剥离演练）',
    specs: PHASE_D,
    checks: [],
    blind: [
      'D-5 剥离演练已做（tests/strip-drill.spec.ts + docs/strip-drill-report-2026-10-10.md）；'
      + '白名单=两条闭环都走完 5 步：org 域（建域→候选→批准→注入→退役）+ user 域（采集→评审→注入→退役）',
      '发布是"复制"而非"镜像"：源行后续改写不传播到域行（报告盲区 2，尚无对账 verify）',
      '四个写开关默认全 off ⇒ 演练证明的是能力闭环，不是线上已开启',
      'WP11 向量回填的真写未执行（开关默认 off）；真库 dry-run 已做（parity 1.000000 PASS）',
      'doctor / mc-acceptance 的域判定已有 hermetic 正负样本（tests/domain-checks.spec.ts），'
      + '但真库采样仍是各一次：阈值与采样量的长期漂移只能靠趋势，不能靠这两条判据',
    ],
  },
]

/** Every spec path the map refers to. */
export function mappedSpecs() {
  return [...new Set(PHASES.flatMap(phase => phase.specs))]
}

export function phaseById(id) {
  return PHASES.find(phase => phase.id === id)
}
