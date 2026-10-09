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
     * S(t) decay scoring (schema v7 sidecar, borrowed from mon3stera's
     * dsh-magic-context): hits slow the decay and boost the score;
     * sub-threshold rows stop being injected here (they stay searchable in
     * ctx_memory). Stats are ALWAYS collected in the adapter's own
     * `memory_stats` table; `enabled` gates only the ranking takeover.
     * Profile-JSON only (like the rest of `memory`, not in the settings
     * schema — a declared key would open the lane for every profile).
     */
    scoring?: {
      /** Default false: collect stats, keep MC's ranking. */
      enabled?: boolean
      /** Hit boost strength (mon3stera default 0.4). */
      alpha?: number
      /** How much each hit slows the decay (mon3stera default 0.2). */
      beta?: number
      /** Scores below this stop being injected (default 2, on the 1–100 scale). */
      archiveThreshold?: number
      /** Category half-life in DAYS; null = immortal. Defaults: PROJECT_RULES/
       * ARCHITECTURE/CONSTRAINTS immortal, CONFIG_VALUES 60, NAMING 90,
       * USER_PREFERENCES 14, WORKFLOW_RULES/KNOWN_ISSUES 30, ENVIRONMENT 90. */
      halfLives?: Record<string, number | null>
    }
    /**
     * Global-domain activation (adapter schema v8). `adapter` (default) resolves
     * the domains a project activates from the ADAPTER's own table — the contract
     * workspace tables have no writer left once Magic Context's dashboard goes.
     * `contract` keeps the old lookup for one release so the two sources can be
     * compared; it is a rollback lever, not a supported end state.
     */
    domains?: {
      /** Default 'adapter'. */
      source?: 'adapter' | 'contract'
    }
    /**
     * The `user` (profile) lane. It has no activation rule because it is about
     * the person, not a project — which is exactly why its two halves are
     * separate switches: rendering reads the shared store, collecting writes it.
     */
    global?: {
      user?: {
        /**
         * Inject the stored profile as m[0] `<user-profile>` (and new entries as
         * m[1] `<new-user-profile>`). Default true — Magic Context injected the
         * profile into every session, and this adapter had no such lane.
         * Read-only: nothing is written to the shared store.
         */
        render?: boolean
        /**
         * Produce new profile candidates from DSH sessions. Default FALSE: this
         * is the path that writes to the shared store, so it stays off until
         * the write is deliberately turned on.
         */
        collect?: boolean
        /**
         * Review candidates into the profile (`user_memories`) — the half that
         * makes a promoted fact inject into EVERY session. Default FALSE, and
         * deliberately separate from `collect`: gathering observations is
         * reversible, publishing a standing rule about the user is not.
         */
        review?: boolean
      }
      machine?: {
        /**
         * Share knowledge between every project on THIS machine. Default FALSE:
         * switching it on widens what every local project can read, so it is an
         * operator decision, not a default.
         */
        enabled?: boolean
        /**
         * Projects kept OUT of the machine domain, even while it is on. Names
         * are `git:`/`dir:` identities, exactly as they appear in `ctx-status`.
         * An excluded project neither sees machine rows nor joins the domain;
         * excluding never deletes anything else (see planMachineDomain).
         */
        excludeProjects?: readonly string[]
      }
    }
    /**
     * Workspace root for the evidence pass (schema v7): its greps run here.
     * Defaults to `memory.project` when that is a real filesystem path.
     */
    evidenceRoot?: string
    /**
     * Embed query-side candidates in memory instead of reading stored vectors
     * (the B4 lane, `memory-lane.ts`). Default TRUE — this is what lets a search
     * work at all on rows the store has no vector for. It writes nothing.
     * (The old comment here claimed a false default while the code read true;
     * the flag was never the backfill switch, and WP11 added the real one below.)
     */
    embedBackfill?: boolean
    /**
     * WP11: fill `memory_embeddings` for active rows the dominant space is
     * missing. Default FALSE — this is the switch that WRITES vectors into the
     * shared store, so it is opt-in, and it only ever writes after the
     * shared-space parity gate has passed (see `vector-backfill.ts`).
     */
    vectorBackfill?: boolean
    /**
     * Rows per maintenance tick for the vector backfill (default 24). Bounds how
     * much of the shared store one pass touches; the remaining gap is picked up
     * by the next tick.
     */
    vectorBackfillLimit?: number
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
    /**
     * The evidence pass (schema v7, borrowed from mon3stera's
     * codebase-grounded verify): `shadow` journals what the workspace
     * evidence would decide against each stage-1 stale/wrong flag (default
     * `off`); `enforce` defers the destructive stage-1 verdicts and lets the
     * evidence decide instead. Needs a workspace root — `memory.evidenceRoot`
     * or a `memory.project` that is a real filesystem path.
     */
    evidenceVerify?: {
      mode?: 'off' | 'shadow' | 'enforce'
      maxRows?: number
    }
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
