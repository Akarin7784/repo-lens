/** 提交限额(每来源每小时),来自环境变量;见 docs/BACKEND_AI_DESIGN.md 限流一节 */
export interface SubmitLimits {
  /** 新仓库(真正入队的新任务)上限,默认 5;复用、被拒绝、出错不计 */
  rateLimitPerHour: number;
  /** 宽松总量上限,默认 60;每次 POST /api/analyze 都计(含复用、被拒绝、出错) */
  submitLimitPerHour: number;
}

function int(env: Record<string, string | undefined>, name: string, def: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} 必须是正整数,当前为 "${raw}"`);
  return n;
}

export function readSubmitLimits(env: Record<string, string | undefined>): SubmitLimits {
  return {
    rateLimitPerHour: int(env, 'RATE_LIMIT_NEW_REPOS_PER_HOUR', 5),
    submitLimitPerHour: int(env, 'RATE_LIMIT_SUBMITS_PER_HOUR', 60),
  };
}

/** P4-e 问答限额与 user_key 密钥(p4-design §7、§8) */
export interface ChatLimits {
  /** RATE_LIMIT_CHAT_PER_HOUR,默认 30;按 ipKey(IPv6 /64)计 */
  perHour: number;
  /** CHAT_MAX_CONCURRENT_STREAMS,默认 8;进程内计数 */
  maxStreams: number;
  /** CHAT_USER_KEY_SECRET(≥32 字节);未设置时为 null,user_key 存 null */
  userKeySecret: string | null;
  /** CHAT_STREAM_TIMEOUT_MS,默认 90000;整条问答流的总时限(毫秒) */
  streamTimeoutMs: number;
}

export function readChatLimits(env: Record<string, string | undefined>): ChatLimits {
  const secret = env.CHAT_USER_KEY_SECRET?.trim() || null;
  if (secret && Buffer.byteLength(secret) < 32)
    throw new Error('CHAT_USER_KEY_SECRET 至少 32 字节');
  return {
    perHour: int(env, 'RATE_LIMIT_CHAT_PER_HOUR', 30),
    maxStreams: int(env, 'CHAT_MAX_CONCURRENT_STREAMS', 8),
    userKeySecret: secret,
    streamTimeoutMs: int(env, 'CHAT_STREAM_TIMEOUT_MS', 90_000),
  };
}
