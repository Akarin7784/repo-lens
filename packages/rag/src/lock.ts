import { randomBytes } from 'node:crypto';

/** 锁需要的最小 Redis 子集(ioredis 兼容) */
export interface LockKv {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * 锁 TTL 默认 300 秒。持有者每 TTL/3 心跳续期,向量化时长不再受 TTL 限制;
 * TTL 只决定持有者崩溃后多久释放(实测见 docs/notes/embed-lock-bench.md)。
 */
export const DEFAULT_EMBED_LOCK_TTL_SEC = 300;
/**
 * 等待者最长等待默认 3600 秒:实测单核 3.6 块/秒(e5-small fp32,batch 16),
 * 约覆盖 1.3 万块的完整向量化(hono ed1d5f7 为 1434 块)。
 */
export const DEFAULT_EMBED_LOCK_MAX_WAIT_SEC = 3600;

export const embedLockKey = (repoId: number, commitSha: string) =>
  `lock:embed:${repoId}:${commitSha}`;
/** 持有者成功完成后写的完成标记,等待者据此判断"已写完,复用" */
const doneKey = (lockKey: string) => `${lockKey}:done`;

/** 只删值等于自己 token 的锁,不会误删别人(过期后被他人重新持有)的锁 */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** 心跳续期:只续自己 token 的锁;返回 1 表示仍持有 */
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
/**
 * 完成标记:仍持有锁(KEYS[1] 值为自己 token)时才写 KEYS[2] = digest,返回 1;否则不写、返回 0。
 * 最后一次持锁校验与写完成标记在同一个 Lua 脚本里,两者之间不会被别的客户端插入。
 */
const MARK_DONE_IF_HELD = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], ARGV[2], 'PX', ARGV[3]) return 1 else return 0 end`;

export class EmbedLockLostError extends Error {
  constructor(key: string) {
    super(`向量化锁 ${key} 已丢失(续期失败或被接管),中止写入`);
    this.name = 'EmbedLockLostError';
  }
}
export class EmbedLockWaitTimeoutError extends Error {
  constructor(key: string, ms: number) {
    super(`等待同 commit 的另一任务向量化超过 ${Math.round(ms / 1000)} 秒(${key})`);
    this.name = 'EmbedLockWaitTimeoutError';
  }
}

/** 交给持有者的守卫:写入、删除前调用 assertHeld(),失去锁时抛 EmbedLockLostError */
export interface EmbedLockGuard {
  assertHeld(): Promise<void>;
}

export type LockedRun<T> = { ran: true; result: T } | { ran: false };

export interface EmbedLockOptions {
  ttlSec?: number;
  pollMs?: number;
  prefix?: string;
  /** 心跳间隔,默认 TTL 的 1/3 */
  renewMs?: number;
  /** 等待者最长等待毫秒,默认 DEFAULT_EMBED_LOCK_MAX_WAIT_SEC(3600 秒),与 TTL 无关;超时抛 EmbedLockWaitTimeoutError */
  maxWaitMs?: number;
  /** 本次切块内容 digest:持有者成功后写进完成标记,等待者只在标记值与之相同时复用 */
  digest: string;
  /** 第一次拿不到锁、开始等待时回调一次(发进度事件) */
  onWait?: () => Promise<void> | void;
}

/**
 * 拿到锁的执行 fn(guard),期间按 renewMs 心跳续期;拿不到的不写,轮询等待:
 * - 完成标记存在且等于本次 digest、锁已释放 → 返回 { ran: false },调用方记 reused;
 * - 锁消失但无匹配的完成标记(持有者失败、崩溃过期或内容不同)→ 重新抢锁接手执行;
 * - 等待超过 maxWaitMs → 抛 EmbedLockWaitTimeoutError。
 *
 * 已知限制:assertHeld() 与随后的向量库写入(Qdrant delete / upsert)不是原子的。校验通过后、
 * 写入完成前锁若恰好过期并被别的任务接管,两边可能短暂同时写同一 commit。影响有限:point id
 * 由 (repo, commit, path, 行区间, 符号) 确定性生成,同内容写入互相覆盖;接管者开写前会先删旧点,
 * 完成标记只由仍持锁者写(MARK_DONE_IF_HELD),丢锁的一方不会把结果标成可复用。
 */
export async function withEmbedLock<T>(
  kv: LockKv,
  key: string,
  fn: (guard: EmbedLockGuard) => Promise<T>,
  o: EmbedLockOptions,
): Promise<LockedRun<T>> {
  const ttlMs = Math.round((o.ttlSec ?? DEFAULT_EMBED_LOCK_TTL_SEC) * 1000);
  const pollMs = o.pollMs ?? 1000;
  const renewMs = o.renewMs ?? Math.max(10, Math.floor(ttlMs / 3));
  const maxWaitMs = o.maxWaitMs ?? DEFAULT_EMBED_LOCK_MAX_WAIT_SEC * 1000;
  const k = (o.prefix ?? '') + key;
  const token = randomBytes(16).toString('hex');
  const t0 = Date.now();
  let waiting = false;
  for (;;) {
    if ((await kv.set(k, token, 'PX', ttlMs, 'NX')) === 'OK') {
      await kv.del(doneKey(k));
      let held = true;
      const renew = async () => {
        if (!held) return false;
        const ok = Number(await kv.eval(RENEW, 1, k, token, String(ttlMs))) === 1;
        if (!ok) held = false;
        return ok;
      };
      const timer = setInterval(() => void renew().catch(() => (held = false)), renewMs);
      const guard: EmbedLockGuard = {
        async assertHeld() {
          // 不只看本地标记:同步校验一次 token(同时续期),避免心跳间隙里锁已过期被接管
          if (!(await renew())) throw new EmbedLockLostError(key);
        },
      };
      try {
        const result = await fn(guard);
        // 最后一次持锁校验与写完成标记合并为一个 Lua 脚本(原子)
        const marked = Number(
          await kv.eval(MARK_DONE_IF_HELD, 2, k, doneKey(k), token, o.digest, String(ttlMs)),
        );
        if (marked !== 1) {
          held = false;
          throw new EmbedLockLostError(key);
        }
        return { ran: true, result };
      } finally {
        clearInterval(timer);
        held = false;
        await kv.eval(RELEASE, 1, k, token);
      }
    }
    if (!waiting) {
      waiting = true;
      await o.onWait?.();
    }
    if (Date.now() - t0 >= maxWaitMs) throw new EmbedLockWaitTimeoutError(key, maxWaitMs);
    await new Promise((r) => setTimeout(r, pollMs));
    if ((await kv.get(doneKey(k))) === o.digest && !(await kv.get(k))) return { ran: false };
  }
}
