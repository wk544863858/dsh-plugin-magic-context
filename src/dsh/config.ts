/**
 * The adapter's configuration contract (moved verbatim out of index.ts so the
 * wiring modules can type their `config` without importing the composition
 * root). Nothing here executes; index.ts re-exports the interface.
 */
import type { JournalLevel } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'

export interface MagicContextDshConfig {
  /** Directory for the adapter's SQLite store. Defaults under ~/.local/share. */
  dataDir?: string
  /** Master switch; false keeps the plugin loaded but fully inert. */
  enabled?: boolean
  /** Register the ctx_reduce / ctx_expand agent tools (default true). */
  registerTools?: boolean
  /** Register the /ctx-status command (default true). */
  registerStatusCommand?: boolean
  /**
   * Host-supplied tool constructor. In-tree glue (which resolves
   * @deepseek-ai/dsh-tools natively) passes it here; when absent the
   * adapter falls back to a dynamic import, which only works in loading
   * modes where that specifier is resolvable from this package.
   */
  defineTool?: MagicContextDshConfigDefineTool
  /** Explicit historian route; default is the session's last routed model. */
  historian?: { provider: string; model: string }
  /** Turn the historian's out-of-band digests off (default: on). */
  historianEnabled?: boolean
  /**
   * Write one notice entry (`user/message`, producer kind `magic-context`,
   * form `notice`) into the session stream after each management pass that
   * actually did something — publish, force-drop, or fact promotion. The
   * transcript renders it as a collapsed notice row. Default true; the entry
   * is model-visible, so it costs its own (short) tokens until compaction.
   */
  sessionNotices?: boolean
  /**
   * Project-memory recall from Magic Context's shared `context.db`. Off when
   * omitted; reads only (writes stay with Magic Context's own storage layer).
   */
  memory?: {
    /** Explicit path to context.db; defaults to the CortexKit data directory. */
    dbPath?: string
    /** Master switch for the whole memory lane (default true when memory is present). */
    enabled?: boolean
    /**
     * Identity (`git:<root-sha>` / `dir:<hash>`) OR a directory to derive it
     * from. Unset falls back to the session's cwd, so project memory works
     * with no configuration at all.
     */
    project?: string
    /** Extra identities to read shared rows from; unset uses the DB's workspace. */
    workspaceProjects?: readonly string[]
    /** Category whitelist for shared rows; unset uses the workspace's policy. */
    shareCategories?: readonly string[]
    /**
     * Promote the historian's facts into project memory (Magic Context's
     * `memory.auto_promote`). Default true when memory is configured: facts
     * only become durable knowledge through this path.
     */
    autoPromote?: boolean
    /**
     * Let the agent maintain memories through `ctx_memory` (write/update/
     * archive/merge). Default true; false keeps the tool read-only while the
     * bridge still injects existing memories.
     */
    write?: boolean
    /**
     * Backfill stored-query vectors for rows the shared store has none of
     * (the B4 lane). Default false: the query side embeds on demand anyway,
     * and the backfill costs a local model load. Intentionally undocumented
     * in the settings schema — profile-JSON only.
     */
    embedBackfill?: boolean
  }
  /**
   * Turn the reduce-guidance band (desk section + Channel 1/2) off entirely
   * (default true). Read through the volatile reference live at every pass.
   */
  reduceGuidance?: boolean
  /**
   * Auto-search hint: one "you may recall something related" entry per user turn
   * (default true, `search-hint.ts`). The hint is FTS-only and deadline-bounded.
   */
  searchHint?: boolean
  /**
   * The maintenance tick's schedule + verify route. Profile-JSON only (the
   * settings schema at index.ts declares the volatile fields the form may
   * edit; these arrive through the same patch object either way).
   */
  maintenance?: {
    enabled?: boolean
    intervalMs?: number
    verifyProvider?: string
    verifyModel?: string
  }
  /**
   * Host-supplied CompactionEngine base class (in-tree glue injects it; when
   * absent the adapter resolves `@deepseek-ai/dsh-compaction` dynamically).
   */
  compactionBase?: unknown
  /** Mount the adapter's CompactionEngine on the `compaction` seam (default true when resolvable). */
  registerCompactionEngine?: boolean
  /**
   * Validation-period observability. The Desktop app does not persist the
   * harness logger, so decisions and outcomes go to the adapter's own journal
   * table plus (by default) a human-readable mirror file; see
   * scripts/mc-report.mjs for the review side.
   */
  journal?: {
    /** Turn the journal off entirely (default: on). */
    enabled?: boolean
    /** Minimum persisted level (default 'info'; 'warn' drops routine events). */
    level?: JournalLevel
    /** Retention in days, pruned when the journal opens (default 30). */
    retentionDays?: number
    /** Write the one-line text mirror (default true). */
    mirror?: boolean
  }
  /** §N§ tag registry retention (default 30 days; pruned once per mount). */
  tags?: {
    retentionDays?: number
  }
  /** Pressure policy overrides; unset fields keep the defaults. */
  policy?: Partial<PressurePolicy>
}

export type MagicContextDshConfigDefineTool = typeof import('@deepseek-ai/dsh-tools')['defineTool']
