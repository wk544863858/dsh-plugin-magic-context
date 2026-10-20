# DSH 插件「实时日志/遥测上屏」契约

> 目标：回答「一个 host 侧插件如何把自己正在做什么的实时日志显示到 GUI 主界面」，并给出 magic-context 落地的最小改造配方与不可行路径的黑名单。
>
> 标注约定：〔码〕= 源码行号证据；〔测〕= 隔离环境实测（隔离 `DSH_HOME`，未触碰真实 profile）；〔档〕= 仓库 README/文档。
> 证据基线：DSH Desktop **0.2.0-rc.2**（打包路径 `%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\resources\`）；源码参考 `deepseek-harness-master`（下称源码树，仓内相对路径）。
> 姊妹文档：`docs/dsh-plugin-config-ui-contract.md`（配置界面契约，task-2）。本文不重复其内容，§8 只做交叉引用。

---

## 0. 结论摘要（先看这 8 条）

1. **主界面确实有官方座位可以显示任意内容，而且是最适合"遥测"的那一类**：`shell.overlay`（`kind: list`、`scope: root`、`replaceRisk: none`）的契约原文写着 —— “Deliberately generic and unowned by any feature: a **badge, a toast stack or a status pill** all belong here”。〔码〕`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2845-2849`。全量座位共 **92 个**（见 §4.4）。
2. **但座位只能由「浏览器半侧」（client half）注册，host 半侧不能直接写界面。** 所以「服务端插件显示日志」的准确形态是：**同一个 npm 包里再加一个 `lib/client.js` 浏览器半 + `package.json` 的 `dsh.client` 声明**，host 半侧只负责提供数据（HTTP 路由或 Remote 方法）。
3. **这条链路已端到端实测通过**：一个第三方包（用 NTFS junction 链进 profile，与 magic-context 现在的 `link:` 安装形态同型，且**不是** DSH 内置包）在被 boot 时出现在页面的 boot graph 里：`{"id":"mc-ui-probe","url":"plugins/??mc-ui-probe/client.js&rev=4a516f99b975"}`，且该 URL 返回 200 与逐字节原文。〔测〕见 §2.4。
4. **实时通道有 3 条，成本从低到高：**
   - **(A) 插件自有 HTTP 路由 + 浏览器半 `fetch`/`EventSource`（SSE）** —— 零新依赖、零代码生成、不被任何白名单限制。**本文推荐**。host 侧 `ctx.webServer.register` 实测 JSON 200 + `text/event-stream` 分帧输出。〔测〕§5。
   - **(B) Typert Remote（`mode:'stream'` 或 `$on` 事件）** —— 官方机制、类型安全，但需要 `lib/typert.host.js` + `lib/typert.remote-client.js` 两件**代码生成产物**；且 `$on` 的事件转发白名单是 `@deepseek-ai/dsh-api-remotes` 里的**编译期常量表**，第三方插件运行时加不进去。§6。
   - **(C) 会话内可见消息** —— 5 种 surface 事件**全部会进入模型上下文（花 token）**，`system/message` 还是「protected head」；唯一零 token 的可见文本是 `ctx.commands.register` 的 `{kind,text}` 结果，但必须用户主动敲 `/命令`。§7。
5. **客户端 bundle 没有任何 import 能力**：动态浏览器半的 `require` 只认模块表里的基线模块（`react`、`react-dom`、cordis、少数官方 client 包）；`styles.insert(css)` 是**动态半侧专有**的符号，普通编译产物里没有这个服务 —— 自带样式请用 inline style 或 `document.createElement('style')`。〔码〕§3。
6. **改文件即生效，但两个半侧的生效机制不同**：`dsh-client-hmr` **自动** watch 每个 client 入口产物，**不需要 `hmr.root`**（实测 8 秒内 `/rev` 从 `4a516f99b975` 变了）；而 host 半侧 `lib/index.js` 不进 `hmr.root` 就**不会**重载（实测改完仍是 404）。〔测〕§2.5、§5.4。
7. **插件页可以挂自己的只读状态面板**（`plugins.detail.section`、`plugins.row.config`、`plugins.item`），机制与 task-2 的配置表单完全同源（都要 client half + `ctx.slots.register`）。§8。
8. ⚠️ **安全前提**：插件自有路由**不受** `browser-auth` 的 token 门保护（实测无 token 直接 200），只有「loopback 绑定」这一层。遥测数据可以放，凭据/隐私内容不可以放；并且路由路径冲突会**抛异常**（`exact` 同路径重复注册 throw）。〔码〕`packages/host/webserver/tests/webserver.spec.ts:245` 〔测〕§5.3。

**一句话**：把日志打上屏 = **host 半侧建数据面（推荐一条自有 SSE 路由）+ 同一个包加一个约 60 行的 `lib/client.js` 注册进 `shell.overlay`**；不需要改 DSH、不需要第二套构建链、不需要 typert 代码生成。

---

## 1. 三层结构：一次看清新机制谁在哪一层

| 层 | 载体 | 能力 | 关键约束 |
|---|---|---|---|
| **host 半侧** | `lib/index.js`（`package.json` `main`，当前 magic-context 已有） | cordis 插件；`ctx.*` 服务面：`webServer`、`commands`、`slots`(host 侧占位)、`hmr` … | 一个 Loader 行；改动要么进 `hmr.root` 热重载，要么重启 |
| **通道** | 进程内 Remote / 自有 HTTP 路由 / commands 结果 | 把 host 数据送到浏览器 | 见 §5/§6/§7 的取舍 |
| **client 半侧** | `lib/client.js`（`exports["./client"]`，**当前 magic-context 没有**） | `window.__ModuleLoader__` 闭包工厂 → cordis 插件；`ctx.slots`、`ctx.remote`；`require` 模块表；`React` | 无 import；无设计系统组件；host half 的 `ctx` 服务**不共享** |

**核心心智模型**：host 半与 client 半是**同一个包的两次装载**（一个在 Node，一个在浏览器），彼此**不共享内存**，只通过通道通信。因此「显示正在做什么」必然是「host 侧可读状态 + client 侧轮询/订阅」。

---

## 2. 机制 A：client 半侧的发现、装载与服务（含实测）

### 2.1 package.json 契约〔码〕

以官方 `@deepseek-ai/dsh-client-ui-plugin-manager` 为范本：

```jsonc
{
  "main": "lib/index.js",            // host 半（现有）
  "exports": {
    ".":        { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },        // ← 浏览器半侧，唯一必需新增
    "./typert": { "default": "./lib/typert.host.js" },   // 仅方案 B 需要
    "./remote": { "default": "./lib/typert.remote-client.js" }
  },
  "dsh": {
    "client": {
      "platform": "web",                                     // ← 唯一硬性字段
      "inject": ["@deepseek-ai/dsh-client-ui-layout", "..."] // 可选：客户端模块 id 的依赖边，决定 boot graph 里的排序
    }
  },
  "files": ["lib/index.js", "lib/client.js"]                 // ← 发版时别漏
}
```
〔码〕`packages/client/ui-plugin-manager/package.json:14-46,78-86`（`platform`、`inject` = **client 模块 id（host 包名形态）**，`files` 含 `lib/client.js`）。

`dsh.client` 缺省即「纯 host 插件」：**当前 magic-context 正是这一状态，因此没有任何客户端产物被扫描**，改动前零风险。

### 2.2 谁扫描、谁服务〔码〕

- **扫描**：`@deepseek-ai/dsh-client-modules` 的 host 半扫**已启用的 Loader 行**，对每个「能定位到包根 manifest + 声明了 `dsh.client.platform === 'web'` + 有 `exports["./client"]`」的行，产出一条 boot graph entry（`id` = 行名，`url` = `plugins/??<id>/client.js&rev=<digest>`），并把它的客户端 `inject` 变成模块依赖边。
  〔码〕`packages/client/modules/src/index.ts:630-660`（`resolveMeta`/`locatePkgJson` 与 `/plugins` 路由注册）、`packages/client/modules/src/index.ts:830-880`（`compose`/`scan`）、`packages/client/modules/README.md`（“The host half turns each declaration into a served bundle under `/plugins`”）。
- **服务**：`ctx.webServer.register({ kind: 'prefix', path: PLUGIN_ROUTE, handler: this.serveBundle })`，`PLUGIN_ROUTE = '/plugins'`；combo 形式 `/plugins/??a/client.js&rev=…,b/client.js&rev=…`。〔码〕`packages/client/modules/src/index.ts:649`。
- **存在条件**：宿主 web 组合里有该行 ⇒ 目录里**已构建** `lib/client.js`。README 明确：**必须**让 `pnpm run build` 产出每个 `lib/client.js`，否则会 404 回到壳的错误横幅。〔档〕`packages/client/modules/README.md`。

### 2.3 产物形态（闭包工厂）〔码〕

```js
window.__ModuleLoader__.load({
  id: '<包名或行 id>',
  factory: (require) => { /* … 返回 cordis 插件对象 … */ },
})
```
源码树内由 `tsdown.client.ts` 的 `clientClosureFactoryPlugin` 统一生成，并注入 `data-plugin` 样式处理与 `^@deepseek-ai/dsh-` 外部化白名单。〔码〕`packages/client/tsdown.client.ts`、`packages/client/AGENTS.md`。**结论：可以手写**（§2.4 就是手写的 30 行），不必引入 tsdown 预设。

### 2.4 实测记录：一个 third-party 包真的被服务了〔测〕

环境：`DSH_HOME=%TEMP%\dsh-probe-home`、profile `probe`（`--from-default-profile web`）、包 `mc-ui-probe`（junction → `%TEMP%\dsh-probe-plugin`）、端口 31987、打包版 CLI `resources\runtime\cli\bin\dsh.cmd`。

| 步骤 | 命令/动作 | 观察 |
|---|---|---|
| 建隔离 profile | `dsh probe --from-default-profile web --dump-config` | 成功，组合里含 web 组合（`dsh-client-modules`） |
| 装包 | profile `node_modules\mc-ui-probe` = junction 到包目录；`cordis.patch.yml` 加 `- insert: [{ id: mc-ui-probe, name: 'mc-ui-probe' }]` | profile 与真实 `desktop` 同型（真实 profile 用的是 `link:<path>` 形态） |
| 启动 | `dsh probe --no-open --port 31987` | stdout 打印 `http://127.0.0.1:31987/?token=…`（index 需 token，无 token = 401） |
| **boot graph** | `GET /?token=…` | 含 `{"id":"mc-ui-probe","url":"plugins/??mc-ui-probe/client.js&rev=4a516f99b975","rev":"4a516f99b975"}`，位于 application 相位 |
| **产物被服务** | `GET /plugins/??mc-ui-probe/client.js&rev=4a516f99b975` | 200；**989 字节，与磁盘文件逐字节一致**；含 `__ModuleLoader__.load({ id: "mc-ui-probe"` |
| **源码映射** | `GET /plugins/mc-ui-probe/client.js.map?rev=…` | 404（我们没产 map；源码树内构建会产） |

⇒ **结论：第三方 profile 插件只要加 `dsh.client` + `exports["./client"]` + 构建好 `lib/client.js`，打包版运行时就自动收录并服务它，无需改任何 DSH 代码。**

### 2.5 生效机制（两个半侧不同，容易踩）〔测〕〔码〕

- **client 半侧：自动热更，不需要 `hmr.root`。** 追加一行注释后 8 秒内 boot graph 的 `rev` 从 `4a516f99b975` 变为新值〔测〕；源码侧 `dsh-client-hmr` 的 README 写明 “The **Host half watches each package's stamped entry artifact** and serves `/plugins/events`”，客户端订阅 SSE 后换入新产物。〔档〕`packages/client/hmr/README.md`；路由 `{ kind:'exact', path: EVENTS_ENDPOINT }` 〔码〕`packages/client/hmr/src/index.ts:182`。
- **host 半侧：不进 `hmr.root` 就不重载。** 把 `lib/index.js` 改成注册一条路由后不重启，`GET /mc-probe/status` 仍 404〔测〕；重启后 200。这与 profile 里已有 `hmr.root: [<repo-root>]` 的作用对象一致（**它只覆盖 host 半**）。

---

## 3. 模块表：client 半侧到底能拿到什么〔码〕

- 浏览器半侧跑在 `window.__ModuleLoader__` 下，工厂参数 `require` 只解析**模块表**里的 id；表由 `PLATFORM_MODULES` 播种（`react`、`react-dom`、cordis、少数官方 client 包如 ui-primitives），再由每个 client 入口的 `dsh.client.inject` 补边。〔码〕`packages/client/web/src/platform.ts`（`PLATFORM_MODULES`）、`packages/client/modules/src/index.ts`（`dependencies`/`dependsOn` 边）。
- **purity 规则**：构建期拒绝把 `@deepseek-ai/dsh-*` 打进产物（必须走模块表），只有显式 `dsh.client.external` 才允许。〔码〕`packages/client/tsdown.client.ts`、`packages/client/AGENTS.md`。
- **动态浏览器半**（`cordis-client-runner`，即 LLM 现写 UI 的那条路）更严格：`require` 由 sandbox 提供，**只有** `React`、`console`、`styles`、`host`、`harness`、少量 trap 参数可用。它的 `styles.insert(css)` 是**该平面专有**符号，普通编译产物里没有。〔码〕`packages/extensions/cordis-client-runner/src/client/evaluator.ts:173`、`providers.ts:61-63`。
- ⇒ **落地方案请假设「只能 `require('react')`」**：样式用 inline style 或自建 `<style>` 标签。

---

## 4. 插槽（slot）：注册 API 与全量清单

### 4.1 注册 API〔码〕

```js
module.exports = {
  inject: ['slots'],                       // 不声明 → 座位被扣留（CLIENT_NOTES #1）
  apply(ctx) {
    ctx.slots.inject('shell.overlay', () => // 座位只在声明者挂载期间存在；对未声明座位注册会 throw
      ctx.slots.register(
        { name: 'shell.overlay', id: 'mc.telemetry', order: 100, label: '…' },
        TelemetryPill,
      ))
  },
}
```
〔码〕`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:68-75`（CLIENT_NOTES）；`packages/client/ui-slots/src/index.ts`（`register`/`inject` 实现）。

**register options（按基数）**：`name` 必填；`list`/`keyed` 需 `id`（**用你自己新鲜的 id → 追加，不覆盖 shipped 条目**）；`order` 可选（升序，默认 0）；`label` 可选（`string | () => string`）。〔码〕`slot-catalog.ts:2850-2869`。
**不要传 `priority`**：门面会自动赋值且**低于所有 shipped 条目**。〔码〕`slot-catalog.ts:71`。
**`locale`（可选，2026-10-07 实测）**：声明字典命名空间（本插件用 `magic-context`）。声明后渲染器把
`t(key, params)`（`{name}` 插值）作为 prop 注入组件；每个 outlet 都订阅 locale revision，**切换语言即时
重渲染、无需刷新**。`label` 写成 `() => t('…')` 时也跟随当前语言（`resolveSlotLabel` 在读取时求值）。
声明了 `locale` 但 shell 没装 locale 面会抛 `SlotAssemblyError`，所以 `inject` 必须真的带上 `'locale'`。
〔码〕随应用分发的 bundle：`app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js`
（`standardKit`/`factoryKit` 写 `kit.t = localeSeat(face, entry.locale)`；`useLocaleRevision` 用
`useSyncExternalStore` 订阅）、`@deepseek-ai/dsh-client-ui-slots/lib/index.js`（`resolveSlotLabel`）、
`@deepseek-ai/dsh-client-locale`（`register`/`bind`/`translate`）。

**卡片语义三种**：`single`（唯一座位，注册即**替换** shipped UI，`replaceRisk: shadows-shipped-ui`）、`list`（追加，`none`）、`keyed`（按 key 取格）、`chain`。〔码〕`slot-catalog.ts:30-65`。

### 4.2 组件能拿到什么

标准 framework props 随 scope 变化：`root` 座位给 `useResource/useWorkspaces/usePanelInfo/useSessions/…`，`session` 座位再给 `useChat/useConversation/useInput/inputActions/useSession/sessionId/useProjection/useTrajectory`。选择器钩子按选择器调用（如 `useSessions(s => s.current)`）。〔码〕`slot-catalog.ts:73,92-109,3406-3422`。

注册项声明 `locale: <ns>` 时再加一个 `t`（见 4.1），官方范例的签名是
`function JobListAction({ sessionId, useJobs, watchRows, observe, killJob, t })`，插值用法
`t('terminal.expand', { n: hidden })`。〔码〕`@deepseek-ai/dsh-client-ui-jobs/lib/client.js`。

### 4.3 推荐座位（与 magic-context 用途对齐）

| slot key | kind | 含义 | replaceRisk | 定义 file:line |
|---|---|---|---|---|
| `shell.overlay` | list | **帧级浮动层**（不属于任何功能；badge / toast 栈 / 状态 pill 都归这里；整层 click-through，条目自行 opt-in 指针事件）—— **遥测首选** | none | `packages/client/ui-layout/src/client/index.ts:105` |
| `conversation.input.dock` | list | composer 卡片上方的**整宽**内容（每会话）—— 适合「本会话同步中」状态条 | none | `packages/client/ui-conversation/src/client/contract/slots.ts:195` |
| `conversation.chat.turnTail` | list | 每个已完成 Turn 的 action row 之前的尾巴 —— 适合「本回合做了什么」的收尾卡片 | none | `packages/client/ui-chat/src/client/contract/slots.ts:315` |
| `plugins.detail.section` | list | 插件详情页的**追加**分区 —— 适合完整日志面板 | none | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:128` |
| `plugins.item` | list | 插件页的插件卡片（追加） | none | 同上 `:96` |
| `plugins.row.config` | keyed | 行级配置格，key = `<包名>#<行 id>`（task-2 的入口） | none | 同上 `:110` |
| `settings.section` | list | 每个 list 条目 = 一个设置页 | none | `packages/client/ui-settings/src/client/contract/slots.ts:57` |
| `shell.bottom` | single | 三栏下方整宽内容 —— **会替换 shipped UI**，不要用来挂遥测 | shadows-shipped-ui | `packages/client/ui-layout/src/client/index.ts:94` |

### 4.4 全量插槽清单（92 个，机器提取）

来源：`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（**生成物**，头注：`scripts/gen-client-catalog.ts` 生成、`verify-client-catalog` 门禁）。在动态插件组合里，模型可用 `cordis_inspect what:"client"` 直接读同一份数据。〔码〕该文件 `:1-14`。

| # | slot key | kind | scope | replaceRisk | 契约摘要（英文原文） | 声明者 declaredBy（必须挂载才有座位） | 定义 file:line |
|---|---|---|---|---|---|---|---|
| 1 | `conversation.approval.detail` | single | session | shadows-shipped-ui | Optional detail for the Tool call correlated with an approval request. | an entry in 'conversation.composer' (client-ui-approval), so it exists whi… | `packages/client/ui-approval/src/client/contract/slots.ts:37` |
| 2 | `conversation.chat.assistant-actions` | list | session | none | Ordered actions for one finalized assistant message. | an entry in 'conversation.chat.node' (client-ui-chat), so it exists while … | `packages/client/ui-chat/src/client/contract/slots.ts:321` |
| 3 | `conversation.chat.commandview` | keyed | session | none | Command row keyed by the command name. | an entry in 'conversation.chat.node' (client-ui-chat), so it exists while … | `packages/client/ui-chat/src/client/contract/slots.ts:309` |
| 4 | `conversation.chat.node` | keyed | session | shadows-shipped-ui | Final Chat node renderer, keyed by `ChatNodeKind`. | an entry in 'conversation.view' (client-ui-chat), so it exists while that … | `packages/client/ui-chat/src/client/contract/slots.ts:290` |
| 5 | `conversation.chat.turnTail` | list | session | none | Ordered feature contributions before a completed Turn's action row. | an entry in 'conversation.chat.node' (client-ui-chat), so it exists while … | `packages/client/ui-chat/src/client/contract/slots.ts:315` |
| 6 | `conversation.composer` | chain | session | none | Selector-routed replacements for the current Session's resident composer. | factory 'conversation.content' (client-ui-conversation), so it exists whil… | `packages/client/ui-conversation/src/client/contract/slots.ts:187` |
| 7 | `conversation.composer.bar` | single | session-maybe | shadows-shipped-ui | Resident composer body, including the no-Session inert state. | factory 'conversation.content' (client-ui-conversation), so it exists whil… | `packages/client/ui-conversation/src/client/contract/slots.ts:207` |
| 8 | `conversation.composer.dock` | list | session | none | Ambient entries below the composer card. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:199` |
| 9 | `conversation.header` | single | session-maybe | shadows-shipped-ui | Resident navigation container, including when no Session is selected. | an entry in 'main.conversation' (client-ui-conversation), so it exists whi… | `packages/client/ui-conversation/src/client/contract/slots.ts:139` |
| 10 | `conversation.header.leading` | single | root | none | Global navigation before the Session title, available without a Session. | an entry in 'conversation.header' (client-ui-conversation), so it exists w… | `packages/client/ui-conversation/src/client/contract/slots.ts:168` |
| 11 | `conversation.hero.agentPreset` | single | session-maybe | shadows-shipped-ui | Agent-preset control staged for a New Session. | factory 'conversation.content' (client-ui-conversation), so it exists whil… | `packages/client/ui-conversation/src/client/contract/slots.ts:193` |
| 12 | `conversation.hero.brand.mark` | single | root | none | Brand mark shown before the blank-session headline. | factory 'conversation.content' (client-ui-conversation), so it exists whil… | `packages/client/ui-conversation/src/client/contract/slots.ts:191` |
| 13 | `conversation.hero.workspace` | single | root | shadows-shipped-ui | Workspace picker shown by the blank-session Hero. | factory 'conversation.content' (client-ui-conversation), so it exists whil… | `packages/client/ui-conversation/src/client/contract/slots.ts:189` |
| 14 | `conversation.hero.workspace.directoryFlow` | single | root | shadows-shipped-ui | Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker e… | an entry in 'conversation.hero.workspace' (client-ui-workspace), so it exi… | `packages/client/ui-workspace/src/client/contract/slots.ts:117` |
| 15 | `conversation.input.activity` | single | session | shadows-shipped-ui | Compact action after the model selector; it can expand across the toolbar while retaining the ed… | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:205` |
| 16 | `conversation.input.attachments` | single | session-maybe | shadows-shipped-ui | Optional draft-attachment rail and drop target. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:209` |
| 17 | `conversation.input.dock` | list | session | none | Full-width entries above the composer card. | factory 'conversation.content' (client-ui-conversation), so it exists whil… | `packages/client/ui-conversation/src/client/contract/slots.ts:195` |
| 18 | `conversation.input.left` | list | session | none | Compact controls at the left of the composer tool row. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:201` |
| 19 | `conversation.input.model` | single | session | shadows-shipped-ui | Model selector inside the composer tool row. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:223` |
| 20 | `conversation.input.overlay` | list | session | none | Floating entries rendered inside the resident composer card. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:197` |
| 21 | `conversation.input.permission` | single | session | shadows-shipped-ui | Current-session permission control inside the composer tool row. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:217` |
| 22 | `conversation.input.plan` | single | session | shadows-shipped-ui | Plan control inside the composer tool row. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:215` |
| 23 | `conversation.input.right` | list | session | none | Compact controls before the composer submit action. | an entry in 'conversation.composer.bar' (client-ui-conversation), so it ex… | `packages/client/ui-conversation/src/client/contract/slots.ts:203` |
| 24 | `conversation.message.images` | single | session | shadows-shipped-ui | Renderer for one consecutive group of durable message images. | an entry in 'conversation.view' (client-ui-chat), so it exists while that … | `packages/client/ui-chat/src/client/contract/slots.ts:303` |
| 25 | `conversation.plan-review.actions` | list | session | none | Actions for the exact plan under review; approval remains with the question composer. | an entry in 'conversation.composer' (client-ui-user-questions), so it exis… | `packages/client/ui-user-questions/src/client/contract/slots.ts:21` |
| 26 | `conversation.session` | single | session | shadows-shipped-ui | Strict per-Session Conversation body. | factory 'conversation.content' (client-ui-conversation), so it exists whil… | `packages/client/ui-conversation/src/client/contract/slots.ts:133` |
| 27 | `conversation.session.header` | single | session | shadows-shipped-ui | Strict per-Session title, actions, and View navigation. | an entry in 'conversation.header' (client-ui-conversation), so it exists w… | `packages/client/ui-conversation/src/client/contract/slots.ts:141` |
| 28 | `conversation.session.header.actions` | list | session | none | Title-adjacent Session actions in ascending order. | an entry in 'conversation.session.header' (client-ui-conversation), so it … | `packages/client/ui-conversation/src/client/contract/slots.ts:156` |
| 29 | `conversation.session.header.corner` | single | session | shadows-shipped-ui | The header's far-right corner, past the utilities' edge and into the header's own padding, for o… | an entry in 'conversation.session.header' (client-ui-conversation), so it … | `packages/client/ui-conversation/src/client/contract/slots.ts:179` |
| 30 | `conversation.session.header.lineage` | single | session | shadows-shipped-ui | Optional replacement for one Session breadcrumb title. | an entry in 'conversation.session.header' (client-ui-conversation), so it … | `packages/client/ui-conversation/src/client/contract/slots.ts:150` |
| 31 | `conversation.session.header.utilities` | list | session | none | Right-aligned Session utilities in ascending order. | an entry in 'conversation.session.header' (client-ui-conversation), so it … | `packages/client/ui-conversation/src/client/contract/slots.ts:162` |
| 32 | `conversation.trajectory.images` | single | session | shadows-shipped-ui | Renderer for one group of durable record images in the Trajectory ledger. | an entry in 'conversation.view' (client-ui-trajectory), so it exists while… | `packages/client/ui-trajectory/src/client/trajectory-contract.ts:98` |
| 33 | `conversation.view` | list | session | none | Registered Conversation target Views, rendered one at a time. | an entry in 'conversation.session' (client-ui-conversation), so it exists … | `packages/client/ui-conversation/src/client/contract/slots.ts:185` |
| 34 | `deliverables.file.actions` | list | session | none | Open one file through its authorized Session event coordinates. | an entry in 'conversation.chat.turnTail' (client-ui-deliverables), so it e… | `packages/client/ui-deliverables/src/client/file-actions.ts:8` |
| 35 | `deliverables.review.file.actions` | list | session | none | The same file actions owned by a changed-file review tab. | an entry in 'sidebar.right.pane.tab' (client-ui-deliverables), so it exist… | `packages/client/ui-deliverables/src/client/file-actions.ts:21` |
| 36 | `main` | keyed | root | shadows-shipped-ui | Central panel selected by sidebar entry id. | an entry in 'root' (client-ui-layout), so it exists while that entry is mo… | `packages/client/ui-layout/src/client/index.ts:73` |
| 37 | `main.conversation` | single | session-maybe | shadows-shipped-ui | Conversation shell beneath its root-scoped main-panel entry. | an entry in 'main' (client-ui-conversation), so it exists while that entry… | `packages/client/ui-conversation/src/client/contract/slots.ts:131` |
| 38 | `plugins.add.actions` | list | root | none | Additional MenuItemButton rows after installation: 72px high, with a title and a description cap… | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:84` |
| 39 | `plugins.bundle.activation` | keyed | root | shadows-shipped-ui | Optional guidance after the user enables a bundle from the list, keyed by npm package name. | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:86` |
| 40 | `plugins.bundle.config` | keyed | root | shadows-shipped-ui | A bundle's own configuration, keyed by the bundle's package name and rendered on the bundle's pa… | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:102` |
| 41 | `plugins.detail.actions` | list | root | none | Controls at the head of a detail page, before the page's own switch and uninstall, rendered with… | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:116` |
| 42 | `plugins.detail.badge` | list | root | none | Tags beside a detail page's title, after the version, beta, and problem tags the page draws itse… | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:121` |
| 43 | `plugins.detail.section` | list | root | none | Sections under a detail page's own content: after the rows on a bundle's page, after the configu… | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:128` |
| 44 | `plugins.item` | list | root | none | One official plugin the Plugins page lists in its Official group after the official bundles: `la… | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:96` |
| 45 | `plugins.row.config` | keyed | root | none | The configuration of one row a bundle declares, keyed by `<package name>#<row id>` with the row … | an entry in 'main' (client-ui-plugin-manager), so it exists while that ent… | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:110` |
| 46 | `rightbar` | single | root | shadows-shipped-ui | The right column: a track the centre makes room for, or nothing. | an entry in 'root' (client-ui-layout), so it exists while that entry is mo… | `packages/client/ui-layout/src/client/index.ts:87` |
| 47 | `rightbar.session` | single | session | shadows-shipped-ui | Session content selected by the root-scoped right Sidebar controller. | an entry in 'rightbar' (client-ui-sidebar-right), so it exists while that … | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:43` |
| 48 | `root` | single | root | shadows-shipped-ui | The built-in render-tree root hole (seeded by SlotCore): the one slot the shell itself renders, … | the runtime itself (built in; always present) | `packages/client/ui-renderer/src/client/registry.ts:44` |
| 49 | `settings.action` | list | root | none | Optional actions rendered in the content-column header before Close. | an entry in 'sidebar.settings' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:39` |
| 50 | `settings.close` | single | root | shadows-shipped-ui | The close button's visually-hidden label text (the button itself — icon, geometry, focus — is sh… | an entry in 'sidebar.settings' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:45` |
| 51 | `settings.general.item` | list | root | none | One preference row inside the General section — the additive seat for a single setting that need… | an entry in 'settings.section' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:92` |
| 52 | `settings.header` | single | root | shadows-shipped-ui | The panel title text seat. | an entry in 'sidebar.settings' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:33` |
| 53 | `settings.launcher` | single | root | shadows-shipped-ui | Optional sidebar account launcher; opens the shell-owned settings panel. | an entry in 'sidebar.settings' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:17` |
| 54 | `settings.models.footer` | list | root | none | Ordered extension area after the provider rows and the add controls. | an entry in 'settings.section' (client-ui-settings-models), so it exists w… | `packages/client/ui-settings-models/src/client/slot-contract.ts:40` |
| 55 | `settings.models.provider-card` | keyed | root | none | One provider card's adapter extension area, dispatched with `entryKey = settingsNs` on every car… | an entry in 'settings.section' (client-ui-settings-models), so it exists w… | `packages/client/ui-settings-models/src/client/slot-contract.ts:33` |
| 56 | `settings.models.sign-in` | single | root | shadows-shipped-ui | Optional account login choice before the credential editor. | an entry in 'settings.onboarding' (client-ui-settings-models), so it exist… | `packages/client/ui-settings-models/src/client/slot-contract.ts:35` |
| 57 | `settings.onboarding` | list | root | none | Root-scoped onboarding steps contributed by settings features. | an entry in 'sidebar.settings' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:77` |
| 58 | `settings.plugins.tab` | list | root | none | One page inside the Plugins settings section. | an entry in 'settings.section' (client-ui-settings-plugins), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:66` |
| 59 | `settings.section` | list | root | none | One settings page per list entry. | an entry in 'sidebar.settings' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:57` |
| 60 | `settings.trigger` | single | root | shadows-shipped-ui | The sidebar-foot trigger row content: icon + label, supplied as slot content (the accessible nam… | an entry in 'sidebar.settings' (client-ui-settings-general), so it exists … | `packages/client/ui-settings/src/client/contract/slots.ts:27` |
| 61 | `shell.bottom` | single | root | shadows-shipped-ui | Full-width bottom content below all three columns. | an entry in 'root' (client-ui-layout), so it exists while that entry is mo… | `packages/client/ui-layout/src/client/index.ts:94` |
| 62 | `shell.leading` | single | root | shadows-shipped-ui | Window-chrome seat at the frame's top-left, over every main panel. | an entry in 'root' (client-ui-layout), so it exists while that entry is mo… | `packages/client/ui-layout/src/client/index.ts:119` |
| 63 | `shell.overlay` | list | root | none | Frame-wide floating layer, above every column and outside their scroll containers. | an entry in 'root' (client-ui-layout), so it exists while that entry is mo… | `packages/client/ui-layout/src/client/index.ts:105` |
| 64 | `shell.quota-notice` | chain | root | none | Frame-wide quota notice chain. | an entry in 'shell.overlay' (client-ui-chat), so it exists while that entr… | `packages/client/ui-chat/src/client/contract/slots.ts:329` |
| 65 | `sidebar` | single | root | shadows-shipped-ui | The whole left column. | an entry in 'root' (client-ui-layout), so it exists while that entry is mo… | `packages/client/ui-layout/src/client/index.ts:68` |
| 66 | `sidebar.brand.mark` | single | root | shadows-shipped-ui | Brand mark rendered in the expanded brand row and collapsed rail. | an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry i… | `packages/client/ui-sidebar/src/client/contract/slots.ts:25` |
| 67 | `sidebar.brand.name` | single | root | shadows-shipped-ui | Brand name rendered beside the expanded mark. | an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry i… | `packages/client/ui-sidebar/src/client/contract/slots.ts:30` |
| 68 | `sidebar.chat.conversation` | single | session | shadows-shipped-ui | Session-scoped Conversation occurrence hosted by one Sidebar chat tab. | an entry in 'sidebar.right.pane.tab' (client-ui-subagent), so it exists wh… | `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:42` |
| 69 | `sidebar.footer.action` | list | root | none | Optional actions beside Settings at the sidebar foot. | an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry i… | `packages/client/ui-sidebar/src/client/contract/slots.ts:53` |
| 70 | `sidebar.panellist` | list | root | none | Global panel icons. | an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry i… | `packages/client/ui-sidebar/src/client/contract/slots.ts:35` |
| 71 | `sidebar.right.pane.tab` | keyed | session | none | One tab's body, dispatched with the `id` of the type in force for `tab.kind`. | an entry in 'rightbar.session' (client-ui-sidebar-right), so it exists whi… | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:59` |
| 72 | `sidebar.right.pane.tab.title` | keyed | session | none | A tab's title as its chip (and a floating panel's header) shows it, dispatched with the same key… | an entry in 'rightbar.session' (client-ui-sidebar-right), so it exists whi… | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:73` |
| 73 | `sidebar.right.tab.document` | keyed | session | none | Document body selected by a registered implementation id. | an entry in 'sidebar.right.pane.tab' (client-ui-sidebar-documentpreview), … | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:51` |
| 74 | `sidebar.right.tab.document.action` | keyed | session | none | Renderer-specific controls before the document toolbar's reload button. | an entry in 'sidebar.right.pane.tab' (client-ui-sidebar-documentpreview), … | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:87` |
| 75 | `sidebar.right.tab.document.actions` | list | session | none | Header toolbar contributions acting on the previewed file, rendered after the preview's own cont… | an entry in 'sidebar.right.pane.tab' (client-ui-sidebar-documentpreview), … | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:66` |
| 76 | `sidebar.right.tab.document.office.pdf` | keyed | session | none | PDF presentation supplied with Office-owned converted bytes. | an entry in 'sidebar.right.tab.document' (client-ui-sidebar-documentprevie… | `packages/client/ui-sidebar-documentpreview/src/client/office/OfficeBody.tsx:19` |
| 77 | `sidebar.right.tab.document.unpreviewable` | list | session | none | Empty-state contributions for a file this preview cannot render, offered where Retry would stand… | an entry in 'sidebar.right.pane.tab' (client-ui-sidebar-documentpreview), … | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:78` |
| 78 | `sidebar.right.tab.files.actions` | list | session | none | Workspace directory actions after the file tree's reload control. | an entry in 'sidebar.right.pane.tab' (client-ui-sidebar-files), so it exis… | `packages/client/ui-sidebar-files/src/client/index.ts:34` |
| 79 | `sidebar.right.tab.guide` | chain | session | none | The guide tab's body. | an entry in 'sidebar.right.pane.tab' (client-ui-sidebar-right), so it exis… | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:84` |
| 80 | `sidebar.right.tab.guide.entry` | keyed | session | none | One provider's guide card, with the standard card as the owner's fallback. | an entry in 'sidebar.right.pane.tab' (client-ui-sidebar-right), so it exis… | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:91` |
| 81 | `sidebar.right.tab.menu.item` | list | session | none | Extra items at the end of one tab's actions menu, in registration order. | an entry in 'rightbar.session' (client-ui-sidebar-right), so it exists whi… | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:103` |
| 82 | `sidebar.session.row.hover` | list | root | none | Section of the Session row's hover card between its relative time and its trailing status line. | an entry in 'sidebar.workspaces' (client-ui-workspace), so it exists while… | `packages/client/ui-workspace/src/client/contract/slots.ts:134` |
| 83 | `sidebar.session.row.leading` | list | root | none | Leading decoration of one Session row, in the 16px cell before the title that the row's own stat… | an entry in 'sidebar.workspaces' (client-ui-workspace), so it exists while… | `packages/client/ui-workspace/src/client/contract/slots.ts:129` |
| 84 | `sidebar.settings` | single | root | shadows-shipped-ui | The settings seat at the sidebar foot. | an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry i… | `packages/client/ui-sidebar/src/client/contract/slots.ts:48` |
| 85 | `sidebar.toggle.badge` | single | root | shadows-shipped-ui | Non-interactive notification inside the collapsed sidebar expand button. | an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry i… | `packages/client/ui-sidebar/src/client/contract/slots.ts:19` |
| 86 | `sidebar.workspaces` | single | root | shadows-shipped-ui | The workspace/session browsing region: section header, search, the grouped/flat session list, an… | an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry i… | `packages/client/ui-sidebar/src/client/contract/slots.ts:42` |
| 87 | `sidebar.workspaces.directoryFlow` | single | root | shadows-shipped-ui | Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). | an entry in 'sidebar.workspaces' (client-ui-workspace), so it exists while… | `packages/client/ui-workspace/src/client/contract/slots.ts:119` |
| 88 | `sidebar.workspaces.session.menu.item` | list | root | none | The rows of one Session's "..." menu, in ascending `order`. | an entry in 'sidebar.workspaces' (client-ui-workspace), so it exists while… | `packages/client/ui-workspace/src/client/contract/slots.ts:166` |
| 89 | `sidebar.workspaces.session.row.action` | list | root | none | The hover buttons at the end of one Session row, in ascending `order`, after the "..." menu trig… | an entry in 'sidebar.workspaces' (client-ui-workspace), so it exists while… | `packages/client/ui-workspace/src/client/contract/slots.ts:184` |
| 90 | `tool.call.images` | single | session | shadows-shipped-ui | Durable images of a settled image-bearing Tool call, rendered through the attachment presentatio… | an entry in 'tool.call.toolview' (client-ui-tool), so it exists while that… | `packages/client/ui-tool/src/client/contract/slots.ts:44` |
| 91 | `tool.call.toolview` | keyed | session | shadows-shipped-ui | Keyed Tool call view dispatched by wire Tool name. | an entry in 'conversation.chat.node' (client-ui-tool), so it exists while … | `packages/client/ui-tool/src/client/contract/slots.ts:26` |
| 92 | `tool.view.cordis` | keyed | session | none | Interactive Package-owned region rendered inside the latest eligible `cordis_run` card in the co… | an entry in 'tool.call.toolview' (client-ui-cordis), so it exists while th… | `packages/extensions/ui-cordis/src/client/slots.ts:31` |

---

## 5. 方案 A（推荐）：插件自有 HTTP 路由 + 浏览器半

### 5.1 为什么推荐

- **零新依赖**：host 侧只用 `ctx.webServer`（已内置服务），client 侧只用 `React` + 浏览器原生 `EventSource`。
- **不受任何白名单限制**：`$on` 事件转发白名单（§6.2）与我们的路由无关。
- **真推送**：SSE 一条长连接，无需轮询节流，无 token 成本。
- **可独立健壮**：路由与 UI 同包，版本天然一致。

### 5.2 host 半侧（实测通过的写法）〔测〕

```js
export const name = 'magic-context'
export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',                 // 'exact' 精确匹配；'prefix' 匹配 p 与 p/anything
    path: '/mc-telemetry',
    handler: (req, res) => {
      const url = new URL(String(req.url), 'http://localhost')
      if (url.pathname === '/mc-telemetry/status') { /* JSON 快照 */ }
      if (url.pathname === '/mc-telemetry/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
        const beat = setInterval(() => res.write(`data: ${JSON.stringify(snapshot)}\n\n`), 2000)
        req.on('close', () => { clearInterval(beat); res.end() })
      }
    },
  }), 'magic-context: telemetry routes')
}
```
实测：`GET /mc-probe/status` → 200 JSON；`GET /mc-probe/events` → `content-type: text/event-stream; charset=utf-8` 并立刻读到一帧 `data: {...}`〔测〕。
`kind` 语义〔码〕`packages/host/webserver/src/index.ts:38`；返回 dispose 函数，务必放进 `ctx.effect` 以便行卸载/热重载时释放〔码〕`packages/host/webserver/tests/webserver.spec.ts:247-251`。

### 5.3 路由的硬约束与安全

- **同路径重复注册会 throw**（`webserver.spec.ts:245`）；用 `exact` + 唯一前缀（如 `/mc-telemetry`）避免撞官方路由。
- **不受 browser-auth token 保护**：实测**无 token** 直接 200〔测〕；`/` index 无 token 是 401〔测〕。⇒ 只有 loopback 一层保护，**不要放密钥/个人数据**；给日志做裁剪（事件类型 + 计数，不放正文）。
- 该服务只服务于 web 组合；headless/TUI 组合里没有 `webServer` ⇒ `inject` 缺失时插件不应崩（把注册放进 `ctx.effect` 并容错）。

### 5.4 client 半侧（约 60 行，手写即可）〔测〕

```js
window.__ModuleLoader__.load({
  id: 'magic-context',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState } = React

    const css = '.mc-pill{font:12px/1.4 ui-monospace,monospace;padding:6px 10px;border-radius:8px;' +
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);pointer-events:auto}'
    let styled = false
    const ensureStyle = () => {
      if (styled || typeof document === 'undefined') return
      const tag = document.createElement('style'); tag.textContent = css
      document.head.appendChild(tag); styled = true
    }

    function Pill() {
      const [snap, setSnap] = useState(null)
      useEffect(() => {
        ensureStyle()
        const es = new EventSource('/mc-telemetry/events')   // 同源，绝对路径
        es.onmessage = (e) => { try { setSnap(JSON.parse(e.data)) } catch {} }
        return () => es.close()
      }, [])
      if (!snap) return null
      return React.createElement('div', { className: 'mc-pill', style: { position: 'fixed', right: 12, bottom: 12 } },
        `magic-context · ${snap.phase} · ${snap.events} ev`)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'magic-context.telemetry', order: 100 }, Pill))
      },
    }
  },
})
```
要点：**只用相对/同源绝对路径**（页面就是 `http://127.0.0.1:<port>/`，`EventSource('/mc-telemetry/events')` 同源可达）；`shell.overlay` 整层 click-through，需要交互的元素自己 `pointer-events:auto`〔码〕`slot-catalog.ts:2849`；SSE 断线由浏览器自动重连，无需额外心跳逻辑（心跳只是防中间件超时）。

---

## 6. 方案 B：Typert Remote（官方机制，但有代码生成成本）

### 6.1 形态〔码〕

- host 半：`class MyService extends TypertRemoteService { constructor(ctx){ super(ctx, 'myService') } @Remote async recent() {…} @Remote({ mode:'stream' }) follow(): AsyncIterable<Frame> {…} }`〔码〕`packages/api/remotes/README.md`。
- 构建产物：`exports["./typert"]` = `lib/typert.host.js`（gateway 描述符注册）、`exports["./remote"]` = `lib/typert.remote-client.js`（类型 + 运行时方法名）。**由 `@deepseek-ai/dsh-typert-generator` 生成**〔码〕`packages/typert/generator/README.md`。
- client 半：`inject: ['remote','remote.myService']`，调用 `ctx.remote.myService.recent()`；**流式**消费是官方既有用法：`for await (const frame of ctx.remote.plan.follow(input, signal))`〔码〕`packages/client/ui-plan/src/client/plan-resource.ts:52`。

### 6.2 事件推送的硬限制（务必记住）

`ctx.remote.$on('event/name', handler)` 只转发 `API_REMOTE_FORWARDED_EVENTS` 里列出的键（如 `plugin-manager/changed`），该表是 `@deepseek-ai/dsh-api-remotes` 的**运行时常量**；`TypertRemoteEventSelection` 虽然可 declaration-merge（编译期），但**运行时列表不会随之扩展** — 第三方插件无法把自己的事件名加进去。〔码〕`packages/api/remotes/src/remote-events.ts`、`src/types.ts`、`packages/api/remotes/README.md`（“forwarded events”一节）。
⇒ 想用 Remote 做推送，只能用 **`mode:'stream'`**（客户端 `for await`，等于自带下行通道），别指望 `$on` 自定义事件。

### 6.3 何时才值得上方案 B

需要「强类型 + 与官方协议一致 + 未来要给别的插件消费」时。仅为本插件内部日志上屏，**不值得**引入 typert 生成器（新增构建步骤、两件生成物、`files` 与 `exports` 扩张）。

---

## 7. 方案 C：会话内可见文本（会花 token，需分清）

- surface 事件**恰好 5 种类型，全部是 LLM 消息**：`SURFACE_EVENT_TYPES = { system/message, developer/message, user/message, assistant/message, tool/result }`；`system/message` 还有 **protected head** 保护（不能被覆盖/surface 替换）。〔码〕`packages/core/session/src/surface.ts:49-56`（运行时集合）、`packages/core/session/src/types.ts:439-444`（`SurfaceEventType` 联合）、`packages/client/ui-conversation/src/client/contract/system-prompt.ts`。
  ⇒ 用 `system/message` 上屏遥测 = **每帧都进模型上下文并消耗 token**，且污染对话史。**不要这么做**（除非确实想让模型看到）。
- **零 token 的可见文本**：`ctx.commands.register({ name, description, input, handler })`，handler 返回 `{ kind: 'success' | 'error', text }` —— 契约原文：UI 适配器渲染的文本，**不创建模型消息、不花 token**。客户端渲染成对话流里的 command 卡片（`command/done` → `GenericCommandCard`），并且可按命令名接管渲染：座位 `conversation.chat.commandview`（`keyed`，key = 命令名）〔码〕`packages/interaction/commands/README.md`、`packages/client/ui-chat/src/client/chat/GenericCommandCard.tsx`、`slot-catalog.ts` 中 `conversation.chat.commandview`（契约 `ui-chat/src/client/contract/slots.ts:309`）。
- **限制**：必须用户**主动敲命令**（我们已有 `/ctx-status` 走这条路）。适合「按需查询」，不适合「持续播报」。

---

## 8. 其它候选速查（谁能用、能干什么）

| 机制 | 插件能用？ | 说明 | 证据 |
|---|---|---|---|
| `shell.overlay` 自定义 pill/toast 栈 | ✅ 推荐 | 自己画，自己喂数据 | `slot-catalog.ts:2845` |
| `conversation.input.dock` / `.chat.turnTail` | ✅ | 会话内、但**非模型消息**的常规座位 | `ui-conversation/.../slots.ts:195`、`ui-chat/.../slots.ts:315` |
| 插件页 `plugins.detail.section` / `plugins.item` / `plugins.row.config` | ✅ | 只读状态面板 / 行级配置；与 task-2 同机制 | `ui-plugin-manager/src/client/slot-contract.ts:96,110,128` |
| 设置页 `settings.section` | ✅ | 条目 = 一个设置页 | `ui-settings/.../slots.ts:57` |
| **官方 toast（`PluginRefreshToast`）** | ❌ | 它是**客户端本地状态**触发（插件同步失败时 manager store 置 `kind:'refresh-failed'`），**没有 host→客户端 的 toast API**；要 toast 就在 client 半自己画 | `ui-plugin-manager/src/client/PluginRefreshToast.tsx` |
| 状态栏/底栏 | ⚠️ | `shell.bottom` 是 **single**，注册即替换 shipped UI；遥测请用 `shell.overlay` | `ui-layout/src/client/index.ts:94` |
| 动态浏览器半（LLM 现写 UI，`cordis-client-runner` + `ui-cordis`） | ⚠️ 运行期能力 | 可让模型现场注册 UI 到这些座位并读回加载报告（`cordis_inspect what:"temporary"`），但需 cordis 扩展 + 宿主批准；**我们的 profile 把 extensions 设成 `[]`**，不可用 | `packages/extensions/cordis-client-runner/`、`cordis-client-runner/README.md` |
| `ui-dockkit` / `ui-settings-session-log` / `ui-jobs` / `ui-goal` / `ui-plan` | ❌ | 都是**编译期内置包**，不是运行时插件可扩展的座位；不要指望"把日志塞进 jobs 面板" | `packages/client/ui-dockkit`、`ui-settings-session-log` |

---

## 9. 给 magic-context 的最小改造配方

现状（改动前）：`package.json` 只有 `main: lib/index.js`，**无 `dsh.client`**，无 `lib/client.js` ⇒ 与 DSH 客户端零耦合（风险为 0）。

**步骤**
1. host 半（`src/`）：新增遥测环形缓冲（最近 N 条 + 计数），`inject: ['webServer']`，注册 `/mc-telemetry/events`（SSE）与 `/mc-telemetry/status`（JSON），注册放进 `ctx.effect`。已实测该写法在 0.2.0-rc.2 上可用。
2. client 半：新增 `src/client/index.js`（手写产物；本仓即此形态），内容 = §5.4 模板，注册进 `shell.overlay`，`id` 用 `magic-context.telemetry`（新鲜 id ⇒ 追加不覆盖）。
3. 构建：产出 `lib/client.js`。若不想引入 tsdown 预设，可用一个 6 行的 esbuild/rolldown 包装脚本手工套上 `__ModuleLoader__.load({ id, factory })`（实测手写产物可被服务）。
4. `package.json`：加 `exports["./client"]`、`dsh.client = { platform: "web" }`（可选加 `inject: ["@deepseek-ai/dsh-client-ui-layout"]` 以获得排序边），并把 `lib/client.js` 加进 `files`。
5. profile 侧**无需新增行**（client 半挂在 `magic-context-dsh` 这一行上），但**新增 client 入口属于新的 boot-graph 依赖边** ⇒ 本次生效需要重启 DSH，或走插件页的安装/刷新/启用流程（源码说明该流程驱动的增量组合能在同一会话内把新入口组合进来〔码〕`packages/client/modules/src/index.ts:806-814`）；之后改 `lib/client.js` 即热更（§2.5）。
6. 验证清单：boot graph 出现 `{"id":"magic-context-dsh", …plugins/??…/client.js&rev=…}` → 该 URL 200 且字节一致 → 页面右下出现 pill → 改动 `lib/client.js` 后 `rev` 变化 & 页面自动换入。
7. 回滚：删掉 `dsh.client` 与 `exports["./client"]` 即可退回纯 host 插件（客户端会忽略该行），**无需协议版本协商**（我们只走自有路由，不碰 DSH 协议）。

**为什么不选另外两条**：方案 B 要引入 typert 生成器与两件生成物、且 `$on` 白名单挡住自定义推送；方案 C 每帧花 token 或必须用户手敲命令。

---

## 10. 未闭环 / 不要轻信的地方（诚实清单）

1. **未在真浏览器里目视确认**。本文的"插槽真的画出来"只到「产物被正确服务 + 注册契约来自生成物 catalog」；无头环境下没有验证 React 组件实际渲染、`EventSource` 在页面内建连成功。→ 建议首次落地时用现有 GUI（刷新页面）目视一次，并读插件页的浏览器半加载报告。
2. **`/plugins/events`（client HMR 的 SSE）没有实测帧内容**。`rev` 变化实测到了，但"浏览器端收到 reload 并换入新产物"是 README 声明 + 源码推导，未抓帧。
3. **`dsh.client.inject` 的排序语义**只从 `ui-plugin-manager/package.json` 与 modules README 推断；我们的模板用 `ctx.slots.inject` 已能容忍座位晚到，故未实测 inject 缺失的后果。
4. **`styles.insert` 归属**：确认它是动态浏览器半的符号（`cordis-client-runner`），普通编译产物里**没有**；本文推荐自带 `<style>`/inline style 来彻底规避这个歧义。
5. **路由鉴权**只验证了「无 token 可 200」这一个方向，没有穷举 trustedHosts/loopback 的边界；正式落地前请把遥测数据默认裁剪到"类型 + 计数"。
6. 本文所有源码行号基于 `deepseek-harness-master` 当前快照；DSH 升级后行号会漂移，**语义请以 `slot-catalog.ts` 与 README 为准**（catalog 本身有 freshness 门禁）。

---

## 附录 A：实测环境与命令（可复现）

```powershell
$env:DSH_HOME="$env:TEMP\dsh-probe-home"           # 隔离，未触碰 %USERPROFILE%\.dsh
$dsh="%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh probe --from-default-profile web --dump-config      # 建 profile
# 包：%TEMP%\dsh-probe-plugin { package.json(dsh.client), lib/index.js, lib/client.js }
# profile：node_modules\mc-ui-probe = junction → 包目录；cordis.patch.yml 插入 mc-ui-probe 行
& $dsh probe --no-open --port 31987                        # 后台启动，stdout 给 token URL
# GET /?token=…                      → boot graph 含 mc-ui-probe 行
# GET /plugins/??mc-ui-probe/client.js&rev=… → 200，989B，与磁盘一致
# GET /mc-probe/status               → 200 JSON（无 token）
# GET /mc-probe/events               → text/event-stream + 首帧 data:
```
残留物（可删）：`%TEMP%\dsh-probe-home`、`%TEMP%\dsh-probe-plugin`、`%TEMP%\dsh-probe-web*.log`。服务进程已停止（端口 31987 已释放，未影响用户 19387 的 desktop 实例）。

## 附录 B：证据文件索引（源码树相对路径）

| 主题 | 文件 |
|---|---|
| 插槽全量契约（生成物，92 键） | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` |
| 动态半浏览器 API 面 | `packages/extensions/cordis-client-runner/src/client/{providers,evaluator,runtime,api-catalog}.ts` |
| client 半的扫描/服务/boot graph | `packages/client/modules/src/index.ts`、`README.md` |
| 模块表基线 | `packages/client/web/src/platform.ts` |
| client 半构建与外部化 | `packages/client/tsdown.client.ts`、`packages/client/AGENTS.md` |
| client HMR | `packages/client/hmr/README.md`、`src/index.ts` |
| Remote/Typert | `packages/api/remotes/README.md`、`src/{types,remote-events}.ts`、`packages/typert/generator/README.md` |
| 流式消费范例 | `packages/client/ui-plan/src/client/plan-resource.ts` |
| HTTP 路由服务 | `packages/host/webserver/src/index.ts`、`README.md` |
| 命令（零 token 可见文本） | `packages/interaction/commands/README.md` |
| surface 事件（会花 token） | `packages/core/session/src/{surface,known-event-types}.ts` |
| 插槽使用的官方范例 | `packages/client/ui-plugin-manager/{package.json,src/index.ts,src/client/*}` |
| 配置界面（姊妹文档） | `docs/dsh-plugin-config-ui-contract.md` |

## 勘误与补充（Lead + client-ui 实现期实测，2026-10-07）

实现本插件的浏览器半侧时，下面几点与本文正文的表述不同，以本节为准：

1. **`__ModuleLoader__.load({ id })` 的 id 是「包名」，不是 loader 行 id**。boot graph 行形如
   `{"id":"dsh-plugin-magic-context","url":"plugins/??dsh-plugin-magic-context/client.js&rev=a0b07ec77735","rev":"a0b07ec77735"}`；
   `system.ts:221` 会校验「已载入但未注册 <id>」。文中的 `id:"magic-context-dsh"` 写法会让外壳注册失败。
   （配置表单的**命名空间**仍然是 loader 行 id `magic-context-dsh`——两处取值口径不同，勿混。）
2. **只有 combo URL 可取 client bundle**：`GET /plugins/??<包名>/client.js&rev=<rev>` → 200；
   单资源形式 `/plugins/<包名>/client.js?rev=…` → **404**，因为 chunk 路由的 `CLIENT_CHUNK` 正则只接受
   `client.<name>.js`（`packages/client/modules/src/index.ts:192,1080-1098`），入口产物不匹配。
3. **combo 响应体 = 磁盘文件 + `;\n` + `//# sourceMappingURL=…`（共 85 B）**，即 harness 的
   `buildComboScript` epilogue；逐字节校验时要把这 85 B 算进去（本插件实测 31078 = 30993 + 85，
   文件本体 sha256 与磁盘一致）。
4. **宿主半侧的 `webServer` 必须用 `ctx.inject(['webServer'], …)` 获取，不能用 `ctx.get('webServer')` 快照**。
   `ctx.get` 是「无 inject 要求的读」，webServer 的 provider fiber 在 bundle apply 时通常尚未 active →
   返回 undefined → 路由永不注册，**且不会随服务晚到而重试**。实测：隔离 profile 里 `/mc-telemetry/*` 404，
   而 desktop 实例恰好赢了竞态才 200；改成 `ctx.inject` 后两侧都确定注册
   （官方写法见 `packages/client/modules/src/index.ts:653`）。
5. **client bundle 的注册表在应用启动时构建**：给一个已安装的包**新加** `exports["./client"]` / `dsh.client`
   之后，运行中的应用不会自动把它纳入 boot graph（`dsh-client-hmr` 只 watch **已注册**的产物）。
   实测：desktop 实例上 `GET /plugins/??dsh-plugin-magic-context/client.js&rev=…` 仍 404，**需要重启应用**。
6. **`defaultDataDir()` 不受 `DSH_HOME` 约束**：隔离 profile 里启动本插件仍会打开
   `~/.local/share/cortexkit/magic-context-dsh-poc`（往共享 `activity.log` 追加行、并发 WAL 打开库）。
   做隔离实验时请显式传插件配置 `dataDir`，避免污染真实观测数据。
7. **多语言（2026-10-07 实现）——语言开关只覆盖浏览器 UI**。`@deepseek-ai/dsh-client-locale` 是
   **浏览器侧**服务：`ctx.locale.register(ns, { zh, en })` 注册字典、`ctx.locale.bind(ns)` 取翻译函数；
   槽位注册项声明 `locale: ns` 后由渲染器注入 `t` prop，切换语言即时重渲染（机制见 4.1）。宿主的
   `locale.preference` 存在 profile 的 `cordis.patch.yml`（当前默认 `en`），但**宿主（node）侧没有任何
   locale 服务**：实测 asar 内除 `dsh-client-locale` 外没有任何包读取 `locale.preference`，自带宿主包
   （compaction/commands/agent-instructions/session/…）全部纯英文。因此本插件的分工是：
   - **client 半侧**：`inject: ['slots','locale']`，注册 `magic-context` 命名空间（zh/en 各 78 键，
     键集合必须一致），四个槽位注册项都声明 `locale: 'magic-context'`，面板/徽标文案一律 `t('key')`；
   - **宿主半侧**：`session-notice` 的 notice（写进会话流、**模型可见**）保持英文常量，与其它宿主面
     一致，也避免同一会话中途换语言造成 cached prefix 抖动——改语言只影响浏览器 UI，不改变模型可见文本。
   验收：`node scripts/mc-i18n-check.mjs`（无浏览器、无 DB：断言宿主 notice 英文与
   120 字上限、字典键对齐、源码引用的键都存在、字典之外无硬编码中文、`apply` 接线、en/zh 渲染结果）。
   注：本仓 `tests/session-notice.spec.ts` 的断言已同步改为英文；该 spec 早期是 DSH 测试树的镜像，
   独立仓后已脱离镜像关系。
8. **胶囊面板「操作记录」的记录模型（2026-10-08 补齐回收 lane）**。面板把 journal 行映射成记录的顺序是：
   `recordOf()`（一个 kind/分支 → 一条记录或 `null`）→ `recordsOf()`（相邻同文案同明细折叠成 `×N`）→
   `recordCounts()`（按分类出 chips），最多 `MAX_RECORDS = 12` 条。本次修掉的两处**丢弃**：
   - `case 'tool-call'` 原先只认 `data.action ∈ {write,update,archive,merge}`（🧠 写入记忆）与
     `{list,get}`（🔎 检索记忆）。而 `ctx_reduce`/`ctx_expand` 的行**没有 `action`**（只有
     `tool` + `requested/queued/refused/ms`，见 `dsh/tool-bridge.ts:217,277`），于是**永远不显示**；
     `ctx_memory search` 有 action 却不在白名单里，同样被丢。现在三条都映射：
     `ctx_reduce → 🗑️ 回收入队（入队 N · 被拒 M · 耗时）`、`ctx_expand → 🧭 恢复原文（恢复 N · 被拒 M）`、
     `search → 🔎 检索记忆（命中 N）`；`hits` 由宿主在 `finish()` 里随 journal 行下发
     （历史行没有该字段，只显示「检索 · 耗时」）。
   - 渡过的坑：**`baseline` 的记录必须按 `data.mode` 分**——HARD 重建是记录（✂️，priced cache bust），
     SOFT 刷新进噪声行（`noiseLine` 只数 soft）。`scripts/mc-records-check.mjs` 原先按 kind 一刀切把
     `baseline` 全归噪声，只在"采样窗口里恰好没有 HARD 行"时通过；本次改为按 mode 断言，并新增
     「HARD 基线重建仍是记录」。同一脚本的采样也补成**每个 `tool`/`action` 各取最新一行**
     （`perFlavour`）：此前 `tool-call` 只按 (kind, level) 取一行，最新那行几乎总是 ctx_memory，
     回收 lane 的断言其实是空断言。
   验收：`node scripts/mc-records-check.mjs`（真实 journal 行 → 面板将显示的记录，
   含分类表漂移、噪声折叠、HARD/SOFT 拆分、zh/en 渲染无中文残留）与
   `node scripts/mc-i18n-check.mjs`（新增 `detail.verb.search` 后，动态键族的
   动作清单同步加了 `search`）。client 半侧改动需要 `node scripts/copy-client.mjs` 重建 `lib/client.js`
   并**刷新页面**才生效（浏览器不热更）。
