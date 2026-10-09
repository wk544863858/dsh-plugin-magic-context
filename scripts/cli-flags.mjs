#!/usr/bin/env node
/**
 * cli-flags.mjs — shared flag parsing for the operator scripts (pure, testable).
 *
 * Why this exists as a module instead of four lines inside each script: a script
 * that acts on flags it did not understand is a script nobody can reason about,
 * and that is a judgement worth testing. `mc-import-workspace.mjs` is the case
 * that forced it — `--help` silently performed the import, because every
 * unrecognised token fell through to "no flags given, do the work".
 *
 * `parseFlags` reports what it did NOT understand (`unknown`) instead of
 * dropping it, so each caller decides: refuse, or warn. It never decides for
 * them, and it never touches the filesystem.
 */

/**
 * @param {readonly string[]} argv raw arguments (without node and the script path)
 * @param {ReadonlySet<string> | readonly string[]} known flags that take part
 * @returns {{ flags: Map<string, string | true>, unknown: string[], help: boolean }}
 */
export function parseFlags(argv, known) {
  const knownSet = known instanceof Set ? known : new Set(known)
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue
    const name = arg.slice(2)
    if (name === '') continue
    const next = argv[i + 1]
    // A following `--flag` is never a value: `--db --dry-run` must not swallow
    // the second flag into the first one's value.
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      i += 1
    } else {
      flags.set(name, true)
    }
  }
  const help = flags.has('help') || flags.has('h')
  const unknown = [...flags.keys()].filter((name) => name !== 'help' && name !== 'h' && !knownSet.has(name))
  return { flags, unknown, help }
}

/** The string value of a flag, or `undefined` when it was absent or valueless. */
export function stringFlag(flags, name) {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}
