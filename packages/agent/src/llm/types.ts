import type { LlmPurpose } from '@repolens/db';

export type { LlmPurpose };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 发给底层模型的请求(只含影响输出的字段,整体参与缓存 key) */
export interface LlmCall {
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 要求返回 JSON 对象(OpenAI 兼容的 response_format) */
  json?: boolean;
  /**
   * 取消信号(调用方超时 / 外部取消)。不参与缓存 key。客户端应把它传给底层请求,
   * 被取消时请求真正中止,不会再收到迟到的响应,也就不会为它计费。
   */
  signal?: AbortSignal;
}

export interface LlmUsage {
  /** 输入 token 总数(含 provider 上下文缓存命中的部分) */
  tokensIn: number;
  tokensOut: number;
  /** 其中命中 provider 上下文缓存的输入 token(DeepSeek prompt_cache_hit_tokens);不提供则为 0 */
  cachedTokensIn?: number;
}

/** 底层客户端返回;usage 取自响应的 usage 字段(真实 provider)或 FakeLlm 的估算 */
export interface LlmCallResult {
  text: string;
  usage: LlmUsage;
}

/**
 * 流式输出的一个事件:`text` 为正文增量;`usage` 为服务商返回的用量,只在流正常结束时出现一次(最后一个事件)。
 * 没有 `usage` 就结束的流视为上游中途断流。
 */
export type LlmStreamEvent = { type: 'text'; text: string } | { type: 'usage'; usage: LlmUsage };

/** 底层模型客户端:FakeLlm(默认)与 DeepSeekClient(OpenAI 兼容) */
export interface LlmClient {
  readonly provider: string;
  call(req: LlmCall): Promise<LlmCallResult>;
  /**
   * 可选:流式调用。被 `req.signal` 取消时应中止底层请求并抛出(调用方据 signal.aborted 判定为用户中止)。
   * 未实现的客户端(目前 DeepSeekClient,见 P7)不提供此方法。
   */
  stream?(req: LlmCall): AsyncIterable<LlmStreamEvent>;
}

/** 网关请求:LlmCall + 记账归属 */
export interface LlmRequest extends LlmCall {
  purpose: LlmPurpose;
  repoId?: number;
  taskId?: number;
  sessionId?: number;
}

export interface LlmResult extends LlmCallResult {
  model: string;
  /** 本次实际花费;缓存命中为 0 */
  costMicroUsd: number;
  cacheHit: boolean;
}

/** LlmGateway.stream 的正文增量 */
export interface LlmStreamChunk {
  text: string;
}

export type LlmErrorCode = 'BUDGET_EXCEEDED' | 'LLM_UNAVAILABLE';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    /** BUDGET_EXCEEDED 时是哪一级预算 */
    readonly scope?: 'daily' | 'task',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}
