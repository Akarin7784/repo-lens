import { createHash } from 'node:crypto';
import type { LlmCall, LlmCallResult, LlmClient } from './types.js';

/** 粗略 token 估算:约 4 个字符一个 token */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * 确定性假模型:同样的请求永远返回同样的文本和 token 数,不访问网络、不需要 key。
 * 用于 CI、单测与无 key 演示。json=true 时返回可解析的 JSON。
 */
export class FakeLlm implements LlmClient {
  readonly provider = 'fake';
  /** 实际被调用的次数(测试用来确认缓存命中没打到模型) */
  calls = 0;

  constructor(private readonly opts: { fail?: (req: LlmCall) => boolean } = {}) {}

  async call(req: LlmCall): Promise<LlmCallResult> {
    this.calls++;
    if (this.opts.fail?.(req)) throw new Error('FakeLlm: 模拟调用失败');
    const prompt = req.messages.map((m) => `${m.role}:${m.content}`).join('\n');
    const h = createHash('sha256').update(`${req.model}\n${prompt}`).digest('hex').slice(0, 12);
    const text = req.json
      ? JSON.stringify({
          summary: `fake summary ${h}`,
          responsibilities: [`fake-${h.slice(0, 6)}`],
        })
      : `fake response ${h}`;
    const out = Math.min(estimateTokens(text), req.maxTokens ?? Infinity);
    return { text, usage: { tokensIn: estimateTokens(prompt), tokensOut: out } };
  }
}
