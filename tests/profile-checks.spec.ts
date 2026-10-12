/**
 * D-4 — profile 依赖卫生的判据，用正负样本自证。
 *
 * 起因是 2026-10-11 的启动失败：宿主核心包（`@deepseek-ai/*`）的副本落进 profile 的
 * `node_modules`，被 DSH"profile 本地同名包优先"的解析选中，`agents`/`sessions`/`tools`
 * 三个服务不再注册，启动以 "1 required plugin did not activate" 失败。
 *
 * 这个文件要证明的是**两个方向**：坏了会报（hard / warn），没坏不报（ok），并且
 * "读不到事实"（宿主包清单不可达）不会被当成绿灯。判据住在
 * `scripts/profile-checks.mjs`，是纯函数：合成输入就是完整输入，没有文件系统、没有时钟。
 */
import { describe, expect, it } from 'vitest'
import {
  HOST_SCOPE,
  hostDependencyFindings,
  profileHygieneFindings,
  profileShadowFindings,
} from '../scripts/profile-checks.mjs'

type Finding = { level: string; text: string }

const levelsOf = (findings: readonly Finding[]) => findings.map((finding) => finding.level)
const textOf = (findings: readonly Finding[]) => findings.map((finding) => finding.text).join('\n')

/** A profile as the doctor hands it over: a directory plus what Node can resolve from its root. */
const profile = (name: string, shadow: string[] = []) => ({
  name,
  dir: `/.dsh/profiles/${name}`,
  shadow,
})

const deps = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, '1.0.0']))

const HOST = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session']

describe('profileShadowFindings', () => {
  it('stays silent when no profile carries host packages', () => {
    const findings = profileShadowFindings([profile('desktop'), profile('web')]) as Finding[]
    expect(levelsOf(findings)).toEqual(['ok'])
    expect(textOf(findings)).toContain('desktop')
    expect(textOf(findings)).toContain('web')
  })

  it('blocks when a profile carries a host package copy', () => {
    const findings = profileShadowFindings([profile('desktop', ['@deepseek-ai/dsh-tools'])]) as Finding[]
    expect(levelsOf(findings)).toContain('hard')
    expect(textOf(findings)).toContain('@deepseek-ai/dsh-tools')
    expect(textOf(findings)).toContain('desktop')
    // 判据必须给出可执行动作，而不只是"出事了"
    expect(textOf(findings)).toContain(`node_modules\\${HOST_SCOPE}`)
  })

  it('reports only the dirty profile and still vouches for the clean one', () => {
    const findings = profileShadowFindings([
      profile('desktop', ['@deepseek-ai/cordis']),
      profile('web'),
    ]) as Finding[]
    expect(levelsOf(findings)).toEqual(['hard', 'info', 'info', 'ok'])
    expect(textOf(findings)).toContain('web')
  })

  it('treats an unreadable profile list as "nothing to report", never as a fault', () => {
    // 取数失败时 doctor 会传空数组：判据不许把"没读到"说成"有副本"
    expect(levelsOf(profileShadowFindings([]) as Finding[])).toEqual([])
  })
})

describe('hostDependencyFindings', () => {
  it('stays silent when dependencies hold only private packages', () => {
    const findings = hostDependencyFindings(
      deps(['@huggingface/tokenizers', 'onnxruntime-common']),
      HOST,
    ) as Finding[]
    expect(levelsOf(findings)).toEqual(['ok'])
    expect(textOf(findings)).toContain('@huggingface/tokenizers')
  })

  it('blocks when a dependency is a package the host also ships', () => {
    const findings = hostDependencyFindings(deps(['@deepseek-ai/dsh-tools']), HOST) as Finding[]
    expect(levelsOf(findings)).toContain('hard')
    expect(textOf(findings)).toContain('@deepseek-ai/dsh-tools')
    expect(textOf(findings)).toContain('peerDependencies')
  })

  it('does not block a host-scope dependency the host does not ship', () => {
    // 精确性：遮蔽只发生在"宿主也自带"的包上，作用域相同不等于会遮蔽
    const findings = hostDependencyFindings(deps(['@deepseek-ai/dsh-not-shipped']), HOST) as Finding[]
    expect(levelsOf(findings)).not.toContain('hard')
    expect(levelsOf(findings)).toEqual(['ok', 'info'])
  })

  it('warns instead of vouching when the host package list is unreadable', () => {
    const findings = hostDependencyFindings(deps(['@deepseek-ai/dsh-tools']), undefined) as Finding[]
    expect(levelsOf(findings)).toEqual(['warn', 'info'])
    expect(textOf(findings)).toContain('--host-asar')
  })

  it('still vouches for private dependencies when the host list is unreadable', () => {
    // 没有宿主作用域的依赖时，读不到宿主清单不妨碍下结论
    const findings = hostDependencyFindings(deps(['onnxruntime-common']), undefined) as Finding[]
    expect(levelsOf(findings)).toEqual(['ok'])
  })
})

describe('profileHygieneFindings', () => {
  it('reports the live failure shape: shadowed profile plus host packages in dependencies', () => {
    const findings = profileHygieneFindings({
      profiles: [profile('desktop', ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools'])],
      dependencies: deps(['@deepseek-ai/dsh-tools', 'onnxruntime-common']),
      hostPackages: HOST,
    }) as Finding[]
    // 两条判据都亮红灯：现场（profile 有副本）与成因（dependencies 里有宿主包）
    expect(levelsOf(findings).filter((level) => level === 'hard')).toHaveLength(2)
    expect(textOf(findings)).toContain('@deepseek-ai/dsh-agent')
  })

  it('passes on the repaired shape', () => {
    const findings = profileHygieneFindings({
      profiles: [profile('desktop'), profile('web')],
      dependencies: deps(['@huggingface/tokenizers', 'onnxruntime-common']),
      hostPackages: HOST,
    }) as Finding[]
    expect(levelsOf(findings)).toEqual(['ok', 'ok'])
  })

  it('only ever emits known levels', () => {
    // 防止判据里出现拼错的等级：doctor 只认得这四个
    const findings = profileHygieneFindings({
      profiles: [profile('desktop', ['@deepseek-ai/cordis'])],
      dependencies: deps(['@deepseek-ai/dsh-tools']),
      hostPackages: undefined,
    }) as Finding[]
    for (const level of levelsOf(findings)) expect(['ok', 'info', 'warn', 'hard']).toContain(level)
  })
})
