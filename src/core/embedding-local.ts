import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Local MiniLM embedding provider — the adapter's twin of Magic Context's
 * `memory/embedding-local.ts` (v0.45.0 defaults).
 *
 * Why this exists: `ctx_search` scores meaning with `cosineSimilarity(query,
 * stored)` (search.ts:722-727). The vectors in the shared `memory_embeddings`
 * table were produced by Magic Context's own local pipeline, and our acceptance
 * probe (2026-10-07) proved a locally-embedded fp32 vector matches a stored one
 * with cosine 1.000000 — the same vector space, byte for byte. Reading that
 * table and embedding queries here therefore needs no server.
 *
 * Discipline borrowed from MC's `embedding-identity.ts`: local vectors are
 * fenced to the runtime stack that produced them. The fold below reproduces
 * MC's identity input exactly (`provider/model/endpoint/apiKeyPresent/
 * runtimeFingerprint`, fp32 omitted as the default) so `embeddingIdentityHash()`
 * names the adapter's own vectors honestly; shared-space parity against a store
 * is checked at runtime by `verifyEmbeddingParity` (cosine against a stored
 * vector), never assumed.
 *
 * Everything here is lazy and fail-open: the heavy modules load on the first
 * `embed()` call, and any failure resolves to `null` telemetry-shaped results —
 * search degrades to its FTS lane rather than failing the tool call.
 */

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
/** MC default dtype (`DEFAULT_LOCAL_DTYPE`, embedding-local.ts) — must stay
 *  fp32 or the vectors leave MC's space and every stored comparison degrades. */
export const EMBEDDING_DTYPE = 'fp32' as const;
export const EMBEDDING_DIMS = 384;
/** MC `LOCAL_EMBEDDING_RUNTIME_FINGERPRINT` (embedding-identity.ts:12-14). */
export const LOCAL_EMBEDDING_RUNTIME_FINGERPRINT =
  'transformers@4.3.0;onnxruntime-node@1.30.0;onnxruntime-web@1.26.0-dev.20260416-b7804b056c';

/** MC `computeNormalizedHash` — the same md5 fold the memory rows use (§2.3). */
export function normalizedEmbeddingHash(content: string): string {
  return createHash('md5').update(content.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

/** MC `getEmbeddingProviderIdentity` local branch (embedding-identity.ts:79-88).
 *  Verified empirically against the reference store: this fold yields
 *  `embedding-provider:ac1a4f8f0674f430a6c85a0e1a43a86a`. */
export function embeddingIdentityHash(): string {
  return `embedding-provider:${normalizedEmbeddingHash(JSON.stringify({
    provider: 'local',
    model: EMBEDDING_MODEL,
    endpoint: '',
    apiKeyPresent: false,
    runtimeFingerprint: LOCAL_EMBEDDING_RUNTIME_FINGERPRINT,
  }))}`;
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
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Open the lazy local embedder. `embed()` loads `@huggingface/transformers`
 * (native onnxruntime backend, proven loadable inside the DSH host) once, then
 * reuses the pipeline. Every failure mode resolves to `[]`/null-shaped results
 * — telemetry and recall quality, never correctness.
 */
export function openLocalEmbedder(options: LocalEmbedderOptions): LocalEmbedder {
  const logger = options.logger;
  let pipelinePromise: Promise<{
    extract(texts: readonly string[], opts: Record<string, unknown>): Promise<{ data: Float32Array; dims: number[] }>
  }> | null = null;

  const load = async (): Promise<NonNullable<typeof pipelinePromise>> => {
    if (pipelinePromise === null) {
      pipelinePromise = (async () => {
        const transformers = await import('@huggingface/transformers');
        const env = transformers.env as unknown as Record<string, unknown>;
        // MC `configureTransformersRemoteHost`: the host string MUST carry a
        // trailing slash or transformers builds `https://hostmodels/...`.
        env.remoteHost = 'https://huggingface.co/';
        env.allowLocalModels = false;
        env.cacheDir = options.cacheDir;
        const extract = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL, {
          dtype: EMBEDDING_DTYPE,
        });
        logger?.info?.(`magic-context local embedder ready (${EMBEDDING_MODEL} ${EMBEDDING_DTYPE})`);
        return extract as unknown as NonNullable<typeof pipelinePromise>;
      })().catch((error: unknown) => {
        pipelinePromise = null; // allow a later retry
        throw error;
      });
    }
    return pipelinePromise;
  };

  return {
    modelId: embeddingIdentityHash(),
    dims: EMBEDDING_DIMS,
    async embed(texts) {
      if (texts.length === 0) return [];
      if (options.embedOverride !== undefined) return options.embedOverride(texts);
      try {
        const extract = await load();
        const out = await extract(texts as string[], { pooling: 'mean', normalize: true });
        const dims = out.dims.at(-1) ?? EMBEDDING_DIMS;
        const stride = out.data.length / texts.length;
        if (stride !== Math.floor(stride) || dims !== stride) {
          logger?.warn?.(`magic-context embedder returned unexpected shape dims=${out.dims.join(',')}`);
        }
        const vectors: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
          vectors.push(out.data.slice(i * stride, (i + 1) * stride));
        }
        return vectors;
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
