/**
 * Cross-project drift detection: the turn text is the only place DSH shows
 * WHERE work is happening (there is no per-turn working directory), so the
 * detector scans it for absolute paths and resolves each one's git root.
 *
 * These tests run real `git init` fixtures — the root resolution is the
 * component under test, stubbing it would prove nothing. Everything fails
 * open: any uncertainty must read as "no drift", never a throw.
 *
 * Fixtures land under `homedir()`, not `tmpdir()`: the detector's POSIX
 * branch only scans likely project prefixes (/home, /Users, /mnt, …) —
 * /tmp would be invisible on Linux, leaving this spec vacuous there.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectProjectDrift } from '../src/dsh/project-drift.ts'

// Real git spawns under a parallel vitest pool can stall past the default 5s
// test timeout (antivirus scans, worker contention) — the detector's own 3s
// probe timeout then fails a fixture through no fault of the logic.
vi.setConfig({ testTimeout: 30_000 })

const tempDirs: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(homedir(), '.tmp-mc-drift-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'file.txt'), 'seed\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'root'], { cwd: dir })
  return dir
}

function makePlainDir(): string {
  const dir = mkdtempSync(join(homedir(), '.tmp-mc-drift-plain-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* best-effort: residue under homedir has no OS temp sweep */
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
