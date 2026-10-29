import { afterAll, describe, expect, it } from 'vitest';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { MemoryStore, publicJobId, queueJobId, redisKeys } from '@repolens/db';
import { RedisEventSink } from './events.js';
import { ANALYZE_JOB_OPTS, processAnalyzeJob, type AnalyzeJobData } from './queue.js';
import { makeGitRepo, SAMPLE_REPO, testConfig } from './test-utils.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/7'; // 库号占用表见 packages/agent/src/llm/llm.test.ts
async function redisUp() {
  const r = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
  });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const hasRedis = await redisUp();
if (!hasRedis) console.warn(`[worker] Redis 不可达(${REDIS_URL}),跳过 BullMQ 集成测试`);

describe.skipIf(!hasRedis)('BullMQ + Redis Stream(真实 Redis)', () => {
  const qname = `analyze-test-${process.pid}-${Date.now()}`;
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  afterAll(async () => {
    const q = new Queue(qname, { connection: redis.duplicate() });
    await q.obliterate({ force: true });
    await q.close();
    redis.disconnect();
  });

  it('入队 → Worker 处理 → Stream 里有完整事件;重复 jobId 不重复入队', async () => {
    const { url, sha } = makeGitRepo(SAMPLE_REPO);
    const store = new MemoryStore();
    const repo = await store.upsertRepo({ url, owner: 'o', name: 'n' });
    const jobId = publicJobId(repo.id + 9000 + (Date.now() % 1000), sha);
    await store.createTask({ jobId, repoId: repo.id, commitSha: sha });
    await redis.del(redisKeys.jobEvents(jobId));
    const data: AnalyzeJobData = { jobId, repoId: repo.id, repoUrl: url, commitSha: sha };

    const queue = new Queue<AnalyzeJobData>(qname, { connection: redis.duplicate() });
    const qe = new QueueEvents(qname, { connection: redis.duplicate() });
    await qe.waitUntilReady();
    const worker = new Worker<AnalyzeJobData>(
      qname,
      (job) =>
        processAnalyzeJob(job, {
          store,
          events: new RedisEventSink(redis),
          config: testConfig(),
          allowFileProtocol: true,
        }),
      { connection: redis.duplicate() },
    );
    const j1 = await queue.add('analyze', data, { ...ANALYZE_JOB_OPTS, jobId: queueJobId(jobId) });
    const j2 = await queue.add('analyze', data, { ...ANALYZE_JOB_OPTS, jobId: queueJobId(jobId) });
    expect(j2.id).toBe(j1.id);
    await j1.waitUntilFinished(qe, 30_000);
    const entries = await redis.xrange(redisKeys.jobEvents(jobId), '-', '+');
    const names = entries.map(([, f]) => f[1]);
    expect(names[0]).toBe('progress');
    expect(names).toContain('graph_ready');
    expect(names.at(-1)).toBe('done');
    const ttl = await redis.ttl(redisKeys.jobEvents(jobId));
    expect(ttl).toBeGreaterThan(23 * 3600);
    expect(j1.opts.attempts).toBe(3);
    expect(j1.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
    await worker.close();
    await qe.close();
    await queue.close();
  }, 40_000);
});
