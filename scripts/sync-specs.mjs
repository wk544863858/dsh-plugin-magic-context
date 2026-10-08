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
 * The two copies are byte-identical: the specs address this repository's
 * sources by absolute path, and `historian-terminal.spec.ts` imports the
 * checkout's mock adapter relatively — a path that only resolves where vitest
 * runs. Copying verbatim keeps the check trivially exact.
 *
 * Checkout location: MC_DSH_CHECKOUT (default: the documented temp checkout).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)
const REPO_TESTS = join(PKG, 'tests')
const DEFAULT_CHECKOUT = '<path>'
const CHECKOUT = process.env.MC_DSH_CHECKOUT ?? DEFAULT_CHECKOUT
const CHECKOUT_TESTS = join(CHECKOUT, 'packages', 'test-support', 'mc-dsh-poc', 'tests')

const check = process.argv.includes('--check')
const normalize = (text) => text.replace(/\r\n/g, '\n')

if (!existsSync(REPO_TESTS)) {
  console.error(`sync-specs: canonical directory missing: ${REPO_TESTS}`)
  process.exit(2)
}

const names = readdirSync(REPO_TESTS).filter((name) => name.endsWith('.spec.ts')).sort()
if (names.length === 0) {
  console.error('sync-specs: no canonical specs found')
  process.exit(2)
}

if (check && !existsSync(CHECKOUT_TESTS)) {
  console.error(`sync-specs: checkout suite missing: ${CHECKOUT_TESTS}`)
  console.error('  set MC_DSH_CHECKOUT to the checkout root, or run without --check to write it')
  process.exit(2)
}
if (!check) mkdirSync(CHECKOUT_TESTS, { recursive: true })

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
  writeFileSync(target, canonical)
  written += 1
}

// A spec present only in the checkout is dead weight: vitest would run a test
// the repository cannot see.
const orphaned = existsSync(CHECKOUT_TESTS)
  ? readdirSync(CHECKOUT_TESTS).filter((name) => name.endsWith('.spec.ts') && !names.includes(name)).sort()
  : []

if (check) {
  const problems = [...drifted, ...orphaned.map((name) => `${name} (checkout-only)`)]
  if (problems.length > 0) {
    console.error(`sync-specs: ${problems.length} of ${names.length} specs drifted`)
    for (const problem of problems) console.error(`  ! ${problem}`)
    console.error('  fix: node scripts/sync-specs.mjs')
    process.exit(1)
  }
  console.log(`sync-specs: ${names.length} specs identical (${CHECKOUT_TESTS})`)
  process.exit(0)
}

console.log(`sync-specs: wrote ${written} specs to ${CHECKOUT_TESTS}`)
if (checkOnly.length > 0) console.log(`  (created ${checkOnly.length} missing: ${checkOnly.join(', ')})`)
if (orphaned.length > 0) console.warn(`  warn: checkout-only specs (not in the repository): ${orphaned.join(', ')}`)
