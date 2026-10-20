# 上游 Magic Context v0.46.1 源码分析：画像机制 与 workspace 机制

> **取源**：`git clone --depth 1 --branch v0.46.1 https://github.com/cortexkit/magic-context .upstream/magic-context`
> （3696 文件 / 76 MB，已加入本仓 `.gitignore`，只读分析、不提交）。
> 适配器自身的 parity 目标此前记为 **v0.46.0**（`PARITY.md` 头部），本次多取一个补丁版；
> 文中锚点均为相对 `.upstream/magic-context/` 的路径。
>
> **目的**：为"全局记忆"实验特性提供事实基础 —— 上游到底有没有全局记忆、
> 画像通道能不能借用、workspace 能不能承载"组织全域"。

---

# A. 用户画像机制（user profile / user memories）

## A.1 定位：这就是一条"跨项目全局记忆"通道

上游把**关于人的行为模式**单独做了一条线，与项目记忆（`memories` 表）**完全分离**：

- 它不存在 `memories` 表里，有自己的两张表（`user_memory_candidates` / `user_memories`）；
- 它**不属于任何项目**：版本号挂在 `project_state` 的保留行 `__global__` 上
  （`GLOBAL_USER_PROFILE_PROJECT_PATH`，`packages/plugin/src/features/magic-context/storage-project-state.ts:3`）；
- 它**注入到每一个会话**（不分项目），走 m[0] 的 `<user-profile>` 与 m[1] 的 `<new-user-profile>`；
- 它的 reviewer 租约是**全局域**，不是 per-project：
  `"user-memories is GLOBAL (mutates the cross-project user-profile pool, so two different projects' dreamers must not review concurrently)"`
  （`.../dreamer/task-registry.ts:276-281`）。

**一句话：上游已经实现了"无主、全局、有版本、有增量"的记忆通道；我们想要的组织级全局记忆，形态与它同构，但内容域不同。**

## A.2 数据模型

建表在 `.../features/magic-context/migrations.ts:385-413`（migration v3）：

```sql
CREATE TABLE IF NOT EXISTS user_memory_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_compartment_start INTEGER,
    source_compartment_end INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_umc_created ON user_memory_candidates(created_at);

CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    promoted_at INTEGER NOT NULL,
    source_candidate_ids TEXT DEFAULT '[]',          -- JSON 数组
    source_candidate_provenance TEXT,                -- 后加列（v77 迁移）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_um_status ON user_memories(status);
```

`source_candidate_provenance` 是**证据链**：提升时把每条候选的
`(candidate_id, session_id, source_compartment_start, source_compartment_end)` 快照进目标行
（`.../user-memory/storage-user-memory.ts:124-165` → `loadUserMemorySourceProvenance` /
`serializeUserMemorySourceProvenance`）。也就是说：**每条全局记忆都保留"它从哪些会话、哪段
compartment 归纳出来"**，候选行被消费删除后证据仍可追溯。

**没有唯一键**：`content` 无 UNIQUE，去重完全靠 reviewer 的语义判断。

## A.3 采集：候选从哪来

两条来源，都是"独立观察"而非"结论"：

1. **historian 的 `<user_observations>`**（主来源）。
   - 提示词把它列为五类产出之一：*"universal behavioral patterns about the human user, fed to a
     separate dreamer review pipeline that promotes recurring patterns into stable user-profile
     memories"*（`.../hooks/magic-context/historian-prompt.source.md:30`）。
   - 写入点：`.../hooks/magic-context/compartment-runner-incremental.ts:1313-1337`，
     每条候选带 `sessionId` + 该批 compartment 的 `startMessage`/`endMessage`；
     **只有 `deps.experimentalUserMemories === true` 且不是"未锚定的 wrapup 块"时才写**
     （注释明确：门控是为了隐私 —— 不会为退出该特性的用户持久化行为候选）。
   - 失败只记 session log，不影响 compartment 发布（`:1334-1336`）。
2. **retrospective 学习任务**：`.../dreamer/retrospective-learnings.ts:201` 也调
   `insertUserMemoryCandidates`。

采集侧**不做去重、不做频率限制**，靠 TTL + review 收敛（见 A.6）。

## A.4 提升门：`review-user-memories`

实现在 `.../user-memory/review-user-memories.ts`（454 行）。完整判定链：

| 步骤 | 规则 | 锚点 |
|---|---|---|
| 0. 先衰减 | 删除 `created_at < now - 30d` 的候选（`USER_MEMORY_CANDIDATE_TTL_MS`） | `storage-user-memory.ts:10,110-120`；`review-user-memories.ts:109` |
| 1. 数量闸 | `candidates.length < promotion_threshold` ⇒ **整轮跳过**（默认阈值 **3**） | `:114-120`；默认值见 `storage-user-memory.ts:5-9` 的注释 |
| 2. 上下文 | 把全部候选 + 现有 active 画像喂给 reviewer | `:122-134` |
| 3. 语义闸 | 提示词要求："A candidate must appear in至少 N semantically similar variants before promotion" —— **不是哈希相等，是语义相似** | `:148-149` |
| 4. 领域闸 | 只提升"truly universal"：沟通风格、专业程度、审查关注点、决策模式、工作习惯；**明确禁止** project-specific preferences / framework choices / one-off moods / task-local frustrations | `:150-151` |
| 5. 输出契约 | 单个 JSON：`promote[]` / `update_existing[]` / `dismiss_existing[]` / `consume_candidate_ids[]`；截断即解析失败并重试（fail-closed） | `:36-45,55-72,157-179` |
| 6. 消费语义 | **所有被评审的候选一律删除**（promoted / merged / rejected），且 reviewer 漏列时也会把 promote/update 引用的候选并入消费集（防重复提升） | `:177,398-406` |
| 7. 写入 | 租约保护下写：insert → update → dismiss → delete candidates；**有任何变更才 bump 版本** | `:411-431` |
| 8. 租约 | 全局 `user-memories` 域租约 + 心跳；租约丢失即 abort，抛错让调度器热重试 | `:217-228,340-352` |
| 9. 失败语义 | 抛错（不吞）—— 否则调度器会推进 `next_due_at` 跳过未处理的工作 | `:340-352` |

**关键点：`promotion_threshold` 是"要不要开始评审"的闸，不是"提升几条"的配额**；真正的
判别由 LLM 做，且要求跨会话/跨 historian 运行的复现。

**但模型侧的"≥N 个语义相似变体"没有任何校验**（分片核实）：宿主门只数
`candidates.length < promotionThreshold`；提示词第 2 条的要求是**纯模型自律**，
`applyReviewVerdict` 落地时也只过滤 `content.trim().length > 0`，**不检查
`candidate_ids` 长度**。⇒ 一条候选 + 模型一句话，就能落地一条稳定画像。

**渲染顺序的确定性**：`getActiveUserMemories` 用 `ORDER BY promoted_at ASC, id ASC`，
注释写明"否则 `<user-profile>` 渲染顺序在多次 pass 间不确定，会漂移 m[0]/m[1] 字节"
（`storage-user-memory.ts:195-202`）。这是缓存前缀纪律在画像通道上的复刻。

## A.5 渲染：m[0] 基线 + m[1] 增量

两侧都有，需要分清：

| 位置 | 块 | 内容 | 预算 |
|---|---|---|---|
| **m[0]** | `<user-profile>` | 全部 active 画像，`- ` 前缀，渲染时剥掉冗余主语（"User " → 大写首字母） | `DEFAULT_USER_PROFILE_BUDGET_TOKENS = 4_000`，超预算**跳过**而不是截断（`trimUserMemoriesToBudget`） |
| **m[1]** | `<new-user-profile>` | 全局版本号变化时重渲染全部 active 画像 | 基线的 **25%** = 1_000 |

锚点：`inject-compartments.ts:1151`（预算常量）、`:2279-2287`（`renderUserProfileBlock`）、
`:2077-2090`（`trimUserMemoriesToBudget`，逐条 `estimateTokens + 4`，超预算 continue）、
`:2334-2340`（m[0] 位置：project-docs 之后）、`:3005-3023`（m[1] 增量整块渲染）。

m[0] 分区顺序（同文件）：`<project-docs>` → **`<user-profile>`** → session-history →
`<project-memory>` → …；m[1] 分区顺序：`<memory-updates>` → `<new-compartments>` →
`<new-memories>` → **`<new-user-profile>`** → `<compartment-delta>`。

**版本号不是 HARD 触发器**（`inject-compartments.ts:1929-1934`，逐字）：

> NOTE: project_user_profile_version is deliberately NOT a trigger. Additive user-profile
> promotions surface in m[1] via renderM1's `<new-user-profile>` delta (version-watermark),
> exactly like new compartments and memories. A version change must not fold m[0]; the delta
> reconciles into m[0] on the next HARD fold. Destructive profile edits route through the same
> delta plus the project_memory_epoch path for external (dashboard) mutations.

即：**画像的加法变更永远不破 m[0]**，靠 `cached_m0_project_user_profile_version` 与
`project_user_profile_version` 的差值渲染 delta；只有 dashboard 的破坏性编辑（走
`project_memory_epoch`）才会 HARD fold。

版本 bump 的 SQL（`storage-project-state.ts:85-103`）：默认写 `project_path = '__global__'`，
`project_user_profile_version = project_user_profile_version + 1`。

## A.6 生命周期与管理面

- **候选 30 天 TTL**（`:110-120`）；注释解释了为什么是 30 天：review 每日跑、阈值 3，
  真实特质以"天到周"的节奏复现，30 天足以让真模式凑齐变体，同时清掉一次性噪声。
- **dismiss**（软删）：`status='dismissed'`；**delete**（硬删）；**update**（改内容）。
- **Dashboard**：`get_user_memories` / `get_user_memory_candidates` /
  `promote_user_memory_candidate` / `dismiss` / `delete` / `update`
  （`packages/dashboard/src-tauri/src/db.rs:8345-8500`，命令注册 `main.rs:106-107`）。
  人工可以**直接把候选提升为画像**，绕开 reviewer —— 这就是"人工确认"通道。
- 并发：两个项目的 dreamer 不会同时评审（全局租约，A.1）。

## A.7 护栏（对我们最有参考价值的三条）

1. **隐私门控**：候选写入受特性开关约束，opt-out 用户的行为观察根本不落库（A.3）。
2. **home 目录隔离**：workspace 明确拒绝把 home 目录加为成员
   （"Home sessions are intentionally isolated from workspace memory sharing"，
   `packages/dashboard/src-tauri/src/workspaces.rs:653-657`）——上游用"域隔离"保护最私密的上下文。
3. **画像不得被当成项目记忆处理**：curate 的归档/改写安全门里有一条专门理由
   `"user-profile-is-not-project-memory"`（`.../dreamer/curate-memory-safety.ts:7,59-68`），
   外加通用的 `directive-shaped-project-rule` 拒绝（`:71-77`）。
   **注意后者对我们有直接影响**：上游会拒绝"指令形状的项目规则"被 curate 改动。

## A.8 对"全局记忆"最有用的五条结论

1. **形态可以直接借用**：候选池（带 session/compartment 溯源）→ 复现闸 → LLM 或人工裁决 →
   独立表 → 版本驱动的 m[1] 增量 + m[0] 基线。
2. **"复现"是被验证过的信号**：上游用"≥N 个语义相似变体、跨会话"来判"这是真模式"。
   我们的组织知识可以升级成更强的形式：**跨 project_path 复现**（上游的画像不区分项目，
   所以它拿不到这个信号，我们能）。
3. **加法不破缓存靠版本水位**，与 `maxMemoryId` 完全同构 —— 我们实现全局记忆时可以照抄。
4. **预算独立且很宽**：画像基线 4000 token（对比项目记忆 8000），增量 25%。
5. **人工通道已存在**：dashboard 可以直接把候选变成正式条目 —— 我们要的"只允许人工确认"
   不需要新发明，只需要在 DSH 侧接上（且目前适配器 0 覆盖这条通道）。

## A.9 补遗：画像深挖的追加事实（分片核实）

**(1) 采集与评审被硬耦合（Option C）。** 候选写入的门是
`userMemoryCollectionEnabled(dreamer)` = `dreamer.tasks["review-user-memories"].schedule !== ""`
（`dreamer/task-config.ts:64-73`）。后果三条：① **不可能只采集不评审，也不可能只评审不采集**；
② 关掉评审任务 ⇒ 已有候选既不被消费**也不被 decay**（`pruneExpiredUserMemoryCandidates`
的唯一调用者就是 `reviewUserMemories`）⇒ 候选无限堆积直到会话被删；
③ 关掉评审**不影响已落地画像的渲染**（渲染门是 `memory.enabled`，不是该任务开关）。
另注：historian 的**系统提示词永远描述 `<user_observations>`**，功能关了也照描述，
只为保住 prompt 字节稳定（`packages/plugin/src/index.ts:1136-1139`）——模型照产，runner 丢弃。

**(2) `user_memories` 有两处不安全缺省。**
① **`status` 无 CHECK 约束**（同文件的 `primers` 有），而 TS 的 `parseUserMemoryRow`
把一切非 `'dismissed'` 都当 `'active'`（`storage-user-memory.ts:288`）⇒ 库里若有
`'archived'` 一类脏值，**会被当作 active 渲染出来**（Rust 测试里就用了 `'archived'` 当"非激活"样本）；
② **表没有任何 project 维度**（这是设计意图："apply everywhere"，`crates/mc-store/src/lib.rs:672-675`），
所以它天然就是"全局池"——也正是它不能承载组织知识的原因之一。

**(3) m[0] 里的旧画像是"不可回收"的（对全局事实是致命的）。**
版本变化**不是 HARD 触发**（A.5 引文），所以 dashboard 删除/改写一条画像后，会话会
**同时**看到 m[0] 的旧 `<user-profile>` 和 m[1] 的新 `<new-user-profile>`，直到某次**无关的**
HARD fold 才合并。个人画像错了只是"画像不准"；**一条已被证伪的组织事实会在此后每一轮继续被注入**。
⇒ 我们做全局记忆时**必须**二选一：把全局事实的变更提升为 HARD 触发，或把 m[1] 做成真正的增量
+ 显式"已被取代"清单。

**(4) 增量上屏还要等一次 cache-busting pass。** 画像 bump 本身**不是** ride 信号
（`cache-busting-signals.ts:52-60` 只认 hardFold/force/explicitFlush/publishedHistory/subagentExecute），
defer pass 直接回放已持久化的 m[1] 字节。⇒ 03:00 晋升的画像要等下一次 historian 发布 /
TTL hard fold / execute pass 才进上下文。

**(5) TS 与 Rust 的 m[1] 画像语义不同（无文档解释）。** TS 拿"m[0 基线版本 ≠ 当前版本"判，
**每次 cache-busting pass 都重发整份画像**（内容无语义变化时字节相同，所以不破缓存，但白费 token）；
Rust 用独立的持久化水位 `m1_user_profile_version`，**只发一次**，且空块不推进水位以免丢增量
（`crates/mc-module/src/m1_compose.rs:507-525`）。

**(6) 溯源有几处缺口。** ① 候选的 `source_compartment_start/end` 是**整批共享一个区间**
（chunk 级，不是每条级）——与 primer 候选的逐条 `at_compartment` **不对称**；
② dashboard 手工晋升**不写 `source_candidate_provenance`**（留 NULL）且不做 verb-first 归一化
（`db.rs:8462-8489`），与 `insertUserMemory` 不一致；③ `source_candidate_provenance`
看起来**只写不读**（dashboard SELECT 不含它，渲染路径也不消费）；
④ 会话删除会连带删掉该 session 的候选行，"来自哪段对话"只剩画像行里那份 JSON 副本。

**(7) 其它生命周期缺口。** TS 侧**没有画像硬删除**（只有 dashboard 能真删）；被 dismiss 的特质
对 reviewer 不可见 ⇒ **可以再次以新行晋升**（没有"否决记忆"）；候选写入无去重、无频率限制
（Rust 模块路径有"全列精确匹配"的**重放幂等**检查，但不是语义去重）。

**(8) 配置的实际形态（v1→v2 迁移后）。**
`dreamer.tasks["review-user-memories"].schedule` 默认 `"0 3 * * *"`（每日 03:00，`""` = 禁用）；
`.promotion_threshold` 默认 `3`、范围 **[2, 20]**；**两者都在"项目层禁用名单"里**
（`config/schema/magic-context.ts:1634-1635`）—— 被克隆的仓库不能自行打开或调阈值。
v1 的 `user_memories.enabled:false` 在迁移里被折成 `schedule: ""`。

**(9) 一条 TS 注释与实现相矛盾**：`inject-compartments.ts:1933-1934` 声称 dashboard 的破坏性画像
编辑会走 `project_memory_epoch` 路径，但 dashboard 四个 user-memory 命令**只 bump profile version**，
`bump_project_memory_epoch_for_identity` 的唯一调用者是 workspace 变更（`workspaces.rs:313`）。

---

# B. workspace 机制

## B.1 数据模型

migration v34（`.../migrations.ts:1518-1541`）：

```sql
CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    display_path TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, project_path)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);
```

migration v35（`:1591-1618`）补 `workspaces.share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'`。

**两条硬约束（对设计影响最大）**：

1. `idx_workspace_member_unique` on `project_path` ⇒ **一个项目只能属于一个 workspace**。
2. `idx_workspace_member_name` on `(workspace_id, display_name)` ⇒ 同一工作区内显示名唯一。

## B.2 解析：身份集合与共享类别

- `resolveWorkspaceIdentitySet(db, identity)`（`.../features/magic-context/workspaces.ts:164-200`）：
  `workspace_members` **自连接**（anchor 与 member 同一个 workspace_id），返回**同一工作区的
  全部成员身份**；不在任何工作区则返回 `[自己]`。
- `expandWorkspaceIdentitySetWithAliases`（`:206-240`）：再并上 `v22_identity_rekey_map`
  的历史别名（身份迁移后老 `project_path` 仍算同一项目）。
- `resolveWorkspaceShareCategories` / `selectWorkspaceShareCategories`（`:99-162`）：
  **fail-closed 解析**：
  - 不是工作区成员 ⇒ `null`（不共享）；
  - `share_categories` 为 NULL/缺失 ⇒ 默认 `["CONSTRAINTS"]`；
  - 不是 string / 坏 JSON / 不是数组 / **含任何非 v2 五类** ⇒ `[]`（什么都不共享）并 warn；
  - 合法 ⇒ 去重 + 排序。
- 只有 v2 五类（PROJECT_RULES / ARCHITECTURE / CONSTRAINTS / CONFIG_VALUES / NAMING）
  可以出现在白名单里（`VALID_SHARE_CATEGORIES = new Set(V2_MEMORY_CATEGORIES)`，`:32`）。

## B.3 可见性：跨项目谓词与 `scope` 的真实地位

`FOREIGN_VISIBLE_SQL`（本仓 `docs/dsh-plugin-memory-write-contract.md:362-372` 转述，与
`packages/plugin/src/features/magic-context/memory/visibility.ts` 一致）：

```sql
status IN ('active','permanent')
  AND (expires_at IS NULL OR expires_at > :now)
  AND shareable = 1
  AND scope IN ('project','ecosystem','universe')     -- ★ 三值同权
  AND category IN (workspace 白名单)
  AND project_path IN (该 workspace 的成员)
  AND project_path <> 读者自己
```

**`scope` 不产生任何特权**：`universe` 与 `project` 在可见性上等价。真正决定"能否跨项目"
的是 `shareable=1` + **同工作区成员** + 类别白名单。

**`shareable` 的唯一合法写入者是 MC 的 classify 任务**，且内容一变就 fail-closed 归零
（见本仓契约 §4.3）。⇒ 任何"写全局记忆"的路径都要面对这条规则。

## B.4 成员变更：唯一生产写入者是 Dashboard

全仓 `INSERT INTO workspace_members` 的**生产调用点只有 dashboard**
（`packages/dashboard/src-tauri/src/workspaces.rs:792`；其余全是测试与迁移）。
`apply_workspace_changes`（`:611-839`）的语义：

1. **home 目录禁止加入**（`:653-657`）：`is_user_home_workspace_member` 同时按
   `dir:<md5(home)>` 身份和 canonical path 双重判定（`:841-860`）。
2. 显示名校验 + 同工作区内唯一（`:733`）。
3. **一个项目只能属于一个 workspace**：加成员时先查 `SELECT workspace_id FROM
   workspace_members WHERE project_path=?`，已在别的工作区即报错
   "This project already belongs to another workspace."（`:684-706`）——与 B.1 的唯一索引一致。
4. 删除工作区会先 fan-out bump 旧成员的 epoch（`:600-608`）。
5. **成员/显示名/共享类别任一变化 ⇒ 对 old∪new 全体成员各 bump 一次
   `project_memory_epoch`**（`:830-835`），注释称这是缓存不变量 —— 每个成员都需要一次
   fold 机会；纯改名/无变化的保存不得churn 成员 epoch。
6. 整个过程在一个 `BEGIN IMMEDIATE` 事务里。

**补正（分片核实）**：上述 fan-out 的**生产实现只在 Rust/dashboard 侧**（`bump_epochs_for_workspace_mutation`，`workspaces.rs:308-334`，调用点 `:830-835`）；插件 TS 侧的 `bumpEpochsForWorkspaceMembers`（`workspaces.ts:372-396`）虽然导到 facade，但 **v0.46.1 没有任何生产调用者**（只有测试与 migration v35 用的 `…MemberSet` 变体，`migrations.ts:1633`）。
另外两条语义细节：① **工作区改名不 bump epoch**（名字不渲染进 m[0]/m[1]，只有成员的 `display_name` 影响 `source=` 归属，`workspaces.rs:585-587`）；② fan-out 取 **old ∪ new**，让"被移除的成员"也拿到一次 fold 机会以纠正 union 基线。

## B.5 身份规范化：伪身份到底能不能当成员（本次最关键的判定）

`normalizeStoredProjectPath`（`.../memory/project-identity.ts:790-801`）：

```ts
if (rawOrStored.startsWith("git:") || rawOrStored.startsWith("dir:")) return rawOrStored;
try { return resolveProjectIdentity(rawOrStored) }
catch { return rawOrStored }   // 解析失败保留原样，绝不臆造第二个身份
```

`isUsableProjectIdentity` 只要求"非空字符串"（`:713-715`）。

推论（逐条给证据）：

| 问题 | 结论 | 依据 |
|---|---|---|
| `__global__`（无前缀）能被 dashboard 加成成员吗 | **不能可靠**：会被当相对目录 `resolveProjectIdentity("__global__")` → 无 `.git` → 走 `dir:<md5(cwd/__global__)>` fallback，落成一个路径相关的伪 `dir:` 身份 | `project-identity.ts:790-801,541-597` |
| 直接 SQL 插入 `__global__` 成员行，读路径能用吗 | **能用**：`resolveWorkspaceIdentitySet` 原样读回；`resolveStoredPathWorkspaceIdentity` 的 canonical map 直接命中；`storedPathBelongsToIdentity` 的 `===` 分支命中 | `workspaces.ts:164-200,242-261`；`project-identity.ts:812-820` |
| 但 dashboard 还管得了它吗 | **基本管不了**：dashboard 的 add/remove 都会先 `normalize_stored_project_path`，`__global__` 被改写 ⇒ 移除时 "Workspace member not found"；改名也要匹配规范化后的 key | `workspaces.rs:646,652,719` |
| 有没有"四处透传"的写法 | **有**：任何以 `git:`/`dir:` 开头的字符串都**逐字节透传**所有规范化点。所以保留一个形如 `git:0000000000000000000000000000000000000000`（或 `dir:` 前缀的固定串）的**合成身份**，就能同时是"合法的成员身份"和"无需目录存在的伪项目" | `project-identity.ts:790-793`；`workspaces.ts:32` 只校验类别不校验身份形态 |

**这是本次分析最有价值的单条结论**：想给"全局记忆"一个无主身份，**必须带 `git:`/`dir:`
前缀**，否则它在上游的规范化链路上会被静默改写成某个 `dir:` 哈希。

## B.6 一个项目只能属于一个 workspace（设计硬约束）

由 B.1 的唯一索引 + B.4 的检查共同保证。后果：

- 你不能同时让 `example-service` 属于"组织域"和"机器域"两个工作区；
- 于是**"组织级全局"与"机器级全局"不可能靠两个 workspace 同时覆盖同一个项目**；
- 想在同一个项目里同时生效，激活判定必须**下沉到适配器**（或让全局记忆自带适用域字段），
  而不能只依赖 workspace 成员资格。

## B.7 与 DSH 适配器的差距（顺带盘出）

| 项 | 上游 | 本适配器 |
|---|---|---|
| workspace 读取 | `resolveWorkspaceIdentitySet` + `expandWorkspaceIdentitySetWithAliases`（含身份迁移别名） | 只读 `workspace_members`，**不消费 `v22_identity_rekey_map` 别名** |
| 指纹 | `computeWorkspaceEpochFingerprint`：sha256，覆盖 **share_categories + 每个身份 epoch**（`workspaces.ts:312-334`） | `epochFingerprint`：sha1，**只覆盖 epoch，不含 share_categories** ⇒ 工作区改共享类别时适配器不会 HARD |
| 共享类别默认 | NULL ⇒ `["CONSTRAINTS"]`；非法 ⇒ `[]` | 同语义的复刻（`memory-bridge.ts:60,760,884`） |
| 成员变更 | dashboard 写 + fan-out bump epoch | 只读，不写 |
| 画像通道 | 完整 | **0 覆盖**（`src/` 内无 `user_memories` / `__global__`） |

## B.8 补遗：workspace 深挖的追加事实（分片核实）

**(1) 可见性谓词有 4 份实现 + 1 份规范常量。** 规范常量 `FOREIGN_VISIBLE_SQL`
（`memory/visibility.ts:5-6`，Rust 同字面量 `crates/mc-store/src/lib.rs:76`，靠一个逐字节
parity 测试绑住）**只是字符串**，四个调用点各自拼 SQL：

| 实现 | 位置 | 形态差异 |
|---|---|---|
| 渲染/水位/FTS 共用 builder | `memory/storage-memory.ts:783-834`（调用点 `:926`/`:956`、`storage-memory-fts.ts:136`） | own 分支 + foreign 分支并列，参数是**类别名列表** |
| 批量基线读 | `memory/storage-memory.ts:836-915` | 手写同形状，末尾一句 `void FOREIGN_VISIBLE_SQL;` 只为"保持对齐" |
| 工具/归属判定（内存态） | `memory/memory-visibility.ts:57-108` | JS 布尔组合 |
| Rust native | `crates/mc-store/src/lib.rs:17389-17434` | 同形状；用 `FOREIGN_VISIBLE_SQL.contains("shareable = 1")` 当**能力降级开关** |

⇒ **任何共享策略改动必须同时改 4 处**；规范常量用的是 `json_each(:share_categories)`
（JSON 数组字符串），而 builder 传的是 `?,?,?` 占位符，所以常量本身**无法被直接复用**。

**(2) `share_categories` 非法值：两处方向相反。** 插件 fail-closed（任何非法 ⇒ `[]` = 什么都不共享，
`workspaces.ts:84-96`）；**dashboard 读侧 fail-open**（NULL/坏 JSON/未知类别 ⇒ 回落到全部 5 类，
`workspaces.rs:440-450`、`:524`）。同一个畸形值会让 dashboard 显示"全共享"而插件实际"零共享"。

**(3) `isWorkspaced` 的门槛是成员数 > 1**（`inject-compartments.ts:1198`）：**只有一个成员的
工作区被当作单项目**（shareCategories/fingerprint 都置 null）。设计时不能假设"建了工作区就生效"。

**(4) 一个会话的读集决策链**（与配置无关，工作区**没有任何用户可见开关**，`packages/plugin/src/config`
里 `workspace` 只出现在主目录说明那一段）：

```
宿主目录(compartmentDirectory || cwd) → resolveProjectIdentityForSession → 身份
  → workspace_members 自连接 → 成员集合
  → v22_identity_rekey_map → 历史身份别名
  → workspaces.share_categories → 类别白名单
  → allow_home_project / memory.enabled
```
`session_projects` **不参与**记忆池选择（它只服务 chunk embedding 归属与回填）。

**(5) 成员身份伪装的真实可行边界**（补强 B.5）：
- dashboard 的 `normalize_stored_project_path` 把非前缀值按 **dashboard 进程 cwd** 做词法 resolve
  再 md5（`dashboard/src-tauri/src/project_identity.rs:64-71`）⇒ 同一字面量在不同 cwd 下得到
  不同 `dir:` 值，**不可移植**；
- 主目录守卫在 `display_path` 无法 canonicalize 时**不拒绝**（`workspaces.rs:857` 的
  `unwrap_or(false)`）⇒ 伪造身份配一个不存在的 display_path 能通过；
- dashboard 的成员选择器只列"已知项目 ∪ 既有成员"（`db.rs:4644-4658`、`workspace-staging.ts:138-146`），
  普通操作无法输入伪身份，只能 SQL/HTTP 注入；
- `display_path` 还被 CLI 的 `doctor-merge-identity` 当真实目录用（`doctor-merge-identity.ts:275-278`），
  伪造值会污染该映射；
- **没有任何测试覆盖"非 `git:`/`dir:` 成员"** —— 这是"未定义但被允许"，不是被设计支持。

**(6) 上游有、适配器没有的 workspace 能力**：读 `display_name` 做 `source=` 归属标注
（适配器 grep `display_name` 零命中 ⇒ 注入的外来记忆**无法标注来源仓库**）、消费
`v22_identity_rekey_map` 别名、目录包含关系判定、主目录排除、**FTS5 联合检索**
（适配器在召回集合上做 `.includes()` 子串过滤，没有 bm25/日期区间/分词）、任何写入能力。

---

# C. 对"全局记忆"设计的修正结论

## C1. 画像通道**不适合**承载组织知识（三个理由）

1. **语义污染**：它的 reviewer 提示词被固定成"关于人的通用行为模式"，会把"组织 DB 连接方式"
   当成用户特质继续归纳；它还有 `dismiss_existing` 这种自动化改写/退役路径。
2. **激活面错误**：画像注入**所有会话**（无项目闸门），而组织知识必须只在组织项目出现。
3. **半自动化**：reviewer 每日自动提升（阈值 3），与"极度准确、必须人工确认"冲突；
   而且"≥N 个语义相似变体"只是提示词要求、**无任何校验**（A.4 补注）。
4. **旧内容不可回收**：画像变更不是 HARD 触发，m[0] 里的旧块会与新块**并存**到某次无关
   HARD 为止（A.9-(3)）。对个人画像只是"不准"，对组织事实是**持续污染**。
5. **采集与评审耦合**（A.9-(1)）：我们若要"先收集证据、后人工确认"，它的开关形状直接用不了。

⇒ **借形态，不借通道。** 若要复用它的表，也只能是"读"，不能是"写"。

## C2. 组织级全局记忆的落点（修正版）

```
身份：一个带 git:/dir: 前缀的合成身份，例如 git:000…0company（保留段）
      —— 必须在所有规范化点逐字节透传（B.5）
归属：memories.project_path = 该合成身份；scope='universe'；shareable=1
激活：把该合成身份登记为「组织域」workspace 的成员 ⇒ 该工作区成员项目自动可见
      （复用 FOREIGN_VISIBLE_SQL，零新增可见性代码）
准入：候选（跨 project_path 复现 ≥2）+ 人工确认（命令或 dashboard），
      **禁止 historian 自动直写全局**
呈现：独立分区 + 独立预算；新条目走版本水位进 m[1]，不破 m[0]（照抄画像的版本增量模式）
```

**`shareable` 陷阱必须先解决**：上游内容一改就 `shareable=0`；适配器自己的
`UPDATE_MEMORY_CONTENT` 同样置 0。任何全局写/改路径都必须显式重设 `shareable=1`，
否则"改一次就消失"。

## C3. 两条域的实现取舍（B.6 的后果）

| 方案 | 做法 | 代价 |
|---|---|---|
| **W1 两个 workspace** | 「组织域」与「机器域」各一个 workspace | ❌ 同一项目只能属于一个 ⇒ 无法同时生效 |
| **W2 一个 workspace + 适配器侧适用域判定** | 全局记忆自带 `applies_to`（org/machine/all），适配器在召回时按当前项目属性过滤 | ✅ 可行，需新字段+判定；但字段只能写在适配器侧（上游 `memories` 无此列） |
| **W3 只做组织域** | 先只做「组织域」，机器级事实继续留在项目记忆 | ✅ 最克制，先验证价值 |

我推荐 **W3 起步、W2 作为演化方向**：不要让"机器级事实"这个更私密、更宽的面，
在还没有运行时就把设计撑大。

## C4. 复用清单

**直接复用（形态）**：候选池 + 溯源（`source_candidate_ids`/provenance 模式）、
"复现次数"闸、版本水位驱动的 m[1] 增量、独立预算、加法不破缓存、
人工提升通道（dashboard 已存在同类 API）。

**不要复用**：自动 LLM 提升（阈值 3 就写）、注入所有项目的激活面、
LLM `dismiss_existing`（全局退役必须人工）。

## C5. 修正后的分期

- **P0（只读验证）**：手工造 3–5 条 `project_path='<合成身份>' + shareable=1 + scope='universe'`
  记忆，登记进「组织域」workspace；适配器只做"认识该身份 + 独立分区 + 审计"。
  观察：注入频率、是否真被用到、有无跨域误用。
- **P1（准入）**：候选表（适配器库或上游风格的新表）+ 跨项目复现门 + 人工确认命令。
- **P2（适用域）**：`applies_to` 字段 + 适配器侧过滤（W2），把机器级事实纳入。

---

# D. 仍未确认 / 需要实测的点

1. **合成身份在 dashboard 的显示与操作**：`WorkspaceMemberChange{project_path, display_name,
   display_path}` 里的 `display_path` 是自由字符串，理论上可填占位值；但 UI 可能强制"选目录"。
   需实测一次 dashboard 加成员流程。
2. **MC 的其它消费者会不会碰合成身份**：`session_projects`、dreamer 的 per-project 任务、
   `map-memories`/`verify` 等按 `project_path` 遍历时，遇到合成身份是跳过、报错还是当作项目处理
   （下游任务按 project 遍历的入口未逐一核）。
3. **`shareable` 与 classify 的冲突**：我们手工置 `shareable=1` 后，MC 的 classify 任务
   重跑时是否会按它的判断改回 0。
4. **Pi / OpenCode 侧**是否有对 `workspace_members` 身份的额外校验（本次只核了 dashboard 与
   plugin TS 两条路径）。
5. **适配器 fingerprint 不含 share_categories** 是否要在本次一并补齐（否则改共享类别不会
   触发 HARD，可能出现 m[0] 里残留旧共享集合的窗口）。

---

## 附：本次取源与分析的方法说明

- 只读；未修改上游任何文件；`.upstream/` 已加入本仓 `.gitignore`。
- 亲读并逐条核实：`workspaces.ts`（全文 422 行）、`storage-user-memory.ts`（全文）、
  `review-user-memories.ts`（全文）、`user-profile-render.ts`、`storage-project-state.ts`、
  `migrations.ts` 相关 DDL、`project-identity.ts` 关键函数、dashboard `workspaces.rs`
  成员变更段、`inject-compartments.ts` 的画像渲染与触发器注释、
  `compartment-runner-incremental.ts` 候选写入点、`task-registry.ts` 租约域、
  `task-gates.ts` 画像候选计数门、`curate-memory-safety.ts`。
- 未覆盖：`package.json` 配置项细节、dashboard 前端 `WorkspacesPanel`、Rust `mc-store`
  侧的 workspace 实现、Pi 侧差异。
