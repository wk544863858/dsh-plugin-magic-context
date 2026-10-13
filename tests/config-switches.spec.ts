/**
 * The switch snapshot + drift alarm (2026-10-12, after the lost-key incident).
 *
 * The profile's `config` block is REPLACE semantics: a rewrite that drops a
 * key silently reverts that switch to its default, and nothing in the journal
 * said so — the 2026-10-11 incident was found ~12h later by inference. These
 * are the two pure halves of the fix: the snapshot (what is effectively on)
 * and the diff (what moved between mounts, with `went-off` as the alarm).
 */
import { describe, expect, it } from 'vitest'
import type { MagicContextDshConfig } from '../src/dsh/config.ts'
import { SWITCH_KEYS, buildSwitchSnapshot, diffSwitches } from '../src/dsh/config-switches.ts'

const EMPTY = {} as MagicContextDshConfig

describe('buildSwitchSnapshot', () => {
  it('applies every default for a config that mentions nothing', () => {
    const snapshot = buildSwitchSnapshot(EMPTY)
    expect(snapshot).toEqual({
      write: true,
      autoPromote: true,
      embedBackfill: true,
      vectorBackfill: true, // default ON since 2026-10-12 (commit e5d11a0cd)
      scoring: false,
      userRender: true,
      userCollect: false,
      userReview: false,
      machine: false,
      machineAutoStage: false,
      guardMode: 'observe',
      forceWaitMs: 0,
    })
  })

  it('honors explicit operator values over the defaults', () => {
    const snapshot = buildSwitchSnapshot({
      memory: {
        write: false,
        vectorBackfill: false,
        scoring: { enabled: true },
        global: { user: { collect: true, review: true }, machine: { enabled: true, autoStage: true } },
      },
      policy: { compartmentGuardMode: 'enforce', forceWaitReadyMs: 20_000 },
    })
    expect(snapshot.write).toBe(false)
    expect(snapshot.vectorBackfill).toBe(false)
    expect(snapshot.scoring).toBe(true)
    expect(snapshot.userCollect).toBe(true)
    expect(snapshot.userReview).toBe(true)
    expect(snapshot.machine).toBe(true)
    expect(snapshot.guardMode).toBe('enforce')
    expect(snapshot.forceWaitMs).toBe(20_000)
  })
})

describe('diffSwitches', () => {
  it('alarms when a switch that was on went off — the incident shape', () => {
    const before = buildSwitchSnapshot(EMPTY) // vectorBackfill: true by default
    const after = buildSwitchSnapshot({ memory: { vectorBackfill: false } })
    const rows = diffSwitches(before, after)
    expect(rows).toEqual([{ key: 'vectorBackfill', before: true, after: false, severity: 'went-off' }])
  })

  it('reports came-on and changed without alarm severity', () => {
    const before = buildSwitchSnapshot(EMPTY)
    const after = buildSwitchSnapshot({
      memory: { scoring: { enabled: true } },
      policy: { compartmentGuardMode: 'enforce' },
    })
    const rows = diffSwitches(before, after)
    expect(rows).toContainEqual({ key: 'scoring', before: false, after: true, severity: 'came-on' })
    expect(rows).toContainEqual({ key: 'guardMode', before: 'observe', after: 'enforce', severity: 'changed' })
    expect(rows.every(row => row.severity !== 'went-off')).toBe(true)
  })

  it('produces no rows for identical snapshots and survives a JSON round-trip', () => {
    const snapshot = buildSwitchSnapshot(EMPTY)
    expect(diffSwitches(snapshot, buildSwitchSnapshot(EMPTY))).toEqual([])
    const stored = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
    expect(diffSwitches(stored, buildSwitchSnapshot(EMPTY))).toEqual([])
  })

  it('skips keys the previous snapshot did not carry (forward compatibility)', () => {
    const rows = diffSwitches({ write: true }, { write: true, scoring: false })
    expect(rows).toEqual([])
  })

  it('tracks exactly the keys the snapshot builds', () => {
    expect(SWITCH_KEYS).toHaveLength(Object.keys(buildSwitchSnapshot(EMPTY)).length)
  })
})
