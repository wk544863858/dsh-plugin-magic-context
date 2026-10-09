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
import { parseFlags, stringFlag } from './cli-flags.mjs'

const args = process.argv.slice(2)
const KNOWN_FLAGS = ['dry-run', 'workspace', 'enable', 'rollback', 'db', 'data-dir']
const { flags, unknown: unknownFlags, help } = parseFlags(args, KNOWN_FLAGS)

const USAGE = `usage: mc-import-workspace.mjs [options]

  --dry-run            show what would be imported, write nothing
  --workspace <name>   import this workspace (default: the only one)
  --enable             switch the org domain on after importing
  --rollback           remove the imported members and disable the domain
  --db <path>          contract database (default: the shared context.db)
  --data-dir <path>    adapter data directory

No options at all imports without enabling, which is safe to re-run (idempotent).`

if (help) {
  console.log(USAGE)
  process.exit(0)
}
// An unknown flag must never fall through to "do the import". The failure mode
// this prevents: an operator types `--help` to see what the tool does, and the
// tool does it. The import is idempotent and never enables a domain on its own,
// so the blast radius is small — but a tool that acts on instructions it did not
// understand is a tool nobody can reason about.
if (unknownFlags.length > 0) {
  console.error(`mc-import-workspace: unknown flag --${unknownFlags[0]}\n\n${USAGE}`)
  process.exit(2)
}

const { defaultContractDb } = await import('./mc-contract-freeze.mjs')
const { openStores, defaultDataDir } = await import('../src/core/stores.ts')
const { readWorkspacePlan, importWorkspacePlan, rollbackWorkspaceImport, summarizePlan } = await import(
  '../src/core/domain-import.ts'
)

const contractDb = resolve(stringFlag(flags, 'db') ?? defaultContractDb())
const dataDir = resolve(stringFlag(flags, 'data-dir') ?? defaultDataDir())
const workspaceName = stringFlag(flags, 'workspace')

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
