# MC 记忆写路径存储契约（DSH 适配器实现用）

> 提取自 Magic Context 源码 + 用户真实生产库（只读实测）。
> 目标读者：`packages/dsh-plugin` 写入路径的实现者。
> 标注约定：〔码〕= 源码 file:line；〔档〕= 仓库文档；〔测〕= 本次实测（Node 24 / 真实 context.db）。
> 所有文件名相对于仓库根 `<path>`。

---

## 0. 结论先行（12 条硬结论）

1. **真实库 schema 版本 = 94**（`schema_migrations` 表 94 行，`MAX(version)=94`；`PRAGMA user_version` 是 **0**，不要用它判版本）。〔测〕
2. `memories` 表 **28 列**，权威 `CREATE TABLE` 在 `storage-db.ts:1342-1373`，与真实库 DDL **逐字节一致**。〔测〕
3. 去重键是 **`UNIQUE(project_path, category, normalized_hash)`**，作用域 = 项目身份 × 类别 × 内容哈希（**不含 status**——archived 行仍占位，重复写入会命中已归档行）。〔码〕`storage-db.ts:1372`
4. `normalized_hash` = `md5(content.toLowerCase().replace(/\s+/g," ").trim())` 的**小写 hex**。Rust 侧用等价的 JS-`\s` 码点集合复刻，两运行时同哈希。〔码〕`normalize-hash.ts:3-12`、`mc-store/src/lib.rs:17506-17536`
5. **写入前必须查重并走"已存在则 bump seen_count"分支**：`insertMemory` 本身不做查重，靠 UNIQUE 抛错；工具层与 Rust facade 各自显式查重。直接用裸 INSERT 会在重复内容上抛 `UNIQUE constraint failed`。〔码〕`storage-memory.ts:627-652,660-678`；`mc-store/src/lib.rs:6568-6620`
6. **新增（additive write）不 bump epoch、不写 mutation log**。它靠 `maxMemoryId` 水位在 m[1] 的 `<new-memories>` 里浮现；只有 `update`/`archive`/`merge(superseded)` 写 `memory_mutation_log`，渲染成 m[1] 的 `<memory-updates>`。〔档〕`ARCHITECTURE.md:97,106`；〔码〕`inject-compartments.ts:1932-1935`
7. **`project_memory_epoch` 只由外部写入者（dashboard）与身份迁移 bump**；活跃会话内的 `ctx_memory` 写路径**绝不** bump。〔档〕`ARCHITECTURE.md:106`
8. **真实库已装权威守卫触发器**：`memories_authority_guard_{insert,update,delete}` 会在项目被标记进 `authority_managed`/`authority_repair_pending` 且 `context_privilege_state.enabled=0` 时 `RAISE(ABORT,'context.db memory writes are managed by the Rust module')`。**当前两表均为空 → 现阶段直写不会被拒**，但契约必须实现"检测 + 让路"。〔测〕〔码〕`migrations.ts:216-244`
9. FTS 靠 **AFTER 触发器**同步（`memories_ai/ad/au`），外部内容表 `memories_fts`。**不要**手动写 FTS，否则与触发器双写、索引损坏。〔测〕〔码〕`storage-db.ts:1746-1757`
10. `UPDATE memories` 的 `memories_au` 触发器会重建 FTS 行，所以更新内容**无需**另写 FTS。〔测〕
11. 第二个宿主（我们）与 OpenCode 里的 MC 同时写是**安全的**，前提是：每次写用 **`BEGIN IMMEDIATE`**、`busy_timeout` ≥ 5000ms、WAL 已是库级持久设置、**绝不**在 `BEGIN` 之前缓存"查重结果"。`memory_mutation_log.id` 是 AUTOINCREMENT 全局单调，天然给两侧一个统一顺序。〔码〕`sqlite.ts:286-330,834-871`
12. MC 的 TS 模块在 Node 24 下**可以**直接 import，但需要两件事：`--experimental-transform-types`（默认的类型剥离不支持参数属性）+ 一个**无扩展名相对导入的解析钩子**。满足后 `storage-memory.ts`/`storage-memory-fts.ts`/`workspaces.ts`/`project-identity.ts`/`memory-visibility.ts` 全部加载成功，可直接复用——**不必抄**。唯一不可用的是 `tools/ctx-memory/tools.ts`（依赖未安装的 `@opencode-ai/plugin`）。〔测〕见 §12

---

## 1. `memories` 全字段

### 1.1 权威 DDL

〔码〕`packages/plugin/src/features/magic-context/storage-db.ts:1342-1373`（新库建表）；真实库 DDL 与之逐字节相同〔测〕：

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  importance INTEGER,
  scope TEXT NOT NULL DEFAULT 'project',
  shareable INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT,
  source_type TEXT DEFAULT 'historian',
  seen_count INTEGER DEFAULT 1,
  retrieval_count INTEGER DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_retrieved_at INTEGER,
  status TEXT DEFAULT 'active',
  expires_at INTEGER,
  verification_status TEXT DEFAULT 'unverified',
  verified_at INTEGER,
  classified_at INTEGER,
  superseded_by_memory_id INTEGER,
  merged_from TEXT,
  metadata_json TEXT,
  mural_cue TEXT,
  mural_cue_hash TEXT,
  mural_cue_at INTEGER,
  mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_path, category, normalized_hash)
);
```

同一定义也出现在 Rust 测试夹具 `crates/mc-module/tests/fixtures/context-db-schema.sql:261-292`，可交叉核对。

### 1.2 逐列语义（写入时谁负责填）

| 列 | 类型 | 默认 | NOT NULL | 写入方与取值 |
|---|---|---|---|---|
| `id` | INTEGER | AUTOINCREMENT | PK | SQLite |
| `project_path` | TEXT | — | ✔ | **项目身份**，`git:<root-commit-sha>` 或 `dir:<md5前12位>`；见 §1.4 |
| `category` | TEXT | — | ✔ | 五类之一，见 §3 |
| `content` | TEXT | — | ✔ | 工具层已 `trim()`；见 §11.1 |
| `normalized_hash` | TEXT | — | ✔ | `computeNormalizedHash(content)`，见 §2 |
| `importance` | INTEGER | NULL | ✘ | 插入时 `input.importance ?? 50`〔码〕`storage-memory.ts:564`；Rust 传 `None` 时留 NULL，但真实库 0 行 NULL（classify 已回填）〔测〕 |
| `scope` | TEXT | `'project'` | ✔ | 插入固定 `'project'`；classify 后续改，见 §4 |
| `shareable` | INTEGER | `0` | ✔ | 插入固定 0；classify 置位，见 §4 |
| `source_session_id` | TEXT | NULL | ✘ | 调用方 sessionID |
| `source_type` | TEXT | `'historian'` | ✘ | 插入默认 `"historian"`；TS 工具层用 `deps.sourceType ?? "agent"`，dreamer 分支用 `"dreamer"`；`"user"` **被强制拒绝**，见 §1.3 |
| `seen_count` | INTEGER | `1` | ✘ | 插入=1；重复写入 +1 |
| `retrieval_count` | INTEGER | `0` | ✘ | 插入=0；显式检索 +1，见 §9 |
| `first_seen_at` | INTEGER | — | ✔ | 插入 = `now`（`Date.now()`，epoch ms） |
| `created_at` | INTEGER | — | ✔ | 插入 = `now` |
| `updated_at` | INTEGER | — | ✔ | 插入 = `now`；每次 UPDATE 都要刷新 |
| `last_seen_at` | INTEGER | — | ✔ | 插入 = `now`；见 §9 |
| `last_retrieved_at` | INTEGER | NULL | ✘ | 插入 NULL；显式检索时 = now |
| `status` | TEXT | `'active'` | ✘ | 插入 `'active'`；见 §4 |
| `expires_at` | INTEGER | NULL | ✘ | 插入 = `input.expiresAt ?? null`；真实库 0 行非空〔测〕 |
| `verification_status` | TEXT | `'unverified'` | ✘ | 插入 `'unverified'`；真实库 100% `unverified`〔测〕 |
| `verified_at` | INTEGER | NULL | ✘ | 插入 NULL；仅 `updateMemoryVerification` 在 status='verified' 时写，见 §9 |
| `classified_at` | INTEGER | NULL | ✘ | 插入不写（NULL）；classify 打点；内容更新时清 NULL |
| `superseded_by_memory_id` | INTEGER | NULL | ✘ | merge 时置替换者 id，见 §11.4 |
| `merged_from` | TEXT | NULL | ✘ | merge 时写 JSON 数组（升序去重 id）〔码〕`tools.ts:793-814` |
| `metadata_json` | TEXT | NULL | ✘ | archive reason 等；插入 `input.metadataJson ?? null` |
| `mural_cue` / `mural_cue_hash` / `mural_cue_at` | TEXT/TEXT/INTEGER | NULL | ✘ | 内容压缩产物，写入路径只**清空**，见 §4.5 |
| `mural_cue_rejection_count` | INTEGER | `0` | ✔ | 内容更新时归零 |

**注意 `importance` 的插入分支**：`getInsertMemoryStatement` 有带/不带 importance 两种形态（旧库列守卫），新库一律走带 importance 的 21 值 INSERT。〔码〕`storage-memory.ts:332-345`

### 1.3 `source_type = "user"` 被硬拒

〔码〕`storage-memory.ts:627-635`：

```ts
if (input.sourceType === "user") {
  throw new Error(
    `sourceType "user" is reserved for future dashboard manual entry and cannot be written by agent paths`,
  );
}
```

真实库只有 `historian`(614) / `agent`(194) / `dreamer`(33)，无 `user`〔测〕。

### 1.4 `project_path` 的取值（写错 = 记忆分裂）

- 已是 `git:` / `dir:` 前缀 → **原样返回**。〔码〕`project-identity.ts:790-793`
- 否则解析为 `git:<root-commit-sha>`（`git rev-parse` 根的 commit）〔码〕`project-identity.ts:400`
- 非 git 目录回退 `dir:<md5(canonicalPath) 前 12 位>`〔码〕`project-identity.ts:176-178`
- 解析失败时**保留原始字符串**，绝不臆造第二个身份。〔码〕`project-identity.ts:795-800`
- 归属判定：`storedProjectPath === identity || normalizeStoredProjectPath(storedProjectPath) === identity`〔码〕`project-identity.ts:812-820`

〔测〕真实库 28 个不同 `project_path`，全部为 `git:`/`dir:` 形态，例如 `git:dfbf85f5…`(247 条)、`dir:b107f9d493dd`(98 条)。

### 1.5 索引与触发器（真实库实测）

索引〔测〕（源码：`storage-db.ts:2035-2037`）：

```sql
CREATE INDEX idx_memories_project_status_category ON memories(project_path, status, category);
CREATE INDEX idx_memories_project_status_expires  ON memories(project_path, status, expires_at);
CREATE INDEX idx_memories_project_category_hash   ON memories(project_path, category, normalized_hash);
-- 加上 UNIQUE 约束自动生成的 sqlite_autoindex_memories_1
```

FTS 外部内容表〔测〕〔码〕`storage-db.ts:1746-1757`：

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, category, content='memories', content_rowid='id', tokenize='porter unicode61');

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;
```

权威守卫触发器 3 个（详见 §8.4）。

---

## 2. `normalized_hash` 算法

### 2.1 原函数

〔码〕`packages/plugin/src/features/magic-context/memory/normalize-hash.ts:1-12`（全文）：

```ts
import { createHash } from "node:crypto";

export function normalizeMemoryContent(content: string): string {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeNormalizedHash(content: string): string {
    const normalized = normalizeMemoryContent(content);
    // node:crypto's MD5 produces the exact same hex digest as Bun.CryptoHasher("md5"),
    // so existing memory hashes remain stable across the runtime swap.
    return createHash("md5").update(normalized).digest("hex");
}
```

**精确步骤**（无 Unicode 归一化、无截断）：

| 步骤 | 操作 | 备注 |
|---|---|---|
| 1 | `toLowerCase()` | JS 语义的 Unicode 小写（非 locale 感知） |
| 2 | `replace(/\s+/g, " ")` | 连续空白折叠为**单个半角空格** |
| 3 | `trim()` | 去掉首尾空白（`\s` 定义） |
| 4 | MD5（UTF-8 字节） | 输出 **32 位小写 hex**（无 `0x`、无分隔） |

**不在算法内**：Unicode NFC/NFD 归一化、标点归一化、截断、类别/项目参与哈希。大小写与空白之外的一切差异都会产生不同哈希。

### 2.2 两运行时等价性（Rust 侧复刻）

Rust **不能**直接用 `char::is_whitespace`，因为 JS 的 `\s` 与 Rust 定义差两个码点（含 `U+FEFF`、不含 `U+0085`）。〔码〕`crates/mc-store/src/lib.rs:17501-17536`：

```rust
pub fn compute_normalized_memory_hash(content: &str) -> String {
    let normalized = content
        .to_lowercase()
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let digest = md5::compute(normalized.as_bytes());
    format!("{digest:032x}")
}

fn is_js_whitespace(ch: char) -> bool {
    matches!(ch,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}'
        | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}
```

⚠️ Rust 用 `split+filter+join` 而非 `replace`，对**全空白输入**会得到空串——与 JS `trim()` 结果一致；这是两运行时唯一的边界一致性来源，不要改成自己的 trim。

### 2.3 去重作用域与事务形状

- **作用域**：`(project_path, category, normalized_hash)`。不含 `status`/`scope`/`source_type`。〔码〕`storage-db.ts:1372`
- **TS 工具层事务形状**（`update`/`merge` 是 `BEGIN IMMEDIATE`，`write` **不是**）：

〔码〕`tools.ts:659-689`（update：查重与写入在同一 IMMEDIATE 事务内）：

```ts
// Probe + write share one BEGIN IMMEDIATE so a concurrent insert
// cannot slip in between; UNIQUE remains the friendly fallback.
runImmediateTransaction(deps.db, () => {
    const duplicate = getMemoryByHash(deps.db, rawProjectPath, targetCategory, normalizedHash);
    if (duplicate && duplicate.id !== memory.id) { duplicateId = duplicate.id; return; }
    updateMemoryContentInCurrentTransaction(deps.db, memory, content, normalizedHash, targetCategory);
    queueMemoryMutation(deps.db, { projectPath: projectIdentity, mutationType: "update",
        targetMemoryId: memory.id, category: targetCategory, newContent: content });
});
```

- **`write`（新增）路径是单条语句、非显式事务**：先裸查重（`getMemoryByHash`），命中就 bump seen_count 返回；否则 `insertMemoryIdempotent`（内部 INSERT，UNIQUE 冲突时回退到"bump seen_count"）。〔码〕`tools.ts:548-581`、`storage-memory.ts:660-678`
- **Rust facade 全程包在一个由 `with_facade_command` 拥有的 `context.db` 事务里**——"一个命令的写入一起提交"。〔码〕`mc-store/src/lib.rs:6560-6562`

**给我们的实现建议**：把"查重 + INSERT"和"查重 + UPDATE"都放进一个 `BEGIN IMMEDIATE`，即使 MC 的 write 路径没这么做——UNIQUE 是安全网，但显式事务让 seen_count 分支与插入互斥，避免第二宿主插在中间。

---

## 3. 类别词表与漂移

### 3.1 当前可写五类（v2 world taxonomy）

〔码〕`memory/constants.ts:9-15`：

```ts
export const V2_MEMORY_CATEGORIES = [
    "PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING",
] as const satisfies readonly MemoryCategory[];
```

注释（`constants.ts:3-8`）明确：**这是 agent 今天唯一可以 WRITE 的类别集合**；旧的 9 类值**仍可读**（保留排序/渲染/TTL）但新写入不再接受。

工具层把它做成 schema enum，非法类别在**参数校验**阶段就失败：〔码〕`tools.ts:398-400`

```ts
category: tool.schema.enum([...V2_MEMORY_CATEGORIES]).optional()
```

运行时二次校验：`getValidatedCategory` → `isMemoryCategory` → `MEMORY_CATEGORY_LOOKUP`（12 个键，5 个 v2 + 7 个 legacy）。〔码〕`tools.ts:233-245`、`storage-memory.ts:44-59`

### 3.2 旧类别（含 2 个与 v2 重叠）

`types.ts:1-20` 的 `MemoryCategory` 联合类型列出全部 12 个字面量：

| v2（5，可写） | legacy（7，只读可续写） |
|---|---|
| `PROJECT_RULES` | `ARCHITECTURE_DECISIONS` |
| `ARCHITECTURE` | `CONFIG_DEFAULTS` |
| `CONFIG_VALUES` | `USER_PREFERENCES` |
| `CONSTRAINTS`（v2/v1 共有） | `USER_DIRECTIVES` |
| `NAMING`（v2/v1 共有） | `ENVIRONMENT` |
| | `WORKFLOW_RULES` |
| | `KNOWN_ISSUES` |

漂移映射的**唯一权威说明**在 `types.ts:8-11`：legacy 值是"accept-both bridge"，dreamer 的 curate 任务在下次触碰该行时把它映射进 5 类集合；historian 不再产出它们。

### 3.3 谁来选类别

1. **historian（自动历史压缩）** 决定新记忆的类别 —— 它是 5 类的"今天 emit 者"（`constants.ts:6`）。
2. **主 agent 通过 `ctx_memory action=write`** 显式指定，必须在 5 类内。
3. **`update`/`merge` 的类别**：`update` 允许**改类别**（`tools.ts:650-654`：只有传了合法 v2 类别才改，否则保持原类别）；`merge` 类别 = 显式参数 ?? 源记忆类别。〔码〕`tools.ts:785-789`
4. **禁止跨类别 merge**——结构上拒绝，不是提示词规则：〔码〕`tools.ts:780-783`

```
Error: Cannot merge memories from different categories (A, B). If they are genuine
duplicates, one is miscategorized — archive the redundant one instead of merging across categories.
```

5. **dreamer curate** 一次只处理一个类别（`curate-category-rotation`）。

〔测〕真实库**只有 5 个 v2 类别**，零 legacy 行——漂移已经完成：

| category | 条数 |
|---|---|
| CONFIG_VALUES | 266 |
| CONSTRAINTS | 197 |
| ARCHITECTURE | 187 |
| PROJECT_RULES | 151 |
| NAMING | 40 |

### 3.4 类别顺序常量（渲染排序用）

〔码〕`constants.ts:31-57`。`CATEGORY_PRIORITY` = 5 个 v2 在前，然后 `USER_DIRECTIVES, USER_PREFERENCES, CONFIG_DEFAULTS, ARCHITECTURE_DECISIONS, ENVIRONMENT, WORKFLOW_RULES, KNOWN_ISSUES`；未知类别序 99。SQL 形态 `MEMORY_CATEGORY_ORDER_SQL` 在 `constants.ts:55-57`，Rust 对等物 `memory_render.rs:62-68,70-88`。

### 3.5 TTL 默认

〔码〕`constants.ts:66-70`（仅 legacy 类别有条目，v2 无 TTL → 永久）：

```ts
export const CATEGORY_DEFAULT_TTL: Partial<Record<MemoryCategory, number>> = {
    WORKFLOW_RULES: 90 * 24 * 60 * 60 * 1000, // 90 days
    KNOWN_ISSUES: 30 * 24 * 60 * 60 * 1000,   // 30 days
};
```

---

## 4. 状态 / scope / shareable / expires 语义

### 4.1 `status` 取值集合

`types.ts:22`：

```ts
export type MemoryStatus = "active" | "permanent" | "archived";
```

**只有三个值**——没有 `expired`（过期靠 `expires_at` + 查询谓词表达，不改 status）。

合法迁移：

| 从 | 到 | 触发 | 写者 |
|---|---|---|---|
| （无） | `active` | INSERT | `insertMemory`（硬编码 `'active'`）〔码〕`storage-memory.ts:576` |
| `active` | `archived` | archive 工具 / dreamer expire / merge 的源 | `archiveMemory`、`supersededMemory` |
| `permanent` | `archived` | 同上 | 同上 |
| `archived` | `active`/`permanent` | **仅**通过 `mergeMemoryStats` 把合并目标设为 `mergedStatus`〔码〕`storage-memory.ts:1202-1219` |
| `active`/`permanent` | `archived` + `superseded_by_memory_id` | merge 源 | `supersededMemory`〔码〕`storage-memory.ts:1197-1200,482-491` |

**没有"归档 → 取消归档"的写路径**：`memory_mutation_log` 的注释明确说 un-archive 只能靠 **epoch bump 触发的整块 re-materialize**，绝不通过 mutation log。〔码〕`storage-memory-mutation-log.ts:9-14`

真实库分布〔测〕：`active` 757、`archived` 84，**无 `permanent`**（但类型与查询都支持）。

### 4.2 `scope` 取值与含义

`types.ts:23`：

```ts
export type MemoryScope = "project" | "ecosystem" | "universe";
```

- 插入固定 `'project'`〔码〕`storage-memory.ts:576`
- 只有 `setMemoryClassification` 能改（classify 任务/dreamer），且非法值抛 `invalid memory scope: X`〔码〕`storage-memory.ts:1161-1170`
- 真实库分布〔测〕：`project` 808、`universe` 18、`ecosystem` 15

**对外可见性语义**（`FOREIGN_VISIBLE_SQL`，`memory/visibility.ts:5-6`，注释要求与 mc-store 的 `FOREIGN_VISIBLE_SQL` **逐字节一致**）：

```sql
status IN ('active','permanent')
  AND (expires_at IS NULL OR expires_at > :now_ms)
  AND shareable = 1
  AND scope IN ('project','ecosystem','universe')
  AND category IN (SELECT value FROM json_each(:share_categories))
  AND project_path IN (SELECT project_path FROM workspace_members WHERE workspace_id = :workspace_id)
  AND project_path <> :reader_project
```

即：**`scope` 的三个值在外项目可见性判定里权重相同**（不是 project<ecosystem<universe 的层级放松）。真正决定跨项目可见的是 `shareable=1` + workspace 成员 + workspace `share_categories` 白名单。

### 4.3 `shareable` 由谁置位

- 插入恒为 `0`（私有）〔码〕`storage-memory.ts:576`（注意：INSERT 语句里 `shareable` 甚至不在列清单里，靠 DEFAULT 0）
- **唯一置位者 = classify 任务**，经 `setMemoryClassification(db, id, { shareable })`；实现是 `shareable = ?` 赋 1/0，且**只有值真正变化才写**（避免无意义 bytes 变化）〔码〕`storage-memory.ts:1171-1177`
- **内容一变就 fail-closed 归零**（关键安全不变量）：

〔码〕`storage-memory.ts:1075-1081`：
> The `shareable` flag was scored against the OLD content by classify; new content invalidates that judgement. Fail closed: reset to private so a now-sensitive edit can't inherit a stale shareable=1.

```sql
UPDATE memories SET shareable = 0 WHERE id = ?   -- 内容更新事务内
```

同一不变量在 rust facade（`mc-store/src/lib.rs:6664`）与 dashboard（`db.rs:6081-6086`）都复刻了。

真实库 `shareable` 分布：0 → 445、1 → 396〔测〕。

### 4.4 `expires_at` 规则

- 插入 = `input.expiresAt ?? null`；**插入路径不套用 `CATEGORY_DEFAULT_TTL`**（TTL 常量由 promotion/dreamer 侧消费）
- 存储的是**绝对 epoch ms**，不是 TTL
- 过期不改 `status`；读取侧统一用 `(expires_at IS NULL OR expires_at > <cutoff>)` 过滤
- **cutoff 必须可冻结**：m[1] 渲染路径传入 m[0] 物化时间戳作为冻结 cutoff，避免两次 defer 之间一条记忆跨过 `expires_at` 导致 wire 字节变化（cache bust）〔码〕`storage-memory.ts:697-701`
- 真实库 0 行非空 `expires_at`〔测〕

### 4.5 内容更新必须连带清空的字段

〔码〕`storage-memory.ts:1072-1119`，一个 `.immediate()` 事务内：

```sql
UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?;
UPDATE memories SET shareable = 0 WHERE id = ?;                                  -- 列守卫
UPDATE memories SET classified_at = NULL WHERE id = ?;                           -- 列守卫
UPDATE memories SET mural_cue = NULL, mural_cue_hash = NULL, mural_cue_at = NULL,
                    mural_cue_rejection_count = 0 WHERE id = ?;                  -- 列守卫
DELETE FROM memory_verifications WHERE memory_id = ?;                            -- 表守卫
DELETE FROM memory_embeddings WHERE memory_id = ?;                               -- 触发 re-embed
```

⚠️ TS 工具层版本 `updateMemoryContentInCurrentTransaction`（`tools.ts:361-384`）**多写一列 `category`**（支持 recategorize），且用 `clearMemoryVerifications`；Rust facade 版本（`mc-store/src/lib.rs:6657-6673`）同样含 `category` 与 mural 三列。

⚠️ **`setMemoryClassification` 只 stamp `classified_at` 不算 bytes 变化**（注释说 stamp 时间戳不影响渲染 m[0] 字节，保持 cache-neutral）〔码〕`storage-memory.ts:1183-1190`。

---

## 5. `project_state.project_memory_epoch`

### 5.1 表结构

〔码〕`storage-db.ts:1573-1578`；真实库一致〔测〕：

```sql
CREATE TABLE project_state (
  project_path TEXT PRIMARY KEY,
  project_memory_epoch INTEGER NOT NULL DEFAULT 0,
  project_user_profile_version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
```

〔测〕真实库 6 行；epoch 分布：3 → 5 个项目、0 → 1 个项目。

### 5.2 何时 bump（确切判定）

**核心规则（权威）**〔档〕`ARCHITECTURE.md:106`：

> **Memory mutations route through m[1], not the epoch.** In-session `ctx_memory` mutations do NOT bump `project_memory_epoch`: additive writes surface via the `maxMemoryId` watermark; non-additive (`update`/`archive`/`merge`) record a `memory_mutation_log` row rendered as a `<memory-updates>` delta. Both reconcile into m[0] on the next natural hard bust. The epoch is bumped only by **dashboard** mutations (an external editor can't otherwise signal a running session).

**bump 的实现**〔码〕`storage-project-state.ts:65-83`：

```sql
INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
VALUES (?, 1, 0, ?)
ON CONFLICT(project_path) DO UPDATE SET
   project_memory_epoch = project_memory_epoch + 1,
   updated_at = excluded.updated_at
```

**谁调用 `bumpProjectMemoryEpoch`**（TS 侧全仓搜索，只有非生产 caller）〔测〕：
- `workspaces.ts:358-374` `bumpEpochRows`（workspace 成员资格变化时，逐个成员同一 UPDATE 语句）
- `v22-deferred-backfill.ts:173` `bumpProjectMemoryEpochInTransaction`（身份迁移回填）
- 测试/脚本

**dashboard（Rust，外部写入者）**〔码〕`dashboard/src-tauri/src/db.rs:5833-5850`，同一 SQL。其公开入口 `bump_project_memory_epoch_for_identity_pub`（`db.rs:4975-4980`）目前唯一 caller 是 `dashboard/src-tauri/src/workspaces.rs:313`。

**身份迁移**也是 bump 来源：`crates/mc-module/src/single_store_migrate.rs:3573`。

### 5.3 谁读它 / 交互

**读 epoch 做 fold 判定**〔码〕`inject-compartments.ts:1916-1918`：

```ts
} else if (args.state.cachedM0ProjectMemoryEpoch !== current.projectMemoryEpoch) {
    return { value: true, reason: "project_memory_epoch" };
}
```

**workspace 变体**：workspaced 时用 `workspace_fingerprint` 而非裸 epoch，但同时比较"当前 workspaced 或 缓存曾 workspaced"，防止 workspace→single 转换漏 bump〔码〕`inject-compartments.ts:1903-1915`。workspace fingerprint 把每个 canonical 身份的 epoch 一起哈希〔码〕`workspaces.ts:312-334`。

**明确不是 trigger 的**（`inject-compartments.ts:1919-1940` 逐条注释）：
- `project_user_profile_version` → 走 m[1] `<new-user-profile>` 增量
- `max_compartment_seq` → 走 m[1] `<new-compartments>`
- **`maxMemoryId`** → 走 m[1] 水位
- `projectDocsHash` → 自然 HARD fold 时重读

**"仅当可注入集合发生变化"的确切判定**：不是"有写入"，而是 `MAX(id)`（以 m[0] 的可见性/生命周期/冻结过期谓词过滤）**数值变化**，或 workspace fingerprint 变化。`mustMaterialize` 的注脚把这条讲成硬规则（`:1932-1935`）。

**物化事务内的 stale 检查**（Phase 3 前）〔码〕`inject-compartments.ts:2661-2677`：epoch/fingerprint 变化即 `ROLLBACK` + 抛 `MaterializeContentionError({reason:"snapshot changed before Phase 3"})`。**注意 `maxMemoryId` 被刻意排除在 stale 检查外**（注释 `:2656-2660`），因为 additive write 不使已渲染 m[0] 失效。

**外部写入（dashboard）与活跃会话的交互**：dashboard 改内容时**同时**写 mutation log 与 bump epoch（`db.rs:6073-6100` 的 update 命令：UPDATE → shareable=0 → DELETE embeddings → `queue_memory_mutation("update")`；epoch 由命令外层 bump）。运行中的会话下一轮 transform 看到 epoch 变化 → HARD fold，m[0] 与新 m[1] 都重建，delta 被吞掉。

---

## 6. `memory_mutation_log` 与 `<memory-updates>`

### 6.1 表结构

〔码〕`storage-db.ts:1476-1491`；真实库一致〔测〕：

```sql
CREATE TABLE memory_mutation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
  target_memory_id INTEGER NOT NULL,
  superseded_by_id INTEGER,
  category TEXT,
  new_content TEXT,
  queued_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_mutation_log_project    ON memory_mutation_log(project_path, id);
CREATE INDEX idx_memory_mutation_log_visibility ON memory_mutation_log(project_path, category, id, target_memory_id);
CREATE INDEX idx_memory_mutation_log_target     ON memory_mutation_log(project_path, target_memory_id, id);
```

⚠️ **`mutation_type` 没有 `merge`** —— 本地库 CHECK 只允许四个值。merge 由 **`superseded`（每个源）+ `update`（目标）** 组合表达。〔码〕`storage-db.ts:1479`；〔测〕真实库实测三类：`archive` 62、`superseded` 22、`update` 170（**无 `delete`**，虽然 schema 允许）。

### 6.2 何时 append（逐操作行为）

append 原语〔码〕`storage-memory-mutation-log.ts:66-101`：

```sql
INSERT INTO memory_mutation_log
  (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
```

**所有写入必须用 `normalizeStoredProjectPath(...)` 解析后的身份**——dashboard 的注释把这个坑讲得很清楚〔码〕`db.rs:5861-5865`：渲染侧按 resolved identity 过滤，写原始路径的行会**永远不可见**。

| 操作 | 写 memories | append mutation log | 备注 |
|---|---|---|---|
| `write`（新增） | INSERT | **不写** | 靠 maxMemoryId 水位浮现〔码〕`tools.ts:560-581` |
| `write`（哈希命中已存在） | `seen_count+1` | **不写** | 〔码〕`tools.ts:554-558` |
| `update` | content/category/hash + 清 5 类附带字段 | `("update", id, category=新类别, new_content=新内容)` | 〔码〕`tools.ts:682-688` |
| `archive`（无 reason） | `status='archived', updated_at` | `("archive", id)` | 〔码〕`tools.ts:979-983` |
| `archive`（有 reason） | `status='archived', metadata_json=mergeJson(archive_reason), updated_at` | 同上 | 〔码〕`storage-memory.ts:1221-1238` |
| `archive`（batch） | 全部**先校验再改**（all-or-nothing），单事务内循环 | 每 id 一行 | 〔码〕`tools.ts:936-986` |
| `merge` | 源：`status='archived', superseded_by_memory_id=target, updated_at`；目标：content/hash/counters/merged_from/status + `shareable=0, classified_at=NULL` | 每个源 `("superseded", srcId, superseded_by=targetId)`；目标变更才 `("update", targetId, category, new_content)` | 〔码〕`tools.ts:879-900`；Rust `mc-store/src/lib.rs:6938-7000` |
| `merge`（新建 canonical，Rust） | canonical 插入后再 `UPDATE seen_count/retrieval_count/merged_from`，并**删除**刚插入的那条 `update` delta | 删 delta 的 SQL 见下 | 〔码〕`mc-store/src/lib.rs:6829-6861` |
| `delete`（硬删） | `DELETE FROM memory_embeddings` → `DELETE FROM memories`，单 `.immediate()` 事务 | **本仓 TS 路径不 append**（`deleteMemory` 无 log） | 〔码〕`storage-memory.ts:1240-1251`；schema 允许 `delete` 供其他写者用 |

Rust 新建 canonical 后删掉多余 delta 的语句〔码〕`mc-store/src/lib.rs:6848-6856`：

```sql
DELETE FROM memory_mutation_log
 WHERE id = (SELECT MAX(id) FROM memory_mutation_log
              WHERE project_path = ?1 AND mutation_type = 'update'
                AND target_memory_id = ?2 AND queued_at = ?3)
```

**terminal vs non-terminal**（折叠时优先级，决定先后顺序不会"复活"）：〔码〕`storage-memory-mutation-log.ts:9-15`

```ts
const TERMINAL_MUTATION_TYPES = new Set<MemoryMutationType>(["archive", "delete", "superseded"]);
```

> `update` is non-terminal — the memory is still present with new content. The render fold gives terminal states precedence over a later `update` so an update queued after an archive/delete cannot resurrect a memory that is gone.

**可见性变更哨兵**：`category` 列可存魔法值 `"__mc_visibility__"`，表示"这条记忆的可见性变了但内容没变"（跨项目共享开关翻转）。〔码〕`storage-memory-mutation-log.ts:6,61`

### 6.3 渲染折叠（coalesce）算法

〔码〕`storage-memory-mutation-log.ts:144-229`，常量 `MAX_MEMORY_REPLACEMENT_DEPTH = 8`（`:7`，Rust 对等 `mc-store/src/lib.rs:79`）：

1. 游标 `afterId`（`id > cursor`），按 `project_path IN (identities)` 过滤
2. **先**取所有 `category='__mc_visibility__'` 的 `target_memory_id`，并入"待请求目标集"（与本次已渲染的 memory id 合并）
3. 按 `target_memory_id` 分批加载，**每个 target 只保留一条**（`coalesceMutations`）：
   - 若已选中的是 terminal 且新候选是 non-terminal → **保留 terminal**（内容用 terminal 的，但 OR 上 visibilityChanged）
   - 否则用**后出现**的那条
4. `superseded` 的 `superseded_by_id` 作为下一层 frontier 继续加载（最多 8 层，防环），并把链解析到**终端**（`visited` 集合防环）
5. 最终按 `id ASC` 排序

### 6.4 `<memory-updates>` 确切渲染格式

**TS 权威**〔码〕`inject-compartments.ts:2794-2876`；**Rust 权威**〔码〕`memory_render.rs:333-377`（注释 `:1-15` 声明是 `renderMemoryUpdatesBlock` 的忠实移植）。两者字节一致。

模板（注意**两个空格缩进**、em dash 是 `—`）：

```
<memory-updates>
These memories changed since the snapshot below — trust these:
  <updated id="{id}">{escaped content}</updated>
  <updated id="{id}" category="{escaped category}">{escaped content}</updated>
  <superseded id="{target}" by="{replacement}"/>
  <removed id="{target}"/>
</memory-updates>
```

规则：
- 首行**恒为** `These memories changed since the snapshot below — trust these:`；只有一个 header 则整块视为空（`lines.length === 1` → `block: ""`）〔码〕`inject-compartments.ts:2870`
- `category` 属性**仅当** `category` 非空且不等于 `__mc_visibility__` 时才加〔码〕`memory_render.rs:349-357`
- 逃生：attr 用 `&amp; &lt; &gt; &quot;`；content 用 `&amp; &lt; &gt;`〔码〕`memory_render.rs:36-47`
- `superseded` 分支：替换者**可解析**（在 m[0] baseline ∪ 本次 delta，且 eligible）→ `<superseded .../>`；否则降级 `<removed .../>`〔码〕`memory_render.rs:365-371`；TS 侧同一逻辑在 `inject-compartments.ts:2825-2839`
- `archive`/`delete`/其他 → `<removed id="..."/>`
- **条数上限**：`<memory-updates>` 的**行数本身无上限**；受上限约束的是被"强制渲染"的替换者 id：`MAX_FORCED_MEMORIES_PER_DELTA = 10`〔码〕`inject-compartments.ts:1142,2867-2869`，Rust `MAX_MERGE_REPLACEMENTS_PER_DELTA = 10` + `tracing::warn!` 后 truncate〔码〕`m1_compose.rs:32,438-446`

### 6.5 注入到 m[1] 的哪个节点

**块顺序**〔码〕`memory_render.rs:268-300`（`assemble_m1`）与 `inject-compartments.ts`（TS 对等）：

```
<session-history-since>
<memory-updates>…</memory-updates>
<new-compartments>…</new-compartments>
<new-memories>…</new-memories>
<new-user-profile>…</new-user-profile>
</session-history-since>
```

- 非空块之间**恰好一个 `\n`** 分隔；空块整个省略
- **全部为空时**渲染占位符 `M1_PLACEHOLDER`（`memory_render.rs:31-32`）—— m[1] 永不为空，因为 provider prompt-cache 需要稳定断点：
  ```
  <session-history-since>(no new content since last materialization)</session-history-since>
  ```

---

## 7. `maxMemoryId` 水位

### 7.1 水位存在哪

**`session_meta.cached_m0_max_memory_id INTEGER`**，与 `cached_m1_bytes` 一起持久化。〔测〕真实库 `session_meta` 列确认存在；〔码〕`storage-db.ts:1829`、迁移 `migrations.ts:977`。

同族列（同一物化快照）：`cached_m0_bytes`、`cached_m0_project_memory_epoch`、`cached_m0_workspace_fingerprint`、`cached_m0_max_compartment_seq`、`cached_m0_max_mutation_id`、**`cached_m0_max_memory_mutation_id`**（mutation log 游标）、`cached_m1_bytes`、`cached_m0_materialized_at` 等〔测〕。

### 7.2 水位怎么算

物化时用与 m[0] 完全相同的可见性/生命周期/冻结过期谓词取 MAX(id)〔码〕`inject-compartments.ts:1414-1428`：

```sql
SELECT MAX(memory.id) FROM memories AS memory
 WHERE memory.project_path IN (SELECT project_path FROM expanded)
   AND memory.status IN ('active','permanent')
   AND (memory.expires_at IS NULL OR memory.expires_at > ?)
   AND (memory.project_path IN (SELECT project_path FROM own)
        OR (memory.shareable = 1
            AND memory.scope IN ('project','ecosystem','universe')
            AND memory.category IN (SELECT category FROM shared)))
```

TS 对等函数 `getMaxMemoryIdForProjects`〔码〕`storage-memory.ts:917-944`：

```sql
SELECT COALESCE(MAX(id), 0) AS max_id FROM memories
 WHERE project_path IN (…)
   AND status IN ('active','permanent')
   AND (expires_at IS NULL OR expires_at > ?)  -- expiryCutoff
   -- + workspace sharing filter
```

### 7.3 新增记忆如何浮现

〔码〕`inject-compartments.ts:2944-2975`：

```ts
const forcedMemoryIds = new Set(memoryUpdates.forcedMemoryIds);
const newMemories = eligibleMemories.filter(
    (memory) => memory.id > markers.maxMemoryId && !forcedMemoryIds.has(memory.id),
);
// 预算 = min(1, floor(memoryInjectionBudgetTokens * 0.25))
const trimmedNewMemories = trimMemoriesToBudgetV2(sessionId, newMemories, …, …).renderOrder;
const deltaMemories = [...trimmedNewMemories, ...eligibleMemories.filter(m => forcedMemoryIds.has(m.id))];
const newMemoriesBlock = renderMemoryBlockV2(deltaMemories, "new-memories", …);
```

- **新增块的预算 = m[0] 记忆预算的 25%**（TS `inject-compartments.ts:2955-2965`；Rust `m1_compose.rs:449-468`）
- 被 mutation 强制带入的替换者**不受** 25% 限制，但受 10 条上限
- Rust 对等查询 `readNewMemoriesForM1Union`（TS 版）〔码〕`storage-memory.ts:946-975`：`id > afterId AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?)` + sharing filter，`ORDER BY <category order>, id ASC`

### 7.4 何时推进

**只在 m[0] 物化成功、持久化 snapshot markers 时**——把那一轮的 `markers.maxMemoryId` 写回 `session_meta`：

- TS：`persistCachedM0(..., { maxMemoryId: snapshotMarkers.maxMemoryId, ... })`〔码〕`inject-compartments.ts:2696-2704`；内存态 `state.cachedM0MaxMemoryId = markers.maxMemoryId`〔码〕`:2374, :3199`
- 持久化 SQL 在 `storage-meta-shared.ts:530-560`
- Rust：`meta.max_memory_id = composition.memory_revision.max_memory_id`〔码〕`transform.rs:3284-3285`（另见 `:5698-5699, :5921-5922`）

### 7.5 下次 HARD fold 如何合并

1. HARD fold 重新查 `MAX(id)`，把水位**推进**到当前值
2. m[0] 重新渲染完整 `<project-memory>`，`id <= 新水位` 的所有记忆进入基线
3. m[1] 重算：`id > 新水位` 的集合为空 → `<new-memories>` 消失
4. **mutation 游标（`cached_m0_max_memory_mutation_id`）也在同一 HARD 里推进**，所以已折叠的 `<memory-updates>` 消失〔码〕`inject-compartments.ts:2656-2660` 与测试 `inject-compartments.test.ts:4006-4049`

**水位 ≠ trigger**〔码〕`inject-compartments.ts:1932-1935`：additive write 不足以触发 HARD，否则每次 historian 后台发布都会击穿 prompt-cache 前缀。

### 7.6 一个易漏的耦合

内容更新（`update`）**不改 `id`**，所以它永远不会被"水位 > id"过滤掉；它必须靠 **mutation log + 已渲染 id 集合** 才能出现在 `<memory-updates>`。反之，`merge` 新建的 canonical 行**有更大的 id**，会同时出现在 `<new-memories>` 与（作为 supersede 目标）被 forced 带入——渲染侧用 `forcedMemoryIds` 去重，避免同一 id 出现两次〔码〕`inject-compartments.ts:2944-2946`。

---

## 8. 权威守卫（`memory-visibility.ts` + authority triggers）

### 8.1 两个谓词（读 vs 写）

〔码〕`memory/memory-visibility.ts:1-17` 的模块注释是权威定义：

> - **VISIBLE (read)**: the project's own memories in every category, plus a workspace member's memories only while they are active, unexpired, marked shareable, scoped beyond the writing project, and in a category the workspace explicitly shares.
> - **OWNED (mutate)**: only rows that resolve to this project's identity. A shared memory from another project is readable here and never writable here — **sharing grants reading, not editing**.

工厂 `createMemoryVisibilityPolicy(db, projectIdentity)`〔码〕`memory-visibility.ts:57-109`：

```ts
const owned = (memory) => workspaced
    ? identityFor(memory.projectPath) === projectIdentity
    : storedPathBelongsToIdentity(memory.projectPath, projectIdentity);

const visible = (memory) => {
    if (!workspaced) return storedPathBelongsToIdentity(memory.projectPath, projectIdentity);
    if (!storedPathBelongsToWorkspace(...)) return false;
    if (identityFor(memory.projectPath) === projectIdentity) return true;
    return (memory.status === "active" || memory.status === "permanent")
        && (memory.expiresAt === null || memory.expiresAt > Date.now())
        && memory.shareable === 1
        && ["project", "ecosystem", "universe"].includes(memory.scope)
        && (shareCategories?.includes(memory.category) ?? false);
};
```

**非 workspaced 时 `visible` 与 `owned` 重合**；workspaced 时 `visible ⊋ owned`。

### 8.2 主 agent 允许/禁止矩阵

〔码〕`tools.ts:512-522`（注释）+ 各 action 分支：

| action | 判定 | 主 agent（非 dreamer） | dreamer |
|---|---|---|---|
| `write` | 无（只能新建到自己项目） | ✔ | ✔（sourceType=dreamer） |
| `get` | `visible` | ✔（自己的全部 + 共享可见的外项目） | ✔ |
| `list` | 只查自己项目 | ✔ | ✔ |
| `update` | `owned` + `isPrimaryMutableMemory` | 只可改**自己身份**且 `status∈{active,permanent}` 且 `supersededBy===null` | 放宽到 `visible` |
| `archive` | `owned` + `isPrimaryMutableMemory` | 同上 | 放宽到 `visible` |
| `merge` | `owned`（全部源）+ `isPrimaryMutableMemory`（全部源） | 只可合并**自己身份**的行 | 非 workspace：跨项目自由；**workspace 内**退化为 `visible` |

`isPrimaryMutableMemory`〔码〕`tools.ts:334-339`：

```ts
function isPrimaryMutableMemory(memory: Memory): boolean {
    return (memory.status === "active" || memory.status === "permanent")
        && memory.supersededByMemoryId === null;
}
```

### 8.3 确切错误文案（逐条可粘贴）

〔码〕`tools.ts:162-186`、`:341-359`、`:642-646`、`:750-783`：

```text
# get：不泄露存在性（"foreign 未共享" 与 "不存在" 共用一句）
id {id}: not found or not visible from this project

# update / archive 权限或找不到
Error: Memory with ID {id} was not found.

# update / merge / archive：目标已归档或被取代
Error: Memory with ID {id} is archived or superseded; restore it before updating.
Error: Memory with ID {id} is archived or superseded; restore it before merging.
Error: Memory with ID {id} is archived or superseded; restore it before archiving.

# update/merge 去重冲突（事务内查重命中）
Error: Memory content already exists as ID {id}; merge or archive duplicates instead.

# write 缺参
Error: 'content' is required when action is 'write'.
Error: 'category' is required when action is 'write'.
Error: Unknown memory category '{rawCategory}'.

# update/merge/get/archive 参数
Error: 'ids' must contain exactly one integer memory ID when action is 'update'.
Error: 'ids' must include at least two integer memory IDs when action is 'merge'.
Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.
Error: 'ids' must contain at least one integer memory ID when action is 'archive'.
Error: 'ids' must contain at least one integer memory ID when action is 'get'.
Error: 'ids' must contain at most 20 memory IDs when action is 'get' (got {n}).
Error: 'content' is required when action is 'update'.
Error: 'content' is required when action is 'merge'.

# 跨类别 merge（结构性拒绝）
Error: Cannot merge memories from different categories ({A}, {B}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.

# dreamer 在 workspace 内碰到未共享类别
Error: Memory with ID {id} is in a category not shared with this workspace member and cannot be merged.

# 成功回执
Saved memory [ID: {id}] in {category}.
Memory already exists [ID: {id}] in {category} (seen count incremented).
Updated memory [ID: {id}] in {category}.
Merged memories [{ids}] into canonical memory [ID: {canonical}] in {category}; superseded [{supersededIds}].
Archived memory [ID: {id}].                      # 单数
Archived memories [ID: {a}, {b}].                 # 复数
Archived memory [ID: {id}] ({reason}).            # 带 reason
```

其它：`GET_MAX_IDS = 20`〔码〕`tools.ts:170`；memory 功能关闭时 `Cross-session memory is disabled for this project.`〔码〕`tools.ts:247-249`。

### 8.4 权威触发器（数据库层面的第二道闸）

**这是真实库上已存在、必须让路的机制。** 〔码〕`migrations.ts:216-244`（`installLatestAuthorityTriggers`），真实库实测 DDL 如下〔测〕：

```sql
CREATE TRIGGER memories_authority_guard_insert
BEFORE INSERT ON memories
WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
   OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
  AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;

CREATE TRIGGER memories_authority_guard_update
BEFORE UPDATE ON memories
WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
   OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
   OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
   OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
  AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;

CREATE TRIGGER memories_authority_guard_delete
BEFORE DELETE ON memories
WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
   OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
  AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
```

相关表〔测〕：

```sql
CREATE TABLE authority_managed (
  project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL);
CREATE TABLE authority_repair_pending (
  project_path TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
CREATE TABLE context_privilege_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)));
```

**为什么用状态表而不是 UDF**〔码〕`migrations.ts:176-187`：触发器是**持久数据库工件**，每个打开 context.db 的连接都会重新求值；UDF 只存在于注册过它的连接上，其他连接（node:sqlite、dashboard 的 rusqlite、旧 Bun）会 `no such function`。特权写入者在**自己的 BEGIN IMMEDIATE 里**翻转 `enabled`，任何第二连接都观察不到〔码〕`sqlite.ts:924-988`。

**TS 侧的前置让路检查**〔码〕`storage-memory.ts:606-625`：

```ts
function assertTsMemoryWriteAllowed(db, projectPath) {
    try {
        const managed = db.prepare(
            "SELECT 1 FROM authority_managed WHERE project_path = ? UNION SELECT 1 FROM authority_repair_pending WHERE project_path = ? LIMIT 1",
        ).get(projectPath, projectPath);
        if (managed) throw new ModuleMemoryAuthorityError(projectPath);
    } catch (error) {
        // 老库没有 authority 表 → 视为普通 TS 归属
        if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
    }
}
```

错误文案〔码〕`storage-memory.ts:595-604`：

```text
memory writes for module-managed project {projectPath} must use the Rust ctx_memory module facade
```

**〔测〕真实库现状**：`authority_managed` **0 行**、`authority_repair_pending` **0 行**、`context_privilege_state` = `{id:1, enabled:0}`。⇒ **今天直写不会被拒**；但守卫已安装，若用户将来把某项目交给 Rust module 托管，我们的写入会立刻被 ABORT。

**给我们的实现**：写入前先跑 `assertTsMemoryWriteAllowed` 等价检查（读两张表，容忍 `no such table`）；命中就拒绝并给出可诊断的错误，**不要**试图通过写 `context_privilege_state.enabled=1` 绕过——那是 MC 自己特权写入者的协议，冒充它会破坏"第二连接永不可见 enabled=1"的不变量。

---

## 9. 计数与验证状态

### 9.1 `retrieval_count` / `last_retrieved_at`

**只由显式 agent 检索更新**，自动浮现不计数。原函数〔码〕`storage-memory.ts:1015-1019,429-438`：

```ts
export function updateMemoryRetrievalCount(db: Database, id: number): void {
    assertTsMemoryIdWriteAllowed(db, id);
    const now = Date.now();
    getUpdateMemoryRetrievalCountStatement(db).run(now, now, id);
}
```
```sql
UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?, updated_at = ? WHERE id = ?
```

调用点唯一：`ctx_search` 结果里 source==='memory' 的命中〔码〕`search.ts:2258-2282`，注释原文：

> Only count retrievals for explicit agent-driven searches. Plugin-internal automatic surfacing (auto-search hints) should not inflate retrieval_count because the agent may never actually consume the hint. retrieval_count is telemetry, not correctness: under MODULE authority the TS write path is fenced, so skip the bump rather than failing the search.

⇒ 实现要点：**整个 batch 在一个 `.immediate()` 事务里循环 bump**；遇到 `ModuleMemoryAuthorityError` **吞掉继续**（telemetry 不得让搜索失败）；其它错误照抛。

〔测〕真实库：841 行中 192 行 `retrieval_count > 0`，总和 594（大量记忆从未被显式检索）。

**DSH 适配器接线（task-9 ②，2026-10-07）**：计数点唯一地落在 `ctx_memory` 的 recall 通道
（`src/dsh/tool-bridge.ts` 的 `list`、以及不带 `id` 的 `get` 分支）——即"显式 agent 检索"。
m[0]/m[1] 自动注入不经过该工具，因此**永不计数**：宿主在 recall 回调里把 `ids`（实际渲染进
`<memory-pool>`/`<new-memories>` 的 `[...rows, ...newRows].map(r => r.id)`）交回工具，
工具只 bump 其中属于本会话 identity 的行。同一 id 一次调用只 bump 一次；非本项目 id、
未知 id 与非法 id（≤0 或非整数）落入 `skipped` 且按调用方顺序返回。
`get <id>`（单行读）与全部写动作**不计数**。计数不写 `memory_mutation_log`、不 bump epoch、
不碰 `seen_count`。与 MC 的**有意分歧**：本适配器的 UPDATE 不写 `updated_at`（MC 的语句写），
因为 `memory-bridge.ts` 用 `id:updated_at` 组合 m[0] 摘要并按 `updated_at DESC` 排序，
bump `updated_at` 会击穿缓存前缀。fence（schema > v95）/MODULE authority/DB 失败一律返回
`{ok:false, reason}` 而不抛错，调用方永远先拿到检索结果（telemetry 不是正确性）。

### 9.2 `seen_count` / `last_seen_at`

〔码〕`storage-memory.ts:1009-1013,418-427`：

```sql
UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ?
```

**何时 +1**：内容哈希重复写入时（`write` 命中已存在 / `insertMemoryIdempotent` 撞 UNIQUE）〔码〕`tools.ts:554-558`、`storage-memory.ts:660-677`。
Rust facade 用 `COALESCE(seen_count, 0) + 1`，容忍历史 NULL〔码〕`mc-store/src/lib.rs:6583-6587`。

⚠️ **注意：这不是"每次被注入 +1"**——`seen_count` 是**写入去重计数**，不是注入计数。〔测〕真实库 829 行 =1、11 行 =2、1 行 =3，与之吻合。

〔测〕**`last_seen_at` 与 `retrieval_count>0` 的 192 行完全一致**（`SUM(CASE WHEN last_retrieved_at IS NOT NULL…) = 192`），说明 `seen_count` 路径与 `retrieval_count` 路径互不覆盖。

### 9.3 `verified_at` / `verification_status`

〔码〕`storage-memory.ts:1045-1059,460-469`：

```ts
export function updateMemoryVerification(db, id, verificationStatus: VerificationStatus): void {
    assertTsMemoryIdWriteAllowed(db, id);
    const now = Date.now();
    getUpdateMemoryVerificationStatement(db).run(verificationStatus, verificationStatus, now, now, id);
}
```
```sql
UPDATE memories SET
  verification_status = ?,
  verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END,
  updated_at = ?
WHERE id = ?
```

要点：
- `verified_at` **只在**目标状态恰为 `'verified'` 时刷新为 now；其余状态（`unverified`/`stale`/`flagged`）**保留历史 verified_at**
- 取值集合 `VerificationStatus = "unverified" | "verified" | "stale" | "flagged"`〔码〕`types.ts:24`
- 真正的"验证"由 dreamer 的 verify 任务 + `memory_verifications` 表（文件级映射）驱动，不是注入时自动发生
- `memory_verifications` 表〔码〕`storage-db.ts:1463-1474`：`verified_at=0` 表示"已映射文件但未内容验证"〔码〕注释 `:1466-1467`

〔测〕真实库 **841 行全部 `unverified`，0 行 `verified_at` 非空**。⇒ 我们的写路径**不应该**去写 verification（那是 dreamer 的活）。

### 9.4 `classified_at`

classify（dreamer）打点；**即使没有任何列值变化也 stamp**，以让 run-gate 认为已分类、下轮不再重扫〔码〕`storage-memory.ts:1183-1190`。内容更新时清 NULL（见 §4.5）。

---

## 10. 并发写入安全

### 10.1 连接级设置（真实库实测）

〔测〕`PRAGMA journal_mode = "wal"`（**库级持久**）、`PRAGMA foreign_keys = 1`（连接级；由写入者设置）。

MC 的初始化顺序有讲究〔码〕`storage-db.ts:1119-1132`：

```ts
db.exec(`PRAGMA busy_timeout=${resolveBootBusyTimeoutMs(busyTimeoutMs)}`);  // 先
db.exec("PRAGMA foreign_keys=ON");                                          // 必须在任何读/写前
configureContextDatabasePragmas(db);
applySqliteTuningPragmas(db);
```

**`foreign_keys` 必须开着**，否则 `memory_embeddings.memory_id REFERENCES memories(id) ON DELETE CASCADE` 形同虚设，硬删记忆会留下孤儿 embedding。〔码〕`storage-db.ts:1376-1379,1127-1130`

dashboard 侧同序〔码〕`db.rs:749-754`：注释 "busy_timeout MUST come before journal_mode=WAL: setting WAL can itself need the lock"，`busy_timeout=5000` 然后 `journal_mode=WAL`。**busy_timeout 是连接级**（`db.rs:695-696`）。mc-store 侧 `busy_timeout` 为 5000ms（`mc-store/src/lib.rs:18876`）。

### 10.2 事务边界

| 操作 | 事务形状 | 出处 |
|---|---|---|
| `write`（新增/去重） | **autocommit 单语句**（工具层无显式事务） | `tools.ts:548-581` |
| `update` | `BEGIN IMMEDIATE`（查重+写+log 同一事务） | `tools.ts:664-689` |
| `archive`（batch） | `BEGIN IMMEDIATE`（先全量校验，再循环写+log） | `tools.ts:963-986` |
| `merge` | `BEGIN IMMEDIATE`（查重+插 canonical+更新+supersede+log） | `tools.ts:828-903` |
| `deleteMemory` | `.immediate()`（删 embedding + 删行） | `storage-memory.ts:1243-1246` |
| `updateMemoryContent` | `.immediate()`（内容 + 5 类清空 + 删 embedding） | `storage-memory.ts:1072-1119` |
| retrieval_count 批 | `.immediate()` | `search.ts:2270-2280` |
| Rust facade | 外层 `with_facade_command` 拥有的单一事务，命令内所有写一起提交 | `mc-store/src/lib.rs:6560-6562` |

**`BEGIN IMMEDIATE` 而非 DEFERRED** 是关键：写→写的热点路径不允许"先读后升级写锁"（SQLite 在这种升级下不遵守 busy_timeout，会直接 SQLITE_BUSY）。MC 的 shim 默认 writable 连接就用 IMMEDIATE〔码〕`sqlite.ts:311`；其注释 `db.rs:688` 之外的仓内说明见 `compaction-marker.ts:688`。

**为什么 `write` 能裸跑**：UNIQUE 是兜底，`insertMemoryIdempotent` 捕获 `SQLITE_CONSTRAINT_UNIQUE` 后回退到 bump seen_count〔码〕`storage-memory.ts:654-678`；冲突检测同时认 code 与 `sqlite3_errmsg` 文本，因为 node:sqlite 可能重映射 code〔码〕`tools.ts:345-356`：

```ts
if (code === "SQLITE_CONSTRAINT_UNIQUE") return true;
// bun:sqlite sets SQLITE_CONSTRAINT_UNIQUE; node:sqlite may omit or remap
// the code. sqlite3_errmsg text is stable across adapters.
return /UNIQUE constraint failed/i.test(error.message);
```

**写者获取重试**（长锁场景）：`shared/sqlite.ts` 实现了有界异步重试——`beginSqliteWriterAsync` 首次失败等 500ms、之后 1000ms，总预算 `FOREGROUND_ACQUISITION_BUDGET_MS = 16_500`，超预算抛 `SqliteAcquisitionBusyError`〔码〕`sqlite.ts:678-680,834-871`。短促重试用 `SHORT_BUSY_TIMEOUT_MS = 25`，前台 in-pass 用 `FOREGROUND_IN_PASS_BUSY_TIMEOUT_MS = 250`〔码〕`sqlite.ts:678-679`。

### 10.3 没有 advisory lock（记忆写入层）

记忆的 `write/update/archive/merge` **不使用** lease/advisory lock。仓里的 lease 机制（`compartment-lease.ts`、`dreamer/lease.ts`、`git-commits/sweep-coordinator.ts`、`tool-owner-backfill.ts`）服务于别的子系统（物化、dreamer 调度、git sweep、tool owner），不是记忆写路径。

**唯一的"顺序锁"是 SQLite 的写锁 + AUTOINCREMENT**。

### 10.4 两个宿主同时写：哪些安全、哪些会打架

| 场景 | 安全性 | 说明 |
|---|---|---|
| 我们 INSERT 新记忆；OpenCode 同时 INSERT | ✅ 安全 | 各自 `BEGIN IMMEDIATE`（或靠 UNIQUE 兜底）；`memory_mutation_log.id` 全局单调，两侧 delta 都按 id 排序，坍缩逻辑用 `id > cursor`，不会互相吃掉 |
| 我们 UPDATE 内容（同事务写 `update` delta）；OpenCode 同时 UPDATE 同一行 | ⚠️ **last-writer-wins**，两侧 delta 都会留在 log | 内容被后者覆盖，但**两条 delta 都在**。渲染 fold 取"后出现的那条"（`id` 更大者），因此 `<memory-updates>` 显示的是最终内容——自洽。风险是中间的 update 被静默丢弃（无冲突报错）。MC 自己也没有乐观锁来防这个 |
| 双方同时 bump `project_memory_epoch` | ✅ 安全 | 都是 `project_memory_epoch = project_memory_epoch + 1`，原子自增，不会丢计数；**但会让活跃会话连续两次 HARD fold**（性能，不是正确性） |
| 双方同时 INSERT **相同内容**（同项目同类别） | ✅ 安全 | UNIQUE 兜底，一方插入、另一方 bump seen_count |
| 我们 UPDATE；另一宿主同时**硬删**该行 | ⚠️ UPDATE 影响 0 行（静默） | 应先 SELECT 确认存在（MC 的 `assertTsMemoryIdWriteAllowed` 就是这个作用），并检查 `changes` |
| dashboard 外部改 + 我们的会话正在写 | ✅ 安全（设计如此） | dashboard 走 epoch bump 强制 HARD；我们走 mutation log → m[1]。两条通道在下次 HARD 时收敛 |
| 我们**去改 FTS 表 / 去 bump epoch / 去翻转 `context_privilege_state`** | ❌ **禁止** | 分别会与触发器双写、过度 cache-bust、破坏特权不变量 |

**给我们的最小安全配方**：

```ts
// 每次写事务
db.exec("PRAGMA busy_timeout=5000");     // 先（连接级）
db.exec("PRAGMA foreign_keys=ON");       // 必须在首次读写前
db.exec("PRAGMA journal_mode=WAL");      // 库级持久，重复设置是无害 no-op
// ... 业务写放 BEGIN IMMEDIATE
```

**绝不要**：用 `BEGIN DEFERRED` 做"查重→写"；用 `busy_timeout=0`；在事务外缓存查重结果再写。

---

## 11. 写入 SQL 原文（可直接照抄到 `node:sqlite`）

以下全部为可粘贴语句，占位符是 `?`（位置参数）。列名/顺序与真实库逐字一致〔测〕。

### 11.1 `write`（新增）— TS 版本

**步骤 1 · 归一化 + 查重**〔码〕`storage-memory.ts:347-356`：

```sql
SELECT <getMemorySelectColumns> FROM memories
 WHERE project_path = ? AND category = ? AND normalized_hash = ?
```

其中 `getMemorySelectColumns`〔码〕`storage-memory.ts:200-224` 展开为（新库，全部列存在）：

```sql
SELECT memories.id AS id, memories.project_path AS projectPath, memories.category AS category,
       memories.content AS content, memories.normalized_hash AS normalizedHash,
       COALESCE(memories.importance, 50) AS importance,
       COALESCE(memories.scope, 'project') AS scope,
       COALESCE(memories.shareable, 0) AS shareable,
       memories.source_session_id AS sourceSessionId, memories.source_type AS sourceType,
       memories.seen_count AS seenCount, memories.retrieval_count AS retrievalCount,
       memories.first_seen_at AS firstSeenAt, memories.created_at AS createdAt,
       memories.updated_at AS updatedAt, memories.last_seen_at AS lastSeenAt,
       memories.last_retrieved_at AS lastRetrievedAt, memories.status AS status,
       memories.expires_at AS expiresAt, memories.verification_status AS verificationStatus,
       memories.verified_at AS verifiedAt, memories.superseded_by_memory_id AS supersededByMemoryId,
       memories.merged_from AS mergedFrom, memories.metadata_json AS metadataJson
  FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?
```

**步骤 2a · 命中 → bump seen_count**〔码〕`storage-memory.ts:421-423`：

```sql
UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ?
```

**步骤 2b · 未命中 → INSERT**〔码〕`storage-memory.ts:337`（21 值形态；`now` = `Date.now()`）：

```sql
INSERT INTO memories
  (project_path, category, content, normalized_hash, importance,
   source_session_id, source_type, seen_count, retrieval_count,
   first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at,
   status, expires_at, verification_status, verified_at,
   superseded_by_memory_id, merged_from, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, NULL,
        'active', ?, 'unverified', NULL, NULL, NULL, ?)
```

绑定顺序（含字面量展开后的实际参数序列）〔码〕`storage-memory.ts:551-585`：
`projectPath, category, content, normalizedHash, importance ?? 50, sourceSessionId ?? null, sourceType ?? "historian", now, now, now, now, expiresAt ?? null, metadataJson ?? null`

⚠️ 注意 `seen_count`/`retrieval_count`/`status`/`verification_status`/`last_retrieved_at`/`verified_at`/`superseded_by_memory_id`/`merged_from` 是**字面量或 NULL**，不是参数。

**步骤 3 · 回读**〔码〕`storage-memory.ts:356,587-593`：

```sql
SELECT <getMemorySelectColumns> FROM memories WHERE id = ?
```

### 11.2 `write` / merge 的 canonical 插入 — Rust facade 版本

〔码〕`mc-store/src/lib.rs:6595-6601`（列清单更短，其余靠 DEFAULT）：

```sql
INSERT INTO memories
  (project_path, category, content, normalized_hash, importance,
   source_session_id, source_type, seen_count, retrieval_count,
   first_seen_at, created_at, updated_at, last_seen_at, status,
   expires_at, verification_status, metadata_json)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0, ?8, ?8, ?8, ?8,
        'active', ?9, 'unverified', ?10)
```

随后**必然**抬升 embedding 水位〔码〕`mc-store/src/lib.rs:6617,16479-16487`：

```sql
INSERT INTO memory_embedding_watermarks
  (project_path, written_memory_id, embedded_memory_id, updated_at)
VALUES (?1, ?2, 0, ?3)
ON CONFLICT(project_path) DO UPDATE SET
  written_memory_id = MAX(memory_embedding_watermarks.written_memory_id, excluded.written_memory_id),
  updated_at = excluded.updated_at
```

⚠️ **TS 的 `insertMemory` 不写这个水位**（由 embedding backfill 自己扫 `MAX(id)`）。若我们想与 Rust 宿主一致，可以写；若不想引入额外耦合，可省略——但要知道两边行为不同。〔测〕真实库 `memory_embedding_watermarks` 当前为**空表**。

### 11.3 `update`

**工具层版本（含 category，事务内）**〔码〕`tools.ts:368-370`：

```sql
UPDATE memories SET content = ?, category = ?, normalized_hash = ?, updated_at = ? WHERE id = ?
```

**Rust facade 版本（含全部连带清空）**〔码〕`mc-store/src/lib.rs:6659-6670`：

```sql
UPDATE memories
   SET content = ?1, category = ?2, normalized_hash = ?3, updated_at = ?4,
       shareable = 0, classified_at = NULL,
       mural_cue = NULL, mural_cue_hash = NULL, mural_cue_at = NULL,
       mural_cue_rejection_count = 0
 WHERE id = ?5
```

**storage 层版本（不含 category）**〔码〕`storage-memory.ts:471-479,1072-1119`：见 §4.5 的六条语句。

**查重（事务内，排除自身）**〔码〕`mc-store/src/lib.rs:6646-6648`、`tools.ts:665-670`：

```sql
SELECT id FROM memories
 WHERE project_path = ?1 AND category = ?2 AND normalized_hash = ?3
 LIMIT 1
```

**delta**〔码〕`mc-store/src/lib.rs:6674-6686` / `tools.ts:682-688`：

```sql
INSERT INTO memory_mutation_log
  (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
VALUES (?, 'update', ?, NULL, ?, ?, ?)
```

### 11.4 `merge`

**源行（每个 source）**〔码〕`mc-store/src/lib.rs:6940-6945`、`storage-memory.ts:482-491`：

```sql
UPDATE memories
   SET status = 'archived', superseded_by_memory_id = ?, updated_at = ?
 WHERE id = ?
```

**源的 delta**〔码〕`mc-store/src/lib.rs:6949-6960` / `tools.ts:884-889`：

```sql
INSERT INTO memory_mutation_log
  (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
VALUES (?, 'superseded', ?, ?, NULL, NULL, ?)
```

**目标行（canonical）**〔码〕`mc-store/src/lib.rs:6965-6975`：

```sql
UPDATE memories
   SET content = ?1, normalized_hash = ?2, seen_count = ?3, retrieval_count = ?4,
       merged_from = ?5, status = ?6, updated_at = ?7, shareable = 0, classified_at = NULL
 WHERE id = ?8
```

字段计算规则：
- `merged_from` = 受影响 id（target + 所有 source）∪ 各 source 已有 `merged_from` 数组的**升序去重 JSON 数组**〔码〕`mc-store/src/lib.rs:17310-17320`、`tools.ts:793-814`
- `seen_count` = Σ `max(seen_count, 0)`；`retrieval_count` = Σ `max(retrieval_count, 0)`〔码〕`mc-store/src/lib.rs:6928-6932`
- `status` = 任一受影响行是 `permanent` → `'permanent'`，否则 `'active'`〔码〕`mc-store/src/lib.rs:6933-6937`、`tools.ts:823-825`

**target delta**〔码〕`mc-store/src/lib.rs:6988-6999`：

```sql
INSERT INTO memory_mutation_log
  (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
VALUES (?, 'update', ?, NULL, ?, ?, ?)
```

**TS storage 层的合并统计（无 category/清空列）**〔码〕`storage-memory.ts:493-499`：

```sql
UPDATE memories SET seen_count = ?, retrieval_count = ?, merged_from = ?, status = ?, updated_at = ? WHERE id = ?
```

### 11.5 `archive`

**无 reason**〔码〕`storage-memory.ts:440-446`：

```sql
UPDATE memories SET status = ?, updated_at = ? WHERE id = ?     -- status = 'archived'
```

**有 reason**〔码〕`storage-memory.ts:449-457`：

```sql
UPDATE memories SET status = 'archived', metadata_json = ?, updated_at = ? WHERE id = ?
```

`metadata_json` 的构造〔码〕`storage-memory.ts:1026-1043`（解析失败 → 空对象）：

```ts
return JSON.stringify({ ...base, ...{ archive_reason: trimmedReason } });
```

**delta**〔码〕`tools.ts:979-983`：

```sql
INSERT INTO memory_mutation_log
  (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
VALUES (?, 'archive', ?, NULL, NULL, NULL, ?)
```

〔测〕真实库 `metadata_json` 实例：`{"archive_reason":"docs/architecture/field-normalization.md 不存在于仓库…"}`。

### 11.6 `get` / `list` 读取

**按 id 批量**〔码〕`storage-memory.ts:367-383`：

```sql
SELECT <getMemorySelectColumns> FROM memories WHERE id IN (?, ?, …)
```

**按项目 + 状态 + 未过期，含渲染排序**〔码〕`storage-memory.ts:385-403`：

```sql
SELECT <getMemorySelectColumns> FROM memories
 WHERE project_path = ? AND status IN (?, ?) AND (expires_at IS NULL OR expires_at > ?)
 ORDER BY category ASC, updated_at DESC, id ASC
```

**m[1] 新增块**〔码〕`storage-memory.ts:962-972`：

```sql
SELECT <getMemorySelectColumns> FROM memories
 WHERE project_path IN (…) AND id > ?
   AND status IN ('active','permanent')
   AND (expires_at IS NULL OR expires_at > ?)
   -- + buildWorkspaceMemorySqlFilter 子句
 ORDER BY <MEMORY_CATEGORY_ORDER_SQL>, id ASC
```

**`mutation log` 渲染拉取**〔码〕`storage-memory-mutation-log.ts:178-188`：

```sql
SELECT id, project_path, mutation_type, target_memory_id, superseded_by_id,
       category, new_content, queued_at
  FROM memory_mutation_log
 WHERE project_path IN (…) AND id > ? AND target_memory_id IN (…)
 ORDER BY id ASC
```

**可见性哨兵拉取**〔码〕`storage-memory-mutation-log.ts:153-163`：

```sql
SELECT DISTINCT target_memory_id FROM memory_mutation_log
 WHERE project_path IN (…) AND id > ? AND category = '__mc_visibility__'
```

**mutation 游标**〔码〕`storage-memory-mutation-log.ts:249-254`：

```sql
SELECT MAX(id) AS max_id FROM memory_mutation_log WHERE project_path = ?
```

### 11.7 `delete`

〔码〕`storage-memory.ts:504-519,1240-1251`，单 `.immediate()` 事务：

```sql
DELETE FROM memory_embeddings WHERE memory_id = ?;
DELETE FROM memories WHERE id = ?;
```

⚠️ 硬删**不写 mutation log**，所以已注入过该记忆的活跃会话不会收到 `<removed>`——只有 epoch bump / 自然 HARD 才会让它消失。这是 MC 现存的语义（`delete` 类型只在 schema 里，TS 路径不产生它）。**建议我们的写路径完全不暴露硬删。**

### 11.8 epoch bump 与 project_state

```sql
-- 读取
SELECT project_path, project_memory_epoch, project_user_profile_version, updated_at
  FROM project_state WHERE project_path = ?;

-- 确保存在（幂等）
INSERT OR IGNORE INTO project_state
  (project_path, project_memory_epoch, project_user_profile_version, updated_at)
VALUES (?, 0, 0, ?);

-- bump（外部写入者语义）
INSERT INTO project_state
  (project_path, project_memory_epoch, project_user_profile_version, updated_at)
VALUES (?, 1, 0, ?)
ON CONFLICT(project_path) DO UPDATE SET
  project_memory_epoch = project_memory_epoch + 1,
  updated_at = excluded.updated_at;

-- bump 用户画像版本（__global__ 行）
INSERT INTO project_state
  (project_path, project_memory_epoch, project_user_profile_version, updated_at)
VALUES (?, 0, 1, ?)
ON CONFLICT(project_path) DO UPDATE SET
  project_user_profile_version = project_user_profile_version + 1,
  updated_at = excluded.updated_at;
```

〔码〕`storage-project-state.ts:37-127`；`GLOBAL_USER_PROFILE_PROJECT_PATH = "__global__"`（`:3`）。

---

## 12. 可导入性实测（Node 24 原生类型剥离）

### 12.1 环境

〔测〕
- `node --version` → **v24.15.0**
- `bun --version` → 1.4.0（`<path>`）
- `node:sqlite` 导出：`DatabaseSync, StatementSync, Session, constants, backup`
- 类型剥离在 Node 24 **默认开启**；但 strip-only **不支持** enum / namespace / **参数属性**，需要 `--experimental-transform-types`

### 12.2 逐个候选实测结果

**实验方式**：临时 harness 放在 `$env:TEMP`，用 `await import("file:///D:/…")`。

**第一轮 — 裸 Node 24（无任何 flag/hook）**：

| # | 候选（`packages/plugin/src/…`） | 结果 | 首个失败原因 |
|---|---|---|---|
| 1 | `features/magic-context/memory/normalize-hash.ts` | ✅ OK | — |
| 2 | `features/magic-context/memory/constants.ts` | ✅ OK | — |
| 3 | `features/magic-context/memory/types.ts` | ✅ OK（纯类型，剥离后为空模块） | — |
| 4 | `features/magic-context/memory/memory-visibility.ts` | ❌ | `ERR_MODULE_NOT_FOUND: Cannot find module '…\features\magic-context\workspaces'`（**无扩展名相对导入**） |
| 5 | `features/magic-context/memory/visibility.ts` | ✅ OK | — |
| 6 | `features/magic-context/memory/storage-memory.ts` | ❌ | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode`（`ModuleMemoryAuthorityError` 的 `constructor(readonly projectPath: string)`，`storage-memory.ts:598`） |
| 7 | `features/magic-context/memory/storage-memory-fts.ts` | ❌ | `ERR_MODULE_NOT_FOUND: …\memory\storage-memory`（无扩展名） |
| 8 | `features/magic-context/memory/storage-memory-verifications.ts` | ✅ OK | — |
| 9 | `features/magic-context/storage-memory-mutation-log.ts` | ✅ OK | — |
| 10 | `features/magic-context/storage-project-state.ts` | ✅ OK | — |
| 11 | `features/magic-context/workspaces.ts` | ❌ | `ERR_MODULE_NOT_FOUND: …\shared\logger`（无扩展名） |
| 12 | `features/magic-context/memory/project-identity.ts` | ❌ | `ERR_MODULE_NOT_FOUND: …\shared\logger`（无扩展名） |
| 13 | `shared/sqlite.ts` | ✅ **OK** | — |
| 14 | `tools/ctx-memory/tools.ts` | ❌ | `ERR_MODULE_NOT_FOUND: Cannot find package '@opencode-ai/plugin'`（**未安装**：`node_modules/@opencode-ai/plugin` 在根与 `packages/plugin` 下都不存在） |

**规律**：只有"相对导入**全是 `import type`**"或"只 import `node:` 内建"的模块能裸跑。任何**运行时**相对导入都会因 Node ESM 不做扩展名解析而失败。

### 12.3 第二轮 — `--experimental-transform-types` + 扩展名解析钩子

钩子（`$env:TEMP/mc-import-probe/hooks.mjs`）：

```js
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error && error.code === "ERR_MODULE_NOT_FOUND" &&
        (specifier.startsWith("./") || specifier.startsWith("../"))) {
      for (const ext of [".ts", ".tsx", "/index.ts", ".js"]) {
        try { return await nextResolve(specifier + ext, context); } catch {}
      }
    }
    throw error;
  }
}
```

注册（`register.mjs`）：

```js
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
```

运行（**Windows 上 `--import` 必须传 `file://` URL，传裸 `C:\…` 会 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`**）：

```powershell
node --experimental-transform-types --import file:///C:/…/register.mjs probe.mjs
```

结果：

| 候选 | 第一轮 | 第二轮（transform + hook） |
|---|---|---|
| `memory/memory-visibility.ts` | ❌ | ✅ **OK** |
| `memory/storage-memory.ts` | ❌ 参数属性 | ✅ **OK** |
| `memory/storage-memory-fts.ts` | ❌ | ✅ **OK** |
| `workspaces.ts` | ❌ | ✅ **OK** |
| `memory/project-identity.ts` | ❌ | ✅ **OK** |
| `tools/ctx-memory/tools.ts` | ❌ | ❌ 仍失败：`Cannot find package '@opencode-ai/plugin'` |

结论：**只有 `tools.ts` 真的不可用**，且原因与我们无关——它是 OpenCode 插件 API（`import { type ToolDefinition, tool } from "@opencode-ai/plugin"`，`tools.ts:1`），仓库里没装。

### 12.4 依赖闭包分析

- `shared/sqlite.ts` **裸 Node 就能加载**，而且**它本身就是为双运行时设计的**：`detectSqliteRuntime()` 检测 Bun vs Node，动态（bundler-evading）导入 `bun:sqlite` 或 `node:sqlite`，并把 `node:sqlite` 的 `DatabaseSync` 包成 better-sqlite3 形状（补 `db.transaction(fn)`、`readonly`→`readOnly`、单数组绑定归一化）。**这是最大的复用收益**——我们的 DSH 适配器可以直接用 `import { Database } from "../../plugin/src/shared/sqlite.ts"`，白拿事务 shim + 写者获取重试。〔码〕`shared/sqlite.ts:172-198,286-330,391-429`
- **唯一需要外部 shim 的**：无扩展名导入的**解析**（一个 ~15 行 loader hook，见上）；以及 `--experimental-transform-types`（Node 24 内建，无需第三方）。**不需要**改 MC 源码、不需要 `tsconfig paths`、不需要 bundler。
- 参数属性只在 `storage-memory.ts:598`（`ModuleMemoryAuthorityError`）一处；`--experimental-transform-types` 覆盖。
- enum/namespace/decorator：候选集合里**没有**，不是阻塞点。
- `shared/sqlite.ts` 有**顶层 `await`**（`:189`）：import 它的模块必须也是 ESM 且接受异步初始化。

### 12.5 真实库（只读）验证

〔测〕用 `node:sqlite` 的 `new DatabaseSync(path, { readOnly: true })` 直接打开用户真实库（**只读**，未做任何写；未备份、未 checkpoint、未触碰 `-wal`/`-shm`）：

- `PRAGMA user_version` → `0`（**不是版本号**）
- `schema_migrations` → **94 行，MAX(version)=94**，最新一条 description = `store LKG prefixes as slices and replay decisions as rows instead of growing records`
- `migration_pending` → 空
- `PRAGMA journal_mode` → `wal`；`PRAGMA foreign_keys` → `1`
- `SELECT COUNT(*) FROM memories` → **841**；可注入（active/permanent 且未过期）→ **757**
- 三张表的 DDL 与源码默认**逐字节一致**（见 §1.1、§5.1、§6.1）
- `memories` 上 6 个触发器、4 个索引（详见 §1.5、§8.4）；`memories_fts` 为 fts5 external-content

真实值集〔测〕：

| 列 | 分布 |
|---|---|
| `category` | CONFIG_VALUES 266 / CONSTRAINTS 197 / ARCHITECTURE 187 / PROJECT_RULES 151 / NAMING 40（**无 legacy**） |
| `status` | active 757 / archived 84（无 permanent） |
| `scope` | project 808 / universe 18 / ecosystem 15 |
| `source_type` | historian 614 / agent 194 / dreamer 33（无 user） |
| `verification_status` | unverified 841（100%） |
| `shareable` | 0 → 445 / 1 → 396 |
| `importance` | 无 NULL；范围含 10…100 |
| `expires_at` | 0 行非空 |
| `verified_at` | 0 行非空 |
| `retrieval_count` | 192 行 > 0，总和 594 |
| `seen_count` | 1 → 829 / 2 → 11 / 3 → 1 |
| `memory_mutation_log.mutation_type` | archive 62 / superseded 22 / update 170（无 delete） |
| `project_state` | 6 行；epoch 3 → 5 项目、0 → 1 项目 |
| `authority_managed` / `authority_repair_pending` | **0 行 / 0 行**（⇒ 直写当前不被拒） |
| `context_privilege_state` | `{id:1, enabled:0}` |
| `memory_embedding_watermarks` | 空表 |

复现命令（可从仓库根重跑）：

```powershell
$tmp = Join-Path $env:TEMP "mc-import-probe"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null
# hooks.mjs / register.mjs 见 §12.3
$repo = "<path>"
$url  = "file:///$repo/packages/plugin/src/features/magic-context/memory/storage-memory.ts"
node --experimental-transform-types --import "file:///$(($tmp -replace '\\','/'))/register.mjs" `
  --input-type=module -e "await import('$url'); console.log('OK')"
```

---

## 13. 实现清单（按依赖顺序）

### 13.1 最小语句集合

**必须实现的（按依赖顺序）**

| # | 能力 | 语句/逻辑 | 来源 |
|---|---|---|---|
| 0 | 连接设置 | `PRAGMA busy_timeout=5000` → `PRAGMA foreign_keys=ON` → `PRAGMA journal_mode=WAL`（顺序不可换） | §10.1 |
| 1 | 项目身份 | `normalizeStoredProjectPath` + `storedPathBelongsToIdentity`；`git:<sha>` / `dir:<md5[:12]>` | §1.4 |
| 2 | 内容哈希 | `md5(content.toLowerCase().replace(/\s+/g," ").trim())` hex | §2.1 |
| 3 | 权威让路 | `authority_managed ∪ authority_repair_pending` 探针（容忍 `no such table`） | §8.4 |
| 4 | 读列投影 | `getMemorySelectColumns` 等价 SELECT | §11.1 |
| 5 | **write** | 查重 → `seen_count+1` 或 `INSERT … 21 列` → 回读；同一 `BEGIN IMMEDIATE` | §11.1 |
| 6 | **update** | 事务内排除自身的查重 → `UPDATE content/category/hash/updated_at` + `shareable=0` + `classified_at=NULL` + mural 清空 → `DELETE memory_embeddings` → append `update` delta | §11.3、§4.5 |
| 7 | **archive** | `UPDATE status='archived'[, metadata_json=…]` → append `archive` delta；batch 先全量校验 | §11.5 |
| 8 | **merge** | 同类别校验 → canonical（复用 5 或既有行）→ `UPDATE` 目标聚合 → 各源 `superseded` UPDATE + delta → 目标 `update` delta | §11.4 |
| 9 | **get / list** | `WHERE id IN (…)` / `WHERE project_path=? AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?) ORDER BY category, updated_at DESC, id ASC` | §11.6 |
| 10 | 可见性谓词 | 复用 `createMemoryVisibilityPolicy`（可直接 import） | §8.1 |
| 11 | **m[1] 增量面** | 每轮须能算 `MAX(id)` 水位 + `MAX(memory_mutation_log.id)` 游标 + 折叠渲染 `<memory-updates>` / `<new-memories>`，并持久化两个游标 | §6、§7 |
| 12 | mutation 折叠 | coalesce（terminal 优先、8 层链）、visibility 哨兵、按 id 升序 | §6.3 |

**可以不做 / 延后的**

- epoch bump（除**显式外部编辑**场景；dashboard 语义）
- `memory_embedding_watermarks`（TS 路径本来就不写）
- `verification_status` / `verified_at` / `memory_verifications`（dreamer 专责；真实库 100% unverified）
- `mural_cue*` 的**写入**（我们只清空）
- `retrieval_count` / `last_retrieved_at`（telemetry；可选，且必须在显式检索时才 +1）
- 硬 `delete`（建议完全不暴露）
- FTS 写入（触发器负责）

### 13.2 建议直接 import 复用（不要重写）

〔测〕§12.3 已验证可在 Node 24 `--experimental-transform-types` + 扩展名解析钩子下加载：

```ts
import { Database } from "../../plugin/src/shared/sqlite.ts";
import { computeNormalizedHash, normalizeMemoryContent }
  from "../../plugin/src/features/magic-context/memory/normalize-hash.ts";
import { V2_MEMORY_CATEGORIES, CATEGORY_PRIORITY, MEMORY_CATEGORY_ORDER_SQL, getMemoryCategoryOrder }
  from "../../plugin/src/features/magic-context/memory/constants.ts";
import { FOREIGN_VISIBLE_SQL } from "../../plugin/src/features/magic-context/memory/visibility.ts";
import { createMemoryVisibilityPolicy } from "../../plugin/src/features/magic-context/memory/memory-visibility.ts";
import { insertMemory, insertMemoryIdempotent, getMemoryByHash, getMemoryById, getMemoriesByIds,
         updateMemoryContent, updateMemorySeenCount, updateMemoryStatus, archiveMemory,
         supersededMemory, mergeMemoryStats, deleteMemory, getMemoriesByProject,
         getMaxMemoryIdForProjects, readNewMemoriesForM1Union, setMemoryClassification,
         COLUMN_MAP, getMemorySelectColumns, hasMemoryShareableColumn,
         ModuleMemoryAuthorityError }
  from "../../plugin/src/features/magic-context/memory/storage-memory.ts";
import { queueMemoryMutation, getMemoryMutationsForRender, getMaxMemoryMutationId }
  from "../../plugin/src/features/magic-context/storage-memory-mutation-log.ts";
import { bumpProjectMemoryEpoch, getProjectState, ensureProjectState,
         GLOBAL_USER_PROFILE_PROJECT_PATH }
  from "../../plugin/src/features/magic-context/storage-project-state.ts";
import { normalizeStoredProjectPath, storedPathBelongsToIdentity }
  from "../../plugin/src/features/magic-context/memory/project-identity.ts";
import { resolveWorkspaceIdentitySet, resolveWorkspaceShareCategories }
  from "../../plugin/src/features/magic-context/workspaces.ts";
```

**收益**：`shared/sqlite.ts` 白送 Bun/Node 双后端 + `db.transaction()` shim + 写者获取重试 + 单数组绑定归一化；`memory-visibility.ts` 白送 workspace 共享策略，避免"第二份策略实现"漂移（该文件注释明确警告过这点，`memory-visibility.ts:14-16`）。

**代价/注意事项**：
- 进程启动必须带 `--experimental-transform-types`（参数属性）与 loader hook（无扩展名解析）。DSH 若不能控制 node 启动参数，这个方案就要退回"复制这几个文件 + 加扩展名"，或预先构建。
- 会打印 `ExperimentalWarning: Transform Types is an experimental feature`。
- 相对路径的深度要按 `packages/dsh-plugin/src/...` 的实际位置调整。

### 13.3 **不建议**复刻的部分与理由

| 不建议复刻 | 理由 |
|---|---|
| `tools/ctx-memory/tools.ts` 整层 | 依赖未安装的 `@opencode-ai/plugin`；且含 OpenCode 专属的 `toolContext.agent`/`directory`/`sessionID`、curate 轮转、imitated-reduced-args 解包。**语义照抄，代码用我们自己的工具定义**。 |
| FTS 索引维护 | 真实库靠 `memories_ai/ad/au` 触发器；再写一遍会双写并损坏 `memories_fts`。 |
| 翻转 `context_privilege_state.enabled=1` | 这是 MC 特权写入者协议（`withPrivilegedWriter`），要求 `enabled` 在同一 `BEGIN IMMEDIATE` 内从 1 置回 0，且"第二连接永不可见 1"。冒充会破坏该不变量并可能让另一宿主在错误窗口绕过守卫。**正确做法是 detection + 让路**。 |
| `bumpProjectMemoryEpoch` 用于**会话内**写 | 会击穿 prompt-cache 前缀——这正是 m[0]/m[1] 分裂要解决的 bug（`inject-compartments.ts:1926-1935`）。我们应与 MC 一致：additive → 水位；non-additive → mutation log。 |
| `bumpEpochsForWorkspaceMembers` 的 workspace 广播 | 只在 workspace 成员资格/共享类别**结构变化**时用；逐条记忆写入用它会造成 6 个项目同时 HARD fold。 |
| `memory_embeddings` 的 embedding provider 链 | 我们已实现只读召回；写入侧 embedding 可交由 MC 的 backfill（它按 `MAX(id)` / `memory_embedding_watermarks` 自扫）。若要写，只需 `DELETE FROM memory_embeddings WHERE memory_id = ?`（内容变更时的失效）。 |
| `mural_cue*` 压缩逻辑 | 属 mural 渲染子系统；我们只做"内容变更时清空"。 |
| `memory_verifications` / validate / verify | dreamer 专责；真实库 100% `unverified`、0 行 `verified_at`。 |
| dreamer 的 curate/expire/classify 任务 | 属另一条产品线（记忆策展），不是"写一条记忆"的最小契约。见同目录的另一份 promotion 契约。 |
| 硬 `delete` | 已注入的活跃会话收不到 `<removed>`（不写 log），会造成"库里没了、上下文里还在"的分裂。**建议我们的写路径不暴露 delete**。 |
| `metadata_json` 的自由写入 | 真实库中只用于 `archive_reason`；自由写入会污染 dashboard 展示与 dreamer 判断。 |

---

## 14. 一页速查（最小可粘贴实现骨架）

```ts
// 0) 连接（一次）
db.exec("PRAGMA busy_timeout=5000");
db.exec("PRAGMA foreign_keys=ON");
db.exec("PRAGMA journal_mode=WAL");

// 1) 权威让路（每次写前；容忍老库缺表）
const managed = (() => { try {
  return db.prepare(`SELECT 1 FROM authority_managed WHERE project_path = ?
                     UNION SELECT 1 FROM authority_repair_pending WHERE project_path = ? LIMIT 1`)
           .get(identity, identity);
} catch (e) { if (String(e).includes("no such table")) return null; throw e; } })();
if (managed) throw new Error(
  `memory writes for module-managed project ${identity} must use the Rust ctx_memory module facade`);

// 2) 写入（write：查重+插，同一 IMMEDIATE）
const now = Date.now();
const hash = md5Hex(content.toLowerCase().replace(/\s+/g, " ").trim());
db.transaction(() => {
  const dup = selectByHash.get(identity, category, hash);
  if (dup) { bumpSeen.run(now, now, dup.id); return { id: dup.id, inserted: false }; }
  insert.run(identity, category, content, hash, importance ?? 50,
             sessionId ?? null, sourceType ?? "historian",
             now, now, now, now, expiresAt ?? null, metadataJson ?? null);
  const id = Number(lastInsertRowid);
  return { id, inserted: true };
}).immediate();
// ↑ 新增：不写 mutation log、不 bump epoch。渲染侧靠 MAX(id) 水位。

// 3) update / archive / merge：见 §11.3–11.5，每个都在 BEGIN IMMEDIATE 内
//    UPDATE memories … → append delta → 完成
```

**渲染面（每轮 transform）必须同时维护两条游标**，否则每次写入都会破坏缓存前缀：

```sql
-- 水位：与 m[0] 完全相同的可见性/生命周期/冻结过期谓词
SELECT COALESCE(MAX(id), 0) FROM memories
 WHERE project_path IN (…) AND status IN ('active','permanent')
   AND (expires_at IS NULL OR expires_at > :frozenCutoff)   -- + 共享过滤

-- mutation 游标
SELECT COALESCE(MAX(id), 0) FROM memory_mutation_log
 WHERE project_path IN (…)
```

两者都持久化在会话元数据里（`cached_m0_max_memory_id` / `cached_m0_max_memory_mutation_id`），**只在 m[0] 成功物化时推进**。

## 16. Cross-project writes and reads (adapter extension)

DSH has no per-turn working directory (verified across core/session, agent-loop
and the tool layer: `header.cwd` is frozen creation metadata; `ptc.ts` injects
it as a per-call default only). OpenCode — whose sessions expose an updated
`directory` and for which Magic Context keeps a drift-correcting
`session_projects` binding — cannot be mirrored here because the host-side
authority signal does not exist.

The adapter therefore scopes cross-project work by the MODEL naming the
project:

- Every `ctx_memory` action accepts an optional `project` argument (an
  absolute path or a `git:`/`dir:` identity). It resolves through the same
  normalizer as the session scope; an unresolvable spec is a structured
  refusal (`project … could not be resolved`, journaled with `ok:false`) and
  nothing is read or written under a guessed scope.
- Retrieval telemetry follows the effective scope: rows counted are rows of
  the project the action named.
- The desk prompt carries the cross-project discipline (write AND read).
- Identity stability is unchanged: a git project's identity is its root
  commit, so moving the directory does not orphan its memories; only
  non-git `dir:` identities are path-bound.
- Observation: `project-drift` journal rows (warn) record turn text whose
  git roots differ from the session's own root — the data that quantifies
  how often cross-project sessions happen and whether a deeper mechanism
  (per-fact attribution, or a DSH `session_projects` equivalent) is warranted.

## 17. Cross-host compatibility audit (DSH writes ↔ MC reads/operates)

Audited 2026-10-07 (two independent passes: live-store probes against
`context.db` v94 plus a field-level source comparison of the MC read/operate
paths against the DSH write paths). **Verdict: compatible — every row the
DSH plugin writes is readable and operable by the reference MC plugin, with
zero incompatibilities.** Fixed in the same pass: R1/R2 below
(commit `cf78dbfd7`).

### 17.1 Why the two hosts interoperate

- **Identity**: byte-identical derivation on both sides — `git:` + root
  commit (multi-root: lexicographically smallest, truncated to 64) or
  `dir:` + `md5(path)[:12]`; all matching is **exact equality**, no prefix
  matching (MC `project-identity.ts:339-410,790-820`; DSH
  `memory-bridge.ts:255-306`). The same repository yields the same
  `project_path` under either host, so MC never misses DSH rows.
- **Hash**: `normalized_hash` algorithms are identical
  (`normalize-hash.ts:3-12` ↔ `memory-bridge.ts:240-242`); the dedup key
  `(project_path, category, normalized_hash)` behaves the same.
- **Row validation**: DSH-written enums (V2 five categories,
  `scope='project'`, `source_type='agent'|'historian'`, `status='active'`,
  `verification_status='unverified'`) all pass MC's `isMemoryRow`
  (`storage-memory.ts:44-85,272-301`); unwritten columns all have schema
  defaults (`storage-db.ts:1342-1373`).
- **FTS**: maintained by the `memories_ai/ad/au` triggers on the shared DB
  (`storage-db.ts:1746-1757`) — any writer's INSERT/UPDATE lands in
  `memories_fts` automatically. Verified live: a DSH historian-promoted row
  matches a content-word `MATCH`.
- **Operations**: MC's update/archive/merge issue `UPDATE memories … WHERE
  id = ?` with **no source-type precondition** (`storage-memory.ts:443-497`);
  the only ownership hard-check is mural (MC-only; DSH leaves those columns
  NULL).

### 17.2 Fixed during the audit

- **R1**: DSH `markVerified` wrote only `verified_at`; MC writes
  `verification_status` and `verified_at` as a pair
  (`storage-memory.ts:464`). Maintenance-verified rows therefore still read
  as *unverified* under MC. Fixed: the DSH statement now pair-writes
  `verification_status='verified'` with `verified_at`.
- **R2**: tool-supplied `importance` was written unclamped; it is now
  clamped to MC's 1..100 band (`storage-memory.ts:1132-1135`).

### 17.3 Accepted behavioral differences (watch items, not defects)

| # | Difference | Impact |
|---|------------|--------|
| R3 | DSH tool writes TTL WORKFLOW_RULES (90d) / KNOWN_ISSUES (30d); MC tool writes of the same categories are permanent (MC sets TTL only on historian promotion) | Rows expire out of MC list/search; both sides' read filters agree |
| R4 | Ownership check: DSH compares raw `project_path`, MC compares normalized | MC can operate DSH rows; the reverse only misses MC legacy raw-path rows (none in a v94 store) |
| R5 | A transient git failure makes DSH fall back to `dir:` while MC reuses its last-known `git:` identity | Rows written inside the window are invisible to MC until DSH's next process (self-heals) |
| R6 | Non-git directories reached through symlinks may hash differently (MC realpaths at the session layer, DSH only `path.resolve`) | Git projects unaffected (identity is the root commit) |
| R9 | DSH writes no embeddings; rows score FTS-only (0.3 × 0.8 single-source penalty) until MC's read-path backfill fills them (`search.ts:707-731`) | Convergence delay, not a miss; workspace-*foreign* rows are never backfilled and stay FTS-only |
