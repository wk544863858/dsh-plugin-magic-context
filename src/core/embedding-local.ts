import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

/**
 * Local MiniLM embedding provider — the adapter's twin of Magic Context's
 * `memory/embedding-local.ts` (v0.45.0 defaults), running on **onnxruntime-web's
 * WASM backend** instead of the native onnxruntime-node build.
 *
 * Why WASM: the native stack (~287 MB of platform binaries via
 * `@huggingface/transformers`'s hard dependency) made the distributed package
 * prohibitive; the WASM runtime is a vendored 27 MB binary with zero native
 * install steps. Verified 2026-10-09: this path reproduces the native fp32
 * pipeline byte-for-byte at cosine 1.0000000 over a Chinese/English probe set,
 * so vectors stay inside Magic Context's shared space (see the parity gate in
 * memory-lane.ts — verified empirically, never assumed).
 *
 * Why this exists at all: `ctx_search` scores meaning with
 * `cosineSimilarity(query, stored)` (search.ts:722-727). The vectors in the
 * shared `memory_embeddings` table were produced by Magic Context's own local
 * pipeline, and our acceptance probe (2026-10-07) proved a locally-embedded
 * fp32 vector matches a stored one with cosine 1.000000 — the same vector
 * space, byte for byte. Reading that table and embedding queries here
 * therefore needs no server.
 *
 * Discipline borrowed from MC's `embedding-identity.ts`: local vectors are
 * fenced to the runtime stack that produced them. The fold below reproduces
 * MC's identity input exactly (`provider/model/endpoint/apiKeyPresent/
 * runtimeFingerprint`, fp32 omitted as the default) so `embeddingIdentityHash()`
 * names the adapter's own vectors honestly; shared-space parity against a store
 * is checked at runtime by the composition root's `resolveSharedSpace` closure
 * (cosine against a stored vector), never assumed. The fingerprint names THIS
 * stack (wasm), which differs from MC's native fold — that is honest naming,
 * not a compatibility break: reads are gated by the empirical parity check.
 *
 * Everything here is lazy and fail-open: the model assets download on the first
 * `embed()` call, the heavy modules load then too, and any failure resolves to
 * `null`-shaped telemetry results — search degrades to its FTS lane rather
 * than failing the tool call.
 */

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
/** MC default dtype (`DEFAULT_LOCAL_DTYPE`, embedding-local.ts) — must stay
 *  fp32 or the vectors leave MC's space and every stored comparison degrades. */
export const EMBEDDING_DTYPE = 'fp32' as const;
export const EMBEDDING_DIMS = 384;
/** Sentence-transformers' convention for this model (tokenizer_config.json
 *  `model_max_length`); the native pipeline truncated here too. */
export const EMBEDDING_MAX_SEQ = 512;
/** The runtime stack behind every vector we produce — onnxruntime-web's wasm
 *  backend (vendored, see `vendor/onnx/`) plus the official tokenizers binding. */
export const LOCAL_EMBEDDING_RUNTIME_FINGERPRINT =
  'onnxruntime-web@1.31.0-dev.20260914-8d85527a0(wasm);@huggingface/tokenizers@0.2.0';

/** One downloadable model asset, integrity-pinned. */
export interface EmbeddingAssetSpec {
  readonly name: string;
  readonly path: string;
  readonly minBytes: number;
  readonly sha256: string;
}

/** Model assets, resolved once into `cacheDir` and reused forever after.
 *  Both the upstream revision AND the sha256 of every byte are pinned: the
 *  ONNX file is executed by the vendored WASM runtime, so a floating
 *  `resolve/main` is both a silent-quality hazard (weights change → the
 *  vector space drifts) and a supply-chain one (hf-mirror is a third party
 *  serving executable input). Pinned at upstream sha 751bff37182d3f1213fa05d7196b954e230abad9
 *  (2026-10-14, hashes verified against the mirror download); `minBytes`
 *  stays as a cheap size sanity check, the hash is the authority. */
export const EMBEDDING_ASSETS: readonly EmbeddingAssetSpec[] = [
  { name: 'tokenizer.json', path: 'Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer.json', minBytes: 100_000, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
  { name: 'tokenizer_config.json', path: 'Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer_config.json', minBytes: 32, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
  { name: 'model.onnx', path: 'Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model.onnx', minBytes: 10_000_000, sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e' },
];

/** HuggingFace first, the public mirror as fallback — both plain GETs. */
const MIRRORS = ['https://huggingface.co/', 'https://hf-mirror.com/'];

/** MC `computeNormalizedHash` — the same md5 fold the memory rows use (§2.3). */
export function normalizedEmbeddingHash(content: string): string {
  return createHash('md5').update(content.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

/** MC `getEmbeddingProviderIdentity` local branch (embedding-identity.ts:79-88). */
export function embeddingIdentityHash(): string {
  return `embedding-provider:${normalizedEmbeddingHash(JSON.stringify({
    provider: 'local',
    model: EMBEDDING_MODEL,
    endpoint: '',
    apiKeyPresent: false,
    runtimeFingerprint: LOCAL_EMBEDDING_RUNTIME_FINGERPRINT,
  }))}`;
}

/** Cosine similarity over equal-length vectors (MC cosine-similarity.ts). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Mean-pool the model's `last_hidden_state` over the attention mask, then
 * L2-normalize — the exact recipe of transformers.js' `pooling: 'mean',
 * normalize: true`. The fp64 accumulator keeps the summation order-stable; the
 * spike measured cosine 1.0000000 against the native pipeline with it.
 * Exported for tests: this function IS the vector space.
 */
export function meanPoolNormalize(
  hidden: Float32Array,
  seq: number,
  dims: number,
  mask: ArrayLike<number>,
): Float32Array {
  const acc = new Float64Array(dims);
  let maskSum = 0;
  for (let s = 0; s < seq; s++) {
    const m = mask[s] ?? 0;
    maskSum += m;
    for (let h = 0; h < dims; h++) acc[h] = acc[h]! + hidden[s * dims + h]! * m;
  }
  if (maskSum === 0) return new Float32Array(dims);
  let norm = 0;
  for (let h = 0; h < dims; h++) {
    acc[h] = acc[h]! / maskSum;
    norm += acc[h]! * acc[h]!;
  }
  norm = Math.sqrt(norm);
  const out = new Float32Array(dims);
  for (let h = 0; h < dims; h++) out[h] = acc[h]! / norm;
  return out;
}

export interface LocalEmbedder {
  /** The adapter's own identity (names vectors *we* would write). */
  readonly modelId: string;
  readonly dims: number;
  /** Mean-pooled, L2-normalized embeddings — MC's pooling recipe. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface LocalEmbedderOptions {
  /** Where the ONNX model files cache (adapter-owned directory). */
  readonly cacheDir: string;
  readonly logger?: {
    readonly info?: (message: string) => void;
    readonly warn?: (message: string) => void;
  };
  /** Test seam: replaces the transformers pipeline. */
  readonly embedOverride?: (texts: readonly string[]) => Promise<Float32Array[]>;
  /** Test seam: where to import the ORT module from (defaults to the vendored copy). */
  readonly ortUrl?: string;
  /** Test seam: the fetcher for model assets (defaults to global fetch). */
  readonly fetchImpl?: typeof fetch;
  /** Test seam: asset manifest override (defaults to the pinned EMBEDDING_ASSETS). */
  readonly assets?: readonly EmbeddingAssetSpec[];
}

/** The vendored ORT node entry sits beside the built lib at `<pkg>/vendor/onnx/`;
 *  `src/core/*` and `lib/core/*` are both two levels below the package root, so
 *  one relative URL serves the source tree (vitest) and the built tree (DSH). */
function ortVendorUrl(): string {
  return new URL('../../vendor/onnx/ort.node.min.mjs', import.meta.url).href;
}

/** Structural slice of onnxruntime-web we rely on (no type decls for the
 *  deep dist entry; anything else stays untyped by design). */
interface MinimalOrt {
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;
  InferenceSession: {
    create(path: string, options: Record<string, unknown>): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { dims: number[]; data: Float32Array }>>;
    }>;
  };
}

interface EncodingLike {
  ids: number[];
  attention_mask: number[];
  token_type_ids?: number[];
}

interface TokenizerLike {
  encode(text: string, options?: { add_special_tokens?: boolean; return_token_type_ids?: boolean }): EncodingLike;
}

async function ensureAsset(cacheDir: string, asset: EmbeddingAssetSpec, fetchImpl: typeof fetch, logger: LocalEmbedderOptions['logger']): Promise<void> {
  const dest = join(cacheDir, asset.name);
  // Cached files were hash-verified when written by this code path; the size
  // floor keeps the warm path free of any hashing cost.
  if (existsSync(dest) && statSync(dest).size >= asset.minBytes) return;
  mkdirSync(cacheDir, { recursive: true });
  for (const mirror of MIRRORS) {
    try {
      logger?.info?.(`magic-context embedding assets: fetching ${asset.name} from ${mirror}`);
      const res = await fetchImpl(mirror + asset.path, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const tmp = `${dest}.part`;
      await streamPipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
      if (statSync(tmp).size < asset.minBytes) throw new Error(`suspiciously small (${statSync(tmp).size} bytes)`);
      const digest = createHash('sha256').update(readFileSync(tmp)).digest('hex');
      if (digest !== asset.sha256) throw new Error(`sha256 mismatch (got ${digest.slice(0, 16)}…, want ${asset.sha256.slice(0, 16)}…)`);
      renameSync(tmp, dest);
      logger?.info?.(`magic-context embedding assets: ${asset.name} cached (${statSync(dest).size} bytes)`);
      return;
    } catch (error) {
      logger?.warn?.(`magic-context embedding assets: ${asset.name} from ${mirror} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`all mirrors failed for ${asset.name}`);
}

/**
 * Open the lazy local embedder. `embed()` fetches the model assets (first use),
 * loads the vendored onnxruntime-web WASM backend and the official tokenizers
 * binding once, then reuses both. Every failure mode resolves to `[]`-shaped
 * results — telemetry and recall quality, never correctness.
 */
export function openLocalEmbedder(options: LocalEmbedderOptions): LocalEmbedder {
  const logger = options.logger;
  /** What the WASM session yields per text: a callable over a batch of one. */
  type Runner = (texts: readonly string[]) => Promise<Float32Array[]>;
  let runnerPromise: Promise<Runner> | null = null;

  const load = async (): Promise<Runner> => {
    if (runnerPromise === null) {
      runnerPromise = (async () => {
        // The vendored ORT loads first: a broken runtime fails fast and cheap,
        // before any model asset traffic is even considered.
        const ort = await import(/* webpackIgnore: true */ options.ortUrl ?? ortVendorUrl()) as unknown as MinimalOrt;
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        for (const asset of options.assets ?? EMBEDDING_ASSETS) await ensureAsset(options.cacheDir, asset, fetchImpl, logger);
        const { Tokenizer } = await import('@huggingface/tokenizers');
        const tok = new Tokenizer(
          JSON.parse(readFileSync(join(options.cacheDir, 'tokenizer.json'), 'utf8')) as object,
          JSON.parse(readFileSync(join(options.cacheDir, 'tokenizer_config.json'), 'utf8')) as object,
        ) as unknown as TokenizerLike;
        const session = await ort.InferenceSession.create(join(options.cacheDir, 'model.onnx'), {
          executionProviders: ['wasm'],
        });
        logger?.info?.(`magic-context local embedder ready (${EMBEDDING_MODEL} ${EMBEDDING_DTYPE}, wasm backend)`);
        return async (texts: readonly string[]): Promise<Float32Array[]> => {
          const vectors: Float32Array[] = [];
          for (const text of texts) {
            const raw = tok.encode(text, { add_special_tokens: true, return_token_type_ids: true });
            const seq = Math.min(raw.ids.length, EMBEDDING_MAX_SEQ);
            const ids = BigInt64Array.from(raw.ids.slice(0, seq).map((v) => BigInt(v)));
            const mask = BigInt64Array.from(raw.attention_mask.slice(0, seq).map((v) => BigInt(v)));
            const types = BigInt64Array.from((raw.token_type_ids ?? raw.ids.map(() => 0)).slice(0, seq).map((v) => BigInt(v)));
            const out = await session.run({
              input_ids: new ort.Tensor('int64', ids, [1, seq]),
              attention_mask: new ort.Tensor('int64', mask, [1, seq]),
              token_type_ids: new ort.Tensor('int64', types, [1, seq]),
            });
            const hidden = out.last_hidden_state ?? Object.values(out)[0]!;
            const modelDims = hidden.dims.at(-1) ?? EMBEDDING_DIMS;
            if (modelDims !== EMBEDDING_DIMS) {
              logger?.warn?.(`magic-context embedder returned unexpected dims ${hidden.dims.join(',')}`);
            }
            const maskNums = raw.attention_mask.slice(0, seq);
            vectors.push(meanPoolNormalize(hidden.data, seq, modelDims, maskNums));
          }
          return vectors;
        };
      })().catch((error: unknown) => {
        runnerPromise = null; // allow a later retry
        throw error;
      });
    }
    return runnerPromise;
  };

  return {
    modelId: embeddingIdentityHash(),
    dims: EMBEDDING_DIMS,
    async embed(texts) {
      if (texts.length === 0) return [];
      if (options.embedOverride !== undefined) return options.embedOverride(texts);
      try {
        const run = await load();
        return await run(texts);
      } catch (error) {
        logger?.warn?.(
          `magic-context local embedder unavailable (search degrades to FTS): `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    },
  };
}

/** Default model cache directory, derived from the adapter's own data dir
 *  (the directory holding the adapter's SQLite store). */
export function defaultEmbeddingCacheDir(adapterDbPath: string): string {
  return join(dirname(adapterDbPath), 'models');
}
