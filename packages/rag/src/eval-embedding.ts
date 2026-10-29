import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIM, readEmbeddingConfig } from './config.js';
import type { DashscopeConfig } from './config.js';
import type { Embedder } from './embedder.js';

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
