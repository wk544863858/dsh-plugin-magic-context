# 安全策略 / Security Policy

本插件运行在用户自己的 DSH Desktop 里，直接接触会话 journal、项目记忆库和本机回环 HTTP 路由。
我们重视这些问题，也欢迎私下报告。

## 支持的版本 / Supported versions

| 版本 | 是否支持安全修复 |
|---|---|
| `0.9.x`（当前公开发行线） | ✅ |
| `< 0.9`（公开发布前的内部构建） | ❌ |

只有最新公开发行版本会收到安全修复。报告时请写明插件版本、DSH 版本、Node.js 版本和操作系统。

## 报告漏洞 / Reporting a vulnerability

**请不要开公开 issue，也不要在 PR / Discussion 里贴细节。**

请通过 GitHub 的私密漏洞报告通道提交：

<https://github.com/wk544863858/dsh-plugin-magic-context/security/advisories/new>

（仓库 **Security** 标签页 → *Report a vulnerability*。）

报告里请尽量包含：

- 受影响的版本：插件版本、DSH 版本（`dsh --version`）、Node.js 版本、操作系统；
- 复现步骤或最小 PoC（已脱敏）；
- 影响评估：能读到什么、能写到什么、是否要求本机访问或同机其他进程；
- 你希望的致谢方式（是否愿意被署名）。

## 不要做什么 / What NOT to do

- 不要在公开 issue、PR、截图或日志里贴出 API key、token、cookie、私人会话正文、真实记忆库内容
  或本机绝对路径；
- 不要上传真实的 `memories.db`、journal 文件或导出数据，用合成样例替代；
- 不要测试他人的实例：本插件只应在你自己的机器 / 你被授权使用的机器上验证；
- 不要在修复发布前公开细节（见下面的处理预期）。

## 范围 / Scope

以下部分属于本插件的安全边界：

- **回环遥测路由**：注册在宿主 webServer 上的 `/mc-telemetry/summary` 与 `/mc-telemetry/events`
  （SSE），除"仅 loopback 可达"外**没有额外认证**。设计上只暴露计数与一行摘要，永不暴露消息正文、
  文件路径或凭据。越权读取其他会话/其他进程数据、来源校验绕过、注入或资源耗尽（如未关闭的 SSE
  连接）都算。
- **记忆库与注入**：插件自有 `memories.db`（SQLite，`node:sqlite`）以及 `m[0]`/`m[1]` 基线注入
  路径。跨项目 / 跨域越权读写、通过注入内容篡改或提取他人记忆、绕过"发布永远是人"的全局域审批，
  都算。
- **项目身份与域解析**：`git:<root-sha>` / `dir:<hash>` 身份推导、域表解析、全局域 `autoStage`
  自动入队——入队可以自动化，**发布必须经人审批**；任何能自动发布到机器/组织域的路径都是漏洞。
- **journal 与日志**：不得把密钥、凭据或用户正文写入可被他人读取的位置；日志脱敏失效算。
- **模型与 vendor 资产**：MiniLM 首次下载钉死 revision + sha256（双镜像回退，哈希不符弃块），
  `vendor/onnx/` 是逐字 vendored 的 WASM 后端。校验被绕过、被替换或静默降级都算。
- **安装与配置面**：`cordis.patch.yml`、profile bundle 叠加、GUI 设置卡片写回（volatile 字段
  保存即生效）——越权写配置或把不可信值带进决策点都算。
- **客户端渲染**：手写的浏览器半侧把遥测/配置数据渲染进 GUI；由此产生的脚本注入或信息泄露算。

明确**不在**本仓库范围内（请报告给各自上游）：

- DeepSeek Harness 本体的问题 → 报告给 DSH 项目；
- magic-context 上游的问题 → 报告给上游仓库；
- 依赖包自身的问题 → 报告给对应依赖的维护者；本仓库只负责升级或规避。

## 处理预期 / Response expectations

- 收到报告后 **7 天内**确认收到（维护者单人，尽力而为）；
- 评估后告知是否接受、修复计划与预计时间，并在修复过程中保持同步；
- 修复随新版本发布时，会在 GitHub Security Advisory 中说明；如果你愿意，会署名致谢；
- 请在修复发布前给维护者合理时间，不要公开利用细节。

## English (short)

This plugin runs locally inside DSH Desktop and touches session journals, a local memory database
(`memories.db`) and loopback HTTP telemetry routes (`/mc-telemetry/summary`, `/mc-telemetry/events`).
Please report vulnerabilities **privately** through GitHub Security Advisories:
<https://github.com/wk544863858/dsh-plugin-magic-context/security/advisories/new> — never in a public
issue. Do not include secrets, real memory databases, private conversation text or absolute local
paths; do not test instances you do not own. In scope: the loopback telemetry routes, the memory
store and `m[0]`/`m[1]` injection, project/domain isolation and global-domain approval, journal
redaction, the pinned model/vendor assets, the plugin install/config surface, and client rendering.
Scope excludes DSH itself, the upstream magic-context project and third-party dependencies — report
those upstream. We aim to acknowledge within 7 days (solo maintainer, best effort) and will agree on
a disclosure timeline with you; fixes are published with a GitHub Security Advisory.
