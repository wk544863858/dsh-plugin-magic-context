#!/usr/bin/env node
/**
 * The runnable suite lives in the DSH checkout (this repository has no
 * `node_modules`, so vitest cannot resolve its own specifier here); the
 * canonical copy is `packages/dsh-plugin/tests/`, committed so the suite can
 * never be lost with a temporary directory.
 *
 *   node scripts/sync-specs.mjs            # repo -> checkout (writes)
 *   node scripts/sync-specs.mjs --check    # verify equality, exit 1 on drift
 *
 * Every `.ts` file under tests/ is synced, preserving relative layout
 * (`*.spec.ts` entries plus shared fixtures such as `helpers/memory-db.ts`).
 * The two copies are byte-identical: the specs address this repository's
 * sources by absolute path, and `historian-terminal.spec.ts` imports the
 * checkout's mock adapter relatively — a path that only resolves where vitest
 * runs. Copying verbatim keeps the check trivially exact.
 *
 * Checkout location: `MC_DSH_CHECKOUT` (or `DSH_TESTHOST`), else the project-local
 * snapshot at `<repo>/<tmp>/deepseek-harness-master`, else the legacy
 * temp checkout. See `test-host.mjs`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { PKG, SUITE_TESTS, resolveTestHost } from './test-host.mjs'

const REPO_TESTS = join(PKG, 'tests')

let HOST
try {
  HOST = resolveTestHost()
} catch (error) {
  console.error(`sync-specs: ${error.message}`)
  process.exit(2)
}
const CHECKOUT = HOST.root
const CHECKOUT_TESTS = join(CHECKOUT, SUITE_TESTS)

const check = process.argv.includes('--check')
const normalize = (text) => text.replace(/\r\n/g, '\n')

/** Every `.ts` file under root, as sorted relative paths. */
function collect(root) {
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return out
}

if (!existsSync(REPO_TESTS)) {
  console.error(`sync-specs: canonical directory missing: ${REPO_TESTS}`)
  process.exit(2)
}

const names = collect(REPO_TESTS)
if (names.length === 0) {
  console.error('sync-specs: no canonical .ts files found')
  process.exit(2)
}

if (check && !existsSync(CHECKOUT_TESTS)) {
  console.error(`sync-specs: checkout suite missing: ${CHECKOUT_TESTS}`)
  console.error('  set MC_DSH_CHECKOUT to the checkout root, or run without --check to write it')
  process.exit(2)
}

let written = 0
const drifted = []
const checkOnly = names.filter((name) => !existsSync(join(CHECKOUT_TESTS, name)))
for (const name of names) {
  const canonical = normalize(readFileSync(join(REPO_TESTS, name), 'utf8'))
  const target = join(CHECKOUT_TESTS, name)
  if (check) {
    if (!existsSync(target)) { drifted.push(`${name} (missing in checkout)`); continue }
    if (normalize(readFileSync(target, 'utf8')) !== canonical) drifted.push(name)
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, canonical)
  written += 1
}

// A file present only in the checkout is dead weight: vitest would run (or
// import) something the repository cannot see.
const orphaned = collect(CHECKOUT_TESTS).filter((name) => !names.includes(name))

if (check) {
  const problems = [...drifted, ...orphaned.map((name) => `${name} (checkout-only)`)]
  if (problems.length > 0) {
    console.error(`sync-specs: ${problems.length} of ${names.length} files drifted`)
    for (const problem of problems) console.error(`  ! ${problem}`)
    console.error('  fix: node scripts/sync-specs.mjs')
    process.exit(1)
  }
  console.log(`sync-specs: ${names.length} files identical (${CHECKOUT_TESTS})`)
  process.exit(0)
}

console.log(`sync-specs: wrote ${written} files to ${CHECKOUT_TESTS}`)
if (checkOnly.length > 0) console.log(`  (created ${checkOnly.length} missing: ${checkOnly.join(', ')})`)
if (orphaned.length > 0) console.warn(`  warn: checkout-only files (not in the repository): ${orphaned.join(', ')}`)
