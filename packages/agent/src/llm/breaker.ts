import { redisKeys } from '@repolens/db';
import type { LlmCall, LlmCallResult, LlmClient, LlmStreamEvent } from './types.js';

/** 熔断用到的最小 KV(ioredis 满足) */
export interface BreakerKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  incrby(key: string, n: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_S = 60;

export class CircuitOpenError extends Error {
  constructor(readonly provider: string) {
    super(`LLM 熔断已打开(${provider}),${BREAKER_OPEN_S}s 内不再调用`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * provider 级熔断(BACKEND_AI_DESIGN §7):连续 5 次失败后打开 60 秒,期间直接失败、不打 provider。
 * - `cb:llm:{provider}` 存在即为打开状态(TTL 60s,到期自动半开:下一次调用放行)。
 * - `cb:llm:{provider}:fails` 为连续失败计数,任何一次成功清零。
 * - 半开:打开时把失败计数置为 阈值-1,到期后放行的第一次调用再失败就立即重新打开 60 秒;成功则清零、完全关闭。
 * 多个进程共享同一 Redis 时状态共享。
 */
export class BreakerClient implements LlmClient {
  readonly provider: string;
  /** 只在内层客户端支持流式时提供(保持 `client.stream` 是否存在的语义) */
  readonly stream?: (req: LlmCall) => AsyncIterable<LlmStreamEvent>;
  constructor(
    private readonly inner: LlmClient,
    private readonly kv: BreakerKv,
    private readonly o: { failures?: number; openSeconds?: number; keyPrefix?: string } = {},
  ) {
    this.provider = inner.provider;
    if (inner.stream) this.stream = (req) => this.streamThrough(req);
  }
  private get openKey() {
    return `${this.o.keyPrefix ?? ''}${redisKeys.llmBreaker(this.provider)}`;
  }
  private get failKey() {
    return `${this.o.keyPrefix ?? ''}${redisKeys.llmBreakerFails(this.provider)}`;
  }

  async call(req: LlmCall): Promise<LlmCallResult> {
    if (await this.kv.get(this.openKey)) throw new CircuitOpenError(this.provider);
    try {
      const r = await this.inner.call(req);
      await this.succeeded();
      return r;
    } catch (err) {
      await this.failed();
      throw err;
    }
  }

  /**
   * 流式:建连失败、超时、5xx、上游中途断流(抛错或没给 usage 就结束)都计一次失败;
   * 用户主动中止(req.signal 已 aborted)不计失败也不算成功。拿到 usage 才算成功。
   */
  private async *streamThrough(req: LlmCall): AsyncGenerator<LlmStreamEvent> {
    if (await this.kv.get(this.openKey)) throw new CircuitOpenError(this.provider);
    let usage = false;
    try {
      for await (const ev of this.inner.stream!(req)) {
        if (ev.type === 'usage') usage = true;
        yield ev;
      }
    } catch (err) {
      if (!req.signal?.aborted) await this.failed();
      throw err;
    }
    if (req.signal?.aborted) return;
    if (usage) await this.succeeded();
    else await this.failed();
  }

  private async succeeded() {
    const openS = this.o.openSeconds ?? BREAKER_OPEN_S;
    await this.kv.set(this.failKey, '0', 'EX', openS * 10);
  }

  private async failed() {
    const openS = this.o.openSeconds ?? BREAKER_OPEN_S;
    const n = await this.kv.incrby(this.failKey, 1);
    await this.kv.expire(this.failKey, openS * 10);
    const max = this.o.failures ?? BREAKER_FAILURES;
    if (n >= max) {
      await this.kv.set(this.openKey, '1', 'EX', openS);
      // 进入半开预备:计数停在阈值-1,到期后第一次失败就重新打开
      await this.kv.set(this.failKey, String(max - 1), 'EX', openS * 10);
    }
  }
}
