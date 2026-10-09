/**
 * The flag guard's negative control.
 *
 * `mc-import-workspace.mjs --help` used to run the import: unrecognised tokens
 * fell through to "no flags given, do the work", so the one invocation an
 * operator makes to ask *what does this do* was the one that did it. The rule
 * this file pins: a flag the tool does not know is reported, never ignored.
 * Whether to refuse is the caller's decision, so the parser returns the facts.
 */
import { describe, expect, it } from 'vitest'
import { parseFlags, stringFlag } from '../scripts/cli-flags.mjs'

const KNOWN = ['dry-run', 'workspace', 'enable', 'rollback', 'db', 'data-dir']

describe('parseFlags', () => {
  it('collects known boolean flags', () => {
    const { flags, unknown, help } = parseFlags(['--dry-run', '--enable'], KNOWN)
    expect(flags.get('dry-run')).toBe(true)
    expect(flags.get('enable')).toBe(true)
    expect(unknown).toEqual([])
    expect(help).toBe(false)
  })

  it('binds a value to the flag that precedes it', () => {
    const { flags } = parseFlags(['--workspace', 'code', '--db', 'C:/x/context.db'], KNOWN)
    expect(flags.get('workspace')).toBe('code')
    expect(flags.get('db')).toBe('C:/x/context.db')
    expect(stringFlag(flags, 'workspace')).toBe('code')
  })

  it('reports an unknown flag instead of silently ignoring it', () => {
    // The whole point: `--help` was the unknown flag that did the damage, but
    // any typo (`--dryrun`, `--enabled`) would have done the same.
    expect(parseFlags(['--frobnicate'], KNOWN).unknown).toEqual(['frobnicate'])
    expect(parseFlags(['--dryrun'], KNOWN).unknown).toEqual(['dryrun'])
    // ...and it is still reported alongside flags the tool DOES know.
    const mixed = parseFlags(['--dry-run', '--nope'], KNOWN)
    expect(mixed.unknown).toEqual(['nope'])
    expect(mixed.flags.get('dry-run')).toBe(true)
  })

  it('treats --help and -h as help, never as unknown', () => {
    expect(parseFlags(['--help'], KNOWN).help).toBe(true)
    expect(parseFlags(['--help'], KNOWN).unknown).toEqual([])
    expect(parseFlags(['--h'], KNOWN).help).toBe(true)
    // A bare `--` is neither a flag nor an error.
    expect(parseFlags(['--'], KNOWN).unknown).toEqual([])
  })

  it('never swallows a following flag as a value', () => {
    // `--db --dry-run` must set db=true (valueless) and keep dry-run its own
    // flag — otherwise the second flag disappears into the first one's value and
    // the operator silently loses a safety switch.
    const { flags } = parseFlags(['--db', '--dry-run'], KNOWN)
    expect(flags.get('db')).toBe(true)
    expect(flags.get('dry-run')).toBe(true)
    expect(stringFlag(flags, 'db')).toBeUndefined()
  })

  it('ignores non-flag arguments and keeps values in order', () => {
    const { flags } = parseFlags(['stray', '--workspace', 'code'], KNOWN)
    expect(flags.get('workspace')).toBe('code')
    expect(stringFlag(flags, 'workspace')).toBe('code')
  })

  it('accepts a Set or an array for the known flags, and an empty argv', () => {
    expect(parseFlags([], new Set(KNOWN)).unknown).toEqual([])
    expect(parseFlags([], KNOWN).flags.size).toBe(0)
  })
})
