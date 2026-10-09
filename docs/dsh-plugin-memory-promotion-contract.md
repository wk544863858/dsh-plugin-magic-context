# DSH 适配器：historian 事实提升与 dreamer 策展契约

> 目标读者：要在 `packages/dsh-plugin` 里实现"记忆能产生"的工程师。
> 证据分级：〔码〕源码行 · 〔档〕文档 · 〔测〕测试/实测取样。
> 本文只读 MC 仓库与用户真实库；无任何写入（真实库以 `mode=ro` + `PRAGMA query_only=1` 探测）。

---

## 结论（先行）

1. **提升不是"候选池 + 阈值"，而是一次无门槛的直写。** historian 输出的 `<facts>` 条目在**与 compartment 同一个发布事务**里被逐条插入 `memories`：只要 `memory.enabled && memory.auto_promote` 为真、类别在白名单内、文本非空、`(project_path, category, normalized_hash)` 未命中，就写一行。〔码〕`compartment-runner-incremental.ts:944-945,1062,1077-1105,1154`；`promotion.ts:49-94`
2. **没有 importance 门槛、没有长度/条数上限、没有冷却期、没有语义相似度过滤。** fact 自身不带 importance，落库用默认 50；compartment 的 `importance` 与提升完全无关。〔码〕`promotion.ts:79-91`；`storage-memory.ts:564`；〔档〕`docs/reports/historian-memory-promotion.md:7`
3. **提升不写 `memory_mutation_log`，也不 bump `project_memory_epoch`。** 它在 MC 里是"纯追加"：靠 `maxMemoryId` 水位在**下一次**物化机会进入 m[1] `<new-memories>`，m[0] 不因此失效。〔码〕`inject-compartments.ts:1932-1933,2656-2660,2944-2975`
4. **不额外调用 LLM。** 用的就是 historian 那一次调用的输出；唯一的额外外部调用是**提交后 best-effort 的 embedding**（失败只记日志）。〔码〕`promotion.ts:96-143`；`compartment-runner-incremental.ts:1187-1192`
5. **dreamer 的策展（curate）是"质量维护"，不是提升。** 它每 7 天按类别轮转跑一次，只做合并/改写/归档，且**禁止 mint 新事实**；它通过 `ctx_memory` 走 mutation log 路径，同样不 bump epoch。〔码〕`task-prompts.ts:40-57,104-128`；`task-registry.ts:90-94`；`magic-context.ts:550`
6. **对本适配器：提升写入器可以复刻（约 60 行，无前置依赖）；dreamer 策展不能复刻**（需要跨宿主共享的定时器、lease、`ctx_memory` 工具环与 LLM 预算）。但**必须先补 m[1] 水位**，否则新增记忆会让召回 digest 变化 → 每次提升都触发 HARD 重建 → 破坏缓存前缀。〔码〕`management-pass.ts:177-181`；`memory-bridge.ts:421-423`
7. **当前最大阻塞不是"阈值难调"，而是契约不匹配**：本适配器的 historian 输出 `facts: string[]`（无类别），而 MC 的提升只接受 `{category, content}` 且类别必须在 `PROMOTABLE_CATEGORIES` 内——**今天我们的每一条 fact 都会被 100% 丢弃**。〔码〕`dsh-plugin/src/core/compartments.ts:26,246`；`dsh-plugin/src/dsh/historian.ts:135`；`promotion.ts:32-34,66-68`

---

## 1. 触发点

### 1.1 TS（host 权威路径）

| 项 | 值 | 证据 |
|---|---|---|
| 调用位置 | historian 发布事务内，`appendCompartments` 之后、`COMMIT` 之前 | 〔码〕`compartment-runner-incremental.ts:1062` → `:1077-1105` → `:1154` |
| 输入 | `validatedPass.facts ?? []`，元素形如 `{ category, content }` | 〔码〕`:1083`；`compartment-parser.ts` 解析 `<facts>` 下按类别标签分组的 `*` 条目 |
| 门控 | `promotionActive = embeddingActive && deps.memoryEnabled !== false && deps.autoPromote !== false`（二者缺省即 true） | 〔码〕`:943-945` |
| 额外跳过 | `skipUnanchoredPromotion = discardedLast \|\| weakLookaheadFinalCompartment`（弱边界不提取不可锚定事实） | 〔码〕`:914-928,1077` |
| 同步性 | **同步、事务内**；失败传播 → 整个发布回滚 | 〔码〕`promotion.ts:41-48` |
| 后置（真异步） | embedding 在 COMMIT 之后 best-effort 跑，不参与发布成败 | 〔码〕`promotion.ts:96-143`；`compartment-runner-incremental.ts:1187-1192` |
| 权威冲突降级 | 项目是 module 管理时 `ModuleMemoryAuthorityError` 被吞掉：**只丢 facts，保留 compartments** | 〔码〕`:1088-1104` |
| Pi 同源 | Pi 调用同一个 promoter | 〔码〕`packages/pi-plugin/src/pi-historian-runner.ts:1361-1364,1409` |

```
compartment-runner-incremental.ts
  943  const embeddingActive = !!promotionDirectory;
  944  const promotionActive =
  945      embeddingActive && deps.memoryEnabled !== false && deps.autoPromote !== false;
  ...
 1062  appendCompartments(db, sessionId, persistedCompartments);
 1077  if (promotionActive && !skipUnanchoredPromotion) {
 1079      const promotion = promoteSessionFactsDurable(
 1082          promotionProjectIdentity,
 1083          validatedPass.facts ?? [],
 1084      );
  ...
 1154  db.exec("COMMIT");
```

### 1.2 Rust module 路径（结构相同，语义不同）

- `promote_facts = memory_enabled && auto_promote`，在 `validate` 阶段就决定，facts 被投影进 publish 请求。〔码〕`crates/mc-module/src/historian.rs:3115`，`:831-840`
- 真正落库在 fold 写入事务里：`apply_fold_tx` → `promote_facts_tx`。〔码〕`crates/mc-store/src/context_writes.rs:288-307`

### 1.3 两条 TS 路径的"importance 无关"确认

historian 的 `importance` 只用于 compartment 衰减渲染，**不参与事实提升的任何判断**；Rust 侧 `to_store_fact` 明确写死 `importance: None, expires_at: None`。〔码〕`historian.rs:213-227`

---

## 2. 合格门槛（全部条件，缺一即丢）

| # | 门槛 | 取值 | 证据 |
|---|---|---|---|
| 1 | 功能开关 | `memory.enabled` 且 `memory.auto_promote`，默认均 `true` | 〔码〕`config.rs:123,187`；`packages/plugin/src/config/schema/magic-context.ts:1483,1558`；〔档〕`CONFIGURATION.md:741` |
| 2 | 项目身份可用 | 需要解析出的 project identity（空则整条路径 no-op） | 〔码〕`:912,946-948` |
| 3 | fact 结构 | `category` 与 `content` 均为 string，且 `content.trim().length > 0` | 〔码〕`promotion.ts:57-65` |
| 4 | 类别白名单 | `PROMOTABLE_CATEGORIES`＝v2 五类（`PROJECT_RULES / ARCHITECTURE / CONSTRAINTS / CONFIG_VALUES / NAMING`）＋ legacy 七类 | 〔码〕`memory/constants.ts:17-29` |
| 5 | 去重前置 | `getMemoryByHash(project_path, category, md5(normalize(content)))` 未命中才 INSERT | 〔码〕`promotion.ts:70-77`；`normalize-hash.ts:3-11`；`storage-memory.ts:680-691` |
| 6 | 边界有效性（非质量门槛） | discard-last / weak-lookahead 边界不提升；Rust 侧支持 `[at_compartment=N]` 锚 | 〔码〕`:914-928`；`historian_validate.rs:396-407,603-619` |

**明确不存在的门槛**（易被误解，逐条否定）：

| 被误认为存在的门槛 | 实际情况 | 证据 |
|---|---|---|
| importance 下限 | 不存在。fact 无 importance 字段；落库 `importance ?? 50` | 〔码〕`promotion.ts:79-86`；`storage-memory.ts:564` |
| 长度上限 | 不存在。只有 `trim().length === 0` 的判空 | 〔码〕`promotion.ts:62` |
| 每次/每天条数上限 | 不存在。`for (const fact of facts)` 全量处理 | 〔码〕`promotion.ts:57-91` |
| 冷却期 / 证据计数 | 不存在 | 〔档〕`docs/reports/historian-memory-promotion.md:7` |
| embedding 相似度闸门 | 不存在，且 embedding **在提交之后**才产生，不可能作为前筛 | 〔码〕`promotion.ts:96-143` |
| compartment 的 importance | 与提升无关 | 〔码〕`historian.rs:213-227` |

〔测〕真实库佐证：614 条 historian 行的 `importance` **无一条为 NULL**，其中 294 条恰为默认值 50（其余由 `classify-memories` 后置调整），说明落库走的是"默认 50"的写入器而非 Rust 的 `importance = None`。〔测〕`<path>`（schema v94，只读）

---

## 3. 落库映射（fact → `memories` 行）

### 3.1 TS 路径字段表〔码〕

| 列 | 值 | 来源 |
|---|---|---|
| `project_path` | `resolveProjectIdentity(sessionDirectory)`（`git:<root-sha>` 或 `dir:<md5[:12]>`） | `promotion.ts:80`；`:946-948` |
| `category` | fact.category（必须在白名单内） | `promotion.ts:81` |
| `content` | fact.content（原样，不做 trim 存储） | `promotion.ts:82` |
| `normalized_hash` | `md5(content.toLowerCase().replace(/\s+/g," ").trim())` | `normalize-hash.ts:7-11`；`storage-memory.ts:638` |
| `importance` | `input.importance ?? 50`（historian 提升恒为 50） | `storage-memory.ts:564` |
| `scope` | 列默认 `'project'` | `storage-db.ts:1349` |
| `shareable` | 列默认 `0` | `storage-db.ts:1350` |
| `source_session_id` | 当前 session id | `promotion.ts:83` |
| `source_type` | `'historian'` | `promotion.ts:84` |
| `seen_count` / `retrieval_count` | `1` / `0` | `storage-memory.ts:569-570` |
| `first_seen_at` / `created_at` / `updated_at` / `last_seen_at` | 同一个 `Date.now()` | `storage-memory.ts:571-574` |
| `status` | `'active'` | `storage-memory.ts:576` |
| `expires_at` | `resolveExpiresAt(category)`：`WORKFLOW_RULES`=now+90d、`KNOWN_ISSUES`=now+30d，**其余（含 v2 五类）为 NULL** | `promotion.ts:36-39,85`；`constants.ts:67-70` |
| `verification_status` | `'unverified'` | `storage-memory.ts:578` |
| `verified_at` / `superseded_by_memory_id` / `merged_from` / `metadata_json` | `NULL` | `storage-memory.ts:579-582` |
| `classified_at` | 不写（由 `classify-memories` 后置打标） | `storage-memory.ts:1137-1194` |

### 3.2 是否走 agent 写入的同一路径？

**共用底层写入器，但路径比 agent 更窄：**

- 共用：`insertMemory` / `getMemoryByHash` / `updateMemorySeenCount`。
- 差异 1：agent 走 `ctx_memory` 工具，`update/archive/merge` 会 `queueMemoryMutation` 写 mutation log。〔码〕`tools/ctx-memory/tools.ts:682,884,893,972,979`；提升只 INSERT/seen++，**不写 mutation log**。
- 差异 2：`source_type` 不同（historian vs agent vs dreamer）。〔测〕真实库三源分布：historian 614 / agent 194 / dreamer 33。
- 差异 3：权威守卫相同——`assertTsMemoryWriteAllowed` 对 module 管理项目抛错。〔码〕`storage-memory.ts:606-619,636`
- 差异 4：`sourceType: "user"` 被写入器硬拒（保留给 dashboard 手工录入），提升不会走到。`storage-memory.ts:627-635`

### 3.3 epoch 与 mutation log：**都不动**

- `insertMemory` 只写 `memories` + 进程内 embedding 缓存失效（`invalidateProject`，非 DB epoch）。〔码〕`storage-memory.ts:650`；`embedding-cache.ts:61`
- 纯追加写**不产生 `project_state` 行**，已有断言。〔测〕`tools/ctx-memory/tools.test.ts:513-527`
- `memory_mutation_log` 的写入方只在三处：`ctx_memory` 工具、`verify`、`expire-memories`。〔码〕`verify.ts:739,749`；`expire-memories.ts:163-168`
- `project_memory_epoch` 的生产调用点只有：workspace 成员/策略变化、identity 合并、v22 回填，以及**外部（dashboard）改动**所走的那条路径。〔码〕`workspaces.ts:361-365`；`storage-identity-merge.ts:675-679`；`v22-deferred-backfill.ts:173-179`；`inject-compartments.ts:1914-1924`

### 3.4 Rust 两条写入器的语义差异（对齐前必读）

| | TS `promoteSessionFactsDurable` | Rust `promote_facts_tx` | Host single-store `insert_memories` |
|---|---|---|---|
| 去重键 | `(project, category, md5(normalized content))` | 项目内**逐字节 content**，跨类别也命中 | 项目内 live **精确 content** |
| 重复时 | `seen_count += 1`, `last_seen_at` 前移 | **直接 skip，不 bump** | `seen_count += 1` |
| 写入 hash | 真实 md5 | 合成 `historian-exact:<content-hash>:<nonce>` | 真实 md5 |
| importance | `?? 50` | `fact.importance`（module 传 None → NULL） | `unwrap_or(50)` |
| embedding | 提交后 best-effort | 事务内 `raise_embedding_watermark_tx` | 由 publish 流程驱动 |
| 证据 | `promotion.ts:49-94` | `mc-store/src/lib.rs:16318-16398` | `host_store.rs:1286-1346` |

〔测〕真实库 614 条 historian 行的 `normalized_hash` **全部为 32 位 md5 十六进制，`historian-exact:` 前缀 0 条** → 该库当前由 TS/host 写入器写，`promote_facts_tx` 不是活跃路径。同时 `(project_path, category, normalized_hash)` 重复对为 **0**，UNIQUE 约束成立。〔码〕`storage-db.ts:1372`

---

## 4. 是否涉及 LLM

**不涉及。** 事实提升是一次纯数据库操作：

- 输入是 historian 那一次调用的 `<facts>` 解析结果，没有任何第二次 completion。〔码〕`compartment-runner-incremental.ts:1083`；`promotion.ts:49-94`
- Rust 侧同样复用 vendored prompt，不额外调模型。〔码〕`historian_prompt.rs:91-96`
- 唯一外部调用是 **embedding**：`embedPromotedFacts` → `embedTextForProject`，COMMIT 后 best-effort，失败 `sessionLog` 后放弃，等主动 drain 补。〔码〕`promotion.ts:100-143`；`dream-timer.ts:47-49`（`embedUnembeddedMemoriesForProject`）
- 结果被刻意丢弃而非阻塞：向量与当下 `normalized_hash` 不匹配时丢弃（编辑竞态保护）。〔码〕`promotion.ts:118-140`

---

## 5. dreamer 策展（curate）

### 5.1 它做什么

对**单个类别**（五类轮转）执行三阶段，全部经 `ctx_memory` 工具落地：〔码〕`task-prompts.ts:104-128`

| 阶段 | 动作 | 约束 |
|---|---|---|
| A 合并重复 | `merge(ids=[...], content, category)` | 所有 id 必须**同类别**，否则系统拒绝 |
| B 改写措辞 | `update(ids=[N], content, superseded_by=M)` | 删除超过一半内容时必须指名存活者；`write` 只允许拆分（SPLITS ONLY） |
| C 归档冗余 | `archive(ids=[N], superseded_by=M, reason)` | **只有存在同项目同类别存活者**才能归档；裸 "redundant" 会被拒 |

- 硬性规则：**禁止 mint 新事实**（"that is the historian's job"）。〔码〕`task-prompts.ts:55,110,118`
- KEEP 覆盖归档：含 must/never/always 的规则、解释 WHY、外部系统约束、带上下文的路径/配置、`retrieval_count>0`。〔码〕`task-prompts.ts:122`
- 类别轮转状态持久在 task schedule state 里（`cursor` + `activeCategory`），成功后才推进游标。〔码〕`curate-category-rotation.ts:77-135`；跨类别 scope 拒绝 `:145-162`
- legacy 类别映射（`ARCHITECTURE_DECISIONS→ARCHITECTURE` 等）由 rotation 层完成。〔码〕`curate-category-rotation.ts:9-23`

### 5.2 触发机制

| 项 | 值 | 证据 |
|---|---|---|
| 调度 | 进程内 timer 每 **15 分钟** tick，按项目检查 | 〔码〕`plugin/dream-timer.ts:80` |
| 到期判定 | 每任务 5 字段 cron（本地时区），`next_due_at` 存 DB；`""`＝禁用 | 〔码〕`task-scheduler.ts:235-269`；`cron.ts:20-25,114-120` |
| 默认表 | `curate: "0 4 * * 0"`（每周日 04:00）、`verify: "0 3 * * *"`、`map-memories: "0 2 * * *"`、`classify-memories: "0 6 * * *"` | 〔码〕`config/schema/magic-context.ts:540-560` |
| 手动 | `/ctx-dream` → `runManualDream` | 〔码〕`task-scheduler.ts:552` |
| 失败重试 | 瞬时失败热重试至 `MAX_TASK_RETRIES = 3`，仍失败则推到下一个 cron 槽；失败**不推进** `last_run_at` | 〔码〕`task-scheduler.ts:37,319-344` |

### 5.3 并发保护

- 每个任务映射到 **lease kind**；memory 域任务（`map-memories/verify/verify-broad/curate/compress-cues/classify-memories/retrospective/promote-primers/refresh-primers`）**共享同一个 per-project `memory:<identity>` lease**，因此互相串行；只有 `review-user-memories` 走全局 `user-memories` lease。〔码〕`task-registry.ts:262-309`
- 执行器在 **BEGIN IMMEDIATE 前**复核 holder。〔码〕`task-scheduler.ts:82-90` 注释；`expire-memories.ts:155-171` 的 `runLeaseGuardedWrite` 是范例
- 跨进程（module 权威）时同样先取 lease，再分批 100 条通过 module 调用归档。〔码〕`expire-memories.ts:47-120`

### 5.4 对 `project_memory_epoch` / `memory_mutation_log` 的影响

| 机制 | curate / verify / expire 的行为 | 证据 |
|---|---|---|
| `memory_mutation_log` | **写**。`update` / `archive` / `superseded` 各写一行，供 m[1] 渲染 `<memory-updates>` | 〔码〕`tools.ts:682,884,893,972,979`；`verify.ts:739,749`；`expire-memories.ts:163-168`；渲染 `inject-compartments.ts:2823-2875` |
| `project_memory_epoch` | **不写**。epoch 留给外部（dashboard）改动/工作区变化 | 〔码〕`inject-compartments.ts:1914-1924`；`storage-project-state.ts:65-80` |
| 语义 | mutation log 只覆盖"非追加"变更；`update` 非终态，`archive/delete/superseded` 终态且终态优先于后续 update | 〔码〕`storage-memory-mutation-log.ts:9-19` |
| 过期归档 | TTL 到期的 active 行由 `archiveExpiredMemories` 以 `reason='expired'` 归档并入队 mutation；与 curate 是不同任务路径 | 〔码〕`expire-memories.ts:12-13,122-171` |

〔测〕真实库 `memory_mutation_log` 分布：`update 170 / archive 62 / superseded 22`；614 条 historian 行中**148 条**后来成为 mutation 的 target（即 curate/verify/expire 的后续产物，而非创建时写入）。

---

## 6. 失败与幂等

### 6.1 幂等靠什么

| 层 | 机制 | 效果 | 证据 |
|---|---|---|---|
| 前置查重 | `getMemoryByHash(project, category, md5)` | 同文本同类别 → 命中 → 只 `seen_count+=1`，不新增行 | 〔码〕`promotion.ts:70-77` |
| 数据库约束 | `UNIQUE(project_path, category, normalized_hash)` | 竞态兜底；命中即整体回滚（提升路径**不**用 `insertMemoryIdempotent`） | 〔码〕`storage-db.ts:1372`；`promotion.ts:88` vs `storage-memory.ts:660-678` |
| 事务原子性 | 提升与 `appendCompartments` + 边界水位在**同一事务** | 崩溃不会越过"尚未变成记忆的 facts" | 〔码〕`compartment-runner-incremental.ts:1070-1076,1062,1154` |
| 边界重放 | weak-boundary 跳过提升，避免下一轮重述翻倍 | 〔码〕`:914-928` |
| Rust 额外 | `next_nonce = MAX(id)+1` 构造唯一合成 hash；host 写入器用 `last_seen_at == now_ms` 识别"本次发布已写过" | 〔码〕`mc-store/src/lib.rs:16348-16351`；`host_store.rs:1313-1331` |

**已知边角（复刻时不要踩）**：UNIQUE 覆盖**所有 status**，所以已归档行会吸收 `seen_count` 增量而**不会被复活**；同义改写（换词/换类别）仍可新增第二行。〔档〕`docs/reports/historian-memory-promotion.md:19`

### 6.2 失败重试策略

| 失败类型 | 策略 | 证据 |
|---|---|---|
| 存储失败（磁盘/约束/权威） | **传播** → 整个 historian 发布回滚（compartments + 边界都不前进），下一轮整体重试 | 〔码〕`promotion.ts:41-48` |
| 项目为 module 权威 | 吞掉 `ModuleMemoryAuthorityError`，只丢 facts，保留 compartments（避免饿死 overflow 恢复） | 〔码〕`compartment-runner-incremental.ts:1088-1104` |
| 非法/不可提升 fact | 校验跳过，**不**中止发布 | 〔码〕`promotion.ts:41-48` 注释；`:57-68` |
| historian 输出非法 | 2 次尝试（第二次附修复提示），仍失败则整轮失败、什么都不写 | 〔码〕`dsh-plugin/src/dsh/historian.ts:245-293`；MC 侧失败计数/退避 `compartment-runner-incremental.ts:876-887` |
| embedding 失败 | 吞掉 + 记日志；等主动 drain 重试 | 〔码〕`promotion.ts:141-143`；`dream-timer.ts:47-49` |

---

## 7. 可复刻性评估

| # | 契约项 | 判断 | 理由 / 前置依赖 |
|---|---|---|---|
| 7.1 | **提升写入器**（校验 → hash 查重 → INSERT / seen++） | ✅ **适合在本适配器复刻** | 约 60 行纯 SQL；前置依赖：`resolveProjectIdentity`（已有 `memory-bridge.ts:188-190`）、`md5(normalize)`（已有 `normalizeMemoryContent` `:134-136`）。**必须与 7.2 同时做**，否则无类别可写 |
| 7.2 | **facts 契约升级为 `{category, content}`** | ✅ **必须复刻，且是硬前提** | 现状 `facts: string[]` 无类别 ⇒ 提升器会 100% 丢弃。改动点：`historian.ts:127-149`（指令）、`core/compartments.ts:198-203,246`（parser）、`renderCompartment` 的 `facts:` 行 `:103` 需兼容新旧形状 |
| 7.3 | **触发点：与 compartment 发布同事务** | ⚠️ **可复刻但需改结构** | 本适配器把 compartment 存入 `stores.allocateCompartment`（`historian.ts:370-375`），事务边界在 `stores.ts` 内；提升要么并入同一事务，要么接受"compartment 已落、记忆未落"的窗口。建议先做**同函数内紧邻写入**并在 journal 中记录原子性降级 |
| 7.4 | **importance / TTL / scope / shareable 默认值** | ✅ 适合复刻 | 常量表 + 默认值，无外部依赖。注意 `scope/shareable` 在 MC 由 `classify-memories` 后置改写（〔测〕真实库已有 `universe/ecosystem` 行），复刻写入器只需写默认值 |
| 7.5 | **UNIQUE 约束 + seen_count 幂等** | ✅ 适合复刻 | 建索引即可；但**要意识到我们在写一个共享库**：约束由 MC 的 schema 拥有，我们不得修改 schema |
| 7.6 | **embedding（提交后 best-effort）** | ❌ **本节不做** | 需要 embedding provider 配置与模型注册表；MC 有完整 embedding 身份/水位机制（`raise_embedding_watermark_tx`）。缺失只影响语义检索，不影响文本召回与注入 |
| 7.7 | **m[1] `maxMemoryId` 水位 + `<new-memories>`** | ⚠️ **必须做（前置），但形态不同** | MC 的水位是 DB 级；本适配器的基线状态在 `stores.baselineState`。最小做法：把 `maxMemoryId` 存进 `BaselineState`，增量行单独渲染；**否则**新提升的记忆会改召回 digest → 每次提升都 HARD 重建 |
| 7.8 | **权威守卫（module 管理项目禁写）** | ✅ 适合复刻（轻量版） | 只需在写入前 `SELECT 1 FROM authority_managed`；表缺失时视为 TS 所有权〔码〕`storage-memory.ts:606-619` |
| 7.9 | **`memory_mutation_log` / `project_memory_epoch`** | ❌ **必须留在 MC 存储层** | 两者都是 MC 的渲染/失效契约：epoch 由外部写入者与工作区变化驱动，mutation log 由 `ctx_memory`/verify/expire 驱动。适配器复刻会与 MC 自身的写入者抢语义 |
| 7.10 | **dreamer curate 全任务** | ❌ **必须留在 MC 存储层** | 需要：①跨宿主共享的 15 分钟 timer 与 per-project lease；②`ctx_memory` 工具环（agentic tool-loop）；③按类别轮转的持久游标；④LLM 预算（`curate` 1.5M token）。任何一项单独复刻都得不到 curate 的效果 |
| 7.11 | **curate 的产物（mutation log 行）如何被我们消费** | ✅ 读侧可复刻 | 我们可以在召回时读 `memory_mutation_log > 上次水位` 渲染 `<memory-updates>`；语义定义在〔码〕`inject-compartments.ts:2823-2875`。这比复刻 curate 便宜得多 |
| 7.12 | **过期归档（expire）** | ⚠️ 可复刻但不建议优先 | 逻辑简单（`status='active' AND expires_at <= now`），但会写共享库；且 MC 的 dreamer tick 已经在做。**重复做会产生双重归档** |
| 7.13 | **Rust parity** | ❌ 不在本次范围 | 本适配器不经 module 权威路径（〔测〕真实库无 `historian-exact:` 行）。但若用户开启 `single_store`/module 权威，我们的直写会被 MC 拒绝——这正是 7.8 的守卫要处理的 |

---

## 8. 与 m[1] 的关系（新记忆如何在本次会话可见）

### 8.1 MC 的设计（不变式）

```
inject-compartments.ts
 1932  // NOTE: maxMemoryId is NOT a trigger. Additive memory writes surface in m[1]
 1933  // via the maxMemoryId watermark; memory mutations use the m[1] reconcile
 2656  // NOTE: maxMemoryId is deliberately EXCLUDED from this stale-check.
 2657  // Additive memory writes (write/promote) do not invalidate the rendered
 2658  // m[0]; they surface in m[1] via the maxMemoryId watermark.
 2945  const newMemories = eligibleMemories.filter(
 2946      (memory) => memory.id > markers.maxMemoryId && !forcedMemoryIds.has(memory.id),
 2955  const trimmedNewMemories = trimMemoriesToBudgetV2(
 2961      (options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS) * 0.25,
 2970  const newMemoriesBlock = renderMemoryBlockV2(deltaMemories, "new-memories", ...)
```

不变式（可在测试中断言）：

1. **提升（append）不 bump epoch、不进 stale-check** ⇒ 不强制 HARD fold。〔码〕`:2656-2665`
2. 新行在**下一次物化机会**以 `<new-memories>` 进入 m[1]，预算为记忆注入预算的 **25%**。〔码〕`:2955-2963`
3. 非追加变更（update/archive/supersede）走 `maxMemoryMutationId` 游标 + `<memory-updates>`。〔码〕`:2631-2638`；渲染 `:2823-2875`
4. m[0] 里的记忆池只在自然 HARD 时重建 ⇒ **水位移动本身不得单独破坏缓存**。〔码〕`crates/mc-module/src/m1_compose.rs:124-143`
5. `session_facts` 已退役：facts 不再作为渲染源，只能经"提升成记忆"这条路到达模型。〔码〕`:2998-3000`

### 8.2 本适配器的现状与风险（关键）

- 现状：记忆只进 **m[0]** 的 `<project-memories>` 块；delta 只承载 compartments。〔码〕`core/compartments.ts:122-166`
- HARD 重建的触发条件之一就是 **memories digest 变化**。〔码〕`management-pass.ts:177-181`
- 而 digest 是对**入选行** `id:updatedAt` 的 sha1。〔码〕`memory-bridge.ts:421-423`
- ⇒ **一旦开始写记忆，每次提升都可能改变入选集合与 digest → 立即 HARD 重建 → m[0] 前缀变化 → 缓存前缀失效。** 这正是 MC 用 `maxMemoryId` 水位规避的情况。

### 8.3 正确接线（顺序敏感）

1. `BaselineState` 增加 `maxMemoryId`（与 `frozenAt` 同级），HARD 时设为当时的最大 id。〔码〕`core/types.ts` / `stores.ts` 的 `BaselineState`
2. 召回时把行分为 `id <= maxMemoryId`（m[0] 静态池）与 `id > maxMemoryId`（m[1] 增量），**digest 只对前者计算**，增量块单独渲染。
3. 提升写入发生在 historian 的 out-of-band lane（已是"不改变线上字节"的通道，见 `dsh/historian.ts:5-8` 与 `management-pass.ts:336-363`）；下一次 execute band 才把增量渲染上去——与 MC 的"下一次物化机会"一致。
4. 增量块预算：MC 用记忆预算的 25%，本适配器可用 `policy.memoryBudgetTokens * 0.25`（现为 8000×0.25=2000）。〔码〕`core/policy.ts:35,51`

---

## 9. 验收断言建议（3–6 条不变式）

| # | 不变式 | 断言方式 | 对应 MC 证据 |
|---|---|---|---|
| A1 | **同一 fact 提升两次只产生一行**；第二次只让 `seen_count` 从 1→2 且 `last_seen_at` 前移 | 构造 `{category:'CONSTRAINTS', content:'X'}`（含大小写/多空白变体）跑两次，断言 `COUNT(*)=1`、`seen_count=2`；对变体断言 hash 相同 | 〔码〕`promotion.ts:70-77`；`normalize-hash.ts:7-11` |
| A2 | **提升是纯追加**：不写 `memory_mutation_log`、不产生/不修改 `project_state` 行（epoch 不变） | 提升前后快照两表；`COUNT(memory_mutation_log)` 与 `project_memory_epoch` 均不变 | 〔测〕`tools.test.ts:513-527`；〔码〕`inject-compartments.ts:2656-2660` |
| A3 | **项目隔离**：提升只改目标 `project_path` 的行数；其它项目行数、epoch、digest 一律不变 | 两个 identity 各播种若干行，只提升其一 | 〔码〕`promotion.ts:80`；`getMaxMemoryIdForProjects` `storage-memory.ts:917-944` |
| A4 | **不合格 fact 不产生行、也不中止发布**：空 content / 非白名单类别 / `category` 非 string | 混合输入（1 条合法 + 3 条非法）断言只新增 1 行，且 compartment 行数正常推进 | 〔码〕`promotion.ts:57-68`；`:41-48` |
| A5 | **原子性**：注入 `BEFORE INSERT ON memories` 的失败触发器时，compartments 与边界水位都不前进 | 复现 MC 测试手法（`CREATE TRIGGER ... RAISE(ABORT)`），断言 compartment 计数不变 | 〔码〕`compartment-runner-incremental.ts:1070-1076,1154`；测试先例 `compartment-runner.test.ts:1756` |
| A6 | **类别决定 TTL**：`WORKFLOW_RULES` → `expires_at ≈ now+90d`；v2 五类 → `expires_at IS NULL` | 断言写入行的 `expires_at` 与类别映射 | 〔码〕`constants.ts:67-70`；`promotion.ts:36-39` |
| A7 | **水位可见性**：提升后新行 `id > baseline.maxMemoryId`，出现在 m[1] 增量块，且 m[0] 字节不变（缓存前缀不破） | 断言 `renderBaseline` 输出中 m[0] 段逐字节相同、增量段含新行 | 〔码〕`inject-compartments.ts:2944-2975,2656-2660` |

（A1/A2/A5/A7 是最能抓住回归的四条；其余为补充。）

---

## 10. 最小实现建议

> **如果只能做一件事让"记忆能产生"：把 `facts` 契约升级为 `{category, content}`，并在 historian 落库的同一函数里加一个 60 行的幂等提升写入器。这两件事不可拆——没有类别，提升器写不进去；有类别没写入器，事实仍然只是 compartment 里的文本。**

具体落点（不改 MC，只改 `packages/dsh-plugin`）：

1. **契约**（必改，这是"0 条记忆"的直接原因）
   - `src/dsh/historian.ts:127-149`：把 `"facts": ["..."]` 改为按类别分组的对象数组，或保留 `string[]` 但并行输出 `[{category, content}]`；在指令里列出五个 v2 类别。
   - `src/core/compartments.ts:198-203,246`：`asStringArray` → `asFactArray`，输出 `{category, content}[]`，非白名单类别按 MC 语义**丢弃而不报错**。
2. **提升写入器**（新增 `src/core/memory-promote.ts`，只依赖 `node:sqlite` + `createHash`）
   - `md5(content.toLowerCase().replace(/\s+/g,' ').trim())`，与 `memory-bridge.ts:134-136` 的归一化必须**同一实现**。
   - `SELECT id FROM memories WHERE project_path=? AND category=? AND normalized_hash=?` → 命中则 `seen_count+=1, last_seen_at=now, updated_at=now`；未命中则 INSERT，字段按 §3.1 表，`source_type='historian'`、`status='active'`、`importance=50`、`verification_status='unverified'`。
   - 写入前守卫：`authority_managed` / `authority_repair_pending` 命中即**跳过**（不是抛错中止会话）。
   - **不要**写 `memory_mutation_log`，**不要**bump `project_memory_epoch`。
3. **可见性**（前置，否则第 2 步会破缓存）
   - `BaselineState` 增 `maxMemoryId`；m[0] digest 只覆盖 `id <= maxMemoryId`；`id > maxMemoryId` 的行进 m[1] 增量块。
4. **开关**：新增 `memory.autoPromote`（默认 false，先 shadow 观察 journal），等 §9 的 A1/A2/A4 全绿再默认 true。

**明确不要做**（本阶段）：

- ❌ 不要复刻 dreamer curate/verify/expire——它们在 MC 里已经在跑，重复写共享库会双重归档。
- ❌ 不要写 `project_memory_epoch`——只有外部（dashboard）改动才该 bump。
- ❌ 不要在没有 m[1] 水位时先写记忆——按本适配器当前的 digest 逻辑，每次写入都会 HARD 重建并破坏缓存前缀。

---

## 附录 A：只读实测（真实库，未做任何写入）

```
db   : <path>
mode : file:...?mode=ro + PRAGMA query_only=1
schema_migrations(LATEST < 10000): 94
```

| 观测 | 结果 | 推论 |
|---|---|---|
| 行数按 `source_type` | historian 614 / agent 194 / dreamer 33 | 提升是主要写入者，与 MC 报告一致 |
| historian `importance` | 无 NULL；294 行为 50 | 走"默认 50"的写入器，非 Rust `promote_facts_tx` |
| historian `scope/shareable/status` | `project/0/active` 248 · `project/1/active` 271 · archived 72 · `universe|ecosystem` 23 | 写入时只写默认值，`scope/shareable` 由 `classify-memories` 后置改写 |
| `normalized_hash` 形状 | historian/agent/dreamer 全为 32 位 md5，`historian-exact:` 0 条 | 本库由 TS/host 写入器写 |
| `(project_path, category, normalized_hash)` 重复对 | 0 | UNIQUE 成立 |
| historian `expires_at` | 614 条全为 NULL | 当前没有 `WORKFLOW_RULES`/`KNOWN_ISSUES` 事实进入 |
| historian `seen_count > 1` | 1 条 | 精确重复重述很少，侧证去重有效但覆盖面有限 |
| `memory_mutation_log` | update 170 · archive 62 · superseded 22 | 全部来自 `ctx_memory`/verify/expire，非提升 |
| historian 行为 mutation target | 148 条 | 生命周期后置变更，非创建时写入 |
| `project_state` 最高项目 | epoch 3 / 247 行 | epoch 与行数无线性关系，符合"只在语义变更时 bump" |

〔测〕脚本：`%TEMP%\mc-probe-promotion.py`（本文以外不落任何文件）。

## 附录 B：证据索引（按主题）

| 主题 | 关键位置 |
|---|---|
| 提升入口 | `packages/plugin/src/hooks/magic-context/compartment-runner-incremental.ts:943-948, 1062, 1077-1105, 1154` |
| 提升实现 | `packages/plugin/src/features/magic-context/memory/promotion.ts:32-144` |
| 类别白名单/TTL | `packages/plugin/src/features/magic-context/memory/constants.ts:9-29, 67-70` |
| 归一化 hash | `packages/plugin/src/features/magic-context/memory/normalize-hash.ts:3-11` |
| 插入默认值 | `packages/plugin/src/features/magic-context/memory/storage-memory.ts:551-585, 627-652` |
| 表结构/唯一约束 | `packages/plugin/src/features/magic-context/storage-db.ts:1342-1373`（memories）、`:1476-1491`（mutation log） |
| mutation log 写入方 | `packages/plugin/src/tools/ctx-memory/tools.ts:682, 884-893, 972-979`；`dreamer/verify.ts:739-749`；`dreamer/expire-memories.ts:163-168` |
| epoch | `packages/plugin/src/features/magic-context/storage-project-state.ts:65-80`；`workspaces.ts:361-365`；`inject-compartments.ts:1914-1924` |
| m[1] 水位与渲染 | `packages/plugin/src/hooks/magic-context/inject-compartments.ts:1932-1933, 2621-2665, 2944-2975, 2998-3000` |
| Rust 提升 | `crates/mc-store/src/lib.rs:16318-16398`；`crates/mc-store/src/context_writes.rs:288-328`；`crates/mc-module/src/historian.rs:213-227, 831-840, 3115` |
| Host 单库写入 | `crates/mc-module/src/host_store.rs:1286-1346` |
| dreamer 任务注册/lease | `packages/plugin/src/features/magic-context/dreamer/task-registry.ts:13-28, 72-121, 262-309` |
| dreamer 调度 | `packages/plugin/src/features/magic-context/dreamer/task-scheduler.ts:37, 235-269, 319-344, 552`；`plugin/dream-timer.ts:80`；`dreamer/cron.ts:20-25` |
| curate 提示与阶段 | `packages/plugin/src/features/magic-context/dreamer/task-prompts.ts:40-57, 97-129`；`dreamer/curate-category-rotation.ts:77-162` |
| 默认 cron | `packages/plugin/src/config/schema/magic-context.ts:540-560` |
| 本适配器缺口 | `packages/dsh-plugin/src/core/compartments.ts:26, 122-166, 198-203, 246`；`src/dsh/historian.ts:127-149, 370-375`；`src/dsh/management-pass.ts:177-181, 336-363`；`src/core/memory-bridge.ts:134-136, 421-423`；`src/core/policy.ts:35, 51` |
| 既有文档 | `docs/reports/historian-memory-promotion.md`；`docs/architecture/memory-and-search.md:27`；`docs/architecture/historian.md:73`；`CONFIGURATION.md:741`；`docs/dsh-plugin-project-memory-review-2026-10-06.md:72-74` |
