import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { MysqlStore, redisKeys, waitForSchema } from '@repolens/db';
import { loadConfig } from './config.js';
import { RedisEventSink } from './events.js';
import { ANALYZE_QUEUE, processAnalyzeJob, type AnalyzeJobData } from './queue.js';

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL 未设置');
// 迁移只由 API 执行;worker 等待 schema 就绪(有限次指数退避重试)
await waitForSchema(config.databaseUrl, { label: 'worker' });
const store = MysqlStore.create(config.databaseUrl);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const events = new RedisEventSink(redis);

async function invalidateGraphCache(repoId: number, commitSha: string) {
  const stream = redis.scanStream({ match: redisKeys.graphPattern(repoId, commitSha), count: 200 });
  for await (const keys of stream as AsyncIterable<string[]>)
    if (keys.length) await redis.del(...keys);
}

const worker = new Worker<AnalyzeJobData>(
  ANALYZE_QUEUE,
  (job) =>
    processAnalyzeJob(job, { store, events, config, onGraphPersisted: invalidateGraphCache }),
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
