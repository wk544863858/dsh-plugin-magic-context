# DSH Magic Context 适配器 — 工程记录与升级跟进指南

> 用途：Magic Context（MC）或 DeepSeek Harness（DSH）主版本变化后，用本文档快速
> 重新对齐适配器。先读「基线锚点」，再按「跟进流程」执行，对不上的地方查「对齐面
> 清单」定位 MC 源码依据，接缝坏了查「DSH 接缝清单」。
>
> 工程目录：`packages/dsh-plugin`（适配器本体）；测试镜像：`src/**\/*.spec.ts`；
> 可运行测试套：`<DSH-checkout>/packages/test-support/mc-dsh-poc/tests/`。

---

## 0. 单插件模式（2026-10-09 收敛，先读这节）

适配器开发已收敛为**单轨**，本仓库降级为只读上游镜像：

- **插件唯一之家** = `<path>`（npm 包名
  `dsh-plugin-magic-context`，含真 typecheck + 仓内 vitest 套件 + `npm run gate`）。
  desktop profile 经 pnpm `link:` 加载它（`bundles: [dsh-plugin-magic-context]`，
  loader row id 仍为 `magic-context-dsh`），HMR root 指向同一目录。
- **开发循环**：在新家改代码 → `npm run gate` → HMR 热重载。一切构建/测试/体检
  （`npm run doctor`）都在插件仓内闭环。
- **本仓库剩余职能**：fetch 上游（cortexkit/magic-context）tag、读上游源码做对齐
  面 diff。`dsh-track --apply` 与 `scripts/extract-standalone.ps1` 已随
  `packages/dsh-plugin` 的删除而退役——上游跟进不再走 rebase+重放，而是：看上游
  新 tag 的 diff → 按 §5 对齐面把相关变更移植进插件新家 → 那边 gate 全绿。
- `packages/dsh-plugin` 目录已从 `dsh` 分支删除；其 60+ 提交的完整历史经
  逐提交重放保留在插件新家的 git 历史里（树曾逐字节验证一致）。

---

## 1. 基线锚点（本工程对齐到的版本）

| 项 | 值 | 变化时的影响 |
|---|---|---|
| MC 版本 | **v0.46.0**（tag `651c105a9`，2026-10-08 发布 = 本地 `dsh-base`） | MC 升级 → 先跑 `dsh-track --check --fetch` |
| MC 存储契约 | **schema v95**（`MEMORY_SCHEMA_MAX_VERSION = 95`，`memory-bridge.ts`） | MC 迁移 >95 → fence 只读降级（见 §3.3） |
| DSH Desktop | **0.2.0-rc.2**（packaged app） | DSH 升级 → 查 §3 接缝 |
| 适配器自有库 | schema **v6**（adapter store，`stores.ts` SCHEMA_VERSION） | 适配器内部，自洽 |
| 测试基线 | **`mc-test --full` 7/7 PASS**（28 文件 / 255 测试全绿 + tsc + acceptance + audit + records） | 每次跟进的终验标准 |

## 2. 适配器三原则（为什么长这样）

1. **存储共享**：直接读写 MC 的 `context.db`（schema v95，只读连接 + 契约式写入），
   适配器自有库只存会话态（水位/区段/journal/tags）。
2. **逻辑逐字节照抄**：注入、融合评分、写入契约、分块策略都从 MC 源码移植，每处
   注释带 MC 依据（`file:line`）。禁止发明语义——曾收回 ctx_note 别名、tail_hygiene
   通知化两个发明。
3. **仅宿主接缝替换**：DSH 没有 MC 的请求前注入点，唯一架构性替换是 `preStep` 时序
   与 `requestError` 瀑布（见 §3.1）。每处偏差有注释。

## 3. DSH 接缝清单（DSH 升级最先坏的地方）

### 3.1 时序接缝
- **preStep**（`index.ts` preStep 注册）：DSH 无请求前注入点，适配器在 preStep 组装
  m[0]/m[1]/`<memory-updates>` 并做压力决策。MC 对应 `m0_compose.rs` 的请求前组装。
- **postToolExecute**：工具结果落地时打 §N§ 标签（fail-open；曾在 hmr 重挂载竞态中
  抛 `database is not open`，已包 try/catch）。
- **requestError**：`CONTEXT_WINDOW_EXCEEDED` 失败后的应急回收 + 重试
  （`dsh/emergency.ts`；窗口=clamp(上下文×5%, 8k, 64k)，工具分层 T1/T2/T3，
  MC `selection.rs:1185` + `emergency-drop.ts:54-55`）。

### 3.2 LLM seam
- `ctx.llm.stream()`（`index.ts` 的 `llm = ctx.llm`）：historian 辅助调用走 DSH 的
  provider 配置；路由=会话当前模型（`requestContextOf(session)`），可用
  `config.historian.route` 覆盖。**不读 MC 的任何配置**。
- 流协议：`text-delta` / `usage` / `finish.reason.kind ∈ {stop, max-tokens, error,
  aborted}`——historian 的截断/超时分类依赖这些 kind（`historian.ts collectText`）。
  DSH 改事件形状 → 改这里。

### 3.3 存储与宿主边界
- **fence**：`SELECT MAX(version) FROM schema_migrations WHERE version < 10000` >
  `MEMORY_SCHEMA_MAX_VERSION` → 写路径只读（`{ok:false, reason:'contract-version-unsupported'}`），
  读路径继续。MC 升 schema 后的跟进点就是把 94 改成新值并核对迁移内容。
- **authority guard**：`authority_managed` / `authority_repair_pending` 有行 → 写拒绝；
  `context_privilege_state` 永不翻转。
- **profile patch 的 config 是整体替换不是深合并**（`cordis.patch.yml` 每个必须保留
  的键都要重复写）。
- 插件 Config 从 **default export** 上解（`export default { name, inject, apply,
  Config }`）；只具名导出 Config 会被 loader 静默忽略。`memory` 故意不进 Config
  schema（schemastery 会为每个 profile 物化并打开桥）。
- client bundle：手写 `window.__ModuleLoader__.load({id, factory})` 壳（官方
  dsh-client-tsdown 未发布）；座位 `conversation.composer.dock`（order 2，兜底
  `shell.overlay`）；client 改动需页面 F5。

## 4. 对齐面清单（MC 源码 ↔ 适配器）

| MC 依据 | 适配器移植 | 跟进时 diff 的 MC 路径 |
|---|---|---|
| `inject-compartments.ts`（m[0]/m[1] 渲染、水位、mutation 过滤 :2825-2848） | `core/compartments.ts` + `dsh/management-pass.ts` | 同名文件 |
| `storage-memory.ts` / 写契约文档 §1.1（29 列、UNIQUE hash、promotion 纯 append） | `core/memory-write.ts` | 同上 + `docs/dsh-plugin-memory-write-contract.md` |
| `workspaces.ts:69-97`（share_categories 容错） | `core/memory-bridge.ts`（workspaceFor） | 同上 |
| `search.ts:48-64, :297-321, :836-904`（0.7/0.3 融合、id 直查、合并） | `core/memory-search.ts` | 同上 |
| `emergency-drop.ts:54-55` / `selection.rs:117-119, :1185`（分层、保护窗） | `dsh/emergency.ts` | 同上 |
| historian 分块（≤4 连续块 + merge） | `dsh/historian.ts`（planChunkSpans / HISTORIAN_MERGE_INSTRUCTION） | `hooks/magic-context/` |
| `getVisibleMemoryIds`（search 抑制已注入行） | `index.ts` visibleMemoryIdsBySession + `memory-search.ts` visibleMemoryIds | `inject-compartments.ts:222` |
| 向量：纯 JS 余弦 + 读路径回填 | `core/embedding-local.ts`（MiniLM fp32）+ B4 开关 `memory.embedBackfill` 默认关 | `memory/cosine-similarity.ts` |
| 代理引导（desk 段 + reduce reminder） | `dsh/reduce-guidance.ts` → SystemPrompt 服务 `section('magic-context-desk')` + 动态 `context('magic-context-reduce')` | `agents/magic-context-prompt.ts` + `hooks/magic-context/ctx-reduce-nudge.ts`（阈值/文案照抄：60k/25k floor、20/40/60% 阶梯、channel2 ≥75% 且 ≥50k、sticky 5 轮、refire 8%）|

对齐命令（MC 新版本后）：

```bash
git -C <path> log v0.45.0..<NEW> --oneline -- \
  packages/plugin/src/features/magic-context packages/plugin/src/hooks/magic-context crates/mc-module/src
```

## 5. 已记录偏差（有意为之，升级时不要"修复"它们）

- `recordRetrieval` 不写 `updated_at`（保 m[0] digest=id:updatedAt 稳定；MC 写）。
- >v95 只读降级、COALESCE seen_count、错误形态 `{ok:false}`。
- historian 单 run 预算 min(600s, timeoutMs×调用数)，与 MC 的独立预算结构不同。
- 未移植模块：caveman / decay_render / decision_calibration / divergence / healing /
  reply_pages / historian_chunk(MC 侧) / dreamer（curate/verify/expire 会双重归档）。
  **dreamer 的取舍边界与向量回填策略见 `docs/dsh-plugin-dreamer-vector-decision-2026-10-08.md`**
  （MC 按运输方式把 12 个任务分为 tool-loop 7 / single-shot 4 / host-only 1；当前只排
  `promote-primers`，其余按触发条件评估）。
- 95% 主动带、mid-turn deferral、租约在 DSH 架构下不可行（只有 preStep）。
- 跨重启的 historian 孤儿 start 行（进程内终局写不回；MC 用 WAL 恢复扫描）。

## 6. 跟进流程（每次 MC/DSH 升级后执行）

0. **跟踪（一条命令，只读）**：
   ```powershell
   node packages/dsh-plugin/scripts/dsh-track.mjs --check --fetch
   ```
   报告有无新 tag、上游推进量与本地增量数，并断言本地增量只落在
   `packages/dsh-plugin/**`、`docs/dsh-*`、`.gitignore` 之内。退出码：`0` 无事、
   `3` 有新 tag、`1` 越界或测试红、`2` 前置不满足。确认后用
   `node scripts/dsh-track.mjs --apply <tag>` 完成重放（`--onto <tag> dsh-base`）
   + 移动 `dsh-base` + 全量门禁 + 打印本节 §1 锚点该改成什么；重放冲突会
   `--abort` 并复原 `dsh-base`（预期冲突只可能出现在 `.gitignore`）。

1. **MC 侧**：§4 的 diff 命令 → 逐条核对到适配器文件；schema >94 时改
   `MEMORY_SCHEMA_MAX_VERSION` 并核对迁移。
2. **DSH 侧**：§3 逐条冒烟——preStep 注入、postToolExecute 打标、requestError 应急、
   `ctx.llm` 流、client 座位。
3. **回归（一条命令）**：
   ```powershell
   cd <path>
   node scripts/mc-test.mjs --full      # --quick = 只跑一致性 + 套件
   ```
   `--full` 依次等于旧五件套（逐步 PASS/FAIL 汇总在末尾）：
   - `sync-specs --check` — 两侧逐字节一致；漂移或 host-only 均 exit 1
   - `vitest run packages/test-support/mc-dsh-poc/tests` — 在解析到的宿主内执行
   - `tsc -p tsconfig.build.json` + `copy-client.mjs` — 构建（写 `lib/` 会热重载 live
     实例；勿在他人在途时执行）
   - `mc-acceptance.mjs` — 0 FAIL
   - `mc-memory-audit.mjs --json` — exit 0 = 无 HARD 违规
   - `mc-records-check.mjs` — 面板记录分类/计数/噪声折叠 ALL PASS
   - `mc-records-check` 之外还有一条**只在重放后需要**的检查：
     `node scripts/build-reference-seeds.mjs`（`npm run build:seeds`）从上游
     `reference-seeds.generated.ts` 重抽 historian 校准锚点，`--check` 判定本包
     `src/core/reference-seeds.ts` 是否已随上游更新（漂移则 exit 1）。
   宿主解析顺序（`scripts/test-host.mjs`）：`MC_DSH_CHECKOUT`/`DSH_TESTHOST` →
   项目内 `<tmp>/deepseek-harness-master`（默认，gitignored）→ 旧
   `%TEMP%\dsh-src\deepseek-harness-master`。宿主缺失或未装依赖时跑
   `node scripts/bootstrap-testhost.mjs --install` 重建。
4. **套件单源**：canonical = `packages/dsh-plugin/tests/`（含 `helpers/`），
   checkout 侧由 `node scripts/sync-specs.mjs` 生成，两侧逐字节一致。
   模拟库 DDL 一律 `tests/helpers/memory-db.ts`，LLM 替身一律
   `tests/helpers/llm-fake.ts`——不在 spec 内联 `CREATE TABLE memories`，
   不手搓 llm 假件（形状宽松的替身是两个真实缺陷的藏身处）。
5. **live 冒烟**：`/mc-telemetry/summary` 的 health 字段（lastPressure/reclaimed24h/
   promote24h）+ journal 尾部无 error 级。
6. **存储交叉校验（可选，host-agnostic）**：`npx -y @cortexkit/magic-context@latest
   doctor store init` —— 上游 doctor 报 store 路径与 schema 版本，并拒绝比自身更新的库。
   它**没有 DSH lane**（上游宿主适配器只有 opencode/opencode2/pi/omp），但这一条与宿主
   无关，适合在改 fence 前后各跑一次做对照。本适配器的对应物是插件新家的
   `node scripts/dsh-doctor.mjs`（`npm run doctor`，只读）：输出 fence 余量裁决、
   事件车道心跳（挂载过却长期零 journal/usage 活动 = 事件接缝可能已静默失效，
   启发式只 WARN）、悬空 historian run、失败尾部与 embedding 车道状态，退出码 1
   表示有阻断问题（库比构建新 / 自有库 schema 不一致 / 库缺失）。

## 7. 本次工程阶段成果（2026-10-07）

- P1：水位可见性谓词、到期冻结 now（B2）、读事务快照（B3）、merge forced 行 cap 10（A1）。
- P2：应急回收 token 保护窗 + 工具分层（T3→T2→1）。
- P3：historian 分块 + merge + 预算伸缩（600s cap）、ctx_search 混合检索（FTS5+向量）、
  search 抑制已注入行、from/to/sources 参数、embedBackfill 默认关。
- 宿主半：preStep 管理 pass、工具结果 §N§ 打标（admission 打标 2026-10-08 撤销，见
  可行性文档 §7.4）、应急瀑布、journal+activity.log、/ctx-status、
  /mc-telemetry、胶囊面板（收起=压力%，面板=2 行指标+操作记录+节拍）与
  `session.append` 通知通道。
- 修复史（要点）：identity dir-hash 分隔符、facts 契约（string→{category,content}）、
  `promote is not a function`、hmr 竞态（stores closed 旗标 + fail-open tagging）、
  `exec is not defined`（闭包误绑）、historian 终局不变量、token-cap 8192 floor、
  trimSummary 白名单。
- 终验（收尾时）：21 文件/187 测试绿、tsc 0、acceptance 13 PASS/2 WARN/0 FAIL、
  audit exit 0、live 冒烟干净。

## 7.1 上游跟进实战记录（v0.45.0 → v0.46.0，2026-10-08）

首个用 `dsh-track.mjs` 走完的真实跟进（`--check` exit 3 → `--apply`）：

- **重放**：跨 217 个上游提交，51 个本地提交重放到位；`dsh-base` = `651c105a9`（v0.46.0）。
- **冲突**：唯一在 `.gitignore`，形态固定为"双方各自在文件末尾追加一行"（本地
  `desktop-runtime.json`、上游 `/scripts/ckmc-write-probe/migcheck/target`）→ 解决方式 =
  保留双方。`--apply` 的离线备份落在 `<tmp>/v0.46.0-pre-replay/`（51 个补丁）。
- **存储契约**：migration 95 = `migration-v95-perf-indexes.ts`，只新增 `temporal_decisions`、
  `git_commit_fts_rowid_map` 两表 + 覆盖索引，**无 `ALTER TABLE memories`** → fence 提到 95，
  29 列写契约不变。**门禁是有效 tripwire**：3 个 spec 把"fenced 版本"硬编码成 95，提 fence
  后立刻 FAIL，改 96 后 7/7 PASS；fence spec 另加"落后一个版本仍可写"用例。
- **对齐面复核（§4 逐行）**：

  | 对齐行 | 提交数 | 结论 |
  |---|---|---|
  | `inject-compartments.ts`、`storage-memory.ts`、`workspaces.ts`、`search.ts`、`emergency-drop.ts`、`agents/magic-context-prompt.ts` | 0 | 无需改 |
  | `ctx-reduce-nudge.ts`（reduce 五条阈值）、`agents/historian.ts`、`agents/permissions.ts`、`historian-host-runner.ts`（超时）、`compartment-runner-historian.ts` | 0 | 移植面未动 |
  | `transform.ts`(19) + `transform-postprocess-phase.ts`(36) + `rust-mode-transform.ts`(30) | 85 | OpenCode 专有（protected_tools、marker rides、served/cache-bust、writer-locked renders）→ DSH 无对应模型，不移植（对应 PARITY §B1/§B5） |
  | `compartment-prompt.ts` + `historian-prompt.generated.ts` | 1 | 校准改为 3-seed / "3 scored + 4 recent"；**不适用**：本移植 0 处 `compartment_examples_from_other_projects`/`session_references` |
  | `crates/mc-module/src/selection.rs` | 7 | 全部围绕**新的** `protected_tools`（按工具名保留）车道，含一次 introduce→revert→restore→restrict 循环 → 未移植，记入 PARITY §C；等上游稳定再评估 |
  | `dreamer` | 11 | 不移植（取舍见决策记录） |

- **交叉校验**：`doctor store init` 实测 exit 0、报 `schema v94` → 本机库仍 v94，等 MC 侧
  升到 v0.46.0 迁移后才变 95；届时 ceiling 95 正好接上（>95 才降级）。
- **结论**：本次升级对本适配器的**生效行为无影响**，改动只有 fence 95 + 文档锚点。

**下次复核的最短路径**：`dsh-track --check --fetch` → `git log --name-only v旧..v新 -- <§4 各行路径>`
取"文件 → 提交数"表 → 只 diff 计数 > 0 的文件。

## 8. 相关文档

- `docs/dsh-plugin-memory-write-contract.md` — 写契约（逐节 MC 依据）
- `docs/dsh-plugin-memory-promotion-contract.md` — 提升契约
- `docs/dsh-plugin-config-ui-contract.md` — 配置 UI 契约
- `docs/dsh-plugin-ui-telemetry-contract.md` — 遥测/胶囊契约
- `docs/dsh-plugin-project-memory-review-2026-10-06.md` — 项目级记忆复盘
- `docs/dsh-port-feasibility-2026-10-06.md` — 移植可行性（架构边界论证）
- `docs/dsh-plugin-memory-acceptance.md` — 验收记录
