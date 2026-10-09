# 上游 `hooks/` 机制覆盖摸排（2026-10-08）

**问题**：上游 Magic Context 的 `packages/plugin/src/hooks/` 下还有哪些机制我们没有移植？

**样本**：`packages/plugin/src/hooks/magic-context/`（142 个非测试模块）+ `auto-update-checker/`（6 个）
= **148 个模块**。只有 OpenCode 宿主有 `src/hooks/`（`packages/pi-plugin` 无此目录，Pi 走
`pi.on("context")`）。

**方法**（三路交叉，避免单一判断）：

1. **逐模块人工分类**（4 个并行子代理按机制簇分片：transform/wire、historian/compartment、
   module/lkg/refusal、auto-update/misc）。每行给出：作用、分类、我们的实现或缺口说明。
2. **独立名字交叉信号**：对每个上游模块名在我们 `src/**` 里做词命中统计
   （`<tmp>/hooks-crosstab.mjs`，只读）。152 个模块中**仅 13 个零命中**——
   这些是最可疑的"缺口或宿主专有"。
3. **我方实现清单**：`packages/dsh-plugin/src/**`共 31 个模块（下表），用于核对"已移植"。

**分类口径**（与 `PARITY.md` 一致）：

| 分类 | 含义 |
|---|---|
| `ported` | 机制已在本适配器实现（可能换了名字/换了宿主手段） |
| `host-imposed` | 因宿主不同**不适用**（OpenCode 的 message parts、Rust module 桥、served/cache-bust 模型、OpenCode 自身 session 库等） |
| `internal` | 上游自己的管道/夹具，没有对应的用户可见机制 |
| `GAP` | 我们确实缺的机制 |

## 1. 我方实现清单（31 模块，判断"已移植"的基准）

| 行数 | 模块 | 用途（首句） |
|---|---|---|
| 606 | `src/index.ts` | 适配器入口与装配（preStep/工具/面板/journal） |
| 517 | `src/dsh/seams.ts` | **DSH 接触面**：surface 枚举、range replace、span 回放、合成节点 source |
| 612 | `src/dsh/management-pass.ts` | execute 档的全部动作（发布 compartment、刷新 baseline、应急） |
| 807 | `src/dsh/historian.ts` | historian：span 选择、分块、预算、校验、落库 |
| 692 | `src/dsh/tool-bridge.ts` | `ctx_reduce`/`ctx_expand`/`ctx_memory`/`ctx_search` 工具面 |
| 469 | `src/dsh/pre-step.ts` | real-user-turn 计数、project-drift、每回合登记、pass 触发 |
| 295 | `src/dsh/memory-lane.ts` | `config.memory` ↔ 共享库之间的全部逻辑（含向量一致性证明） |
| 252 | `src/dsh/reduce-guidance.ts` | Channel1/2 代理引导（阈值照抄上游） |
| 313 | `src/dsh/compaction-engine.ts` | DSH `ctx.compaction` 接缝（手动 checkpoint/压力） |
| 125 | `src/dsh/session-notice.ts` | 通道 A：往会话流写一行折叠通知 |
| 115 | `src/dsh/emergency.ts` | 应急回收（保护窗 + 工具分层） |
| 120 | `src/dsh/project-drift.ts` | 跨项目漂移观测 |
| 98 | `src/dsh/status-command.ts` | `/ctx-status` |
| 432 | `src/dsh/telemetry.ts` | 面板遥测（health/节拍/操作记录） |
| 119 | `src/dsh/config.ts` | 配置契约 |
| 108 | `src/dsh/maintenance-wiring.ts` | 维护 tick 的排程 |
| 68 | `src/dsh/volatile.ts` | volatile 引用读取 + 决策点解析 |
| 53 | `src/dsh/context-pressure.ts` | 占用读数节流 |
| 972 | `src/core/memory-bridge.ts` | 共享 `context.db` 读路径 + fence（`MEMORY_SCHEMA_MAX_VERSION`） |
| 1325 | `src/core/memory-write.ts` | 写路径（契约动作、authority、mutation log） |
| 526 | `src/core/memory-search.ts` | `ctx_search` 混合检索（FTS5 + 向量融合） |
| 752 | `src/core/stores.ts` | 适配器自有库（journal/compartments/baseline/drops） |
| 507 | `src/core/compartments.ts` | compartment 模型 + tier 近似 + 占位符 |
| 327 | `src/core/journal.ts` | 活动 journal + 挂载自愈 |
| 279 | `src/core/maintenance.ts` | 维护 tick（TTL 归档 + verify 批量） |
| 158 | `src/core/embedding-local.ts` | 本地 MiniLM embedding |
| 130 | `src/core/policy.ts` | 压力策略与 pass 决策 |
| 83 | `src/core/memory-categories.ts` | MC 记忆分类表（逐字复制） |
| 66 | `src/core/types.ts` | 中性词汇 |
| 17 | `src/core/tagger.ts` | §N§ 标签分配 |
| 1755 | `src/client/index.js` | 浏览器半侧（面板/胶囊/词典） |

## 2. 第一手确认的"零命中"模块判定（13 个）

这 13 个在上游模块名与我们的 `src` 之间**没有任何词命中**，逐个读过头部后判定如下：

| 上游模块 | 实际作用 | 判定 |
|---|---|---|
| `hook.ts` | OpenCode 插件入口装配：dreamer 执行器、compaction handler、打开 OpenCode DB | `host-imposed`（宿主装配层；我们的对应物是 `src/index.ts`） |
| `hook-handlers.ts` | 各 hook 的处理体（dreamer verify 读上限、reasoning watermark 清理等） | `host-imposed` |
| `read-session-db.ts` / `read-session-raw.ts` | 读 OpenCode 自己的 session 库（gap healing、raw message 分类） | `host-imposed`（DSH 的 surface 由 `session.snapshotEvents()` 提供） |
| `auto-update-checker/*`（含 `checker.ts`/`semver.ts`） | 插件自我更新检查（对比 npm 版本、semver、缓存） | `host-imposed`（分发方式不同；DSH 适配器随仓库走） |
| `todo-view.ts` | 合成一个**假的 `todowrite` 工具 part** 注入最新 assistant 消息（借用 OpenCode 的 todo 心智模型） | `host-imposed`（DSH 有原生 todo 工具与 UI） |
| `note-nudger.ts` | `ctx_note` 的状态机提醒（historian 完成后/提交后触发） | **产品决策**（desk 段已明确去掉 `ctx_note`，见 PARITY §C/§D） |
| `tail-hygiene-walk.ts` | 尾部卫生遍历：按 tag 归属、受保护 tag 等度量可读尾部 | `ported`（改判见 §3.4-5：`pre-step.ts:437-454` 尾部度量 + `reduce-guidance.ts:57` 频段；无冻结前缀比对） |
| `heuristic-cleanup.ts` | 启发式清理：工具丢弃 + caveman + calibration 组合 | `ported`（改判见 §3.4-5：紧急带 `management-pass.ts:512` + 剥注入 `compartments.ts:405`；**无去重**，caveman/calibration 仍属 §C） |
| `recomp-orchestrator.ts` | **重压缩**（`/ctx-recomp`）：全量/区间重压 + staging 提升 | `GAP` —— 本报告唯一 P1（见 §4） |
| `wrapup-orchestrator.ts` | **收尾**（`/ctx-wrapup`）：lease、进度、受保护尾部边界 | `ported`（能力子集，改判见 §3.4-4：`/compact` → `selectManualRange` → `callHistorian` → 检查点） |
| `lkg-slot.ts`（及 `lkg-*` 共 5 个） | last-known-good：捕获/回放"上一次可用的线材状态"，用于崩溃后恢复 | `host-imposed`（结构性不必要，改判见 §3.4-1） |

> 关联证据：`child-session-spawn.ts` 里出现 `FAIL_CLOSED_DOCTOR_COMMAND` 与
> `SCHEMA_PROBE_FAILURE_NOTICE`——上游在**生成子会话前先探测 schema fence**，失败则拒并指向上游
> `doctor`。这解释了上一轮"doctor 值不值得参考"的答案：它是**fail-closed 链路的一环**，不只是
> 诊断工具。

## 3. 逐模块分类

四路分片（transform/wire、historian/compartment、module/lkg/refusal、auto-update/misc）。为可读性按
**分类聚合**而不是按上游文件顺序铺开：真缺口逐行列出，已移植给对应实现，宿主专有/内部只列举名字
（它们的共性是"换了宿主就不存在"）。

### 3.1 `GAP` —— 确认缺失的机制

| 上游文件 | 作用 | 缺口说明 |
|---|---|---|
| `recomp-orchestrator.ts` + `compartment-runner-recomp.ts` + `compartment-runner-partial-recomp.ts` | 重压缩（全量/区间，staging 提升、区间吸附） | **最实的缺口**：我们的手动范围把 `covered.has(node.seq)` 明确列为 skippable（`compaction-engine.ts:299-305`）→ **已压过的历史永远不重做**，没有 `/ctx-recomp`。三文件同一特性，`grep recomp` 在 `dsh-plugin` 零命中 |
| `command-handler.ts` | 斜杠命令分发 | 只有 `/ctx-status`（`status-command.ts:30`）；无 recomp / manual dream（wrapup 见 §3.4-4） |
| `auto-search-hint.ts` + `auto-search-runner.ts` | 主动检索提示 | 无逐轮"你可能记得相关的东西"提示（上游把检索结果压成 ≤200 token 附加到用户消息）；我们靠 m[0] digest + desk 段（`pre-step.ts:213`） |
| `reference-retrieval.ts` + `reference-seeds.generated.ts` + `.source.xml` | historian 打分锚点（60 条） | `historian.ts:208` **只有指令、没有标定样例** → importance 校准弱，连带影响 tier/衰减/提升 |
| `tokenizer-calibration.ts` + seeds、`decision-calibration.ts`、`image-token-estimate.ts` | 按模型标定 token 比 / 图像计价 | 固定 `chars/4`（`core/compartments.ts:59`、`historian.ts:18`）；图片重的会话被低估（`pre-step.ts:437` 只数文本） |
| `edit-marker.ts` | 裁剪老 `edit`/`write` 巨型 diff 入参 | 只回收 tool/result 内容（`management-pass.ts:487`），不改 tool-call 入参；受 §B4 限制，要做须先确认宿主是否允许改写 assistant 内容 |
| `tool-reclaim.ts` | 按水位自动回收 | **已读全文核实**：`buildSyntheticToolReclaimOps`（`:12-48`）对"活跃 tag 编号 ≤ watermark 且可回收 ≥ `AGE_RECLAIM_MIN_TOKENS`"自动生成 drop，并 `advanceToolReclaimWatermarkToCurrentMax` 推进水位（`:50-57`）。我们只有模型 stamp + force 带（`management-pass.ts:476/509`）。注意与"宿主级 `auto_drop_tool_age` 已废弃"**不是同一机制** |
| `drop-stale-reduce-calls.ts` | 剥离陈旧 reduce 调用 | 不剥离旧的 `ctx_reduce` 工具部件，只替换结果内容（`seams.ts:174`） |
| `supersession-reclaim.ts` | 失效控制面结果回收 | 无 `ctx_note`/`bash_status` 控制面；工具结果只随 §N§ stamp 回收 |
| `tool-sweep-policy.ts` | sweep 变体采纳条件 | 无 double-sweep 采纳 |
| `unmanaged-over-window.ts` | 未托管超窗发送前拒绝 | 靠 provider 拒绝 + emergency 兜底（§D）；**分片判定冲突**，裁定见 §3.4-3 |
| `degraded-pass-refusal.ts` + `pass-outcome.ts` | 降级 pass 拒绝 + 阶段效果台账 | 我们 fail-open（`pre-step.ts:389`）；上游语义是"依赖阶段失败就别服务这一轮"，与 lkg 同子系统。**DSH 结构性豁免**见 §3.4-1 |
| `historian-no-fire-cause.ts` | 未触发原因词表 | 只有 below-trigger 有日志（`historian.ts:752`），其余静默返回 → **观测缺口**（§E 关注项） |
| `producer-window-guard.ts` | 生产者窗口准入 | 跨度按窗口 5%（≤50k）分块（`historian.ts:133/380`），但**单节点超窗的原子截断未实现** |
| `user-profile-render.ts` | 用户档案渲染 | 无 user 作用域记忆/档案块（召回过滤 `memory-bridge.ts:422`） |
| `compaction-off-transition.ts` | 压缩关闭迁移 + 建议 wrapup | 无状态明示与 wrapup 建议 |
| `note-nudger.ts` + `note-visibility.ts` | `ctx_note` 提醒/可见性 | **产品决策**：desk 段已去掉 `ctx_note`（有意偏差） |

### 3.2 `ported` —— 已移植（按机制簇聚合；三片合并）

| 机制簇 | 上游文件 | 我们的实现 |
|---|---|---|
| 装配/接缝 | `hook.ts`、`hook-handlers.ts`、`magic-context/index.ts`、`transform.ts`、`event-handler.ts` | `index.ts:94/156/193`；决策落 `agent/pre-step`（`pre-step.ts:75`），§B1 无 `output.messages` 改写 |
| reduce 引导 | `ctx-reduce-nudge.ts`、`channel2-cycle.ts`、`channel2-delivery.ts` | 阈值照抄 `reduce-guidance.ts:57/79/115/135`；载体是**追加 reminder**而非 synthetic user message（§B1/§B3） |
| 尾部度量 | `tail-hygiene-walk.ts` | 未打标/尾部 token 度量（`pre-step.ts:437-454`）+ 频段判定（`reduce-guidance.ts:57`）；**无冻结前缀比对** |
| execute 档 | `cache-busting-signals.ts`、`fold-execution-gate.ts`、`apply-operations.ts`、`execute-flush.ts`、`heuristic-cleanup.ts` | `core/policy.ts:95`、`management-pass.ts:461/476/512`；`heuristic-cleanup` → 紧急带 + 剥注入（`compartments.ts:405`），**无去重** |
| 丢弃/回收 | `tool-drop-target.ts`、`dropped-token-estimate.ts`、`emergency-drop.ts` | `seams.ts:174/200`、`management-pass.ts:499`、`emergency.ts:72` |
| m[0]/m[1] 注入 | `inject-compartments.ts`、`compartment-render-epoch.ts` | `core/compartments.ts:199/294` + `refreshBaseline`（`management-pass.ts:304`）；渲染 epoch 以 baselineState 摘要 + 字节比对近似（`:336/398`） |
| 打标 | `tag-messages.ts`、`tag-content-primitives.ts`、`tag-part-guards.ts` | `seams.ts:78/200/329`、`core/tagger.ts:15`；用户/文件打标按 §B2 有意移除 |
| historian/compartment | `compartment-parser.ts`、`compartment-prompt.ts`、`compartment-runner.ts`、`-incremental`、`-historian`、`-validation`、`-drop-queue`、`compartment-trigger.ts`、`historian-prompt.generated.ts` | `historian.ts:108/160/183/208/298/435/721`、`core/compartments.ts:468`、`management-pass.ts:229/461/512`。多套 runner 的差异**是实现方式**：我们"扫描定区间 + 整段替换"替代"模型报区间 + 逐条入队"；`-validation` 的失败关闭语义已有 |
| 衰减档位 | `decay-curve.ts` | 四档近似 `core/compartments.ts:68`（§C 记精确曲线不移植） |
| 用量/水位/持久化 | `transform-context-state.ts`、`transform-message-helpers.ts`、`transform-postprocess-phase.ts` | `pre-step.ts:105/171/223`、`stores.ts:24` |
| 拒绝家族 | `single-store-refusal.ts`、`store-ahead-refusal.ts`、`storage-busy-refusal.ts` | authority 让位（`memory-write.ts:745`）、fence→只读（`:612`）、busy_timeout + 结构化拒绝（`:579/538`） |
| 通知/状态/引导注入 | `send-session-notification.ts`、`execute-status.ts`、`system-prompt-hash.ts` | `session-notice.ts:104`、`status-command.ts:30`、`pre-step.ts:420` |
| 配对不变式 | `openai-compat-adjacency.ts` | 强制执行而非只断言：`historian.ts:187`（span 边）+ `seams.ts:433`（回放边，commit `c5f51308c`） |
| 收尾 | `wrapup-orchestrator.ts` | `compaction-engine.ts:125/260-272`：`/compact` → `selectManualRange` → `callHistorian` → 写检查点。**能力子集**：无 lease/进度/受保护尾边界，且跳过已覆盖节点（裁定见 §3.4-4） |
| 宿主层边界修复 | `history-boundary-repair.ts`、`unresolved-history-boundary.ts`、`shared-compartment-boundaries.ts`、`legacy-compartments.ts` | DSH 日志不丢行（§B1）；无位置可替换的 compartment 直接标记落地（`management-pass.ts:206`） |

### 3.3 `host-imposed` / `internal` —— 换了宿主就不存在（四片合并，约 90 个）

按"为什么不需要"分组：

- **OpenCode message parts 手术**：`strip-content`、`strip-structural-noise`、`system-injection-stripper`、
  `reasoning-removal`、`sentinel`（空块过滤）、`text-complete`、`todo-view`、`empty-task-output`、
  `stripped-command`、`persist-filtered-noise`、`tag-part-guards`、`tag-id-fallback`、`transform-operation` 相关。
  上游必须在 `output.messages` 里改部件；DSH 的线材由日志推导、内容块只有文本/工具调用
  （`seams.ts:335`），§B1/§B2/§B4 已裁定不改宿主节点。
- **OpenCode 会话库与原始序数**：`read-session-db`、`read-session-raw`、`read-session-chunk`、
  `read-session-true-raw-tokens`、`read-session-formatting`、`shared-compartment-boundaries`、
  `protected-tail-boundary`、`context-limit-resolution`、`raw-fallback-context-limit`、
  `history-boundary-repair`、`unresolved-history-boundary`、`legacy-compartments`、`m0-token-breakdown`。
  DSH 只看 surface 节点（`seams.ts:358`）与宿主投影/计费行（`context-pressure.ts:37`）。
- **ck-mc 模块与 Rust 引擎**：`module-*`（6）、`rust-*`（5）、`maintenance-authority`、
  `historian-host-runner`、`host-served-rows`。本机没有该守护进程/引擎，直接读写 SQLite（§B8）。
- **OpenCode 宿主钩子与权限面**：`request-hook-order`、`ctx-reduce-availability`、`dropped-input-guard`、
  `tool-input-size`、`spawn/todowrite permission` 系列。DSH 单一 seam + content-only 改写。
- **分发/自更新**：`auto-update-checker/*`（6）。随仓库分发，无 npm 缓存树/`opencode.json`/TUI toast。
- **实验特性与宿主时钟**：`temporal-awareness`、`temporal-served-projection`、`live-session-state`。
  `SurfaceNode` 无墙钟（`seams.ts:275`），且依赖 LKG 槽。
- **上游内部管道与夹具**：`event-payloads`、`transform-operations`、`transform-stage-logger`、
  `compartment-runner-types`/`-mapping`、`historian-prompt.source.md`、`historian-prompt-fit`、
  `historian-publish-stage-logger`、`embed-session-state`、`format-bytes`/`format-embed-*`、
  `postprocess-read-cache`、`producer-window-test-support`、`default-protection-pressure.test-support`、
  `opencode-v1-store-fixture`、`issue-135`/`issue-423`/`issue-424` 夹具、`__fixtures__/*`。

> 说明：`historian-expand-tools.ts` 在上游只有 `.test.ts`，不计入；`auto-search-deadline.ts`（3s 截止
> 包装）归 internal（本侧无该 lane）。

### 3.4 Lead 复核裁定（分片冲突与初判修正，5 条）

1. **`lkg-*`（5 个）：分片判 `GAP` → 裁定 `host-imposed`（结构性不必要）**。依据已读上游
   `degraded-pass-refusal.ts:4-11`：LKG 的前提是"线材是可被半途改写、可能丢的投影"——关键阶段失败时
   宁可重放上次好请求或拒绝该轮，也不服务退化线材。DSH 线材由 append-only 日志推导（§B1），
   pass 失败=没追加=线材不变，"恢复上次好请求"没有对象（也不需要 `lkg_slots`）。**观察项**：若将来
   引入"就地改写已落地消息"的旁路，此前提重新成立。
2. **`embed-history-runner` / `embed-session-state` / `format-embed-*`：`GAP` → 产品决策/内部**。
   分室向量回填已在 §C/§D 明确不移植且默认关（`memory-lane.ts:106` 只做 memory 向量车道），
   不重复计入缺口。
3. **`unmanaged-over-window.ts`：分片 C 判 `GAP`、分片 D 判 `host-imposed` → 保留为 `GAP`（低优先）**。
   §D 记录的是"provider 拒绝后回收重试"，那是**事后**路径而非等价的发送前守门；本轮修 400 孤儿
   `tool_result` 的经历说明"让 provider 拒绝"的用户可见代价真实存在。故保留在 §3.1，但降到 P3。
4. **`wrapup-orchestrator.ts`：分片 B 判 `ported`、Lead 初判 `GAP` → 裁定 `ported`（能力子集）**。
   已核实 `writeCheckpoint` 真的调用 `callHistorian`（`compaction-engine.ts:125`），所以
   `/compact` → `selectManualRange` → 检查点，等价于"用户要求把剩余历史摘要掉"。缺的只是 lease
   （单进程不需要）、进度上报、受保护尾边界解析。**从 §4 P1 移除**。
5. **`tail-hygiene-walk.ts` / `heuristic-cleanup.ts`：Lead 初判 `GAP` → 改判 `ported`**（对应物：
   `pre-step.ts:437-454` 尾部度量；`management-pass.ts:512` 紧急带 + `compartments.ts:405` 剥注入）；
   同批把 `history-boundary-repair` / `unresolved-history-boundary` / `legacy-compartments` 改判
   `host-imposed`（DSH 日志不丢行，§B1）。


## 4. 真缺口清单（按"用户可见收益 ÷ 成本"排序，第一手证据）

| 优先级 | 缺口 | 上游文件 | 影响 | 粗估 |
|---|---|---|---|---|
| ✅ 已实现 | **`/ctx-recomp` 重压缩** | `recomp-orchestrator.ts`、`compartment-runner-recomp.ts`、`compartment-runner-partial-recomp.ts`、`command-handler.ts:92` | 落地于 §6：`src/dsh/recomp.ts` + `stores.replaceCompartmentDraft` + `seams.nodesForSeqs`；命令 `all`/`last:<n>`/`<start>-<end>`（按 compartment 吸附） | 完成 |
| P2 | **historian 打分锚点** | `reference-retrieval.ts` + `reference-seeds.generated.ts`（60 条） | prompt 只有指令、无标定样例 → importance 校准弱，连带 tier/衰减/提升 | 0.5–1 天（数据 + 提示词接线） |
| P2 | **主动检索提示** | `auto-search-hint.ts`、`auto-search-runner.ts`（3s 截止包装） | 用户可感知的回忆质量：把检索结果压成 ≤200 token 的模糊提示，促使 agent 自己 `ctx_search` | 1 天 |
| P2 | **按模型 token 标定 + 图像计价** | `tokenizer-calibration.ts` + seeds、`decision-calibration.ts`、`image-token-estimate.ts` | 预算/触发阈值精度；图片重的会话被低估（现固定 `chars/4`） | 1.5 天 |
| P3 | **水位自动回收 + 陈旧调用剥离** | `tool-reclaim.ts`、`drop-stale-reduce-calls.ts` | 无人干预时按 watermark 自动回收旧工具输出（我们只有模型 stamp + force 带） | 0.5–1 天 |
| P3 | **工具调用输入裁剪** | `edit-marker.ts` | 巨型 `edit`/`write` diff 入参常驻；受 §B4 限制，需先验证宿主是否允许改写 assistant 内容 | 0.5 天 + 验证 |
| P3 | **观测缺口** | `historian-no-fire-cause.ts`、`pass-outcome.ts` | 静默不触发（只有 below-trigger 有日志）与降级无台账 → 现场无法定位 | 0.5 天 |
| P3 | **超窗发送前守门** | `unmanaged-over-window.ts` | 现靠 provider 拒绝 + emergency 事后兜底（裁定见 §3.4-3） | 0.5 天 |
| P3 | **压缩模式迁移 UX** | `compaction-off-transition.ts` | 开关压缩时无状态明示与 wrapup 建议 | 0.5 天 |
| 决策 | **`ctx_note` 提醒 / 用户档案块** | `note-nudger.ts`、`note-visibility.ts`、`user-profile-render.ts` | 需要先定产品取舍（desk 段已刻意去掉 `ctx_note`） | 产品决策 |

> 已在 `PARITY.md` §C 记录、不重复计入：dreamer 全任务集、`caveman`/`decay_render`、`divergence`、
> `healing`、`reply_pages`、`protected_tools`、per-request projection seam。"决策"行与它们同类：
> **要做是产品决策，不做是明确偏差**。

## 5. 结论

1. **比例**：148 个模块里约 **90 个 `host-imposed`/`internal`**（OpenCode parts 手术、自身会话库与
   原始序数、ck-mc 模块与 Rust 引擎、插件自更新、上游夹具），约 **40 个 `ported`**，**约 18 个 `GAP`**。
2. **缺口集中在三处，都不在核心链路**：
   - **用户可见操作面**：`/ctx-recomp`（唯一 P1）与命令面；
   - **标定数据**：historian 打分锚点、token 校准表、图像计价——上游用数据把"估算"做成"标定"；
   - **观测与自动化边角**：水位自动回收、静默不触发原因、降级台账。
3. **核心链路已完整移植并有测试**：historian（span 选择/分块/校验/预算）、compartment 发布（含本轮
   修复的遮蔽枚举与配对边界）、m[0]/m[1] baseline、应急回收、维护 tick、记忆读写检索、reduce 引导阈值。
4. **建议顺序**：① `/ctx-recomp` → ② historian 打分锚点 → ③ 主动检索提示 → ④ token 标定。
   ②③④ 都是**加法**（不触碰线材，风险低）；①需要新命令面 + 部分区间吸附，是本清单唯一的 P1，
   也是唯一"用户已经会想要"的能力。
5. **反向结论（同样重要）**：这次摸排确认了两类**不需要**做的事——LKG/降级拒绝（DSH 结构性豁免，
   §3.4-1）与 refusal 家族的大半（§3.2）。把它们写下来是为了以后不再重复评估。

## 6. 实施记录：`/ctx-recomp`（P1 落地）

**机制**（`src/dsh/recomp.ts` + 三个底层扩展）：

1. `seams.nodesForSeqs(session, seqs)`：按**显式 seq** 构造节点视图，**包含被遮蔽事件**——这是整个
   特性的前提（`enumerateSurfaceNodes` 只看活窗口）。为此把 `enumerateSurfaceNodes` 的字段推导抽成
   共用的 `surfaceNodeOf`，两条路径单一来源。
2. `stores.replaceCompartmentDraft(sessionId, id, draft)`：原地替换摘要（tiers/importance/facts/events），
   **不动**身份、`covered_seqs`、`landed_event_seq`。
3. `parseRecompSelection` / `snapRangeToCompartments` / `selectRecompTargets`：
   `all`（默认）、`last:<n>`、`<start>-<end>`；区间按 compartment **吸附、绝不切分**
   （对齐上游 `snapRangeToCompartments`）；只选**已落地**的 compartment（没落地的文本模型看不到）。
4. `recompactCompartments`：逐个目标重跑 `callHistorian`（`trigger:'manual'`，分块预算 = 与自动路径同一条
   `historianTriggerBudget`，5% 窗、5k–50k），成功即替换 + journal `compartment-recomp`；单个失败
   **不中断其余**（修复工具的部分成功就是目的）；覆盖事件已不在日志里 → 记 `skipped`。
5. 命令 `ctx-recomp` 注册在 `/ctx-status` 旁边（同一 `registerStatusCommand` 门），`llm` 缺失或
   `historianEnabled=false` 时返回可读错误。

**与上游的两处有意差异**：

- **无表面手术**：上游要 staging 提升 + 重写占位符 + compartment lease；本适配器的摘要是**从 store 渲染**的
  （`renderBaseline`），所以替换行就是全部操作，占位符节点保持原样（它的文本只是标记，不是摘要）。
- **无 lease**：DSH 单进程，不需要跨进程互斥。

**可见性**：替换后基线渲染发生变化，下一趟 pre-step 的 `refreshBaseline` 会重建（**可能 HARD**，
即一次计价的前缀失效）——命令输出里明确写了这一点。

**测试**：`tests/recomp.spec.ts` 7 条——解析（含用法错误）、区间吸附（不切分）、`last:<n>` 只取已落地、
原地替换后身份/覆盖/落地标记不变、historian 失败时旧摘要保留且报告、覆盖事件缺失时跳过且**不调用 LLM**。

**仍未做（上游有、本实现没有）**：进度上报（上游 recomp 有 stage 进度）、`staging` 提升等价物
（上游先用新摘要替换旧摘要再核验）、以及"重压缩后立即重建基线"（本实现等下一趟 pass，避免命令内写表面）。
