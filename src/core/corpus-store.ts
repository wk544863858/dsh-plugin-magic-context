/**
 * Own-corpus bootstrap — the plugin's memory database, owned end to end.
 *
 * Cutover (user ruling 2026-10-13): before small-scale distribution the
 * adapter stops sharing upstream Magic Context's `context.db`. Dual-writer
 * conflicts were structural, not incidental — upstream releases near-daily
 * (0.47/0.48/0.49 within four days), the fence had zero version margin, and
 * MC 0.48's indexCoordination treats every non-MC connection as a foreign
 * body. The corpus now lives in the plugin's OWN data dir; the legacy file is
 * read exactly once, by the importer (`scripts/mc-import-corpus.mjs`), and
 * never touched again. Upstream is followed for FEATURES only, never for
 * storage compatibility.
 *
 * Schema lineage: the shape is inherited verbatim from the upstream v95
 * store the corpus was imported from (validated against the live DDL
 * 2026-10-13), so `MEMORY_SCHEMA_MAX_VERSION` keeps guarding the SAME
 * numbering — but from this module on, every new `schema_migrations` row is
 * OURS: a version above the ceiling can only mean this build is older than
 * the corpus, which must fence exactly as before.
 *
 * Table set: exactly what the openers touch (memory-bridge / memory-write /
 * profile-write / memory-search / vector-lane), nothing more. Upstream
 * subsystems the adapter never reads (workspaces, authority guards, tags,
 * session_meta, primers, git_commits_fts …) are deliberately absent:
 *  - `workspaces` absence is by design — domain resolution reads the
 *    adapter's own domains tables (design v2, no workspace takeover);
 *  - authority-guard triggers protected upstream's module-managed projects;
 *    no such modules exist here, so the writer's hasAuthority=false path is
 *    the honest one.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The version this build creates and understands. Own lineage, inherited shape. */
export const CORPUS_SCHEMA_VERSION = 95

/** Marker row for a corpus imported from the legacy shared store. The main
 * fence lane reads `MAX(version) WHERE version < 10000`, so sidecar markers
 * at ≥ 10000 never influence it. */
export const CORPUS_IMPORT_MARKER_VERSION = 10_001

export type CorpusBootstrapOutcome =
  | 'exists' // a corpus is already there — hands off, whatever its shape
  | 'created' // no file: schema laid down
  | 'repaired-empty' // a 0-byte file existed (a failed opener's residue): replaced
  | 'failed' // create or sanity check threw — caller proceeds; openers will refuse loudly

const SCHEMA_DDL = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT,
    applied_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    normalized_hash TEXT NOT NULL,
    importance INTEGER,
    scope TEXT NOT NULL DEFAULT 'project',
    shareable INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT,
    source_type TEXT DEFAULT 'historian',
    seen_count INTEGER DEFAULT 1,
    retrieval_count INTEGER DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_retrieved_at INTEGER,
    status TEXT DEFAULT 'active',
    expires_at INTEGER,
    verification_status TEXT DEFAULT 'unverified',
    verified_at INTEGER,
    classified_at INTEGER,
    superseded_by_memory_id INTEGER,
    merged_from TEXT,
    metadata_json TEXT,
    mural_cue TEXT,
    mural_cue_hash TEXT,
    mural_cue_at INTEGER,
    mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_path, category, normalized_hash)
  );
  CREATE INDEX idx_memories_project_status_category ON memories(project_path, status, category);
  CREATE INDEX idx_memories_project_status_expires ON memories(project_path, status, expires_at);
  CREATE INDEX idx_memories_project_category_hash ON memories(project_path, category, normalized_hash);

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, category, content='memories', content_rowid='id', tokenize='porter unicode61');

  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
  END;

  CREATE TABLE memory_embeddings (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY(memory_id, model_id)
  );

  CREATE TABLE memory_mutation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
    target_memory_id INTEGER NOT NULL,
    superseded_by_id INTEGER,
    category TEXT,
    new_content TEXT,
    queued_at INTEGER NOT NULL
  );
  CREATE INDEX idx_memory_mutation_log_project ON memory_mutation_log(project_path, id);
  CREATE INDEX idx_memory_mutation_log_visibility ON memory_mutation_log(project_path, category, id, target_memory_id);
  CREATE INDEX idx_memory_mutation_log_target ON memory_mutation_log(project_path, target_memory_id, id);

  CREATE TABLE project_state (
    project_path TEXT PRIMARY KEY,
    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    promoted_at INTEGER NOT NULL,
    source_candidate_ids TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_candidate_provenance TEXT
  );

  CREATE TABLE user_memory_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_compartment_start INTEGER,
    source_compartment_end INTEGER,
    created_at INTEGER NOT NULL
  );
`

/**
 * Make sure an own-corpus store exists at `dbPath`. Idempotent, fail-open:
 * every non-`exists` outcome still lets the caller open the store and hit
 * the same refusals the openers would have raised anyway. An EXISTING file
 * is never touched — an operator-pointed legacy store keeps its shape and
 * the fence keeps guarding it.
 */
export function ensureOwnCorpusStore(dbPath: string): { outcome: CorpusBootstrapOutcome; detail?: string } {
  try {
    const existed = existsSync(dbPath)
    if (existed && statSync(dbPath).size > 0) return { outcome: 'exists' }
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('BEGIN')
      db.exec(SCHEMA_DDL)
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)')
        .run(CORPUS_SCHEMA_VERSION, 'own-corpus init (inherited upstream v95 shape)', Date.now())
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    return { outcome: existed ? 'repaired-empty' : 'created', detail: `v${String(CORPUS_SCHEMA_VERSION)}` }
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
