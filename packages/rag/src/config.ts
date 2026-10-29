import { z } from 'zod';
import { DEFAULT_EMBED_LOCK_TTL_SEC } from './lock.js';

/** D4:本地 multilingual-e5-small(fp32),384 维 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export const EMBEDDING_DIM = 384;

const empty = (v: unknown) => (v === '' ? undefined : v);
const Schema = z.object({
  EMBEDDER: z.preprocess(empty, z.enum(['fake', 'onnx']).default('fake')),
  EMBEDDING_MODEL: z.preprocess(empty, z.string().default(DEFAULT_EMBEDDING_MODEL)),
  EMBEDDING_MODEL_DIR: z.preprocess(empty, z.string().default('/app/models')),
  EMBEDDING_BATCH_SIZE: z.preprocess(empty, z.coerce.number().int().min(1).max(256).default(16)),
  EMBEDDING_LOCK_TTL_SEC: z.preprocess(
    empty,
    z.coerce.number().int().min(60).default(DEFAULT_EMBED_LOCK_TTL_SEC),
  ),
  QDRANT_URL: z.preprocess(empty, z.string().url().optional()),
  QDRANT_API_KEY: z.preprocess(empty, z.string().optional()),
  QDRANT_COLLECTION: z.preprocess(
    empty,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('code_chunks'),
  ),
});

export interface EmbeddingConfig {
  provider: 'fake' | 'onnx';
  model: string;
  modelDir: string;
  batchSize: number;
  /** 同 commit 向量化锁 TTL(秒),见 lock.ts 默认值理由 */
  lockTtlSec: number;
  qdrant: { url: string; apiKey?: string; collection: string } | null;
}

/** 读 embedding 与向量库配置;非法时抛错(只报变量名,不回显值) */
export function readEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const r = Schema.safeParse(env);
  if (!r.success)
    throw new Error(`embedding 配置非法:${r.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const e = r.data;
  return {
    provider: e.EMBEDDER,
    // fake 下模型名只用于缓存 key,与真实模型区分
    model: e.EMBEDDER === 'fake' ? 'fake-384' : e.EMBEDDING_MODEL,
    modelDir: e.EMBEDDING_MODEL_DIR,
    batchSize: e.EMBEDDING_BATCH_SIZE,
    lockTtlSec: e.EMBEDDING_LOCK_TTL_SEC,
    qdrant: e.QDRANT_URL
      ? { url: e.QDRANT_URL, apiKey: e.QDRANT_API_KEY, collection: e.QDRANT_COLLECTION }
      : null,
  };
}
