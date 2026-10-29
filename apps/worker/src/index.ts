import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_PRICES, LlmGateway, createLlmClient } from '@repolens/agent';
import { MysqlStore, redisKeys, waitForSchema } from '@repolens/db';
import { CachedEmbedder, qdrantCollectionFor, QdrantVectorStore } from '@repolens/rag';
import { buildEmbeddingDeps, selectEmbedder } from './embedder-select.js';
import { loadConfig } from './config.js';
import { RedisEventSink } from './events.js';
import { ANALYZE_QUEUE, processAnalyzeJob, type AnalyzeJobData } from './queue.js';

// 配置(含 LLM 预算等)不合法时启动即失败
const config = loadConfig();
console.log(
  `[worker] llm provider=${config.llm.provider} daily=${config.llm.dailyBudgetCents}¢ task=${config.llm.taskBudgetCents}¢`,
);
if (!config.databaseUrl) throw new Error('DATABASE_URL 未设置');
// 迁移只由 API 执行;worker 等待 schema 就绪(有限次指数退避重试)
await waitForSchema(config.databaseUrl, { label: 'worker' });
const store = MysqlStore.create(config.databaseUrl);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const events = new RedisEventSink(redis);
// LLM 网关:缓存与预算计数放 Redis,记账写 llm_usage
const gateway = new LlmGateway({
  // LLM_PROVIDER=deepseek 时套 cb:llm:{provider} 熔断(状态放共享 Redis)
  client: createLlmClient(config.llm, { kv: redis }),
  kv: redis,
  usage: store,
  prices: DEFAULT_PRICES,
  dailyBudgetCents: config.llm.dailyBudgetCents,
  taskBudgetCents: config.llm.taskBudgetCents,
});

// embedding 只在 worker 里跑(本地 ONNX 峰值约 2.5 GB);未配置 QDRANT_URL 时跳过向量化阶段
const emb = config.embedding;
const ds = emb.dashscope;
// EMBEDDING_PROVIDER=dashscope 时不构造 OnnxEmbedder、不读 /models;无 key → 向量化记 skipped 并告警(不打印 key)
const { base: baseEmbedder, dashscope } = selectEmbedder(emb);
const embedder = new CachedEmbedder(baseEmbedder, redis);
const embeddingDeps = buildEmbeddingDeps(emb, dashscope, redis);
// 每个提供方 / 维度一个集合,local 仍是 QDRANT_COLLECTION(默认 code_chunks)
const collection = emb.qdrant ? qdrantCollectionFor(emb.qdrant.collection, ds) : null;
// 缺 key 时向量库不会被使用:embeddingSkipReason='no-key' 使向量化整段跳过,不建集合、不写入
const vectorStore = emb.qdrant
  ? new QdrantVectorStore({ ...emb.qdrant, collection: collection!, dim: embedder.dim })
  : undefined;
if (ds && !ds.apiKey)
  console.warn(
    '[worker] EMBEDDING_PROVIDER=dashscope 但未配置 DASHSCOPE_API_KEY:向量化将记为 skipped',
  );
console.log(
  ds
    ? `[worker] embedder=dashscope model=${ds.model} dim=${ds.dim} batch=${ds.batchSize} budget=${ds.taskBudgetCents}c collection=${collection ?? '-'} qdrant=${emb.qdrant ? 'on' : 'off'}`
    : `[worker] embedder=${emb.provider} model=${emb.model}@${emb.revision.slice(0, 7)} batch=${emb.batchSize} qdrant=${emb.qdrant ? 'on' : 'off'}`,
);

async function invalidateGraphCache(repoId: number, commitSha: string) {
  const stream = redis.scanStream({ match: redisKeys.graphPattern(repoId, commitSha), count: 200 });
  for await (const keys of stream as AsyncIterable<string[]>)
    if (keys.length) await redis.del(...keys);
}

const worker = new Worker<AnalyzeJobData>(
  ANALYZE_QUEUE,
  (job) =>
    processAnalyzeJob(job, {
      store,
      events,
      config,
      lockKv: redis,
      gateway,
      embedder,
      vectorStore,
      ...embeddingDeps,
      onGraphPersisted: invalidateGraphCache,
    }),
  { connection: redis.duplicate(), concurrency: config.concurrency },
);

worker.on('ready', () => console.log(`[worker] listening on queue "${ANALYZE_QUEUE}"`));
worker.on('completed', (job) => console.log(`[worker] job ${job.data.jobId} done`));
worker.on('failed', (job, err) =>
  console.error(
    `[worker] job ${job?.data.jobId} failed (attempt ${job?.attemptsMade}): ${err.message}`,
  ),
);

const shutdown = async () => {
  await worker.close();
  await store.close();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
