import type { LlmGateway } from '@repolens/agent';
import { redisKeys, type Store } from '@repolens/db';
import {
  CachedEmbedder,
  qdrantCollectionFor,
  QdrantVectorStore,
  type EmbeddingConfig,
  type EmbeddingKv,
  type LockKv,
} from '@repolens/rag';
import type { WorkerConfig } from './config.js';
import { buildEmbeddingDeps, selectEmbedder, type EmbedderCtors } from './embedder-select.js';
import type { EventSink } from './events.js';
import type { PipelineDeps } from './pipeline/run.js';

/**
 * worker 装配用的 Redis 子集:embedding 缓存 + embed-lock + 图缓存 SCAN/DEL。
 * 生产传入 ioredis;单测可用 MemoryEmbeddingKv + 桩方法。
 */
export type JobDepsRedis = EmbeddingKv &
  LockKv & {
    scanStream(opts: { match: string; count?: number }): AsyncIterable<string[]>;
  };

export interface BuildJobDepsInput {
  config: WorkerConfig;
  /** 默认 `config.embedding`;测试可单独传入 */
  emb?: EmbeddingConfig;
  redis: JobDepsRedis;
  gateway: LlmGateway;
  store: Store;
  events: EventSink;
  ctors?: EmbedderCtors;
}

/**
 * 组装 processAnalyzeJob 的完整 deps。
 * index.ts 只负责连库/连 Redis/建 gateway,再调用本函数。
 */
export function buildJobDeps(input: BuildJobDepsInput): PipelineDeps {
  const emb = input.emb ?? input.config.embedding;
  const { base, dashscope } = selectEmbedder(emb, input.ctors);
  const embedder = new CachedEmbedder(base, input.redis);
  const embeddingDeps = buildEmbeddingDeps(emb, dashscope, input.redis);
  const ds = emb.dashscope;
  const collection = emb.qdrant ? qdrantCollectionFor(emb.qdrant.collection, ds) : null;
  // 缺 key 时向量库不会被使用:embeddingSkipReason='no-key' 使向量化整段跳过,不建集合、不写入
  const vectorStore = emb.qdrant
    ? new QdrantVectorStore({ ...emb.qdrant, collection: collection!, dim: embedder.dim })
    : undefined;

  const { redis } = input;
  return {
    store: input.store,
    events: input.events,
    config: input.config,
    lockKv: redis,
    gateway: input.gateway,
    embedder,
    vectorStore,
    ...embeddingDeps,
    onGraphPersisted: async (repoId, commitSha) => {
      const stream = redis.scanStream({
        match: redisKeys.graphPattern(repoId, commitSha),
        count: 200,
      });
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (!keys.length) continue;
        // LockKv.del 单 key;逐个删(图缓存键量通常不大)
        for (const k of keys) await redis.del(k);
      }
    },
  };
}
