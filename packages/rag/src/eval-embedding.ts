import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIM, readEmbeddingConfig } from './config.js';
import type { DashscopeConfig } from './config.js';
import type { Embedder } from './embedder.js';
import { estimateTokens } from './dashscope.js';

/** 评测脚本(scripts/rag-eval.mjs)的 embedding 选择结果;开始行打印前四项,不含密钥 */
export interface EvalEmbeddingChoice {
  provider: 'local' | 'dashscope';
  model: string;
  /** 请求的向量维度(dashscope 为 DASHSCOPE_EMBEDDING_DIM 或模型默认;local 固定 384) */
  dim: number;
  /** 评测用集合名:eval_<provider>_<model>_<请求维度>(model 中非 [A-Za-z0-9_-] 字符替换为 _) */
  collection: string;
  /** 仅 dashscope:配置(含 apiKey,只来自 DASHSCOPE_API_KEY),调用方不得打印 */
  dashscope: (DashscopeConfig & { apiKey: string }) | null;
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
export const evalCollectionName = (provider: string, model: string, dim: number) =>
  `eval_${provider}_${sanitize(model)}_${dim}`;

/**
 * 按环境变量选择评测 embedding。只读 EMBEDDING_PROVIDER(local|dashscope,缺省 local)
 * 与 DASHSCOPE_*;local 时模型固定为 multilingual-e5-small(与改动前一致,不读 EMBEDDING_MODEL)。
 * dashscope 时 key 只取 DASHSCOPE_API_KEY,缺失直接报错(只报变量名)。默认模型不变(text-embedding-v3)。
 */
export function selectEvalEmbedding(env: NodeJS.ProcessEnv = process.env): EvalEmbeddingChoice {
  const pick = (k: string) => (env[k] === undefined ? {} : { [k]: env[k] });
  const cfg = readEmbeddingConfig({
    ...pick('EMBEDDING_PROVIDER'),
    ...pick('DASHSCOPE_API_KEY'),
    ...pick('DASHSCOPE_EMBEDDING_BASE_URL'),
    ...pick('DASHSCOPE_EMBEDDING_MODEL'),
    ...pick('DASHSCOPE_EMBEDDING_DIM'),
    ...pick('DASHSCOPE_EMBEDDING_TPM'),
    ...pick('EMBEDDING_BATCH_SIZE'),
  });
  const ds = cfg.dashscope;
  if (!ds) {
    return {
      provider: 'local',
      model: DEFAULT_EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      collection: evalCollectionName('local', DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIM),
      dashscope: null,
    };
  }
  if (!ds.apiKey?.trim())
    throw new Error('EMBEDDING_PROVIDER=dashscope 需要环境变量 DASHSCOPE_API_KEY');
  return {
    provider: 'dashscope',
    model: ds.model,
    dim: ds.dim,
    collection: evalCollectionName('dashscope', ds.model, ds.dim),
    dashscope: { ...ds, apiKey: ds.apiKey.trim() },
  };
}

/** 开始行(不含密钥):EVAL embedding provider=… model=… dim=… collection=… */
export const evalEmbeddingLine = (c: EvalEmbeddingChoice) =>
  `EVAL embedding provider=${c.provider} model=${c.model} dim=${c.dim} collection=${c.collection}`;

/** 向量缓存文件:local 保持原路径(行为不变);dashscope 按集合名分文件 */
export function evalVectorCacheFile(c: EvalEmbeddingChoice, holdoutName: string | null): string {
  if (c.provider === 'local')
    return holdoutName ? `/tmp/rl-eval-vectors-${holdoutName}.json` : '/tmp/rl-eval-vectors.json';
  return `/tmp/rl-eval-vectors-${holdoutName ? `${holdoutName}-` : ''}${c.collection}.json`;
}

/** 构造评测 embedder;工厂由调用方注入(测试用假 embedder,CI 不调用真实 DashScope) */
export function makeEvalEmbedder(
  c: EvalEmbeddingChoice,
  factories: {
    local: () => Embedder;
    dashscope: (cfg: DashscopeConfig & { apiKey: string }) => Embedder;
  },
): Embedder {
  const e = c.dashscope ? factories.dashscope(c.dashscope) : factories.local();
  if (e.dim !== c.dim) throw new Error(`embedder 维度 ${e.dim} != 请求维度 ${c.dim}`);
  return e;
}

/**
 * 评测索引阶段的 embedding 用量。measuredTokens 只累计响应 usage.total_tokens;
 * 响应没给 usage 的批次按 estimateTokens 估算,单独记在 estimatedTokens,不混进实测数。
 */
export interface EvalIndexUsage {
  batches: number;
  measuredTokens: number;
  estimatedBatches: number;
  estimatedTokens: number;
}

type WithUsage = Embedder & {
  embedDocumentsWithUsage?: (
    texts: string[],
  ) => Promise<{ vectors: number[][]; usageTokens?: number }>;
};

/**
 * 包一层只用于索引的 embedder,统计 embedDocuments 的用量;不改向量、不改字段
 * (provider/model/revision/dim 原样透传,digest 仍按原 embedder 计算)。
 * 底层没有 embedDocumentsWithUsage(如 local)时只计批次,不计 token。
 */
export function trackEvalIndexUsage(inner: Embedder): {
  embedder: Embedder;
  usage: EvalIndexUsage;
} {
  const usage: EvalIndexUsage = {
    batches: 0,
    measuredTokens: 0,
    estimatedBatches: 0,
    estimatedTokens: 0,
  };
  const src = inner as WithUsage;
  const embedder: Embedder = {
    ...(inner.provider === undefined ? {} : { provider: inner.provider }),
    model: inner.model,
    ...(inner.revision === undefined ? {} : { revision: inner.revision }),
    dim: inner.dim,
    embedQuery: (t) => inner.embedQuery(t),
    embedDocuments: async (texts) => {
      if (!src.embedDocumentsWithUsage) return inner.embedDocuments(texts);
      const r = await src.embedDocumentsWithUsage(texts);
      usage.batches++;
      if (r.usageTokens !== undefined) usage.measuredTokens += r.usageTokens;
      else {
        usage.estimatedBatches++;
        usage.estimatedTokens += texts.reduce((s, t) => s + estimateTokens(t), 0);
      }
      return r.vectors;
    },
  };
  return { embedder, usage };
}

/**
 * 用量行(不含密钥):
 * - 复用向量缓存:`EVAL embedding usage reused=1 totalTokens=未测`(不写 0)
 * - local:`EVAL embedding usage reused=0 totalTokens=不适用(local)`
 * - dashscope:`EVAL embedding usage reused=0 totalTokens=<实测累计> batches=N`;
 *   有批次没给 usage 时追加 `estimatedTokens=<估算>(估算,未计入totalTokens) estimatedBatches=k`
 */
export function evalUsageLine(c: EvalEmbeddingChoice, u: EvalIndexUsage | null): string {
  const head = 'EVAL embedding usage';
  if (!u) return `${head} reused=1 totalTokens=未测`;
  if (c.provider === 'local') return `${head} reused=0 totalTokens=不适用(local)`;
  const est =
    u.estimatedBatches > 0
      ? ` estimatedTokens=${u.estimatedTokens}(估算,未计入totalTokens) estimatedBatches=${u.estimatedBatches}`
      : '';
  return `${head} reused=0 totalTokens=${u.measuredTokens} batches=${u.batches}${est}`;
}

/**
 * 评测里传给 hybridSearch 的「索引来源」。评测的索引与查询总是同一个 embedder,
 * 所以如实写出 provider/model/dim:dashscope 时不传会被 hybridSearch 当作 local
 * 而判 provider-mismatch,全部题降级 keyword-only。local 不传(与改动前完全一致)。
 */
export function evalIndexedSource(c: EvalEmbeddingChoice): {
  indexedProvider?: 'dashscope';
  indexedModel?: string;
  indexedDim?: number;
} {
  if (c.provider === 'local') return {};
  return { indexedProvider: 'dashscope', indexedModel: c.model, indexedDim: c.dim };
}
