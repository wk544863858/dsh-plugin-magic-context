# 底座接管与全局域设计 v2（2026-10-09）

> **状态**：设计草案 v2。v1 经用户一轮评审（"你来当架构师和产品经理挑战一下"）后修订。
> **未动代码**：本文只定义机制、不变量、阶段与验收判据。
>
> ### v2 变更记录（评审结论）
> | 编号 | 变更 | 性质 |
> |---|---|---|
> | A1 | **不再接管 workspace 表**。Pi 也将移除 ⇒ 契约内的 workspace 已无消费者。组织成员改住适配器自有表，三个域共用"适配器自建 peer 车道"；`workspaces`/`workspace_members`/`project_state` 全部**转休眠（只读不写）** | 架构反转 |
> | A2 | 向量回填：**必须逐字节写同一个 dominant `model_id`**（真库现有两个：`embedding-provider:c447…` 827 行 / `embedding-provider:ac1a…` 97 行），写入前用闸门自证 | 补漏 |
> | A3 | **"改写"不再走 HARD**：改写 = supersede + 新增（走加法车道）；**只有 dismiss/delete 走 HARD** | 不变量修改 |
> | A4 | 契约冻结分两层：**L1 语义冻结（必须守住）/ L2 结构冻结（可撤销的默认 + 加列流程）** | 放松过度约束 |
> | A5 | 域激活**必须在构造 peer 身份列表时决定（SQL 之前）**，禁止 JS 后置过滤 | 新不变量 |
> | A6 | 域激活**只允许一个实现**，配可见性矩阵测试 | 新不变量 |
> | B2 | 每域 cap **由预算推导**（cap = floor(budget / 每行估算)），不拍脑袋 | 修正 |
> | B4 | **约束型（directive-shaped）条目一律走"提问式二次确认"**，不得自动提升；存量 17 条需人工复核 | 新机制 |
> | B5 | 新增"稳态运维"一节（人的操作回路） | 补漏 |
> | C1/C3/C4 | 补测试策略；`memory_mutation_log.mutation_type` CHECK 入不变量；迁移幂等与回滚 | 补漏 |
>
> **用户裁决（2026-10-09）**：① Pi 也要删除；② 约束型必须通过提问做二次确认；③ 存量 17 条做一次人工复核（见 `docs/user-profile-review-2026-10-09.md`）。
>
> **前置事实文档**：`docs/memory-mechanisms-inventory-2026-10-09.md`（本仓机制现况）、
> `docs/upstream-source-analysis-2026-10-09.md`（上游 v0.46.1 画像 / workspace 逐行分析）；
> 上游源码就地可查：`.upstream/magic-context/`（已 gitignore）。

---

## 0. 触发条件（用户裁决）

1. **`context.db` 与契约锁死后留下**（schema 冻结；不再有 MC 侧迁移）。
2. **MC dashboard（Rust）不会留下**。
3. **OpenCode 将逐步移除**；**Pi 也将移除**。

⇒ **`context.db` 将只剩我们一个读者与写者。** 这是本版设计的基石：契约内的"共享/工作区/画像版本"等机制不再有第二个消费者，我们对它们的取舍只服务自己。

---

## 1. 目标 / 非目标

### 目标
- 记忆平台的**全生命周期**收归适配器：写入语义、共享属性、域激活、画像管线、向量回填。
- 三个全局域：`user`（人员画像）、`org`（组织知识）、`machine`（本机环境）。
- 全程不突破**语义冻结**（§3），新状态一律住适配器库（schema v8 起）。
- 每域可激活、可审计、可退役、可限流；**约束型内容永远要过人的门**。

### 非目标
- 不复刻 MC 的 dreamer 调度器与 7 个 tool-loop 任务；不引入 cron（一切节拍挂 maintenance tick）。
- 不做 GUI：命令 + journal 交付管理面。
- **不写** `workspaces` / `workspace_members` / `project_state`（转休眠）。
- 不做"通用工程规范"这类无差别全局类目。

---

## 2. 归属接管矩阵（v2）

| 能力 | 今天的生产者 | 消失后 | v2 的处置 |
|---|---|---|---|
| `shareable` / `scope` 置位 | MC classify | 无人 | **接管**：发布共享/全局行时显式写；内容更新后恢复（I4） |
| 工作区成员关系 | MC dashboard | 无人 | **不接管**：一次性把现有成员导入适配器自有表，契约表转休眠（A1） |
| 画像采集/评审/版本 | MC historian + review 任务 | 停摆 | **接管**：原地复用 `user_memories` / `user_memory_candidates`，版本改用我们自己的每会话水位 |
| 向量回填 | MC embedding backfill | 停摆 | **接管**：写同一个 dominant `model_id`（A2） |
| 契约迁移 | MC migrations | 冻结 | 不迁移；L1 语义冻结（A4） |

**一次性导入**：`workspaces`/`workspace_members`（真库现有 1 个工作区、5 个成员）→ 适配器表 `domains` / `domain_members`，导入后契约表只读。

---

## 3. 契约纪律（两层）

### L1 语义冻结（必须守住）
- 不改既有列的语义；不删列/表；不破坏既有索引与触发器（尤其 `memories_fts` 的同步触发器）。
- 遵守既有 CHECK：`memory_mutation_log.mutation_type IN ('archive','delete','update','superseded')`（C3）。
- 遵守既有主键/外键：`memory_embeddings` PK `(memory_id, model_id)` + `ON DELETE CASCADE`。
- `memories.category` 虽无 CHECK，但**语义上只允许 v2 五类**（真库 957 行全部落在这五类内），不新造类别值。

### L2 结构冻结（可撤销的默认）
- 默认不加列、不加表。若确实需要（例如域归属列），必须走流程：
  `DDL 快照 → 加列必须带默认值且可空 → 回滚脚本 → 在合成库上演练 → 记入变更记录`。
- 新状态优先住适配器库（这才是默认路径）。

### 机械校验（每阶段验收都跑）
- `PRAGMA table_info` / `sqlite_master`（表/视图/索引/触发器）与冻结基线逐项比对，基线存适配器库 `meta.contract_freeze_snapshot`。
- 漂移 = 验收失败（不区分"有意/无意"）。

---

## 4. 三个全局域

### 4.1 总原则
- **一个域 = 一条激活规则 + 一份独立预算 + 一个由预算推导的 cap + 一个内容门。**
- **域 = 适用环境，不是话题分类**（话题由既有 `category` 承担）。
- **一条记忆只属于一个域**，域在提升时确定，之后不得静默改挂。
- 域数量**硬上限 3**；新增域必须同时满足：独立激活条件 + 独立受众 + 独立预算。

### 4.2 域激活（A5 + A6）
- 三个域共用**一条适配器自建 peer 车道**：
  `域身份列表 = f(适配器自有 domain_members, 当前项目身份, domain 配置)`，
  在构造召回 SQL 的 `project_path IN (...)` **之前**算出（不是 JS 后置过滤）。
- **单实现**：只有一个函数回答"当前项目激活哪些域"；其余路径（召回 / 水位 / 显式检索）必须调用它。
- 水位（`maxVisibleId`）与召回必须使用**同一个**激活结果，否则不可见行会推高水位并静默吞掉后续可见新行。
- 契约表 `workspaces.workspace_members` 不再参与；`baseline_state.project_epoch_fingerprint` 的来源
  从 `project_state.project_memory_epoch` 改为**我们自己的域成员指纹**（域集合 + 成员 + epoch + 激活配置），
  保持"成员变化 ⇒ HARD"这条既有不变量。

### 4.3 `user`（人员画像）
| 项 | 决定 |
|---|---|
| 存储 | 原地复用 `user_memories`（不从 `memories` 重建） |
| **为什么不能塞进 `memories`** | `memories.category` 是 NOT NULL 且语义只限 v2 五类；画像内容**没有合适的类别**，也不应进入项目记忆的类别/共享体系 ⇒ `user_memories` 是唯一正确的家（这比 v1 的"省迁移"是更强的理由） |
| 候选 | 原地复用 `user_memory_candidates`；**约束型的确认状态住适配器库新表**（见下） |
| 激活 | 所有会话（门：`memory.global.user.enabled`） |
| 准入 | **描述型**：允许自动提升（跨会话复现 ≥3 + LLM 评审）；**约束型（directive-shaped）：必须提问式二次确认**（B4） |
| 退役 | `dismiss` / 硬删 ⇒ **HARD**；改写 ⇒ supersede + 新增（不 HARD，A3） |
| cap | 由预算推导（见 4.6） |
| 采集 | 我们的 historian（JSON）新增 `userObservations`，post-commit / best-effort |
| 评审 | maintenance tick：`候选数 ≥ 阈值 且 距上次评审 > 24h` |
| 渲染 | m[0] `<user-profile>`（预算 4000）+ m[1] `<new-user-profile>`（25% = 1000） |

**约束型二次确认的确切流程（B4 + 用户裁决②）**
```
候选 → 分类器判定 directive-shaped（对齐上游 curator 的 directive-shaped 判据）
  ├─ 描述型 → 正常评审 → 可自动写入 user_memories
  └─ 约束型 → **不写 user_memories**，写入适配器库 confirmations 队列（状态 pending）
              → 会话内可见的一次性通知（复用 session-notice 通道）
                内容 = 候选文本 + 观察到几个会话/哪段 compartment（provenance）
                     + 为什么判为约束型 + "确认后它将在所有会话生效"的提示
              → 用户命令确认/拒绝
              → 确认后才写 user_memories 并 bump 水位
```
- 未确认的约束型条目**永不进入注入池**（这是"不能被误用"的实现点）。
- 存量 17 条里的约束型条目已生效 ⇒ 按 `docs/user-profile-review-2026-10-09.md` 逐条复核（保留 / 改写为描述型 / 退役）。

**水位**：不再使用 `project_user_profile_version`；在适配器 `baseline_state` 加每会话画像 m[1] 水位（schema v8）。

**沿用 MC 的两条正确细节**：渲染顺序 `promoted_at ASC, id ASC`（id tiebreaker 承重）；预算裁剪用 `continue` 而非 `break`。

### 4.4 `org`（组织知识）
| 项 | 决定 |
|---|---|
| 身份 | `dir:global:org`（合成；`dir:` 前缀保证逐字节透传） |
| 存储 | `memories`：`scope='universe'`、`shareable=1`、`source_type='user'` |
| 激活 | 适配器自有 `domain_members`：(org, 项目身份) 列表（由契约内的 5 个成员一次性导入） |
| 准入 | 候选门：同 `normalized_hash` 在 **≥2 个不同 project_path** 独立复现；**提升必须人工确认** |
| 渲染 | m[0] 独立分区 `<global-memories domain="org">`，独立预算 |
| 发布前置校验 | 类别必须在我们自己的域白名单内 |

### 4.5 `machine`（本机环境）
同 org，身份 `dir:global:machine`；激活 = 本机（可按配置排除项目）；**因为不再走契约 workspace，§v1 里的"跨工作区偏离"问题自动消失**（自建车道本来就不受 `UNIQUE(project_path)` 约束）。

### 4.6 预算与 cap（B2）
```
每域预算（token）：user 4000(基线)+1000(增量) / org 768 / machine 512   ← 待标定
每域 cap = floor(预算 / 每行估算 token)，再乘 0.8 安全系数
溢出行为：超出 cap 的**新条目拒收**（不踢出旧条目），并在 journal 提示"该域已满"
```
即 cap 是预算的**推论**，不是独立拍定的数字。

---

## 5. 不变量清单（v2）

| # | 不变量 | 备注 |
|---|---|---|
| I1 | **L1 语义冻结**必须守住；L2 结构冻结按 §3 流程 | A4 |
| I2 | 每域独立预算与 cap（由预算推导）；不挤占 `policy.memoryBudgetTokens`(8000) | |
| I3 | **新增走 m[1]；改写 = supersede + 新增（不 HARD）；只有 dismiss/delete 走 HARD** | A3 |
| I4 | `shareable`/`scope` 由我们显式维护，内容更新后必须恢复 | |
| I5 | 自动化路径（historian 提升）**永不写**全局域与 `user_memories` 的约束型条目 | |
| I6 | 凭据模式拒写（`password=`、`://user:pass@`、`-----BEGIN`、长 base64/hex、云凭据形状） | |
| I7 | 一条记忆只属于一个域，域在提升时确定 | |
| I8 | **约束型（directive-shaped）内容必须经提问式二次确认**方可生效；未确认永不注入 | B4 |
| I9 | 域激活**单实现**，且在构造 peer 列表时决定（SQL 之前）；水位与召回必须同源 | A5/A6 |
| I10 | 适配器库 schema 走 forward-only + fail-closed 迁移链 | |
| I11 | 全流程不依赖 dashboard（命令面可完成 建域/审批/退役） | |
| I12 | 变更可观测：journal（注入行数/域/类别/id）+ mc-report 桶 | |
| I13 | 遵守契约既有 CHECK：`mutation_type IN ('archive','delete','update','superseded')` | C3 |
| I14 | 向量回填只写**默认 dominant `model_id`**，写入前过闸门自证（cos ≥ 0.99） | A2 |
| I15 | 一次性迁移（工作区成员→适配器表、画像归域）必须**幂等可重跑**，带行数/内容哈希校验 | C4 |

---

## 6. 阶段计划（v2）

### P0 接管写路径（地基，不含 workspace）
1. **共享属性维护**：发布/更新路径显式写 `scope`/`shareable` + 恢复封装（I4）。
2. **一次性导入**：契约 workspace 成员 → 适配器 `domains`/`domain_members`（幂等，I15）。
3. **域激活单实现** + 矩阵测试骨架（A6）。
4. **冻结基线快照** + 机械校验脚本。
5. 最小命令面：`/ctx-global`（域/候选/成员 的列表与变更）。

**验收**：契约零漂移；成员变化 ⇒ 相关会话 HARD（指纹来源已切换）；域激活矩阵测试通过；`npm run gate` 全绿。

### P1 `user` 域（防腐，优先）
采集 → 候选 → 分类（描述/约束）→ 描述走自动评审、**约束走确认队列** → 渲染两块 → 输出裁决走 supersede（不 HARD）→ dismiss 走 HARD。

**验收**：① 3 条相近候选 → 1 条画像；② 新会话出现 `<user-profile>`；③ **约束型候选未经确认时在会话里不可见**（专项测试）；④ dismiss 后两个块都消失（HARD）；⑤ 候选 30 天 TTL 在**评审关闭时仍然生效**（对上游缺陷的回归）；⑥ 连续两趟渲染字节相同（顺序稳定）。

### P2 `org` 域
候选表（适配器库）+ 跨 `project_path` 复现门 + 人工确认 + 独立预算/分区 + 凭据拒写。

**验收（含产品判据）**：组织内可见、非组织不可见；含凭据形状被拒；改写/退役立即生效且不出现新旧并存；**上线 2 周内若没有任何一条 org 记忆被 ≥2 个不同项目命中（`hits`），判定需求不成立并停止投入**。

### P3 `machine` 域
同 org，激活=本机（可排除）；水位一致性专项（不出现从未注入过的 `<new-memories>` 行）。

### 并行：向量回填接管（A2）
只写 dominant `model_id`；每拍限额；失败 fail-open。**验收**：`memory_embeddings` 行数单调增长且 `model_id` 集合不新增第三个；hybrid 命中占比回升。

---

## 7. 稳态运维（B5，v2 新增）

| 节拍 | 动作 | 不做的后果 |
|---|---|---|
| 每会话 | 无（自动） | — |
| 每日 | 看一眼待确认队列（约束型候选 + 新域候选）；批准/拒绝 | 队列堆积，直到 cap 拒收新条目 |
| 每周 | 跑 `mc-report`：域命中分布、cap 占用、候选堆积、TTL 清理 | 无法判断域是否被真正使用 |
| 阈值触发 | 域 cap 打满 → 强制整理（合并/退役）；候选 > 50 且 >7 天未处理 → 告警 | 域退化为噪声池 |
| 每月 | 抽查一条已批准条目（内容是否仍成立） | 全局域"说得对但已过期" |

---

## 8. 测试策略（C1，v2 新增）

- 全部用**合成库 fixture**（不依赖真实会话）：造两个项目身份 + 两个域成员关系 + 若干记忆行。
- **可见性矩阵**：3 域 × {组织内, 组织外, 无成员关系} × {自动注入, 显式检索} × {水位, 召回}，逐格断言。
- **HARD 行为**：dismiss/delete ⇒ 下一次 pass HARD；改写 ⇒ **不** HARD 且出现 supersede 增量。
- **约束门**：directive-shaped 候选未确认时，注入池与检索均不可见。
- **契约冻结**：DDL/索引/触发器与基线比对。
- **迁移幂等**：导入脚本重跑两次结果一致。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 域激活多处实现导致不一致 | I9 单实现 + 矩阵测试 |
| 水位被不可见行污染（静默吞行） | 水位与召回同源 + 专项测试（不出现从未注入的行） |
| 约束型条款被自动放大 | I8：未确认永不生效；存量按复核清单处理 |
| 契约被无意改动 | 机械校验 + L1/L2 分层 |
| 向量空间被写脏 | I14（只写 dominant model_id + 闸门自证） |
| 命令面误操作 | 破坏性动作 dry-run + 显式确认 + journal |

**回滚**：每域一个默认 **off** 的配置开关；P0 的导入是可重跑的幂等脚本；契约层只读。

---

## 10. 未决

1. 每域预算的具体值（768/512 待按真实内容标定）。
2. 描述型自动提升的复发门：池子 ≥3 vs 跨会话复现 ≥3（倾向后者，代价是记 session 去重）。
3. 命令面的命名与粒度。
4. 向量回填的限额与节拍。
5. `machine` 域的项目排除配置形状。
6. **存量 17 条的复核结论**（见 `docs/user-profile-review-2026-10-09.md`）。
