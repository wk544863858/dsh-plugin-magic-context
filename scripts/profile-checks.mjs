#!/usr/bin/env node
/**
 * profile-checks.mjs — profile 依赖卫生的判据（纯函数，只读）
 *
 * 为什么单独成文件：本仓纪律 ④「判据先自证」——一条判据只有在"人为破坏后确实报警"
 * 时才成立。所以判定逻辑不碰文件、不打印、不退出，测试用合成输入做**正负样本对照**
 * （`tests/profile-checks.spec.ts`）；doctor 只负责取数与打印。
 *
 * 判据针对的是 2026-10-11 那次启动失败，不是插件代码：
 *
 *   DSH 的模块解析是"profile 本地同名包优先"（`dsh-app-boot` 的
 *   `lib/worker/profile-resolution-bootstrap.js` → `routeScoped`：先看 profile 的
 *   node_modules 里有没有同名候选，有就走它）。于是 base 束里 name 为
 *   `@deepseek-ai/dsh-agent` / `dsh-session` / `dsh-tools` 的核心行会被换成 profile
 *   里那份副本，`agents`/`sessions`/`tools` 三个服务不再注册，启动报
 *   "dsh: startup failed: 1 required plugin did not activate"（27 个核心行 pending）。
 *
 * 副本的来源是两个条件相撞：profile 的安装策略是 `nodeLinker: hoisted` +
 * `autoInstallPeers: false`，而插件把宿主包写进了 `dependencies`——在 profile 里跑
 * `pnpm add` 就会把它们提升到 profile 根（DSH 插件管理器的安装方式正是 pnpm add）。
 *
 * 两条判据，一条治标一条治本：
 *   1. 任何 profile 的 node_modules 里出现 `@deepseek-ai/*` ⇒ **hard**（故障的前一刻）；
 *   2. 插件 `dependencies` 里出现"宿主自带的包" ⇒ **hard**（正在制造第 1 条）。
 *
 * 覆盖面（写清楚以免过度承诺）：只看 profile 根的 `node_modules/@deepseek-ai/`，也就是
 * Node/DSH 真的能解析到的位置；`.pnpm` 内部未提升的副本不会遮蔽，因此不报。
 */

const LEVEL_OK = 'ok'
const LEVEL_INFO = 'info'
const LEVEL_WARN = 'warn'
/** 阻断级：命中即"下次启动会失败"或"正在制造该失败"。 */
const LEVEL_HARD = 'hard'

/** 宿主自有包的作用域：这个作用域的副本落进 profile 就有可能顶掉宿主自带版本。 */
export const HOST_SCOPE = '@deepseek-ai'

/** 作用域内的包名（`@deepseek-ai/dsh-tools` 这种完整名）。 */
const inHostScope = (name) => name.startsWith(`${HOST_SCOPE}/`)

/**
 * 判据 1：profile 根上出现宿主作用域的包。
 *
 * `profiles` 是已经取好的事实：`{ name, dir, shadow }`，其中 `shadow` 是该 profile
 * `node_modules/@deepseek-ai/` 下的完整包名列表。取数（readdir）留在调用方，这样
 * 这条判据在合成输入上就能跑。
 *
 * @param {readonly { name: string, dir: string, shadow?: readonly string[] }[]} profiles
 * @returns {{ level: string, text: string }[]}
 */
export function profileShadowFindings(profiles) {
  const findings = []
  const clean = []
  for (const profile of profiles) {
    const shadow = [...(profile.shadow ?? [])].sort()
    if (shadow.length === 0) {
      clean.push(profile.name)
      continue
    }
    findings.push({
      level: LEVEL_HARD,
      text: `profile「${profile.name}」的 node_modules 里躺着宿主核心包：${shadow.join(', ')}`,
    })
    findings.push({
      level: LEVEL_INFO,
      text: '  这些副本会被 DSH 的"profile 本地同名包优先"解析选中，顶掉宿主自带版本：'
        + 'agents/sessions/tools 三个服务不再注册，启动会以 "1 required plugin did not activate" 失败',
    })
    findings.push({
      level: LEVEL_INFO,
      text: `  动作（治标）：删掉 ${profile.dir}\\node_modules\\${HOST_SCOPE} 后重启；`
        + '不要靠重命名整个 profile 来绕过（宿主副本当时是齐的，问题只在 profile 这一层）',
    })
  }
  if (clean.length > 0) {
    findings.push({ level: LEVEL_OK, text: `node_modules 干净、无宿主包副本的 profile：${clean.join(', ')}` })
  }
  return findings
}

/**
 * 判据 2：插件自己的 `dependencies` 不得包含宿主也自带的包。
 *
 * 这是治本的一条：只要宿主包留在 `dependencies`，profile 里的任何一次 `pnpm add`
 * 都可能把它们提升到 profile 根，第一条判据随即命中（`peerDependencies` 在 profile 的
 * `autoInstallPeers: false` 下不会被安装，正是我们想要的行为）。
 *
 * `hostPackages` 为 `undefined` 表示宿主包清单没读出来（app.asar 不可达）。此时**不**
 * 断言"没问题"，而是降级成 WARN——读不到事实不能变成"绿灯"。
 *
 * @param {Record<string, string>} dependencies 插件 package.json 的 dependencies
 * @param {readonly string[] | undefined} hostPackages 宿主安装自带的包名
 * @returns {{ level: string, text: string }[]}
 */
export function hostDependencyFindings(dependencies, hostPackages) {
  const findings = []
  const declared = Object.keys(dependencies ?? {}).sort()
  const scoped = declared.filter(inHostScope)
  const hosted = hostPackages === undefined ? undefined : new Set(hostPackages)
  const offenders = hosted === undefined ? [] : scoped.filter((name) => hosted.has(name))

  if (offenders.length > 0) {
    findings.push({
      level: LEVEL_HARD,
      text: `插件 dependencies 里混入宿主自带的包：${offenders.join(', ')}`,
    })
    findings.push({
      level: LEVEL_INFO,
      text: '  profile 的安装策略是 nodeLinker: hoisted + autoInstallPeers: false，'
        + '而 DSH 插件管理器用 pnpm add 在 profile 内安装：这些依赖会被提升到 profile 根，'
        + '正是上一条故障的直接成因',
    })
    findings.push({
      level: LEVEL_INFO,
      text: '  动作（治本）：移到 peerDependencies（版本号留在 devDependencies 供构建与夹具），'
        + 'dependencies 只留宿主没有的私有依赖',
    })
    return findings
  }

  if (hosted === undefined && scoped.length > 0) {
    findings.push({
      level: LEVEL_WARN,
      text: `宿主包清单读不到（app.asar 不可达），dependencies 里的 ${scoped.join(', ')} 是否会遮蔽宿主无法判定`,
    })
    findings.push({
      level: LEVEL_INFO,
      text: '  动作：用 --host-asar <...\\resources\\app.asar> 指定宿主安装，或人工确认这些包宿主并不自带',
    })
    return findings
  }

  findings.push({
    level: LEVEL_OK,
    text: `插件 dependencies 只含宿主没有的私有依赖：${declared.join(', ') || '（空）'}`,
  })
  if (hosted !== undefined && scoped.length > 0) {
    findings.push({
      level: LEVEL_INFO,
      text: `dependencies 里的 ${scoped.join(', ')} 宿主并不自带，提升到 profile 根无害`,
    })
  }
  return findings
}

/**
 * doctor 第 8 节的一次调用：两条判据合起来，顺序即阅读顺序（先看故障现场，再看成因）。
 *
 * @param {{ profiles: readonly { name: string, dir: string, shadow?: readonly string[] }[],
 *           dependencies: Record<string, string>,
 *           hostPackages: readonly string[] | undefined }} input
 * @returns {{ level: string, text: string }[]}
 */
export function profileHygieneFindings({ profiles, dependencies, hostPackages }) {
  return [...profileShadowFindings(profiles), ...hostDependencyFindings(dependencies, hostPackages)]
}
