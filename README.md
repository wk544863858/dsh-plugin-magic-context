# dsh-plugin-magic-context — Magic Context 的 DeepSeek Harness 适配插件

> 把 [Magic Context](https://github.com/cortexkit/magic-context) 的上下文管理与共享记忆能力移植到
> **DeepSeek Harness（DSH）** 的适配插件。以 DSH **bundle** 形态安装进 desktop profile：出现在
> GUI 的"插件"页面，在运行中的应用里即时开始工作。
>
> 当前版本 **0.8.2** · 上游基线 **magic-context v0.46.0**（`651c105a9`）· 针对 **DSH
> 0.2.1-alpha.1**（`e0f83cbfe`）· 状态：**已在真实 DSH Desktop 安装并日常运行**（2026-10-06 起）。
>
> 本包原本长在上游 `packages/dsh-plugin` 下，2026-10-08 抽出为独立仓库（60 个提交原样重放，
> 作者与日期保留）。上游 MIT © 2025 Ufuk Altinok；本仓库新增部分 © 2026 wukai。出处与内嵌
> 第三方文件见 [NOTICE](NOTICE)，许可见 [LICENSE](LICENSE)。数据库仍在 `~/.local/share/cortexkit/`
> 命名空间下——那是与 magic-context **共享同一个记忆库**的互操作路径，刻意不随改名而改。

## 它做什么

Magic Context 的核心思想：**上下文是可管理的资产**——旧的工具结果可以打标、回收、需要时恢复；
被消化的历史压缩成带外摘要；重要的知识沉淀为项目记忆，跨会话复用。本仓库把这套能力接到 DSH 的
事件 / surface 体系上：

| 能力 | 机制 |
|---|---|
| **可逆上下文回收** | 工具结果打 `§N§` 标签（admission 刻意不打标）；`ctx_reduce` **只入队**，落地发生在 execute 带内（content-only 替换为 `[dropped §N§]` 占位符，引用原事件）；`ctx_expand` 恢复原文。绝不自发打断缓存前缀 |
| **压力调度** | 持久 usage（含 cache 读写）→ 压力 = 未缓存输入 + cache 读 + cache 写 ÷ `contextWindow`；execute/defer 决策（默认 65% 阈值、5 min cache TTL、85% 强制带）；`CONTEXT_WINDOW_EXCEEDED` 紧急回收 + retry；reduce-guidance 分级引导（60k/25k 地板、20/40/60% 阶梯） |
| **historian（带外摘要）** | 一次性 LLM 调用重放真前缀（保 KV cache）→ 四层摘要 p1–p4 + importance + facts/events，**只写 store 不动线缆**；execute 带内发布为 `[compacted §C<n>§]` 范围替换（引用原事件，可恢复）；`/ctx-recomp` 可原地重做已压缩历史 |
| **m[0]/m[1] 基线** | 合成 notice 节点承载冻结基线 + 增量车道（`<new-memories>` / `<memory-updates>` / `<user-profile>`）；每类增量有独立水位（`maxMemoryId`、mutation 水位、profile 水位 + digest），**新记忆永不重建缓存前缀**；内容未变则零变更 |
| **项目记忆（自有语料库）** | 插件自有 `memories.db`（2026-10-13 起与上游 MC 数据库彻底分家，无共享无兼容义务）：身份自动推导（`git:<root-sha>` / `dir:<hash>`，未配置用会话 cwd，域共享从适配器域表解析）；注入 m[0] + `ctx_memory` 检索与**读写维护**；historian facts 自动提升；FTS 0.7/0.3 融合向量检索 |
| **本地向量车道** | `vendor/onnx/` 内置 onnxruntime-web WASM 后端（27 MB，MIT，Microsoft），无原生编译、无额外依赖；首次 `embed()` 从 huggingface.co 下载 MiniLM（~90 MB，失败自动切 hf-mirror.com），缓存在插件数据目录 `models/`；检索候选内嵌补分 + 维护 tick 向量回填；任何失败 fail-open 降级 FTS，journal 有可读 warn |
| **全局域 + 用户画像** | 机器 / 组织域：**入队可自动化**（维护 tick `autoStage`、LLM 域分类），**发布永远是人**（`ctx_memory review_global` 审批卡、`/ctx-global approve`）；用户画像 render / collect / review 三开关分离——读默认开、写共享库的半边默认关 |
| **维护 tick（MC dreamer 切片）** | 每 30 min：TTL 归档（走 archive 契约动作）→ 批量 LLM verify（keep / update / archive）→ 向量回填 → 全域候选入队 |
| **压缩接缝** | `registerCompactionEngine` 可接管 `ctx.compaction`（真实 `compaction/start\|summary\|replace\|end` 协议，管理通道永不写 checkpoint）；**首装保守关闭**，不碰宿主 compaction-basic |
| **界面集成** | 插件页设置卡片（volatile 字段保存即生效）；`shell.overlay` 遥测徽标 + 胶囊面板（实时指标 + 操作记录）；`session-notice` 会话流提示；中英双语即时切换 |

## 安装

```powershell
# 1) 构建（桌面运行时加载编译产物 lib/；包里没有 TS loader）
npm install
npm run build     # tsc → lib/（多文件 ESM）+ 浏览器半侧拷贝为 lib/client.js

# 2) 安装（应用自带 CLI；DSH_HOME 默认即 ~/.dsh）
#    spec 可以是 Git 地址、本地路径或 registry 版本
dsh plugin --profile desktop add <git-url 或本仓库路径>
```

安装做三件事：profile 里 `pnpm add`（本地路径用 `link:`）、把包名追加进 `dsh.profile.bundles`、
由 loader 组合。**Desktop 带 HMR → 立即热生效**（无需重启，运行中的会话即刻开始打标签）。

- `peerDependencies` 里的 `@deepseek-ai/*` 全部声明为 `"*"`——兼容性预检对任何 DSH 0.2.x 放行；
  运行时真正 import 的宿主包同时列为**精确版本 dependencies**（随包解析，link: 开发安装由本仓
  自己的 node_modules 提供）。
- 运行环境需要 **Node ≥ 22.19**：自有存储基于内建的 `node:sqlite`，无原生模块（桌面宿主是
  Electron RunAsNode 进程，ABI 编译模块不可移植）。
- **工具构造器解析**：`config.defineTool`（宿主注入，树内 glue 用）优先，其次动态
  `import('@deepseek-ai/dsh-tools')`（硬依赖，任何安装形态物理可解析）。二者皆不可用时**响亮
  失败**（挂载中止）——ctx_* 工具是回收标记的唯一入口，不能静默半启动。
- 两种加载模式：**patch-overlay / 文件 URL**（开发期，overlay yml + `config.defineTool` 注入）
  与 **profile 安装**（生产，包名行 + link 依赖）。生产路径即上面的 `dsh plugin add`。

卸载 / 停用：GUI 插件页停用该 bundle（写 profile patch 的 `disabled`），或
`dsh plugin --profile desktop remove dsh-plugin-magic-context`。

## 配置

改配置有两种途径，语义不同（详见[配置界面契约](docs/dsh-plugin-config-ui-contract.md)）：

- **GUI 设置卡片**：暴露 `policy.*`（含 historian 生成上限 / 上限抬升 / 超时）、
  `historianEnabled`、`registerCompactionEngine`、`journal.*` 等 volatile 字段。写回走 settings
  链路：非 volatile 键原样保留、未触碰的字段不会 materialize 进覆盖行——**保存即生效**
  （host 侧读取一律经 `liveNumber/liveBoolean/liveString` 在决策点现取）。
- **手写 profile 覆盖行**：`config` 是**整体替换**包内 patch 的 config，**不是深合并**。只写
  `memory:` 会把 `registerCompactionEngine: false` 抹掉。手写覆盖时必须把要保留的键一并写出。

bundle 自带配置只有一行：`registerCompactionEngine: false`（保守首装——只做回收与 historian，
宿主压缩引擎保持原位）。要接管压缩时：

```yaml
- id: magic-context-dsh
  name: 'dsh-plugin-magic-context'
  config:
    registerCompactionEngine: true
    memory: {}            # 空对象即启用记忆车道：身份/工作区/共享类别全部自动解析
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true          # 二者互斥，接管时必须同时禁用宿主引擎
```

配置参考（完整类型见 [src/dsh/config.ts](src/dsh/config.ts)；除注明外均为 profile 覆盖行可写）：

| 组 | 键（默认值） | 说明 |
|---|---|---|
| 总开关 | `enabled` (true) · `registerTools` (true) · `registerStatusCommand` (true) · `sessionNotices` (true) · `reduceGuidance` (true) · `searchHint` (true) | `enabled: false` 保持加载但完全惰性；`sessionNotices` 控制会话流内的管理提示行 |
| 压缩接缝 | `registerCompactionEngine`（代码默认可解析即挂；**bundle 随发 false**）· `compactionBase`（宿主注入基类） | 接管需同时禁用 compaction-basic；pre-step 每步 `reconcileEngine` 动态挂/卸 |
| 压力策略 | `policy.*`：`executeThreshold` (65) · `forceThreshold` (85) · `ttlMs` (5 min) · `assumedContextWindow` (256k) · `protectedToolResults` (8) · `historianTimeoutMs` (120 s) · `historianMaxTokens` (8192，低于会被抬到 8192) · `historianMaxTokensCeiling` (32768) · `baselineTokens` (2000) · `memoryBudgetTokens` (8000) · `memoryLimit` (40) · `compartmentGuardMode` (observe) · `forceWaitReadyMs` (0) | 阈值在下一个决策点生效（含 `/ctx-status` 与 compaction engine 路径） |
| historian | `historianEnabled` (true) · `historian.{provider, model}`（默认会话最后路由的模型） | 带外运行；verify 之外的唯一 LLM 消耗点 |
| 项目记忆 | `memory.{}`：`enabled` · `dbPath` · `project`（省略用会话 cwd）· `domainProjects` · `shareCategories` · `autoPromote` (true) · `write` (true) | `memory: {}` 即可用；`write: false` 让 `ctx_memory` 退回只读 |
| 检索 / 向量 | `memory.embedBackfill` (true，查询侧内嵌补分) · `memory.vectorBackfill` (true，维护 tick 回填) · `memory.vectorBackfillLimit` (24 行/tick) | 向量车道任何失败 fail-open 降级 FTS |
| S(t) 衰减 | `memory.scoring.{enabled (false)，alpha (0.4)，beta (0.2)，archiveThreshold (2)，halfLives}` | 默认只收集统计、不接管排序；profile-JSON only，不进设置卡片 |
| 全局域 | `memory.global.machine.{enabled (false)，excludeProjects，autoStage (false)}` · `memory.global.review.batchLimit` (50) | 入队可自动化（≤3 条/pass、≥10 候选待审时暂停），发布永远是人 |
| 用户画像 | `memory.global.user.{render (true)，collect (false)，review (false)}` | 读 / 收集 / 评审三半独立；写共享库的两个半边默认关 |
| 域解析 | `memory.domains.source` (`adapter` \| `contract`) | `contract` 是对照用的回退杆，不是支持终态 |
| 维护 | `maintenance.{enabled，intervalMs (30 min)，verifyProvider，verifyModel}` | LLM verify 需显式路由（未钉则跟随主对话最新路线） |
| 观测 | `journal.{enabled (true)，level (info)，retentionDays (30)，mirror (true)}` · `tags.retentionDays` (30) | level/mirror 对下一条写入生效；挂载时就是 off 的 journal 运行中打开需重启；`retentionDays` 有 `min(1)` 下限防误剪 |

## 工具与命令

Agent 工具（挂载时注册；`registerTools: false` 可关）：

| 工具 | 作用 |
|---|---|
| `ctx_reduce` | 解析 MC 范围语法（`"3-5,8"`）→ **只入队**；落地是有价 bust，等待回收带，绝不自发 |
| `ctx_expand` | 从占位符引用的源事件**恢复原文**（恢复的即打标原文） |
| `ctx_memory` | 共享记忆库的读写口。读：`list` / `search` / `get`；写：`write` / `update` / `archive` / `merge`（与 MC 相同的规范化内容哈希、mutation log 与 authority 守卫全程在环）；`review_global`（把机器/组织域候选逐条弹成审批卡，批准才发布）；`promote`（单条项目记忆即时入池弹卡，无复现门槛的人工通道）。每个动作可带 `project`（绝对路径或 git 根）操作其它项目 |

斜杠命令（`registerStatusCommand: false` 只关 `ctx-status`）：

| 命令 | 作用 |
|---|---|
| `/ctx-status` | 压力 / 决策 / 回收台账 / compartments / 基线 / 策略 |
| `/ctx-recomp` `all` \| `last:<n>` \| `<startSeq>-<endSeq>` | 重跑 historian 并**原地替换** store 里的摘要（区间按 compartment 吸附、绝不切分；身份与已落地占位符不变，下一趟 pre-step 重建基线） |
| `/ctx-profile` `confirm` \| `reject` \| `retire` | 用户画像候选的确认 / 拒绝 / 退休；晋升进共享 profile 在下一维护 tick 发生 |
| `/ctx-global` `add` \| `remove` \| `status` \| `promote` \| `approve` \| `reject` | 全域成员管理与候选审批的人工通道（与审批卡走同一 gate→publish 路径，`source_type=user`） |

## 界面与遥测

两个界面能力都靠同一个浏览器半侧（`src/client/index.js`，构建时原样拷为 `lib/client.js`）：

- **插件页设置卡片**：上文 volatile 配置项的可视化编辑，保存即生效（见"配置"一节）。
- **`shell.overlay` 遥测徽标 + 胶囊面板**：收起态显示占用百分比；面板里是两行指标、节拍与
  **实时操作记录**（最多 12 条，相邻同操作折叠 `×N`）：🧠 写入记忆 · 🔎 加载记忆 · 🗑️ 回收入队 ·
  🧭 恢复原文 · ✂️ 压缩上下文 · 🗑️ 丢弃上下文 · 🧭 归档已存 · 🧰 维护巡检 · ⚠️ 失败。
  点击面板/徽标之外、按 Esc、窗口失焦即关闭。
- 数据来自本插件自己的 HTTP 路由（harness 的 Remote 事件白名单是编译期常量，第三方 bundle 的
  受支持口子是 `ctx.webServer.register`）：
  - `GET /mc-telemetry/summary` — 一次性快照（适配器 / 项目 / 健康状态 + 最近事件）
  - `GET /mc-telemetry/events` — SSE 实时尾
- **安全**：路由仅 loopback、无 token 鉴权，因此**只输出计数与单行摘要**——不含消息正文、
  不含文件路径、不含凭据。
- **多语言**：浏览器侧 `magic-context` 命名空间字典（zh/en），设置 → 通用切换即时生效、无需刷新；
  写进会话流、模型可见的 `session-notice` 保持英文常量（避免同会话中途换语言造成 cached prefix
  抖动）。机制见[主界面遥测契约](docs/dsh-plugin-ui-telemetry-contract.md)。

## 观测与运维

Desktop **不持久化 `ctx.logger` 输出**，所以插件把决策与结果写进自己的 append-only journal：

- `~/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db` → `journal` 表
  （结构化，可 SQL 查询）
- `~/.local/share/cortexkit/magic-context-dsh-poc/activity.log` → 单行文本镜像
  （`tail`/grep 友好，超 5 MiB 自动轮转为 `.1`）

**隐私**：消息正文**永不记录**。只记计数、标签号、token 估算、原因与耗时；字符串截断 300 字符、
数组上限 20 项（`redactData` 兜底）。

journal 覆盖（按组）：生命周期（`boot` / `config-drift` / `session-first-seen`）；回收与压缩
（`pass` —— execute 全量记录，含 **tokensBefore→After 净回收证明** 与 defer 原因、`drop-landed`、
`compartment-published`/`-recomp`/`-guard`、`force-path`、`emergency-reclaim`、`context-pressure`）；
historian 与基线（`historian` —— 含 start/done/failed 配对与 LLM 用量、`baseline`、`session-notice`、
`wire-repair`）；记忆（`memory-recall` / `profile-recall` / `memory-promote` / `memory-stats` /
`vector-lane` / `search-hint` / `project-drift` / `global-review`）；维护（`maintenance`）；
工具与引擎（`tool-call` / `engine` / `error` —— 所有 fail-open 吞掉的异常）。

### 运维命令

```sh
npm test               # vitest run（72 个 spec）
npm run gate           # 全门禁：typecheck + 套件 + build + 验收 + 记忆审计 + records
npm run doctor         # 只读健康报告：corpus fence / 事件车道心跳 / 悬空 run / embedding 车道

node scripts/mc-report.mjs --days 7 [--json] [--session <id>]   # journal 复盘报告
node scripts/mc-acceptance.mjs [--hours 72 --json]              # 语料库验收，失败 exit 1
npm run phase          # 阶段门：跑某一阶段的套件并给出裁决与盲区
```

复盘报告含：库与状态、按 kind/按天计数、关键指标（execute/defer 比例与原因分布、净回收、
historian 失败率与耗时、紧急回收、工具调用）、最近事件明细与健康提示（"窗口内没有 execute
pass" / "historian 从未运行" / "存在 error" / "journal 最新事件超过 24h" 等）。

`scripts/` 专项工具：检索权重 A/B（`retrieval-eval`）、S(t) 排序离线 diff（`score-diff`）、
稀释与 fold 仪表（`report-dilution`）、域命中统计（`report-hits`）、historian 失败分类
（`report-classify`）、向量模型预检（`embedder-precheck`）、参考种子重建（`npm run build:seeds`）、
面板分类校验（`mc-records-check`）、多语言检查（`npm run check:i18n`）。

## 架构

```
src/
  dsh/     # ← 全包唯一允许 import @deepseek-ai/* 的目录（防腐层）。
           #    事件名、payload 形状、surface 词汇表全部收拢在这里，
           #    DSH 升级只改这个目录。
  core/    # 中性逻辑与存储：policy/stores/journal/memory-*/domains。
           #    不依赖 DSH。
  client/  # 浏览器半侧（设置卡片 + 遥测徽标），纯 JS，
           #    构建时原样拷为 lib/client.js。
  index.ts # 组合根：boot probe（fail-loud）→ 接缝监听 → 中性存储。
```

隔离纪律（DSH 处于 developer preview，破坏性变更预期之内；这就是本包的结构策略）：

- **能力探测 fail-loud**：`probeDshSeams` 启动期校验接缝可用性，不可用即抛错，绝不静默假装
  在管理上下文；
- **版本 fence**：适配器库 schema 链当前 **v10**（前向迁移，库比新即拒开）；**自有语料库**
  `memories.db` 版本线继承 **v95** 起点（2026-10-13 切换，续号归本插件；`MEMORY_SCHEMA_MAX_VERSION`
  守自有迁移线），超出即读路径拒绝、写路径转只读并响亮告警；
- **测试即探针**：集成测试同时是接缝契约测试——DSH 升级后重跑，破坏点精确定位到 `src/dsh/`；
- **双库结构**：
  - **适配器库** `~/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db`
    （tags / usage / pending_drops / compartments / baseline / domains / queues / journal…，
    schema v10）；
  - **自有语料库** `~/.local/share/cortexkit/magic-context-dsh-poc/memories.db`
    （项目记忆 + 全域行 + 画像 + 向量；legacy `context.db` 已封存不读——2026-10-13 硬切换，
    与上游只做功能跟进、无存储兼容义务）；
- **上游对齐账本**：与 OpenCode / Pi 两个上游适配器的逐条有效行为对齐与刻意差异见
  [PARITY.md](PARITY.md)（aligned / host-imposed / intentional 三种裁决，每条引用宿主文件）。

## 文档索引

**契约类**：[记忆写契约](docs/dsh-plugin-memory-write-contract.md) ·
[记忆提升契约](docs/dsh-plugin-memory-promotion-contract.md) ·
[记忆验收](docs/dsh-plugin-memory-acceptance.md) ·
[配置界面契约](docs/dsh-plugin-config-ui-contract.md) ·
[主界面遥测契约](docs/dsh-plugin-ui-telemetry-contract.md) ·
[升级跟随](docs/dsh-plugin-upgrade-followup.md) ·
[hooks 覆盖](docs/dsh-plugin-hooks-coverage-2026-10-08.md)

**设计决策**：[移植可行性（接缝地图）](docs/dsh-port-feasibility-2026-10-06.md) ·
[执行计划](docs/dsh-plugin-execution-plan-2026-10-09.md) ·
[平台接管与全域](docs/dsh-plugin-platform-takeover-and-global-domains-2026-10-09.md) ·
[dreamer 向量决策](docs/dsh-plugin-dreamer-vector-decision-2026-10-08.md) ·
[记忆机制清单](docs/memory-mechanisms-inventory-2026-10-09.md) ·
[上游源码分析](docs/upstream-source-analysis-2026-10-09.md) ·
[全域来源调查](docs/global-domain-source-finding-2026-10-10.md) ·
[记忆架构挑战](docs/memory-architecture-challenge-2026-10-10.md) ·
[用户画像评审](docs/user-profile-review-2026-10-09.md)

**复盘与运行**：[项目记忆复盘](docs/dsh-plugin-project-memory-review-2026-10-06.md) ·
[测试设计审计](docs/dsh-plugin-test-design-audit-2026-10-07.md) ·
[运维手册](docs/dsh-plugin-operations-runbook-2026-10-10.md) ·
[creator 模式复盘](docs/dsh-plugin-creator-mode-review-2026-10-11.md) ·
[surface 写审计](docs/dsh-surface-write-audit-2026-10-09.md) ·
[巡检提示词](docs/patrol-prompt-v8.md)

**报告**：`docs/reports/`（dreamer token 用量、记忆方案对比）

## 已知边界

- historian 的触发与预算用 **chars/4 估算**，不是真 tokenizer（检索向量的分词是真
  tokenizer）；四层摘要在**一次调用**内产出（MC 是跨调用累积）；
- `review_global` 审批卡必须由 agent 轮内触发；headless 无审答器时明确拒绝、零状态变更；
- 挂载时就是 off 的 journal，运行中打开需要重启（其余 journal / 阈值改动均即时生效）；
- Desktop 不持久化 harness logger——可观测性完全由自记 journal 承担。

## 出处与许可

- **magic-context**（MIT © 2025 Ufuk Altinok）：本仓库的衍生来源。抽取自上游 tag
  v0.46.0（`651c105a9`）；适配器自有提交从本地 checkout `dsh` 分支的 `e34eda955`
  （2026-10-08）原样重放。
- **DeepSeek Harness**（MIT）：以依赖消费，不含在内。代码针对 0.2.1-alpha.1 编写
  （checkout `e0f83cbfe`，npm 协调 dist-tag `dsh-0-2-1-alpha-1`；注意这些包的 `latest`
  标签落后一个发布线，精确钉版以 devDependencies 为准）。
- 内嵌第三方：`vendor/onnx/`（onnxruntime-web WASM 子集，MIT © Microsoft）、
  `tests/helpers/mock-adapter.ts`（DSH 测试树原样内嵌）。明细见 [NOTICE](NOTICE)，
  许可见 [LICENSE](LICENSE)。
