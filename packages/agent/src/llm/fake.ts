import { createHash } from 'node:crypto';
import type { LlmCall, LlmCallResult, LlmClient, LlmStreamEvent } from './types.js';

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

  /** stream() 被调用的次数 */
  streams = 0;

  constructor(
    private readonly opts: {
      fail?: (req: LlmCall) => boolean;
      /** stream():自定义输出全文(默认与 call() 相同) */
      streamText?: (req: LlmCall) => string;
      /** stream():每个 text 事件的字符数,默认 8 */
      chunkSize?: number;
      /** stream():吐出这么多个 text 事件后模拟上游断流(抛错,不给 usage) */
      breakAfterChunks?: number;
    } = {},
  ) {}

  /**
   * 确定性流式输出:按 chunkSize 切分文本逐段 yield,最后给一个估算的 usage 事件。
   * 每段之前检查 signal,已取消就抛出 signal.reason(模拟底层请求被中止)。
   */
  async *stream(req: LlmCall): AsyncGenerator<LlmStreamEvent> {
    this.streams++;
    if (this.opts.fail?.(req)) throw new Error('FakeLlm: 模拟建连失败');
    const prompt = req.messages.map((m) => `${m.role}:${m.content}`).join('\n');
    const text = this.opts.streamText?.(req) ?? this.render(req, prompt);
    const size = Math.max(1, this.opts.chunkSize ?? 8);
    let n = 0;
    for (let i = 0; i < text.length; i += size) {
      await Promise.resolve();
      if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
      if (this.opts.breakAfterChunks != null && n >= this.opts.breakAfterChunks)
        throw new Error('FakeLlm: 模拟上游中途断流');
      n++;
      yield { type: 'text', text: text.slice(i, i + size) };
    }
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
    const out = Math.min(estimateTokens(text), req.maxTokens ?? Infinity);
    yield { type: 'usage', usage: { tokensIn: estimateTokens(prompt), tokensOut: out } };
  }

  private render(req: LlmCall, prompt: string) {
    const h = createHash('sha256').update(`${req.model}\n${prompt}`).digest('hex').slice(0, 12);
    return `fake response ${h}`;
  }

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
