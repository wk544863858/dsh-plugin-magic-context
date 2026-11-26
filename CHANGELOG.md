# 更新日志 / Changelog

本文件记录本仓库面向公众的版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

这是一个 **DeepSeek Harness（DSH）适配器**仓库，不是 magic-context 本体：它把
[magic-context](https://github.com/cortexkit/magic-context)（MIT，Copyright (c) 2025 Ufuk Altinok）
的上下文管理与记忆能力移植到 DSH 的插件 / surface 体系上。代码出处、被 vendored 的第三方文件与
钉住的上游 revision 见 [NOTICE](NOTICE)；上游自身的变更历史请见上游仓库。

## [0.11.3] - 2026-11-26

**注入的记忆不再被误当成用户对当前轮次的要求。** 起因是一个实际观察到的现象：注入的记忆块与用户
原话在同一处被送进模型，wire 上二者完全不可分，模型有时会把某条历史记忆当成「用户现在要求我这样做」。
本版在注入块内加了一段自述 frame，并把长期处于死代码状态的指令型候选门禁接回生产路径。

### Fixed

- **注入块自带自述 frame**：记忆块此前紧贴在用户原话前面、同处一条 user 消息，而 DeepSeek 序列化
  会把相邻的同角色消息合并成一整条，`source` 标记在 provider 侧被彻底丢弃——模型能看到的只有裸标签，
  没有任何依据判断这段文本的来源与效力。现在块首写明三段语义：这是**检索到的记录、不是新请求**；
  其中的约束与决定是**既往会话中已达成且仍然有效**的；与用户当前消息冲突时**以当前消息为准**，并应
  指出被搁置的是哪条记录。
- **分节标签词表纠正**：减少上下文引导（reduce guidance）里列举的标签名与实际渲染不一致——把复数
  `<project-memories>` 写成单数，且 9 个渲染标签里漏了 6 个。现由同一份词表生成，不再靠手工同步。
- **记忆内容不能伪造区块边界**：记忆行此前只压缩空白、不做任何转义，而同类内容的 `memory-updates`
  渲染早已转义。一行含 `</project-memories>` 的记忆会提前终止所在分节，含 `<system-reminder>` 的
  则能伪造一条宿主口吻的提醒；由于注入块每个会话都会读到，这条路径实际可跨会话污染。现在只中和
  **真正能伪造结构的两类**：本块使用的闭合标签，以及 `<system-reminder>` 的开闭形态。**开标签刻意
  放行**——块是纯文本而非 DOM，`<project-memories>` 这类开标签不终止任何分节、没有伪造能力。实测语料
  4607 条活跃记忆中，闭合标签 0 个、`<system-reminder>` 2 个，开标签却有 50 个；首版连开标签一起改写，
  结果 20 条受影响记忆里 19 条是**记录渲染器输出标签的文档型记忆**被改成 `‹project-memories›` 而失去
  精度，真正被保护到的只有 1 条。收窄后受影响行 20 → 1。存储始终保留原文，转义只发生在渲染层。
- **指令型候选门禁接回生产路径**：画像候选的形状检查与确认队列在 0.6.0 就已存在，但
  `gateProfileCandidate` 在生产代码里**零调用**——门禁是死代码，历史学家的两条入池路径（facts 与
  userObservations）都不经形状检查，而画像会注入每一个会话。本次把它接进画像评审，并修掉三处实测缺陷：
  ①**只看晋升文本会被改写绕过**——评审被要求把候选合并、改写成独立陈述，「始终用中文回答」这类祈使句
  常被改写成描述句，规则就被洗进画像；现在同时检查所有贡献候选。②**批准按文本匹配则永不生效**——晋升
  文本是改写后的新措辞，与候选原文对不上；现在按候选 id 匹配，且要求每个指令源都获批准，一条批准不能
  担保拼接进人类没看过的内容。③**分类器漏判**——补上 `always answer in Chinese` 这类句式（
  动词-沟通类与句首祈使类，祈使锚定行首，避免误伤「用户用中文书写」这类描述句）。
  次序上门禁排在跨会话复现门之后，否则注定落不了的晋升会白发问题；被扣下的候选一律不消费，批准后下一轮
  仍可落地。
- **注入块遥测**：基线 journal 行新增 `frame` 字段，可直接查出改造覆盖进度；记忆召回的 journal 行在
  实际发生中和时记录被改写的标签数——否则正则一旦静默失效，表现与「语料本来就干净」完全相同，这道防线
  会无声消失。画像评审在候选池堆积到批窗口上限时打一条告警：被扣下的候选不消费、池按创建时间取前 40，
  堆积会静默饿死新候选。

### Notes

- frame 是静态文本、不参与记忆摘要计算，因此**不会触发强制基线重建**，只在下一次执行档的软刷新时随该次
  刷新落地——已有历史会话不会立即生效，需各自达到压力阈值。实测改造后 5 个会话在一天内带上 frame，
  88 个含注入块的会话中其余仍在等待各自的重建时机。这属预期行为，不是故障。
- 存量画像中仍有 3 条被判为指令型（改造前越权进入的），本版只防新增；是否退役请自行决定。
- 上游跟进状态不变：本版未改动任何上游对齐核心文件，最近一次上游跟进仍是 0.11.2 所记录的
  v0.49.30→v0.49.50 复查结论，此后未再跟进新的上游提交。代码提取基线（NOTICE 所述 v0.46.0）不受影响。

## [0.11.2] - 2026-11-11

**后台车道不再会静默停摆。** 跟进上游 magic-context v0.49.50（区间 v0.49.30→v0.49.50，375 个非 merge
提交）后，修掉三处我们自己代码里成立的缺陷：维护车道可能因一次不返回的模型流而永久停摆、verify 的
`skip` 判定不留痕导致候选池原地打转、压缩后仍拿过期压力读数二次丢弃上下文。

### Fixed

- **维护车道不再可能静默永久停摆**：verify 与画像评审的模型调用此前没有任何墙钟上限，而维护定时器
  的 interval 是在**首个 tick 的 `finally`** 里才安装的——一次永不 settle 的 provider 流会让 TTL 过期、
  记忆 verify、画像评审、向量回填在本进程生命周期内全部停摆，且面板只显示「从没跑过」。现在两个调用
  各带 120 秒预算（`withDeadline`：abort 释放连接 + `Promise.race` 兜住不响应 signal 的 seam），调度
  改为在首个 tick 之前就装上 interval，并额外记录「单次 tick 超过一个 interval」的 warn 行。
- **verify 的 `skip` 判定会被记住**：模型判定「仅凭文本无法判断」的行此前只会计数、不落任何状态，而
  候选池固定取 16 行 unverified——一旦累积到 16 条这样的行，每 tick 都会重复提问同一批、新记忆永远
  得不到判定，且每次都付一次模型调用。现在 skip 以内容哈希记进 `metadata_json`（状态仍是 unverified，
  skip 属于不确定而非结论），扫描时跳过已记住的行；内容一经修改（含 stale 重写、人工编辑）哈希失配，
  该行自动回到池中。
- **force band 不再对过期的压力读数二次丢弃**：使用量读数描述的是 provider 实际服务的那份 prompt，一旦
  压缩写入 compartment 或基线重冻，那份 prompt 就不存在了。此前读数不会因此作废，压缩后的下一步仍可能
  按旧百分比再丢一批本可保留的工具结果（不可逆）。现在读数早于最近一次历史变更时，force band 只记一行
  `skipped-stale-reading` 审计、不再回收；execute 决策仍照旧使用该读数（没有更新的信号可用）。

### Changed

- 文档口径校正：`maintenance.ts` 顶部关于上游 dreamer 扫描范围的说明已按上游 v0.49.50 更正（上游也只扫
  宿主进程已打开的项目）；`policy.ts` 把「缓存过期即进入 execute 带」显式标注为**已论证的分歧**——上游
  v0.49.44 移除了该分支，理由是重建会丢 signed thinking 并提前折叠 m[0]，而这两项成本在 DSH 侧都不存在，
  且适配器没有 `/ctx-flush` 等价杠杆来手动落地排队中的 `ctx_reduce`。

## [0.11.1] - 2026-11-07

**设置卡片目录自检。** 修复卡片把有效路由钉误标为 `(not in catalog)`：移除或改名 provider
后打开设置卡片，不会再拿过期目录比对配置值。

### Fixed

- 设置卡片不再把有效路由钉误标为 `(not in catalog)`：卡片挂载时若模型目录缓存已超过 60 秒
  就先重读一次宿主目录（`ensureFresh`）。此前目录只在 `llm/models-updated` /
  `connection/reset` 事件到达时刷新，卡片若错过事件（例如在移除/改名 provider 之后才打开），
  就会拿旧目录比对配置值，把实际存在的 `zth-anthropic/deepseek-flash` 标成不在目录中。
  事件驱动的即时刷新语义不变，只是补上了「打开时自检」这一层。自检阈值提为命名常量
  `MODEL_CATALOG_MAX_AGE_MS`（60 秒），便于按部署节奏调整。

## [0.11.0] - 2026-11-06

**设置卡片路由钉与门面重排。** 两类后台生成路由（维护 verify 与生成 historian）可以在设置
卡片里从宿主模型目录直接钉住或清空；画像评审的「无事可做」跳过改为每天一条 journal 心跳；
README 双语门面按「30 秒可装 → 5 分钟可感」重排并配实拍截图。

### Changed

- README 门面吸引力重排（双语同步）：npm registry 一行安装前置（源码构建降为开发子节）、
  新增「快速上手」（含 `ctx_reduce` → `[dropped §N§]` → `ctx_expand` 真实参数示例）、英文版
  补痛点引子与状态行、移除首段指向 DSH 的失效链接记号（DSH 无公开仓库页）、新增 npm version
  badge、能力表机制列短语化（镜像链/水位/内部日期细节下沉）、修正「`memory: {}` 才启用记忆
  车道」的过时说法（0.9.0 起默认开启，退路为 `memory.enabled: false`）、去除硬编码版本号与
  用例数；「界面与遥测」一节插入设置卡片与遥测胶囊面板实拍截图（`docs/img/`，README 用
  raw.githubusercontent 绝对 URL 引用，npm 页面可渲染且不增包体积）。
- 画像评审 pass 的「无事可做」跳过不再静默：`no-candidates` / `too-few` / `too-few-sessions`
  现在各打一条 info journal 心跳行，并同时写 24h 节流戳（`profile_last_review_at`）——每天恰好
  一条评审记录，journal 里的安静不再可能被误读为「车道死了」，也顺带消除了 `too-few-sessions`
  在池长期单会话时每 30 分钟重复打日志的隐患。失败类跳过（`llm-off` / `llm-failed` /
  `invalid-output`）语义不变：不写戳、下个 tick 重试。
- README 拆分为双语：`README.md` 默认英文完整版，`README.zh-CN.md` 中文完整版，顶部互链；
  门面重写为记忆优先的叙事（项目记忆/本地向量/共享域在前，上下文管理在后），版本与测试数据
  同步刷新（0.10.1 / 上游 v0.49.30 / 宿主 0.2.2-rc.1 / 782 用例）。

### Added

- 设置卡片新增**两档生成路由钉**（维护 / 生成两类，均成对生效）：
  - `maintenance.verifyProvider` / `verifyModel` — 元数据类后台（verify/评分/自动归档分类/画像审阅）；
  - `historian.provider` / `model` — 生成类后台（historian 带外摘要 + `/compact` 摘要，此前只能跟随会话路由）。

  两组都从宿主已配置的模型目录（客户端 `remote.session.modelCatalog()`）下拉选择，带「Auto = 跟随
  会话路由」与一键清空；宿主不提供该 RPC 的 shell 退回纯文本输入（值仍可手填）。切换 provider 时自动
  清掉不属于它的旧 model 草稿；保存按「成对钉住 / 成对清空」写回，语义与 host 的 pin 判定一致
  （`maintenance-wiring.ts`、`liveRoute`：两者都非空才钉住）。`historian.{provider,model}` 现已由
  Config schema 声明，并在 pre-step、compaction engine、`/ctx-recomp` 三条路径上**实时读取**（改配置
  下一次调用即生效）；空值 = 保持原有「跟随会话」行为。

## [0.10.1] - 2026-11-05

**发布链路切换。** 本版本没有运行时代码变更，内容是把 npm 发布认证从一次性 token 切换到
npm Trusted Publishing（OIDC）：仓库不再保存任何 npm 凭据，发布由 GitHub Actions 的 OIDC
身份授权，provenance 签名保持不变（本版本即 trusted publisher 的首次验证发布）。

### Changed

- `.github/workflows/release.yml`：移除 `NODE_AUTH_TOKEN` 与 `NPM_TOKEN` secret 依赖，发布改由
  OIDC 授权；npmjs.com 的 trusted publisher 绑定到本仓库的 `release.yml`

## [0.10.0] - 2026-11-05

**首个 npm 制品版本。** 自 0.9.0 起的累积变更；从本版本开始，推送 `v*` tag 会由 GitHub Actions
跑完整门禁并自动发布到 npm 注册表（带 provenance 签名，可在 npm 页面验证来源）。

### Added

- 上游跟进：紧急回收（emergency）的 fit 护栏——估算出的表面用量装不下时保留原结果、不再重试
  （对齐上游 #731）
- 上游跟进：historian 无进展闸——会话历史没有更新时自动档等待下一个更新节点，`forcedRange`
  手动路径放行（对齐上游 #802）
- 上游跟进：`userObservations` 产出开关——画像收集器未装备时向 prompt 注入明确的 disabled
  说明，避免模型空转
- 发布流水线：`.github/workflows/release.yml`（tag 推送 → 版本 / 分支 / 重复发布三道护栏 →
  完整门禁 → `npm publish --provenance`）

### Changed

- **展示层命名统一**：全局域（原 machine）、工作域（原 org）的界面文案、路由选项、分类提示与
  `ctx_memory` 工具描述统一为新名称；内部 token（kind 值、`dir:global:*` 身份、`suggested_domain`
  列、classifier 词表）保持不变，历史记忆与 journal 零迁移
- 依赖：`vitest` 4.1.12、`@types/node` 24.19.2 及传递依赖刷新；CI 的 actions 升到 v7，
  dependabot 对 `@deepseek-ai/*` 宿主包与主版本升级改为人工处理

### Fixed

- reduce-guidance：nudge 记录的 turn 曾是硬编码 0，使同档位的粘性抑制间隔在 ≥5 轮会话里恒满足、
  热会话会在每个 system prompt 组装时重发提醒；改为记录真实用户轮数

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

[Unreleased]: https://github.com/wk544863858/dsh-plugin-magic-context/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/wk544863858/dsh-plugin-magic-context/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/wk544863858/dsh-plugin-magic-context/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/wk544863858/dsh-plugin-magic-context/releases/tag/v0.9.0
