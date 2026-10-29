/** Redis key 约定(BACKEND_AI_DESIGN.md §2.2),API 与 Worker 共用 */
export const JOB_EVENTS_MAXLEN = 500;
export const JOB_EVENTS_TTL_S = 24 * 3600;
export const GRAPH_CACHE_TTL_S = 7 * 24 * 3600;
export const RATE_LIMIT_TTL_S = 3600;
export const LOCK_TTL_S = 30 * 60;
export const LLM_CACHE_TTL_S = 30 * 24 * 3600;
/** 日花费 key 保留 2 天(跨 UTC 零点时前一天的 key 还能查) */
export const LLM_SPEND_DAY_TTL_S = 2 * 24 * 3600;
export const LLM_SPEND_TASK_TTL_S = 7 * 24 * 3600;
/**
 * 图投影版本号,写进图缓存 key(graph:v{N}:...)。
 * **改投影逻辑(apps/api/src/projection.ts 的节点/边/截断规则)时必须递增**,
 * 旧版本 key 不再命中、随 TTL 自然过期,不依赖部署后手动清缓存。
 * v1 = #10(无版本前缀);v2 = #12 跨子树聚合边 + 边界节点;v3 = meta.cycles 按 SCC 成员集合投影;v4 = #21 根层 meta.suggestedFocus;v5 = 边的 inCycle(T-003h)。
 */
export const GRAPH_PROJECTION_VERSION = 5;

const pad = (n: number) => String(n).padStart(2, '0');
/** UTC 的 yyyyMMddHH(限流按自然小时分桶) */
export const hourBucket = (d = new Date()): string =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
/** UTC 的 yyyyMMdd(LLM 日预算按 UTC 自然日分桶) */
export const dayBucket = (d = new Date()): string => hourBucket(d).slice(0, 8);

export const redisKeys = {
  jobEvents: (jobId: string) => `job:${jobId}:events`,
  repoLock: (repoId: number, commit: string) => `lock:repo:${repoId}:${commit}`,
  /** graph:v{N}:{repoId}:{commitSha}:{parentId|root};includeExternal=true 时追加 :ext */
  graph: (
    repoId: number,
    commit: string,
    parentId: string | null,
    includeExternal = false,
    version = GRAPH_PROJECTION_VERSION,
  ) =>
    `graph:v${version}:${repoId}:${commit}:${parentId ?? 'root'}${includeExternal ? ':ext' : ''}`,
  /** 当前版本该 commit 的全部图缓存(重新入库时删除);旧版本 key 靠 TTL 过期 */
  graphPattern: (repoId: number, commit: string, version = GRAPH_PROJECTION_VERSION) =>
    `graph:v${version}:${repoId}:${commit}:*`,
  rateLimitIp: (ip: string, d = new Date()) => `rl:ip:${ip}:${hourBucket(d)}`,
  /** 宽松总量计数:所有 POST /api/repos 提交 */
  submitLimitIp: (ip: string, d = new Date()) => `rl:sub:${ip}:${hourBucket(d)}`,
  /** LLM 响应缓存,hash = sha256(model + 请求内容) */
  llmCache: (hash: string) => `llm:${hash}`,
  /** 全站当日 LLM 花费(micro-USD,INCRBY) */
  llmSpendDay: (d = new Date()) => `llm:spend:day:${dayBucket(d)}`,
  /** 单个分析任务的 LLM 花费(micro-USD) */
  llmSpendTask: (taskId: number) => `llm:spend:task:${taskId}`,
} as const;

/** 对外 jobId = `${repoId}:${commit}`;BullMQ 5 禁止自定义 id 含单个 ':',队列内用 '-' */
export const publicJobId = (repoId: number, commit: string) => `${repoId}:${commit}`;
export const queueJobId = (jobId: string) => jobId.replace(':', '-');
export const parseJobId = (jobId: string): { repoId: number; commitSha: string } | null => {
  const m = /^(\d+):([0-9a-f]{40})$/.exec(jobId);
  return m ? { repoId: Number(m[1]), commitSha: m[2]! } : null;
};
