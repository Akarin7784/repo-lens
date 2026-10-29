import type { DashscopeConfig } from './config.js';
import { DASHSCOPE_MAX_INPUT_CHARS } from './dashscope.js';
import type { Embedder } from './embedder.js';

/** 缺省单价(text-embedding-v3,0.0005 元 / 千 token);按模型的单价见 models.ts 能力表 */
export const DASHSCOPE_YUAN_PER_1K_TOKENS = 0.0005;
/** 预算换算汇率(元/美元),与设计文档预算依据一致 */
export const CNY_PER_USD = 6.67;

/**
 * 每个提供方 / 模型 / 维度一个 Qdrant 集合:local 仍用配置的集合名(默认 code_chunks,不变);
 * dashscope 为 `<base>_dashscope_<model>_<dim>`,如 code_chunks_dashscope_text-embedding-v3_1024。
 * 维度不同的向量不能进同一集合;旧集合保留,回切即复用。
 */
export function qdrantCollectionFor(
  base: string,
  ds: Pick<DashscopeConfig, 'model' | 'dim'> | null,
): string {
  if (!ds) return base;
  return `${base}_dashscope_${ds.model.replace(/[^A-Za-z0-9_-]/g, '_')}_${ds.dim}`;
}

/**
 * 任务 embedding 费用上界(美分)。按最坏 1 字符 ≈ 1 token(与预算依据相同),单条先截到
 * DASHSCOPE_MAX_INPUT_CHARS;不扣缓存命中,宁可多估。用于开始前强制 EMBEDDING_TASK_BUDGET_CENTS。
 */
export function estimateEmbeddingCents(
  texts: string[],
  yuanPer1k = DASHSCOPE_YUAN_PER_1K_TOKENS,
): number {
  return tokensToCents(worstTokens(texts), yuanPer1k);
}

export const tokensToCents = (tokens: number, yuanPer1k = DASHSCOPE_YUAN_PER_1K_TOKENS) =>
  ((tokens / 1000) * yuanPer1k * 100) / CNY_PER_USD;

/** 单条文本的 token 估算上界(最坏 1 字符 ≈ 1 token,先截到 DASHSCOPE_MAX_INPUT_CHARS) */
const worstTokens = (texts: string[]) =>
  texts.reduce((s, t) => s + Math.min(t.length, DASHSCOPE_MAX_INPUT_CHARS), 0);

/** 预算用尽:停止外部调用;worker 记 embeddingStatus=skipped、embeddingSkipReason=budget */
export class EmbeddingBudgetExceeded extends Error {
  override readonly name = 'EmbeddingBudgetExceeded';
  constructor() {
    super('embedding task budget exceeded');
  }
}

/**
 * 单任务 embedding 计量。优先按响应 usage.total_tokens 累计;响应没给 usage 时按上界估算并计入
 * estimatedTokens,stats 里据此标明 usage / estimate / mixed。每批请求前检查「已花 + 本批上界」
 * 不超过 EMBEDDING_TASK_BUDGET_CENTS,超出即抛 EmbeddingBudgetExceeded,不再发请求。
 */
export class TaskBudgetMeter {
  tokens = 0;
  estimatedTokens = 0;
  requests = 0;
  constructor(
    readonly budgetCents: number,
    /** 模型单价(元 / 千 token),取能力表 yuanPer1kTokens */
    readonly yuanPer1k = DASHSCOPE_YUAN_PER_1K_TOKENS,
  ) {}
  get cents() {
    return tokensToCents(this.tokens, this.yuanPer1k);
  }
  get source(): 'usage' | 'estimate' | 'mixed' | 'none' {
    if (this.requests === 0) return 'none';
    if (this.estimatedTokens === 0) return 'usage';
    return this.estimatedTokens === this.tokens ? 'estimate' : 'mixed';
  }
  assertRoom(texts: string[]) {
    if (this.cents + tokensToCents(worstTokens(texts), this.yuanPer1k) > this.budgetCents)
      throw new EmbeddingBudgetExceeded();
  }
  charge(usageTokens: number | undefined, texts: string[]) {
    this.requests++;
    if (usageTokens !== undefined) this.tokens += usageTokens;
    else {
      const est = worstTokens(texts);
      this.tokens += est;
      this.estimatedTokens += est;
    }
  }
}

export interface UsageReportingEmbedder extends Embedder {
  embedDocumentsWithUsage(texts: string[]): Promise<{ vectors: number[][]; usageTokens?: number }>;
}

/**
 * 给外部 embedder 套任务预算(每任务一个)。放在 CachedEmbedder 里面:缓存命中不计费、不检查。
 */
export class MeteredEmbedder implements Embedder {
  constructor(
    private readonly inner: UsageReportingEmbedder,
    readonly meter: TaskBudgetMeter,
  ) {}
  get provider() {
    return this.inner.provider;
  }
  get model() {
    return this.inner.model;
  }
  get revision() {
    return this.inner.revision;
  }
  get dim() {
    return this.inner.dim;
  }
  embedQuery(text: string) {
    return this.inner.embedQuery(text);
  }
  async embedDocuments(texts: string[]) {
    if (!texts.length) return [];
    this.meter.assertRoom(texts);
    const r = await this.inner.embedDocumentsWithUsage(texts);
    this.meter.charge(r.usageTokens, texts);
    return r.vectors;
  }
}
