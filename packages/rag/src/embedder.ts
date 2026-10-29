import { createHash } from 'node:crypto';
import { EMBEDDING_DIM } from './config.js';

export type EmbedRole = 'query' | 'passage';

/** e5 约定:查询加 `query: `,文档加 `passage: ` */
export const E5_PREFIX: Record<EmbedRole, string> = { query: 'query: ', passage: 'passage: ' };

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  /** 单条查询,内部加 `query: ` 前缀 */
  embedQuery(text: string): Promise<number[]>;
  /** 批量文档,内部加 `passage: ` 前缀;调用方负责分批 */
  embedDocuments(texts: string[]): Promise<number[][]>;
}

const normalize = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};

/**
 * 假向量:不加载模型、不联网,CI 和单测用。按词哈希到 384 维(词袋),
 * 同样的文本得到同样的向量,共享词越多余弦越高,足够做结构验证。
 */
export class FakeEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  /** 实际被编码的文本条数(测试用来确认缓存命中) */
  encoded = 0;
  constructor(readonly model = 'fake-384') {}
  private vec(text: string): number[] {
    this.encoded++;
    const v = new Array<number>(this.dim).fill(0);
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
      const h = createHash('sha256').update(w).digest();
      v[h.readUInt16BE(0) % this.dim]! += h[2]! & 1 ? 1 : -1;
    }
    return normalize(v);
  }
  async embedQuery(text: string) {
    return this.vec(E5_PREFIX.query + text);
  }
  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vec(E5_PREFIX.passage + t));
  }
}

export type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/** pipeline 选项;threads 未给时不设 session_options,沿用 ORT 默认 */
export function onnxPipelineOptions(threads?: number) {
  return {
    dtype: 'fp32' as const,
    ...(threads ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {}),
  };
}

/**
 * 本地 ONNX(@huggingface/transformers,fp32)。模型在镜像构建时下载到 modelDir,
 * 运行时禁止联网拉模型。只在 worker 进程里使用(峰值内存约 2.5 GB)。
 */
export class OnnxEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  private ext: Promise<Extractor> | null = null;
  constructor(
    readonly model: string,
    private readonly modelDir: string,
    /** @internal 仅测试:替换模型加载,用来断言实际送进模型的文本;业务代码不要传 */
    loader?: () => Promise<Extractor>,
    private readonly threads?: number,
  ) {
    if (loader) this.ext = loader();
  }
  private load(): Promise<Extractor> {
    this.ext ??= (async () => {
      const t = await import('@huggingface/transformers');
      t.env.localModelPath = this.modelDir.endsWith('/') ? this.modelDir : `${this.modelDir}/`;
      t.env.allowRemoteModels = false;
      return (await t.pipeline(
        'feature-extraction',
        this.model,
        onnxPipelineOptions(this.threads),
      )) as unknown as Extractor;
    })();
    return this.ext;
  }
  private async run(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const out = (await (await this.load())(texts, { pooling: 'mean', normalize: true })).tolist();
    for (const r of out)
      if (r.length !== this.dim) throw new Error(`embedding 维度 ${r.length},期望 ${this.dim}`);
    return out;
  }
  async embedQuery(text: string) {
    return (await this.run([E5_PREFIX.query + text]))[0]!;
  }
  async embedDocuments(texts: string[]) {
    return this.run(texts.map((t) => E5_PREFIX.passage + t));
  }
}
