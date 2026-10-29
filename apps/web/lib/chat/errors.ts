import type { ChatErrorInfo } from './answer';

/** FRONTEND_DESIGN §6.1 的错误码文案;前端自有码(HTTP/NETWORK)在下方补充 */
export const CHAT_ERROR_TEXT: Record<string, string> = {
  LLM_UNAVAILABLE: '模型服务暂时不可用',
  BUDGET_EXCEEDED: '今日额度已用完,明天再试',
  REPO_NOT_READY: '仓库还在分析中(摘要/索引未完成)',
  RATE_LIMITED: '提问太频繁,请稍后再试',
  NETWORK: '网络连接中断',
  NOT_AVAILABLE: '问答服务暂未上线',
  HTTP: '问答请求失败,请稍后重试',
  BAD_RESPONSE: '服务返回的不是问答流,无法显示回答,请稍后重试',
};

/** RATE_LIMITED 的默认重试倒计时(秒):concurrency、缺 reason、未知 reason、rate_limit 未带 retryAfterSec 时用 */
export const RATE_LIMIT_COOLDOWN_S = 10;
/** retryAfterSec 上限:契约为 1–3600(距下一个 UTC 整点);超出按 3600 截断,防止异常值让按钮长期不可点 */
export const RATE_LIMIT_MAX_COOLDOWN_S = 3600;

/**
 * 等待时长文案(T-236,架构师定稿):不足 60 秒「N 秒」;60 秒及以上向上取整「约 N 分钟」。
 * 用于提示行「…后可再提问」;按钮文字不含倒计时。
 *
 * 前置条件:调用方保证 sec>0 才渲染(RetryButton 仅在 left>0 时显示提示行)。
 * 本函数不防 0 / 负数 / NaN,传入时按原样格式化(如 0 → 「0 秒」),不做兜底。
 */
export function formatWait(sec: number): string {
  return sec < 60 ? `${sec} 秒` : `约 ${Math.ceil(sec / 60)} 分钟`;
}

/** 契约 v2:429 按 details.reason 细分;缺失或不认识的 reason 用通用 CHAT_ERROR_TEXT.RATE_LIMITED */
export const RATE_LIMITED_REASON_TEXT: Record<string, string> = {
  rate_limit: '本小时提问次数已用完,请稍后再试',
  concurrency: '当前提问的人较多,请稍后再试',
};

/**
 * RATE_LIMITED 的重试倒计时(秒);其他错误码返回 0(不倒计时)。
 * 只有 rate_limit 使用 retryAfterSec;concurrency 按契约不带该字段,即使带了也忽略。
 */
export function retryCooldownSec(e: ChatErrorInfo): number {
  if (e.code !== 'RATE_LIMITED') return 0;
  if (e.reason === 'rate_limit' && e.retryAfterSec !== undefined)
    return Math.min(e.retryAfterSec, RATE_LIMIT_MAX_COOLDOWN_S);
  return RATE_LIMIT_COOLDOWN_S;
}

/**
 * 契约错误码和前端自有码用固定文案;其他码(开流前 ApiError 的 code)显示服务端 ApiError.message,
 * 没有 message 时用通用文案。不显示原始响应体。
 */
export function chatErrorText(e: ChatErrorInfo): string {
  if (
    e.code === 'RATE_LIMITED' &&
    e.reason !== undefined &&
    Object.hasOwn(RATE_LIMITED_REASON_TEXT, e.reason)
  )
    return RATE_LIMITED_REASON_TEXT[e.reason]!;
  const fixed = CHAT_ERROR_TEXT[e.code];
  if (fixed && e.code !== 'HTTP') return fixed;
  return e.message ? `问答请求失败:${e.message}` : CHAT_ERROR_TEXT.HTTP!;
}
