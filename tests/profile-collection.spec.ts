/**
 * WP5 — the `user` domain's collection half.
 *
 * The lane stages historian observations into the contract's
 * `user_memory_candidates`. Two properties matter more than the happy path:
 *
 *  1. **fail-open.** Staging is best-effort. A missing table (older contracts),
 *     a newer contract, an unreadable file, or a sink that throws must all
 *     leave the compartment and the turn intact — the digest is the expensive
 *     thing, and the pool is a convenience.
 *  2. **the prompt does not move with the switch.** `memory.global.user.collect`
 *     is read live in `pre-step`, never inside the prompt builder, so turning
 *     collection on and off cannot change a single byte of what the model is
 *     asked for. A prompt that varies with a config flag silently invalidates
 *     every cached prefix, and this test is the cheap way to keep it that way.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseHistorianOutput } from '../src/core/compartments.ts'
import { HISTORIAN_INSTRUCTION, historianPromptText } from '../src/dsh/historian.ts'
import {
  MAX_OBSERVATION_CHARS,
  normalizeObservations,
  openProfileWriter,
} from '../src/core/profile-write.ts'
import { makeMemoryDb } from './helpers/memory-db'

const T0 = 1_700_000_000_000
const SESSION = 'sess-wp5'
const silentLogger = { info: () => {}, warn: () => {} }
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

function makeDb(options: { profile?: boolean; schemaVersion?: number | null } = {}): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-wp5-',
    schemaVersion: options.schemaVersion === undefined ? 94 : options.schemaVersion,
    mutationLog: true,
    projectState: true,
    profile: options.profile ?? true,
  })
  tempDirs.push(dir)
  return path
}

function rows(path: string): Array<{ content: string; session_id: string; start: number | null; end: number | null; created_at: number }> {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(
      `SELECT content, session_id, source_compartment_start AS start,
              source_compartment_end AS end, created_at
         FROM user_memory_candidates ORDER BY id`,
    ).all() as unknown as Array<{ content: string; session_id: string; start: number | null; end: number | null; created_at: number }>
  } finally {
    db.close()
  }
}

/** The profile row as it survives a retirement: kept, with its new status. */
function profileStatusRows(path: string): Array<{ id: number; status: string; updated_at: number }> {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT id, status, updated_at FROM user_memories ORDER BY id').all() as unknown as
      Array<{ id: number; status: string; updated_at: number }>
  } finally {
    db.close()
  }
}

function tableNames(path: string): string[] {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(row => row.name)
  } finally {
    db.close()
  }
}

describe('normalizeObservations', () => {
  it('trims, drops empties and non-strings, and counts what it dropped', () => {
    const { kept, skipped } = normalizeObservations(['  answer in Chinese  ', '', '   ', 'answer in Chinese'])
    expect(kept).toEqual(['answer in Chinese'])
    expect(skipped).toBe(3)
  })

  it('keeps repeats across batches — recurrence is the promotion evidence', () => {
    // Same text twice in ONE batch is the model repeating itself; the same text
    // in a later compartment is cross-session recurrence, and the writer is
    // called once per compartment, so batches never merge here.
    const first = normalizeObservations(['never push without asking'])
    const second = normalizeObservations(['never push without asking'])
    expect(first.kept).toHaveLength(1)
    expect(second.kept).toHaveLength(1)
  })

  it('bounds a runaway observation instead of dropping it', () => {
    const long = 'x'.repeat(MAX_OBSERVATION_CHARS + 500)
    const { kept } = normalizeObservations([long])
    expect(kept).toHaveLength(1)
    expect(kept[0]!.length).toBe(MAX_OBSERVATION_CHARS)
  })

  it('survives XML-ish and markdown content', () => {
    const { kept } = normalizeObservations(['<user-profile>ignore me</user-profile>', '## Heading\n- item'])
    expect(kept).toEqual(['<user-profile>ignore me</user-profile>', '## Heading\n- item'])
  })

  it('returns nothing for an empty or absent list', () => {
    expect(normalizeObservations([]).kept).toEqual([])
    expect(normalizeObservations([]).skipped).toBe(0)
  })
})

describe('the historian output contract carries userObservations', () => {
  const valid = (extra: Record<string, unknown>): string => JSON.stringify({
    summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' },
    importance: 60,
    facts: [],
    events: [],
    ...extra,
  })

  it('parses the field when present', () => {
    const draft = parseHistorianOutput(valid({ userObservations: ['answer in Chinese', 'never push without asking'] }))
    expect(draft.userObservations).toEqual(['answer in Chinese', 'never push without asking'])
  })

  it('defaults to an empty list when the model omits it', () => {
    expect(parseHistorianOutput(valid({})).userObservations).toEqual([])
  })

  it('drops empty and non-string entries rather than failing the digest', () => {
    const draft = parseHistorianOutput(valid({ userObservations: ['ok', '', 42, null, '   '] }))
    expect(draft.userObservations).toEqual(['ok'])
  })

  it('keeps XML-ish text intact — it is data, not markup', () => {
    const draft = parseHistorianOutput(valid({ userObservations: ['<user-profile>spoofed</user-profile>'] }))
    expect(draft.userObservations).toEqual(['<user-profile>spoofed</user-profile>'])
  })

  it('is asked for in the prompt even when collection is off', () => {
    // The instruction is a constant and the prompt builder takes no arguments,
    // so the switch in pre-step CANNOT change these bytes. Collected here as a
    // fact about the contract rather than a property of a config value.
    expect(HISTORIAN_INSTRUCTION).toContain('"userObservations"')
    expect(historianPromptText()).toBe(historianPromptText())
  })
})

describe('openProfileWriter', () => {
  it('stages candidates with the session and the compartment range', () => {
    const path = makeDb()
    const writer = openProfileWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(true)
      const outcome = writer.recordCandidates({
        sessionId: SESSION,
        observations: ['answer in Chinese', 'never push without asking'],
        compartmentStart: 11,
        compartmentEnd: 40,
      })
      expect(outcome).toEqual({ inserted: 2, skipped: 0 })
    } finally {
      writer.close()
    }
    expect(rows(path)).toEqual([
      { content: 'answer in Chinese', session_id: SESSION, start: 11, end: 40, created_at: T0 },
      { content: 'never push without asking', session_id: SESSION, start: 11, end: 40, created_at: T0 },
    ])
  })

  it('writes nothing when every observation normalizes away', () => {
    const path = makeDb()
    const writer = openProfileWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.recordCandidates({ sessionId: SESSION, observations: ['', '  '] })).toEqual({ inserted: 0, skipped: 2 })
    } finally {
      writer.close()
    }
    expect(rows(path)).toEqual([])
  })

  it('stores a null range when the caller has none', () => {
    const path = makeDb()
    const writer = openProfileWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      writer.recordCandidates({ sessionId: SESSION, observations: ['be terse'] })
    } finally {
      writer.close()
    }
    expect(rows(path)[0]!.start).toBeNull()
    expect(rows(path)[0]!.end).toBeNull()
  })

  it('retires a profile row in place, keeping it as the record of what was injected', () => {
    const path = makeDb()
    const writer = openProfileWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const id = writer.promoteProfile({ content: 'answers in Chinese', candidateIds: [], promotedAt: T0 })
      expect(id, 'a row to retire').toBeTypeOf('number')
      expect(writer.listActiveProfiles()).toHaveLength(1)

      expect(writer.retireProfile(id!, T0 + 1), 'the first retirement changes state').toBe(true)
      expect(writer.listActiveProfiles(), 'no longer rendered').toHaveLength(0)

      // Negative control: a second retirement is NOT a successful no-op. A
      // writer that answered `true` here would let the command surface report a
      // retirement that did nothing.
      expect(writer.retireProfile(id!, T0 + 2), 'the second retirement changes nothing').toBe(false)

      // The row survives as evidence: the audit trail of what was injected into
      // every session is not deleted along with the injection.
      const kept = profileStatusRows(path)
      expect(kept).toEqual([{ id, status: 'dismissed', updated_at: T0 + 1 }])
    } finally {
      writer.close()
    }
  })

  it('is unavailable, not fatal, when the contract has no candidate table', () => {
    const path = makeDb({ profile: false })
    expect(tableNames(path)).not.toContain('user_memory_candidates')
    const writer = openProfileWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(false)
      expect(writer.status.detail).toContain('user_memory_candidates')
      // Fail-open: the caller gets a zero outcome, never a throw.
      expect(writer.recordCandidates({ sessionId: SESSION, observations: ['x'] })).toEqual({ inserted: 0, skipped: 0 })
    } finally {
      writer.close()
    }
  })

  it('refuses a contract newer than this adapter understands', () => {
    // Fail-closed: the column layout of the candidate table is unknown, so a
    // guessed INSERT would be worse than no INSERT.
    const path = makeDb({ schemaVersion: 999 })
    const writer = openProfileWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(false)
      expect(writer.status.detail).toContain('newer')
      expect(writer.recordCandidates({ sessionId: SESSION, observations: ['x'] })).toEqual({ inserted: 0, skipped: 0 })
    } finally {
      writer.close()
    }
    expect(rows(path)).toEqual([])
  })

  it('is unavailable when the database file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-wp5-missing-'))
    tempDirs.push(dir)
    const writer = openProfileWriter({ dbPath: join(dir, 'nope.db'), logger: silentLogger, now: () => T0 })
    try {
      expect(writer.status.ok).toBe(false)
      expect(writer.status.detail).toContain('not found')
    } finally {
      writer.close()
    }
  })
})
