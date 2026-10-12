# 运维手册（可执行清单）

> 规划 WP14 的第二个交付物（第一个是巡检 prompt v5，见 [`patrol-prompt-v5.md`](patrol-prompt-v5.md)）。
> 来源：设计 v2 §7「稳态运维」的节拍表 —— 那份表回答"什么时候做什么"，本文回答
> **"敲哪条命令、看到什么算正常、看到什么该动手、动不了怎么办"**。
>
> **脚本类命令全部在真库上实跑过**（2026-10-10），含备份命令与 `verify` 的退出码；
> DSH 里的斜杠命令（`/ctx-profile`、`/ctx-global`）无法从终端跑，其用法逐字取自
> `src/dsh/command-surface.ts` 的 `PROFILE_USAGE` / `GLOBAL_USAGE`。

---

## 0. 先知道三件事

**① 两个库，责任不同**

| 库 | 路径 | 谁写 |
|---|---|---|
| 共享契约库 | `~/.local/share/cortexkit/magic-context/context.db` | 本适配器（受契约 v95 约束）；**结构冻结** |
| 适配器自有库 | `~/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db` | 只有本适配器（schema v9） |

排查任何问题，先问"这条数据在哪个库里"——域、队列、journal、baseline 在自有库；
记忆正文、画像行、embedding 在共享库。**混着看会得出错误的结论**（域判定第一版就踩过：
拿适配器句柄去问 `user_memories`，恒报"没有画像表"）。

**② 契约结构一旦漂移，先停手**

```bash
node scripts/mc-contract-freeze.mjs verify
```

`contract OK: 196 objects, contract v94, digest 8bd1476f9a07` = 正常。
**任何 FAIL ⇒ 停止一切写入**，先弄清是不是本适配器干的（L1 语义冻结不允许被打破）。

**③ 开关不在 GUI 里**

`memory.*` 全部**不在导出 Config 中**（GUI 看不到），只能改 profile 的 `cordis.patch.yml`；
且 patch config 是**整键替换**不是深合并 —— 改一个子键要写全整个 `memory.global.user` 块。
清单见 §5。

---

## 1. 每日（2 分钟）

```bash
node scripts/dsh-doctor.mjs
```

只看两节：**§6 全局域与画像**、**§7 向量**。然后在 DSH 里敲 `/ctx-profile list`。

| 看到 | 含义 | 动作 |
|---|---|---|
| `全部域停用：路由已就绪但未接管` | 正常态（**每个域开关默认 off 是刻意的**） | 无需动作；要接管见 §5 |
| `dir:global:org [org] 停用 · budget 768 · cap 30 · 5 成员` | 成员已导入、开关未开 | 无需动作（这是当前真库状态） |
| `画像确认队列待确认 N 条（/ctx-profile list）` | **约束型内容在等人** | 进 DSH 敲 `/ctx-profile list` → `confirm <id>` 或 `reject <id> --yes` |
| `全局候选待定 N 条（/ctx-global candidates）` | org/machine 候选待复核 | `/ctx-global candidates` → `approve <id> --yes` 或 `reject-candidate <id> --yes` |
| `已启用却没有任何成员` | **病态**：域看起来配好了却看不到任何项目 | 见 §6 第 2 条 |
| `覆盖率 <70%` / `前沿之后有 N 条从未嵌入` | 向量车道在退化（回填开关默认 off） | 见 §6 第 5 条 |

**没看到"待确认"行 = 队列是空的**，不是诊断坏了（该行恒打印，0 时也打印）。

---

## 2. 每周（5 分钟）

```bash
node scripts/mc-acceptance.mjs      # 退出码：0=无 FAIL，1=至少一条 FAIL
node scripts/mc-report.mjs          # 域命中分布 / 队列 / cap 占用 / 向量 / historian 成因
```

acceptance 的 `domain.*` 是**域车道的存活性检查**（7 条，判定逻辑在
`scripts/domain-checks.mjs`，每条都有正负样本）：

| 条目 | PASS 的样子 | WARN 时怎么办 |
|---|---|---|
| `domain.schema` | `全局域表存在（1 个域）` | FAIL = schema 未到 v8，插件没升级成功 |
| `domain.members` | `1 个域有成员（dir:global:org=5）` | `node scripts/mc-import-workspace.mjs --dry-run` 看会导入什么 |
| `domain.enabled` | `N 个域已启用` | WARN 是正常默认态；要接管见 §5 |
| `domain.enabled-without-members` | `没有"已启用却零成员"的域` | 见 §6 第 2 条 |
| `domain.confirmation-backlog` | `队列 0 条，未积压` | 有人没处理确认队列；阈值见 §3 |
| `domain.candidate-backlog` | `候选 0 条，未积压` | 复核通道没推进 |
| `domain.profile-pool` | `画像池 active 14 行` | `契约没有 user_memories 表` = 契约库只读降级或未打开 |

**mc-report 的值不值得看**：`domain 命中（按域/按项目去重）` 如果两周都是 0，说明域没被
真正使用 —— 这是"要不要继续投入"的产品判据（见规划 WP9 的退出条件），不是故障。

---

## 3. 阈值触发（不需要等到日/周）

| 触发 | 判据出处 | 动作 |
|---|---|---|
| 域 cap 打满 | doctor 的 `cap N` 与 `mc-report` 的域行数 | **强制整理**：合并同义条目、退役失效条目（`/ctx-global` 成员/候选面 + `/ctx-profile retire <id> --yes`）。不整理 ⇒ 域退化为噪声池，cap 会拒收新条目 |
| 确认队列积压 | acceptance `domain.confirmation-backlog`（>5 条 WARN） | 清队列；**约束型内容未确认就不会生效**，堆积等于白采集 |
| 候选积压 | acceptance `domain.candidate-backlog`（>10 条 WARN = 提前提醒） | 复核或拒绝；`promote` 只造候选，不发布 |
| 候选越红线 | acceptance `domain.candidate-redline`（**>50 条 且 最老 >7 天 ⇒ FAIL**，设计 v2 §7） | **必须处理**：复核/拒绝，或退役该域。判据是"深**且**旧"，只满足一条不报 |
| 契约冻结 FAIL | `mc-contract-freeze.mjs verify` | **停止写入**，先定位漂移来源 |
| historian 失败率异常 | `mc-report` 的成因行（带"至 MM-DD"） | 看成因：`配额`=某条路线 7 天上限（换路线或等）；`截断`=容量；`invalid-output`=输出形状（已加配平诊断） |
| 维护 tick 跳过 LLM | journal `maintenance` 行 `LLM steps skipped: <route> observed quota-exhausted Nm ago (hold 45m)` | **无需动作**：维护车道跟随主对话路线（2026-10-10 起未钉 verifyProvider 时）；该路线额度恢复或主对话换路线后，≤45 分钟自动重开。观察是易失的（不落盘），外部重置额度不会被旧状态困住 |

> ✅ **两层阈值已统一到一份常量，且都在 acceptance 里**（2026-10-10 定案）：`scripts/domain-checks.mjs`
> 的 `BACKLOG_THRESHOLDS` = `early`（确认 5 条 / 候选 10 条 ⇒ `domain.confirmation-backlog` /
> `domain.candidate-backlog` 报 WARN，提前提醒）+ `redLine`（候选 >50 条 **且** 最老 >7 天未处理
> ⇒ `domain.candidate-redline` 报 **FAIL**，即设计 v2 §7 的必处理线）。两者不冲突：早提醒先响，红线只在
> "深且旧"时响 —— 深但不旧、旧但不深、恰好等于阈值三种情况都有负向对照
> （`tests/domain-checks.spec.ts`）。读报告只需认 id，不必再猜自己看的是哪一层。

---

## 4. 每月

```bash
node scripts/mc-contract-freeze.mjs verify     # 契约结构
npm run gate                                   # 全量门禁（含契约冻结、验收、记忆审计）
npm run phase all                              # 阶段门 A–D
```

加一件手工事：**抽查一条已批准条目**（org 域或画像池各一条），问"这句话现在仍然成立吗"。
全局域最典型的失效是"说得对但已过期"——机器查不出来，只能人看。
不成立 ⇒ `/ctx-profile retire <id> --yes`（画像）或 `/ctx-global` 的退役路径（域行）。

---

## 5. 开关清单（默认值 / 打开顺序 / 回滚）

**全部默认 off 是刻意的**：默认关闭意味着"装上插件不会自动开始跨项目共享"。

| 配置键 | 默认 | 写什么 | 回滚 |
|---|---|---|---|
| `memory.global.user.render` | **on** | 只读契约（注入 `<user-profile>`） | 关掉即不再注入；已注入内容在下次 HARD 重建时消失 |
| `memory.global.user.collect` | off | 写契约 `user_memory_candidates` | 关掉即停止采集；**已采集的候选留着**，用 `expireCandidates`/TTL 清 |
| `memory.global.user.review` | off | 写契约 `user_memories`（**会注入所有会话**） | 关掉停止新增；**已晋升的行不会自己消失** ⇒ 必须显式 `retire` |
| `memory.global.machine.enabled` | off | 写契约（本机共享） | 关掉即不写；**已有域行仍在**，退役要显式做 |
| `memory.global.machine.excludeProjects` | `[]` | — | 只增不减语义：排除只是把项目移出域，**从不删除**其他数据 |
| `memory.domains.source` | `adapter` | — | 改成 `contract` = 回退到旧的 workspace 查询（**一个版本的回滚杠杆，不是终态**） |
| `memory.vectorBackfill` | **on**（2026-10-12 起缺省=true；此前 off） | 写契约 `memory_embeddings` | 设 false 即停；已写的行留着（唯一的合法写入目标见 §7）。改缺省的理由：写入路径不嵌入 ⇒ 默认关=新记忆永远无向量、中文语义召回随行数静默衰减 |
| `memory.vectorBackfillLimit` | 24 | — | 每拍回填上限 |
| `memory.embedBackfill` | on | **不写库**（查询侧按需嵌入） | 与回填无关，别混淆 |

**建议打开顺序**（每步之后跑 acceptance + doctor，并做一次备份）：

1. `user.collect` → 观察候选是否合理（可逆：只是采集）
2. `user.review` → 观察写入的画像是否合理（**语义上不可逆，要退役**）
3. `org` 域 `enable`（先确认 5 名成员身份正确）
4. `machine.enabled`（先用 `excludeProjects` 排除不该共享的项目）
5. `vectorBackfill`（先看 doctor 的 parity；**parity 是前提，闸门关即整批中止**）

备份（真写前必做；**下面这条在真库上实测过**，输出 `backup ok: ... memories= 1359`）：

```powershell
node -e 'const {DatabaseSync}=require("node:sqlite"); const p=process.env.USERPROFILE+"/.local/share/cortexkit/magic-context/context.db"; const out=p.replace(/\.db$/,"")+"-backup-"+Date.now()+".db"; new DatabaseSync(p).exec("VACUUM INTO ''"+out+"''"); console.log("backup ok:", out)'
```

`VACUUM INTO` 只读源库、写出一个新文件，**不会碰正在用的库**；备份文件与源库同目录，
名字带时间戳。验证备份可用：把 `out` 换成备份路径再打开数一次 `memories` 行数。

---

## 6. 故障处置

1. **`全部域停用` 一直不变，而你以为开了** ⇒ 开关在 `cordis.patch.yml` 的 `memory.global.*`
   下，**不是** GUI 里；且 patch 是整键替换，写漏子键会被整块覆盖。
2. **`已启用却没有任何成员`** ⇒ 启用了却零成员 = 该域看不到任何项目。
   先 `node scripts/mc-import-workspace.mjs --dry-run` 看计划，再决定是否真导入。
   （入口脚本拒绝裸路径身份：它们与适配器的规范化身份不匹配，导入后域会静默不激活。）
3. **`domain.profile-pool` 报"契约没有 user_memories 表"** ⇒ 契约库没打开或被 fence
   （版本高于适配器支持）。此时画像车道无源，先看 acceptance 里 `contract.exists` /
   `fence.version` 的结论。
4. **写入没生效但命令报成功** ⇒ 检查 `boot` 里的 `memoryWrite`：
   `read-only` 表示契约 fence 生效，**所有写路径都在失败**（这是历史上出现过的
   "全写失败却对外宣称 read-write"形态，acceptance 的 `fence.exposure` 专门盯它）。
5. **向量覆盖率下降** ⇒ `memory.vectorBackfill` 自 2026-10-12 起缺省 on
   （写入路径不嵌入，默认关曾让新记忆永远无向量）；真库 dry-run 结论是
   parity 1.000000 PASS。排查前先确认主导空间：
   **只允许写 dominant `model_id`**，写错就是第三个空间（见 §7）。
   本地模型的缓存在**适配器库同级的 `models/`**（`defaultEmbeddingCacheDir`），~87 MB；
   若在**别处**（例如仓库根）看到 `models/`，说明某次运行用了相对适配器路径
   （`dirname('.')`）——那是缓存副本，删掉只会让下次重新下载，不影响任何数据。
6. **会话日志被判定损坏** ⇒ 见 PROJECT_RULES 的两条禁令（§7 第 3 条）：先确认该会话不在
   运行中，再修，且只修 loader 致命项。修复工具不接受"看起来不对"就改。

---

## 7. 不要做的事（都会造成不可逆损害）

1. **不给契约库加列/加表/改触发器/FTS**。L1 语义冻结必须守；L2 结构冻结要走流程。
2. **不往非 dominant 的 `model_id` 写 embedding**（会造成第三个向量空间，检索静默变化）。
3. **不在会话运行中带外改写会话日志文件**（历史上因此复发过一次事故：运行中的进程按旧内存
   结构继续 append）。
4. **不把约束型候选直接写进 `user_memories`**：必须过二次确认队列（未确认 ⇒ 注入与检索均
   不可见，这是设计不变量 I8）。
5. **不动 `<session-id>` 之外的巡检任务**：`schedule_*` 是会话作用域，
   禁止带外编辑 `schedule.json`。
6. **不用 `pnpm run`**（本仓会 EPERM 中断）；统一 `node node_modules/...` 或 `npm run`。

---

## 8. 哨兵本身可信吗（怎么自查）

本仓纪律是"判据先自证"：新哨兵必须做过"人为破坏必须报警"的对照。运维侧可复跑：

```bash
npm run phase d          # 含 domain-checks / report-classify / strip-drill / 命令面
```

- `tests/domain-checks.spec.ts` —— doctor 每条 WARN 与 acceptance 每条 `domain.*` 都有
  **触发用例 + 静默用例**（人为破坏必须报警）；含"未迁移 ≠ 零域""契约句柄缺失 ≠ 池子空"。
- `tests/report-classify.spec.ts` —— historian 成因分类用真库语料逐字回归。
- `tests/strip-drill.spec.ts` —— 无任何 MC 组件下两条闭环（org / user）各走完 5 步。
- `tests/phase-map.spec.ts` —— 任何空阶段直接判失败（门禁不能靠"没跑"变绿）。

**全绿必须带白名单与盲区**：`npm run phase all` 会打印每个阶段的 blind 列表，读结论时要一起读。

---

## 9. 未决

1. ~~队列 WARN 阈值（代码 5/10）与设计 §7 红线（候选 >50 且 >7 天）是否统一。~~
   **已定案 2026-10-10**：统一为一份常量 `BACKLOG_THRESHOLDS`（`early` + `redLine`），两层都进 acceptance，
   红线判据是"深且旧"双条件；见 §3 阈值注。
2. 每次接受的 `writer` 与 `profileWriter` 是两个句柄，但排队/发布共用一条 maintenance tick：
   域多起来后是否需要按域限流。
3. `mc-report` 的域命中目前每个域一行；第三个域上线后需要"按域 × 按项目"的二维视图。
