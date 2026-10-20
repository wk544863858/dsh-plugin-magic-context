# 贡献指南

感谢你愿意为 **dsh-plugin-magic-context**（Magic Context 的 DeepSeek Harness 适配插件）做贡献。
本文件说明环境准备、常用命令、代码约定和 PR 流程。

- 语言约定：仓库文档（README、`docs/`）用中文；代码注释、测试名、变量名用英文。
- 提交信息：Conventional Commits，type 用英文，subject 用中文。
- 沟通渠道：只用 **GitHub Issues**（缺陷 / 功能建议模板）。安全问题走 [SECURITY.md](SECURITY.md)，
  不要在公开 issue 里贴敏感信息。

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | **>= 22.19**（依赖内建的 `node:sqlite`，无原生模块；CI 覆盖 22.x 与 24.x） |
| 包管理器 | **npm**（`package-lock.json` 是唯一权威锁文件） |
| 操作系统 | Windows / macOS / Linux 均可；仓库用 `.gitattributes` 统一为 LF（`.bat` 为 CRLF） |
| DSH | 宿主为 DeepSeek Harness 0.2.x；`@deepseek-ai/*` 以精确版本钉在 `devDependencies` |

## 准备

```bash
git clone https://github.com/wk544863858/dsh-plugin-magic-context.git
cd dsh-plugin-magic-context
npm install
```

- 用 `npm install`，不要用 pnpm / yarn 重新生成锁文件；`pnpm-lock.yaml` 只服务于宿主 profile
  安装场景，不要在普通 PR 里改动它。
- 不要在仓库里提交 `node_modules/`、`lib/`、`dist/`、`.tmp-*/`、`models/`（见 `.gitignore`）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run typecheck` | `tsc --noEmit`，最便宜的一步，先跑它 |
| `npm test` | `vitest run`，当前 73 个 spec 文件 / 761 个用例 |
| `npm run test:watch` | vitest watch 模式，开发时用 |
| `npm run build` | `tsc -p tsconfig.build.json` + `scripts/copy-client.mjs`，产出 `lib/` |
| `npm run check:i18n` | 校验宿主 notice 文案与客户端中英文字典一致 |
| `npm run gate` | 完整本地闸门：typecheck + suite + build + acceptance + 记忆审计 + records |

提交 PR 前至少要跑 `npm run gate`（或等价的四步：`typecheck`、`test`、`build`、`check:i18n`）。
CI 在 `ubuntu-latest` 上跑 Node 22.x / 24.x 两档，步骤与上表一致。

## 代码约定

1. **只有 `src/dsh/` 可以 import `@deepseek-ai/*`。** `src/core/` 保持宿主中立——它是升级隔离
   契约：DSH 迭代时只改 `src/dsh/`，核心逻辑通过中立词汇（`NeutralMessageId`、`NeutralCallId`
   等）与适配层通信。见 `src/core/types.ts` 的文件头注释。
2. **测试是契约探针，不是覆盖率填充。** spec 的名字和结构应当表达一条行为契约（"在什么前提下，
   什么必须成立"）。改行为时先改/加探针，再改实现。
3. **测试替身必须镜像真实形状。** fake 的返回值和事件形状要与宿主 / 上游真实对象一致
   （`tests/helpers/mock-adapter.ts` 逐字来自 DSH，`llm-fake.ts`、`memory-db.ts` 同此原则）；
   简化到"能跑通"的 fake 会让测试通过而线上失败。
4. **中文文档，英文代码。** 新增用户可见文案要同时进 zh / en 两个字典，并让 `npm run check:i18n`
   通过。
5. **不引入原生模块。** 存储用内建 `node:sqlite`；向量车道用 `vendor/` 里的 WASM 后端。
6. **保持 diff 聚焦。** 不要顺手格式化无关文件或做大范围重命名；需要时可以单独开 PR。

## 提交信息（Conventional Commits）

```
feat(historian): 支持按会话路线切换 verify 模式
fix(memory): 修正维护 tick 在空语料库上的崩溃
docs: 补全配置界面契约
refactor(core): 抽出域解析的共同路径
test(telemetry): 覆盖回环路由的来源校验
chore(deps): 升级 vitest
```

- type 用 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`；scope 可选。
- subject 用中文，祈使句、不加句号；正文说明"为什么"，不是"改了什么"（diff 已经说明）。
- 破坏性变更用 `!` 并在正文写 `BREAKING CHANGE:`。

## 安全与隐私

- **不要在提交里放密钥或个人数据**：API key、token、cookie、私人会话正文、真实记忆库导出、
  以及本机的绝对路径（用户主目录下的完整路径、盘符路径等）都不行。测试数据用合成值。
- journal / 日志样例必须脱敏后再贴进 issue 或测试 fixture。
- 发现漏洞不要开公开 issue，走 [SECURITY.md](SECURITY.md) 的私密报告通道。

## PR 流程

1. Fork 仓库并从 `main` 切分支（分支名说明意图，例如 `feat/historian-verify-mode`）。
2. 改动 + 测试：先跑 `npm run typecheck` 和 `npm test`，最后跑一次 `npm run gate`。
3. 按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 填写：摘要、变更内容、测试方式、检查清单。
4. 关联相关 issue（`Fixes #123`），保持一个 PR 只做一件事；CI 全绿后再请求评审。
5. 评审意见用追加提交处理，不要强推改写别人已经看过的历史（维护者会 squash）。

**DCO 不要求**（不需要 `Signed-off-by` 行）；**签名提交（GPG / SSH signed commits）欢迎**，
但不是合并前提。

---

# Contributing (English)

Short version — the Chinese section above is authoritative.

- **Prerequisites**: Node.js >= 22.19 (built-in `node:sqlite`; no native modules), **npm**
  (`package-lock.json` is canonical), DSH 0.2.x.
- **Setup**: `git clone … && npm install`. Do not regenerate the lockfile with pnpm/yarn.
- **Commands**: `npm run typecheck`, `npm test` (vitest, 73 specs / 761 tests),
  `npm run build`, `npm run check:i18n`, and `npm run gate` for the full local gate.
  Run `gate` (or at least typecheck + test + build + check:i18n) before opening a PR.
- **Conventions**:
  - Only `src/dsh/` may import `@deepseek-ai/*`; `src/core/` stays host-neutral.
  - Tests are **contract probes**: a spec states the behavior contract, and fakes must mirror
    the real host/upstream shapes (see `tests/helpers/mock-adapter.ts`).
  - Repository docs are Chinese; code comments, test names and identifiers are English.
  - Conventional Commits, English type + Chinese subject; keep diffs focused.
- **PRs**: branch from `main`, fill the PR template, link the issue, keep CI green.
  DCO is not required; signed commits are welcome but not required.
- **No secrets or personal data in commits** (keys, tokens, cookies, private conversation text,
  real memory DBs, absolute local paths). Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
- **Contact**: GitHub Issues only (bug / feature templates). No email, Discord or Slack channel.
