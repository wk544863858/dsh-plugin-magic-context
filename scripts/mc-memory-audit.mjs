#!/usr/bin/env node
/**
 * Read-only auditor for the Magic Context memory store + our adapter side.
 *
 * Why this exists: the goal for this adapter is "MC-parity memory, verified
 * end-to-end against the REAL memory store, with upgrade isolation". Ad-hoc
 * SQL in a terminal answers one question at a time and is not repeatable, so
 * this turns the goal's invariants into a checklist anyone can re-run:
 *
 *   1. store identity: schema version, table inventory (mutation log? epoch?)
 *   2. field conformance: every row's category/scope/source_type/status/
 *      timestamps/hash are within the contract's vocabulary
 *   3. our writes: rows produced by the adapter (agent / historian)
 *   4. safety rails: authority guard state, privilege flags, epoch per project
 *   5. duplicate hashes (normalized_hash must be unique per project+category)
 *   6. TTL sanity: only the TTL categories may carry an expiry
 *   7. adapter side: recall watermark, promotion counters, tool-call writes
 *
 * Usage:
 *   node scripts/mc-memory-audit.mjs
 *   node scripts/mc-memory-audit.mjs --memory <memories.db> --adapter <dsh.db>
 *   node scripts/mc-memory-audit.mjs --json
 *
 * It never writes: the memory store is opened readOnly, and every statement is
 * a SELECT/PRAGMA. Exit code is 0 unless a HARD invariant is violated.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const asJson = args.includes('--json')

const memoryDb = flag('memory', join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'memories.db'))
const adapterDb = flag('adapter', join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'dsh-magic-context.db'))

/** Categories the contract defines; anything else is drift. */
const V2_CATEGORIES = ['PROJECT_RULES', 'ARCHITECTURE', 'CONSTRAINTS', 'CONFIG_VALUES', 'NAMING']
const PROMOTABLE_CATEGORIES = [...V2_CATEGORIES, 'ARCHITECTURE_DECISIONS', 'CONFIG_DEFAULTS', 'USER_PREFERENCES', 'USER_DIRECTIVES', 'ENVIRONMENT', 'WORKFLOW_RULES', 'KNOWN_ISSUES']
/** Only these two carry expires_at in the promotion contract (90d / 30d). */
const TTL_CATEGORIES = ['WORKFLOW_RULES', 'KNOWN_ISSUES']

const findings = []
const hard = []
const note = (level, text, detail) => {
  findings.push({ level, text, detail })
  if (level === 'HARD') hard.push(`${text}${detail === undefined ? '' : ` (${detail})`}`)
}

function openReadOnly(path, label) {
  if (!existsSync(path)) {
    note('HARD', `${label} not found`, path)
    return undefined
  }
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    note('HARD', `${label} could not be opened read-only`, String(error?.message ?? error))
    return undefined
  }
}

const tables = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r => r.name))
const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params)?.n ?? 0)

// ── memory store ──────────────────────────────────────────────────────────────
const memory = openReadOnly(memoryDb, 'memory store')
const report = { memoryDb, adapterDb, store: {}, adapter: {}, findings }

if (memory !== undefined) {
  const names = tables(memory)
  const version = (() => {
    for (const table of ['schema_version', 'schema_migrations', 'migrations', 'meta', 'config']) {
      if (!names.has(table)) continue
      const columns = memory.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
      for (const column of ['version', 'schema_version', 'value', 'max_version']) {
        if (!columns.includes(column)) continue
        try {
          const row = memory.prepare(`SELECT MAX(${column}) AS v FROM ${table}`).get()
          if (row?.v !== undefined && row.v !== null) return `${row.v} (${table}.${column})`
        } catch { /* keep looking */ }
      }
    }
    const userVersion = memory.prepare('PRAGMA user_version').get()?.user_version
    return userVersion ? `${userVersion} (PRAGMA user_version)` : 'unknown'
  })()

  report.store = {
    schemaVersion: version,
    tables: [...names].filter(name => /memor|mutation|epoch|project_state|authority|privilege/i.test(name)).sort(),
    memories: count(memory, 'SELECT COUNT(*) n FROM memories'),
    byStatus: Object.fromEntries(memory.prepare('SELECT status, COUNT(*) n FROM memories GROUP BY status').all().map(r => [r.status, Number(r.n)])),
    bySourceType: Object.fromEntries(memory.prepare('SELECT source_type, COUNT(*) n FROM memories GROUP BY source_type').all().map(r => [String(r.source_type), Number(r.n)])),
    byScope: Object.fromEntries(memory.prepare('SELECT scope, COUNT(*) n FROM memories GROUP BY scope').all().map(r => [String(r.scope), Number(r.n)])),
    projects: count(memory, 'SELECT COUNT(DISTINCT project_path) n FROM memories'),
  }
  note('INFO', `store: schema ${version}, ${report.store.memories} rows over ${report.store.projects} projects`)
  if (!report.store.tables.includes('memories')) note('HARD', 'memories table missing')

  // The mutation log is what the m[1] increment lane is built on.
  for (const table of ['memory_mutation_log', 'project_state', 'authority_managed', 'authority_repair_pending', 'context_privilege_state']) {
    note(names.has(table) ? 'INFO' : 'WARN', `${table}: ${names.has(table) ? 'present' : 'ABSENT'}`)
  }
  if (names.has('memory_mutation_log')) {
    report.store.mutationLog = count(memory, 'SELECT COUNT(*) n FROM memory_mutation_log')
    note('INFO', `mutation log rows: ${report.store.mutationLog}`)
  }

  // Category vocabulary drift.
  const drift = memory.prepare('SELECT category, COUNT(*) n FROM memories GROUP BY category').all()
    .filter(r => !PROMOTABLE_CATEGORIES.includes(String(r.category)))
  for (const row of drift) {
    report.store.categoryDrift = [...(report.store.categoryDrift ?? []), `${row.category}: ${row.n}`]
    note('WARN', `category outside the contract vocabulary: ${row.category}`, `${row.n} row(s)`)
  }

  // Duplicate normalized_hash per (project, category) — the dedup key.
  const duplicates = memory.prepare(`
    SELECT project_path, category, normalized_hash, COUNT(*) n
    FROM memories GROUP BY project_path, category, normalized_hash HAVING COUNT(*) > 1 LIMIT 10`).all()
  for (const row of duplicates) note('HARD', 'duplicate normalized_hash', `${row.project_path} / ${row.category} / ${String(row.normalized_hash).slice(0, 12)} ×${row.n}`)

  // TTL sanity.
  const strayExpiry = count(memory, `SELECT COUNT(*) n FROM memories WHERE expires_at IS NOT NULL AND category NOT IN (${TTL_CATEGORIES.map(() => '?').join(',')})`, ...TTL_CATEGORIES)
  if (strayExpiry > 0) note('WARN', `${strayExpiry} row(s) carry expires_at outside the TTL categories`)
  const missingExpiry = count(memory, `SELECT COUNT(*) n FROM memories WHERE expires_at IS NULL AND category IN (${TTL_CATEGORIES.map(() => '?').join(',')})`, ...TTL_CATEGORIES)
  if (missingExpiry > 0) note('WARN', `${missingExpiry} TTL-category row(s) have no expires_at`)

  // Timestamp coherence: created <= updated, and last_seen >= created.
  const incoherent = count(memory, 'SELECT COUNT(*) n FROM memories WHERE updated_at < created_at OR last_seen_at < created_at')
  if (incoherent > 0) note('WARN', `${incoherent} row(s) with incoherent timestamps`)

  // Rows this adapter writes (agent tool calls, historian promotion).
  report.store.ourRows = memory.prepare(`
    SELECT source_type, status, COUNT(*) n FROM memories
    WHERE source_type IN ('agent', 'historian') GROUP BY source_type, status`).all()
    .map(r => ({ source_type: r.source_type, status: r.status, n: Number(r.n) }))
  if (report.store.ourRows.length === 0) note('WARN', 'no adapter-written rows yet (agent writes / historian promotion)')

  // Authority guard: the adapter must refuse to write for these projects.
  const guardTables = ['authority_managed', 'authority_repair_pending'].filter(t => names.has(t))
  report.store.guard = guardTables.map(t => ({ table: t, rows: count(memory, `SELECT COUNT(*) n FROM ${t}`) }))
  const guarded = report.store.guard.reduce((sum, entry) => sum + entry.rows, 0)
  note(guarded === 0 ? 'INFO' : 'WARN', `authority guard rows: ${guarded} (${report.store.guard.map(e => `${e.table}=${e.rows}`).join(', ') || 'no tables'})`)

  // Epoch per project (drives mutation-cursor reset rules).
  if (names.has('project_state')) {
    const columns = memory.prepare('PRAGMA table_info(project_state)').all().map(c => c.name)
    if (columns.includes('project_memory_epoch')) {
      report.store.epochs = memory.prepare('SELECT project_path, project_memory_epoch e FROM project_state ORDER BY project_memory_epoch DESC LIMIT 10').all()
        .map(r => ({ project: r.project_path, epoch: r.e }))
      note('INFO', `epochs tracked for ${report.store.epochs.length} project(s)`)
    } else {
      note('WARN', 'project_state has no project_memory_epoch column')
    }
  }
  memory.close()
}

// ── adapter side ──────────────────────────────────────────────────────────────
const adapter = openReadOnly(adapterDb, 'adapter journal')
if (adapter !== undefined) {
  const kinds = Object.fromEntries(adapter.prepare('SELECT kind, COUNT(*) n FROM journal GROUP BY kind ORDER BY n DESC').all().map(r => [r.kind, Number(r.n)]))
  const meta = Object.fromEntries(adapter.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]))
  const lastRecall = adapter.prepare("SELECT at, data FROM journal WHERE kind='memory-recall' ORDER BY id DESC LIMIT 1").get()
  const recall = lastRecall === undefined ? undefined : JSON.parse(lastRecall.data ?? '{}')
  const historianStarts = count(adapter, "SELECT COUNT(*) n FROM journal WHERE kind='historian' AND json_extract(data,'$.phase')='start'")
  const historianTerminal = count(adapter, "SELECT COUNT(*) n FROM journal WHERE kind='historian' AND json_extract(data,'$.phase') IN ('done','failed')")
  const promotions = count(adapter, "SELECT COUNT(*) n FROM journal WHERE kind='memory-promote'")
  const toolWrites = count(adapter, "SELECT COUNT(*) n FROM journal WHERE kind='tool-call' AND json_extract(data,'$.action') IN ('write','update','archive','merge')")

  report.adapter = { schema: meta.schema_version, memoryBridge: meta.memory_bridge, memoryWrite: meta.memory_write, compactionEngine: meta.compaction_engine, kinds, historianStarts, historianTerminal, promotions, toolWrites, lastRecall: recall }
  note('INFO', `adapter: schema v${meta.schema_version}, bridge ${meta.memory_bridge}, write ${meta.memory_write}`)
  note('INFO', `recall: ${recall?.rows ?? '?'} rows, watermark ${recall?.maxMemoryId ?? '?'}, digest ${recall?.digest ?? '?'}`)
  note('INFO', `agent write tool calls: ${toolWrites} | promotions: ${promotions}`)

  // A historian that only ever starts means facts (and therefore promotion)
  // can never happen — the exact failure this audit is meant to catch.
  if (historianStarts > 0 && historianTerminal === 0) {
    note('HARD', 'historian never reached a terminal phase', `${historianStarts} start(s), 0 done/failed`)
  } else if (historianStarts > 0) {
    note('INFO', `historian runs: ${historianStarts} started / ${historianTerminal} terminal`)
  }
  adapter.close()
}

// ── output ────────────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('Magic Context memory audit (read-only)')
  console.log(`  memory store : ${memoryDb}`)
  console.log(`  adapter      : ${adapterDb}`)
  console.log('')
  for (const finding of findings) console.log(`  [${finding.level}] ${finding.text}${finding.detail === undefined ? '' : ` — ${finding.detail}`}`)
  console.log('')
  console.log(hard.length === 0
    ? '  Result: OK (no hard invariant violated)'
    : `  Result: ${hard.length} HARD violation(s)`)
}
process.exit(hard.length === 0 ? 0 : 1)
