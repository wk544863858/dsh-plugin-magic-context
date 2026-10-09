/**
 * The phase map is a gate, so it has to be checkable.
 *
 * Three ways a phase suite rots, all asserted here:
 *   1. a spec exists but belongs to no phase — it then runs in the full suite
 *      while gating nothing, and the "phase passed" claim quietly excludes it;
 *   2. a phase lists a path that does not exist — a typo reads as an empty
 *      suite;
 *   3. an empty phase passes — which is the "nothing verified, reported green"
 *      failure this project has hit before.
 *
 * The map also has to state its blind spots, so a pass cannot be read as more
 * than it is.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PHASES, mappedSpecs } from '../scripts/phase-map.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))

function specFiles(): string[] {
  const root = join(PKG, 'tests')
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.spec.ts')) found.push(relative(PKG, full).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return found.sort()
}

describe('the phase map', () => {
  it('maps every spec in the repository, so nothing escapes the phase gates', () => {
    const mapped = new Set(mappedSpecs())
    const unmapped = specFiles().filter(spec => !mapped.has(spec))
    expect(unmapped, 'these specs run in the full suite but gate no phase').toEqual([])
  })

  it('only lists paths that exist', () => {
    const missing = mappedSpecs().filter(spec => !existsSync(join(PKG, spec)))
    expect(missing).toEqual([])
  })

  it('declares exactly one phase as not-yet-verified, not an accidental empty one', () => {
    // Phase C (org/machine) is deliberately empty until the contract writes are
    // released. Any OTHER empty phase is a mistake, and the runner would fail
    // loudly on it — this pins which one is intentional.
    const empty = PHASES.filter(phase => phase.specs.length === 0).map(phase => phase.id)
    expect(empty).toEqual(['c'])
  })

  it('gives every phase an identity and a blind list', () => {
    for (const phase of PHASES) {
      expect(phase.id).toMatch(/^([0a-d])$/)
      expect(phase.title.length).toBeGreaterThan(4)
      expect(phase.blind.length, `phase ${phase.id} must state what it does not cover`).toBeGreaterThan(0)
      expect(Array.isArray(phase.checks)).toBe(true)
    }
  })

  it('runs the baseline regression suite before every other phase', () => {
    // Phase 0 is the plugin's pre-takeover behaviour; it comes first so the
    // summary reads as "old behaviour, then new lanes".
    expect(PHASES[0]!.id).toBe('0')
    expect(PHASES[0]!.specs.length).toBeGreaterThan(20)
  })

  it('covers the phase-A substrate with specs that actually exercise it', () => {
    const phaseA = PHASES.find(phase => phase.id === 'a')!
    expect(phaseA.specs).toContain('tests/contract-freeze.spec.ts')
    expect(phaseA.specs).toContain('tests/domain-visibility.spec.ts')
    // Phase A carries the contract-freeze detector as a check, so a phase-A pass
    // also asserts the frozen store has not drifted.
    expect(phaseA.checks.map(check => check.script)).toContain('scripts/mc-contract-freeze.mjs')
  })
})
