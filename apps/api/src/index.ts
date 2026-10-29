import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_PRICES, LlmGateway, createLlmClient, readLlmConfig } from '@repolens/agent';
import {
  CachedEmbedder,
  DashscopeEmbedder,
  FakeEmbedder,
  QdrantVectorStore,
  qdrantCollectionFor,
  readEmbeddingConfig,
  type Embedder,
} from '@repolens/rag';
import { MysqlStore, queueJobId, runMigrations } from '@repolens/db';
import { buildApp, type AnalyzeJobData, type JobQueue } from './app.js';
import { createGitHost } from './githost.js';
import { readChatLimits, readSubmitLimits } from './limits.js';
import { redisRewriteCache } from './chat/route.js';

const ANALYZE_QUEUE = 'analyze';
/** 与 worker 的 ANALYZE_JOB_OPTS 一致 */
const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

// 限额配置不合法时启动即失败
const limits = readSubmitLimits(process.env);
const chatLimits = readChatLimits(process.env);
// LLM 配置(provider、日/任务预算)不合法时启动即失败
const llm = readLlmConfig(process.env);
const emb = readEmbeddingConfig(process.env);
const port = Number(process.env.API_PORT ?? 4000);
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL 未设置');
// 只有 API 跑迁移:连接有限次重试 + GET_LOCK 互斥
await runMigrations(dbUrl, { label: 'api' });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});
const bull = new Queue<AnalyzeJobData>(ANALYZE_QUEUE, { connection: redis.duplicate() });
const queue: JobQueue = {
  async enqueue(data) {
    await bull.add('analyze', data, { ...JOB_OPTS, jobId: queueJobId(data.jobId) });
  },
  async removeFailed(jobId) {
    const j = await bull.getJob(queueJobId(jobId));
    if (j && (await j.isFailed())) await j.remove();
  },
};
const store = MysqlStore.create(dbUrl);
// 与 worker 同一网关口径:预算计数放 Redis,记账写 llm_usage
const gateway = new LlmGateway({
  client: createLlmClient(llm, { kv: redis }),
  kv: redis,
  usage: store,
  prices: DEFAULT_PRICES,
  dailyBudgetCents: llm.dailyBudgetCents,
  taskBudgetCents: llm.taskBudgetCents,
  // app 在下面创建;告警只在请求期间触发,那时 app 已初始化
  log: { warn: (obj, msg) => app.log.warn(obj, msg) },
});
// 查询向量:百炼(有 key)或 fake;本地 ONNX 不在 api 里加载(峰值约 2.5 GB),此时检索 keyword-only
const ds = emb.dashscope;
const queryEmbedder: Embedder | null = ds?.apiKey
  ? new CachedEmbedder(new DashscopeEmbedder({ ...ds, apiKey: ds.apiKey }), redis)
  : emb.provider === 'fake'
    ? new FakeEmbedder()
    : null;
const vectorStore =
  emb.qdrant && queryEmbedder
    ? new QdrantVectorStore({
        ...emb.qdrant,
        collection: qdrantCollectionFor(emb.qdrant.collection, ds),
        dim: queryEmbedder.dim,
      })
    : null;
const app = buildApp({
  store,
  redis,
  queue,
  git: createGitHost({ githubToken: process.env.GITHUB_TOKEN }),
  maxRepoMb: Number(process.env.MAX_REPO_MB ?? 300),
  // 与 worker 默认值一致;compose 里两者都设为 /data/repos(api 只读挂载)
  reposDir: process.env.REPOS_DIR ?? join(tmpdir(), 'repolens-repos'),
  ...limits,
  chat: {
    gateway,
    model: llm.chatModel,
    embedder: queryEmbedder,
    vectorStore,
    perHour: chatLimits.perHour,
    maxStreams: chatLimits.maxStreams,
    userKeySecret: chatLimits.userKeySecret,
    streamTimeoutMs: chatLimits.streamTimeoutMs,
    rewriteCache: redisRewriteCache(redis),
  },
});
if (!chatLimits.userKeySecret)
  app.log.warn('CHAT_USER_KEY_SECRET 未设置:chat_session.user_key 将存 null');
app.log.info(
  {
    llmProvider: llm.provider,
    dailyBudgetCents: llm.dailyBudgetCents,
    chatRetrieval: vectorStore ? 'hybrid' : 'keyword-only',
  },
  'llm config loaded',
);
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
