import type { LlmMessage, LlmUsage } from './types.js';

/**
 * 按字数估算 token(服务商没给 usage、但流以 finish_reason:"stop" + [DONE] 正常结束时的兜底)。
 * 取上界、宁多勿少,不能少记预算:
 *   `tokens = ceil(字符串 UTF-16 长度 × 1)`,即每个字符(代理对算 2)按 1 token 计。
 * DeepSeek 实际约中文 0.6 token/字、英文/代码约 0.25–0.3 token/字符,1 token/字符 是上界。
 */
export function estimateTextTokens(s: string): number {
  return Math.ceil(s.length);
}

/** 输入 = 全部消息 content 之和 + 每条 4 token 的角色/分隔开销;输出 = 正文全文;cachedTokensIn 记 0(全按未命中价) */
export function estimateUsage(messages: readonly LlmMessage[], output: string): LlmUsage {
  return {
    tokensIn: messages.reduce((n, m) => n + 4 + estimateTextTokens(m.content), 0),
    tokensOut: estimateTextTokens(output),
    cachedTokensIn: 0,
  };
}
