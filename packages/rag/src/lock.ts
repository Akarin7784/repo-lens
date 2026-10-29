import { randomBytes } from 'node:crypto';

/** 锁需要的最小 Redis 子集(ioredis 兼容) */
export interface LockKv {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * 同 (repo, commit) 向量化互斥锁的默认 TTL:30 分钟。
 * 理由:必须长于一次完整向量化。本地 e5-small CPU 推理按保守 ≥10 块/秒估算,
 * 30 分钟可覆盖约 1.8 万块,远超演示仓库规模(zustand 132 块);持有者崩溃时最多阻塞这么久后由过期释放。
 * 大仓库或慢机器用 EMBEDDING_LOCK_TTL_SEC 调大。
 */
export const DEFAULT_EMBED_LOCK_TTL_SEC = 1800;

export const embedLockKey = (repoId: number, commitSha: string) =>
  `lock:embed:${repoId}:${commitSha}`;
/** 持有者成功完成后写的完成标记,等待者据此判断"已写完,复用" */
const doneKey = (lockKey: string) => `${lockKey}:done`;

/** 只删值等于自己 token 的锁,不会误删别人(过期后被他人重新持有)的锁 */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

const MARK_DONE = `return redis.call('set', KEYS[1], '1', 'PX', ARGV[1])`;

export type LockedRun<T> = { ran: true; result: T } | { ran: false };

/**
 * 拿到锁的执行 fn;拿不到的不写,轮询等待:
 * - 持有者成功(完成标记存在)→ 返回 { ran: false },调用方记 reused;
 * - 锁消失但没有完成标记(持有者失败或崩溃后过期)→ 重新抢锁接手执行。
 */
export async function withEmbedLock<T>(
  kv: LockKv,
  key: string,
  fn: () => Promise<T>,
  o: { ttlSec?: number; pollMs?: number; prefix?: string } = {},
): Promise<LockedRun<T>> {
  const ttlMs = (o.ttlSec ?? DEFAULT_EMBED_LOCK_TTL_SEC) * 1000;
  const pollMs = o.pollMs ?? 1000;
  const k = (o.prefix ?? '') + key;
  const token = randomBytes(16).toString('hex');
  for (;;) {
    if ((await kv.set(k, token, 'PX', ttlMs, 'NX')) === 'OK') {
      await kv.del(doneKey(k));
      try {
        const result = await fn();
        await kv.eval(MARK_DONE, 1, doneKey(k), String(ttlMs));
        return { ran: true, result };
      } finally {
        await kv.eval(RELEASE, 1, k, token);
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
    if (await kv.get(doneKey(k))) {
      if (!(await kv.get(k))) return { ran: false };
    }
  }
}
