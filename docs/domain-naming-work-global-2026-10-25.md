# 域命名决定：machine=全局域 / org=工作域（2026-10-25）

## 背景

评估了"org 与 machine 合并为一个全局域、层级简化为 项目+全局 两级"的提议。
结论是**不合并**：域轴回答的是"何时可见"（受众），不是"分布到哪"。线上实测，
`dir:global:org` 是手工圈定的**工作项目受众**（5 个成员仓库、17 条有效行——
内网基础设施拓扑、部署次序、端口表），`dir:global:machine` 是**全机受众**
（自动同步 23 个项目、3 条本机工具链事实）。合并会把内网拓扑注入每个
个人/开源项目的会话基线（泄露面 + token 噪声），并消灭这套系统里唯一的
记忆可见性隐私边界。

正确的三层心智模型（现状机制的正确读法，非新设计）：

| 层 | 实现 | 受众 |
| --- | --- | --- |
| project | 项目记忆（默认） | 所属项目 |
| work（工作域） | `dir:global:org`，成员手工维护（`/ctx-global add/remove`） | 圈定的工作项目 |
| global（全局域） | `dir:global:machine`，成员自动同步（可 excludeProjects） | 本机全部项目 |
| （画像，正交） | `user` 域 | 所有会话，无激活规则 |

机制不限于两个受众域：`/ctx-global create <id> --kind org|machine` 可建任意多个。

## 决定

只改**展示层命名**，内部 token 一律不动（存储键零迁移）：

- 人面文案：`机器域`→`全局域`、`组织域`→`工作域`
  （`global-review.ts` 的 `domainLabel` 与改判选项 `OPTION_REROUTE_*`）。
- LLM 分类器受众描述（`global-autostage.ts` `CLASSIFY_INSTRUCTION`）：
  machine 描述为 GLOBAL（本机所有项目可见）、org 描述为 WORK（仅成员工作
  项目可见）；**输出 token 保持 `machine|org|project`**，`suggested_domain`
  列与解析逻辑不变。
- `ctx_memory` 工具描述（`tool-bridge.ts`）：promote 的 `domain machine|org`
  参数值不变，补全局/工作受众说明。
- `/ctx-global domains` 列表行显示 `[kind·中文标签]`；`--kind` 报错与
  `detect` 提示随新措辞。

## 明确不改的（存储键/兼容面）

`'org'`/`'machine'` kind 值、`dir:global:org`/`dir:global:machine` 域身份、
domains 表 CHECK 约束、`global_candidates.suggested_domain`、promote 的
domain 参数取值、classifier 的 JSON 输出词表、既有 journal 行与候选历史。

## 验证

`vitest run` 全量（762+ 用例）+ `tsc --noEmit`；UI 断言
（`global-review.spec.ts` 的卡片文案）随新命名同步更新。
