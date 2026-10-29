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
