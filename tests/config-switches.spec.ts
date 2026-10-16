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
      // Distribution defaults ON since 2026-10-13: corpus-owned, gates in force.
      scoring: true,
      userRender: true,
      userCollect: true,
      userReview: true,
      machine: true,
      machineAutoStage: true,
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
      policy: { forceWaitReadyMs: 20_000 },
    })
    expect(snapshot.write).toBe(false)
    expect(snapshot.vectorBackfill).toBe(false)
    expect(snapshot.scoring).toBe(true)
    expect(snapshot.userCollect).toBe(true)
    expect(snapshot.userReview).toBe(true)
    expect(snapshot.machine).toBe(true)
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
    // With the 2026-10-13 distribution defaults every boolean defaults ON, so
    // came-on needs an explicit OFF snapshot to move away from. `forceWaitMs`
    // is the non-boolean half of the snapshot (the guard-mode switch that used
    // to cover `changed` was retired 2026-10-16).
    const before = buildSwitchSnapshot({ memory: { write: false } })
    const after = buildSwitchSnapshot({
      policy: { forceWaitReadyMs: 30_000 },
    })
    const rows = diffSwitches(before, after)
    expect(rows).toContainEqual({ key: 'write', before: false, after: true, severity: 'came-on' })
    expect(rows).toContainEqual({ key: 'forceWaitMs', before: 0, after: 30_000, severity: 'changed' })
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
