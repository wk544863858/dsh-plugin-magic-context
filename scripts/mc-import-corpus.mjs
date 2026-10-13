#!/usr/bin/env node
/**
 * mc-import-corpus.mjs — the ONE-SHOT legacy → own-corpus migration.
 *
 * Cutover (user ruling 2026-10-13): the adapter stops sharing upstream MC's
 * `context.db`. This script is the ONLY code allowed to resolve the legacy
 * path: it reads the legacy store once and copies the corpus into the
 * plugin's own database, preserving ids (supersede chains, watermarks and
 * the visibility maxMemoryId all reference them). Vectors are copied as-is
 * per the ruling — no re-embed pass.
 *
 * Safety: dry-run by default (counts only); `--write` performs the copy in
 * ONE transaction; refuses when the target already holds memories (use
 * `--force` to override after an aborted run — idempotent by row id, but an
 * accidental second import into a corpus that has since grown would be
 * wrong). The legacy store is opened readOnly and never modified.
 *
 * Usage:
 *   node scripts/mc-import-corpus.mjs               # dry run
 *   node scripts/mc-import-corpus.mjs --write
 *   node scripts/mc-import-corpus.mjs --write --force
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Import the DDL + marker constants from the BUILT module so the importer
// and the runtime can never drift apart. Run `npm run build` first.
// (Windows: absolute paths must go through a file:// URL for dynamic import.)
const { ensureOwnCorpusStore, CORPUS_IMPORT_MARKER_VERSION } = await import(
  pathToFileURL(resolve(PKG, 'lib/core/corpus-store.js')).href)

const legacyPath = resolve(process.env.USERPROFILE ?? '', '.local/share/cortexkit/magic-context/context.db')
const ownPath = resolve(process.env.USERPROFILE ?? '', '.local/share/cortexkit/magic-context-dsh-poc/memories.db')

const args = new Set(process.argv.slice(2))
const doWrite = args.has('--write')
const force = args.has('--force')

if (!existsSync(legacyPath)) {
  console.log(`legacy store not found: ${legacyPath} — nothing to import (fresh machine), exiting.`)
  process.exit(0)
}

ensureOwnCorpusStore(ownPath)

const legacy = new DatabaseSync(legacyPath, { readOnly: true })
const own = new DatabaseSync(ownPath)
own.exec('PRAGMA busy_timeout = 5000')

const legacyVersion = legacy.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000').get()?.v
const counts = table => legacy.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0
const ownCount = table => own.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0

const plan = [
  { table: 'memories', columns: null },
  { table: 'memory_embeddings', columns: null },
  { table: 'memory_mutation_log', columns: null },
  { table: 'project_state', columns: null },
  { table: 'user_memories', columns: null },
  { table: 'user_memory_candidates', columns: null },
]

console.log(`legacy : ${legacyPath} (schema v${legacyVersion})`)
for (const step of plan) console.log(`  ${step.table.padEnd(26)} ${String(counts(step.table))} rows`)
console.log(`own    : ${ownPath} (schema v${own.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000').get()?.v})`)

const alreadyImported = own.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = ?')
  .get(CORPUS_IMPORT_MARKER_VERSION)?.c ?? 0
if (alreadyImported > 0) {
  console.log('import marker already present — this corpus was imported before; nothing to do.')
  process.exit(0)
}
if (ownCount('memories') > 0 && !force) {
  console.log(`target already holds ${ownCount('memories')} memory rows; refusing without --force.`)
  process.exit(1)
}

if (!doWrite) {
  console.log('\nDRY RUN — nothing written. Re-run with --write to import.')
  process.exit(0)
}

const t0 = Date.now()
// URI attach with mode=ro: even though this connection is read-write, the
// legacy file can never be written through it.
const legacyUri = `${pathToFileURL(legacyPath).href}?mode=ro`
own.prepare('ATTACH DATABASE ? AS legacy').run(legacyUri)
try {
  own.exec('BEGIN IMMEDIATE')
  let copied = 0
  for (const step of plan) {
    const columns = legacy.prepare(`SELECT group_concat(name) AS cols FROM pragma_table_info('${step.table}')`).get()?.cols
    const ownColumns = own.prepare(`SELECT group_concat(name) AS cols FROM pragma_table_info('${step.table}')`).get()?.cols
    if (columns === undefined || ownColumns === undefined) {
      console.log(`  SKIP ${step.table}: missing on one side (legacy=${String(columns !== undefined)}, own=${String(ownColumns !== undefined)})`)
      continue
    }
    // Column-intersect copy: the own corpus may carry fewer columns than a
    // legacy store that kept growing (or vice versa after our own future
    // migrations) — only shared columns move.
    const shared = columns.split(',').filter(column => ownColumns.split(',').includes(column))
    const columnList = shared.join(', ')
    const result = own.prepare(`INSERT OR IGNORE INTO ${step.table} (${columnList}) SELECT ${columnList} FROM legacy.${step.table}`).run()
    copied += result.changes
    console.log(`  ${step.table.padEnd(26)} +${String(result.changes)} rows`)
  }
  own.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)')
    .run(CORPUS_IMPORT_MARKER_VERSION, 'corpus-imported-from-legacy-context-db', Date.now())
  own.exec('COMMIT')
  console.log(`\ndone: ${String(copied)} rows in ${String(Date.now() - t0)}ms (marker v${String(CORPUS_IMPORT_MARKER_VERSION)} written)`)
} catch (error) {
  own.exec('ROLLBACK')
  console.error(`FAILED (rolled back): ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
} finally {
  own.exec('DETACH DATABASE legacy')
  own.close()
  legacy.close()
}
