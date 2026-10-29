import { afterAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import {
  FakeEmbedder,
  MemoryVectorStore,
  embedLockKey,
  indexChunks,
  withEmbedLock,
} from '@repolens/rag';

// 本机 Redis 共用:固定 db 9 + 进程唯一前缀,不碰其他库和 key
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/9';
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
if (!hasRedis) console.warn(`[worker] Redis 不可达,跳过向量化锁集成测试`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunks = Array.from({ length: 3 }, (_, i) => ({
  path: `src/f${i}.ts`,
  symbol: null,
  startLine: 1,
  endLine: 1,
  text: `f${i}`,
  contentHash: String(i),
}));

describe.skipIf(!hasRedis)('向量化锁 lock:embed:{repo}:{commit}(真实 Redis)', () => {
  const redis = new Redis(REDIS_URL);
  const prefix = `test:${process.pid}:${Date.now()}:`;
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });

  it('key 形如 lock:embed:{repo_id}:{commit_sha}', () => {
    expect(embedLockKey(7, 'abc')).toBe('lock:embed:7:abc');
  });

  it('同 commit 两个并发任务只写一次,另一个不写、得到 reused', async () => {
    const store = new MemoryVectorStore();
    const emb = new FakeEmbedder();
    const spy = vi.spyOn(emb, 'embedDocuments');
    const key = embedLockKey(1, 'c1');
    const run = () =>
      withEmbedLock(
        redis,
        key,
        async () => {
          await sleep(200);
          return indexChunks({ repoId: 1, commitSha: 'c1', chunks, batchSize: 8 }, emb, store);
        },
        { prefix, pollMs: 50 },
      );
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await store.count(1, 'c1')).toBe(3);
    expect(await redis.get(prefix + key)).toBeNull();
  });

  it('持有者崩溃(不释放)时锁按 TTL 过期,等待者接手', async () => {
    const key = embedLockKey(1, 'crash');
    await redis.set(prefix + key, 'dead-token', 'PX', 300);
    const t0 = Date.now();
    const r = await withEmbedLock(redis, key, async () => 'mine', { prefix, pollMs: 50 });
    expect(r).toEqual({ ran: true, result: 'mine' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('持有者失败时释放锁且不写完成标记,另一任务接手执行', async () => {
    const key = embedLockKey(1, 'fail');
    const a = withEmbedLock(
      redis,
      key,
      async () => {
        await sleep(150);
        throw new Error('boom');
      },
      { prefix, pollMs: 50 },
    );
    await sleep(20);
    const b = withEmbedLock(redis, key, async () => 'taken-over', { prefix, pollMs: 50 });
    await expect(a).rejects.toThrow('boom');
    expect(await b).toEqual({ ran: true, result: 'taken-over' });
  });

  it('只释放自己的锁:超时后锁被他人持有,原持有者结束不会删掉别人的锁', async () => {
    const key = embedLockKey(1, 'token');
    const r = await withEmbedLock(
      redis,
      key,
      async () => {
        await sleep(300); // 超过 TTL 0.1s,锁已过期
        await redis.set(prefix + key, 'other', 'PX', 5000);
        return 1;
      },
      { prefix, ttlSec: 0.1, pollMs: 50 },
    );
    expect(r.ran).toBe(true);
    expect(await redis.get(prefix + key)).toBe('other');
  });
});
