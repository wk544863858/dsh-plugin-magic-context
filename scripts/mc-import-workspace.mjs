#!/usr/bin/env node
/**
 * One-time (and safely re-runnable) move of the contract's workspace membership
 * into the adapter's own domain table (WP2 of the execution plan).
 *
 *   node scripts/mc-import-workspace.mjs --dry-run
 *   node scripts/mc-import-workspace.mjs [--workspace <name>] [--enable]
 *   node scripts/mc-import-workspace.mjs --rollback
 *
 * Why a script and not a migration: this is DATA movement between two stores,
 * not a schema change. It must be observable (a dry run prints exactly what
 * would be taken over), re-runnable (idempotent), and reversible (--rollback).
 * Importing never enables the domain unless --enable is passed: taking the data
 * over and switching it on are deliberately separate acts.
 *
 * The logic lives in src/core/domain-import.ts and is reused here verbatim, so
 * the tool cannot drift from the tested code path.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const flags = new Map()
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (!arg.startsWith('--')) continue
  const next = args[i + 1]
  if (next !== undefined && !next.startsWith('--')) {
    flags.set(arg.slice(2), next)
    i += 1
  } else {
    flags.set(arg.slice(2), true)
  }
}

const { defaultContractDb } = await import('./mc-contract-freeze.mjs')
const { openStores, defaultDataDir } = await import('../src/core/stores.ts')
const { readWorkspacePlan, importWorkspacePlan, rollbackWorkspaceImport, summarizePlan } = await import(
  '../src/core/domain-import.ts'
)

const contractDb = resolve(typeof flags.get('db') === 'string' ? flags.get('db') : defaultContractDb())
const dataDir = resolve(typeof flags.get('data-dir') === 'string' ? flags.get('data-dir') : defaultDataDir())
const workspaceName = typeof flags.get('workspace') === 'string' ? flags.get('workspace') : undefined

if (!existsSync(contractDb)) {
  console.error(`mc-import-workspace: contract database not found: ${contractDb}`)
  process.exit(2)
}

console.log(`mc-import-workspace: contract = ${contractDb}`)
console.log(`mc-import-workspace: adapter  = ${dataDir}`)

if (flags.get('rollback') === true) {
  const store = openStores(dataDir)
  try {
    const removed = rollbackWorkspaceImport(store, Date.now())
    console.log(`rollback: removed ${removed} member(s) from the org domain and disabled it`)
  } finally {
    store.close()
  }
  process.exit(0)
}

let plan
try {
  plan = readWorkspacePlan(contractDb, workspaceName)
} catch (error) {
  console.error(`mc-import-workspace: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const summary = summarizePlan(plan)
console.log(`workspace "${plan.workspaceName}" (id ${plan.workspaceId}): ${summary.total} member(s)`)
console.log(`  identities: git=${summary.git} dir=${summary.dir} other=${summary.other}`)
console.log(`  share categories: ${JSON.stringify(plan.shareCategories)}`)
for (const member of plan.members) {
  console.log(`  - ${member.displayName} -> ${member.identity} (${member.displayPath})`)
}

if (summary.other > 0) {
  console.error(
    'mc-import-workspace: refusing to import bare-path identities — they would not match the adapter\'s'
      + ' normalized identity and the domain would silently never activate. Normalize them first.',
  )
  process.exit(2)
}

if (flags.get('dry-run') === true) {
  console.log('dry run: nothing written')
  process.exit(0)
}

const store = openStores(dataDir)
try {
  const enable = flags.get('enable') === true
  const result = importWorkspacePlan(store, plan, { now: Date.now(), enable })
  console.log(
    `imported: domain=${result.domainId} members ${result.membersBefore} -> ${result.membersAfter}`
      + ` (${result.imported} in plan), enabled=${result.enabled}, changed=${result.changed}`,
  )
  console.log(`fingerprint: ${result.fingerprint}`)
} finally {
  store.close()
}
