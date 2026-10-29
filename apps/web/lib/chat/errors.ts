import type { ChatErrorInfo } from './answer';

/** FRONTEND_DESIGN §6.1 的错误码文案;前端自有码(HTTP/NETWORK)在下方补充 */
export const CHAT_ERROR_TEXT: Record<string, string> = {
  LLM_UNAVAILABLE: '模型服务暂时不可用',
  BUDGET_EXCEEDED: '今日额度已用完,明天再试',
  REPO_NOT_READY: '仓库还在分析中(摘要/索引未完成)',
  RATE_LIMITED: '提问太频繁,请稍后',
  NETWORK: '网络连接中断',
  NOT_AVAILABLE: '问答服务暂未上线',
  HTTP: '问答请求失败,请稍后重试',
  BAD_RESPONSE: '服务返回的不是问答流,无法显示回答,请稍后重试',
};

/** RATE_LIMITED 的重试按钮倒计时(§6.1:10 秒后才可点) */
export const RATE_LIMIT_COOLDOWN_S = 10;

/**
 * 契约错误码和前端自有码用固定文案;其他码(开流前 ApiError 的 code)显示服务端 ApiError.message,
 * 没有 message 时用通用文案。不显示原始响应体。
 */
export function chatErrorText(e: ChatErrorInfo): string {
  const fixed = CHAT_ERROR_TEXT[e.code];
  if (fixed && e.code !== 'HTTP') return fixed;
  return e.message ? `问答请求失败:${e.message}` : CHAT_ERROR_TEXT.HTTP!;
}
