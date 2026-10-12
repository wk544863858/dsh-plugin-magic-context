/**
 * The vector lane: measuring the degradation the takeover caused, and planning
 * (never performing) the backfill.
 *
 * Why measuring is the deliverable, not the fix
 * ---------------------------------------------
 * Magic Context used to own `memory_embeddings` and refill it. That job has no
 * owner now, and nothing in the adapter writes embeddings, so the lane decays
 * silently: recall still *works*, it just answers with fewer neighbours. On
 * 2026-10-10 the damage was already measurable and unmeasured until now:
 *
 *   active 1224 · embedded 904 (73.9%) · missing 404
 *   newest embedded memory id 1103, newest memory id 1326 — nothing written
 *   since id 1103 has an embedding, and 194 rows BELOW that frontier lost one
 *
 * Two embedding spaces coexist (≈744 rows in one model, ≈96 in another as of
 * 2026-10-10 — re-measure rather than trusting these). Writing into the wrong
 * space, or into a third, is the specific failure this module exists to prevent:
 * `memory_embeddings` is keyed `(memory_id, model_id)`, so a wrong-space row is
 * not an error — it is simply invisible to the readers that use the other space,
 * forever.
 *
 * So this module only reads: it reports coverage and hands back the id list a
 * backfill WOULD take. The write itself lives in `vector-backfill.ts` (WP11),
 * which consumes exactly this plan. The switch (`memory.vectorBackfill`)
 * defaulted to off until 2026-10-12 and is on by default since (the write path
 * never embeds, so an off-by-default lane let Chinese semantic recall decay
 * with every new row); the phase-D blind spot that motivated the original
 * wording is closed, the parity gate is not optional.
 */
import { DatabaseSync } from 'node:sqlite'

export interface EmbeddingSpaceShare {
  readonly modelId: string
  readonly rows: number
  readonly memories: number
  /** Fraction of all embedding rows in this space. */
  readonly share: number
}

export interface VectorLaneReport {
  readonly active: number
  readonly embedded: number
  readonly missing: number
  /** `embedded / active`; 0 when there is nothing active. */
  readonly coverage: number
  readonly spaces: readonly EmbeddingSpaceShare[]
  /** The space with the most rows — the only one a backfill may write into. */
  readonly dominantModelId?: string
  readonly frontier: {
    /** The newest ACTIVE memory that has an embedding (0 when none does). */
    readonly newestEmbeddedMemoryId: number
    readonly newestMemoryId: number
    /** Active memories NEWER than the frontier: the lane is behind by this many. */
    readonly unembeddedAboveFrontier: number
  }
  /** Active memories with no embedding that already sit below the frontier. */
  readonly gapsBelowFrontier: number
  /** Memories carrying rows in more than one space (a leaked/migrated set). */
  readonly multiSpaceMemories: number
  /** How much of the active set the dominant space alone covers. */
  readonly dominantCoverage: number
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name),
  )
}

/** Read the lane's state from the shared store. `undefined` when it cannot be read. */
export function measureVectorLane(contractDbPath: string): VectorLaneReport | undefined {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(contractDbPath, { readOnly: true })
  } catch {
    return undefined
  }
  try {
    if (!tableExists(db, 'memories') || !tableExists(db, 'memory_embeddings')) return undefined
    const memoryColumns = columnNames(db, 'memories')
    const activeFilter = memoryColumns.has('status') ? "WHERE status = 'active'" : ''
    const active = Number((db.prepare(`SELECT COUNT(*) AS c FROM memories ${activeFilter}`).get() as { c: number }).c)
    const newestMemoryId = Number(
      (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM memories ${activeFilter}`).get() as { m: number }).m,
    )

    // Space shares are measured over the ACTIVE corpus: the question they answer
    // is "which space do live memories actually live in", and a reader only ever
    // looks at active rows.
    const activeJoin = memoryColumns.has('status') ? "WHERE m.status = 'active'" : ''
    const spaces = (db.prepare(
      `SELECT e.model_id AS modelId, COUNT(*) AS rows, COUNT(DISTINCT e.memory_id) AS memories
         FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id ${activeJoin}
        GROUP BY e.model_id ORDER BY rows DESC, modelId`,
    ).all() as unknown as Array<{ modelId: string; rows: number; memories: number }>)
    const totalRows = spaces.reduce((sum, space) => sum + Number(space.rows), 0)

    const embeddedIds = db.prepare(
      `SELECT DISTINCT e.memory_id AS id FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id ${memoryColumns.has('status') ? "WHERE m.status = 'active'" : ''}`,
    ).all() as unknown as Array<{ id: number }>
    const embedded = embeddedIds.length

    const dominantModelId = spaces[0]?.modelId
    const dominantIds = dominantModelId === undefined
      ? new Set<number>()
      : new Set(
        (db.prepare(
          `SELECT DISTINCT e.memory_id AS id FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
            WHERE e.model_id = ? ${memoryColumns.has('status') ? "AND m.status = 'active'" : ''}`,
        ).all(dominantModelId) as unknown as Array<{ id: number }>).map(row => Number(row.id)),
      )

    const allEmbeddedIds = new Set(embeddedIds.map(row => Number(row.id)))
    const activeIds = (db.prepare(`SELECT id FROM memories ${activeFilter}`).all() as unknown as Array<{ id: number }>)
      .map(row => Number(row.id))

    // The frontier is the newest ACTIVE memory that has an embedding. Taking the
    // raw MAX(memory_id) instead would let an archived row's leftover embedding
    // look like progress and hide the backlog behind it.
    const newestEmbeddedMemoryId = embeddedIds.reduce((max, row) => Math.max(max, Number(row.id)), 0)

    let unembeddedAboveFrontier = 0
    let gapsBelowFrontier = 0
    let dominantCoverageCount = 0
    for (const id of activeIds) {
      if (!allEmbeddedIds.has(id)) {
        if (id > newestEmbeddedMemoryId) unembeddedAboveFrontier += 1
        else gapsBelowFrontier += 1
      }
      if (dominantIds.has(id)) dominantCoverageCount += 1
    }

    const multiSpaceMemories = Number((db.prepare(
      'SELECT COUNT(*) AS c FROM (SELECT memory_id FROM memory_embeddings GROUP BY memory_id HAVING COUNT(DISTINCT model_id) > 1)',
    ).get() as { c: number }).c)

    return {
      active,
      embedded,
      missing: active - embedded,
      coverage: active === 0 ? 0 : embedded / active,
      spaces: spaces.map(space => ({
        modelId: space.modelId,
        rows: Number(space.rows),
        memories: Number(space.memories),
        share: totalRows === 0 ? 0 : Number(space.rows) / totalRows,
      })),
      ...dominantModelId === undefined ? {} : { dominantModelId },
      frontier: { newestEmbeddedMemoryId, newestMemoryId, unembeddedAboveFrontier },
      gapsBelowFrontier,
      multiSpaceMemories,
      dominantCoverage: active === 0 ? 0 : dominantCoverageCount / active,
    }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

export interface BackfillPlan {
  readonly modelId: string
  /** Bounded, ascending memory ids that have no row in the dominant space. */
  readonly candidates: readonly number[]
  /** How many rows need one, before the bound. */
  readonly total: number
  /** Why the candidate list is empty, when it is. */
  readonly reason?: string
}

/**
 * Which memories a backfill would take, and which space it may write into.
 *
 * A candidate is an ACTIVE memory with no embedding row under the DOMINANT
 * model. That covers both "never embedded" and "embedded only in the other
 * space" — the second case is how a space migration happens without creating a
 * third space.
 *
 * Writes nothing. The contract write is still ahead.
 */
export function planBackfill(contractDbPath: string, options: { limit?: number } = {}): BackfillPlan | undefined {
  const report = measureVectorLane(contractDbPath)
  if (report === undefined) return undefined
  const limit = options.limit ?? 64

  const db = new DatabaseSync(contractDbPath, { readOnly: true })
  try {
    const dominant = report.dominantModelId
    if (dominant === undefined) {
      return { modelId: '', candidates: [], total: 0, reason: 'no embedding space exists yet — the first writer decides the space' }
    }
    const memoryColumns = columnNames(db, 'memories')
    const activeFilter = memoryColumns.has('status') ? "AND m.status = 'active'" : ''
    // Newest first (2026-10-10). The rows a session is most likely to search for
    // are the ones written most recently, so the lane closes the frontier gap
    // before it grinds through the older churn holes. The order is a policy:
    // tests/vector-lane.spec.ts pins it, and flipping it back is the rollback.
    const missing = db.prepare(
      `SELECT m.id AS id FROM memories m
        WHERE NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model_id = ?)
        ${activeFilter}
        ORDER BY m.id DESC`,
    ).all(dominant) as unknown as Array<{ id: number }>
    const ids = missing.map(row => Number(row.id))
    return {
      modelId: dominant,
      candidates: ids.slice(0, limit),
      total: ids.length,
      ...ids.length === 0 ? { reason: 'every active memory already has a row in the dominant space' } : {},
    }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/** One line for a health report: the shape of the decay, not just a percentage. */
export function describeVectorLane(report: VectorLaneReport): string {
  const spaces = report.spaces
    .map(space => `${space.modelId.replace('embedding-provider:', '')} ${String(space.rows)} 行 (${(space.share * 100).toFixed(0)}%)`)
    .join(' / ')
  return `active ${String(report.active)} · 已嵌入 ${String(report.embedded)} (${(report.coverage * 100).toFixed(1)}%) · `
    + `缺 ${String(report.missing)}（前沿之上 ${String(report.frontier.unembeddedAboveFrontier)} / 前沿之下 ${String(report.gapsBelowFrontier)}）· `
    + `空间：${spaces === '' ? '无' : spaces}`
}
