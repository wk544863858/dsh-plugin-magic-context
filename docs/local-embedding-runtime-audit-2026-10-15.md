# 本地 embedding 运行时审计 — onnx 遥测（opt-out）核对

日期：2026-10-15 · 触发：上游 MC 0.49.1「本地 embedding 的 ONNX Runtime 遥测 opt-out 生效」修复
结论：**不适用——本插件不加载原生 ONNX Runtime，因此不存在上游修复所指的遥测面。** 已把该性质钉成常驻判据（spec）。

## 1. 上游修的是什么

MC 0.49.1 release notes（`Fixed › Local embeddings`）：

> OpenCode 1 and 2, Pi and Oh My Pi: the ONNX Runtime telemetry opt-out now takes effect for local
> embeddings under Bun and Node, including compiled Bun hosts. On Windows, ONNX Runtime uses the
> operating system's event tracing instead, and a one-time log line explains this.

同一版 `local_runtime` 配置项的说明（MC 0.49.1 npm tarball 的 `dist/index.js:9214` 实证）锁定对象：

> `'auto'` uses native under Node and uses WASM under Bun versions before 1.4.0 … **Inference runs in a
> dedicated worker after disabling POSIX telemetry in the native process environment.** … **Windows
> native ONNX emits OS-controlled ETW diagnostics**, not direct uploads.

即：上游的遥测面属于 **native（onnxruntime-node / C++）** 运行时——POSIX 进程环境里的遥测、Windows 的 ETW。
其 `memory/onnx-telemetry.ts` 模块在发布包 bundle 内是空实现（`var init_onnx_telemetry = () => {}`，
MC 0.49.1 npm tarball 的 `dist/index.js:47154-47160`），真正动作发生在原生加载之前。

## 2. 我们的实际运行时（证据）

| 事实 | 证据 |
| --- | --- |
| 用 onnxruntime-web 的 **WASM** 后端，明确不用 native build | `src/core/embedding-local.ts:9-10` |
| 运行栈指纹 = `onnxruntime-web@1.31.0-dev.20260914-8d85527a0(wasm);@huggingface/tokenizers@0.2.0` | `src/core/embedding-local.ts:54-55` |
| 只 import vendor 副本 | `src/core/embedding-local.ts:174`（`vendor/onnx/ort.node.min.mjs`） |
| 会话从**本地文件**创建（非 URL/网络） | `src/core/embedding-local.ts:249`（`join(cacheDir,'model.onnx')`） |
| vendor 三件齐全：`.wasm` 14,264,838 B + `ort.node.min.mjs` 27,107 B + `ort-wasm-simd-threaded.mjs` 24,381 B | `vendor/onnx/` |
| 仓库内 `.node` 原生扩展 = 0（node_modules 里只有 rolldown/lightningcss 构建工具，与 ORT 无关） | `Get-ChildItem -Recurse -Filter *.node` |
| **未安装** onnxruntime-node；`onnxruntime-common` 内 `telemetry` 命中 0 | `node_modules/onnxruntime-common` |
| vendored ORT 三个文件内 `telemetry` 命中 0；唯一 URL 是错误文案里的 `web.dev/cross-origin-isolation-guide` | `vendor/onnx/*.mjs` 全文检索 |

⇒ 上游「原生进程环境遥测 / Windows ETW」两个面在本插件都不存在：**没有原生加载，就没有那两处出口**。

## 3. 常驻判据（防后人换回 native / 防推理期出站）

`tests/embedding-wasm.spec.ts` 新增 `describe('the embedding lane is WASM-only and never reaches the network')`：

1. **运行时目录面**：vendor 三件在位；无任何 `.node`；两个 `.mjs` 内不出现 `onnxruntime-node`；指纹含 `onnxruntime-web` 与 `(wasm)`。
2. **依赖面**：`dependencies` 里 onnxruntime* 只允许 `onnxruntime-common`（纯 JS 共享包），显式禁 `onnxruntime-node` / `@huggingface/transformers`。
   （与既有白名单判据叠加：`tests/profile-checks.spec.ts:72/101/110/121`。）
3. **推理期零出站**：先用合法路径预热资产，再用**抛异常的 fetch** 打开 embedder 并 embed —— 仍返回 384 维，且该 fetch 从未被调用。

## 4. 不做的决定

- **不加遥测关断开关**：上游发布包里不存在有效变量（大小写敏感检索 `TELEMETRY` = 0 命中），加空杠杆违背最简；真正的关断是"不加载原生运行时"。
- **不引入 `local_runtime: auto|native|wasm` 配置**：我们只有 WASM 一条路，配置项会制造两条没人验证的路径。

## 5. 未覆盖（如实记录）

- ORT-web 的 glue 里存在 `fetch` / `XMLHttpRequest` 代码路径（浏览器场景下载 wasm/模型用）；我们走的是文件路径 + 本机 vendor，已由第 3 条第 3 例覆盖"推理期不出站"，但**未**覆盖"资产缺失时回退到远端下载"的那条路——那条路是设计行为（`embedding-local.ts:210` 的流式下载 + 镜像回退，`tests/embedding-wasm.spec.ts` 正例已测），需要网络。
- 若未来接入远端 embedding provider（配置里的 provider 车道），其出站属设计行为，不在本审计范围。
- 本审计只覆盖 ORT 遥测；模型/资产的供应链校验（`EMBEDDING_ASSETS` 哈希 + `ensureAsset`）由既有代码与 spec 负责，本次仅复核其仍在位。

## 6. 复核命令

```powershell
# 运行时目录面 + 依赖面 + 零出站（三条判据）
node_modules\.bin\vitest.cmd run tests/embedding-wasm.spec.ts
# 依赖白名单（既有）
node_modules\.bin\vitest.cmd run tests/profile-checks.spec.ts
# 证据复核（无原生 / 无遥测字样）
Get-ChildItem vendor\onnx -Recurse -File | Select-Object Name, Length
Get-ChildItem . -Recurse -File -Filter *.node | Where-Object { $_.FullName -notmatch '\\node_modules\\' }
Select-String -Path vendor\onnx\*.mjs -Pattern 'telemetry' -CaseSensitive
```
