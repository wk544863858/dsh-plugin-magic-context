#!/usr/bin/env node
/**
 * Phase gates: run one phase's suite (or all of them) and print the verdict WITH
 * its blind spots.
 *
 *   node scripts/mc-phase.mjs a        # one phase
 *   node scripts/mc-phase.mjs all      # every phase in order
 *
 * Two rules make this a gate rather than a convenience wrapper:
 *   - an EMPTY phase FAILS. A phase whose suite is empty cannot be "green", it is
 *     simply not verified yet (phase C today), and saying otherwise is the whole
 *     failure mode this project keeps running into.
 *   - the blind list prints on every run, pass or fail. "Green" without a
 *     statement of what was not covered is not evidence.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHASES, phaseById } from './phase-map.mjs'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitestEntry = join(PKG, 'node_modules', 'vitest', 'vitest.mjs')

const requested = (process.argv[2] ?? 'all').toLowerCase()
const selected = requested === 'all' ? PHASES : [phaseById(requested)].filter(Boolean)

if (selected.length === 0) {
  console.error(`mc-phase: unknown phase '${requested}' (known: ${PHASES.map(p => p.id).join(', ')}, all)`)
  process.exit(2)
}
if (!existsSync(vitestEntry)) {
  console.error('mc-phase: vitest is not installed — run: npm install')
  process.exit(2)
}

const results = []
let failed = false

function run(label, command, args) {
  process.stdout.write(`\n--- ${label} ---\n`)
  const result = spawnSync(command, args, { cwd: PKG, stdio: 'inherit' })
  const code = result.status ?? 1
  if (code !== 0) failed = true
  return code === 0
}

for (const phase of selected) {
  console.log(`\n=== Phase ${phase.id.toUpperCase()} — ${phase.title} ===`)
  const missing = phase.specs.filter(spec => !existsSync(join(PKG, spec)))
  if (missing.length > 0) {
    // A path typo must not read as "the phase has nothing to check".
    console.error(`  mapped spec(s) do not exist: ${missing.join(', ')}`)
    failed = true
    results.push({ id: phase.id, ok: false, reason: 'mapped spec missing' })
    continue
  }
  if (phase.specs.length === 0) {
    console.error('  EMPTY PHASE: no spec is mapped here, so there is nothing to gate on.')
    console.error('  This phase is NOT verified — see the blind list below.')
    failed = true
    results.push({ id: phase.id, ok: false, reason: 'empty phase' })
    continue
  }

  const specsOk = run(`vitest (${String(phase.specs.length)} spec file(s))`, process.execPath, [vitestEntry, 'run', ...phase.specs])
  let checksOk = true
  for (const check of phase.checks) {
    checksOk = run(check.label, process.execPath, [join(PKG, check.script), ...check.args]) && checksOk
  }
  results.push({ id: phase.id, ok: specsOk && checksOk, reason: specsOk && checksOk ? 'ok' : 'red' })
}

console.log('\n=== phase summary ===')
for (const phase of selected) {
  const result = results.find(candidate => candidate.id === phase.id)
  const mark = result?.ok === true ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  phase ${phase.id.toUpperCase()}  ${phase.title}`)
  if (result?.ok !== true && result !== undefined) console.log(`        (${result.reason})`)
  for (const blind of phase.blind) console.log(`        blind: ${blind}`)
}
console.log(`  ${failed ? 'PHASE GATE FAILED' : 'PHASE GATE PASSED'}`)
process.exit(failed ? 1 : 0)
