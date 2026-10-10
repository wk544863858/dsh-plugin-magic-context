/**
 * historian-pairing — the orphan-criterion regression suite.
 *
 * The 2026-10-10 22:00 patrol caught mc-acceptance FAILing with
 * `historian.terminal` + `historian.orphan` while nothing was actually
 * broken: the acceptance run had executed *inside* a live compaction
 * (§C6 start 22:00:00 → done 22:05:21; acceptance ran 22:03–22:05).
 * The old criterion — "start older than 180s with no terminal" — sits
 * below the legitimate run duration (measured 4–6 min: 2 chunks ≈ 90s
 * each plus a ≈3-minute merge LLM call), so every acceptance that lands
 * mid-run flags a healthy, in-flight run as 静默蒸发.
 *
 * The criterion now lives in scripts/historian-pairing.mjs: an open start
 * is an orphan candidate only after HISTORIAN_QUIET_GRACE_MS (15 min)
 * with NO historian row for that session — chunk/merge rows are liveness
 * evidence. These tests pin both sides: the in-flight shape must stay
 * clean, and genuine evaporation must still be flagged (纪律 ④: a
 * criterion only counts if it actually fires when broken).
 */
import { describe, expect, it } from 'vitest'
import {
  HISTORIAN_QUIET_GRACE_MS,
  scanHistorianStarts,
  staleOpenStarts,
} from '../scripts/historian-pairing.mjs'

const SID = 'session-pairing'
const T0 = 1_749_000_000_000

interface Row { id: number; at: number; sid: string; phase: string }

const row = (id: number, at: number, phase: string, sid: string = SID): Row => ({ id, at, sid, phase })

/** The production shape of a live 2-chunk run: start → chunk → chunk → merge. */
const IN_FLIGHT: Row[] = [
  row(1, T0, 'start'),
  row(2, T0 + 60_000, 'chunk'),
  row(3, T0 + 120_000, 'chunk'),
  row(4, T0 + 125_000, 'merge'),
]

describe('historian pairing: in-flight runs are not orphans', () => {
  it('the 22:00 false positive, verbatim: acceptance at minute 4 of a live run stays clean', () => {
    // start 22:00:00, chunks at +60s/+120s, merge at +125s; "now" = +4 min
    // (the old 180s-on-start.at criterion flagged exactly this shape).
    const open = scanHistorianStarts(IN_FLIGHT)
    expect(open.size).toBe(1)
    expect(staleOpenStarts(open, T0 + 4 * 60_000)).toEqual([])
  })

  it('the merge quiet gap: 10 minutes into the merge LLM call is still not an orphan', () => {
    const open = scanHistorianStarts(IN_FLIGHT)
    expect(staleOpenStarts(open, T0 + 125_000 + 10 * 60_000)).toEqual([])
  })

  it('liveness is per-session: another session\'s rows do not keep a dead run alive', () => {
    const rows = [...IN_FLIGHT, row(5, T0 + 60_000, 'chunk', 'session-other')]
    const open = scanHistorianStarts(rows)
    const stale = staleOpenStarts(open, T0 + 20 * 60_000)
    expect(stale.map((h) => h.sid)).toEqual([SID])
  })
})

describe('historian pairing: genuine evaporation still fires', () => {
  it('a bare start that went silent for 16 minutes IS an orphan candidate', () => {
    const open = scanHistorianStarts([row(1, T0, 'start')])
    const stale = staleOpenStarts(open, T0 + 16 * 60_000)
    expect(stale.length).toBe(1)
    expect(stale[0]!.at).toBe(T0)
  })

  it('a run that stalled mid-chunks (no terminal, rows stopped) is an orphan', () => {
    // start + one chunk, then nothing for 16 min: chunk evidence has aged out.
    const open = scanHistorianStarts([row(1, T0, 'start'), row(2, T0 + 60_000, 'chunk')])
    expect(staleOpenStarts(open, T0 + 60_000 + 16 * 60_000).length).toBe(1)
  })

  it('grace boundary: last row exactly 15 min old is NOT stale, one minute later IS', () => {
    const open = scanHistorianStarts([row(1, T0, 'start')])
    const last = T0 + HISTORIAN_QUIET_GRACE_MS
    expect(staleOpenStarts(open, last)).toEqual([])
    expect(staleOpenStarts(open, last + 60_000).length).toBe(1)
  })
})

describe('historian pairing: closing rules unchanged', () => {
  it('done/failed close the start (the 20:21 invalid-output run shape)', () => {
    // start → chunk → chunk → merge → failed, 4 minutes apart — closed.
    const open = scanHistorianStarts([...IN_FLIGHT, row(5, T0 + 245_000, 'failed')])
    expect(open.size).toBe(0)
  })

  it('supersede-close: a new start for the same session replaces the open one', () => {
    const open = scanHistorianStarts([
      row(1, T0, 'start'),
      row(2, T0 + 60_000, 'start'),
    ])
    expect(open.size).toBe(1)
    const only = [...open.values()][0]!
    expect(only.at).toBe(T0 + 60_000)
    expect(only.lastActivity).toBe(T0 + 60_000)
  })
})
