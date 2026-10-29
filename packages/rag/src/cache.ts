import { createHash } from 'node:crypto';
import type { EmbedRole, Embedder } from './embedder.js';

/** 最小 KV 接口(ioredis 兼容的子集),便于单测用内存实现 */
export interface EmbeddingKv {
  mget(keys: string[]): Promise<(string | null)[]>;
  setex(key: string, ttlSec: number, value: string): Promise<unknown>;
}

export class MemoryEmbeddingKv implements EmbeddingKv {
  readonly m = new Map<string, string>();
  async mget(keys: string[]) {
    return keys.map((k) => this.m.get(k) ?? null);
  }
  async setex(key: string, _ttl: number, value: string) {
    this.m.set(key, value);
  }
}

export const EMB_TTL_SEC = 30 * 24 * 3600;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** 缓存键带角色:同一文本作为查询和作为文档的向量不同;model 段含 revision(有时为 model@revision) */
export const embKey = (model: string, role: EmbedRole, text: string) =>
  `emb:${model}:${role}:${sha(text)}`;

const enc = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const dec = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
};

/** 给任意 Embedder 套 Redis 缓存(base64 float32,30 天);未命中的才送模型 */
export class CachedEmbedder implements Embedder {
  constructor(
    private readonly inner: Embedder,
    private readonly kv: EmbeddingKv,
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
  private get keyModel() {
    return this.revision ? `${this.model}@${this.revision}` : this.model;
  }
  get dim() {
    return this.inner.dim;
  }
  async embedQuery(text: string) {
    const k = embKey(this.keyModel, 'query', text);
    const [hit] = await this.kv.mget([k]);
    if (hit) return dec(hit);
    const v = await this.inner.embedQuery(text);
    await this.kv.setex(k, EMB_TTL_SEC, enc(v));
    return v;
  }
  /** 每次调用(indexChunks 里即每一批)成功后立即写缓存:中途失败重跑时已成功的批直接命中,不重复请求 */
  async embedDocuments(texts: string[]) {
    if (!texts.length) return [];
    const keys = texts.map((t) => embKey(this.keyModel, 'passage', t));
    const hits = await this.kv.mget(keys);
    const miss = texts.flatMap((t, i) => (hits[i] ? [] : [i]));
    const fresh = miss.length ? await this.inner.embedDocuments(miss.map((i) => texts[i]!)) : [];
    const out: number[][] = hits.map((h) => (h ? dec(h) : []));
    for (let j = 0; j < miss.length; j++) {
      out[miss[j]!] = fresh[j]!;
      await this.kv.setex(keys[miss[j]!]!, EMB_TTL_SEC, enc(fresh[j]!));
    }
    return out;
  }
}
