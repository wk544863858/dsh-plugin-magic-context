# dsh-plugin-magic-context — Magic Context 的 DeepSeek Harness 适配层

> **这是一个独立仓库。** 本包原本长在 [cortexkit/magic-context](https://github.com/cortexkit/magic-context)
> 的 `packages/dsh-plugin` 下；为了让适配层能被单独安装、单独发版、长期维护，已抽出为
> 自己的仓库。上游项目 MIT 许可，© 2025 Ufuk Altinok；本仓库新增部分 © 2026 wukai。
> 出处、基线版本与内嵌第三方文件见 [NOTICE](NOTICE)，许可见 [LICENSE](LICENSE)。
>
> 设计与契约文档（`docs/dsh-plugin-*.md`）留在上游仓库里，正文中相关链接直接指向 GitHub。
> 本包的数据库仍在 `~/.local/share/cortexkit/` 命名空间下——那是与 magic-context
> **共享同一个记忆库**的互操作路径，刻意不随改名而改。

状态：**已在真实 DeepSeek Harness Desktop 中安装并热生效**（2026-10-06）。插件以 DSH **bundle** 形态注册进 desktop profile，出现在 GUI 的"插件"页面，并在运行中的应用里即时开始工作（工具结果打 §N§ 标签、记录用量、压力管理、historian/基线）。

状态：**阶段 2 完成，记忆读写闭环**（2026-10-06/07）——historian/compartments、m[0]/m[1] 基线注入、项目记忆**读+写**（提升、agent 写、mutation log、权威守卫、`maxMemoryId` 水位）、CompactionEngine 接缝，全部经真实 agent loop 集成测试 + 真实 Node 运行时冒烟 + 真实 `dsh` profile 进程验证；记忆读路径另在**真实生产库与应用内**实测（注入 40 行真实项目记忆）。设计与可行性分析见
`docs/dsh-port-feasibility-2026-10-06.md`；存储契约见
`docs/dsh-plugin-memory-write-contract.md` 与 `docs/dsh-plugin-memory-promotion-contract.md`。

## 装进真实 DSH（2026-10-06 实测通过）

插件是一个 **DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，同目录
`cordis.patch.yml` 插入自己的运行行。GUI 的"插件"页面（`ui-plugin-manager`）
读 profile 的 `package.json`：`dependencies` = 已安装，`dsh.profile.bundles` =
已启用——两处都有本包，因此它出现在 Installed 组，显示名取自
`package.json.description`。

```powershell
# 1) 构建（桌面运行时加载编译产物；包里没有 TS loader）
npm install
npm run build     # tsc → lib/（多文件 ESM）

# 2) 安装（应用自带 CLI；DSH_HOME 默认即 ~/.dsh）
#    spec 可以是 Git 地址、本地路径或 registry 版本；DSH 的 plugin manager
#    对 Git 仓库有专门支持（安装前 git ls-remote 探活）。
dsh plugin --profile desktop add <git-url 或 本仓库路径>
```

安装会做三件事：profile 里 `pnpm add`（本地路径用 `link:`）、把包名追加进
`dsh.profile.bundles`、随后由 loader 组合。**Desktop 带 HMR → 立即热生效**
（无需重启；运行中的会话即刻开始打标签）。GUI 会弹一个刷新提示。

`peerDependencies` 里的 `@deepseek-ai/*` 全部声明为 `"*"`——兼容性预检因此对
任何 DSH 0.2.x 都放行；实际钉版测试的是 devDependencies 里的 0.2.1-alpha 线。
运行时真正 import 的五个宿主包同时列为**精确版本 dependencies**（打包安装
时随包解析；link: 开发安装则由本仓自己的 node_modules 提供）。

**本地 embedding 默认启用（0.3.0 起，WASM）**：运行时从原生
`onnxruntime-node`（~287 MB 平台二进制）换成 **onnxruntime-web 的 WASM 后端**
（`vendor/onnx/` 内置 27 MB，MIT，Microsoft）。安装即有向量车道，无额外依赖、
无原生编译；与 native fp32 管线逐位同空间（spike 实测 cosine 1.0000000，
中英文 6 文本探针，2026-10-09）。首次 `embed()` 从 huggingface.co 下载
MiniLM 模型（~90 MB，失败自动切 hf-mirror.com），缓存在插件数据目录
`models/`。检索的候选内嵌补分默认开启（受 MAX_IN_MEMORY_EMBEDDINGS 上限
约束）；`memory.embedBackfill: false` 可关。任何失败（断网/资产缺失）都
fail-open 降级 FTS 车道，journal 有可读 warn，doctor 有裁决。

卸载 / 停用：
- GUI 插件页停用该 bundle（写 profile patch 的 `disabled`），或
- `dsh plugin --profile desktop remove dsh-plugin-magic-context`

**为什么必须能脱离 `@deepseek-ai/*` 运行**：打包版把 profile 插件当编译 ESM 加载，
而 Node 的 ESM 解析器不读 `NODE_PATH`，profile 的
`pnpm-workspace.yaml` 又是 `autoInstallPeers: false` —— 插件无法 import 宿主包。
因此工具定义改由**本地结构化构造器**生成（`ToolDefinition` 本就是普通接口，
`register()` 只要求 `output.render` + 受支持的 JSON Schema），宿主注入
`config.defineTool` 仍是首选路径，动态导入退居次选。

两个可选的开关（写进 profile 的 `cordis.patch.yml`，按需打开）：

```yaml
- id: magic-context-dsh
  name: 'dsh-plugin-magic-context'
  config:
    # 读 Magic Context 共享记忆库（只读）并注入 m[0]
    memory: {}
      # project 可省略：默认用会话 cwd 自动推导身份
      # project: git:<root-commit-sha>   # 或 dir:<hash>，或直接给目录
      # workspaceProjects: [...]         # 省略则从库里的 workspace_members 自动解析
      # shareCategories: [CONSTRAINTS]   # 省略则用工作区的 share_categories
    # 接管压缩接缝（需同时禁用宿主的 compaction-basic，二者互斥）
    registerCompactionEngine: true
```

默认（bundle 自带配置）为 `registerCompactionEngine: false`：不碰宿主的压缩
引擎，只管回收与 historian。

> **改配置的坑（实测，两种路径语义不同）**：
> - **手写** profile patch 的 `- id: magic-context-dsh` 覆盖行时，`config` 是**整体替换**包内
>   patch 的 config，**不是深合并**。只写 `memory:` 会把 `registerCompactionEngine: false`
>   抹掉（我们曾因此让压缩引擎意外挂载，`meta.compaction_engine` 变成 `magic-context-dsh`）。
>   所以手写覆盖时要把必须保留的键**一并写出**。
> - **GUI 设置卡片保存**走的是 `settings` 的写回链路：它先 `strip` 掉 volatile 叶子、
>   再与 ops 结果 `mergeLayers` 并回，因此**非 volatile 键原样保留、未触碰的字段不会被
>   materialize 进覆盖行**（覆盖行保持最小，其余仍走继承层）。实测：改
>   `policy.executeThreshold` 后覆盖行只多出这一个键。

## 验证期观测：日志与复盘（2026-10-06 起）

**为什么需要专门一层**：桌面应用**不持久化 `ctx.logger` 输出**（日志目录里没有插件行），
而自有库里其余表只记"当前状态"，回答不了"某个 pass 为什么 defer、某次请求花了多少"。
因此插件把**决策与结果**写进自己的 append-only `journal` 表，并默认同时写一份
人类可读的单行镜像文件。

产物：
- `…/magic-context-dsh-poc/dsh-magic-context.db` → `journal` 表（结构化，可 SQL 查询）
- `…/magic-context-dsh-poc/activity.log` → 单行文本镜像（可直接 `tail`/grep）

记录的 kind 与关键字段：

| kind | 内容 |
|---|---|
| `boot` | 版本、工具构造器路径、引擎/记忆桥状态、策略快照、日志配置、**recoveredHistorianRuns**（挂载时补终局的孤儿 run 数）与 maintenance 概要（interval/verify 路由） |
| `session-first-seen` | 会话首次被管理（含 turn/step） |
| `pass` | execute 全量记录（原因/压力/用量/落地标签/发布/强制丢弃/基线是否刷新/historian 是否触发/**tokensBefore→tokensAfter→tokensDelta**，即净回收证明）；defer **只记原因变化**并带 `consecutive` 次数（防止刷屏） |
| `drop-landed` / `compartment-published` | 落地了哪些标签、替换了多少节点、估算回收 token |
| `historian` | start/done/failed：节点数、token、importance、尝试次数、**耗时**、LLM 用量 |
| `baseline` | HARD/SOFT 重建、epoch、基线/增量 compartment 数、记忆行数、字节与估算 token |
| `memory-recall` | 注入 m[0] 的行数/身份/工作区/成员/预算与 token，m[1] 新增行数、当前 `maxMemoryId` |
| `memory-promote` | 提升了几条 fact（含 id/类别）、多少条已存在（seen++）、被丢弃的 fact 及原因、是否因 module 托管让路 |
| `memory-write` | agent 写入路径（write/update/archive/merge）的结果与 mutation 类型 |
| `maintenance` | 维护 tick：TTL 到期归档数、verify 候选/判定数（verified/updated/archived）、无 LLM 路由时说明 verify 关闭 |
| `emergency-reclaim` | 溢出回收：丢弃数、保护数、generation 前后（是否 retry） |
| `tool-call` | `ctx_reduce`/`ctx_expand`/`ctx_memory` 的排队/恢复/拒绝与耗时 |
| `engine` | 压缩接缝：挂载/被配置关闭/不可用/手动 checkpoint |
| `error` | 所有被 fail-open 吞掉的异常（scope ∈ pre-step/usage/request-error/…） |

**隐私**：消息正文**永不记录**。只记计数、标签号、token 估算、原因与耗时；
字符串截断 300 字符、数组上限 20 项（`redactData` 兜底）。

保留与开关（默认值即可用）：

```yaml
- id: magic-context-dsh
  config:
    journal:
      level: info          # 设为 warn 只留告警与错误
      retentionDays: 30    # 开库时清理更早的记录
      mirror: true         # 单行文本镜像（超过 5MiB 自动轮转为 .1）
```

复盘（只读，不动数据库）：

```powershell
node scripts/mc-report.mjs --days 7
node scripts/mc-report.mjs --days 30 --json > mc-review.json
node scripts/mc-report.mjs --session <id> --limit 100
```

**契约验收**（只读，一条命令给出通过/告警/失败的清单，失败时 exit 1）：

```powershell
node scripts/mc-acceptance.mjs              # 默认 24h 窗口
node scripts/mc-acceptance.mjs --hours 72 --json
```

覆盖：适配器 schema 与 v6 列、boot 自检（读/写路径是否真的打开）、读路径成功注入、
`<memory-updates>`/`<new-memories>` 两条增量车道、**缓存前缀字节稳定性**（同载荷的
baseline 必须逐字节一致）、historian 终止事件不变式（start 必须有 done/failed，进程
重启被杀者单独标注）、promotion 字段契约与纯追加（无 insert/delete 变更日志）、
epoch 指纹稳定、权威守卫（authority 表空 + privilege 未启用）、契约版本 fence。

报告含：库与状态、时间窗按 kind 计数与按天表格、关键指标（execute/defer 比例与
原因分布、**净回收**：每个 execute pass 上报的 `tokensBefore→tokensAfter` 与平均
收缩量、落地标签与估算回收 token、historian 运行次数/失败率/耗时/LLM 用量、紧急回收、
工具调用）、最近事件明细，以及**健康提示**（例如"窗口内没有 execute pass"
"historian 从未运行""存在 error""journal 最新事件超过 24 小时前"
"执行 pass 未上报占用变化，无法证明省了 token"）。

**验证期怎么看**：先用一周的 `--days 7` 确认三件事——①`pass` 里 defer 占多数且
原因合理（`below-threshold`/`no-usage`），说明回收带没有被滥用；②`compartment-published`
与 `drop-landed` 的 token 估算确实在增长，说明回收有效；③`error` 为空或只是
无路由等预期告警。若某天 `journal` 断流，报告会提示"最新事件超过 24h"。

> 安装 journal 版本后需要**一次重载**才生效：插件页里关掉再打开该 bundle（HMR），
> 或重启桌面应用（必定生效）。生效标志：`meta.schema_version` 变为 `6`。

## 界面集成（插件页配置项 + 主界面遥测）

两个界面能力都靠**同一个浏览器半侧**（`src/client/index.js`，纯 JS，构建时原样拷到 `lib/client.js`）：

- **插件页设置卡片**：暴露 `policy.*`（executeThreshold/forceThreshold/ttlMs/…、
  **historianMaxTokens / historianMaxTokensCeiling / historianTimeoutMs**——historian 的
  生成上限是"事实提升能否发生"的决定性阈值：低于 8192 会被历史学家侧抬到 8192）、
  `historianEnabled`、`registerCompactionEngine`、`journal.*` 等阈值。字段来自 host 侧
  `Config`（schemastery，**只有 `.volatile()` 字段会被投影**），写回走 settings →
  profile `cordis.patch.yml` 的同 id 覆盖行；因为 volatile 变更不重挂 fiber，**保存即生效**。
  host 侧读取一律经 `liveNumber/liveBoolean/liveString`，在决策点现取，这是"改了立刻生效"的前提。
- **`shell.overlay` 遥测徽标**：消费本插件自己的 HTTP 端点
  `GET /mc-telemetry/summary`（一次性快照）与 `GET /mc-telemetry/events`（SSE 实时尾）。
  实测（本机运行中的应用）：`curl http://127.0.0.1:19387/mc-telemetry/summary` →
  `{"adapter":{"schemaVersion":6,"engine":"disabled-by-config","memory":"ok schema v94",
  "memoryWrite":"read-write auto-promote","toolsMode":"dynamic-import"},"project":{"identity":
  "git:93eea8cd…","memories":40},"health":{"journalRows":1246,"passes24h":479,"errors24h":23,
  "compartments24h":6,"memoriesRecalled":40},"recent":[…"recalled 40 project memories into m[0],
  26 new in m[1]"…]}`。

- **胶囊展开面板 = 实时操作记录**：点击 composer 下方的胶囊（收起态显示占用百分比），面板里
  除了两行指标与节拍，就是**操作记录**（最多 12 条，相邻同操作折叠 `×N`）：🧠 写入记忆（提升 N 条 /
  去重命中）· 🔎 加载记忆（list/get/search，search 带命中数）· 🗑️ 回收入队（`ctx_reduce`：入队 N ·
  被拒 M）· 🧭 恢复原文（`ctx_expand`：恢复 N · 被拒 M）· ✂️ 压缩上下文（执行回收 / 压缩上下文 /
  HARD 基线重建）· 🗑️ 丢弃上下文（应急丢弃 / 丢弃落地）· 🧭 归档已存 · 🧰 维护巡检 · ⚠️ 失败。
  噪声不进列表：`pass defer`、`boot`、`engine`、`context-pressure`、`memory-recall`，
  以及 **SOFT** 基线刷新（只数进节拍行；HARD 重建是 priced cache bust，算记录）。
  逐条映射规则与两个 node 侧校验脚本见 [主界面遥测契约](https://github.com/cortexkit/magic-context/blob/master/docs/dsh-plugin-ui-telemetry-contract.md) 勘误第 8 条。
  （2026-10-07 起对话流内的 turnTail 区块已移除：动作可查性由 `session-notice.ts` 的会话流 notice 承担，
  胶囊面板是实时/遥测面。）
- **徽标面板自动关闭**：点击面板/徽标之外的任意位置、按 Esc、或窗口失焦即关闭
  （两个面都带 `data-mc-surface`，因为面板是 `position: fixed`，不宜做矩形命中测试）。

**为什么是自己的 HTTP 路由**：harness 的 Remote 事件白名单是**编译期常量**，第三方 bundle
无法订阅任意插件事件；`ctx.webServer.register` 是受支持的口子（端到端实测过）。
**安全**：该路由没有 token 鉴权（仅 loopback），因此**只输出计数与单行摘要**——不含消息正文、
不含文件路径、不含凭据（journal 本身即无正文）。

> 配置界面的机制与坑见 [配置界面契约](https://github.com/cortexkit/magic-context/blob/master/docs/dsh-plugin-config-ui-contract.md)（含
> "profile patch config 整体替换"与"default export 吞掉 Config"两个实测陷阱）；
> 遥测通路对比见 [主界面遥测契约](https://github.com/cortexkit/magic-context/blob/master/docs/dsh-plugin-ui-telemetry-contract.md)。

## 已实现（阶段 0 + 1 + 2）

| 功能 | 机制 | 验证 |
|---|---|---|
| §N§ 标签（仅工具结果） | `tools/post-execute` content 替换，随结果落地自然写入；admission 不打标（用户消息与宿主注入的 runtime-context 保持原样，无回收通道的句柄不再污染记录与标题） | ✅ 集成测试 |
| 用量记录 | 持久 `assistant/message` usage（含 cache 读写）→ node:sqlite，按事件 seq 锚定 | ✅ 集成测试 |
| 压力测量 | 最近 usage 三项和（未缓存输入+cache 读+cache 写）÷ `requestContext.contextWindow` | ✅ 集成测试 |
| execute/defer 决策 | 阈值（默认 65%）或 cache TTL（5m）过期 → execute；否则 defer | ✅ 集成测试 |
| ctx_reduce | 解析 MC 范围语法（"3-5,8"）→ **只入队**（落地是有价 bust，等待回收带——绝不自发 bust） | ✅ 集成测试 |
| 回收带落地 | execute 带内的 pre-step 统一落地：占位符 `[dropped §N§]`（content-only 替换，引用原事件） | ✅ 集成测试 |
| ctx_expand | 从占位符引用的源事件**恢复原文**（恢复的即打标原文） | ✅ 集成测试 |
| 强制回收 + 紧急回收 retry | force band（85%）自动丢弃；`CONTEXT_WINDOW_EXCEEDED` → 丢弃 + `replaceGeneration` 前进即 retry | ✅ 集成测试 |
| **historian** | 一次性 LLM 调用（重放真前缀保 KV cache）→ 四层摘要 p1–p4 + importance + facts/events；**带外运行**，只写 store，不动线缆 | ✅ 集成测试 + 冒烟 |
| **compartments 发布** | execute 带内把被消化区间替换为 `[compacted §C<n>§]`（引用全部原事件，可恢复） | ✅ 集成测试 + 冒烟 |
| **m[0]/m[1] 基线** | 合成 `user/message` 节点（插件 source `magic-context`+`notice`，内容带 `<magic-context>` 标记）承载冻结基线 + 增量；HARD 重建（路由/记忆变化）与 SOFT 增量；**内容未变则零变更** | ✅ 集成测试 + 冒烟 |
| **项目记忆接入** | 只读打开 MC 共享 `context.db`：版本 fence（≤94）、身份匹配、可注入过滤、工作区共享白名单、预算裁剪；注入 m[0] + `ctx_memory` 只读检索工具。**身份自动推导**：`git:<root-commit-sha>`（git 仓库）→ `dir:<md5(path.resolve)>`（对齐 MC，含 Windows 反斜杠语义）；**未配置时用会话 cwd**；工作区成员与共享类别**从库里的 `workspaces`/`workspace_members` 自动解析** | ✅ 单元 10 + 集成 + **真实库只读端到端**（对 `<path>` 解析出 `git:dfbf85f5…`，与库中身份逐字节一致，注入 40 行） |
| **CompactionEngine 替换** | 注入/动态解析基类；`compactIfNeeded`=管理通道（永不写 checkpoint）、`compactNow/compactRegion`=真实 `compaction/start\|summary\|replace\|end` 协议；占用 `ctx.compaction` | ✅ 集成测试 + 冒烟 + 真实进程 meta |
| /ctx-status | 压力/决策/回收台账/compartments/基线/策略 | ✅ 挂载验证 |
| /ctx-recomp | **重做已压缩历史**：`all` \| `last:<n>` \| `<startSeq>-<endSeq>`（区间按 compartment 吸附、绝不切分）；重跑 historian 后**原地替换 store 里的摘要**（身份/覆盖/已落地占位符都不变），下一趟 pre-step 重建基线 | ✅ 单元 7 |
| **维护 tick（MC dreamer 切片）** | 每 30min（`maintenance.intervalMs`）：① TTL 到期行经 `archiveMemory` 契约动作归档（mutation log/authority 守卫全程在环）；② LLM verify——未验证行批量判定，keep→`markVerified`（per-memory `verified_at`，纯元数据）、stale→`updateMemory`、wrong→`archiveMemory`（对齐 MC `dreamer/verify.ts` 的 host-side manifest 语义）；tick 无会话，verify 需显式 `maintenance.verifyProvider/verifyModel` | ✅ 单元 7 + live boot 概要 |
| **journal 自愈** | 挂载时 `recoverOrphanHistorianRuns`：为被 remount 杀死的 historian start 补 `adapter-remount` 合成终局（含 supersede 双 start 场景，`recoveredStartAt` 标记幂等） | ✅ 单元 + live（修复后 180 start/180 terminal） |
| 存储迁移链 | v1（tags/usage）→ v2（pending_drops）→ v3（compartments/baseline_state），版本 fence fail-closed | ✅ 真实进程 v2→v3 |

**同时在线证据**（真实 `dsh --profile mcpoc` 进程写下的 meta）：
`adapter_version=phase2`、`compaction_engine=magic-context-dsh`、`schema_version=3`。

**未实现 / 已知边界**：memory **写入**（需复刻 MC 的 hash/epoch/mutation-log/authority 不变量，刻意留给 MC 自己的存储层；也因此 `ctx_memory` 目前是**只读**召回，与 MC 的同名写入工具语义不同）；记忆的 m[1] 增量面（`maxMemoryId` 水位 / `memory_mutation_log` → `<memory-updates>`）未实现——写入前必须先有它，否则每次写入都会破坏缓存前缀；historian 触发预算用 chars/4 估算而非真 tokenizer；四层摘要在一次调用内产出（MC 是跨调用累积）。项目级记忆的完整复盘见 [docs/dsh-plugin-project-memory-review-2026-10-06.md](https://github.com/cortexkit/magic-context/blob/master/docs/dsh-plugin-project-memory-review-2026-10-06.md)。

## 生产注入路径（已验证，2026-10-06）

在真实 `dsh` 进程里完整注入插件与工具的三个步骤（隔离 DSH_HOME 实测）：

1. **安装为 profile 依赖**：`dsh plugin --profile <name> add <本包路径>`
   （pnpm link 进 profile 的 node_modules；会提示"no dsh.bundle"，正常——
   组合关系由下一步声明）。
2. **组合进 profile 树**：profile 的 `cordis.patch.yml` 加一行按包名引用：
   `- insert: [{ id: magic-context-dsh-poc, name: 'dsh-plugin-magic-context' }]`
   （loader 会把模块解析为插件并读取其 `inject` 声明）。
   **阶段 2 起还需禁用内置压缩引擎**（base bundle 挂载 compaction-basic，
   与我们的引擎同时提供 `ctx.compaction` 会抛错）：
   ```yaml
   - id: compaction-basic
     name: '@deepseek-ai/dsh-compaction-basic'
     disabled: true
   ```
3. **启动**：`dsh --profile <name>`。插件声明 `inject: ['tools']`（loader 等
   待工具服务可用 + 解锁守卫属性访问），apply 内动态导入 defineTool——
   **tsx 的 tsconfig paths 与导入方位置无关**，跨仓库场景也能解析。

成功判据：启动 exit 0 且无 "did not activate" 警告（本插件 fail-closed：
任何注册失败都会显式使挂载失败）。工具实际工作的端到端证明见
`packages/test-support/mc-dsh-poc/src/smoke.ts`（树内 glue，宿主注入
defineTool，真实 agent loop 驱动完整管理闭环，输出 SMOKE PASS）。

两个加载模式的分工：**patch-overlay/文件 URL 模式**（开发期，绝对路径行 +
config.defineTool 注入或 tsx paths 解析）与**profile 安装模式**（生产，包名
行 + link 依赖）。`config.defineTool` 是给树内 glue 的注入接缝——yml 行
只能挂数据配置，函数依赖必须由代码侧 glue 提供。

## 加载验证（三层证据，2026-10-06）

1. **进程内挂载**（真实 Cordis 宿主 + 真实 agent loop，mock LLM）：集成测试
   `poc.spec.ts` 全绿——驱动完整工具调用回合验证四项行为（见下）。
2. **补丁组合路径**：`dsh --profile web --patch cordis.mc-poc.patch.yml --dump-config`
   的组合树尾部出现本插件行（file URL 解析正确）。
3. **真实 `dsh` 进程**（上游源码 checkout，`pnpm dsh`）：
   - `--profile mcpoc`（sdk-minimal 模板 + 本插件 overlay）**exit 0 干净启动**——
     Cordis 挂载语义下，apply() 抛错会使启动失败（同进程的 typert-loader
     失败即如此），exit 0 即全部插件激活成功；
   - 决定性工件：apply() 在真实进程内执行了迁移链并创建了
     `~/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db`
     （schema v1 + meta/tags/tag_counters/usage_records 四表，内容经独立连接核验）；
   - 该 DB 的创建时间戳（21:49:09）甚至早于 mcpoc 启动——对应同一台机器上
     失败的 web profile 启动：**web 进程里本插件同样已激活**（该次失败源于
     上游 typert/客户端构建缺失，与本插件无关；插件先行挂载成功）。
   - 复现：`$env:DSH_HOME=<隔离目录>; pnpm dsh --profile mcpoc --from-default-profile sdk-minimal --dump-config`（初始化）
     然后 `pnpm dsh --profile mcpoc --patch <本包 overlay yml>`。
     overlay yml 拷贝见 harness 工作区 `packages/test-support/mc-dsh-poc/cordis.mc-poc.patch.yml`。

**边界**：尚未在用户正在使用的 Desktop 安装版中加载——那需要打包发布 +
profile 安装（`dsh plugin add`），属阶段 1 交付。且当前 PoC 是**增量式**
（打标/用量/丢弃实验），尚无压力管理与压缩接管——不建议装入主力环境。

## 这个包是什么

把 Magic Context 的上下文管理能力移植到 DeepSeek Harness（DSH）的适配插件。
Phase 0 范围（刻意保持增量式，无压力策略）：

- **§N§ 标签**：只给工具结果打标（`tools/post-execute` 的 accept content 替换）。
  admission 刻意不打标：本适配器的回收通道只解析工具结果标签，用户消息/宿主注入
  上下文上的句柄永远无法兑现，而 DSH 的模型面与 UI 面是同一份 surface——标签会进
  会话记录，并经 `session-title` 的 fallback 变成会话标题（2026-10-08 撤销，
  见 `docs/dsh-port-feasibility-2026-10-06.md` §7.4）。
- **用量记录**：从持久的 `assistant/message` 事件（内嵌 provider usage，
  含 cacheRead/WriteTokens）写入自有 `node:sqlite` 库，按事件 seq 锚定。
- **持久丢弃实验**：surface `replace` 把工具结果替换为 `[dropped §N§]` 占位符，
  引用原事件 seq（= MC 的 ctx_expand 可恢复语义）。

## 目录结构与升级隔离契约（重要）

DSH 处于 developer preview，破坏性变更预期之内；MC 核心也在演进。本包的结构
就是隔离策略：

```
src/
  dsh/    # ← 全包唯一允许 import @deepseek-ai/* 的目录（防腐层）。
          #    事件名、payload 形状、surface 词汇表全部收拢在这里，
          #    DSH 升级只改这个目录。
  core/   # 中性词表与逻辑：types/stores/tagger。不依赖 DSH。
          #    MC 核心接入（阶段 1+）时经其既有 host seams 消费，
          #    与 pi-plugin 复用核心的方式一致。
  index.ts # 组合根：boot probe（fail-loud）→ 接缝监听 → 中性存储。
```

配套纪律：

- **能力探测 fail-loud**：`probeDshSeams` 在启动期校验接缝可用性，不可用即抛错
  （MC 的 fail-closed 传统），绝不静默假装在管理上下文。
- **版本 fence**：自有 SQLite 带 schema 版本链（当前 v1），库比新即拒开
  （对齐 MC `LATEST_SUPPORTED_VERSION` 语义）。
- **测试即探针**：集成测试（见下）同时是接缝契约测试——DSH 升级后重跑，
  破坏点会精确定位到 `src/dsh/`。

## 已验证的事实（上游 master @ 5badb15，代码级）

| 事实 | 出处 |
|---|---|
| `agent/pre-step` 每步触发、可改写 admitted 用户批次 | `packages/core/agent-loop/src/agent.ts:276` |
| `tools/post-execute` 的 accept content 可替换工具结果投影 | `packages/core/tools/src/index.ts:617,1781` |
| surface `replace` 引用 sourceEventSeqs 即可恢复原文 | `packages/core/session/src/types.ts:450` |
| **tool/result 的 surface 替换只允许改 content**（校验器强制） | `packages/core/session/src/surface.ts:456` |
| 请求=日志纯函数（wire 层重写被禁止） | `packages/llm/llm/src/index.ts:67` |
| usage 随 assistant/message 事件持久化 | `packages/core/agent-loop/src/agent.ts:520` |

## 跑测试

套件在本仓库里跑，不再需要 DSH 源码工作区：

```sh
npm install
npm test           # vitest run（30 个 spec）
npm run gate       # 完整门禁：typecheck + 套件 + build + acceptance + memory audit + records
```

`@deepseek-ai/*` 由 `devDependencies` 提供，锁在与本适配器同版本的 DSH 发布线上
（npm 的 `latest` 落后一个发布线，原因见 [NOTICE](NOTICE)）。`tests/helpers/mock-adapter.ts`
从 DSH 测试树内嵌而来，因此不需要 checkout。细节见 [tests/README.md](tests/README.md)。

specs 驱动真实 agent loop（mock adapter）完成一次工具调用回合，断言：
标签持久落地、无额外请求（零额外 bust）、usage 行正确、surface 替换后派生
请求携带占位符且原文可恢复。

只读检查（本机 `node` 直接跑，不需要 DB / 浏览器）：

```sh
node scripts/mc-i18n-check.mjs                 # 多语言：宿主 notice 英文 + 字典键对齐 + 槽位接线
node scripts/mc-records-check.mjs [adapterDb]  # 用真实 journal 验证面板分类（需库文件）
node scripts/dsh-doctor.mjs [--store db] [--json]  # 只读健康报告：fence 余量裁决 / 事件车道心跳 / 悬空 run / 失败尾部 / embedding 车道
```

## 多语言（2026-10-07）

语言开关（设置 → 通用）是**浏览器侧**机制：client 半侧注册 `magic-context` 命名空间字典（zh/en 各 71 键），
四个槽位注册项都声明 `locale: 'magic-context'`，文案一律走框架注入的 `t`，切换语言即时生效、无需刷新。
宿主（node）侧没有 locale 服务，写进会话流、**模型可见**的 `session-notice` 保持英文常量（与其它宿主面
一致，也避免同一会话中途换语言造成 cached prefix 抖动）。机制与理由见
[docs/dsh-plugin-ui-telemetry-contract.md 勘误 §7](https://github.com/cortexkit/magic-context/blob/master/docs/dsh-plugin-ui-telemetry-contract.md)。

## 阶段 1 衔接点（下一步）

1. `ctx_reduce`/`ctx_expand` 工具注册（`ctx.tools.register`），drop 队列写入
   中性存储，bust-eligible 的 pre-step 统一落地（对齐 MC 单一 bust 权限纪律）；
2. MC scheduler 接入：usage 行 → execute/defer 决策 → force band / 95% 墙；
3. 溢出恢复挂 `agent/request-error`（CONTEXT_WINDOW_EXCEEDED → retry）;
4. 存储迁移到共享 `context.db`（`harness='dsh'`），本包 stores 变后端切换。
