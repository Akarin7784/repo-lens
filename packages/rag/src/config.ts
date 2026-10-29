import { z } from 'zod';
import { DEFAULT_EMBED_LOCK_MAX_WAIT_SEC, DEFAULT_EMBED_LOCK_TTL_SEC } from './lock.js';

/** D4:本地 multilingual-e5-small(fp32),384 维 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export const EMBEDDING_DIM = 384;
/** 与 apps/worker/Dockerfile 的 EMBEDDING_MODEL_REVISION 一致(镜像构建下载的权重版本) */
export const DEFAULT_EMBEDDING_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';

/** T-214c:外部提供方阿里云百炼(OpenAI 兼容 /embeddings) */
export const DASHSCOPE_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DASHSCOPE_DEFAULT_MODEL = 'text-embedding-v3';
export const DASHSCOPE_DEFAULT_DIM = 1024;
/** 官方 v3 单次最多 10 条(2026-10-29 实测 11 条返回 400) */
export const DASHSCOPE_MAX_BATCH = 10;
/**
 * 单任务 embedding 预算(美分)。依据:2991 块 × ≤4000 字符上限约 4M token ≈ 2 元 ≈ 30 美分
 * (0.0005 元/千 token,汇率 6.67);MAX_FILES=5000 的仓库按比例约 50 美分,取 50 留余量。
 * 与摘要的 LLM_TASK_BUDGET_CENTS 独立计数。
 */
export const DEFAULT_EMBEDDING_TASK_BUDGET_CENTS = 50;

const empty = (v: unknown) => (v === '' ? undefined : v);
const Schema = z.object({
  EMBEDDER: z.preprocess(empty, z.enum(['fake', 'onnx']).default('fake')),
  EMBEDDING_MODEL: z.preprocess(empty, z.string().default(DEFAULT_EMBEDDING_MODEL)),
  EMBEDDING_MODEL_REVISION: z.preprocess(
    empty,
    z.string().default(DEFAULT_EMBEDDING_MODEL_REVISION),
  ),
  EMBEDDING_MODEL_DIR: z.preprocess(empty, z.string().default('/app/models')),
  EMBEDDING_BATCH_SIZE: z.preprocess(empty, z.coerce.number().int().min(1).max(256).default(16)),
  EMBEDDING_THREADS: z.preprocess(empty, z.coerce.number().int().min(1).max(64).optional()),
  WORKER_CPUS: z.preprocess(empty, z.coerce.number().positive().optional()),
  EMBEDDING_LOCK_TTL_SEC: z.preprocess(
    empty,
    z.coerce.number().int().min(60).default(DEFAULT_EMBED_LOCK_TTL_SEC),
  ),
  EMBEDDING_LOCK_MAX_WAIT_SEC: z.preprocess(
    empty,
    z.coerce.number().int().min(1).default(DEFAULT_EMBED_LOCK_MAX_WAIT_SEC),
  ),
  EMBEDDING_PROVIDER: z.preprocess(empty, z.enum(['local', 'dashscope']).default('local')),
  DASHSCOPE_API_KEY: z.preprocess(empty, z.string().optional()),
  DASHSCOPE_EMBEDDING_BASE_URL: z.preprocess(
    empty,
    z.string().url().default(DASHSCOPE_DEFAULT_BASE_URL),
  ),
  DASHSCOPE_EMBEDDING_MODEL: z.preprocess(empty, z.string().default(DASHSCOPE_DEFAULT_MODEL)),
  DASHSCOPE_EMBEDDING_DIM: z.preprocess(
    empty,
    z.coerce
      .number()
      .int()
      .refine((d) => [1024, 768, 512, 256, 128, 64].includes(d))
      .default(DASHSCOPE_DEFAULT_DIM),
  ),
  DASHSCOPE_EMBEDDING_TPM: z.preprocess(
    empty,
    z.coerce.number().int().min(1000).default(1_000_000),
  ),
  EMBEDDING_TASK_BUDGET_CENTS: z.preprocess(
    empty,
    z.coerce.number().int().min(0).default(DEFAULT_EMBEDDING_TASK_BUDGET_CENTS),
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
  /** 模型权重 revision;进 embedding digest,换 revision 即重建向量 */
  revision: string;
  modelDir: string;
  batchSize: number;
  /** 同 commit 向量化锁 TTL(秒),见 lock.ts 默认值理由 */
  lockTtlSec: number;
  /** 等待同 commit 另一任务的最长秒数;缺省 DEFAULT_EMBED_LOCK_MAX_WAIT_SEC(3600) */
  lockMaxWaitSec: number;
  /**
   * ONNX 推理线程数(intraOp)。显式 EMBEDDING_THREADS 优先;否则按容器 CPU 配额
   * WORKER_CPUS 向下取整(至少 1),避免默认按宿主机核数开线程、超配额被限流;都没有时 undefined(用 ORT 默认)
   */
  threads?: number;
  qdrant: { url: string; apiKey?: string; collection: string } | null;
  /** T-214c:外部提供方配置;EMBEDDING_PROVIDER=local(默认)时为 null,上面字段保持原样 */
  dashscope: DashscopeConfig | null;
}

export interface DashscopeConfig {
  /** 未配置 key 时为 undefined,由 worker 记 skipped 并告警(不在此抛错) */
  apiKey?: string;
  baseUrl: string;
  model: string;
  dim: number;
  /** min(EMBEDDING_BATCH_SIZE, 10) */
  batchSize: number;
  /** 进程内令牌桶的每分钟 token 上限(官方北京 v3 TPM 1.2M,默认留 ~17% 余量) */
  tpm: number;
  /** 单任务 embedding 预算(美分),0 表示禁止外部 embedding */
  taskBudgetCents: number;
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
    revision: e.EMBEDDER === 'fake' ? 'fake' : e.EMBEDDING_MODEL_REVISION,
    modelDir: e.EMBEDDING_MODEL_DIR,
    batchSize: e.EMBEDDING_BATCH_SIZE,
    lockTtlSec: e.EMBEDDING_LOCK_TTL_SEC,
    lockMaxWaitSec: e.EMBEDDING_LOCK_MAX_WAIT_SEC,
    threads:
      e.EMBEDDING_THREADS ??
      (e.WORKER_CPUS !== undefined ? Math.max(1, Math.floor(e.WORKER_CPUS)) : undefined),
    qdrant: e.QDRANT_URL
      ? { url: e.QDRANT_URL, apiKey: e.QDRANT_API_KEY, collection: e.QDRANT_COLLECTION }
      : null,
    dashscope:
      e.EMBEDDING_PROVIDER === 'dashscope'
        ? {
            apiKey: e.DASHSCOPE_API_KEY,
            baseUrl: e.DASHSCOPE_EMBEDDING_BASE_URL,
            model: e.DASHSCOPE_EMBEDDING_MODEL,
            dim: e.DASHSCOPE_EMBEDDING_DIM,
            batchSize: Math.min(e.EMBEDDING_BATCH_SIZE, DASHSCOPE_MAX_BATCH),
            tpm: e.DASHSCOPE_EMBEDDING_TPM,
            taskBudgetCents: e.EMBEDDING_TASK_BUDGET_CENTS,
          }
        : null,
  };
}
