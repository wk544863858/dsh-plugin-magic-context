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
  'tests/compaction-conflict.spec.ts',
  'tests/compartments.spec.ts',
  'tests/config-schema.spec.ts',
  'tests/global-autostage.spec.ts',
  'tests/global-review.spec.ts',
  'tests/context-pressure.spec.ts',
  'tests/ctx-reduce-render.spec.ts',
  'tests/embedding-wasm.spec.ts',
  'tests/emergency-drop.spec.ts',
  'tests/historian-chunking.spec.ts',
  'tests/historian-terminal.spec.ts',
  'tests/host-drift-tolerance.spec.ts',
  'tests/journal.spec.ts',
  'tests/live-journal.spec.ts',
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

/** Phase A: the substrate. Own corpus (v95 lineage), adapter schema v9, domains activate. */
const PHASE_A = [
  'tests/corpus-store.spec.ts',
  'tests/corpus-version-invariant.spec.ts',
  'tests/store-schema-v8.spec.ts',
  'tests/domain-visibility.spec.ts',
  'tests/memory-delta.spec.ts',
  'tests/memory-sharing.spec.ts',
]

/**
 * Phase B: the `user` domain. Collection and review WRITE the own corpus
 * and stay behind their own switches (`memory.global.user.collect` / `.review`,
 * both default off), so the specs below use a synthetic corpus database.
 */
const PHASE_B = [
  'tests/directive-detect.spec.ts',
  'tests/profile-collection.spec.ts',
  'tests/profile-collection-run.spec.ts',
  'tests/profile-confirmation.spec.ts',
  'tests/profile-render.spec.ts',
  'tests/profile-review.spec.ts',
]

/** Phase C: org/machine domains. Publishing writes the corpus. */
const PHASE_C = [
  'tests/org-domain.spec.ts',
  'tests/domain-publish.spec.ts',
  'tests/machine-domain.spec.ts',
  // "publishing is a copy, not a mirror": the audit of published domain rows
  // against the memories they were promoted from (2026-10-16).
  'tests/domain-reconcile.spec.ts',
]

/** Phase D: the operating loop — commands, telemetry, backfill, drill. */
const PHASE_D = [
  'tests/command-surface.spec.ts',
  'tests/config-switches.spec.ts',
  'tests/vector-lane.spec.ts',
  'tests/vector-backfill.spec.ts',
  'tests/report-classify.spec.ts',
  'tests/domain-checks.spec.ts',
  'tests/profile-checks.spec.ts',
  'tests/cli-flags.spec.ts',
  'tests/route-health.spec.ts',
  'tests/report-hits.spec.ts',
  'tests/historian-pairing.spec.ts',
  'tests/baseline-stability.spec.ts',
  'tests/report-dilution.spec.ts',
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
    title: 'A 地基（自有语料 / schema v9 / 域激活）',
    specs: PHASE_A,
    /** Extra commands that must pass for the gate, run after the specs. */
    checks: [],
    blind: [
      'WP4 共享属性维护已在合成库验证；真库共享行更新已执行（2026-10-10 org #1420→#1431、10-13 #1528 现行；machine #1527 误归域已归档迁 org）',
      'A-7 双源对照随契约源退役（2026-10-13 corpus 切换）：域激活唯一来源=adapter 表，'
      + '契约源与回滚杠杆一并删除——现世界无"切换动作"可演练',
    ],
  },
  {
    id: 'b',
    title: 'B user 域（画像）',
    specs: PHASE_B,
    checks: [],
    blind: [
      'WP5/WP7 已实现并有用例；开关线上实况（2026-10-13）：collect=on、review=on（13:15 重启生效）；'
      + '渲染半边已活（profile-recall 每步注入 14 行）——真机端到端（真实会话产出候选 → 评审 → 注入）**已跑通**：'
      + '2026-10-14 21:32 采集 5 条观察 → 21:34 评审晋升 4 行（ids 18–21）、meta profile_last_review_at 写入，'
      + '22:00 起 m[1] <new-user-profile> 收到 4 new（watermark 17 → currentMaxId 21）',
      'B-8 端到端（合成会话全链路可 journal 回溯）仍缺',
    ],
  },
  {
    id: 'c',
    title: 'C org / machine 域',
    specs: PHASE_C,
    checks: [],
    blind: [
      '三个域都有实现与用例；真库上 org 5 成员、machine 11 成员且 machine 已 enabled+autoStage（2026-10-12 裁决开；11 成员＝2026-10-17 新项目 service-a 导入，成员随项目导入自动增长），user 写侧 collect=on、review=on（10-13 生效）',
      '复现检测在真实语料上是空门（1941 行 / 39 项目 / 0 共享 hash，剔除域行副本口径；2026-10-16 实测）——见 global-domain-source-finding',
      '真库已发布域行（org：17 现行 + 1 归档，含 2026-10-10 #1431 与 10-13 #1528、10-16 #1420 按批准复活；machine：3 现行 + 1 归档，'
      + '#1527 误归域已归档迁 org）；跨项目真实注入已发生——域命中 14d（2026-10-17 08:00）：machine 52 次/8 读者、org 9 次/1 读者',
      'C-7 产品判据埋点已落地（scripts/report-hits.mjs + mc-report「域命中(14d)」行 + tests/report-hits.spec.ts）；'
      + '剩余盲区=观察期未满：org 域 2026-10-10 启用、14 天窗到 2026-10-24，期间域命中=0 属"未起算"，'
      + 'WP9 判据（<2 读取项目 ⇒ 停止投入）到 10-24 才能出结论',
    ],
  },
  {
    id: 'd',
    title: 'D 运维面（命令 / 观测 / 回填）',
    specs: PHASE_D,
    checks: [],
    blind: [
      'D-5 剥离演练随 2026-10-13 corpus 切换退役（前提"保护共享库"消失；现世界=corpus 自包含，'
      + '卸载即带走/删除 memories.db，无第三方库可损）；白名单=两条闭环都走完 5 步：'
      + 'org 域（建域→候选→批准→注入→退役）+ user 域（采集→评审→注入→退役）',
      '发布是"复制"而非"镜像"：源行改写不传播到域行——该对账语义随 domain-source-parity.spec '
      + '（契约源对照）一并退役后，由 memory-gate-fence.spec 的"改写/归档源行不传播"用例继续钉住；'
      + '域行更新只能走产品路径（新候选→发布→归档旧行），没有镜像修复',
      '写开关线上实况（2026-10-13）：user.collect=on、review=on（13:15 生效）、vectorBackfill=on（已收口）、'
      + 'machine.enabled+autoStage=on——画像评审首轮已于 2026-10-14 21:34 跑通（晋升 4），'
      + '演练与线上的差距只剩"域命中观察窗未满"；'
      + '2026-10-12 起 vectorBackfill 缺省=true（分发默认可用，显式 false 才关），'
      + 'profile 需逐键重复的"必须为 true"清单收缩为 scoring/collect',
      'WP11 向量回填已真写并收口（2026-10-10 09:52 开启 → 15:19 dominant 100%）；'
      + '残余特性：缺口随新晋升行回升、靠 30 分钟维护拍清理，机器空闲时段不补跑',
      'doctor / mc-acceptance 的域判定已有 hermetic 正负样本（tests/domain-checks.spec.ts），'
      + '真库采样已积累（候选 21 批准 / 8 拒绝 / 0 待定、域注入 26 次）：阈值与采样量的长期漂移仍只能靠趋势，不能靠这两条判据',
      'profile 依赖卫生判据（tests/profile-checks.spec.ts，2026-10-11 启动失败后加）是静态检查：'
      + '只看 profile 根 node_modules/@deepseek-ai/（Node 真能解析到的位置），看不到 .pnpm 内部未提升的副本；'
      + '宿主包清单读不到时（app.asar 不可达）dependencies 一项降级为 WARN，不冒充绿灯',
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
