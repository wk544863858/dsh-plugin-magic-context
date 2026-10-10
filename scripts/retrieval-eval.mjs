/**
 * 检索权重 A/B 评测（P2 数据件，2026-10-10）。
 *
 * 评测集：journal 里真实 ctx_memory search 的查询（47 条，中英混合）。
 * 相关性 oracle：LIKE 子串——行内容包含查询任一实质词（CJK ≥2 字 / 拉丁 ≥3 字，
 * 大小写不敏感）即相关。这是对"FTS 对中文子串天然失明"的公平基准：同一 oracle
 * 对四种融合配置对称。
 * 车道镜像：与 src/core/memory-search.ts 逐行同构——FTS（sanitizeFtsQuery 严格 AND
 * → relaxedFtsQuery 宽松 OR 回退，bm25 排序，LIMIT 50）+ 语义（dominant 全量存储
 * 向量 cosine，clamp01）。融合 = wSem×sem + wFts×reciprocal-rank；单源 ×0.8；
 * score 降序 + id 升序 tiebreak。visibility 不设工作区过滤（对全部配置对称）。
 *
 * 用法：node scripts/retrieval-eval.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { relaxedFtsQuery, sanitizeFtsQuery } from '../src/core/memory-search.ts'
import { defaultEmbeddingCacheDir, openLocalEmbedder } from '../src/core/embedding-local.ts'

const CONTRACT = join(homedir(), '.local', 'share', 'cortexkit', 'magic-context', 'context.db')
const ADAPTER = join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'dsh-magic-context.db')
const NOW = Date.now()
const CONFIGS = [
  { name: 'current 0.7/0.3', sem: 0.7, fts: 0.3 },
  { name: 'balanced 0.5/0.5', sem: 0.5, fts: 0.5 },
  { name: 'fts-heavy 0.3/0.7', sem: 0.3, fts: 0.7 },
  { name: 'fts-heavier 0.15/0.85', sem: 0.15, fts: 0.85 },
  { name: 'sem-heavy 0.85/0.15', sem: 0.85, fts: 0.15 },
  { name: 'pure-sem 1.0/0', sem: 1.0, fts: 0.0 },
  { name: 'pure-fts 0/1.0 (ref)', sem: 0.0, fts: 1.0 },
]

function loadQueries() {
  const db = new DatabaseSync(ADAPTER, { readOnly: true })
  const rows = db.prepare("SELECT data FROM journal WHERE kind='tool-call' AND summary LIKE '%search%' ORDER BY id DESC").all()
  db.close()
  const seen = new Set()
  const queries = []
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data ?? '{}')
      if (typeof data.query !== 'string' || data.query.length < 4) continue
      if (seen.has(data.query)) continue
      seen.add(data.query)
      queries.push(data.query)
    } catch { /* payload is data, not a contract */ }
  }
  return queries
}

function termsOf(query) {
  return query.split(/\s+/)
    .map(term => term.trim().toLowerCase())
    .filter(term => (/[^\x00-\x7f]/.test(term) && term.length >= 2) || (/^[a-z0-9-]+$/.test(term) && term.length >= 3))
}

/** 必要词：最长的 CJK 连续段（≥3 字）；无则最长拉丁词。oracle 用它收紧相关性。 */
function requiredTermOf(terms) {
  const cjk = terms.filter(term => /[^\x00-\x7f]/.test(term)).sort((left, right) => right.length - left.length)
  if (cjk.length > 0) return cjk[0]
  return [...terms].sort((left, right) => right.length - left.length)[0] ?? null
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

async function main() {
  const db = new DatabaseSync(CONTRACT, { readOnly: true })
  const active = db.prepare("SELECT id, content FROM memories WHERE status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?)").all(NOW)
  const contents = new Map(active.map(row => [Number(row.id), String(row.content)]))

  // dominant 空间与全量向量
  const dominant = db.prepare('SELECT model_id, COUNT(*) AS n FROM memory_embeddings GROUP BY model_id ORDER BY n DESC LIMIT 1').get()
  const vecRows = db.prepare(
    "SELECT e.memory_id AS id, e.embedding AS emb FROM memory_embeddings e"
      + " JOIN memories m ON m.id = e.memory_id WHERE e.model_id = ? AND m.status IN ('active','permanent')",
  ).all(dominant.model_id)
  const vectors = new Map()
  for (const row of vecRows) {
    vectors.set(Number(row.id), new Float32Array(row.emb.buffer, row.emb.byteOffset, row.emb.byteLength / 4))
  }
  console.log(`评测池 ${String(active.length)} 行 · dominant ${String(dominant.n)} 向量（${String(vectors.size)} 有效）· 空间 ${String(dominant.model_id).slice(0, 28)}…`)

  // 查询嵌入（本地 embedder，与线上一致）
  const queries = loadQueries()
  console.log(`真实查询 ${String(queries.length)} 条（去重后）`)
  const embedder = openLocalEmbedder({ cacheDir: defaultEmbeddingCacheDir(ADAPTER), logger: { warn: (m) => console.error('embedder:', m) } })
  let embedded
  try {
    embedded = await embedder.embed(queries)
  } catch (error) {
    console.error(`查询嵌入失败，评测无法进行（语义车道是评测主体）: ${String(error)}`)
    process.exit(1)
  }
  if (embedded === null || embedded.some(vec => vec === undefined)) {
    console.error('查询嵌入返回不完整，评测无法进行')
    process.exit(1)
  }

  // 逐查询：oracle + 双车道
  const ftsSql = (matchValue) => db.prepare(
    "SELECT memories.id AS id FROM memories_fts JOIN memories ON memories.id = memories_fts.rowid"
      + " WHERE memories_fts MATCH ? AND memories.status IN ('active','permanent')"
      + " AND (memories.expires_at IS NULL OR memories.expires_at > ?)"
      + " ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT 50",
  ).all(matchValue, NOW).map(row => Number(row.id))

  const cases = []
  for (let qi = 0; qi < queries.length; qi += 1) {
    const query = queries[qi]
    const qvec = embedded[qi]
    const terms = termsOf(query)
    const required = requiredTermOf(terms)
    const oracle = new Set()
    if (required !== null) {
      for (const [id, content] of contents) {
        if (content.toLowerCase().includes(required)) oracle.add(id)
      }
    }
    // FTS 车道（严格 AND → 宽松 OR）
    let ftsIds = []
    try {
      const strict = sanitizeFtsQuery(query)
      if (strict.length > 0) ftsIds = ftsSql(strict)
      if (ftsIds.length === 0) {
        const relaxed = relaxedFtsQuery(query)
        if (relaxed.length > 0) ftsIds = ftsSql(relaxed)
      }
    } catch { ftsIds = [] }
    // 语义车道
    const semScores = new Map()
    if (qvec !== undefined) {
      for (const [id, vec] of vectors) semScores.set(id, clamp01(cosine(qvec, vec)))
    }
    cases.push({ query, terms, oracle, ftsIds, semScores, isChinese: /[^\x00-\x7f]/.test(query) })
  }
  db.close()

  const oracleEmpty = cases.filter(c => c.oracle.size === 0).length
  const scored = cases.filter(c => c.oracle.size > 0)
  console.log(`oracle 相关行非空的查询 ${String(scored.length)} 条（空 ${String(oracleEmpty)} 条不计入指标）`)

  // 四种配置共用同一双车道，只换融合
  const rankOf = (list, config) => {
    const ftsRank = new Map(config.fts > 0 ? list.ftsIds.map((id, rank) => [id, 1 / (rank + 1)]) : [])
    const ids = new Set([...(config.sem > 0 ? list.semScores.keys() : []), ...ftsRank.keys()])
    const fused = []
    for (const id of ids) {
      const sem = config.sem > 0 ? list.semScores.get(id) : undefined
      const fts = ftsRank.get(id)
      let score = 0
      if (sem !== undefined && fts !== undefined) score = config.sem * sem + config.fts * fts
      else if (sem !== undefined) score = sem * 0.8
      else if (fts !== undefined) score = fts * 0.8
      if (score > 0) fused.push({ id, score })
    }
    fused.sort((left, right) => right.score - left.score || left.id - right.id)
    return fused.map(row => row.id)
  }

  const metricsFor = (subset) => {
    const lines = CONFIGS.map(config => {
      let hit10 = 0
      let mrr = 0
      let recall10 = 0
      for (const c of subset) {
        const ranked = rankOf(c, config).slice(0, 10)
        const first = ranked.findIndex(id => c.oracle.has(id))
        if (first >= 0) {
          hit10 += 1
          mrr += 1 / (first + 1)
        }
        let found = 0
        for (const id of ranked) if (c.oracle.has(id)) found += 1
        recall10 += found / c.oracle.size
      }
      const n = Math.max(1, subset.length)
      return `    ${config.name.padEnd(20)} hit@10 ${((hit10 / n) * 100).toFixed(0).padStart(3)}%   MRR ${(mrr / n).toFixed(3)}   recall@10 ${(recall10 / n).toFixed(3)}`
    })
    return lines
  }

  const zh = scored.filter(c => c.isChinese)
  const en = scored.filter(c => !c.isChinese)
  console.log(`\n== 全部 ${String(scored.length)} 条 ==`)
  for (const line of metricsFor(scored)) console.log(line)
  console.log(`\n== 中文/含 CJK ${String(zh.length)} 条 ==`)
  for (const line of metricsFor(zh)) console.log(line)
  console.log(`\n== 纯拉丁 ${String(en.length)} 条（不回归对照）==`)
  for (const line of metricsFor(en)) console.log(line)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
