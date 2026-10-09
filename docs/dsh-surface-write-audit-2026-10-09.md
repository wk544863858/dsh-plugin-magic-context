# DSH surface 写入点顺序安全审计（2026-10-09）

> 触发背景：`protected first surface head` 损坏事故（两波共 10 个会话）与随后的
> `replacement range is not on the current surface` 复发事件。事后复盘发现，两起事故的
> 碰撞记录**都是本插件写出的 surface 记录**，而此前没有任何一处写入点有显式的顺序安全论证。
> 本文把全部写入点逐一列出并给出论证，同时给出加固与外部前提。

## 1. 不变量（宿主侧事实，已对 app.asar 内的 agent-loop 逐行核实）

1. **保护头**：一个会话的第一个 `system/message` 必须是 surface 的**首节点**（surface node 0）。
   宿主的 loader 重放时用 `foldSurface` 校验；违反则该日志在**每一次重放**时被整份拒绝
   （`SessionFormatError: system/message requires a protected first surface head`）。
2. **宿主写入顺序**（`@deepseek-ai/dsh-agent-loop` `lib/index.js`）：
   ```
   turn():      session.append('turn/start')
                └─ 每个 step: preStep()  ── waterfall('agent/pre-step')   ← 插件在此运行
                             session.append('step/start')
                             step():  system commits（system/message）
                                      for (const message of decision.messages)
                                        session.append('user/message', message)   ← 宿主批量原样落盘
                                      buildRequest()  ← 请求在此成形
   ```
   结论：**waterfall 内直接 append 的记录会落在 `step/start`/`system/message` 之前**（新会话首轮即为 node 0）；
   而塞进 `decision.messages` 的记录由宿主在 system commits 之后落盘，顺序天然正确。
3. **两种写入形态，两种义务**：
   - **append 型**（`surfaceOp: 'append'`）：必须自行证明"头已落盘"，否则可能成为 node 0。
   - **replace 型**（`surfaceOp: { op: 'replace', … }`）：**构造上安全**——替换需要已存在的目标节点，
     无头 surface 上不存在目标，因此调用点根本不会被触达。

## 2. 写入点总表

| # | 写入 | 载体/op | 触发带 | 目标来源 | 无头首轮安全 | 顺序安全 |
|---|---|---|---|---|---|---|
| W1 | auto-search hint | 宿主批次 `decision.messages`（宿主 append） | pre-step waterfall → 宿主批次 | 无 seq | ✅ 结构性（宿主先写头） | ✅ 宿主排序内（0.4.2 起） |
| W2 | 会话通知 notice | `appendMagicContextEntry`，append | pre-step execute band（pre-step.ts:474） | 无 seq | ⚠️ 原本仅靠推理（见 §3），**已加守卫** | ✅ 头存在后尾部 append 合法 |
| W3 | baseline 刷新 | `replaceSurfaceRange`，replace | execute band（management-pass.ts:520） | live surface `nodes.find(user && sourceKind!=='compact-checkpoint')`（:506），无目标即 return false | ✅ 构造 | ✅ |
| W4 | compartment 发布 | `replaceSurfaceRange`，replace | execute band（management-pass.ts:315） | `enumerateSurfaceNodes`（:220）减 covered（:274） | ✅ 构造 | ✅ |
| W5 | compaction checkpoint | `replaceSurfaceRange`，replace | 宿主压缩引擎入口（compaction-engine.ts:174） | 调用方传入的 `input.nodes[0/last]` | ✅ 构造（空列表会在带内抛错） | ✅ |
| W6 | wire repair | `replaceSurfaceRange`，replace | execute band（management-pass.ts:583） | surface 缺陷枚举（:633） | ✅ 构造 | ✅ |
| W7 | drop 落盘 | `replaceToolResultContent`，replace | execute band（management-pass.ts:642） | `enumerateSurfaceToolResults` + tag store | ✅ 构造 | ✅ |
| W7b | （同形的遗留导出） | `replaceToolResultWithPlaceholder`，replace | 无生产调用方（仅 `tests/poc.spec.ts` 与 index.ts re-export） | 调用方传入的 `targetSeq` | ✅ 构造（目标须是已存在的 `tool/result` 节点，否则抛错） | ✅ |
| W8 | 应急 drop | `replaceToolResultContent`，replace | request-error 带（index.ts:338）/ execute band（management-pass.ts:673） | surface tool 节点（emergency.ts:78） | ✅ 构造 | ✅ |
| L1 | compaction/start·summary·end | 裸 append，**无 surfaceOp** | 宿主压缩引擎入口 | — | n/a（非 surface 事件） | 不进 fold，无关 |

## 3. W2 为什么原本只是"推理安全"

notice 由 execute band 触发，而 band 的开启条件是 `decidePass`：

```
wireDefects > 0                              → execute('wire-repair')     ← 注意：在 no-usage 之前
latest === undefined                         → defer('no-usage')
pressure === undefined                       → defer('no-window')
pressure >= executeThreshold                 → execute
```

无头 surface ⇒ 无 surface 节点 ⇒ `wireStrandedResults` 为 0、无 usage、无 pressure ⇒ 只可能 defer。
这条链今天成立，但它依赖 `decidePass` 的分支顺序与枚举实现——**任何一处未来变动都会让 append 重新暴露成 node 0**。
因此加固为写入口的显式前提，而不是调用方论证：

```ts
// session-notice.ts
if (session.surface !== undefined && session.surface.nodes.length === 0) {
  return { ok: false, reason: 'headless-surface' }
}
```

- 表面非空（常态）：行为不变；
- 表面为空：拒绝写入，`appendSessionNotice` 透传 `headless-surface`，pre-step 记一条 warn
  （它意味着 execute band 在无头 surface 上开了——按 §3 本不该发生，属异常信号）；
- 宿主漂移导致读不到 `surface`：退化为原行为（不引入新失败面）。

## 4. 外部前提（代码无法自证，写入纪律）

replace 型写入的 seq 引用**全部取自 `session.snapshotEvents()` 的 live surface**（seams.ts:137/180/210…），
即写入端与自己的运行视图是自洽的。真正的风险只有一个：

> **带外改写日志文件**（例如用工具修完文件、而进程仍按旧内存 surface 继续 append）。
> fe45e26b 的坏记录 #214 正是如此：进程写出 range=7 的替换，而文件里该节点已被重编号为 9。

因此两条禁令（已进 `PROJECT_RULES` #1296 与巡检 prompt 第 0 项）：
1. 修复只能对**已关闭**的会话做；修完必须由新进程重新加载后再继续 append。
2. 只修 loader 致命项；真 loader 判 ok 的日志一律不改写。

## 5. 已知 advisory（不改写）

`verify-all.cjs` 报告 7 个会话存在 `user/message sources omit <seqs>`：被替换区间内的宿主注入节点
（runtime-context / skill-catalog / time-context 三连组）未被 `sourceEventSeqs` 全覆盖。
**真 loader 放行**，属本插件自审比宿主严格；不得据此改写。

## 6. 如何复跑这份审计

```powershell
# 列出全部 surface 写入点
rg -n "\.append\(|surfaceOp|replaceSurfaceRange|replaceToolResultContent|appendMagicContextEntry" src
# 权威完整性判据（真宿主 worker）
node <tmp>/verify-all.cjs      # 判据：loader failures > 0 才详查；advisory 只记录
```

新增任何写入点时，必须在本表登记并回答三个问题：**哪个带触发 / 是否 append 型 / 目标是 live surface 还是持久态**。

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-09 | W1 从 waterfall 内直接 append 改为宿主批次载体（0.4.2，`1beea223c`），无头守卫随之退役 |
| 2026-10-09 | W2 增加 headless-surface 写入前提守卫 + 异常 journal warn（0.4.3） |
| 2026-10-09 | 本文建立；W3–W8 论证为"构造上安全"；§4 外部前提写入纪律 |
