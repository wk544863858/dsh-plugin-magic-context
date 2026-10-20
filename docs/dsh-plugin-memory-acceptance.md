# DSH 适配器 · 记忆功能验收与实测证据

> 本文记录 `dsh-plugin-magic-context` 记忆功能在**实测 Magic Context 记忆库**上的
> 端到端验收结果与可复跑方式。所有数字都来自本机实测（适配器库
> `%USERPROFILE%\.local\share\cortexkit\magic-context-dsh-poc\dsh-magic-context.db`
> 与共享记忆库 `%USERPROFILE%\.local\share\cortexkit\magic-context\context.db`，
> 两者均以 `readOnly` 打开）。
>
> 验收命令：`node scripts/mc-acceptance.mjs`

## 1. 一键验收

```powershell
node scripts/mc-acceptance.mjs                     # 默认 24h 窗口
node scripts/mc-acceptance.mjs --hours 72 --json   # 机器可读
node scripts/mc-acceptance.mjs --dsh-db <path> --mc-db <path>
```

退出码：`0` = 无 FAIL（可含 WARN）；`1` = 至少一条 FAIL；`2` = 参数/环境错误。
脚本零依赖、只读、不打印任何记忆正文（只输出 id / 类别 / 计数 / 摘要）。

**当前结果：14 PASS / 1 WARN / 0 FAIL（exit 0）。**

## 2. 验收项与结果

| 项 | 断言 | 结果 |
|---|---|---|
| `adapter.schema` | 适配器 schema 版本一致，且 `baseline_state` 具备 `max_memory_id` / `max_memory_mutation_id` / `project_epoch_fingerprint` | ✓ v6 |
| `adapter.boot` | 最近 boot 自检：读路径与写路径真的打开 | ✓ `memory=ok schema v94`、`memoryWrite=read-write auto-promote` |
| `read.recall` | 确有项目记忆被注入 m[0]（非空 digest） | ✓ 201 次成功注入，最新 40 行 |
| `delta.lane` | `<memory-updates>` 与 `<new-memories>` 两条车道都有产出 | ✓ 7 次渲染增量、105 次上报新行 |
| `delta.cursor` | `memory_mutation_log` 游标已按会话持久化 | ✓ 5 会话中 3 个有游标 |
| `delta.byteStable` | **同 mode**（hard/soft 分开比）且同载荷（m[0] digest + 变更游标 + 分区计数 + **画像段**一致、期间无新记忆、无 drop 落地）的 baseline **逐字节一致**，判据见 `scripts/baseline-stability.mjs` | ✓ 零违例（缓存前缀稳定） |
| `historian.terminal` | 每个 `start` 必有 `done`/`failed`（只有进程被杀可豁免） | ✓ 修复后未闭合 0 |
| `fence.version` | MC schema ≤ 适配器支持版本（超出则只读降级） | ✓ v95 ≤ v95，未触发 |
| `promotion.contract` | 提升行字段完全符合 MC 契约 | ✓ 66 行零偏差 |
| `promotion.appendOnly` | 提升是纯追加（无 insert/delete 变更日志） | ✓ 仅 1 条 update（来自显式 `ctx_memory update`） |
| `retrieval.telemetry` | 检索计数只由显式检索 +1，自动注入不得灌水 | ✓ 3 行被检索、单行最多 1 次 ≤ 窗口内 7 次显式调用 |
| `epoch.stability` | `project_epoch_fingerprint` 不因本适配器写入而变化 | ✓ 5 会话全为 `905ce385547ae771` |
| `authority.guard` | authority 表为空、`context_privilege_state` 未启用 | ✓ 0 / 0 / enabled=0 |
| `historian.orphan`（WARN） | 被进程重启杀死的运行无法落账 | ! 14 次（重建/重启所致，非静默失败） |

## 3. 端到端链路时间线（实际运行，会话 `<session-id>`）

```
start   (139 nodes, maxTokens 8192)
done    attempts 1, 9744ms, facts 9
stored  compartment §C2§ (~26246 tokens)
compartment-published  §C2§ 替换 139 个 wire 节点
memory-promote         promoted 9 fact(s) into project memory
→ context.db memories id 894–902: source_type='historian', importance 50, scope='project'
```

同一窗口内：`historian` 事件 `start 163 / done 6 / failed 23 / stored 6`，
`compartment-published 6`、`memory-promote 6`。修复前 `done/failed/stored` 与
`memory-promote` **全部为 0**。

### 3.2 契约版本 fence 实测（实测库副本，不碰生产库）

用 `VACUUM INTO` 复制真实记忆库做两个副本，其中一个把 `schema_migrations` 抬到 95：

| 场景 | 结果 |
|---|---|
| v94 副本：写入 | `{ok:true, id:910, created:true, seenCount:1}` |
| v94 副本：同内容再写（去重） | `{ok:true, id:910, created:false, seenCount:2}`——同 id、不新增行 |
| v94 副本：`recordRetrieval` | `retrieval_count 0→1`、`last_retrieved_at` 写入、**`updated_at` 不变**、`seen_count` 不变 |
| v95 副本：状态 | `{ok:true, readOnly:true, corpusVersion:95, detail:"…READ-ONLY"}` |
| v95 副本：write/update/archive/recordRetrieval | 全部 `{ok:false, reason:'corpus-version-unsupported'}`，**不抛错** |
| v95 副本：读 | `listMemories` 66 行、`getMemory(909)` 正常——读路径不受影响 |
| v95 副本：库内容 | 探针行 0——被拒的写入没有落任何数据 |

**由此发现并修掉的缺陷**：fence 状态下 `status.ok` 仍为 `true`（读可用），
而 `src/index.ts` 的 meta/boot 只判断 `status.ok`，于是操作者在界面上会看到
`memory_write: read-write auto-promote`，而每次写入实际都失败。现已按 `readOnly`
区分措辞（`read-only: Magic Context schema v95 is newer…`），并在 `mc-acceptance.mjs`
增加交叉断言 `fence.exposure`：MC 版本高于适配器时 `memory_write` 必须显示 read-only。

### 3.3 去重（normalized_hash）实测

把一条已提升记忆的内容用 `ctx_memory write` **原样再写一次**（同 category）：
工具回报 `Already known (memory 909, seen 2 times)`；库内 `#909 seen_count 1→2`，
`importance/scope/shareable/status/source_type` 不变，`updated_at` 按契约前移，
项目行数不变（未新增行），`memory_mutation_log` 无该记忆的行——**加法写入不产生变更日志**，
全库重复组为 0。

## 4. 关键阈值实测：historian 生成上限

历史缺陷（只有 `start`、无终止事件）修好之后暴露出的**真实死因**是生成预算不足：

| `policy.historianMaxTokens` | 实测结果 |
|---|---|
| 2048（旧默认） | 23 次运行全部 `failed`，reason `historian call truncated at the token cap (incomplete digest)`；facts=0、提升=0 |
| 6144 | 成功，facts 12–15 |
| 8192 | 成功，facts 9–15（`HISTORIAN_MIN_OUTPUT_TOKENS` 现为代码下限） |

因此：`historianMaxTokens` 默认已提到 **8192**，高于该值的配置生效；
新增 `historianMaxTokensCeiling`（默认 **32768**）为"截断后翻倍重试"的上限；
`historianTimeoutMs`（默认 **60000**）为单次运行的墙钟预算，超时必落 `failed`。
界面插件页设置卡片与启动快照均已暴露这三项。

## 5. 缓存与净回收

- 缓存前缀稳定：`<memory-updates>` / `<new-memories>` 只写在 m[1] 增量区，m[0] 字节不变
  （上表 `delta.byteStable` 断言；判据只比**同 mode** 的相邻 baseline——hard rebuild 与
  soft refresh 组装的 block 本就不同，跨 mode 比字节不是这条不变量）。
- HARD 重建只在 m[0] 内容真的变化时发生（例如 promotion 改变池 digest），
  且会把两条增量车道一起折叠进 m[0] 并推进水位与游标。
- 真实 execute pass 净回收实测：`tokensBefore 110120 → tokensAfter 12462`（`tokensDelta −97658`）。

## 6. 已知限制（不是缺陷，但要知道）

1. **进程重启会留下未闭合的 `start`**：插件热重载/重启会杀死在飞的 historian 运行，
   死进程无法写 journal。验收脚本对"start 之后 15s 内有 boot"的情况单独标注为 WARN，
   不计入静默失败。修复后真正的静默蒸发为 **0**。
2. **`errors24h` 会在一段时间内非零**：那是上限修复前的 23 条截断失败，随窗口滚出即归零。
3. **契约版本 fence 未触发**（MC 仍为 v95）。若 MC 升级到 >95，写路径自动进入只读降级，
   读路径继续工作，`mc-acceptance.mjs` 的 `fence.version` 会转为 WARN。
4. **本适配器不实现** dreamer 的 `curate/verify/expire` 与 embedding 检索（`ctx_search`）：
   记忆的策展与淘汰仍归 Magic Context 本体。

## 7. 复跑与回归

```powershell
# 契约验收（只读）
node scripts/mc-acceptance.mjs

# 复盘报告（只读）
node scripts/mc-report.mjs --days 7

# 测试套件 + 一致性（一条命令；宿主自动解析；临时测试宿主目录不随仓库发布）
node scripts/mc-test.mjs --quick
# 需要构建/验收/审计/记录检查时用 --full；宿主缺失时 node scripts/bootstrap-testhost.mjs --install

# 构建（转译，热重载到运行中的桌面实例）
Set-Location <repo-root>; .\node_modules\.bin\tsc.CMD -p tsconfig.build.json
```
