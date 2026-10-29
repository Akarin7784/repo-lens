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
  type LlmStreamChunk,
  type LlmUsage,
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
  /** 告警日志(不传则用 console.warn);只记归属与 token 数,不含正文 */
  log?: { warn(obj: object, msg: string): void };
}

const CENT = 10_000; // micro-USD

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
      // 命中行只做审计:写库失败只 warn、照常返回命中结果(不花钱,不该让调用方重试再调模型)
      try {
        await this.o.usage.insertLlmUsage({
          ...owner,
          ...hit.usage,
          costMicroUsd: 0,
          cacheHit: true,
          ok: true,
        });
      } catch (e) {
        this.warn(
          { ...owner, cacheHit: true, err: errMsg(e) },
          'llm usage cache-hit row write failed',
        );
      }
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
      await this.failRowSafe(owner);
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
    // 与流式路径一致:addSpend 与 insert 都成功才算记过账;任一步抛错包成 LLM_UNAVAILABLE 并补一行 ok=0
    // mark.counted:第一次 INCRBY(日预算)成功即置位;addSpend 部分成功后抛错时补行仍带真实 cost
    const mark = { counted: false };
    try {
      await this.addSpend(cost, taskId, mark);
      await this.o.usage.insertLlmUsage({
        ...owner,
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        costMicroUsd: cost,
        cacheHit: false,
        ok: true,
      });
    } catch (err) {
      await this.failRowSafe(owner, mark.counted ? { ...res.usage, cost } : undefined, err);
      throw new LlmError('LLM_UNAVAILABLE', 'LLM 用量记账失败', undefined, { cause: err });
    }
    // 账已记成功;缓存只是优化,写缓存失败只 warn、照常返回(抛错会让 summarize 重试 → 再调模型再计费)
    try {
      await this.o.kv.set(
        cacheKey,
        JSON.stringify({
          text: res.text,
          usage: { tokensIn: res.usage.tokensIn, tokensOut: res.usage.tokensOut },
        }),
        'EX',
        LLM_CACHE_TTL_S,
      );
    } catch (e) {
      this.warn({ ...owner, err: errMsg(e) }, 'llm cache write failed');
    }
    return { ...res, model: call.model, costMicroUsd: cost, cacheHit: false };
  }

  /**
   * 流式调用(问答终答用):预算检查 → 流式调用 → 按服务商 usage 记账。不读写缓存(问答缓存不在 W3 范围)。
   * - 预算超限抛 LlmError('BUDGET_EXCEEDED'),不调用模型、不写 llm_usage。
   * - 客户端不支持流式抛 LlmError('LLM_UNAVAILABLE')。熔断打开时 cause 为 CircuitOpenError。
   * - 建连失败 / 中途断流 / 没给 usage 就结束:写 ok=0 的 llm_usage,抛 LlmError('LLM_UNAVAILABLE')。
   *   已经吐出的正文不收回,由调用方决定怎么收尾。熔断计数由 BreakerClient 负责。
   * - 用户中止(signal.aborted):写 ok=0、不计花费,抛 LlmError('LLM_UNAVAILABLE', 'LLM 调用已取消')。
   * - usage 带 `estimated`(服务商缺 usage,但 stop + [DONE] 正常结束):记 ok=1、按估算 token 计花费,
   *   打 estimated 告警日志,返回值带 `usageEstimated: true`。
   * - 调用方在 yield 处 it.return():外层 finally 补写一行 ok=0;每次调用恰好一行 llm_usage,不重复。
   * - 正常结束时 generator 的返回值是 LlmResult(text 为全文);输出被 max_tokens 截断时照常记账,返回值带 `truncated: true`。
   */
  async *stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk, LlmResult> {
    const { purpose, repoId, taskId, sessionId, ...call } = req;
    const price = priceOf(this.o.prices, call.model);
    const owner = { purpose, model: call.model, repoId, taskId, sessionId };
    if (!this.o.client.stream)
      throw new LlmError('LLM_UNAVAILABLE', `LLM 客户端不支持流式(${this.o.client.provider})`);
    await this.checkBudget(taskId);
    if (call.signal?.aborted) {
      throw new LlmError('LLM_UNAVAILABLE', 'LLM 调用已取消', undefined, {
        cause: call.signal.reason,
      });
    }
    let text = '';
    let usage: LlmUsage | undefined;
    let truncated = false;
    let estimated = false;
    // 每次调用恰好一行 llm_usage:成功路径在写库成功后置位,catch 写 ok=0 前置位;
    // 调用方在 yield 处 it.return()(如 route 的 finally)、或成功路径 addSpend/insert 抛错时,
    // 由外层 finally 补一行 ok=0。补写失败只打日志,不掩盖原错误、不让 return() 抛错
    let recorded = false;
    // addSpend 已成功(预算已计)但 insert 失败时,补行带真实 cost/token
    let spentRow: { tokensIn: number; tokensOut: number; cost: number } | undefined;
    let bookErr: unknown;
    try {
      try {
        for await (const ev of this.o.client.stream(call)) {
          if (ev.type === 'usage') {
            usage = ev.usage;
            truncated = ev.truncated === true;
            estimated = ev.estimated === true;
          } else if (ev.text) {
            text += ev.text;
            yield { text: ev.text };
          }
        }
        if (call.signal?.aborted) throw call.signal.reason ?? new Error('aborted');
        if (!usage) throw new Error('上游流在 usage 之前结束');
      } catch (err) {
        recorded = true;
        await this.failRowSafe(owner);
        const aborted = call.signal?.aborted === true;
        throw new LlmError(
          'LLM_UNAVAILABLE',
          aborted ? 'LLM 调用已取消' : `LLM 流式调用失败(${this.o.client.provider})`,
          undefined,
          { cause: aborted ? (call.signal?.reason ?? err) : err },
        );
      }

      const cost = costMicroUsd(price, usage.tokensIn, usage.tokensOut, usage.cachedTokensIn ?? 0);
      if (estimated) {
        // llm_usage 没有「估算」列(不加列、不迁移):行照常 ok=1,估算只靠这条告警日志区分
        const w = {
          ...owner,
          estimated: true,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costMicroUsd: cost,
        };
        const msg = 'llm usage estimated: provider sent no usage';
        if (this.o.log) this.o.log.warn(w, msg);
        else console.warn(msg, w);
      }
      const mark = { counted: false };
      try {
        await this.addSpend(cost, taskId, mark);
        await this.o.usage.insertLlmUsage({
          ...owner,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costMicroUsd: cost,
          cacheHit: false,
          ok: true,
        });
        recorded = true;
      } catch (err) {
        // 记账失败:统一成 LlmError;recorded 仍为 false,由 finally 补一行 ok=0
        bookErr = err;
        // 日预算 INCRBY 已成功(哪怕之后 expire/任务预算抛错):补行带真实 cost
        if (mark.counted) spentRow = { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, cost };
        throw new LlmError('LLM_UNAVAILABLE', 'LLM 用量记账失败', undefined, { cause: err });
      }
      return {
        text,
        usage,
        model: call.model,
        costMicroUsd: cost,
        cacheHit: false,
        ...(truncated ? { truncated: true } : {}),
        ...(estimated ? { usageEstimated: true } : {}),
      };
    } finally {
      if (!recorded) {
        recorded = true;
        await this.failRowSafe(owner, spentRow, bookErr);
      }
    }
  }

  /**
   * 补写一行 ok=0 的 llm_usage,自身失败只打 warn(不盖原错误、不让 return() 抛错)。
   * `spent`:addSpend 已成功、但 ok=1 那行没写进去时传入,补行带真实 token 与 cost,
   * 并打一条带 cost 的 warn 便于对账。不会重复计预算:预算只看 Redis `llm:spend:*`(addSpend),
   * llm_usage 只做审计,全仓库没有任何地方把它的 cost 累加回预算(见 BACKEND_AI_DESIGN「记账失败补行」)。
   * 补行自己也失败时,这次花费只留在 Redis 预算计数和这条 warn 日志里,llm_usage 少一行。
   */
  private async failRowSafe(
    owner: Omit<LlmUsageInput, 'tokensIn' | 'tokensOut' | 'costMicroUsd' | 'cacheHit' | 'ok'>,
    spent?: { tokensIn: number; tokensOut: number; cost: number },
    cause?: unknown,
  ) {
    const warn = (w: object, msg: string) => this.warn(w, msg);
    if (spent)
      warn(
        {
          ...owner,
          tokensIn: spent.tokensIn,
          tokensOut: spent.tokensOut,
          costMicroUsd: spent.cost,
          err: errMsg(cause),
        },
        'llm usage insert failed after spend counted',
      );
    try {
      await this.o.usage.insertLlmUsage({
        ...owner,
        tokensIn: spent?.tokensIn ?? 0,
        tokensOut: spent?.tokensOut ?? 0,
        costMicroUsd: spent?.cost ?? 0,
        cacheHit: false,
        ok: false,
      });
    } catch (e) {
      warn(
        { ...owner, costMicroUsd: spent?.cost ?? 0, err: errMsg(e) },
        'llm usage failure row write failed',
      );
    }
  }

  /** 结构化告警:只带归属、token、cost、err.message,不含正文/key/IP */
  private warn(w: object, msg: string) {
    if (this.o.log) this.o.log.warn(w, msg);
    else console.warn(msg, w);
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

  /**
   * 累加 Redis 预算。`mark.counted` 在日预算 INCRBY 成功后立即置位(cost<=0 无需计入,也视为已计入),
   * 之后 expire / 任务预算 INCRBY 抛错时调用方据此知道日预算已扣,补行带真实 cost。
   */
  private async addSpend(cost: number, taskId: number | undefined, mark: { counted: boolean }) {
    if (cost <= 0) {
      mark.counted = true;
      return;
    }
    const day = this.k(redisKeys.llmSpendDay(this.now()));
    await this.o.kv.incrby(day, cost);
    mark.counted = true;
    await this.o.kv.expire(day, LLM_SPEND_DAY_TTL_S);
    if (taskId != null) {
      const tk = this.k(redisKeys.llmSpendTask(taskId));
      await this.o.kv.incrby(tk, cost);
      await this.o.kv.expire(tk, LLM_SPEND_TASK_TTL_S);
    }
  }
}
