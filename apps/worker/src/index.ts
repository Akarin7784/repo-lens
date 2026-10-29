import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_PRICES, LlmGateway, createLlmClient } from '@repolens/agent';
import { MysqlStore, redisKeys, waitForSchema } from '@repolens/db';
import {
  CachedEmbedder,
  FakeEmbedder,
  OnnxEmbedder,
  QdrantVectorStore,
  type Embedder,
} from '@repolens/rag';
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
const baseEmbedder: Embedder =
  emb.provider === 'onnx'
    ? new OnnxEmbedder(emb.model, emb.modelDir, undefined, emb.threads, emb.revision)
    : new FakeEmbedder();
const embedder = new CachedEmbedder(baseEmbedder, redis);
const vectorStore = emb.qdrant ? new QdrantVectorStore(emb.qdrant) : undefined;
console.log(
  `[worker] embedder=${emb.provider} model=${emb.model}@${emb.revision.slice(0, 7)} batch=${emb.batchSize} qdrant=${emb.qdrant ? 'on' : 'off'}`,
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
