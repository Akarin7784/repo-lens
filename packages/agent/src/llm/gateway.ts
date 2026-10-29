import { createHash } from 'node:crypto';
import {
  LLM_CACHE_TTL_S,
  LLM_SPEND_DAY_TTL_S,
  LLM_SPEND_TASK_TTL_S,
  redisKeys,
  type LlmUsageInput,
} from '@repolens/db';
import { costMicroUsd, priceOf, type PriceTable } from './pricing.js';
import {
  LlmError,
  type LlmCall,
  type LlmCallResult,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
} from './types.js';

/** 网关用到的 Redis 子集(ioredis 实例可直接传入) */
export interface LlmKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  incrby(key: string, n: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** 记账落点(Store 满足此接口) */
export interface UsageSink {
  insertLlmUsage(row: LlmUsageInput): Promise<void>;
}

export interface LlmGatewayOptions {
  client: LlmClient;
  kv: LlmKv;
  usage: UsageSink;
  prices: PriceTable;
  /** 全站日预算(美分),DAILY_LLM_BUDGET_CENTS */
  dailyBudgetCents: number;
  /** 单任务预算(美分),D2 = 30;只约束带 taskId 的调用 */
  taskBudgetCents?: number;
  /** key 前缀,测试/共用 Redis 时隔离用 */
  keyPrefix?: string;
  now?: () => Date;
}

const CENT = 10_000; // micro-USD

/** 缓存 key 的 hash:模型 + 影响输出的全部请求字段 */
export function cacheHash(req: LlmCall): string {
  const body = JSON.stringify({
    m: req.messages,
    t: req.maxTokens ?? null,
    temp: req.temperature ?? null,
    j: req.json ?? false,
  });
  return createHash('sha256').update(`${req.model}\n${body}`).digest('hex');
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** 解析缓存内容;内容损坏或结构不对时返回 null,按未命中处理(之后的成功调用会覆盖它) */
export function parseCached(raw: string | null): LlmCallResult | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LlmCallResult> | null;
    if (
      v &&
      typeof v.text === 'string' &&
      v.usage &&
      isCount(v.usage.tokensIn) &&
      isCount(v.usage.tokensOut)
    ) {
      return { text: v.text, usage: { tokensIn: v.usage.tokensIn, tokensOut: v.usage.tokensOut } };
    }
  } catch {
    // 损坏的 JSON:当作未命中
  }
  return null;
}

/**
 * 统一 LLM 网关(BACKEND_AI_DESIGN §7):缓存 → 预算检查 → 调用 → 记账。
 * - 缓存命中不检查预算、不计花费,但记一条 cache_hit=1 的 llm_usage。
 * - 缓存内容损坏(非 JSON 或缺字段)按未命中处理,正常走预算检查和调用,成功后覆盖。
 * - dailyBudgetCents = 0 表示禁止一切模型调用(只允许缓存命中);taskBudgetCents = 0 同理只作用于带 taskId 的调用。
 * - 预算超限抛 LlmError('BUDGET_EXCEEDED'),不调用模型、不写 llm_usage。
 * - 模型调用失败写 ok=0 的 llm_usage,抛 LlmError('LLM_UNAVAILABLE');重试与规则降级由调用方(T-211)决定。
 * 预算是「调用前检查、调用后累加」,并发时最多超出(并发数 - 1)次调用的花费。
 */
export class LlmGateway {
  constructor(private readonly o: LlmGatewayOptions) {}

  private k(key: string) {
    return `${this.o.keyPrefix ?? ''}${key}`;
  }

  /** 当日已花费(micro-USD) */
  async spentToday(): Promise<number> {
    return Number((await this.o.kv.get(this.k(redisKeys.llmSpendDay(this.now())))) ?? 0);
  }

  async spentByTask(taskId: number): Promise<number> {
    return Number((await this.o.kv.get(this.k(redisKeys.llmSpendTask(taskId)))) ?? 0);
  }

  private now() {
    return this.o.now?.() ?? new Date();
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const { purpose, repoId, taskId, sessionId, ...call } = req;
    const price = priceOf(this.o.prices, call.model); // 先校验价格,未知模型直接拒绝
    const owner = { purpose, model: call.model, repoId, taskId, sessionId };
    const cacheKey = this.k(redisKeys.llmCache(cacheHash(call)));

    const hit = parseCached(await this.o.kv.get(cacheKey));
    if (hit) {
      await this.o.usage.insertLlmUsage({
        ...owner,
        ...hit.usage,
        costMicroUsd: 0,
        cacheHit: true,
        ok: true,
      });
      return { ...hit, model: call.model, costMicroUsd: 0, cacheHit: true };
    }

    await this.checkBudget(taskId);
    // 已取消就不再发请求(也不写 llm_usage)
    if (call.signal?.aborted) {
      throw new LlmError('LLM_UNAVAILABLE', 'LLM 调用已取消', undefined, {
        cause: call.signal.reason,
      });
    }

    let res;
    try {
      res = await this.o.client.call(call);
    } catch (err) {
      await this.o.usage.insertLlmUsage({
        ...owner,
        tokensIn: 0,
        tokensOut: 0,
        costMicroUsd: 0,
        cacheHit: false,
        ok: false,
      });
      throw new LlmError('LLM_UNAVAILABLE', `LLM 调用失败(${this.o.client.provider})`, undefined, {
        cause: err,
      });
    }

    // 每次底层调用最多记账一次:被取消的调用在 catch 分支记 ok=0、花费 0;
    // 客户端无视 signal 迟到返回时,token 已真实消耗,这里照常记这一次(调用方已放弃结果,不会再记第二次)
    // 按真实 usage 记账;缓存命中的输入 token(provider 侧上下文缓存)按缓存价计
    const cost = costMicroUsd(
      price,
      res.usage.tokensIn,
      res.usage.tokensOut,
      res.usage.cachedTokensIn ?? 0,
    );
    await this.addSpend(cost, taskId);
    await this.o.usage.insertLlmUsage({
      ...owner,
      tokensIn: res.usage.tokensIn,
      tokensOut: res.usage.tokensOut,
      costMicroUsd: cost,
      cacheHit: false,
      ok: true,
    });
    await this.o.kv.set(
      cacheKey,
      JSON.stringify({
        text: res.text,
        usage: { tokensIn: res.usage.tokensIn, tokensOut: res.usage.tokensOut },
      }),
      'EX',
      LLM_CACHE_TTL_S,
    );
    return { ...res, model: call.model, costMicroUsd: cost, cacheHit: false };
  }

  private async checkBudget(taskId?: number) {
    const daily = this.o.dailyBudgetCents * CENT;
    const spent = await this.spentToday();
    if (spent >= daily) {
      throw new LlmError(
        'BUDGET_EXCEEDED',
        `今日 LLM 预算已用完(${(spent / 1e6).toFixed(4)} / ${(daily / 1e6).toFixed(2)} USD)`,
        'daily',
      );
    }
    if (taskId != null && this.o.taskBudgetCents != null) {
      const cap = this.o.taskBudgetCents * CENT;
      const t = await this.spentByTask(taskId);
      if (t >= cap) {
        throw new LlmError(
          'BUDGET_EXCEEDED',
          `本次分析的 LLM 预算已用完(${(t / 1e6).toFixed(4)} / ${(cap / 1e6).toFixed(2)} USD)`,
          'task',
        );
      }
    }
  }

  private async addSpend(cost: number, taskId?: number) {
    if (cost <= 0) return;
    const day = this.k(redisKeys.llmSpendDay(this.now()));
    await this.o.kv.incrby(day, cost);
    await this.o.kv.expire(day, LLM_SPEND_DAY_TTL_S);
    if (taskId != null) {
      const tk = this.k(redisKeys.llmSpendTask(taskId));
      await this.o.kv.incrby(tk, cost);
      await this.o.kv.expire(tk, LLM_SPEND_TASK_TTL_S);
    }
  }
}
