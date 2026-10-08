#!/usr/bin/env node
/**
 * One command for the adapter's local gate.
 *
 *   node scripts/mc-test.mjs           # --quick: typecheck + the vitest suite
 *   node scripts/mc-test.mjs --full    # + build, acceptance, memory audit, records
 *
 * The suite runs in this repository. It used to run inside a DSH checkout,
 * mirrored there by `sync-specs.mjs`, because the sources had no `node_modules`
 * of their own; now `npm install` provides `vitest` and the pinned
 * `@deepseek-ai/*` packages, so there is no host to resolve and no mirror to
 * verify. The specs address `../src/...` directly.
 *
 * This script owns the whole sequence so no step depends on a remembered
 * command line. Children are started as `node <entry>.mjs` rather than through
 * the `node_modules/.bin` shims, because those are `.CMD` files on Windows and
 * going through `cmd.exe` breaks on the space in `C:\Program Files\nodejs`.
 * Output is inherited, so failures are readable in place.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's root. */
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

const vitestEntry = join(PKG, 'node_modules', 'vitest', 'vitest.mjs')
const tscEntry = join(PKG, 'node_modules', 'typescript', 'bin', 'tsc')

console.log(`mc-test: package = ${PKG}`)
console.log(`mc-test: mode    = ${full ? '--full' : '--quick'}`)

if (!existsSync(join(PKG, 'node_modules'))) {
  console.error('mc-test: no node_modules — run: npm install')
  process.exit(2)
}

// Typecheck first: it is the cheapest step and it is the one the build's
// `noCheck` cannot give. A green compile that does not typecheck is exactly
// the failure mode this step exists to prevent.
run('typecheck (tsc)', process.execPath, [tscEntry, '--noEmit'])

if (!existsSync(vitestEntry)) {
  console.error('mc-test: vitest is not installed — run: npm install')
  process.exit(2)
}
run('vitest suite', process.execPath, [vitestEntry, 'run'])

if (full) {
  run('build (tsc)', process.execPath, [tscEntry, '-p', 'tsconfig.build.json'])
  run('build (client)', process.execPath, [join(PKG, 'scripts', 'copy-client.mjs')])
  run('acceptance', process.execPath, [join(PKG, 'scripts', 'mc-acceptance.mjs')])
  run('memory audit', process.execPath, [join(PKG, 'scripts', 'mc-memory-audit.mjs'), '--json'])
  run('records check', process.execPath, [join(PKG, 'scripts', 'mc-records-check.mjs')])
}

report()
process.exit(failed ? 1 : 0)
