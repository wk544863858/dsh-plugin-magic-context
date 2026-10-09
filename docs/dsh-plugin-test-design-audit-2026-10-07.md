# DSH 适配器：全局测试设计审计（2026-10-07）

> 触发事件：maintenance verify 扫描的 **6 个真实缺陷**全部逃过 222 个测试、24 个 spec，
> 直到在真实库上跑「40 条记忆提炼」才暴露。本审计回答的不是"哪条测试没写"，
> 而是"测试设计的哪几类盲区让整类缺陷系统性不可见"。
> 全部结论附现场测量（数字/文件:行），不含推测。

## 0. 结论先行

1. **套件本身不算少**：24 文件 / 222 测试 / 15 个仓库镜像，覆盖 core 写路径、m[1] 增量面、
   fence、historian 终态、检索计数、i18n 等，质量集中在"纯模块契约"层。
2. **6 个缺陷逃逸的共同点：它们都位于"装配与运行时"层，而套件几乎只测"纯模块契约"层。**
3. 最严重的三条结构性风险：
   - **G1 装配层零覆盖且无注入缝隙**：`src/index.ts` 的定时器、身份登记、事件钩子（preStep）
     没有任何测试，且 `setInterval` 直接写在 index.ts 里，测试无法驱动（无时钟/调度注入）。
     `index.ts` 共 1418 行，其中**只有**"装配层成立"的行为基本零断言（逐条清单见 §3 G1）。
   - **G2 唯一可执行的测试套件不在版本控制内**：套件住在
     `%TEMP%\dsh-src\deepseek-harness-master\packages\test-support\mc-dsh-poc\tests`
     （临时目录，可被系统清理），仓库里只有 15 个镜像，且其中 9 个 spec **完全没有副本**
     ——**包括全部真 E2E（poc/phase1/phase2）与唯一测 `Config` 的文件**。
     本次审计当场发现 1 个镜像已损坏（见 §3 G2），另 `packages/dsh-plugin/package.json`
     **没有 test 脚本、仓库内无 vitest 配置**，即"跑测试"这件事本身也无人把门。
   - **G3 测试替身不校验契约形状**：所有 LLM 替身都忽略入参，因此"参数形状错误"这一类
     缺陷在测试里恒不可见。**本次审计据此又实锤了第二个被掩盖的真实缺陷**（见 §2.5）。
4. 另外 4 类盲区：**可诊断性从未作为契约断言**（historian 有、未推广）、
   **无规模/边界/终态矩阵**（夹具都是 3~4 行）、**验收脚本无维护检查**（已补）、
   **客户端 1703 行零自动化测试**。

## 1. 套件构成（实测）

| 类型 | 数量 | 说明 |
|---|---|---|
| 纯 core 契约单测 | 15 spec | 直接驱动 `core/*` 与 `dsh/*` 模块，fixture 自建临时库 |
| 装配挂载型 | 8 spec | `import mcDshPlugin from index.ts`，挂进真 harness 跑回合（phase1/phase2/poc/config-schema/historian-terminal/journal/memory-gate-fence/memory-promotion/memory-tool-bridge） |
| 端到端 | 3 spec | phase1 / phase2 / poc（真 agent 循环 + mock adapter） |
| 仓库镜像 | 15 | 14 与 POC 逐字节相等（剥离头部后），1 处为文档允许的 rebase 导入（historian-terminal） |
| **仅存在于临时 checkout** | **9** | compartments / config-schema / memory-bridge / memory-retrieval-wiring / phase1 / phase2 / poc / probe / telemetry |

规模分布（行数 / 测试数）显示测试重心：`memory-delta` 1193/31、`memory-write` 1010/22、
`memory-tool-bridge` 721/14、`historian-terminal` 687/18；而 `maintenance` 曾只有 475/7 且
全部是"小 fixture 契约测试"。

## 2. 缺陷 ↔ 缺口映射（核心表）

| # | 缺陷 | 最接近的测试 | 为什么没抓住 |
|---|---|---|---|
| 1 | 维护身份只在 pass-execute 分支登记（安静会话 tick 空转） | 8 个挂载型 spec | 行为位于 `src/index.ts`，**无任何 spec 断言身份登记**；且定时器 60s/30min，秒级测试永不触发 |
| 2 | `content` 传字符串（应为 block 数组） | maintenance.spec 的 7 条 | `fakeLlm(): { stream() }` **不收参数、不看入参** —— 形状错误不可见 |
| 3 | 失败行只记 candidates，不记原因 | maintenance.spec 'fail-open' | 套件只断言 `ok:false`/计数，**没有任何 spec 要求"失败必须可诊断"** |
| 4 | mock 不校验调用形状（同上根因） | 全部 LLM 相关 spec | 所有替身均为宽松替身（§3 G3） |
| 5 | `listMemories(limit 64)` + 事后筛 unverified → 窗口外行永不可达 | maintenance.spec | 所有 fixture 都 <10 行；**无规模/边界测试**（需 >64 行才暴露） |
| 6 | `max-tokens` 终态把整轮当失败丢弃 | historian-terminal 有 max-tokens 覆盖，maintenance 无 | 终态矩阵不完整；且"推理 token 计入输出预算导致零文本"没有任何 fixture 形态 |

## 3. 结构性缺口（按"能防住的缺陷类别"排序）

### 2.5 审计过程中实锤并修复的第二个隐藏缺陷（同属 G3）

`spanRequestMessages`（`src/dsh/seams.ts:373-389`）**只读 `event.data?.message`**，
而真实的 `user/message` 事件把消息本身作为 event data：
`packages/core/session/src/types.ts:309` 定义 `'user/message': UserMessage`，
`packages/core/session/src/surface.ts:132-145` 的 `deriveEventMessage` 对
`user/message` 返回 `event.data`（只有 system/developer/assistant/tool 返回 `data.message`）。

- **后果**：historian 回放的 prefix **丢掉全部 user 轮次**——它不再是"最后一条已路由请求的前缀"，
  函数注释宣称保护的 KV 缓存复用失效，digest 也看不到用户的问题。同文件的 `contentOf`
  （seams.ts:322-325）早已按两种形状处理，`spanRequestMessages` 漏了。
- **掩盖机制（教科书级）**：`historian-terminal.spec.ts` 的 `SESSION_STUB` 给 user 事件
  伪造了 `data.message`——**真实 session 从不产生的形状**；`historian-chunking.spec.ts`
  的 stub 更彻底（`snapshotEvents: () => []`），回放路径根本没被触碰；
  `phase2.spec.ts` 只断言 historian 请求含指令文本，不断言角色序列。
- **已修复**（`2b51a6a16`）：新增 `messageOf()` 精确对齐 `deriveEventMessage`；
  两个 stub 改为真实形状（chunking 的 stub 现在真的产出事件）；
  新增回归断言回放角色序列 `['user', 'assistant']`；`scriptedLlm` 改为强制
  block 数组（此前字符串会静默退化成 `''`）。其余 `data.message` 读取点已逐一核对，
  均有 `tool/result` 或 `assistant/message` 守卫。
- **教训**：替身不仅"宽松"，还会**主动造出不存在的形状**——虚构的输入比缺失的校验更危险，
  因为它让错误实现"看起来正确"。

### G1 装配层与运行时零覆盖（能防住 #1 类）
- 24 个 spec 中只有 `telemetry.spec.ts` 从 `index.ts` 导入（且只取 `openStores`）。
- 8 个 spec 挂载了插件，因此**启动路径**有覆盖；但 `setInterval`/`setTimeout` 调度、
  身份登记、`seenIdentities` 生命周期没有断言，套件里出现的 `setTimeout` 全是测试轮询助手
  （phase2:147、telemetry:126、memory-promotion:221），**不是**对插件调度的覆盖。
- index.ts 把周期与身份登记硬编码在装配函数内，测试**没有注入缝隙**（无 `now`/`timer` 注入）。
- `index.ts`（1418 行）逐条核对：**只在装配层成立的行为基本零断言**——
  `enabled:false` 提前返回（:218-221）、seam probe 失败即抛（:222-229）、
  `resolveSharedSpace` 余弦一致性闸门（:339-363）、`memorySearchForTool` 闭包（:370-413）、
  preStep 的 reduceTracker/漂移/**身份登记**（:469-521）、preStep catch fail-open（:753-760）、
  **reduce guidance 的 SystemPrompt 注册**（:782-839）、
  **requestError 紧急回收钩子**（:860-896，测试改为直接调用函数）、
  `registerTools:false` 与 local-builder 分支（:898-1000）、`/ctx-status` 注册（:1001-1004）、
  **compaction engine 挂载/opt-out**（:1006-1045）、
  **telemetry `ctx.inject(['webServer'])`**（:1064-1116）、
  **维护定时器与身份登记**（:1118-1172）、
  `sessionProjections`/`contextPressure` 监听（:1181-1215）、`liveString` 嵌套 unwrap（:1348-1380）、
  `maintenance` 配置块（:1298-1345）。
  有覆盖的只有：preStep **打标**（poc）、压力决策/管理 pass（phase1/phase2，且都刻意压低阈值以进入 execute band）、
  postToolExecute 打标（poc）、usage 记录（poc/journal）、工具注册存在性（gate）、`policyOf`。
- 附带质量问题：`memory-tool-bridge.spec.ts` 有 **5 条空标题测试**（`it('', …)`，行 622/647/664/684/704），
  失败时无法辨识；`VERIFY_MAX_TOKENS`（当前 32768）没有任何断言，历次调整（2048→8192→32768）都无测试。

### G2 套件不在版本控制内 + 镜像无自动检查（能防住"测试资产丢失/漂移"）
- 可执行套件位于临时 checkout（`%TEMP%`），仓库无 `test-support` 目录，`dsh-plugin/package.json`
  无 vitest 依赖、**无 `test` 脚本**、仓库内无 `vitest.config.*` → 仓库自身**不能跑测试**，
  只能依赖该临时目录存活；`.github/workflows` 里也没有跑 mc-dsh-poc 的作业。
- 仓库镜像 15 个，其中 **9 个 spec 无任何副本**（正是 e2e/wiring 类：phase1/phase2/poc/telemetry/…）。
- **无镜像一致性检查脚本**（`scripts/` 只有 copy-client / mc-acceptance / mc-i18n-check /
  mc-memory-audit / mc-records-check / mc-report）。
- 本次实测漂移（剥离前导注释后逐行比对）：
  - `src/core/memory-write.spec.ts` 镜像**丢失整个 21 行 import 块**（`@ts-nocheck` 使其静默通过）
    ——已修复；
  - `src/dsh/historian-terminal.spec.ts` 唯一差异是文档允许的 mock-adapter 绝对路径 rebase。

### G3 测试替身契约保真（能防住 #2/#4 类，并已实锤第二个隐藏缺陷）
- LLM 替身（maintenance / historian 系列）均不接收参数：真实 seam 要求
  `messages[].content` 是 block 数组（宿主内部调 `content.some`），替身无法发现字符串。
- 结果：一类"接口形状"缺陷在 222 个测试里恒不可见，只有在 live 宿主上才炸。
- 代表替身（按保真度）：
  | 替身 | 位置 | 保真度 | 后果 |
  |---|---|---|---|
  | `fakeLlm`（maintenance） | maintenance.spec.ts:220-232 | **严格**（`Array.isArray(content) && typeof content.some === 'function'`） | 本次已修，可作范本 |
  | `scriptedLlm` / `cappedAnswer` / `hangingLlm`（historian） | historian-terminal.spec.ts:137-185 | 宽松（只读 `maxTokens`/`signal`） | content 形状不可见（已加固 chunking 的那份） |
  | `SESSION_STUB`（historian-terminal） | historian-terminal.spec.ts:99-104 | **形状错误**（伪造 `data.message`） | 掩盖了 §2.5 的真实缺陷（已修） |
  | `SESSION_STUB`（historian-chunking） | historian-chunking.spec.ts:62-64 | 空洞（`snapshotEvents: () => []`） | 回放路径零覆盖（已修） |
  | `MockAdapter`（宿主） | packages/core/agent-loop/tests/mock-adapter.ts:72-139 | 录制器非校验器 | 全部集成 spec 的请求形状无人校验 |
  | `fakeSession.append`（emergency-drop） | emergency-drop.spec.ts:52-86 | 宽松（丢弃 type 与 options） | 错 surfaceOp / 错 type 不可见 |
  | `session.append` 假件（session-notice） | session-notice.spec.ts:77-80 | **严格**（逐字段断言 type/options/data/source/content） | 输出契约范本 |
  | `writer:{recordRetrieval}`（memory-search） | memory-search.spec.ts:472 | 宽松（忽略 `identity` 必填项） | 必填参数缺失不可见 |
  | 纯真实模块（compartments / reduce-guidance / project-drift / journal） | — | 高保真（真跑 git / 真 openJournal / 真 agent loop） | 无 |

### G4 可诊断性未作为契约（能防住 #3 类）
- historian 侧有完整先例：`historian-terminal.spec.ts:260-261,282-283,303,392,667` 断言
  `failed.data.reason` / `errorName` ——这是历史上"historian 静默失败"缺陷的产物。
- 该教训**没有推广**到同样调用 LLM 的 maintenance：后者失败行没有 `why`，
  6 次 tick 全灭而无从定位（已补断言，见 §5）。

### G5 规模 / 边界 / 终态矩阵缺失（能防住 #5/#6 类）
- 夹具重复且已静默漂移：**10 个 spec 各自内联 `CREATE TABLE memories`**（共 11 份），
  其中 `memory-bridge` / `memory-delta` / `phase2` 的 DDL **完全没有 `mural_cue` 列**
  ——它们测的是与生产 v94 不同的 schema。
- 无共享夹具文件（tests 目录下除 `*.spec.ts` 无其他文件），无批量/窗口/上限边界测试。
- 终态矩阵不完整：`stop` 与 `throw` 覆盖充分，`max-tokens` 只覆盖 historian 一处；
  `error`/`aborted` 的**零文本**形态无 fixture。

### G6 live 验收盲区（已修）
- `mc-acceptance.mjs` 原有 15 项检查：schema/boot/recall/delta×3/historian×3/fence×2/
  promotion×2/retrieval/epoch/authority —— **没有一项看维护扫描**。
  即：单元测试与 live 验收双双不看这条路径，缺陷无处可抓。

### G7 客户端零自动化测试
- `src/client/index.js` 1703 行，**没有任何 spec 触及**（`check:i18n` 只按文本读取）。
  UI 回归（胶囊消失、台账布局、hover 名称）全靠人工截图验证——成本高且不可回归。

## 4. 建议（按性价比排序）

**P0**
1. **套件入库**：把 24 个 spec 收进 `packages/dsh-plugin/tests/`（canonical），
   新增 `scripts/sync-specs.mjs`（含 historian-terminal 的 rebase 规则）写入 DSH checkout 运行，
   并把「checkout 副本 == 仓库副本」做成 `npm run check:specs`（替代靠记忆维持的镜像约定）。
2. **装配层可测化**：把调度与身份登记抽成可注入单元（`now`/`timer` 注入），
   加一条"安静会话（不跨压缩阈值）也会登记身份，tick 有身份可维护"的测试。

**P1**
3. **共享严格替身**：`tests/support/llm-fake.ts` —— 强制 block 数组、必填参数、
   可编排终态（stop/error/aborted/max-tokens；带文本/零文本），供 historian 与 maintenance 共用。
   具体迁移目标（本次审计逐一定位）：`historian-terminal.spec.ts:117/137/163/174`、
   `historian-chunking.spec.ts:76`（已加固）、`MockAdapter` 的调用方；
   并**收窄 seam 类型**（`historian.ts:40`、`maintenance.ts:31` 的 `messages` 改为
   `readonly { role: string; content: readonly { type: 'text'; text: string }[] }[]`），
   删掉 `index.ts:1147` 的 `llm as unknown as MaintenanceLlm` 双重断言——正是这类 cast 放过了字符串。
4. **可诊断性升级为跨模块契约**：凡 `journal.warn/error` 的失败行必须携带 `why`/`reason`
   （可用一条通用断言辅助 + 在 acceptance 里对"最近的失败行"设门，已落地 maintenance 部分；
   待补：`compaction-engine.spec.ts:139-140`、`memory-delta.spec.ts:384/596` 只验"无 warning/有 warning"，
   未验失败文本）。
5. **共享 DB 夹具**：单一 `makeMemoryDb()` 生成 v94 DDL（含 mural_cue 全套），
   消除 10 份内联 DDL 的漂移；顺带覆盖 schema 演进（列缺失应让测试明确失败而不是静默降级）。
6. **替身形状错误一律按缺陷处理**：`SESSION_STUB` 那类"发明不存在的字段"的替身要成对加断言
   （回放角色序列一类），否则修正了实现也没有守卫。
   同类待修：`emergency-drop.spec.ts:52-86` 的 `fakeSession.append`（丢弃 type/options、
   surface 与 replaceGeneration 冻结）、`memory-search.spec.ts:472` 的 `writer` 假件（忽略必填 `identity`）、
   `memory-retrieval-wiring` / `memory-tool-bridge` 的 `recall` 假件（返回形状自定，未 import 真实类型）。

**P2**
7. 客户端最小测试：把 `recordOf/recordsOf/noiseLine/sessionNoticeSummary` 等纯函数在 node 下直测
   （已有 `__diagnostics` 入口可利用），i18n 词表补 key 覆盖断言。
8. 验收继续扩展：把"维护扫描有入账"做成时间窗内的趋势判据（当前为窗口内 ≥1 次入账）；
   `telemetry.spec.ts:41-69` 的 `fakeResponse.on()` 接上 close 事件，补 `openStreams === 0` 断言。
9. 清理：`memory-tool-bridge.spec.ts` 的 5 条空标题测试命名；`emergency-drop.spec.ts:40` 的死替身；
   host 侧未使用的 `maxTokensResponse`（mock-adapter.ts:20-28）。

## 5. 本次已落地（commit）

| 提交 | 内容 |
|---|---|
| `2b51a6a16` | **§2.5 的真实缺陷修复**：`messageOf()` 对齐 `deriveEventMessage`（user 轮次不再从 historian 回放中丢失）；两个 SESSION_STUB 改真实形状；新增回放角色序列回归；`scriptedLlm` 强制 block 数组 |
| `1945a6cf3` | acceptance 新增 `maintenance.ran` / `maintenance.diagnosable` / `maintenance.progress`（15 PASS/1 WARN/0 FAIL）；修正 `promotion.contract` 的生命周期期望（unverified→verified 是设计内）；maintenance.spec 增加"失败行必须带 why/route"断言；修复 `memory-write.spec.ts` 镜像丢失的 import 块 |
| `dde546c02` | 未验证筛选下推 SQL（+70 行窗口回归测试）；`max-tokens` 截断抢救（花括号扫描器） |
| `71418b6e3` | 身份登记移入 preStep；LLM 调用改 block 数组；失败遥测带 why/route；`fakeLlm` 强制 block 数组 |

测试数 218 → **223**（+截断抢救、+70 行窗口、+诊断性断言、+镜像 baseline 用例、+historian 回放角色序列）。

## 6. 方法、证据与局限

- 三个独立视角：Lead 现场测量（套件规模/装配覆盖率/镜像逐字节比对/DDL 重复计数/诊断性断言检索）+
  两个只读子代理（① 24 个 spec 分类与 `index.ts` 行为逐条覆盖核对；② 全部测试替身逐一定位与保真度评级）。
- 镜像漂移比对脚本：剥离前导注释后从首个 `import` 起逐行比较（historian-terminal 的
  mock-adapter rebase 为文档化例外），结果 `equal=14 drift=1 no-mirror=9`。
- 局限：子代理未逐字读完大段断言体（memory-write 断言区、memory-search:530-609、
  memory-tool-bridge:260-410/490-590/690-721、memory-delta:90-870/1000-1193、memory-bridge、
  memory-gate-fence:120-330/450-587），其中可能仍有内联字面量替身；`index.ts` 覆盖表的结论来自
  grep 断言（0 处出现 `setInterval`/`useFakeTimers`/`seenIdentities`/`webServer`/`ctx-status`/`requestError`），
  非运行期覆盖率工具测量——建议后续接入 vitest coverage 做一次量化基线。

