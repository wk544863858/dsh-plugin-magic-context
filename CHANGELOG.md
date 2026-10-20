# 更新日志 / Changelog

本文件记录本仓库面向公众的版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

这是一个 **DeepSeek Harness（DSH）适配器**仓库，不是 magic-context 本体：它把
[magic-context](https://github.com/cortexkit/magic-context)（MIT，Copyright (c) 2025 Ufuk Altinok）
的上下文管理与记忆能力移植到 DSH 的插件 / surface 体系上。代码出处、被 vendored 的第三方文件与
钉住的上游 revision 见 [NOTICE](NOTICE)；上游自身的变更历史请见上游仓库。

## [Unreleased]

## [0.9.0] - 2026-10-20

**首个公开发布。** 这是本适配器第一次以独立开源仓库的形式发布：此前它作为 magic-context 仓库的
`packages/dsh-plugin` 存在，于 2026-10-08 抽出为独立仓库。本条目只描述公开发布时仓库里已有的能力，
不追溯更早的仓库内部历史。

### Added

- 以 DSH bundle 形态安装的 Magic Context 插件，包含：
  - 可逆上下文回收：工具结果打 `§N§` 标签，`ctx_reduce` 只入队、在 execute 带内落地为
    `[dropped §N§]`，`ctx_expand` 恢复原文；
  - 压力调度：持久 usage → 压力评估 → execute / defer 决策，含 `CONTEXT_WINDOW_EXCEEDED` 紧急回收；
  - historian 带外摘要：一次性 LLM 调用重放真前缀，产出四层摘要与 facts / events，只写 store
    不动线缆，execute 带内发布为 `[compacted §C<n>§]`；
  - `m[0]`/`m[1]` 记忆基线：冻结基线 + 增量车道（`<new-memories>` / `<memory-updates>` /
    `<user-profile>`），内容未变则零变更；
  - 插件自有项目记忆库（`memories.db`，基于内建 `node:sqlite`），含 `ctx_memory` 检索与读写维护；
  - 本地向量检索车道：`vendor/` 内的 onnxruntime-web WASM 后端 + 钉死 revision / sha256 的
    MiniLM 下载，失败 fail-open 降级 FTS；
  - 机器 / 组织全局域与用户画像：入队可自动化，发布永远经人审批；
  - 30 分钟维护 tick（TTL 归档、LLM verify、向量回填、全域候选入队）；
  - 可接管的 `ctx.compaction` 压缩接缝（首装默认 `registerCompactionEngine: false`）；
  - GUI 集成：插件页设置卡片、`shell.overlay` 遥测徽标与胶囊面板、`session-notice` 会话流提示。
- 界面文案中英双语，`npm run check:i18n` 校验两侧字典一致。
- 公开的本地闸门：`npm run typecheck`、`npm test`、`npm run build`、`npm run check:i18n`，
  以及一次跑完的 `npm run gate`。
- 开源仓库配套文档：`README.md`、`docs/`、`CONTRIBUTING.md`、`SECURITY.md`、
  `CODE_OF_CONDUCT.md`、`NOTICE`、本 CHANGELOG，以及 GitHub issue / PR 模板与 CI 工作流。

### Notes

- 上游基线 **magic-context v0.46.0**（commit `651c105a9`，MIT）；本仓库新增部分 © 2026 wukai，
  整体以 MIT 发布，见 [LICENSE](LICENSE)。
- 运行环境：Node.js **>= 22.19**（依赖内建 `node:sqlite`，不引入原生模块）。已在 DSH
  **0.2.1-rc.1** 上用 Node 24.15 验证；CI 覆盖 Node 22.x 与 24.x。
- 插件数据目录沿用上游命名空间（`~/.local/share/cortexkit/magic-context-dsh-poc/`）以保持出处
  连续，自 2026-10-13 起与上游 MC 数据库分家，插件自有 `memories.db` 无共享兼容义务。

[Unreleased]: https://github.com/wk544863858/dsh-plugin-magic-context/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/wk544863858/dsh-plugin-magic-context/releases/tag/v0.9.0
