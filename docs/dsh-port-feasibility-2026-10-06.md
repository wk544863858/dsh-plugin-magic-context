# DSH (DeepSeek Harness) 移植可行性与方案 — 2026-10-06

状态：可行性已验证（源码级），阶段 0 PoC 进行中。
分析对象：上游 `deepseek-ai/deepseek-harness`（master @ 5badb15，developer preview）；本仓库 `@cortexkit/opencode-magic-context` v0.45.0。

## 0. 结论

**可行，但不是"加一层 wire 变换"那么简单。** DSH 在架构上禁止 magic-context 赖以工作的核心机制——发送前重写消息数组。移植的真实工作是把 MC 的"wire 层临时改写"语义**翻译**成 DSH 的"持久化 surface 变更"语义。两个系统的设计哲学高度同构（都在保护 provider cache），MC 的缓存纪律几乎可以一一映射；MC 的服务层（存储/记忆/historian/dreamer）与宿主无关，可原样复用。

## 1. 根本差异：必须先理解的架构事实

| | OpenCode（MC 现状） | DeepSeek Harness |
|---|---|---|
| 消息数组 | 每次 LLM 调用传入可变数组，插件随意改写 | `session.deriveMessages()` 从**追加式事件日志**派生，请求**深冻结，mutation 抛异常**（`llm/stream` JSDoc："its content is a pure function of the session log… listeners read it, never rewrite it"，`packages/llm/llm/src/index.ts:67-71`；`agent.ts` 的 `buildRequest` 在 `packages/core/agent-loop/src/agent.ts:670-677` 冻结） |
| 历史变更 | wire 层临时（原始历史不动，LKG 回放兜底） | 持久化 surface op：`'append'` 或 `{op:'replace', startSeq, endSeq}` + **必须引用被遮蔽的源事件**（`packages/core/session/src/types.ts:450-464`，注释明示 "Used by compaction; any surface-replacing producer may use it"） |
| 不变量 | defer pass 字节级重放（靠 MC 纪律） | 请求 = 日志纯函数（**结构保证**：deriveMessages 确定性） |
| 缓存失效边界 | MC 自建 pass 分类学 | DSH 原生 `request/header` 的 `startsSeries` + `surface.replaceGeneration` |

MC 的 "drop 留 `[dropped §N§]` 占位符、原文经 ctx_expand 恢复" 与 DSH 的 "replace 节点引用 sourceEventSeqs、replay 可恢复" 是**同一语义的两种拼写**——这是整个翻译可行的基础。

## 2. DSH 侧关键事实（全部经源码验证）

### 2.1 Agent 循环与扩展点

- 循环入口 `ReactLoopAgent`（`packages/core/agent-loop/src/agent.ts`）。每步（step = 一次 LLM 往返）依次：
  1. `ctx.systemPrompt.assemble`（`system-prompt/assemble` 瀑布）
  2. **`agent/pre-step` 瀑布**（agent.ts:276-282）——监听器可 `reject` 或 `enter(messages)` **改写本步 claimed 用户消息**；每步触发一次，等价于 MC 的"每 pass 一次"，且发生在请求派生之前（compaction-basic 即挂载于此，`packages/compaction/compaction-basic/src/index.ts:158`）
  3. `agent/request` 瀑布（只可改 LlmCallConfig，注释明示 "cannot mutate messages"，`core/agent/src/runtime-types.ts:329`）
  4. `session.append` 落 surface（system/message 节点 0、user/message、request/header、request/context）
  5. `deriveMessages()` + deepFreeze → `llm/stream` → 流式响应
- **`agent/request-error` 瀑布**：终态请求失败（含 `CONTEXT_WINDOW_EXCEEDED`）时可返回 `{kind:'retry'}`——compaction-basic 用它做溢出恢复（index.ts:190-234）
- 工具管线：`tools/pre-execute` / **`tools/post-execute`**（`PostToolDecision` 的 `{kind:'accept', content}` 可**替换工具结果投影**，`packages/core/tools/src/index.ts:617-619`）/ `tools/result`
- 事件全集：`agent/created|status|error|inbox/*`、`session/created|disposed|event`（append 即 emit）；`packages/hooks` 的外部进程钩子桥（Claude Code/Codex 方言）仅 5 钩子且 UserPromptSubmit 不能重写消息——不采用

### 2.2 Compaction 是可替换 seam

`ctx.compaction` 为抽象服务 `CompactionEngine`（`packages/compaction/compaction/src/index.ts:119`），一个上下文只装一个实现。内置 `BasicCompactionEngine`（compaction-basic）：压力挂 `agent/pre-step`、溢出挂 `agent/request-error`；机制 = LLM summarize（**复用原对话前缀保 KV cache**，index.ts:238-257）+ 可选 toolResultPruner；落地 = 选中 surface 区间 replace 为一个 compact-checkpoint 用户消息。

### 2.3 用量、模型与缓存信号

- 成功调用的 `assistant/message` 事件内嵌 usage（`TokenUsage = {inputTokens(仅未缓存), outputTokens, cacheReadTokens?, cacheWriteTokens?}`，`packages/llm/llm/src/types.ts:175-187`；agent.ts:520-529 落事件）
- `ctx.tokenMeter.measure(session)` 以 provider usage 为锚定的重放测量（`packages/llm/token-meter/src/index.ts:146,292-321`）
- `request/context` 事件在 provider/model/contextWindow 变更时记录（agent.ts:660-666）——等价 MC 的 `cachedM0ModelKey` 检测
- `request/header` 的 `startsSeries` 与 `surface.replaceGeneration` 提供缓存序列边界信号

### 2.4 存储与宿主环境

- 会话持久化：JSONL（默认 zstd 帧）按 项目key/会话id 分文件；格式 codec 链 v0..v4；插件可经 `ctx.sessions.get/list` 与 `Session.deriveMessages()/eventAt()` 只读
- 插件 = 普通 npm 包，`apply(ctx, config)` Cordis 形态，跑在宿主 Node 进程（引擎 node ^22.19||>=24），**无插件级文件沙箱**；官方 storage-sqlite 用 **`node:sqlite`**（DatabaseSync）——MC 的 `shared/sqlite.ts` 后端选择器已有 Node/node:sqlite 分支
- Desktop 下宿主为 Electron RunAsNode 进程：**原生模块（better-sqlite3/onnxruntime-node）不可跨 CLI/Desktop 移植** → 移植必须全 `node:sqlite`；向量嵌入走 transformers WASM 或降级纯 FTS5
- 工具注册 `ctx.tools.register(defineTool(...))`；隐藏子代理 `ctx.subagents`（in-process spawn：空会话+persona+工具过滤）或 `ctx.agents.create()`；斜杠命令 `ctx.commands.register`；Web UI `ctx.slots`；system prompt `ctx.systemPrompt.section/context`
- 上游 developer preview，明示破坏性变更、无 semver 承诺 → 必须固定上游版本（dsh-desktop 的 submodule pin 模式）；与宿主共享实例的 dsh 包须声明 peerDependencies

## 3. 接缝映射总表

| MC 需要的能力 | DSH 接缝（已验证） | 评估 |
|---|---|---|
| 每 pass 变换时机 | `agent/pre-step` 瀑布（每步一次、派生前） | ✅ |
| 溢出紧急恢复 | `agent/request-error` + retry action | ✅ |
| 用量回报 | `assistant/message` usage + `ctx.tokenMeter` | ✅ 更丰富（含 cache 读写 token） |
| 模型切换检测 | `request/context` 事件 | ✅ |
| 缓存断点意识 | `startsSeries` + `surface.replaceGeneration` | ✅ 原生已有 |
| 原始历史（historian 读） | `session/event` / `deriveMessages()` / JSONL | ✅ disjoint-DB 天然成立 |
| 工具注册 | `ctx.tools.register` | ✅ |
| §N§ 标签 | 用户消息：pre-step `enter(messages)` 改写；工具结果：`tools/post-execute` accept.content 替换；**assistant 文本无法预打标**（落地后才存在）→ 下一个 bust 步 surface replace 补标或放弃 | ⚠️ 已知缺口（**2026-10-08 修订**：用户消息打标已撤销——见 §7.4） |
| 丢弃（drops） | surface `{op:'replace'}` + sourceEventSeqs | ✅ 语义原生对齐 |
| m[0]/m[1] | 见 §4.2 两子方案 | ⚠️ 设计取舍 |
| 压缩引擎 | 实现 `CompactionEngine` 替换 compaction-basic | ✅（替换机制需 PoC 验证） |
| 隐藏子会话 | `ctx.subagents` / `ctx.agents.create()` / 直接 `ctx.llm.stream()`（summarizer 的 KV 保持模式） | ✅ |
| dreamer 定时 | `ctx.effect(setInterval)` + 一次性 agent（`ctx.schedule` 绑会话提醒，不适用） | ✅ |
| 自有 SQLite | `node:sqlite`（MC shared/sqlite.ts 已有该后端分支） | ✅ |
| 命令/UI | `ctx.commands` / `ctx.slots` | ✅ |
| Rust 模式（ck-mc/subc） | 无对应物 | ❌ 跳过，走 TS 路径 |

## 4. 方案

### 4.1 路线 A（推荐）：DSH 原生 surface 模型

新包 `packages/dsh-plugin`（对标 pi-plugin：tsconfig paths 源码映射复用 `../plugin/src` 核心）。

**变换执行器（核心新增件）**：MC 的决策逻辑（scheduler、pass 分类、mutation gates、`mustMaterialize`）原样复用，但输出不是"改写后的数组"，而是**一组待落地的 surface ops**，在 `agent/pre-step` 中执行：

- `ctx_reduce`/age-sweep 丢弃 → replace 为 `[dropped §N§]` 占位节点（引用原 seqs）
- **"搭车 bust"纪律照搬**：只在 DSH 本就要开新序列的步（startsSeries 条件、模型切换、溢出恢复）落地 replace。MC 四条负载不变量原样有效——它们的本质（"字节变更的价格由谁支付"）与宿主无关
- defer 重放不再需要实现：`deriveMessages` 的确定性是结构保证（比 MC 的纪律更强）
- LKG/fail-closed 映射：`DegradedPassRefusalError` → pre-step `reject`；存储 fail-closed → 插件启动时校验 schema fence，失败在 pre-step 挡

**压缩接管**：实现 `CompactionEngine` 注册为唯一压缩实现；MC 的执行阈值/force band/95% 墙保留。

**historian/dreamer**：`ctx.subagents` 一次性子代理（persona = MC historian prompt，工具过滤 = read-only 集）；原始历史读 session log（JSONL 替代 opencode.db 的角色）；dreamer 自建 timer + `ctx.agents.create()`；MC 的 context.db 照旧（`harness='dsh'` 列，SESSION_SCOPED_TABLES 过滤机制原生支持多宿主共存）。

### 4.2 m[0]/m[1] 两子方案

- **(a) surface 化（推荐）**：m[0]+m[1] 作为头部 replace 节点携带（replace 首节点，替换内容含 m0+m1+原文）；HARD fold = 重渲染 m0 节点+重置 m1，SOFT = 仅 replace m1 节点。bust 语义与 MC 完全一致，且持久可见（MC dashboard 可直接读）
- (b) systemPrompt 化：`ctx.systemPrompt.section`（稳定基线 ≈ m[0]）+ `context()` 动态快照（≈ m[1]）。更 DSH 原生；system/message 也是 surface 节点 0，缓存效应相同；但角色是 system 而非 user（MC 选 user 为 Anthropic 断点结构）。备选。

### 4.3 路线 B（不推荐为长期方案）：`llm/stream` 短路中间件

机械可行：冻结对象不可改 → 复制改写后自建 `ctx.llm.stream(改写请求)` 转发 chunk（需递归守卫符号）。唯一保留 MC"不动日志、纯 wire 改写"原语义的路径。**但**违反 DSH reconstructability 不变量的明示精神：真实请求不再可从日志重构、`assistant/message` 记录的 stream 与实际请求脱钩、tokenMeter 失真；developer preview 期间可能被上游封堵。仅作 PoC 期对照实验。

### 4.4 双端演进隔离（硬性设计约束）

DSH 处于 developer preview（明示破坏性变更、无 semver 承诺），MC 核心也在持续
演进。适配层的结构必须保证**任一侧升级都不引发适配层重构**：

1. **DSH 防腐层**：全包唯一允许 `import @deepseek-ai/*` 的目录是 `src/dsh/`
   （seams.ts + probes.ts）。事件名常量、payload 类型收窄、surface 词汇表、
   监听器签名全部收拢于此，以中性类型暴露给其余代码。DSH 升级的修改面 =
   这一个目录。
2. **MC 侧只走既有 seams**：MC 核心对宿主的本就是 seam 化的
   （`TransformDeps`/`resolveTransformHostSeams`，pi-plugin 即此先例）。阶段 1+
   接入时消费这些接口而非内部实现；MC 升级经其自身的 schema fence
   （`LATEST_SUPPORTED_VERSION`）与多宿主共存机制天然兼容。
3. **版本 fence 双向生效**：自有存储带版本链（库比新即 fail-closed 拒开，
   对齐 MC 存储纪律）；DSH 侧用启动期能力探测 + 接缝契约测试（见 4）
   替代版本号判断——能力探测比版本比较在 preview 期稳健得多。
4. **测试即探针**：集成测试驱动真实 agent loop 断言每个接缝的行为形状；
   DSH 升级流程 = 固定新版本 → 跑探针 → 破坏点精确定位到 `src/dsh/`。
5. **上游固定**：对齐 dsh-desktop 的 submodule pin 模式，CI 对 pinned 版本
   跑探针套件，升级是显式动作而非被动漂移。

## 5. 风险清单

1. **上游不稳定**（最大）：developer preview 破坏性变更 → pin 上游版本 + CI 跑 DSH headless 快照测试
2. **Electron ABI**：不用原生模块（node:sqlite 内建）；嵌入强制 WASM 或降级 FTS5
3. **assistant 消息无法预打标**：ctx_reduce 对 assistant 文本回收受限 → bust 步补标（搭车无额外 bust）或放弃
4. **compaction-basic 替换机制**：bundle 层序 base→profile→home 支持覆盖，但替换注册的优先级需 PoC 验证
5. **parity 债务**：参照 Pi PARITY.md（36 条）经验，预计 DSH 亦有 20-40 条（子会话识别、多 profile 并发、无 title 前缀等）
6. Rust 模式不适用

## 6. 分阶段计划

| 阶段 | 内容 | 验证标准 | 估量 |
|---|---|---|---|
| **0 PoC** | 插件骨架 + pre-step 监听 + usage 记录 + §N§ 标签（pre-step 改写 + post-execute 替换）+ node:sqlite 打通 + surface replace 实验 | 标签随消息零成本落地；replace 后 deriveMessages 变化符合预期；compaction 替换可行 | 1-2 天 |
| **1 MVP** | scheduler + ctx_reduce/expand + drops surface 化 + 压力分层 + agent/request-error 溢出恢复 | 长会话压力曲线与 MC 一致；drop 后原文可恢复 | 1-2 周 |
| **2 记忆与历史** | historian + compartment + m[0]/m[1]（surface 方案）+ 记忆注入 + ctx_note/memory/search | 折叠/衰减行为对齐；缓存序列边界符合分类学 | 2-4 周 |
| **3 巩固** | dreamer 全任务 + 向量检索 + /ctx-* 命令 + slots 侧栏 + PARITY.md-dsh + e2e（DSH headless 基建） | 与 OpenCode 版有效行为对齐 | 持续 |

**复用率估算**：`features/magic-context`（MC 大头）约 90% 原样复用；`hooks/magic-context` 决策逻辑约 70%（执行层重写为 surface ops）；`plugin`/`v2`/`pi-plugin` 不复用，新写 `dsh-plugin`（规模预计小于 pi-plugin，无 TUI 桥）。至阶段 2 约 6-10 人周。

## 7. 阶段 0 验收记录（2026-10-06，已完成）

PoC 代码：`packages/dsh-plugin/`（适配层，含升级隔离契约）。集成测试位于
DSH 源码工作区 `packages/test-support/mc-dsh-poc/tests/poc.spec.ts`（驱动真实
agent loop + mock adapter 的完整工具调用回合）。**四项验收全部通过：**

1. **§N§ 标签零成本落地**：用户消息经 `agent/pre-step` enter 决策改写、工具结果经
   `tools/post-execute` accept content 替换；两回合共 2 次模型请求（无额外
   bust），标签为**持久 surface 内容**（非 wire 层临时改写）。
   （**2026-10-08 修订**：admission 打标已撤销——见 §7.4；工具结果部分仍成立。）
2. **usage 记录**：2 行 `assistant/message` 事件（含 inputTokens=10、provider/model）
   锚定事件 seq 写入 `node:sqlite`。
3. **持久丢弃**：surface `replace` 将工具结果替换为 `[dropped §2§]`，replacement
   事件 `sourceEventSeqs=[原seq]`（可恢复原文），原事件仍在日志；**下一个派生
   请求携带占位符而非原文**（deriveMessages 反映变更）。
4. **DSH 校验器的教育**：实现期间 surface 校验器精确拒绝了一次违规替换
   （`tool/result surface replacement may change only content`，surface.ts:456）——
   证实 DSH 的持久化纪律由架构强制执行，适配层必须在它的规则内工作。

升级隔离契约（双端演进不重构适配层）：DSH 接触面全部收拢在 `src/dsh/`
（事件名/payload/surface 词汇表的防腐层）；MC 核心未来经其既有 host seams
接入（pi-plugin 先例）；自有存储带版本 fence；集成测试兼作接缝契约探针。
详见 `packages/dsh-plugin/README.md`。

### 7.1 阶段 1 MVP 验收记录（2026-10-06，已完成）

**管理闭环全部落地并通过真实 agent loop 集成测试**（phase1.spec.ts + poc.spec.ts，
4/4 绿）：压力测量（usage 三项和 ÷ requestContext.contextWindow）→ execute/defer
决策（65% 阈值 / 5m TTL）→ ctx_reduce 只入队 → execute 带内 pre-step 统一落地
`[dropped §N§]` → ctx_expand 从引用事件恢复原文 → force band（85%）保护窗外自动
丢弃 → agent/request-error 紧急回收 + replaceGeneration retry → /ctx-status。
真实 `dsh` 进程（sdk-minimal profile）二次冒烟：exit 0 + **v1→v2 迁移在真实
进程内完成**（pending_drops 表落库）。

阶段 1 的四条工程教训（已固化进代码/文档）：

1. **防腐层的运行时零依赖是载荷-bearing 的**：跨仓库 patch-overlay 加载模式
   下，任何 `@deepseek-ai/*` 运行时导入都会破坏加载。工具构造器改为动态
   导入 + 注入；错误码常量本地定义（漂移由接缝契约测试钉住）。
2. **Cordis 服务访问守卫**：未声明 inject 的插件禁止属性读取（`ctx.commands`
   抛错），可选服务走 `ctx.get()` + 响亮降级。
3. **fail-closed 优于静默半活**：工具注册失败一度被"降级告警"吞掉，导致
   unknown-tool 的隐性失败；改为注册失败即 fail 挂载（registerTools: false
   显式退出）。
4. **vite-tsconfig-paths 只重写静态导入**：动态导入的跨包解析需要显式
   alias（harness 侧 vitest.config 已加）——阶段 2 的 CompactionEngine
   注入会遇到同样问题，解法相同。

### 7.2 插件与工具的正确注入（2026-10-06，目标闭环）

生产注入三步在隔离 DSH_HOME 实测通过：`dsh plugin add`（link 依赖）→
profile `cordis.patch.yml` 按包名 insert → `dsh --profile mcpoc` 启动
**exit 0 且零激活警告**（本插件 fail-closed：注册失败即显式挂载失败，
零警告即完整激活，含 ctx.tools 注册）。

关键机制结论（均已代码级验证并固化）：
- **Cordis inject 语义**：`inject: ['tools']` 声明使 loader 等待服务可用并
  解锁守卫属性访问；裸 `ctx.get()` 是非阻塞查找，不等待（曾在真实 profile
  造成"服务未挂载"误判——fail-closed 抛错让它显性化后定位）。
- **tsx paths 与导入方位置无关**：跨仓库动态导入在真实 dsh 进程内可解析
  （vitest 的失败是 vite-tsconfig-paths 静态重写限制，不代表真实运行时）。
- **defineTool 双路径**：宿主 glue 经 config.defineTool 注入（树内 glue、
  测试），动态导入兜底（profile 安装模式）；两条路都有真实环境验证。
- **Windows ESM**：跨盘绝对路径导入必须 file:// URL（profile loader 本就
  输出该形态；树内 glue 同步采用）。

工具正确工作的端到端证据：`mc-dsh-poc/src/smoke.ts`（真实 Node 运行时，
SMOKE PASS）——echo 打标 §2§ → ctx_reduce('2') 入队（排队 pass 字节不变）
→ 下一 execute 带落地 `[dropped §2§]`（占用请求里原内容消失）→
ctx_expand('2') 恢复带标原文；存储断言（队列清空/用量/标签）全过。

### 7.3 阶段 2 完成记录（2026-10-06）：historian、基线、记忆、引擎

四项建议全部实现并验证；测试 6 文件 23 例全绿 + 双阶段真实运行时冒烟 +
真实 profile 进程取证 + 真实生产库只读探查。

1. **historian / compartments**：`core/compartments.ts`（契约：四层摘要 +
   importance + facts/events 的解析校验、分层衰减、渲染、基线合成/剥离）+
   `dsh/historian.ts`（资格区间选择：跳过 system/基线节点/已覆盖/占位符，
   tool-pairing 边界回退，MC 触发预算 5% clamp[5k,50k]，重放真前缀保 KV
   cache，JSON 失败仅一次修复重试）。**带外运行**：只写 store，线缆零变更；
   发布由 execute 带负责（`[compacted §C<n>§]` 范围替换）。
2. **m[0]/m[1] 基线**：合成 `user/message` 节点承载 `<magic-context>` 标记块
   （`<project-memories>` / `<compartment-baseline>` / `<compartment-delta>`）；
   HARD 重建 = 无状态 / 路由变化 / 记忆摘要变化，SOFT = 增量增长；
   **渲染字节未变则零变更**（no-op pass 不制造 bust，已由集成测试钉住）。
3. **项目记忆接入**：`core/memory-bridge.ts` 只读打开 MC 共享 `context.db`；
   schema fence（`schema_migrations` lane <10000，`LATEST_SUPPORTED_VERSION=94`，
   超前即禁用召回）；`memories` 无 harness 列 = 跨宿主共享；注入过滤
   `status IN ('active','permanent')` + 未过期 + 工作区 `shareable=1` 且
   类别在白名单；优先级 permanent→importance→max(last_seen,verified)→id，
   预算裁剪后按 MC 类别序渲染。**真实库探查**（只读）：schema v94、757 条
   可注入（369 可共享）、按 `git:<sha>` 身份精确召回、工作区共享 10 行。
   **写入刻意不实现**：需复刻 normalized_hash（JS 空白集）、
   `project_memory_epoch` 的 bump 规则、`memory_mutation_log` 与 authority
   guard——这些不变量属于 MC 存储层，分叉会让两个宿主对同一批行产生分歧。
4. **CompactionEngine**：`dsh/compaction-engine.ts` 用注入（或动态解析）的基类
   构造子类并挂载到 `ctx.compaction`；`compactIfNeeded`（压力路径）= 管理通道
   且返回 null（MC 承诺：不为压力写 checkpoint）；`compactNow/compactRegion`
   （手动路径）写真实协议 `compaction/start → summary → 紧邻的 user/message
   替换 → end`。真实 profile：patch 禁用 `compaction-basic` 后，进程 meta
   记录 `compaction_engine=magic-context-dsh`（同时在线的定案证据）。

新增可观测性：adapter 把 `adapter_version` / `compaction_engine` /
`memory_bridge` 写入自有库的 `meta` 表，真实进程可无日志取证。

阶段 2 的三条工程教训：①**重放必须原样传消息对象**——运行时读
assistant 消息的 `source.replayState`（llm/src/index.ts:985），裁剪投影会在
hand-built 调用里炸掉真前缀复用；②**tool-pairing 决定摘要边界**——跨度过短
时 historian 正确地不动作（宁可不动也不能制造悬空 tool 结果）；③**"无变更"
是硬不变量**——基线/发布通道每轮都在跑的代码必须逐字节比较后再决定是否写
surface，否则每个 pass 都是一次全额 cache bust。

### 7.4 修订（2026-10-08）：admission 不打 §N§ 标签，只给工具结果打标

**症状。** 会话记录里出现 `§1§`、`§2§` 一类前缀：用户消息气泡、GUI 的
"Current runtime context" 上下文卡片、以及侧栏标题都带标记。取证（本机会话
`<session-id>-…`，逐 zstd 帧解码）：`seq 9` 的 `user/message` 文本为
`§1§ 一个新的问题：…`；`seq 15` 的 `session/title` 为
`§1§ 一个新的问题：现在会话`（`source: fallback`）；全会话 44 条 user/message
里 41 条带标签，其中 **40 条是宿主注入的 runtime-context**。

**为什么 opencode/pi 不这样。** 它们的标签只存在于"这一次调用的数组"里：
opencode 在 `experimental.chat.messages.transform` 改写 `output.messages`，
pi 在 `pi.on("context")` 返回替换数组（context-handler.ts:1-31）；会话
DB/JSONL 保持原样，所以 UI 与标题派生都看不到。DSH 的请求是日志纯函数
（`deriveMessages()` + 冻结），没有 wire 位点，于是 pre-step 的 enter 决策改写
会随 `session.append('user/message', …)`（agent.ts:419-423）落进日志——而落进
日志就同时是"模型看的"和"UI 看的"，包括 `session-title` 的确定性 fallback：
它取**第一条** `source.kind === 'user'` 的消息文本
（session-title/src/index.ts:131-140, 787-808）。

**同时暴露的真缺陷。** 本适配器的回收通道只认工具结果：`ctx_reduce`/`ctx_expand`
按 `enumerateSurfaceToolResults` 解析标签（tool-bridge.ts:199-216），drop 落地按
`{kind:'tool-result', callId}`（management-pass.ts:437-447），应急回收同理；
`'user-message'` 只出现在分配处与存储里，没有任何消费者。所以用户消息与宿主注入
上下文上的标签是**死句柄**：`ctx_reduce('§1§')` 只会被拒（"no such tool-output
tag on the current surface"，本会话实测两次）。它们只贡献三样东西：污染记录与
标题、占用 tag 号（首条 runtime-context 拿到 §2§）、浪费模型一次被拒调用。

**裁定（已实施）。**
- `dsh/pre-step.ts` 的 admission 打标整段删除；`dsh/seams.ts` 的
  `tagUserMessage` 一并移除（死代码），原位留档说明。
- 工具结果打标保持不变（`index.ts` 的 `tools/post-execute` 分支）——唯一有回收
  消费者的 lane；`ctx_reduce` 描述与 desk 文案改为"只对工具输出"，并删除
  "a large paste inside a user message is fine"（user message 不再有句柄）。
- 回归：`poc.spec.ts` 断言用户消息在请求与 durable 事件里都逐字节干净，并用宿主
  自己的 `fallbackSessionTitle` 钉住标题派生；`phase1`/`journal` 的 tag 序号随之
  下移（首个工具结果从 §1§ 起）。

**遗留偏差（先记录，不修）。** 工具结果卡片仍带 `§N§`——模型必须看见句柄，而
DSH 的模型面与 UI 面是同一份 surface，这是架构性结果。要与 opencode/pi 完全一致，
需要 DSH 上游提供 per-request 投影 seam（或 §4.3 路线 B，已判定违反
reconstructability）。已有会话的旧记录无法回改（标签是持久文本），受影响的只有
标题，可手动改名。

**验证。** 28 文件 / 248 测试全绿（含新回归）；`lib/` 重建（tsc build +
copy-client）；desktop profile 的 `hmr.root` 使宿主半热重载。

**顺带记录的沙箱事故。** 重建时写 `packages/dsh-plugin/**` 被 Windows 文件权限
拒绝（连新建文件都失败，而 `edit` 工具可以写）——是本次会话的沙箱授权在该子树
上缺项，不是仓库问题；用 `diagnose-windows-sandbox-acl` 的单条命令补齐当前用户
完全控制（含回滚脚本，报告在 `<path>`）后
构建恢复正常。

### 7.5 合成节点的 source（2026-10-08 同日追加）

**结论：合成节点不再伪装 `{ kind: 'user' }`。**

**先修正一个我自己的误判。** 我最初说"m[0]/m[1] 基线会以用户气泡显示"——**错**。
替换节点在 Chat 里根本不渲染：`message`/`fallback`/`tool` 三个定义都要求
`isAppendSurfaceEvent`（message.ts:67、fallback.ts:19、tool.ts:303），`command`
定义只认 `source.kind === 'compact-checkpoint'` + `compactionId`
（command.ts:82-92），而 `surface.ts:80-85` 明说"replacement copies stay
model-only"——转写看的是日志里的原始 append，不是 surface。所以基线大块在 GUI
里本来就不可见；我在对话里给出的"会显示成用户气泡"的说法是错的，此处纠正
（§7.4 本身只谈标签，未做该断言）。

**真正的收益（与显示无关）。**
1. **语义**：`session-title` 的 first-user 折叠读的是日志里第一条
   `source.kind === 'user'` 的消息；插件合成节点不该有资格参与这个判定（今天
   靠 seq 顺序侥幸无害）。
2. **manual compaction 的卡片关联**：宿主的 checkpoint source 是
   `{ kind: 'compact-checkpoint', compactionId, sourceCommandId? }`
   （compaction/src/checkpoint.ts:33）；此前我们写 `{ kind: 'user' }`，Chat 的
   `compactSource()` 返回 undefined，压缩卡片无法关联到这次事务。
3. **未来防护**：若宿主某天渲染替换节点，`magic-context` 生产者 + `form:'notice'`
   会渲染成一行折叠上下文行（ContextBody.tsx:551-591 只对 `notice` 读 `summary`），
   而不是冒充用户消息。

**实现。** `dsh/seams.ts` 新增 `magicContextSource(summary)`
（`{ kind:'magic-context', form:'notice', summary }`）与本地镜像的
`compactCheckpointSource(compactionId, sourceCommandId?)`（运行时零
`@deepseek-ai/*` 导入的约束照旧，宿主契约由注释与测试钉住）；
`replaceSurfaceRange` 增加 `source` 参数；三处调用点分别传入——baseline 刷新、
compartment 发布（`management-pass.ts`）、manual checkpoint
（`compaction-engine.ts`）；`session-notice.ts` 改用同一工厂，插件节点的 source
形状从此单源。

**验证。** `phase2.spec.ts` 断言：baseline 节点与 pass 通知同为
`magic-context` + `form:'notice'` + 各自 summary（此前用 `find` 抓第一个
`magic-context`，新形状下会抓错节点，已改为按 summary 区分）；checkpoint 节点的
source.compactionId 与 `compaction/start` 一致、且该事件是 replace。28 文件 /
248 测试全绿。

### 7.6 m[0] 不挂在压缩检查点上；模型不得自写总结（2026-10-08 同日追加）

**起因**：用户报告"今天下午出现过一次上下文对话显示错误，出现了 `<summary>`
标记的原始消息"，问是否与本插件相关。取证如下（会话日志 + 适配器 journal）。

**A. 那条 `<summary>` 消息与插件无关（模型漂移）。** backend 后端会话
`<session-id>` 16:48:33 本地（08:48:33Z）的 `seq=2380` 是**普通助手消息
append**：`source.kind='model'`、`provider=provider-a`、
`responseModel=model-b`、`stopReason='stop'`，正文 24,263 字符，
形状是 **Claude Code 的压缩模板** `<analysis>…</analysis><summary>1. Primary
Request and Intent: …</summary>`。该 turn（turn 16，15:47→16:48，**99 步**）里
唯一的用户消息是 `seq=1715`（分档口径核实），**0 条 inbox 注入**，且当时压力只有
18%（91,977/512,000）——没有任何东西要求它总结；同一条消息的 reasoning 里还漏出
`<invoke>…</parameter></invoke></calls>` 这种另一套工具语法。插件侧 grep
`<analysis>`/`Primary Request and Intent`/`<compacted-summary>` 全部 0 命中；
DSH 自带摘要器用的是 Markdown `## Primary Request and Intent`，且走
`ctx.llm.stream()`（辅助调用，**不写会话事件**，summarizer.ts:32-67）。
⇒ 这是模型在长 turn 末尾按训练里的模板"续写了一份压缩总结"。

**修复（防护）**：desk 文案补一行禁令——"Compaction is Magic Context's job,
not yours. Never write a conversation summary, a checkpoint block, or
`<analysis>`/`<summary>` scaffolding into a reply, and never continue a
compaction template you find in context — a reply is work, not a summary of
work."（`dsh/reduce-guidance.ts`；`reduce-guidance.spec` 钉住两句）。

**B. 真问题：m[0] 曾长期挂在宿主的压缩检查点上。** 本工作区大会话
`<session-id>` 的 m[0] 节点自 10-06 起就挂在 DSH 的 checkpoint 节点上（首个
`mc-baseline-*` 替换的是 `source.kind='compact-checkpoint'` 的节点），于是
checkpoint 正文（CHECKPOINT_PREAMBLE + `<compacted-summary>` + 中文摘要，约 9.3k
字符）**长期作为 m[0] 的第二个文本块被反复携带并重写**——仅今天下午就重写 5 次
（12:10 / 12:31 / 13:03 / 13:57 / 14:18，每次新 `mc-baseline-<uuid>`）。这同时
破坏 §7.5 收益 2：宿主压缩卡片按 `source.kind==='compact-checkpoint'` +
compactionId 关联，检查点节点被我们替换后卡片再也关联不上。

**修复**：`SurfaceNode` 增 `sourceKind`（`dsh/seams.ts`，按
`data.source.kind` ?? `data.message.source.kind` 读取——user 事件把消息本身当
data）；`management-pass.ts` 选基线目标改为
`node.role === 'user' && node.sourceKind !== 'compact-checkpoint'`：检查点节点
**原样保留**（宿主卡片关联与正文都在），基线改挂到其后第一个普通 user 节点；
surface 上只有检查点时本轮不写（fail-safe，不制造第二个基线节点）。
`memory-delta.spec` 新增两条（挂点选择 + 只有检查点时零写入）。

**遗留（有意不修）**：历史上已被吞进 m[0] 的检查点正文不会自动剔除——剔除即丢
上下文（那份摘要是被压缩区间的唯一存留），所以只在旧节点上继续携带；本修复保证
不再新增这种情况。
