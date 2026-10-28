import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MysqlStore, queueJobId, runMigrations } from '@repolens/db';
import { buildApp, type AnalyzeJobData, type JobQueue } from './app.js';
import { createGitHost } from './githost.js';

const ANALYZE_QUEUE = 'analyze';
/** 与 worker 的 ANALYZE_JOB_OPTS 一致 */
const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const port = Number(process.env.API_PORT ?? 4000);
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL 未设置');
await runMigrations(dbUrl);
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
const app = buildApp({
  store: MysqlStore.create(dbUrl),
  redis,
  queue,
  git: createGitHost({ githubToken: process.env.GITHUB_TOKEN }),
  maxRepoMb: Number(process.env.MAX_REPO_MB ?? 300),
});
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
