# 记忆机制盘点（DSH Magic Context 适配器，v0.4.3 / commit 70418d40c）

> **用途**：后续决策的事实底稿。把"当前实际生效"的记忆机制、判定条件、默认值、不变量
> 与已知偏差按数据流整理在一处，避免再靠翻十几份时间跨度很大的文档来还原现状。
>
> **口径**：以 **代码为准**（`src/` + `package.json` v0.4.3，HEAD `70418d40c`），文档只作
> 旁证；与代码冲突的一律进 §9。锚点 `file:line`；不写未核实的结论，推断项标〔待核〕。
> **证据方式**：Lead 亲读关键路径（配置/策略/评分/类目/stores/检索/工具/召回/lane），
> 另有三名只读副手分片交叉核实（存储与写入、检索与注入、生命周期与治理）。
> §9 中带 ★ 的条目由 Lead 逐条回读代码确认（不是转述）。
>
> 日期：2026-10-09。适配器自有库 schema **v7**；共享 MC 库契约上限 **v95**。
>
> **状态更新（2026-10-13，HEAD `4570fee22`）**——本文件是 2026-10-09 的代码快照（v0.4.3），此后以下事实已变，
> 正文照旧只作历史记录、**不要再据此实施**：
> ① **M3 evidence-verify 已整体退役**（commit `6ceeeac45`）：文中所有 `evidence-verify` /
>    `maintenance.evidenceVerify.{mode,maxRows}` / `memory.evidenceRoot` 条目**作废**（该机制从未离开 off，
>    shadow 零有效数据）；`evidenceMode` boot 开关项与 `evidence-verify` journal kind 同时删除；
> ② S(t) 评分线上已开（profile `memory.scoring.enabled: true`），代码默认值仍 false；
> ③ 全局域 **org 与 machine 均已启用**（machine 另有 LLM 域分类 `autoStage`，adapter 自有库 schema **v10**）；
>    用户画像 collect 与 review 均已开；
> ④ 契约库仍 v94（`MEMORY_SCHEMA_MAX_VERSION=95`，无迁移）；巡检 prompt 已到 v8。
> 现行判据以代码 + [patrol-prompt-v8.md](patrol-prompt-v8.md) 为准。

---

## 0. 一页速览

**两套数据库，别混为一谈**

| | 适配器自有库 | 共享 MC 库 `context.db` |
|---|---|---|
| 路径 | `~/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db`（`stores.ts:177`） | `~/.local/share/cortexkit/magic-context/context.db`（`memory-bridge.ts:62`） |
| schema | **v7**（`stores.ts:21`），v1→v7 迁移链 `stores.ts:186-367` | 上限 **v95**（`memory-bridge.ts:46`）；更高则写路径只读降级 |
| 打开方式 | 读写（自己拥有） | **只读连接读 + 契约形状写**（`memory-bridge.ts` / `memory-write.ts`） |
| 装什么 | tags / usage / pending_drops / compartments / baseline_state / journal / **memory_stats** | `memories`(29 列) / `memory_mutation_log` / `project_state` / `memory_embeddings` / `memories_fts` / `workspaces` 等 |

**四个写入口**：① historian 提升 `promoteFacts`（纯追加）② `ctx_memory` 的
write/update/archive/merge ③ 维护 tick 的 TTL 归档 ④ 维护 tick 的 verify 判定。

**四个读/注入面**：① **T1** 自动注入（唯一写 surface 的路径，只在 **execute 带**发生）
→ m[0] `<project-memories>` + m[1] `<new-memories>`/`<memory-updates>`；
② **T2** `ctx_memory list/get`；③ **T3** `ctx_memory search`（FTS+向量融合）；
④ **T4** `search-hint` 每轮提示（旁路，不进 baseline）。

**治理三层**：类别 TTL（仅 legacy 两类）→ 维护 tick 的 LLM verify → 可选
evidence-verify（`off|shadow|enforce`）。**S(t) 衰减评分默认关**，统计恒采集；开启后
只影响注入排名，**绝不回写共享库**。

---

## 1. 存储层

### 1.1 适配器自有库（`src/core/stores.ts`，schema v7）

| 表 | 关键列 | 用途 |
|---|---|---|
| `meta` | key/value | `memory_bridge`、`memory_write`、`compaction_engine` 等启动自检快照 |
| `tags` / `tag_counters` | session+target → tag_number；每会话单调计数 | §N§ 句柄（30 天剪枝，`tags.retentionDays`；剪枝不动 counters） |
| `usage_records` | `(session_id, seq)` 主键 | provider 用量（压力决策输入） |
| `pending_drops` | `(session_id, tag_number)` | `ctx_reduce` 入队，execute 带落地 |
| `compartments` | `tier_p1..p4`、`facts`、`events`、`landed_event_seq`、v7 `landed_reason`/`superseded` | historian 摘要 |
| `compartment_counters` | 每会话 next id | 摘要编号 |
| `baseline_state` | `epoch`、`node_seq`、`memories_digest`、`max_memory_id`(v5)、`max_memory_mutation_id`+`project_epoch_fingerprint`(v6) | m[0]/m[1] 身份 + 两条增量水位 |
| `journal` | `at`/`kind`/`session_id` 三索引 | append-only 决策审计（Desktop 不持久化 logger） |
| `memory_stats` | `(project_identity, memory_id)` → `hits`/`last_hit_at`/`injections`/`last_injected_at`/`local_archived` | **S(t) 侧车**：共享库记忆的统计只落这里 |

迁移链 `stores.ts:186-367`：v1 基础四表 → v2 `pending_drops` → v3 compartments/baseline →
v4 `journal` → v5 `max_memory_id` → v6 变更游标 + epoch 指纹 → v7 `landed_reason`/`superseded`/
`memory_stats`。版本从 `meta.schema_version` 读，**库比适配器新即 fail-closed**
（`StoreAheadOfAdapterError`，`stores.ts:369-380`）；每步事务化，失败回滚并关闭。

### 1.2 共享 MC 库（只读 + 契约写入）

- 常量：`MEMORY_SCHEMA_MAX_VERSION = 95`（`memory-bridge.ts:46`）、
  `DEFAULT_SHARE_CATEGORIES = ['CONSTRAINTS']`（`:60`）、
  `DEFAULT_MUTATION_PAGE_LIMIT = 1000`（`:57`）、`MAX_MEMORY_REPLACEMENT_DEPTH = 8`（`:54`）。
- **单快照读**：召回/检索都在一个事务里（`memory-bridge.ts:869` + `:998-1006`），
  池查询 / max / 水位看到同一快照，并发写不撕裂 digest。
- **写路径**：`openMemoryWriter`（`memory-write.ts:561`）复刻 MC 契约——29 列投影、
  `normalized_hash` 去重、mutation log、authority 守卫、契约 fence。
- 连接纪律（`memory-write.ts:602-609`）：`busy_timeout → foreign_keys → WAL` 顺序是契约
  （否则 `memory_embeddings` 级联失效）；所有 read-then-write 走 `BEGIN IMMEDIATE`
  （SQLite 的升级锁不受 `busy_timeout` 保护）。
- **明确不写**：`project_memory_epoch`（全仓无 `INSERT/UPDATE project_state`）、
  `context_privilege_state`、`memories_fts`（依赖 MC 自己的触发器）。
- 契约 fence：`schema_migrations` 的 `MAX(version) WHERE version < 10000` 大于 95 ⇒
  写入一律 `contract-version-unsupported`（不抛错），读照常；`describeMemoryWrite()`
  显式区分 `read-only:` 与 `read-write`（`memory-lane.ts:231-241`）——只看 `status.ok`
  会把只读库显示成可写（实测踩过）。

---

## 2. 开关与配置面（决策最需要先看这节）

### 2.1 `memory` **不在** 导出的 `Config` 里

`src/index.ts:689` 的 schemastery `Config` 刻意**不声明 `memory`**（理由 `index.ts:683-687`：
声明会被 schemastery 给每个 profile materialize 出一个 `memory` 对象，而"`memory` 存在"就等于
开桥）。后果：

| 后果 | 含义 |
|---|---|
| GUI 设置卡片**没有**记忆开关 | `memory.enabled`/`autoPromote`/`write`/`scoring.*`/`embedBackfill`/`project`/`shareCategories`/`evidenceRoot` **只能写 profile 的 `cordis.patch.yml`** |
| 语义门 | 配置缺席 → 全关；`enabled:false` → 显式关；**其余任何情况 → 开**（`index.ts:197-199`、`memory-lane.ts:70`） |
| 容易踩 | patch 的 `config` 是**整键替换**不是深合并——手写覆盖行必须把要保留的键一并写出 |
| 不一致 | 同一批键读取风格不统一：`enabled`/`embedBackfill` 走 `liveBoolean`，`project`/`evidenceRoot` 走 `liveValue`，`autoPromote`/`write` 是**裸读**（`memory-lane.ts:88,240,349`；`pre-step.ts:451`）——今天无影响（不声明即非 volatile），但一旦把 `memory` 加进 `Config`，裸读的键改配置**不会热生效** |

### 2.2 `memory.*` 键

| 键 | 默认 | 作用 | 锚点 |
|---|---|---|---|
| `enabled` | 存在即 `true` | 记忆车道总闸（桥/写/召回/工具全在此门后） | `memory-lane.ts:70` |
| `dbPath` | `defaultMemoryDbPath()` | 共享库路径（读写/搜索/桥共用） | `memory-bridge.ts:62` |
| `project` | 未设 → 会话 cwd | 身份（`git:<root-sha>` / `dir:<md5[:12]>`）或目录 | `memory-lane.ts:357-360` |
| `workspaceProjects` | 未设 → 库内 workspace 成员 | 额外共享身份 | `memory-bridge.ts:756-759` |
| `shareCategories` | 未设 → workspace 策略，兜底 `['CONSTRAINTS']` | 共享行类别白名单 | `memory-bridge.ts:60,760,884` |
| `autoPromote` | `true` | historian 事实提升；`false` ⇒ pre-step 不注入提升闭包 | `memory-lane.ts:88`、`pre-step.ts:451` |
| `write` | `true` | `false` ⇒ `ctx_memory` 只读（**但提升与维护仍可写**） | `memory-lane.ts:349` |
| `scoring.enabled` | **`false`** | 只接管注入排名；**统计恒采集** | `memory-scoring.ts:45-61` |
| `scoring.alpha` / `beta` | 0.4 / 0.2 | 命中加成 / 减慢衰减 | 同上 |
| `scoring.archiveThreshold` | 2（1–100 量纲） | 低于此分**停止注入**（仍可 search、`<memory-updates>` 指针仍可解析） | 同上 |
| `scoring.halfLives` | 三类永生；CONFIG_VALUES 60、NAMING 90、USER_PREFERENCES 14、WORKFLOW_RULES/KNOWN_ISSUES 30、ENVIRONMENT 90（天） | 类别半衰期 | 同上 |
| `evidenceRoot` | 未设 → `memory.project`（须真路径） | evidence pass 的 grep 根 | `config.ts:91-95` |
| `embedBackfill` | **代码 `true`**（文档说 false，见 §9-★F2） | 候选内嵌补分（上限 32 行） | `memory-lane.ts:122` |

### 2.3 影响记忆的其它键（这些在 GUI 表单里）

- `policy.memoryBudgetTokens` **8000**、`policy.memoryLimit` **40**（`policy.ts:87-88`）——
  m[0] 的 token 与条数双限；`policy.baselineTokens` 2000 用于 compartment 分区渲染。
- `maintenance.enabled` true、`intervalMs` 1_800_000（30 min，下限 60 s）、
  `verifyProvider`/`verifyModel` 默认空串 = verify 关（`index.ts:706-710`）。
- `maintenance.evidenceVerify.mode` 默认 `off`，`maxRows` 默认 4。
- `searchHint` 默认 true、`sessionNotices` 默认 true、`historianEnabled` 默认 true。
- ~~`policy.compartmentGuardMode` 默认 `observe`、`compartmentEntrantTokens` 200~~ ——
  **发布护栏已于 2026-10-16 退役**（观测窗 0 命中，用户裁决整段删除；本文其余段落为 10-09 台账原文）；
  `forceWaitReadyMs` 0 仍为现行缺省。
- 硬编码不可配置：`CATEGORY_DEFAULT_TTL`、`VERIFY_BATCH=16`、`EXPIRE_BATCH=200`、
  `VERIFY_MAX_TOKENS=32768`、`MAX_FORCED_MEMORIES_PER_DELTA=10`、evidence 四项上限、
  drift `MAX_PROBES_PER_TURN=8`、新行 `importance=50/scope=project/shareable=0`。

---

## 3. 写入路径（四条）

### 3.1 historian 提升 —— `promoteFacts`（主产出）

触发：**发布 compartment 时顺手提升**（`management-pass.ts:350-377`）→
`memory-write.ts:837-917`。调用侧还要求：`memoryWriter` 存在、identity 已解析、
`autoPromote !== false`（`pre-step.ts:451`）、compartment 尚未 land
（`stores.ts:646-649` 的 `landed_event_seq IS NULL AND superseded=0 AND landed_reason IS NULL`）。

门（全部按顺序）：

1. `contractFenced`（MC schema > 95）或 `isAuthorityManaged(identity)` ⇒ **整批跳过**，
   `authorityBlocked:true`（跳过而不是中止会话）。
2. 逐条：类别不在 `PROMOTABLE_CATEGORIES` ⇒ `category-not-promotable`；
   内容 `trim()` 为空 ⇒ `empty-content`。**先全量校验再开事务。**
3. `BEGIN IMMEDIATE` 内：`(project_path, category, normalized_hash)` 命中 ⇒ 只
   `seen_count+1`、`last_seen_at/updated_at` 前移；否则 INSERT
   （`importance=50`、`scope=project`、`shareable=0`、`source_type=historian`、
   `status=active`、`verification_status=unverified`）。
4. **纯追加**：不写 `memory_mutation_log`、不 bump `project_memory_epoch`。
5. `expires_at` 只有 legacy 两类带（WORKFLOW_RULES +90 d、KNOWN_ISSUES +30 d；
   `memory-categories.ts:56-68`）。

**无阈值门**：没有最小 importance、没有 seen_count 门槛、没有置信度/评分闸。唯一的
"价值信号"是 `seen_count≥2` 在维护 sweep 里**跳队**（`memory-write.ts:478-488`）。

**去重键 `UNIQUE(project_path, category, normalized_hash)` 覆盖所有 status** ⇒ 已归档行
被重复事实"喂饱" `seen_count` 但**不会复活**；同义改写会产生第二行。

### 3.2 agent 写路径 —— `ctx_memory`（`tool-bridge.ts:442-728`）

| 动作 | 关键语义 | 锚点 |
|---|---|---|
| `list` / `get`(无 id) | 读召回；命中 id 交 `recordRetrieval` 计数 | `tool-bridge.ts:562-601` |
| `search` | 混合检索，命中计 retrieval + S(t) hit | `:603-643` |
| `get`(有 id) | 单行读**不计**检索（"a row read is not a search"） | `:655-664` |
| `write` | 只允许 **v2 五类**；`source_type:'user'` 硬拒；importance 夹 1..100；hash 命中即 `seen` 去重 | `memory-write.ts:918-978` |
| `update` | 需 id+content；外来行按"不存在"拒（不泄漏存在性）；归档/被取代行拒改；改写连带**删向量与验证**、写 `update` mutation | `memory-write.ts:979-1041` |
| `archive` | 可带 `reason`（并入 metadata）或 `supersededBy`（写 `superseded` mutation）；**不删向量/验证** | `memory-write.ts:1042-1098` |
| `merge` | 同项目、同类别、非归档；计数求和、`permanent` 取或、`merged_from` 链并入；写 mutation；**不删向量/验证**（见 §9-★F6） | `memory-write.ts:1099-1231` |
| `project` 参数 | 跨项目作用域的**唯一**信号；无法解析 ⇒ 结构化拒绝，绝不猜 | `tool-bridge.ts:540-560`；`PARITY.md` §B6 |

**权威守卫**：写前探 `authority_managed`/`authority_repair_pending`
（`memory-write.ts:656-662`），并把事务内触发器 ABORT 转成 `authority-blocked`
（`:785-804`）；`context_privilege_state.enabled` 非 0 时 TS 路径同样让路。
**写路径失败一律返回枚举拒绝、不抛给宿主**（一个 turn 不因记忆故障而失败）。

### 3.3 TTL 归档 与 3.4 verify 判定

见 §6.2。两条都走同一组契约动作（`archiveMemory`/`updateMemory`/`markVerified`），
authority 守卫与 mutation log 全程在环。

---

## 4. 注入路径（T1）

### 4.1 触发：只有 execute 带才召回

`agent/pre-step` → `decidePass`（`policy.ts:146-162`：wireDefects>0 → `wire-repair`；
压力 ≥65 → `execute-threshold`；空闲超 5 min → `cache-ttl-expired`；否则 defer）。
**defer 不做召回**（`pre-step.ts:283` 起的 execute 分支）。召回参数：
`budgetTokens=policy.memoryBudgetTokens`、`limit=policy.memoryLimit`、
`now = baselineState.frozenAt ?? Date.now()`（**用过期的冻结时钟**算 `expires_at`）、
`maxMemoryId = baselineState.maxMemoryId`、`scoring`（`pre-step.ts:305-324`）。

### 4.2 召回池（`memory-bridge.ts:864-1013`）

1. SQL 级可注入性：`status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > now)`；
   **没有 `verification_status` 过滤 ⇒ 未核验的 fact 一经提升就能进 m[0]**（§9-★F7）。
2. 自身身份全量可见；workspace 同伴行额外 `shareable=1 AND scope IN ('project','ecosystem','universe')`，
   且类别必须在共享白名单里（JS 侧过滤）。
3. `share_categories` 解析是 fail-safe：非 JSON 数组、或含任何非 v2 类别 ⇒ **空数组 = 什么都不共享**。
4. 可选关键词过滤（`content`/`category` 子串，仅 `list?query` 走；自动注入不带 query）。
5. S(t) 生效时：`localArchived` 或分数 `< archiveThreshold` ⇒ `retiredIds`，不注入但仍在
   `eligibleIds`（可搜、delta 指针可解析）。
6. **选取顺序** = S(t) 降序（关闭时 MC 类别优先级），**渲染顺序** = MC 类别序 + `updatedAt` 降序。
7. 预算：逐行 `max(1, ceil(len/4))` 估算；**条数到 limit 就 break，单条超预算则 continue 跳过**。
8. 水位拆分：`id <= watermark` → m[0] 池；`id > watermark` → m[1] `<new-memories>`，
   预算 = `max(1, floor(budgetTokens × 0.25))` = 2000。
9. **digest = sha1(m[0] 池的 `id:updated_at`)** —— 注意**不含 content**（§9-★F5）。

### 4.3 基线渲染与重建

分区顺序（`compartments.ts:351-401`）：`<project-memories>`(m[0]) →
`<compartment-baseline>`(m[0]) → **m[1] 起点** → `<memory-updates>` → `<new-memories>` →
`<compartment-delta>`，整块包在 `<magic-context>…</magic-context>`，挂在**最早的
user 节点**（`management-pass.ts:506-531`）；新块与现有块字节相同 ⇒ **不写 surface**（幂等）。

HARD 条件（`management-pass.ts:446`）：
```
hard = previous===undefined || routeChanged || memoriesChanged || epochChanged || cursorUpgrade
```
- `memoriesChanged`：`baseline_state.memories_digest ≠ 新 digest`；
- `epochChanged`：`project_epoch_fingerprint` 变（外部/dashboard 改动、工作区成员变化）；
- `cursorUpgrade`：老库没有 mutation 游标列且有 pending 变更。
- HARD 效果：epoch+1、冻结 `frozenAt` 与新 `maxMemoryId`、冻结
  `maxMemoryMutationId = mutations.currentCursor`、把两条增量吞进 m[0]（`<memory-updates>` 清空）。
- SOFT：m[0] 字节不动，只重建 delta。

增量车道：① 加法 `id > maxMemoryId` → `<new-memories>`；② 变更日志
`id > maxMemoryMutationId` → `<memory-updates>`（只播报 target 在 m[0] 渲染过的行；
`coalesceMutations` 一 target 一行、终态压过后续非终态；supersede 链深 ≤8，解析不出降级
`<removed>`；强制行硬上限 10）。

---

## 5. 显式检索与主动提示

### 5.1 `search` 车道（`core/memory-search.ts`）

- 车道的存在性各自独立：`memories` / `memories_fts` / `memory_embeddings` 缺哪个少哪条
  （`:239-244`），全程 fail-open。
- **id 形状捷径**：`#920`、`920 921`（≤5 token）直接按 id 查（`:274-297`），
  **不受"已可见抑制"影响**。
- **FTS5**：`bm25` 排序取 50 条候选，score = `1/(rank+1)`；严格 AND
  （`sanitizeFtsQuery`）无果再放宽 OR（`relaxedFtsQuery`，≤16 token）；FTS 报错 = 空车道。
- **向量**：只读 `memory_embeddings` 中 `model_id` 与查询同空间的向量；
  缺向量的候选用本地 embedder 现算，**上限 32**（`MAX_IN_MEMORY_EMBEDDINGS`）。
  该 SQL **没有 LIMIT**（§9-F11）。
- **融合**：`0.7·semantic + 0.3·fts`；只有一路时乘 `0.8` 惩罚；score≤0 丢弃。
- **共享空间闸门**（`memory-lane.ts:137-161`）：本地 embedder 必须先对一条真实存储向量
  证明 **cosine ≥ 0.99** 才读共享向量；结果 Promise **进程内只算一次、永不重算**（§9-F12）。
- 本地模型：`Xenova/all-MiniLM-L6-v2`、fp32、**384 维**、max seq 512；WASM 随包，
  首次从 HF 下载（失败切镜像），缓存于插件数据目录 `models/`。

### 5.2 `search-hint`（主动提示）

- 每**用户轮**一次（tracker 以最新用户消息 id 为 key，缓存 64 会话）；文本 <24 字符、
  以 `/` 开头、本身含 `<ctx-search-hint>` ⇒ 静默；上限 3 片段 / 80 字符 / 800 总 / 超时 2 s。
- **FTS-only**（`queryEmbedding:null`），避免冷启动模型拖慢它要服务的这一轮。
- **载体**：作为独立 user-role 消息**放进 admitted batch**，绝不从 waterfall 直接 append
  ——2026-10-09 会话损坏就是直接 append 让提示变成 surface node 0，`foldSurface` 每次重放拒绝日志。
- 结果写 `search-hint` journal。
- **文案指向不存在的工具**（§9-★F1）。

---

## 6. 生命周期与治理

### 6.1 类别 TTL

仅 legacy 两类有 `expires_at`（WORKFLOW_RULES 90 d、KNOWN_ISSUES 30 d）；v2 五类永久。
MC 本体的 dreamer expire 是同一语义的另一条路径（双重归档风险见 `PARITY.md` §C）。

### 6.2 维护 tick（默认 30 min，挂载后 60 s 首跑，单飞）

| 阶段 | 动作 | 默认/上限 |
|---|---|---|
| ① TTL 归档 | `listExpired` → `archiveMemory(reason:'ttl-expired')` | `EXPIRE_BATCH=200` |
| ② 候选 | `unverifiedOnly`，`seen_count≥2` 优先跳队 | `VERIFY_BATCH=16` |
| ③ LLM 判定 | 单次流式调用；失败/截断 fail-open、下次重试 | `VERIFY_MAX_TOKENS=32768` |
| ④ 落地 | `verified`→`markVerified`（写 `verification_status='verified'` + `verified_at`）；`stale`→`updateMemory`；`wrong`→`archiveMemory('verify-wrong')`；`skip` 计数；任意方向可带 `importance`→`classifyMemories`（metadata-only，不写 mutation log） | — |
| ⑤ evidence 复核 | `off`（默认）/`shadow`（只记录）/`enforce`（stage-1 破坏性判定先 deferred，由工作区证据决定；confirmed 执行、overturned→markVerified、uncertain 回退） | `maxRows=4` |
| ⑥ 记账 | journal `maintenance`（expired/verified/updated/archived/scored/pool/lag/evidence/usage） | — |

**路由要求**：`verifyProvider` 与 `verifyModel` **都非空**才跑核验；TTL 阶段不需要路由，
永远执行。**无 LLM 路由时 verify 关闭**（tick 无会话，拿不到会话路由）。
**有意偏差**：MC 的 verify 是 tool-loop（读代码核对），本适配器只做文本判定 ⇒
能发现"记忆自相矛盾/过期"，**不能**发现"记忆与代码不符"。

### 6.3 项目漂移（`dsh/project-drift.ts`）

按轮从最新用户消息里抓最多 8 个未见过的绝对路径，解析各自 git root；与 session root
互不包含 ⇒ `journal.warn('project-drift', …)`。**只有观察**：不阻断写入、不重定向身份。
跨项目事实只能靠模型显式传 `ctx_memory` 的 `project`。遥测进 `mc-report` 的 `drift` 桶，
**没有健康阈值**。

### 6.4 S(t) 退役

`memory_stats` 记录 `hits`/`injections`；`scoreMemory` 只用 `hits`/`lastHitAt`
（**`injections` 不参与评分**）。低于阈值 ⇒ 只在本适配器注入池退休。
`localArchived` 通道**没有写入者**（§9-★F4）；且 `lastHitAt === undefined` 的行**永不衰减**
（从未被显式搜索过的行分数静止在 importance），要跌破 `archiveThreshold=2` 需数月量级。

---

## 7. 观测面

| 面 | 内容 |
|---|---|
| journal kind（`journal.ts:28-52`） | `memory-recall`、`memory-promote`、`search-hint`、`project-drift`、`evidence-verify`、`maintenance`、`tool-call`、`baseline`、`error`…（`memory-stats` 声明了但**从未 emit**） |
| `ctx_memory` 动作 | 全部记 `tool-call`（`tool-bridge.ts:525`），**不是** `memory-write` |
| telemetry summary | `health.promote24h`（**事件数，不是行数**）、`project.memories`、`health.memoryStats`（writer.stats）、`maintenanceLast` |
| mc-report | `memoryRecall`、`memoryLane.{promoteEvents,promotions,seenAgain}`、`maintenance.*`、`maintenance.evidence.*`、`scoringStats`、`drift`、`guard.*`（**drift/noGain 恒 0**，§9-★F3） |
| mc-acceptance | `promotion.contract`、`promotion.appendOnly`、`retrieval.telemetry`、`delta.*`、`epoch.stability`、`authority.guard`、`fence.*` |
| dsh-doctor | fence 余量、事件车道心跳、悬空 run、embedding 车道 |

**健康扳机**（记忆治理唯一被量化的告警线）：verify wrong 率 >30%（judged≥10）、
verify lag 最大 >24 h、晋升 >300 行/天、dream 单日 token >5M、真实溢出、
evidence overturned ≥ confirmed（≥3 拍）。

复跑：`npm run gate`、`node scripts/mc-report.mjs --days 7`、`node scripts/mc-acceptance.mjs`、
`node scripts/dsh-doctor.mjs`。

---

## 8. 载荷性不变量（升级/改动时不要破坏）

1. **m[0] digest 只覆盖 `id <= maxMemoryId` 的池**；加法写入只能进 `<new-memories>`。
2. **提升是纯追加**：不写 `memory_mutation_log`、不 bump `project_memory_epoch`。
3. **代理写也不 bump epoch**；非加法变更走 mutation log → `<memory-updates>`。
4. **显式检索才计数**：`recordRetrieval` 只由 agent 的 list/search 触发，自动注入不得灌水；
   且**故意不写 `updated_at`**（保 `id:updatedAt` digest 稳定）。
5. **契约 fence**：MC schema > 95 ⇒ 写全拒、读照旧，UI 文案必须显示 read-only。
6. **authority 守卫**：module 托管项目永不直写；触发器 abort 转结构化拒绝。
7. **身份归一化唯一实现**：`resolveIdentitySpec` / `normalizeMemoryHash` 全仓一处，
   writer 与 recall 必须同源。
8. **surface 首个节点不可被插件抢**（`search-hint` 的 batch 载体即为此）。
9. **写路径失败必须返回枚举拒绝**，绝不抛给宿主；任何检索/评分/回填失败 fail-open。
10. **`memory_stats` 只写适配器库**；共享库永不为评分而写。

---

## 9. 已发现的缺陷与不一致（决策输入）

★ = Lead 回读代码逐条确认；其余为副手核实（附锚点）。

### P0 —— 影响用户可见行为

| # | 事项 | 证据 | 影响 |
|---|---|---|---|
| ★F1 | **`search-hint` 指向不存在的工具 `ctx_search`** | `search-hint.ts:81`（footer）、`:164`（面板摘要）；实际注册的只有 `ctx_reduce`/`ctx_expand`/`ctx_memory`（`tool-bridge.ts:199,261,442`）。`tests/search-hint.spec.ts:52` 还**断言了这个字符串** | 每轮提示都教模型调用不存在的工具（本会话 `<ctx-search-hint>` 即如此）。修法：文案改 `ctx_memory`（action search）+ 改测试 |
| ★F2 | **`registry` 不匹配：`ctx_memory search` 的 `from`/`to` 被静默丢弃** | `tool-bridge.ts:614-631` 解析并传出，但 `MemoryToolSearch` 类型与实现（`memory-lane.ts:23-30,168-221`）**没有 from/to**，从不转发 | 工具描述承诺的日期过滤**不生效也不报错**。附带：`parseBound` 的三元两分支同值（白检正则），且 `Date.parse('YYYY-MM-DD')` 是 **UTC** 午夜而非注释声称的本地日界 |
| ~~★F3~~ | ~~**`guard.drift` / `guard.noGain` 恒为 0**~~ —— **随护栏退役而失效（2026-10-16）** | 生产者写 `'substantive-entrants'`/`'not-shrinkable'`（`management-pass.ts:282-285`，该块已删除），`mc-report.mjs` 只认 `'drift'`/`'no-gain'` | 遥测失真：`publish-guard-acting` 健康提示（要求 drift+noGain≥5）**永不触发**。护栏已整段退役，本条不再是待修项（report 侧仅保留读历史行） |

### P1 —— 行为/文档不一致，影响决策可信度

| # | 事项 | 证据 |
|---|---|---|
| ★F4 | **`localArchived` 是死开关** | 只有 `stores.setMemoryLocalArchived`（`stores.ts:916-922`）能置位，`src/` 内零调用 ⇒ S(t) 的"本地退役"分支（`memory-bridge.ts:936`）在生产永不成立 |
| ★F5 | **m[0] digest 不含 content** | digest = `id:updated_at`（`memory-bridge.ts:982-984`）。若外部写入者改 content 而不动 `updated_at`，digest 不变（不触发 HARD）但 m[0] 字节已变；适配器自己的 `recordRetrieval` 特意不写 `updated_at`（§8.4） |
| ★F6 | **`merge` 不做"内容变更清空"** | `update` 会 `DELETE memory_embeddings`/`memory_verifications`（`memory-write.ts:1033-1034`，grep 确认这两句只出现在 update 路径），`merge` 只清 `classified_at`/`shareable` ⇒ 合并后的目标带着旧向量参与余弦检索 |
| ★F7 | **注入不过核验门** | 召回 SQL 无 `verification_status` 条件（`memory-bridge.ts:422-435`）⇒ 未核验 fact 一经提升即可进 m[0]；核验只影响后续归档/改写 |
| ★F8 | **溢出通道必然丢提升，且"稍后重试"没有实现** | `index.ts:293` 调 `publishReadyCompartments`，其 `Pick<…>` **不含 `memoryPromote`**（`management-pass.ts:402-406`）；而提升只发生在 `publishCompartments` 的发布循环内（`:350`），候选来自 `listUnlandedCompartments`（`stores.ts:646-649`，落地即排除）。注释（`management-pass.ts:398-400`）声称"facts stay durable … retry is idempotent"，但**没有扫描已落地 compartment 再提升的路径** |
| F9 | **`embedBackfill` 默认值自相矛盾** | 代码 **true**（`memory-lane.ts:122`，注释 `:118-121` 说 0.3.0 起默认开）；`config.ts:96-102`、`PARITY.md` §D、`dreamer-vector-decision.md` §D5、`upgrade-followup.md` 都说 **false**；README 说开启；`tests/` 零覆盖 |
| F10 | **核验一次性** | `markVerified` 永久写 `verified`，候选过滤 `unverified` ⇒ 已核验行永不复核；而 `stale → updateMemory` **不改** `verification_status` 且 `updated_at` 前移 ⇒ 判定振荡时同几行逐拍重判，占满 16 行/拍额度（未在真实数据上确认） |
| ★F11 | **向量车道 SQL 无 LIMIT** | `memory-search.ts:342-347` 只按 `model_id`/status/expires 过滤，FTS 侧有 50 上限 ⇒ 大库时全量向量读入内存，无 telemetry |
| F12 | **共享空间闸门只算一次** | `memory-lane.ts:137-161` 的 Promise 进程内缓存；dominant 变化或首算失败被缓存为 `{modelId:null}` 后**永不重算** |

### P2 —— 文档陈旧（按文档决策会跑偏）

| # | 事项 |
|---|---|
| F13 | README 说 schema v6 / MC v94 / "记忆写入未实现" / 路径 `packages/dsh-plugin/…`；`PARITY.md` 头部说 adapter 0.2.0 / schema v6；`docs/dsh-plugin-memory-acceptance.md` 是 v6/v94 时代数字；`memory-promotion-contract.md` §8.2/§10 说"记忆只进 m[0]"、"autoPromote 默认 false"；`upgrade-followup.md:167` 把 from/to 列为已完成 |
| F14 | 注释级陈旧：`memory-write.ts:8` 说 "live v94 schema"（常量是 95）；`memory-search.ts:28-30` 说"没有 visibleMemoryIds 抑制"（早已实现）；`memory-search.ts:6` 自称 "ctx_search's memory lane" |
| F15 | README 的 journal 表列了 `memory-write` kind（不存在，实为 `tool-call`）；`mc-report.mjs:53` 的 `MAJOR_KINDS` 也含它 |

### P3 —— 死代码 / 只被测试使用的接口

- `stores.setMemoryLocalArchived`（无生产调用者）、`MemoryBridge.maxMemoryMutationId()`、
  `MemoryBridge.projectMemoryEpochFingerprint()`（生产走 `mutations()` 的两个字段）。
- `journal` kind `'memory-stats'` 声明但从未 emit。
- `MemoryWriter.stats()` 的 `mutationLog`/`epoch` 计算了但没人消费。
- `memory-search.ts` 的 `sources` 与 `MemorySearchRequest.from/to` 只有测试驱动。
- `LocalEmbedder.modelId` / `embeddingIdentityHash()` 在 `src/` 无读取点。
- `writeMemory` 的 `expiresAt: null` 无法表达"永不过期"（`?? resolveExpiresAt(...)` 把 null 当未设）。
- promotion 与代理写的 authority 处理不对称：代理写转结构化拒绝，`promoteFacts` 用裸
  `BEGIN IMMEDIATE`，事务内 ABORT 会抛出（由 `management-pass.ts:374-381` 兜住记 error）。

### 其它风险（未定级）

- `memory_stats` 与共享库记忆 id 跨库无 FK，孤儿清理只靠每 pass 的 `pruneMemoryStats`；
  长期不产生 pass 的项目其 stats 不会被清。
- drift 的 `rootCache` 是进程级无界 Map。
- `promote24h` 语义偏窄（事件数 vs GUI 文案"Memories promoted"）。
- evidence `maxRows`：超上限的 stage-1 破坏性判定在 enforce 下不 deferred，直接落下。
- 副手未独立复核 MC 真实库 DDL/触发器（本仓无 MC 源码），相关结论采信
  `docs/dsh-plugin-memory-write-contract.md` 的转述。

---

## 10. 待决策清单（现状 → 选项）

**A. P0/P1 修复是否排期**
1. F1（提示文案指向不存在的工具）：立即修 + 改测试？——影响每次提示。
2. F2（from/to 静默丢弃）：是"实现它"（含本地日界语义）还是"从工具描述里删掉"？
   现在是第三种状态：**承诺了但无效**。
3. F3（guard 遥测键名）：修映射即恢复"守卫是否在起作用"的观测能力。
4. F9（`embedBackfill` 真实默认）：定 true 就补首载延迟/内存 telemetry；定 false 就改代码。
5. F8（溢出通道丢提升）：补"已落地 compartment 的 facts 补提升"的扫描路径，还是明确
   接受"溢出即丢"并改注释/文档？

**B. 已裁定不再做（除非用户改变）**
6. dreamer 调度层 + 7 个 tool-loop 任务（`dreamer-vector-decision.md` D1）。
7. `promote-primers`：整条 primer 管线缺生产端/消费端，列为**产品决策**，决策前不排实现。
8. curate/verify/expire 不在本适配器复刻（双重归档风险，`PARITY.md` §C）。

**C. 观察项（有数据才决策）**
9. `project-drift` 频率 → 是否做 per-fact ownership / session_projects（`PARITY.md` §E）。
10. verify 命中率与 429 配额 → 是否评估 `verify-broad`。
11. 物理 TTL 清理（行已归档但字节仍占盘）→ 需要一条裁定。
12. MC↔DSH 存储兼容观察 R3–R9（TTL 不对称、owned-path 相等性、git 故障回退、
    符号链接目录、缺失向量）。
13. S(t) 的 `enabled` 是否要 shadow→enforce 的观察窗（现在只有布尔开关），以及
    "从未被搜索过的行永不衰减"是否需要修（F10 同族）。

**D. 结构性缺口（宿主限制，非本仓可解）**
14. per-request projection seam（`PARITY.md` §C）：没有它，§N§ 只能留在工具结果上。
15. `protected_tools` holds / watermark age reclaim / `edit-marker` / historian 校准锚点 /
    tokenizer 校准——"要不要按产品决策补"的清单。

---

## 11. 文档地图（哪份看什么，新鲜度）

| 文档 | 内容 | 新鲜度 |
|---|---|---|
| `docs/dsh-plugin-memory-write-contract.md` | **MC 存储契约权威**：29 列、hash、状态/scope、索引、触发器 | 有效（写路径依据） |
| `docs/dsh-plugin-memory-promotion-contract.md` | 提升契约 + 只读实测 | MC 侧有效；§8.2/§10 已过时 |
| `docs/dsh-plugin-memory-acceptance.md` | 一键验收 + 实测证据 | 机制有效，数字是 v6/v94 时代 |
| `docs/dsh-plugin-dreamer-vector-decision-2026-10-08.md` | 取舍决策记录（D1–D5 + §6 修正） | 有效；D5 的"默认关"与代码不符 |
| `docs/reports/memory-solutions-comparison.md` | Engram/Hindsight/OpenViking/Honcho 对比 + 可借鉴 10.1–10.8 | 有效（研究） |
| `PARITY.md` | DSH↔上游差异裁定 | 内容有效；**头部版本表陈旧** |
| `README.md` | 安装/机制/观测总览 | **多处陈旧**（F13/F15） |
| `docs/dsh-plugin-upgrade-followup.md`、`hooks-coverage`、`ui-telemetry-contract`、`config-ui-contract`、`surface-write-audit` | 升级流程、接缝清单、UI 契约、surface 写入顺序审计 | 各自领域有效（upgrade-followup:167 有误） |
| **本文** | 记忆机制现况 + 缺陷 + 待决策 | 2026-10-09 / v0.4.3 / `70418d40c` |

---

## 附：本次盘点的覆盖与局限

- **Lead 亲读**：`config.ts`、`policy.ts`、`memory-scoring.ts`、`memory-categories.ts`、
  `volatile.ts`、`stores.ts`（schema 与候选过滤）、`memory-lane.ts`（全文）、
  `memory-bridge.ts`（mutation 与 recall 核心）、`memory-search.ts`（常量/车道/融合）、
  `memory-write.ts`（提升与四动作）、`tool-bridge.ts`（三工具全文）、`search-hint.ts`（全文）、
  `index.ts`（记忆装配与 boot）、`management-pass.ts`（提升调用/HARD 条件/发布守卫/溢出入口）。
- **副手核实**：maintenance 与 evidence 的逐行细节、writer 的 SQL/常量表、mc-report 桶映射、
  drift 判定、telemetry 字段。
- **未覆盖**：historian 提示词逐行、`evidence-verify.ts` 判定阈值细节、
  `tests/memory-write.spec.ts` 的边界矩阵；MC 上游源码不在本仓，凡"与 MC 一致"的说法
  只能核到本仓注释与契约文档。
