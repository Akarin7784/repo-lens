/** Redis key 约定(BACKEND_AI_DESIGN.md §2.2),API 与 Worker 共用 */
export const JOB_EVENTS_MAXLEN = 500;
export const JOB_EVENTS_TTL_S = 24 * 3600;
export const GRAPH_CACHE_TTL_S = 7 * 24 * 3600;
export const RATE_LIMIT_TTL_S = 3600;
export const LOCK_TTL_S = 30 * 60;

const pad = (n: number) => String(n).padStart(2, '0');
/** UTC 的 yyyyMMddHH(限流按自然小时分桶) */
export const hourBucket = (d = new Date()): string =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;

export const redisKeys = {
  jobEvents: (jobId: string) => `job:${jobId}:events`,
  repoLock: (repoId: number, commit: string) => `lock:repo:${repoId}:${commit}`,
  /** 文档为 graph:{repoId}:{commitSha}:{parentId|root};includeExternal=true 时追加 :ext */
  graph: (repoId: number, commit: string, parentId: string | null, includeExternal = false) =>
    `graph:${repoId}:${commit}:${parentId ?? 'root'}${includeExternal ? ':ext' : ''}`,
  graphPattern: (repoId: number, commit: string) => `graph:${repoId}:${commit}:*`,
  rateLimitIp: (ip: string, d = new Date()) => `rl:ip:${ip}:${hourBucket(d)}`,
} as const;

/** 对外 jobId = `${repoId}:${commit}`;BullMQ 5 禁止自定义 id 含单个 ':',队列内用 '-' */
export const publicJobId = (repoId: number, commit: string) => `${repoId}:${commit}`;
export const queueJobId = (jobId: string) => jobId.replace(':', '-');
export const parseJobId = (jobId: string): { repoId: number; commitSha: string } | null => {
  const m = /^(\d+):([0-9a-f]{40})$/.exec(jobId);
  return m ? { repoId: Number(m[1]), commitSha: m[2]! } : null;
};
