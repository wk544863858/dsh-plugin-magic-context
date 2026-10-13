/**
 * The WASM embedding lane (0.3.0): the vendored onnxruntime-web node entry
 * plus the official tokenizers binding replaced the native
 * `@huggingface/transformers` + `onnxruntime-node` stack (~287 MB of platform
 * binaries). Spike record 2026-10-09: cosine(wasm, native fp32) = 1.0000000
 * over a 6-text Chinese/English probe, so MC's shared vector space survives
 * the backend swap. These specs pin the pure pooling math and the wiring's
 * fail-open contract hermetically — no model, no network.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMBEDDING_ASSETS,
  cosineSimilarity,
  meanPoolNormalize,
  openLocalEmbedder,
} from '../src/core/embedding-local.ts'

describe('meanPoolNormalize is the vector space (pin the recipe)', () => {
  it('averages masked positions then L2-normalizes', () => {
    // hidden: [1, 2, seq=2, dims=2] — position 0 = [3, 6] (mask 1), position 1 = [100, 200] (mask 0)
    const hidden = new Float32Array([3, 6, 100, 200])
    const vec = meanPoolNormalize(hidden, 2, 2, [1, 0])
    // mean over unmasked = [3, 6]; norm = sqrt(45); normalized = [1/sqrt5, 2/sqrt5]
    const inv = 1 / Math.sqrt(5)
    expect(vec[0]).toBeCloseTo(inv, 6)
    expect(vec[1]).toBeCloseTo(2 * inv, 6)
  })

  it('an all-zero mask yields the zero vector instead of NaN', () => {
    const vec = meanPoolNormalize(new Float32Array([1, 2, 3, 4]), 2, 2, [0, 0])
    expect(vec.every((v) => v === 0)).toBe(true)
  })

  it('stays parallel to cosineSimilarity: identical vectors score 1', () => {
    const hidden = new Float32Array([1, 2, 3, 4, 5, 6])
    const a = meanPoolNormalize(hidden, 3, 2, [1, 1, 0])
    const b = meanPoolNormalize(hidden, 3, 2, [1, 1, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
  })
})

interface FakeOrtTensor {
  dims: number[]
  data: Float32Array
}

/**
 * A data:-URL module that stands in for the vendored ORT entry: the session
 * returns a deterministic `last_hidden_state` so the whole wiring (dynamic
 * import, tokenizer, tensors, pooling) is exercised without the 27 MB binary.
 */
function fakeOrtModuleUrl(): string {
  const code = `
    export const Tensor = class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims } }
    export const InferenceSession = {
      async create(_path, _opts) {
        return {
          async run(feeds) {
            const seq = Number(feeds.input_ids.dims.at(-1))
            const dims = 384 // match EMBEDDING_DIMS — the dims-mismatch guard must stay quiet
            const data = new Float32Array(seq * dims)
            for (let s = 0; s < seq; s++) for (let h = 0; h < dims; h++) data[s * dims + h] = (s + 1) * (h % 7 + 2)
            return { last_hidden_state: { dims: [1, seq, dims], data } }
          },
        }
      },
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

/** Legal-sized dummy bodies for the three assets (floors from EMBEDDING_ASSETS).
 *  tokenizer.json must survive the REAL binding's constructor: a minimal but
 *  valid WordPiece vocab, whitespace-padded past the size floor (JSON.parse
 *  tolerates trailing whitespace). */
function fakeAssetBodies(): Map<string, string> {
  const miniTokenizer = JSON.stringify({
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [],
    normalizer: null,
    pre_tokenizer: { type: 'Whitespace' },
    post_processor: null,
    decoder: null,
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab: { '[UNK]': 0, 'hello': 1, 'memory': 2, '[CLS]': 3, '[SEP]': 4 },
    },
  })
  const pad = (body: string, floor: number) => body + ' '.repeat(Math.max(0, floor - body.length + 1))
  return new Map(EMBEDDING_ASSETS.map((asset) => {
    const body = asset.name === 'tokenizer.json' ? pad(miniTokenizer, asset.minBytes)
      : asset.name === 'tokenizer_config.json' ? pad('{}', asset.minBytes)
      : 'x'.repeat(asset.minBytes + 1)
    return [asset.name, body]
  }))
}

function fakeFetch(bodies: Map<string, string>, failures = new Set<string>()): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    const asset = EMBEDDING_ASSETS.find((a) => path.endsWith(a.name))
    if (!asset || failures.has(path)) return new Response('boom', { status: 500 })
    return new Response(bodies.get(asset.name)!, { status: 200 })
  }) as unknown as typeof fetch
}

describe('the WASM wiring is lazy, real, and fail-open', () => {
  it('embeds through a fake session end-to-end (import → assets → tokenize → run → pool)', async () => {
    const cacheDir = join(tmpdir(), 'embedding-wasm-spec')
    const warns: string[] = []
    const embedder = openLocalEmbedder({
      cacheDir,
      ortUrl: fakeOrtModuleUrl(),
      fetchImpl: fakeFetch(fakeAssetBodies()),
      logger: { warn: (m) => warns.push(m) },
    })
    const vectors = await embedder.embed(['hello memory'])
    expect(vectors.length).toBe(1)
    expect(vectors[0]!.length).toBe(384)
    let norm = 0
    for (const v of vectors[0]!) norm += v * v
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5) // L2-normalized
    expect(warns).toEqual([])
    expect(existsSync(join(cacheDir, 'model.onnx'))).toBe(true)
    // second call reuses the loaded runner (no re-import blowup)
    expect((await embedder.embed(['again'])).length).toBe(1)
  })

  it('正例: the huggingface.co mirror fallback engages on a 500', async () => {
    const cacheDir = join(tmpdir(), 'embedding-wasm-spec-mirror')
    const bodies = fakeAssetBodies()
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url)
      if (path.startsWith('https://huggingface.co/')) return new Response('down', { status: 500 })
      const asset = EMBEDDING_ASSETS.find((a) => path.endsWith(a.name))!
      return new Response(bodies.get(asset.name)!, { status: 200 })
    }) as unknown as typeof fetch
    const embedder = openLocalEmbedder({
      cacheDir,
      ortUrl: fakeOrtModuleUrl(),
      fetchImpl,
    })
    await expect(embedder.embed(['mirror me'])).resolves.toHaveLength(1)
    expect(existsSync(join(cacheDir, 'tokenizer.json'))).toBe(true)
  })

  it('反例: a broken ORT import degrades to [] with a readable warn, never throws', async () => {
    const warns: string[] = []
    const embedder = openLocalEmbedder({
      cacheDir: tmpdir(),
      ortUrl: 'data:text/javascript,throw new Error("no wasm runtime here")',
      logger: { warn: (m) => warns.push(m) },
    })
    await expect(embedder.embed(['text'])).resolves.toEqual([])
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain('search degrades to FTS')
    expect(warns[0]).toContain('no wasm runtime here')
    // the failed load resets the memo — a later healthy retry is possible
    await expect(embedder.embed(['retry'])).resolves.toEqual([])
  })

  it('反例: empty input short-circuits before any loading', async () => {
    const embedder = openLocalEmbedder({
      cacheDir: tmpdir(),
      ortUrl: 'data:text/javascript,throw new Error("must not be reached")',
    })
    await expect(embedder.embed([])).resolves.toEqual([])
  })

  it('the test seam (embedOverride) still wins over everything', async () => {
    const override = vi.fn(async (texts: readonly string[]) => texts.map(() => new Float32Array(4).fill(1)))
    const embedder = openLocalEmbedder({ cacheDir: process.env.TEMP!, embedOverride: override })
    await expect(embedder.embed(['a', 'b'])).resolves.toHaveLength(2)
    expect(override).calledOnce
  })
})
