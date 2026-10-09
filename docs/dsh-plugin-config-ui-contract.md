# DSH 插件配置界面契约

> 目标：回答「一个 profile 插件的配置项如何出现在 GUI 插件页并可编辑」，并给出把 magic-context 的阈值（`policy.*` / `journal.*` / `memory.*`）做成界面可改的最小改造配方。
>
> 标注约定：〔码〕= 源码行号证据；〔测〕= 本机实测（隔离 TEMP 目录，未触碰用户 desktop profile）；〔档〕= 仓库文档/README。
> 证据基线：DSH Desktop 0.2.0-rc.2；源码参考 `deepseek-harness-master`（vendor 版本：cordis 4.0.5-alpha.1、schemastery 3.18.5-alpha.1）。

---

## 0. 结论摘要（先看这 7 条）

1. **没有任何"自动生成"的插件配置界面。** GUI 里能编辑的每一处插件配置，都是某个人**手写的浏览器半侧（client half）**注册进插槽后画出来的表单。Host 侧只提供「可编辑字段投影 + 读写 RPC」，不画界面。
2. **表单字段来源 = 插件导出的 Cordis `Config`（必须是 schemastery 实例），但只投影 `Volatile` 字段。** 没标 `.volatile()` 的字段在界面里根本不存在（连只读展示都没有）。
3. **插件页的"配置"入口是可选的、由注册决定。** 只有当某个 client 插件注册了 `plugins.row.config`、key = `<包名>#<行 id>` 时，那一行才出现 **Configure** 入口。〔码〕`config-ledger.ts:36-38,51-52`、`PluginManagerPage.tsx:279-286,596`
4. **提交写回 profile 的 `cordis.patch.yml`**（`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`），写的是同 id 的覆盖行（非 `insert` 行）；包内 patch 文件永不被写。〔码〕`config-editor/src/index.ts:34,92,117-128`
5. **覆盖行的 `config` 是整体替换，不是深合并**（`target[key] = value`）。已在隔离环境实测复现。〔码〕`vendor/include/src/index.ts:120-123` 〔测〕见 §5
6. **"插件不能 import 宿主包"这条限制对 schemastery 不成立**：`@deepseek-ai/schemastery` 已发布在公共 npm（3.18.5-alpha.1，与运行时 vendor 版本一致），可作为本包普通 dependency 安装。跨副本安全，因为 volatile 判定用 `Symbol.for`。〔测〕+〔码〕`cosmokit/src/volatile.ts:3,52-54`
7. ⚠️ **本插件当前写法会让新声明的 `Config` 被静默忽略**：loader 的 `unwrapExports` 会选 `module.default`，`runtime.Config` 只从被选中对象上读。我们同时有 `export const Config` 和 `export default { name, inject, apply }` → `runtime.Config === undefined`。已实测。修法见 §6。〔码〕`vendor/loader/src/index.ts:201-208` + `vendor/cordis/src/registry.ts:326` 〔测〕

**一句话**：仅改 host 侧代码 → 配置仍**不会**出现在界面（连入口都没有）；要界面可改 = host 侧声明 volatile schemastery `Config` **且** 新增浏览器半侧页面。两者缺一不可。

---

## 1. Q1：插件页/设置页有没有编辑某个插件行 config 的入口？

### 1.1 插件页（Plugins，侧边栏）——有，但需要注册者

`packages/client/ui-plugin-manager` 的页面结构：

- 页面声明三个插槽：`plugins.item`（官方插件卡片）、`plugins.bundle.config`（keyed by 包名）、`plugins.row.config`（keyed by `<包名>#<行 id>`）。〔码〕`PluginManagerPage.tsx:42-46`、`index.ts:123-124`
- **行级配置入口**：`RowsSection` 只在 `configure.has(row)` 为真时把行标题渲染成可点按钮（带 `>` 图标），否则只渲染纯文本。
  〔码〕`PluginManagerPage.tsx:279-286`
- `configure.has` 的来源是 `configLedger.rows`，而它是 `ctx.slots.entries('plugins.row.config')` 里每个 entry 的 `options.key` 集合。
  〔码〕`config-ledger.ts:51-52,66-67`
- 打开后渲染的是**注册者提供的组件**：`renderSlot('plugins.row.config', { view: 'page', form }, { entryKey: key })`，`key = rowConfigKey(pkg.name, row.rowId) = '<包名>#<行id>'`。
  〔码〕`PluginManagerPage.tsx:574,596`、`config-ledger.ts:36-38`
- **行页只在被注册者点名时存在**；没有注册者时，行上只有开关（启用/禁用），没有任何配置入口。
  〔档〕`ui-plugin-manager/README.md:69,93`

结论：对 `@cortexkit/dsh-magic-context#magic-context-dsh` 这一行，**只要没有人注册该 key，用户点进去只能看到行状态和开关，没有任何配置表单**。今天我确认没有这样一个注册者存在（我们没有任何 client 半侧产物）。

### 1.2 设置页（Settings）——只有官方手写 section，没有"所有插件"列表

- `settings.section` 下的每一节都是手写注册的：`ui-settings-general` 注册 General、`ui-settings-plugins` 只提供"Built-in plugins"这一个**外壳**（导航行 + tab 容器），tab 也由别的包注册。
  〔码〕`ui-settings-general/src/client/index.ts:68,76,84,231`、`ui-settings-plugins/src/client/index.ts:76-84`
- 「配置一个内置插件发生在侧边栏的 Plugins 页，由每个官方插件自己的伴生包注册页面」——设置页不承担该职责。
  〔档〕`ui-settings-plugins/README.md:12`
- `ui-settings-plugins` 没有任何 `src/client` 里对 `settings.describe().namespaces` 的枚举。我逐个检查了 `ui-settings-general` 与 `ui-settings-plugins` 的客户端代码，**没有任何"按 schema 遍历命名空间生成页面"的代码路径**。

### 1.3 唯一的"原始文本"兜底入口

`ui-settings-general` 在 loopback 页面上提供「打开配置文件」：调用 `settings/openSettingsDocument`，Host 侧 `settings.prepareDocument()` 返回 `configEditor.documentPath`（即 profile patch 路径），交给系统文本编辑器。
〔码〕`settings-controller/src/index.ts:166-185`、`settings/src/index.ts:292-296`、`ui-settings-general/README.md:78`

即：**能改原始 YAML，但没有表单**。

---

## 2. Q2：表单字段从哪来？（schema → UI 的确切代码路径）

### 2.1 两段式：Host 侧"投影"，Client 侧"手写控件"

**Host 侧（schema → 可编辑字段投影）**

| 步骤 | 位置 |
| --- | --- |
| 遍历 profile 中可被寻址的行（`include` 子级、id 唯一） | `config-editor/src/index.ts:39-44` |
| 给出 `inherited`（继承层）与 `override`（profile 层）值 | `config-editor/src/index.ts:49-80` |
| 取该行的 schema：`entry.fiber.runtime.Config`，且要求 `'toJSON' in schema` | `settings/src/index.ts:425-428` |
| **只保留 volatile 字段**：`volatileForm(schema)` | `settings/src/index.ts:308`、`settings/src/schema.ts:37-47` |
| 投影三份值：`value`（生效值）、`base`（继承值）、`user`（用户层） | `settings/src/index.ts:319-322` |
| 序列化 schema（`form.toJSON()`）与 revision，广播 `settings/document-updated` | `settings/src/index.ts:311,326-327` |

**`volatileForm` 是全部"可编辑性"的判据**：`schema.meta.volatile` 为真才保留该节点，否则递归进 `object` 的 `dict`，两者都不满足 → `undefined`（整个命名空间不服务给前端）。
〔码〕`settings/src/schema.ts:37-47,74-78`

**实测验证**（隔离 TEMP，`@deepseek-ai/schemastery@3.18.5-alpha.1`）：

```
输入 Config = z.object({
  dataDir: z.string(),
  registerCompactionEngine: z.boolean().default(false),
  policy: z.object({
    executeThreshold: z.number().default(0.8).volatile(),
    forceThreshold:    z.number().default(0.95),          // 未标 volatile
    ttlMs:             z.number().default(600000).volatile(),
  }),
  memory: z.object({ project: z.string() }),
})
volatileForm(Config).toJSON() 只包含：
  policy.executeThreshold (meta.volatile=true, default 0.8)
  policy.ttlMs            (meta.volatile=true, default 600000)
```

〔测〕`$env:TEMP\dshtest-*/probe.mjs`。→ **`forceThreshold` 这类普通字段即使写了 schema 也不会出现在界面**。

**Client 侧（投影 → 具体控件）**

| 步骤 | 位置 |
| --- | --- |
| 唯一一次 `settings/describe` 读取（共享镜像，`document-updated` 时刷新） | `ui-settings/src/client/settings-mirror.ts`、`ui-settings/src/client/index.ts:43`、`README.md:62` |
| 按命名空间取表单（值/继承值/用户层/revision）| `ui-settings/src/client/config-form.ts:293-302,186-209` |
| **每个字段的控件由调用方手写声明**（`SettingsFieldSpec`） | `ui-primitives/src/settings-form/form-model.ts:64-74,156-169,177-186` |
| 渲染（`SettingsForm` 组件） | `ui-primitives/src/settings-form/SettingsForm.tsx:32,50` |

`SettingsFieldSpec` 只有 `{ field, format(value)=>string, parse(text)=>write|undefined }` —— **没有 schema 驱动的自动字段生成**。数字字段工厂 `settingsNumberField()` 接受任意有限数（`Number.isFinite`），所以 `0.8` 这类小数可以使用（不是整数专用）。
〔码〕`form-model.ts:156-169`

### 2.2 `autoGenerate` 目前无人消费

`SettingsDescriptor.autoGenerate` 默认为 `true`，文档明确写道「供按 schema 生成页面的客户端使用；**目前没有已发布的客户端这样做**」。
〔档〕`settings/README.md:39`、〔码〕`settings/src/index.ts:312,325`
我把 `packages/client` 全树按 `autoGenerate` 检索，命中全部是测试与 Host 侧投影，**没有任何生产客户端读取它**。〔测/码〕grep 结果见 §9 复现命令。

### 2.3 官方"同时声明 Config 且界面可编辑"的例子（完整链路）

**agent-loop（子系统上限 `maxParallelToolCalls`）**：

1. Host 行：`- id: agent-loop` / `name: '@deepseek-ai/dsh-agent-loop'` 〔码〕`packages/bundle/base/cordis.patch.yml:511-512`
2. Host Config：`maxParallelToolCalls: Volatile<number>` 〔码〕`packages/core/agent-loop/src/index.ts:297`
3. 伴生 client 包：`packages/client/ui-settings-agent-loop`（Host 半侧是空 `apply`，只为占一行）〔码〕`ui-settings-agent-loop/src/index.ts:1-6`
4. client 半侧绑定命名空间 **= 行 id** `'agent-loop'`，注入 `slots/locale/configForms`：
   〔码〕`ui-settings-agent-loop/src/client/index.ts:36,45,47-49`
   ```ts
   const card = new AgentLoopCardController(ctx.configForms.get(AGENT_LOOP_NS))   // AGENT_LOOP_NS = 'agent-loop'
   ctx.effect(() => ctx.configForms.whileServed([AGENT_LOOP_NS], () => ctx.slots.inject('plugins.item', () =>
     ctx.slots.register({ name: 'plugins.item', id: 'agent-loop', order: 20, label: () => t('title'), locale: NS,
                          inject: () => card.inject() }, AgentLoopCard))))
   ```
5. 字段声明：`new SettingsFormModel(scope, [settingsNumberField('maxParallelToolCalls')])` 〔码〕`agent-loop-card-controller.ts:44-51`

> ⚠️ 注意命名空间是 **Loader 行 id**（`entry.options.id`），不是包名：`settings/src/index.ts:315,326` 用 `entry.options.id as SettingsNamespace`。我们的行 id 是 `magic-context-dsh`，所以将来前端要 `ctx.configForms.get('magic-context-dsh')`。

同类官方例子：`ui-settings-shell`、`ui-settings-subagent`、`ui-settings-web-search`（一个命名空间一个伴生包）〔档〕`ui-plugin-manager/README.md:69,121`。

---

## 3. Q3：提交写回哪里、调用哪个 API、失败如何回滚

### 3.1 完整调用链（自 UI 至磁盘）

```
SettingsForm 保存
  └─ SettingsFormModel.save() → scope.mutate(ops, baseline.revision)
       〔码〕ui-primitives/src/settings-form/form-model.ts:302-315
  └─ ConfigFormController.mutate() → ctx.remote.settings.mutate(ns, ops, revision)
       〔码〕ui-settings/src/client/config-form.ts:134-153（revision 栅栏、失败 recover=重读镜像）
  └─ Remote settings/mutate
       〔码〕api/settings-controller/src/index.ts:151-158,187-213（统一 write()，冲突→settings/conflict，其余→settings/rejected）
  └─ ctx.settings.mutate(ns, ops, expected)
       〔码〕settings/src/index.ts:367-375
  └─ SettingsForms.write()：校验 volatile 路径 → configEditor.edit(entry, change)
       〔码〕settings/src/index.ts:377-423（387-388 校验路径可编辑；390 调用 editor）
  └─ ConfigEditor.edit()：加锁 → reconcile → 解析 YAML → 定位覆盖行 → 原子写
       〔码〕boot/config-editor/src/index.ts:87-154
```

### 3.2 写回位置

- `documentPath = profileContext.patchPath` 〔码〕`config-editor/src/index.ts:34`
- 即 **profile 的 `cordis.patch.yml`**（`loadProfileDirectory` 里 `join(dir, PROFILE_PATCH_FILENAME)`）〔码〕`app-boot/src/profile.ts:761-763`
- 定位写入行：取**最后一个**满足 `id 相同 && !item.has('insert') && (行无 name 或 name 与 entry.name 相同)` 的条目；找不到则 `document.add({ id, name: entry.options.name, config: next })`。
  〔码〕`config-editor/src/index.ts:117-119,127-128`
- 当新值等于继承层时：**删除**该 id 所有非 insert 行的 `config` 键，行变空则整行删除（"回到继承"语义）。〔码〕`config-editor/src/index.ts:120-126`

### 3.3 失败与回滚

| 环节 | 行为 |
| --- | --- |
| 行失效 / 被替换 | `Configuration entry is no longer available` / `changed during reload` / `no longer active` 〔码〕`:94,97,102` |
| 校验 | `resolveConfig(fiber.runtime, next)` 在写盘**之前**跑一遍 schema 校验 〔码〕`:103-104` |
| 被更高优先层覆盖 | 写盘前比对生效值，不等则抛 `Configuration for "<id>" is overridden by a home patch or command-line overlay` 〔码〕`:137-141` |
| **写盘后 reconcile 失败** | **回滚**：把 `before` 原样原子写回，并重放旧 patches 〔码〕`:142-149` |
| 前端并发/版本冲突 | `expectedRevision !== descriptor.revision` → `SettingsConflictError` → 远端 `settings/conflict`，前端 `recover()` 重读镜像 〔码〕`settings/src/index.ts:393-395`、`settings-controller/src/index.ts:257-268`、`config-form.ts:155-160` |

写入是原子的且串行化在 HMR 排他锁内：`writeFileAtomic(path, ..., { mode: 0o600 })` + `hmr.runExclusive(run)`。〔码〕`:142,152-153`

---

## 4. Q4：不 import schemastery 能否声明可编辑配置？

### 4.1 Cordis loader 怎么消费 `Config`

```ts
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)   // Standard Schema
  ...
}
```
〔码〕`vendor/cordis/src/fiber.ts:50-62`

所以 **loader 本身只要求 Standard Schema**（纯 JS 对象理论上能满足）。但还有另外两个消费者：

1. `settings.schema(entry)` 要求 `'toJSON' in schema`，随后用 schemastery 专有 API：`schema.meta`、`schema.type/dict/inner/list`、`new z(schema.toJSON())`、`z.object(dict)`。
   〔码〕`settings/src/index.ts:425-428`、`settings/src/schema.ts:19-47,74-78`
2. loader 保存配置时调用 `runtime.Config['simplify']`；volatile 差分比较 `equalExceptVolatile` 会把 schema 收窄为 Schemastery 类型。
   〔码〕`vendor/loader/src/index.ts:117-118`、`vendor/loader/src/config/diff.ts:7,43`

**结论：纯 JS 对象字面量当 schema 不可行**——loader 能过，但设置服务与浏览器侧都不认（浏览器侧还用 `schema.rehydrate` 重建 schemastery：`ui-settings/src/client/config-form.ts:218`、`schema.ts`）。

### 4.2 但"装不上 schemastery"的假设是错的——实测可装

- `vendor/schemastery/package.json`：`@deepseek-ai/schemastery`，`publishConfig.access = "public"`，版本 `3.18.5-alpha.1`。
- 公共 npm 上确实有：`3.18.1-rc.1 … 3.18.5-alpha.1`（与本仓库 vendor 版本一致）。〔测〕`npm view @deepseek-ai/schemastery versions`
- 隔离目录 `npm install @deepseek-ai/schemastery@3.18.5-alpha.1` 成功（连带 `@deepseek-ai/cosmokit`，共 10 个包，6s）。〔测〕
- 跨副本安全：volatile 引用协议用 `Symbol.for('cosmokit.volatile.write')` 判定，ESM/CJS 多副本可互认。〔码〕`vendor/cosmokit/src/volatile.ts:3,52-54` 〔测〕本地实测 `Symbol.for(...) in value` 为 `true`。

> 这与"profile 插件无法 import 宿主包"（`@deepseek-ai/dsh-tools` 等）不冲突：那些包**不在本包 node_modules 里**，而 schemastery 可以真正安装为本包依赖，且它是无状态纯库，重复副本不产生双实例问题。

### 4.3 兜底方案（做不到 schema 时）

只能编辑**原始 YAML**：

- 用户手动编辑 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`（配置改动实时生效）；
- 或用 Settings → General 的「打开配置文件」（若该页面可用）走系统编辑器。〔码〕`settings-controller/src/index.ts:166-185`

---

## 5. Q5：rowId 与 patch 的对应关系、优先级、推荐做法

### 5.1 两个层

| 层 | 内容 | 谁写 |
| --- | --- | --- |
| 包内 patch（`packages/dsh-plugin/cordis.patch.yml`） | `- insert: [{ id, name, config }]` | 仓库维护者（发布物） |
| profile patch（`cordis.patch.yml`） | `- id: <rowId>` 覆盖行（`disabled` / `config` / …） | 用户 / plugin-manager / configEditor |

组合顺序：**各 bundle layer（按 `dsh.profile.bundles` 顺序）→ profile `cordis.patch.yml` → `--patch` overlay**。
〔码〕`app-boot/src/profile.ts:740-765`、`config-editor/src/index.ts:57`

### 5.2 覆盖语义 = 整键替换（**这条最容易踩**）

`applyEntryPatches` 对非 insert 补丁：

```ts
for (const [key, value] of Object.entries(overrides)) {
  if (key === 'id') continue
  target[key] = value          // ← 整个 config 对象被替换
}
```
〔码〕`vendor/include/src/index.ts:120-123`

**实测复现**（隔离 TEMP，直接调用已发布的 `@deepseek-ai/cordis-plugin-include`）：〔测〕

```js
applyEntryPatches(
  [{ id:'magic-context-dsh', name:'@cortexkit/dsh-magic-context',
     config:{ registerCompactionEngine:false, policy:{ executeThreshold:0.8, forceThreshold:0.95 } } }],
  [{ id:'magic-context-dsh', config:{ policy:{ executeThreshold:0.5 } } }],
  warn)
// => [{ id:'magic-context-dsh', name:'@cortexkit/dsh-magic-context',
//       config:{ policy:{ executeThreshold:0.5 } } }]
// registerCompactionEngine 与 forceThreshold 全部消失
```

这与我们在真实 profile 上观察到的现象一致（只写 `memory:` 就抹掉了 `registerCompactionEngine: false`）。**GUI 编辑走的是同一条 `configEditor.edit()` 路径，写入 profile 覆盖行的完整 config，因此同样遵守"整体替换"语义。** 唯一区别：`settings.write` 会先把当前 `entry.options.config`（已解析的生效值）投影成表单字段，再把**非 volatile 字段原样 strip 回来**合并（`strip(raw, form)` + `mergeLayers`），因此通过表单保存时普通字段会被保留：
〔码〕`settings/src/index.ts:396-420`

即：
- **手写 YAML**：必须重复所有想保留的键（整体替换）。
- **界面表单保存**：`settings.write` 会把不可编辑的普通字段从当前值 strip 出来再合并回去，普通字段**不会**被抹掉；但 volatile 字段是整体由表单决定的。

### 5.3 rowId / key 对应

- `BundleInfo.rows[].rowId` = 包内 patch `insert` 行的 `id`；`overrides[]` = profile 里 id 不属于上述 rows 的条目。
  〔码〕`boot/plugin-manager/src/index.ts:648-676`
- 上述 rows 来自 `flatten(composeEntries([patches.filter(item => item.insert !== undefined)]))`。
  〔码〕同上 `:664`
- UI 配置 key = `${包名}#${rowId}` 〔码〕`config-ledger.ts:36-38`
  → 我们是 `@cortexkit/dsh-magic-context#magic-context-dsh`。
- 行可寻址性（开关能否落到 patch）要求：id 唯一、`name` 与被保护模块匹配、且父级是 `include`；否则标 `unaddressable` / `management-required`。
  〔码〕`plugin-manager/src/index.ts:256-271`

### 5.4 推荐做法

- 用户改的值**必须**落在 profile 层：`configEditor` 只写 `profileContext.patchPath`，从不写包内 patch ✓ 〔码〕`config-editor/src/index.ts:34,92,117-128`
- 包内 patch 只放**默认值**（可被整体替换的那份）；profile 覆盖行写**用户全量**配置。
- 我们的 profile 行 `- id: magic-context-dsh`（无 `name`）可被 `configEditor` 正确定位（name 缺省即匹配）〔码〕`config-editor/src/index.ts:117-119`。

---

## 6. Q6：magic-context 阈值最小改造配方

### 6.0 现状与差距

| 需求 | 现状 | 差距 |
| --- | --- | --- |
| Host 侧 schema | 只有 TS `interface MagicContextDshConfig`，无运行时 `Config` | ❌ 必须新增 `export const Config`（schemastery） |
| schema 可编辑字段 | —— | ❌ 目标字段必须 `.volatile()` |
| loader 认到 `Config` | `export default { name, inject, apply }` | ❌ 会让 `runtime.Config` 为 undefined（实测） |
| 插件值读取 | 直接读 `config.policy.executeThreshold`（数字） | ❌ volatile 后是 `{get()}` 引用对象 |
| 界面 | 无 client 半侧 | ❌ 无入口 |

### 6.1 修改 `packages/dsh-plugin/package.json`

```jsonc
{
  "dependencies": {
    // 与运行时 vendor 版本对齐；纯库，允许重复副本
    "@deepseek-ai/schemastery": "3.18.5-alpha.1"
  },
  "exports": {
    ".": { "default": "./lib/index.js" },
    // 只有要做界面时才需要下面两行
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    // 只有要做界面时才需要：声明浏览器半侧
    "client": { "platform": "web" }
  }
}
```
- `files` 已含 `lib`，无需改。
- `dsh.client` 的合法字段只有 `platform`（必填 string）、`inject`、`external`、`immediately`；解析器会拒绝其它形状。〔码〕`client/modules/src/client/manifest.ts:161-181`
- `dsh.client` 声明了但 `exports["./client"]` 缺失 → Host 侧扫描直接抛错。〔码〕`client/modules/src/index.ts:847,194-204`

### 6.2 修改 `packages/dsh-plugin/src/index.ts`（host 侧）

**第一步**：`import z from '@deepseek-ai/schemastery'`

**第二步**：把 TS 接口对应成运行时 schema，**每个界面要改的字段都 `.volatile()`**，并给 `default`（默认值会显示在表单里；不给 default 的字段在表单里显示为空）：

**好消息（已实测）**：schemastery 的 `z.object` **不丢弃未声明的键**——`validate({unknownKey:42, policy:{t:2, extra:3}})` 返回的 value 里 `unknownKey` 与 `policy.extra` 都还在、且不报 issue。〔测〕`strip.mjs`。所以**可以只声明需要暴露的字段**，`defineTool`（函数）、`compactionBase`、`historian` 等一律不必进 schema，它们会原样保留并继续传给 `apply`。

```ts
export const Config = z.object({
  // 未在此声明的键（dataDir / defineTool / compactionBase / historian / registerTools …）
  // 会被 schemastery 原样透传，无需重复声明
  historianEnabled: z.boolean().default(false).volatile(),
  registerCompactionEngine: z.boolean().default(false).volatile(),

  journal: z.object({
    enabled: z.boolean().default(false),
    level: z.string().default('info'),
    retentionDays: z.number().default(30).volatile(),     // ← 可编辑
    mirror: z.boolean().default(false).volatile(),        // ← 可编辑
  }),

  memory: z.object({
    dbPath: z.string(),
    project: z.string(),
    autoPromote: z.boolean().default(false).volatile(),   // ← 可编辑
  }),

  policy: z.object({
    executeThreshold: z.number().min(0).max(1).default(0.8).volatile(),
    forceThreshold:   z.number().min(0).max(1).default(0.95).volatile(),
    ttlMs:            z.number().default(600_000).volatile(),
    baselineTokens:   z.number().default(20_000).volatile(),
    memoryBudgetTokens: z.number().default(4_000).volatile(),
    memoryLimit:      z.number().default(200).volatile(),
  }),
})
```

> 规则：**嵌套对象本身不标 volatile**，标记放在叶子字段上（volatile 字段要求固定对象路径，不能处在另一个 volatile 字段内部）。〔码〕`vendor/schemastery/src/index.ts:493-496,521-523`
> `settingsNumberField` 接受任意有限数，`0.8/0.95` 这类阈值可直接用。〔码〕`form-model.ts:156-169`

**第三步（关键陷阱）**：让 loader 真正看到 `Config`。当前 `src/index.ts:658` 是 `export default { name, inject, apply }`，loader 的 `unwrapExports` 会选 `default` 对象，`runtime.Config` 取自**被选中对象**，具名 `Config` 会被忽略。〔码〕`loader/src/index.ts:201-208` + `cordis/src/registry.ts:326`

两种改法（任一即可）：
```ts
// A. 把 Config 放进 default（改动最小，推荐）
export default { name, inject, apply, Config }

// B. 删掉 default，改为官方样式（只用具名导出）
export const name = 'magic-context-dsh-poc'
export const inject = ['tools', 'llm']
export const Config = z.object({ /* ... */ })
export async function apply(ctx, config) { /* ... */ }
```

**实测**（隔离 TEMP，真实 ESM 模块 + `@deepseek-ai/cordis@4.0.4`）：〔测〕

| 模块形状 | `pickedDefault?` | `runtime.Config` | `fiber.config.policy.executeThreshold.get()` |
| --- | --- | --- | --- |
| 仅具名导出（含 `Config`） | false | ✅ 存在 | `0.8` |
| 具名 `Config` + `export default {name,inject,apply}` | true | ❌ undefined | `undefined` |
| `export default {name,inject,apply,Config}` | true | ✅ 存在 | `0.8` |

**第四步**：运行时读取方式改变。标了 `.volatile()` 的字段在 `apply(ctx, config)` 里**不再**是 `number`，而是 `Volatile<number>` 引用：〔码〕`vendor/schemastery/src/index.ts:245-249,769`
- 官方写法是在使用点即时 `.get()`（示例：`web-search-deepseek/src/index.ts:140-144` 每次构造 provider 时 `config.model.get()`）；〔码〕
- 我们最小改动：在 `apply` 内做一次 `const policy = { ...DEFAULT_POLICY, executeThreshold: config.policy.executeThreshold.get(), ... }` —— 但这样**界面改动不会生效到已启动的实例**（volatile-only 修改只是把新值提交进引用，不会重挂 fiber，见 §7）。要"改了立刻生效"，必须把阈值读取改成每次决策时 `.get()`（例如把 `DEFAULT_POLICY` 的合并下沉到一个 `policyOf(config)` 函数，在 `decidePass` 调用点求值）。

**包内 `cordis.patch.yml`**：无需写 schema（schema 只来自代码导出）。建议留默认值：
```yaml
- insert:
    - id: magic-context-dsh
      name: '@cortexkit/dsh-magic-context'
      config:
        registerCompactionEngine: false
```

**profile `cordis.patch.yml`**：**不要**写 schema；但因为是整体替换，必须重复所有要保留的键（当前用户 profile 已经这么做了，且带注释说明）。

### 6.3 新增浏览器半侧（只有这一步才能"出现在界面"）

没有这一步，host 侧 schema 再完整，用户也**看不到任何入口**（§1）。

1. 新文件 `packages/dsh-plugin/src/client/index.ts`（browser half，模式照抄 `ui-settings-agent-loop/src/client/index.ts:36-49`）：

```ts
export const inject = ['slots', 'configForms']

export function apply(ctx) {
  const NS = 'magic-context-dsh'                        // ← Loader 行 id，不是包名
  const form = ctx.configForms.get(NS)
  const model = new SettingsFormModel(form, [
    settingsNumberField('policy.executeThreshold'),     // 注意：字段名是 section 内的路径
    settingsNumberField('policy.forceThreshold'),
    settingsNumberField('policy.ttlMs'),
  ])
  ctx.effect(() => () => model.dispose(), 'magic-context: form')
  ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register({
      name: 'plugins.row.config',
      key: '@cortexkit/dsh-magic-context#magic-context-dsh',   // ← 包名#行id
    }, Card))), 'magic-context: page')
}
```

> ⚠️ 待确认细节：`SettingsFieldSpec.field` 是**扁平字段名**（`form-model.ts:64-66` 注释为 "Field name inside the namespace section"），官方例子里字段都在 section 顶层。嵌套路径（`policy.executeThreshold`）能否直接作为 `field` 需要一次冒烟验证；若不支持，可用自定义 `SettingsFieldSpec`（`{field:'policy', format: v => String(v?.executeThreshold ?? ''), parse: ...}`）整段处理，或把阈值提到 section 顶层。**这一点我没有实测。**
> 另外：如果不想引 `ui-primitives` 的 `SettingsFormModel`，也可以只用 `ctx.configForms.get(NS).set('policy', {...})` 直接提交整段（`config-form.ts:114-116`），自己画 `<input>`。

2. 产出 `lib/client.js`，格式是**闭包工厂包装**（tsdown 的固定输出契约）：

```js
window.__ModuleLoader__.load({
  id: "@cortexkit/dsh-magic-context",
  factory: (require) => {
    const React = require('react')
    // ...
    return { inject: [...], apply }
  },
})
```
〔码〕`packages/client/tsdown.client.ts:2-3,617-618`
- **好消息**：`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit` 都在 shell 的静态模块表里（`PLATFORM_MODULES`），可直接 `require`，**不需要** `dsh.client.external`。〔码〕`packages/client/web/src/platform.ts:8-14`
- **坏消息**：官方构建预设 `@deepseek-ai/dsh-client-tsdown`（即 `packages/client/tsdown.client.ts`）**未发布到 npm**（〔测〕`npm view` → E404），且它是 monorepo 内文件。第三方需要自己写 esbuild/tsdown 包装脚本产出上面那个 `__ModuleLoader__.load` 外壳（或在发行包里手写这份 artifact 并冒烟验证）。
- Host 侧只服务 `exports["./client"]` 指向的文件，路由为 `/plugins/<包名>/client.js`。〔码〕`client/modules/src/index.ts:194-204,229-236`

3. 无需额外重建 DSH：`clientModules` 扫描**已启用的 Loader 行**里声明了 `dsh.client` 的包；我们的行 `name` 恰为 `@cortexkit/dsh-magic-context`，满足"说明符恰为包名"的挂载条件。〔档〕`ui-plugin-manager/README.md:121`

### 6.4 改完是否 HMR 即时生效？

| 改动 | 生效方式 |
| --- | --- |
| profile `cordis.patch.yml` 的值 | **实时**：写盘后 configEditor 触发 Loader reconcile；volatile-only 变更**不重挂 fiber**，直接把新值提交进运行中的 `Volatile` 引用并 emit `loader/volatile-update` 〔码〕`vendor/loader/src/config/entry.ts:145-191`、`vendor/loader/README.md:53` |
| host 侧 `src/index.ts`（`Config`/读取方式） | 需 `tsc -p tsconfig.build.json` 重新构建 `lib/`。profile patch 里已有 `hmr.root: <path>`，因此**重建后热重载**；未启用 hmr 时需重启 app。〔码〕`<path>` 的 `hmr` 行 |
| client 半侧 `lib/client.js` | 需重新构建 + **刷新页面**；`client-modules` 通过 `/plugins/events` SSE 与 `clientModules.rebuilt(id)` 支持热替换（需 hmr 客户端行启用），否则刷新即可 〔码〕`packages/client/hmr/src/index.ts:77,130-196` |
| `package.json` 的 `dsh.client` / `exports` | 属于 Host 扫描输入，改后建议重启 app（会话上下文中 client-plugin HMR 仅在 `pnpm run dev:web` 同源监视时免刷新） |

**结论**：数值改动是**即时**的（前提：插件在每次使用点 `.get()`）；代码改动 host 半侧靠 hmr.root 热重载，client 半侧需要重建 + 页面刷新。

---

## 7. 做不到的路径清单（省得再试）

1. **不写浏览器半侧，只声明 `Config`** → 插件页连"Configure"入口都不出现，设置页也没有对应 section。`autoGenerate` 今天无人消费。〔档〕`settings/README.md:39`、〔码〕`config-ledger.ts:51-52`
2. **不声明 schemastery `Config`** → `settings` 不服务该命名空间；任何页面调用 `ctx.configForms.get(ns)` 只能拿到 `unavailable`；Host 侧写操作抛 `No configurable plugin entry "<id>"`。〔码〕`settings/src/index.ts:382-386`
3. **声明了 `Config` 但字段没标 `.volatile()`** → `volatileForm` 返回 `undefined`，整个命名空间不被服务；写操作抛 `Plugin entry "<id>" has no volatile fields`。〔码〕`settings/src/index.ts:308-309,385-386`、`schema.ts:37-47`
4. **用纯 JS 对象字面量当 schema** → loader 能过（Standard Schema），但设置服务需要 `toJSON`/`meta`/`dict`，浏览器侧还需要用 schemastery rehydrate；不成立。
5. **在不安装 schemastery 的前提下声明 `Config`** → 只有手写一个完整 schemastery 兼容对象才可能，代价高于直接安装依赖，不建议。
6. **期望在 profile patch 里写 schema** → schema 只能来自插件的 `Config` 导出；patch 只能写**值**。
7. **期望改包内 `cordis.patch.yml` 就能"让用户改的值持久化"** → 界面写入只落 profile 层；改包内文件会在 `pnpm install`/重装时丢失，且违反"用户值必须在 profile 层"的原则。
8. **指望 `settings/describe` 的 `schema` 自动生成表单** → 目前无任何已发布客户端这么做。

---

## 8. 未闭环项 / 证据等级

| 事项 | 等级 |
| --- | --- |
| 覆盖行 config 整体替换（非深合并） | 【已实测】隔离环境直接调用 `applyEntryPatches`，结果与真实 profile 现象一致 |
| `@deepseek-ai/schemastery` 可从公共 npm 安装、`.volatile()` 行为、`toJSON` 带 `meta.volatile`、`volatileForm` 只留 volatile 字段、`z.object` 透传未声明键 | 【已实测】隔离 TEMP 脚本 |
| `export default {...}` 会吞掉具名 `Config` | 【已实测】真实 ESM 模块 + cordis 4.0.4 |
| 写回 profile patch、回滚、冲突分类 | 【源码级】config-editor / settings / settings-controller / settings-controller 四层代码路径 + 对应单测存在（`packages/settings/settings/tests/editor-failures.spec.ts` 等） |
| 插件页 Configure 入口由 `plugins.row.config` 注册决定 | 【源码级】config-ledger + PluginManagerPage + README |
| 无通用/自动配置界面 | 【源码级 + 文档级】settings README 明确"no shipped client does so yet"；未逐个客户端包穷举 |
| **绑定嵌套字段路径（`policy.executeThreshold`）能否作为 `SettingsFieldSpec.field`** | **未验证**，需冒烟 |
| **手写 `lib/client.js` 闭包工厂外壳在真实运行时可用** | **未实测**（仅按 tsdown 输出契约推导） |
| **隔离 profile 里端到端跑通"插件页出现 Configure → 保存 → 写入 patch"** | **未做**（未在用户的 desktop profile 上做实验，也未在隔离 DSH_HOME 建可 boot 的 profile 验证 settings/describe 端到端） |

---

## 9. 复现命令（本次实测）

```powershell
# 1) schemastery 发布情况
npm view @deepseek-ai/schemastery versions --json

# 2) 隔离探针（不触碰任何 profile）
$t = "$env:TEMP\dshtest-<rand>"
npm install --prefix $t @deepseek-ai/schemastery@3.18.5-alpha.1 @deepseek-ai/cordis-plugin-include @deepseek-ai/cordis
#   probe.mjs       → applyEntryPatches 覆盖语义 + volatileForm 投影
#   strip.mjs       → z.object 是否透传未声明键（结论：透传）
#   unwrap2.mjs     → 两种导出形状下 runtime.Config 是否可见
#   default-with-config.mjs → Config 放进 default 对象后可用

# 3) 源码定位
#   config-editor/src/index.ts:87-154        写回与回滚
#   settings/src/index.ts:302-340,377-428    describe / write / schema
#   settings/src/schema.ts:37-47,74-78       volatileForm / isVolatilePath
#   vendor/include/src/index.ts:120-123      patch 覆盖语义
#   client/ui-plugin-manager/src/client/config-ledger.ts:36-38,51-52
#   client/ui-plugin-manager/src/client/PluginManagerPage.tsx:279-286,596
#   client/ui-settings-agent-loop/src/client/index.ts:36-49   官方最小页面范例
```

---

## 10. 最小改造配方（TL;DR 版）

1. `package.json`：加 `"@deepseek-ai/schemastery": "3.18.5-alpha.1"`；要做界面再加 `exports["./client"]` + `dsh.client = {"platform":"web"}`。
2. `src/index.ts`：`export const Config = z.object({...})`，**每个界面要改的叶子字段加 `.volatile()` 和 `.default()`**（未声明的键透传，可只声明要暴露的部分）；把 `Config` 放进 `export default { name, inject, apply, Config }`（否则 loader 看不到）。
3. `src/index.ts`：阈值读取改为使用点 `config.policy.executeThreshold.get()`（volatile 引用；这也是"改了立刻生效"的前提）。
4. 包内 patch 只留默认值；profile patch 因为是整体替换，必须重复所有要保留的键。
5. 要做界面：新增 `src/client/index.ts`，`ctx.configForms.get('magic-context-dsh')` + `ctx.slots.register({ name:'plugins.row.config', key:'@cortexkit/dsh-magic-context#magic-context-dsh' })`；用自备打包脚本产出 `lib/client.js`（`window.__ModuleLoader__.load({id, factory})` 外壳）；`react`/`ui-primitives` 走静态模块表，无需 `external`。
6. 生效：数值改动即时（volatile 提交，不重挂）；host 代码重建后经 `hmr.root` 热重载；client 半侧重建后刷新页面。
