#!/usr/bin/env node
/**
 * One command for the adapter's local gate.
 *
 *   node scripts/mc-test.mjs           # --quick: spec parity + the vitest suite
 *   node scripts/mc-test.mjs --full    # + build, acceptance, memory audit, records
 *
 * The suite runs inside the resolved test host (see `test-host.mjs`); this
 * script owns the whole sequence so no step depends on a remembered command
 * line. Children are started as `node <entry>.mjs` rather than through the
 * `node_modules/.bin` shims, because those are `.CMD` files here and going
 * through `cmd.exe` breaks on the space in `C:\Program Files\nodejs`. Output is
 * inherited, so failures are readable in place.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { PKG, SCRIPTS, SUITE_TESTS, resolveTestHost } from './test-host.mjs'

const full = process.argv.includes('--full')

const results = []
let failed = false

function run(label, command, args, cwd = PKG) {
  const started = Date.now()
  process.stdout.write(`\n=== ${label} ===\n`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const code = result.status ?? 1
  results.push({ label, code, seconds })
  if (code !== 0) failed = true
  return code === 0
}

function report() {
  console.log('\n=== mc-test summary ===')
  for (const { label, code, seconds } of results) {
    console.log(`  ${code === 0 ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} ${seconds.padStart(6)}s`)
  }
  console.log(`  ${failed ? 'GATE FAILED' : 'GATE PASSED'}`)
}

let host
try {
  host = resolveTestHost()
} catch (error) {
  console.error(`mc-test: ${error.message}`)
  process.exit(2)
}

const vitestEntry = join(host.root, 'node_modules', 'vitest', 'vitest.mjs')
const tscEntry = join(PKG, 'node_modules', 'typescript', 'bin', 'tsc')

console.log(`mc-test: host   = ${host.root}  (${host.source})`)
console.log(`mc-test: mode   = ${full ? '--full' : '--quick'}`)

if (!host.installed || !existsSync(vitestEntry)) {
  console.error(`mc-test: host has no runnable vitest — run: node ${join(SCRIPTS, 'bootstrap-testhost.mjs')} --install`)
  process.exit(2)
}

// The suite is a byte-identical mirror of tests/; write it when absent, then
// always verify, so a stale mirror cannot pass silently.
if (!host.suite) run('sync-specs (write)', process.execPath, [join(SCRIPTS, 'sync-specs.mjs')])
if (!run('sync-specs --check', process.execPath, [join(SCRIPTS, 'sync-specs.mjs'), '--check'])) {
  report()
  process.exit(1)
}

run('vitest suite', process.execPath, [vitestEntry, 'run', SUITE_TESTS.replace(/\\/g, '/'), '--coverage.enabled=false'], host.root)

if (full) {
  if (existsSync(tscEntry)) {
    run('build (tsc)', process.execPath, [tscEntry, '-p', 'tsconfig.build.json'])
  } else {
    results.push({ label: 'build (tsc)', code: 1, seconds: '0.0' })
    failed = true
  }
  run('build (client)', process.execPath, [join(SCRIPTS, 'copy-client.mjs')])
  run('acceptance', process.execPath, [join(SCRIPTS, 'mc-acceptance.mjs')])
  run('memory audit', process.execPath, [join(SCRIPTS, 'mc-memory-audit.mjs'), '--json'])
  run('records check', process.execPath, [join(SCRIPTS, 'mc-records-check.mjs')])
}

report()
process.exit(failed ? 1 : 0)
