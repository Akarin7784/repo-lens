import type { LlmCall, LlmCallResult, LlmClient } from './types.js';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * DeepSeek OpenAI 兼容客户端:POST {baseUrl}/chat/completions(非流式)。
 * 文档:https://api-docs.deepseek.com/api/create-chat-completion
 * - 关闭思考模式(reasoning_effort: none),摘要类任务不需要,省 token。
 * - json=true 时开启 response_format json_object(调用方的 prompt 必须要求 JSON,见文档)。
 * - usage 取响应字段:prompt_tokens(= 命中 + 未命中)、completion_tokens、prompt_cache_hit_tokens。
 * - 不在本层重试;重试、熔断、降级由 BreakerClient / 网关 / 调用方负责。
 * - key 只放在请求头;错误信息只含状态码与响应里的 error.message,不含请求头。
 */
export class DeepSeekClient implements LlmClient {
  readonly provider = 'deepseek';
  readonly #apiKey: string;
  constructor(
    apiKey: string,
    private readonly o: { baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未设置');
    this.#apiKey = apiKey;
  }

  async call(req: LlmCall): Promise<LlmCallResult> {
    const base = (this.o.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const body = {
      model: req.model,
      messages: req.messages,
      stream: false,
      reasoning_effort: 'none',
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    };
    const res = await (this.o.fetch ?? fetch)(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = '';
      try {
        msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        /* 非 JSON 响应 */
      }
      throw new LlmHttpError(
        res.status,
        `DeepSeek HTTP ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`,
      );
    }
    let data: ChatResponse;
    try {
      data = JSON.parse(raw) as ChatResponse;
    } catch {
      throw new LlmHttpError(res.status, 'DeepSeek 响应不是 JSON');
    }
    const text = data.choices?.[0]?.message?.content;
    const u = data.usage;
    if (
      typeof text !== 'string' ||
      !u ||
      typeof u.prompt_tokens !== 'number' ||
      typeof u.completion_tokens !== 'number'
    )
      throw new LlmHttpError(res.status, 'DeepSeek 响应缺少 choices[0].message.content 或 usage');
    return {
      text,
      usage: {
        tokensIn: u.prompt_tokens,
        tokensOut: u.completion_tokens,
        cachedTokensIn: u.prompt_cache_hit_tokens ?? 0,
      },
    };
  }
}
