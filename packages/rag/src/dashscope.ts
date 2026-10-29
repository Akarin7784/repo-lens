import type { Embedder } from './embedder.js';
import type { DashscopeConfig } from './config.js';

/**
 * 单条文本字符上限。依据:官方 v3 单条 ≤ 8192 token;代码/中文最坏约 1 字符 ≈ 1 token,
 * 取 6000 字符留余量。切块上限 MAX_CHUNK_CHARS=4000,正常块不受影响;只防异常长文本让整批 400。
 * 8192 token 边界未实测。
 */
export const DASHSCOPE_MAX_INPUT_CHARS = 6000;

/** 索引:单次 15 秒、最多重试 3 次;查询:单次 5 秒、最多重试 1 次(失败由检索降级 keyword-only) */
export const INDEX_CALL = { timeoutMs: 15_000, retries: 3 } as const;
export const QUERY_CALL = { timeoutMs: 5_000, retries: 1 } as const;

export type EmbeddingErrorKind =
  'auth' | 'rate-limit' | 'timeout' | 'bad-request' | 'unavailable' | 'bad-response';

/**
 * 外部 embedding 错误。message / 字段只含状态码与分类,**不含第三方原始响应体**
 * (防止回显密钥片段);也不挂 cause。
 */
export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError';
  constructor(
    readonly kind: EmbeddingErrorKind,
    readonly status?: number,
  ) {
    super(`dashscope embeddings failed: ${kind}${status ? ` (HTTP ${status})` : ''}`);
  }
  get retryable() {
    return this.kind === 'rate-limit' || this.kind === 'timeout' || this.kind === 'unavailable';
  }
}

/**
 * 进程内 TPM 令牌桶:**只对单个 worker 进程有效**。多 worker 时各自计数,
 * 合计可能超限,靠 429 退避兜底;演示只开一个 worker。
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.tokens = perMinute;
    this.last = now();
  }
  private refill() {
    const t = this.now();
    this.tokens = Math.min(
      this.perMinute,
      this.tokens + ((t - this.last) / 60_000) * this.perMinute,
    );
    this.last = t;
  }
  async take(n: number) {
    const need = Math.min(n, this.perMinute);
    for (;;) {
      this.refill();
      if (this.tokens >= need) {
        this.tokens -= need;
        return;
      }
      await this.sleep(Math.ceil(((need - this.tokens) / this.perMinute) * 60_000));
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 粗估 token(扣桶用):约 3 字符 1 token,至少 1 */
export const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 3));

export interface DashscopeDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  bucket?: TokenBucket;
  /** 退避基数(毫秒),测试设 0 */
  backoffMs?: number;
}

/**
 * 阿里云百炼 OpenAI 兼容 embedding。不加 e5 前缀,不传 text_type / instruct
 * (实测 instruct 会改变 v3 向量)。调用方负责分批(≤10 条)。
 */
export class DashscopeEmbedder implements Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dim: number;
  /** 被截断的文本条数(可进 stats) */
  truncated = 0;
  /** 累计实际 token(来自响应 usage) */
  usageTokens = 0;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bucket: TokenBucket;
  private readonly backoffMs: number;

  constructor(
    private readonly cfg: DashscopeConfig & { apiKey: string },
    deps: DashscopeDeps = {},
  ) {
    this.model = `dashscope:${cfg.model}`;
    this.revision = String(cfg.dim);
    this.dim = cfg.dim;
    this.fetchFn = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? defaultSleep;
    this.bucket = deps.bucket ?? new TokenBucket(cfg.tpm, Date.now, this.sleep);
    this.backoffMs = deps.backoffMs ?? 1000;
  }

  async embedQuery(text: string) {
    return (await this.call([text], QUERY_CALL))[0]!;
  }

  async embedDocuments(texts: string[]) {
    if (texts.length === 0) return [];
    if (texts.length > this.cfg.batchSize)
      throw new RangeError(`batch ${texts.length} > ${this.cfg.batchSize}`);
    return this.call(texts, INDEX_CALL);
  }

  private clip(t: string) {
    if (t.length <= DASHSCOPE_MAX_INPUT_CHARS) return t;
    this.truncated++;
    return t.slice(0, DASHSCOPE_MAX_INPUT_CHARS);
  }

  private async call(raw: string[], opt: { timeoutMs: number; retries: number }) {
    const input = raw.map((t) => this.clip(t));
    await this.bucket.take(input.reduce((s, t) => s + estimateTokens(t), 0));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(input, opt.timeoutMs);
      } catch (e) {
        const err = e instanceof EmbeddingError ? e : new EmbeddingError('unavailable');
        if (!err.retryable || attempt >= opt.retries) throw err;
        const base = this.backoffMs * 2 ** attempt;
        await this.sleep(base + Math.floor(Math.random() * base * 0.25));
      }
    }
  }

  private async once(input: string[], timeoutMs: number): Promise<number[][]> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.model,
          input,
          dimensions: this.dim,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      throw new EmbeddingError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
      );
    }
    if (!res.ok) {
      // 丢弃响应体,不读入错误对象
      await res.body?.cancel().catch(() => {});
      const s = res.status;
      throw new EmbeddingError(
        s === 401 || s === 403
          ? 'auth'
          : s === 429
            ? 'rate-limit'
            : s >= 500
              ? 'unavailable'
              : 'bad-request',
        s,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      // AbortSignal.timeout 也覆盖读响应体:读体超时 / 中止归为 timeout(可重试),其余才是 bad-response
      const name = (e as { name?: string } | null)?.name;
      throw new EmbeddingError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'bad-response',
        name === 'TimeoutError' || name === 'AbortError' ? undefined : res.status,
      );
    }
    const j = json as {
      data?: { index?: number; embedding?: unknown }[];
      usage?: { total_tokens?: number };
    };
    const data = j.data;
    if (!Array.isArray(data) || data.length !== input.length)
      throw new EmbeddingError('bad-response', res.status);
    const out: number[][] = new Array(input.length);
    for (const d of data) {
      const v = d.embedding;
      if (typeof d.index !== 'number' || !Array.isArray(v) || v.length !== this.dim || out[d.index])
        throw new EmbeddingError('bad-response', res.status);
      out[d.index] = v as number[];
    }
    if (out.some((v) => !v)) throw new EmbeddingError('bad-response', res.status);
    if (typeof j.usage?.total_tokens === 'number') this.usageTokens += j.usage.total_tokens;
    return out;
  }
}
