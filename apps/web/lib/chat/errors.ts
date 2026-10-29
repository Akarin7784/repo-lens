import type { ChatErrorInfo } from './answer';

/** FRONTEND_DESIGN §6.1 的错误码文案;前端自有码(HTTP/NETWORK)在下方补充 */
export const CHAT_ERROR_TEXT: Record<string, string> = {
  LLM_UNAVAILABLE: '模型服务暂时不可用',
  BUDGET_EXCEEDED: '今日额度已用完,明天再试',
  REPO_NOT_READY: '仓库还在分析中(摘要/索引未完成)',
  RATE_LIMITED: '提问太频繁,请稍后',
  NETWORK: '网络连接中断',
  NOT_AVAILABLE: '问答服务暂未上线',
  HTTP: '问答请求失败',
};

/** RATE_LIMITED 的重试按钮倒计时(§6.1:10 秒后才可点) */
export const RATE_LIMIT_COOLDOWN_S = 10;

export function chatErrorText(e: ChatErrorInfo): string {
  return CHAT_ERROR_TEXT[e.code] ?? '回答失败';
}
