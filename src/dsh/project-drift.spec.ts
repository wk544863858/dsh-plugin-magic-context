// @ts-nocheck
/**
 * MIRROR of the runnable suite at `packages/test-support/mc-dsh-poc/tests/project-drift.spec.ts`
 * in the DSH checkout — this repository has no node_modules and cannot resolve bare
 * vitest. Keep the two files identical; this header is the only intended difference.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProjectDrift } from '<path>'

const tempDirs: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-drift-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'file.txt'), 'seed\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'root'], { cwd: dir })
  return dir
}

function makePlainDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-drift-plain-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* the OS temp sweep covers residue */
    }
  }
})

describe('detectProjectDrift', () => {
  it('reports a foreign git root when the turn mentions another repository', () => {
    const own = makeRepo()
    const other = makeRepo()
    const outcome = detectProjectDrift(
      `先看一下 ${join(other, 'src', 'api.ts')} 的实现再改`,
      own,
    )
    expect(outcome).toBeDefined()
    expect(outcome!.foreignRoots).toHaveLength(1)
    // The session root is the other fixture's only foreign root.
    const ownRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: own, encoding: 'utf8' }).stdout.trim().replace(/\\/g, '/')
    expect(outcome!.foreignRoots[0]).not.toBe(ownRoot)
    expect(outcome!.sessionRoot).toBe(ownRoot)
  })

  it('reports nothing when every mentioned path is inside the session project', () => {
    const own = makeRepo()
    const outcome = detectProjectDrift(
      `改一下 ${join(own, 'src', 'index.ts')}，再看 ${join(own, 'README.md')}`,
      own,
    )
    expect(outcome).toBeUndefined()
  })

  it('text without absolute paths is not drift', () => {
    const own = makeRepo()
    expect(detectProjectDrift('帮我总结一下这个项目的架构和约定', own)).toBeUndefined()
    expect(detectProjectDrift('', own)).toBeUndefined()
  })

  it('a session without a working directory (or without a git root) never drifts', () => {
    const other = makeRepo()
    expect(detectProjectDrift(`看 ${join(other, 'a.ts')}`, undefined)).toBeUndefined()
    expect(detectProjectDrift(`看 ${join(other, 'a.ts')}`, '')).toBeUndefined()
    // The session cwd exists but is not a repository — no own root, no drift.
    const plain = makePlainDir()
    expect(detectProjectDrift(`看 ${join(other, 'a.ts')}`, plain)).toBeUndefined()
  })

  it('a non-git directory mention does not fabricate a foreign root', () => {
    const own = makeRepo()
    const plain = makePlainDir()
    const outcome = detectProjectDrift(
      `顺手看下 ${join(plain, 'notes.md')} 里的清单`,
      own,
    )
    // The plain directory resolves to no root at all — nothing to report.
    expect(outcome).toBeUndefined()
  })
})
