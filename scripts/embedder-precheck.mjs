/**
 * 多语向量模型预检（embedder pre-check，2026-10-10）。
 *
 * 三个模型同台：MiniLM-L6（基线，复用线上缓存）vs multilingual-e5-small(int8)
 * vs bge-m3(int8)。同后端（vendored ORT WASM）、同池（1338 行全量嵌入）、
 * 同 oracle（retrieval-eval 的必要词子串）、同融合网格——唯一变量是 embedder。
 *
 * 产出：① 质量——各模型在融合网格下的 hit@10/MRR/recall@10（全部/中文），
 *        与 MiniLM 基线同代码对比；判据 = 中文 recall@10 相对改善 ≥15%。
 *      ② 性能——池均每条嵌入毫秒（WASM 后端，与线上一致）。
 * 模型资产下载到 <tmp>/<key>/，不碰线上 models/ 缓存。
 * 用法：node scripts/embedder-precheck.mjs [--skip-minilm]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Tokenizer } from '@huggingface/tokenizers'
import { meanPoolNormalize } from '../src/core/embedding-local.ts'
import { relaxedFtsQuery, sanitizeFtsQuery } from '../src/core/memory-search.ts'
import { loadQueries, requiredTermOf, termsOf } from './retrieval-eval.mjs'

const CORPUS = join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'memories.db')
const LIVE_CACHE = join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'models')
const OUT_ROOT = join(process.cwd(), '<tmp>')
const MAX_SEQ = 512

const MODELS = [
  {
    key: 'minilm', label: 'MiniLM-L6 fp32(基线)', repo: 'Xenova/all-MiniLM-L6-v2',
    modelPath: 'onnx/model.onnx', dims: 384, prefix: null, cacheDir: LIVE_CACHE, predownloaded: true,
  },
  {
    key: 'e5-small', label: 'e5-small int8', repo: 'Xenova/multilingual-e5-small',
    modelPath: 'onnx/model_quantized.onnx', dims: 384, prefix: { query: 'query: ', passage: 'passage: ' },
  },
  {
    key: 'bge-m3', label: 'bge-m3 int8', repo: 'onnx-community/bge-m3-ONNX',
    modelPath: 'onnx/model_quantized.onnx', dims: 1024, prefix: null, pooling: 'cls',
  },
]

async function download(repo, remotePath, dest) {
  if (existsSync(dest)) return
  const host = process.env.HF_HOST ?? 'https://huggingface.co'
  const url = `${host}/${repo}/resolve/main/${remotePath}`
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`${remotePath}: HTTP ${String(res.status)}`)
      const buf = Buffer.from(await res.arrayBuffer())
      writeFileSync(dest, buf)
      console.log(`    下载 ${remotePath} → ${(buf.length / 1048576).toFixed(1)}MB`)
      return
    } catch (error) {
      lastErr = error
      console.log(`    下载失败（第 ${String(attempt)}/3 次）：${String(error).slice(0, 120)}`)
    }
  }
  throw lastErr
}

async function loadRunner(model, ort) {
  const cacheDir = model.cacheDir ?? join(OUT_ROOT, model.key)
  mkdirSync(cacheDir, { recursive: true })
  if (!model.predownloaded) {
    await download(model.repo, 'tokenizer.json', join(cacheDir, 'tokenizer.json'))
    await download(model.repo, 'tokenizer_config.json', join(cacheDir, 'tokenizer_config.json'))
    await download(model.repo, model.modelPath, join(cacheDir, 'model.onnx'))
  }
  const tok = new Tokenizer(
    JSON.parse((await import('node:fs')).readFileSync(join(cacheDir, 'tokenizer.json'), 'utf8')),
    JSON.parse((await import('node:fs')).readFileSync(join(cacheDir, 'tokenizer_config.json'), 'utf8')),
  )
  const session = await ort.InferenceSession.create(join(cacheDir, 'model.onnx'), { executionProviders: ['wasm'] })
  const wantsTypes = session.inputNames.includes('token_type_ids')
  return {
    async embedOne(text) {
      const raw = tok.encode(text, { add_special_tokens: true, return_token_type_ids: true })
      const seq = Math.min(raw.ids.length, MAX_SEQ)
      const ids = BigInt64Array.from(raw.ids.slice(0, seq).map(v => BigInt(v)))
      const mask = BigInt64Array.from(raw.attention_mask.slice(0, seq).map(v => BigInt(v)))
      const inputs = {
        input_ids: new ort.Tensor('int64', ids, [1, seq]),
        attention_mask: new ort.Tensor('int64', mask, [1, seq]),
      }
      if (wantsTypes) {
        const types = BigInt64Array.from((raw.token_type_ids ?? raw.ids.map(() => 0)).slice(0, seq).map(v => BigInt(v)))
        inputs.token_type_ids = new ort.Tensor('int64', types, [1, seq])
      }
      const out = await session.run(inputs)
      const hidden = out.last_hidden_state ?? Object.values(out)[0]
      if (model.pooling === 'cls') {
        // bge-m3 官方 dense 向量 = CLS token（首 token）归一化，不是 mean pool
        const dim = hidden.dims.at(-1)
        const cls = new Float32Array(dim)
        for (let i = 0; i < dim; i += 1) cls[i] = hidden.data[i]
        let norm = 0
        for (let i = 0; i < dim; i += 1) norm += cls[i] * cls[i]
        norm = Math.sqrt(norm) || 1
        for (let i = 0; i < dim; i += 1) cls[i] /= norm
        return cls
      }
      return meanPoolNormalize(hidden.data, seq, hidden.dims.at(-1), raw.attention_mask.slice(0, seq))
    },
  }
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const GRIDS = [
  { name: 'blend 0.7/0.3 (current)', sem: 0.7, fts: 0.3 },
  { name: 'blend 0.5/0.5', sem: 0.5, fts: 0.5 },
  { name: 'blend 0.85/0.15', sem: 0.85, fts: 0.15 },
  { name: 'pure-sem', sem: 1.0, fts: 0.0 },
]

async function main() {
  const skipMinilm = process.argv.includes('--skip-minilm')
  const onlyIdx = process.argv.indexOf('--only')
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null
  const ort = await import(new URL('../vendor/onnx/ort.node.min.mjs', import.meta.url).href)

  const db = new DatabaseSync(CORPUS, { readOnly: true })
  const NOW = Date.now()
  const active = db.prepare("SELECT id, content FROM memories WHERE status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > ?)").all(NOW)
  const poolIds = active.map(row => Number(row.id))
  const contents = new Map(active.map(row => [Number(row.id), String(row.content)]))

  const queries = loadQueries()
  console.log(`预检：池 ${String(poolIds.length)} 行 · 查询 ${String(queries.length)} 条 · 后端 WASM（与线上一致）`)

  // FTS 车道（所有模型共用）
  const ftsSql = (matchValue) => db.prepare(
    "SELECT memories.id AS id FROM memories_fts JOIN memories ON memories.id = memories_fts.rowid"
      + " WHERE memories_fts MATCH ? AND memories.status IN ('active','permanent')"
      + " AND (memories.expires_at IS NULL OR memories.expires_at > ?)"
      + " ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT 50",
  ).all(matchValue, NOW).map(row => Number(row.id))

  const cases = []
  for (const query of queries) {
    const terms = termsOf(query)
    const required = requiredTermOf(terms)
    const oracle = new Set()
    if (required !== null) {
      for (const [id, content] of contents) if (content.toLowerCase().includes(required)) oracle.add(id)
    }
    let ftsIds = []
    try {
      const strict = sanitizeFtsQuery(query)
      if (strict.length > 0) ftsIds = ftsSql(strict)
      if (ftsIds.length === 0) {
        const relaxed = relaxedFtsQuery(query)
        if (relaxed.length > 0) ftsIds = ftsSql(relaxed)
      }
    } catch { ftsIds = [] }
    cases.push({ query, oracle, ftsIds, isChinese: /[^\x00-\x7f]/.test(query) })
  }
  const scored = cases.filter(c => c.oracle.size > 0)
  console.log(`oracle 非空查询 ${String(scored.length)} 条`)
  db.close()

  const results = {}
  for (const model of MODELS) {
    if (model.key === 'minilm' && skipMinilm) continue
    if (only !== null && model.key !== only) continue
    console.log(`\n== ${model.label}（${model.repo}）==`)
    let runner
    try {
      runner = await loadRunner(model, ort)
    } catch (error) {
      console.log(`  加载失败（该档出局）: ${String(error).slice(0, 160)}`)
      results[model.key] = { error: String(error) }
      continue
    }
    // 全池 + 查询嵌入（计时）
    const t0 = Date.now()
    const poolVec = new Map()
    let n = 0
    for (const id of poolIds) {
      const text = model.prefix ? `${model.prefix.passage}${contents.get(id)}` : contents.get(id)
      poolVec.set(id, await runner.embedOne(text))
      n += 1
      if (n % 400 === 0) console.log(`    池嵌入 ${String(n)}/${String(poolIds.length)}（${((Date.now() - t0) / n).toFixed(0)}ms/条）`)
    }
    const qVecs = new Map()
    for (const c of cases) {
      const text = model.prefix ? `${model.prefix.query}${c.query}` : c.query
      qVecs.set(c.query, await runner.embedOne(text))
    }
    const embedMs = (Date.now() - t0) / (poolIds.length + cases.length)

    // 语义分 + 融合网格
    const perCase = scored.map(c => {
      const qv = qVecs.get(c.query)
      const sem = new Map()
      for (const [id, vec] of poolVec) sem.set(id, clamp01(cosine(qv, vec)))
      return { ...c, sem }
    })
    const metrics = (subset) => GRIDS.map(grid => {
      let hit10 = 0; let mrr = 0; let recall10 = 0
      for (const c of subset) {
        const ftsRank = new Map(grid.fts > 0 ? c.ftsIds.map((id, rank) => [id, 1 / (rank + 1)]) : [])
        const ids = new Set([...(grid.sem > 0 ? c.sem.keys() : []), ...ftsRank.keys()])
        const fused = []
        for (const id of ids) {
          const s = grid.sem > 0 ? c.sem.get(id) : undefined
          const f = ftsRank.get(id)
          let score = 0
          if (s !== undefined && f !== undefined) score = grid.sem * s + grid.fts * f
          else if (s !== undefined) score = s * 0.8
          else if (f !== undefined) score = f * 0.8
          if (score > 0) fused.push({ id, score })
        }
        fused.sort((left, right) => right.score - left.score || left.id - right.id)
        const top = fused.slice(0, 10).map(row => row.id)
        const first = top.findIndex(id => c.oracle.has(id))
        if (first >= 0) { hit10 += 1; mrr += 1 / (first + 1) }
        let found = 0
        for (const id of top) if (c.oracle.has(id)) found += 1
        recall10 += found / c.oracle.size
      }
      const denom = Math.max(1, subset.length)
      return { name: grid.name, hit10: hit10 / denom, mrr: mrr / denom, recall10: recall10 / denom }
    })

    const zh = perCase.filter(c => c.isChinese)
    results[model.key] = {
      label: model.label, dims: model.dims, embedMs,
      all: metrics(perCase), zh: metrics(zh), zhN: zh.length,
    }
    console.log(`  嵌入 ${embedMs.toFixed(0)}ms/条（WASM，含池+查询均摊）`)
    for (const scope of ['all', 'zh']) {
      console.log(`  ${scope === 'zh' ? `中文 ${String(results[model.key].zhN)} 条` : `全部 ${String(perCase.length)} 条`}`)
      for (const m of results[model.key][scope]) {
        console.log(`    ${m.name.padEnd(24)} hit@10 ${(m.hit10 * 100).toFixed(0).padStart(3)}%  MRR ${m.mrr.toFixed(3)}  recall@10 ${m.recall10.toFixed(3)}`)
      }
    }
  }

  // 裁决：候选最优配置 vs 基线 current，中文 recall 相对改善
  if (results.minilm !== undefined && results.minilm.error === undefined) {
    const base = results.minilm.zh.find(m => m.name.includes('current'))
    console.log(`\n== 裁决（判据：中文 recall@10 相对基线 ${base.recall10.toFixed(3)} 改善 ≥15%）==`)
    for (const key of ['e5-small', 'bge-m3']) {
      const r = results[key]
      if (r === undefined || r.error !== undefined) { console.log(`  ${key}: 出局（加载失败）`); continue }
      const best = [...r.zh].sort((left, right) => right.recall10 - left.recall10)[0]
      const gain = ((best.recall10 - base.recall10) / base.recall10) * 100
      console.log(`  ${key} 最优配置 ${best.name}：recall ${best.recall10.toFixed(3)}（${gain >= 0 ? '+' : ''}${gain.toFixed(0)}%）· ${r.embedMs.toFixed(0)}ms/条 → ${gain >= 15 ? '✅ 建议立项切换' : '❌ 维持现状'}`)
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
