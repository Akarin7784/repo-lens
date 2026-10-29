import {
  CachedEmbedder,
  DashscopeEmbedder,
  MeteredEmbedder,
  type EmbeddingKv,
  type TaskBudgetMeter,
  FakeEmbedder,
  OnnxEmbedder,
  type EmbeddingConfig,
  type Embedder,
} from '@repolens/rag';

/** 可注入的构造函数(测试用 spy 断言 OnnxEmbedder 构造次数) */
export interface EmbedderCtors {
  onnx: (emb: EmbeddingConfig) => Embedder;
  dashscope: (
    ds: NonNullable<EmbeddingConfig['dashscope']> & { apiKey: string },
  ) => DashscopeEmbedder;
}

const defaultCtors: EmbedderCtors = {
  onnx: (emb) => new OnnxEmbedder(emb.model, emb.modelDir, undefined, emb.threads, emb.revision),
  dashscope: (ds) => new DashscopeEmbedder(ds),
};

/**
 * dashscope 下缺 key 时的占位:维度取配置(与 api 一致),任何调用都抛错。
 * 向量化由 embeddingSkipReason='no-key' 跳过,正常不会被调用;不退回本地/假向量。
 */
export class UnavailableEmbedder implements Embedder {
  readonly provider = 'dashscope' as const;
  readonly revision = 'unavailable';
  constructor(
    readonly model: string,
    readonly dim: number,
  ) {}
  embedQuery(): Promise<number[]> {
    return Promise.reject(new Error('DASHSCOPE_API_KEY 未配置,embedding 不可用'));
  }
  embedDocuments(): Promise<number[][]> {
    return Promise.reject(new Error('DASHSCOPE_API_KEY 未配置,embedding 不可用'));
  }
}

/**
 * 选 worker 的 embedder。EMBEDDING_PROVIDER=dashscope 时完全不构造 OnnxEmbedder,
 * 因而不读 EMBEDDING_MODEL_DIR(/models);model/dim 只来自 DASHSCOPE_EMBEDDING_* 配置。
 */
export function selectEmbedder(
  emb: EmbeddingConfig,
  ctors: EmbedderCtors = defaultCtors,
): { base: Embedder; dashscope: DashscopeEmbedder | null } {
  const ds = emb.dashscope;
  if (ds) {
    const dashscope = ds.apiKey ? ctors.dashscope({ ...ds, apiKey: ds.apiKey }) : null;
    // 模型名格式与 DashscopeEmbedder 一致(dashscope:<model>)
    return {
      base: dashscope ?? new UnavailableEmbedder(`dashscope:${ds.model}`, ds.dim),
      dashscope,
    };
  }
  return { base: emb.provider === 'onnx' ? ctors.onnx(emb) : new FakeEmbedder(), dashscope: null };
}

/**
 * processAnalyzeJob 里与 embedding 提供方相关的两项依赖。
 * dashscope 缺 key → embeddingSkipReason='no-key'、无 taskEmbedder(向量化整段跳过,向量库不会被使用);
 * 有 key → 每任务一个计量 embedder;local → 两项都 undefined(用共享 embedder)。
 */
export function buildEmbeddingDeps(
  emb: EmbeddingConfig,
  dashscope: DashscopeEmbedder | null,
  kv: EmbeddingKv,
): {
  embeddingSkipReason: 'no-key' | undefined;
  taskEmbedder: ((meter: TaskBudgetMeter) => Embedder) | undefined;
} {
  const ds = emb.dashscope;
  return {
    embeddingSkipReason: ds && !ds.apiKey ? 'no-key' : undefined,
    taskEmbedder:
      ds && dashscope
        ? (meter) => new CachedEmbedder(new MeteredEmbedder(dashscope, meter), kv)
        : undefined,
  };
}
