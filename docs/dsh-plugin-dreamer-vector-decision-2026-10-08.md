# Dreamer 取舍与向量回填策略（决策记录，2026-10-08）

> **结论**：不移植 MC 的 dreamer 调度层；`promote-primers` **单独做没有意义**（它需要整条
> primer 管线，见 §6 修正），故改为**产品决策**；单次调用类任务按触发条件逐个评估；
> 向量回填**保持默认关**，开启时必须做成限速后台回填 + 成本上限 + telemetry。
> 本文是 `PARITY.md` §C / §D / §E 的展开依据。

## 1. 判据

**用户可见收益 ÷（双重归档风险 + 新增运维面）**。MC 的 dreamer 是一个约 90 文件的
子系统（`task-executor.ts` 105 KB、`task-scheduler.ts` 31 KB，外加 `cron.ts`、
`lease.ts`、`task-registry.ts`、`storage-task-schedule.ts`），自带调度、租约、运行
记录三层基建；本适配器只有 `setTimeout` + `setInterval` 的 tick
（`src/dsh/maintenance-wiring.ts:40`，间隔 30 min、下限 60 s，见 `:97`）。照搬子系统的
成本远大于照搬其中一两个任务。

## 2. 事实：MC 的 12 个任务按**运输方式**分类

依据 `packages/plugin/src/features/magic-context/dreamer/task-registry.ts:13-28`
（任务清单）、`:72-121`（能力表）、`:124`（`toolLoopDreamTasks()`）。

| 运输方式 | 任务 | 本机可行性 |
|---|---|---|
| `tool-loop`（需隐藏 agent 循环） | map-memories、verify、verify-broad、curate、retrospective、maintain-docs、refresh-primers | **不可行**：适配器没有隐藏 agent 接线，也没有 subagent 面 |
| `single-shot`（一次无工具补全） | compress-cues、classify-memories、evaluate-smart-notes、review-user-memories | 可行：`ctx.llm.stream` 已具备 |
| `host-only`（零模型调用，纯 DB） | **promote-primers** | 可行且最低成本 |

适配器的 LLM 面只有两处单次流式调用：`src/dsh/historian.ts:332`（historian）与
`src/core/maintenance.ts:155`（verify 批量）；全仓库无 `subagent` 接线、无工具循环。

## 3. 决策

### D1 不移植调度层，也不移植 7 个 tool-loop 任务

拒绝理由逐条：**①** 调度/租约/运行记录是为多任务并发与跨进程互斥设计的，本适配器
只有单进程 tick，引入即是净新增故障面；**②** tool-loop 任务需要隐藏 agent 调用工具
（`task-registry.ts:75-120` 逐条写明用途，如"需要只读文件工具去核对记忆描述的代码"），
而 DSH 侧唯一决策点是 `agent/pre-step`，没有可插拔的隐藏循环；**③** curate/verify/expire
一旦移植会与本适配器既有的归档路径**双重写**（升级指南 §5 已记录）。

### D2 `promote-primers` 的原始判断（**已被 §6 修正**）

它聚类既有候选并写行，**不调用任何模型**（`task-registry.ts:114-115`），因此
不受 verify 配额（429）影响，也不引入新的 LLM 预算。落地方式：作为 tick 内的一个
任务挂在 `src/core/maintenance.ts:200`（`runMaintenanceTick`）之后，复用
`src/dsh/maintenance-wiring.ts` 的既有 interval，不新增定时器。

**验收**：新 spec 覆盖"无候选 → 零写行"与"有候选 → 行数/去重正确"两条；tick tally
增加 promoted 计数并进入 telemetry health；先在真实库上跑一次 dry-run 对比行数。

### D3 verify 的"无工具降级"是**有意偏差**（记录，不修）

MC 的 verify 是 tool-loop（要读代码逐条核对）；适配器只做文本判定，裁决为
`verified` / `stale` / `wrong` / `skip`（提示词契约 `src/core/maintenance.ts:81`，
落地 `:251-260`：verified→`markVerified`、stale→`updateMemory`、wrong→`archiveMemory`、
skip 不动）。**影响**：能发现"记忆自相矛盾/过期"，**不能**发现"记忆与代码不符"。
已记入 `PARITY.md` §C/§D。

### D4 4 个 single-shot 任务按需评估，不批量上

它们各自携带 25–35 KB 级提示词与 JSON 契约（`classify.ts`、`evaluate-smart-notes.ts`、
`map-memories-prompt.ts`），移植一个 = 移植一套 prompt + 校验 + 安全护栏。触发条件：
`review-user-memories` 需要有用户可见的"待复核"队列；`classify-memories` 需要分类
字段真的被某处消费；`compress-cues` 需要 mural/cue 功能在 DSH 侧存在。

### D5 向量回填保持默认关

现状：查询侧本地 MiniLM 常开，并有**共享空间闸门**——只有余弦 ≥0.99 才肯读共享向量
（`src/dsh/memory-lane.ts:121-145`）；存储在 `memory_embeddings` 的向量走只读车道；
in-memory 填充车道由 `memory.embedBackfill` 关闭，默认 false
（`src/dsh/config.ts:74`、`src/dsh/memory-lane.ts:106`）。

**开启的前置条件（须同时满足）**：**①** 有具体的 FTS-only 召回失败案例（不是猜测）；
**②** 实现为限速后台回填——每 tick 有行数上限、可中断、**不阻塞**工具调用；
**③** 成本上限与进度进 telemetry（已回填行数、失败计数、模型加载耗时）；
**④** 验收：单步延迟增量 < 50 ms、进程内存增量 < 300 MB、回填可断点续跑。

## 4. 何时重开本记录

- TTL 不对称（存储兼容观察项 R3）被用户实际感知 → 先对齐 expire 语义，再考虑 curate。
- 观察到重复/冲突记忆 → 评估 `classify-memories`（single-shot），而不是 curate（tool-loop）。
- 配额稳定（不再 429）且 verify 命中率持续偏低 → 评估 `verify-broad`。
- DSH 提供隐藏 agent / 工具循环 seam → 重新评估 7 个 tool-loop 任务。

## 5. 影响与预算

- **不做**：调度/租约/运行记录三层基建；7 个 tool-loop 任务。
- **下一步工作量**：见 §6 修正——`promote-primers` 必须连生产端与消费端一起做
  （3–5 天，属产品决策）；单个 single-shot 任务 1–2 天；向量限速回填 1–2 天。
- **对应关系**：`PARITY.md` §C（未移植清单）、§D（verify 降级、回填默认关）、
  §E（观察项）。

## 6. 修正（同日复核）：`promote-primers` 改为产品决策

D2 只依据"运输方式 = host-only（零模型调用）"这一条就选了它。进一步核实发现它**不是独立
任务**，而是整条 primer 管线的最后一环：

1. **生产端**：MC 的 historian 提示词带 `<primer_candidates>` 段
   （`packages/plugin/src/hooks/magic-context/historian-prompt.generated.ts`），由
   `compartment-runner-incremental.ts` 解析后落库到 `primer_candidates`；
2. **存储**：`primers` + `primers_fts` + `primer_candidates` 三张表——MC schema v94 迁移
   已建，本机库中确认存在；
3. **聚类/提升**：`primer-clustering.ts` 需要 embedding 与阈值（`PRIMER_*` 常量）；
4. **消费端**：`ctx_search` 的 `primer` 源与 auto-search 提示——**没有消费者，写进去的行
   没人读**。

本适配器现有 **0 处** primer 代码（`src` 下 grep `primer` = 0），生产端与消费端也都不存在。
**修正后的判断**：把 "primer feature" 当作**产品决策**——要做就把上述四件一起做
（估 3–5 天）；不做就在 `PARITY.md` §C 写明"不移植（缺生产端与消费端）"。
决策之前不排入任何实现项。

D3（verify 无工具降级属有意偏差）、D4（4 个 single-shot 按触发条件）、D5（向量默认关）
不受本次修正影响。
