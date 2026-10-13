/**
 * Single source for the Magic Context store DDL the specs simulate.
 *
 * Eleven specs used to inline near-identical `CREATE TABLE memories` blocks
 * that had already drifted: three lacked the mural_cue columns. Every block
 * here is the contract-pinned shape first written in memory-write.spec
 * (contract §1.1 memories, §5.1/§6.1 support tables, §8.4 authority, §1.5
 * FTS, artefact tables) and validated byte-for-byte against a real v94 store.
 * Scenario-specific inputs stay local to the specs that need them — e.g.
 * memory-search grows a minimal FTS variant on purpose.
 *
 * The stamp columns (first_seen_at/created_at/updated_at/last_seen_at) are
 * NOT NULL without defaults, exactly like MC's own schema (storage-db.ts);
 * seed code must supply them.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** MC's `memories` DDL, verbatim (contract §1.1). */
export const MEMORIES_DDL = `
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
`

/** The mutation-log table the delta lanes read (contract §5.1). */
export const MUTATION_LOG_DDL = `
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
`

/** The project-state table (contract §6.1). */
export const PROJECT_STATE_DDL = `
  CREATE TABLE project_state (
    project_path TEXT PRIMARY KEY,
    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`

/** Both delta-lane tables together (contract §5.1, §6.1). */
export const SUPPORT_DDL = `${MUTATION_LOG_DDL}${PROJECT_STATE_DDL}`


/** The FTS external-content table and its sync triggers, verbatim (contract §1.5). */
export const FTS_DDL = `
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
`

/**
 * The classify/verify artefact tables the §4.5 clears target.
 *
 * Shapes verified against the live contract on 2026-10-10. The earlier version
 * of this fixture had drifted: `memory_embeddings` was declared with `model` and
 * a `created_at` column, neither of which exists upstream (the real key is
 * `(memory_id, model_id)` with a NOT NULL blob), and `memory_verifications` was
 * missing two NOT NULL columns. A fixture that does not match the store makes
 * every test that touches it prove nothing.
 */
export const ARTEFACT_DDL = `
  CREATE TABLE memory_embeddings (
    memory_id INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY(memory_id, model_id));
  CREATE TABLE memory_verifications (
    memory_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    mapped_at INTEGER NOT NULL,
    mapping_origin TEXT NOT NULL,
    PRIMARY KEY(memory_id, file_path));
`

/**
 * The user-profile tables, verbatim from the live corpus (2026-10-10):
 * `user_memory_candidates` is the staging pool the historian feeds (WP5) and
 * `user_memories` is the promoted profile the render lane reads (WP7/WP8).
 * `project_state['__global__'].project_user_profile_version` is NOT created
 * here — it lives in `project_state`, which callers request separately.
 */
export const PROFILE_DDL = `
  CREATE TABLE user_memory_candidates(
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_compartment_start INTEGER,
    source_compartment_end INTEGER,
    created_at INTEGER NOT NULL);
  CREATE INDEX idx_umc_created ON user_memory_candidates(created_at);
  CREATE TABLE user_memories(
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    promoted_at INTEGER NOT NULL,
    source_candidate_ids TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_candidate_provenance TEXT);
  CREATE INDEX idx_um_status ON user_memories(status);
`

/**
 * Create a throwaway context.db in a fresh temp dir with the requested
 * tables, stamp `schemaVersion` into schema_migrations (null skips the
 * table entirely), close the handle, and return the path plus the temp dir
 * (specs register `dir` with their own afterEach cleanup).
 */
export function makeMemoryDb(input: {
  prefix?: string
  schemaVersion?: number | null
  mutationLog?: boolean
  projectState?: boolean
  fts?: boolean
  artefacts?: boolean
  profile?: boolean
}): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), input.prefix ?? 'mc-db-'))
  const path = join(dir, 'context.db')
  const db = new DatabaseSync(path)
  try {
    let ddl = MEMORIES_DDL
    if (input.mutationLog) ddl += MUTATION_LOG_DDL
    if (input.projectState) ddl += PROJECT_STATE_DDL
    if (input.fts) ddl += FTS_DDL
    if (input.artefacts) ddl += ARTEFACT_DDL
    if (input.profile) ddl += PROFILE_DDL
    if (input.schemaVersion !== null) {
      ddl += '  CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER);\n'
    }
    db.exec(ddl)
    if (input.schemaVersion !== null) {
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, 0)').run(input.schemaVersion ?? 95)
    }
  } finally {
    db.close()
  }
  return { path, dir }
}
