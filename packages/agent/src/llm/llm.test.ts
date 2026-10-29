import { randomUUID } from 'node:crypto';
import { MemoryStore } from '@repolens/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLlmConfig, createLlmClient } from './config.js';
import { FakeLlm } from './fake.js';
import { LlmGateway, cacheHash, type LlmKv } from './gateway.js';
import {
  DEFAULT_PRICES,
  costMicroUsd,
  UnknownModelPriceError,
  type PriceTable,
} from './pricing.js';
import { LlmError, type LlmRequest } from './types.js';
import { onServiceUnavailable } from '@repolens/shared';

/** 内存 KV(CI 无 Redis 时也能跑);TTL 只记录不过期 */
class MemKv implements LlmKv {
  m = new Map<string, string>();
  ttl = new Map<string, number>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string, _mode: 'EX', s: number) {
    this.m.set(k, v);
    this.ttl.set(k, s);
    return 'OK';
  }
  async incrby(k: string, n: number) {
    const v = Number(this.m.get(k) ?? 0) + n;
    this.m.set(k, String(v));
    return v;
  }
  async expire(k: string, s: number) {
    this.ttl.set(k, s);
    return 1;
  }
}

// 测试价格:每 token 1 micro-USD(进出同价),便于算预算
const PRICES: PriceTable = {
  ...DEFAULT_PRICES,
  'test-model': { inputPerMTok: 1, outputPerMTok: 1 },
};
const req = (content: string, extra: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'test-model',
  messages: [{ role: 'user', content }],
  purpose: 'summary',
  repoId: 1,
  taskId: 11,
  ...extra,
});

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/5'; // 测试 Redis 库号占用表:api app=1, agent llm=5, worker embed-lock=6, worker queue.int=7, worker test-utils=8;保留不用:0/9/10、11(#108 route.test)、13(本地全量)
const redisOk = await (async () => {
  const r = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
  });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
})();
if (!redisOk)
  onServiceUnavailable('Redis', `[agent] Redis 不可达(${REDIS_URL}),跳过真实 Redis 网关测试`);

function suite(
  name: string,
  makeKv: () => Promise<{ kv: LlmKv; cleanup: () => Promise<void> }>,
  enabled = true,
) {
  describe.skipIf(!enabled)(name, () => {
    let kv: LlmKv;
    let cleanup: () => Promise<void>;
    let prefix: string;
    beforeAll(async () => {
      ({ kv, cleanup } = await makeKv());
    });
    afterAll(async () => cleanup?.());

    const make = (o: { daily?: number; task?: number; fake?: FakeLlm; now?: () => Date } = {}) => {
      prefix = `rl-dev-t210:${randomUUID()}:`;
      const client = o.fake ?? new FakeLlm();
      const usage = new MemoryStore();
      const gw = new LlmGateway({
        client,
        kv,
        usage,
        prices: PRICES,
        dailyBudgetCents: o.daily ?? 500,
        taskBudgetCents: o.task,
        keyPrefix: prefix,
        now: o.now ?? (() => new Date('2026-10-29T05:00:00Z')),
      });
      return { gw, client, usage };
    };

    it('首次调用模型并记账,同样请求第二次命中缓存:不调模型、费用 0、记 cache_hit', async () => {
      const { gw, client, usage } = make();
      const a = await gw.complete(req('hello'));
      expect(a.cacheHit).toBe(false);
      expect(a.costMicroUsd).toBe(a.usage.tokensIn + a.usage.tokensOut);
      const b = await gw.complete(req('hello'));
      expect(b).toMatchObject({ text: a.text, usage: a.usage, cacheHit: true, costMicroUsd: 0 });
      expect(client.calls).toBe(1);
      const rows = await usage.llmUsageByTask(11);
      expect(rows.map((r) => [r.cacheHit, r.ok, r.costMicroUsd])).toEqual([
        [false, true, a.costMicroUsd],
        [true, true, 0],
      ]);
      expect(await gw.spentToday()).toBe(a.costMicroUsd);
      expect(await gw.spentByTask(11)).toBe(a.costMicroUsd);
      // 缓存 key 带前缀且 TTL 30 天
      expect(await kv.get(`${prefix}llm:${cacheHash(req('hello'))}`)).not.toBeNull();
    });

    it('请求内容、模型或参数不同不会串缓存', async () => {
      const { gw, client } = make();
      await gw.complete(req('x'));
      await gw.complete(req('x', { maxTokens: 50 }));
      await gw.complete(req('x', { json: true }));
      await gw.complete(req('x', { model: 'gpt-4o-mini' }));
      expect(client.calls).toBe(4);
    });

    it('日预算用完抛 BUDGET_EXCEEDED(scope=daily),不调模型、不记账;缓存命中仍可用', async () => {
      const { gw, client, usage } = make({ daily: 0 });
      await expect(gw.complete(req('a'))).rejects.toMatchObject({
        code: 'BUDGET_EXCEEDED',
        scope: 'daily',
      });
      expect(client.calls).toBe(0);
      expect(await usage.llmUsageByTask(11)).toEqual([]);
    });

    it('日预算跨过上限后下一次调用被拦', async () => {
      // 1 美分 = 10000 micro-USD;每次约 4~10 token,放大 maxTokens 无用,改用大 prompt
      const { gw, client } = make({ daily: 1 });
      const big = 'x'.repeat(4 * 6000); // ≈6000 token 输入 → ≈6000+ micro-USD
      await gw.complete(req(big + '1'));
      await gw.complete(req(big + '2')); // 调用前 ~6000 < 10000,放行;之后 >10000
      const err = await gw.complete(req(big + '3')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(err).toMatchObject({ code: 'BUDGET_EXCEEDED', scope: 'daily' });
      expect(client.calls).toBe(2);
      // 已缓存的请求不受预算影响
      expect((await gw.complete(req(big + '1'))).cacheHit).toBe(true);
    });

    it('单任务预算(D2)只拦本任务,其他任务与无 taskId 调用不受影响', async () => {
      const { gw } = make({ task: 1 });
      const big = 'y'.repeat(4 * 11000);
      await gw.complete(req(big));
      await expect(gw.complete(req('next'))).rejects.toMatchObject({
        code: 'BUDGET_EXCEEDED',
        scope: 'task',
      });
      await expect(gw.complete(req('next', { taskId: 12 }))).resolves.toMatchObject({
        cacheHit: false,
      });
      await expect(
        gw.complete(req('next', { taskId: undefined, purpose: 'chat' })),
      ).resolves.toBeTruthy();
    });

    it('模型失败:记 ok=0、抛 LLM_UNAVAILABLE、不写缓存不计费', async () => {
      const fake = new FakeLlm({ fail: (r) => r.messages[0]!.content === 'boom' });
      const { gw, usage } = make({ fake });
      const err = await gw.complete(req('boom')).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect((err as Error).cause).toBeInstanceOf(Error);
      expect((await usage.llmUsageByTask(11)).map((r) => r.ok)).toEqual([false]);
      expect(await gw.spentToday()).toBe(0);
      expect(await kv.get(`${prefix}llm:${cacheHash(req('boom'))}`)).toBeNull();
    });

    it('缓存内容损坏时降级为未命中:照常调用模型并覆盖缓存', async () => {
      const { gw, client, usage } = make();
      const key = `${prefix}llm:${cacheHash(req('c'))}`;
      for (const bad of [
        '{not json',
        '"str"',
        'null',
        '{"text":1}',
        '{"text":"t","usage":{"tokensIn":-1,"tokensOut":0}}',
      ]) {
        await kv.set(key, bad, 'EX', 60);
        const r = await gw.complete(req('c'));
        expect(r.cacheHit).toBe(false);
      }
      expect(client.calls).toBe(5);
      expect((await usage.llmUsageByTask(11)).every((u) => !u.cacheHit)).toBe(true);
      // 最后一次成功调用已把缓存覆盖为合法内容
      expect((await gw.complete(req('c'))).cacheHit).toBe(true);
      expect(client.calls).toBe(5);
    });

    it('过 UTC 零点后日预算恢复(按 UTC 自然日换 key)', async () => {
      let t = new Date('2026-10-29T23:59:59.000Z'); // 北京时间 10-30 07:59:59,仍属 UTC 10-29
      const { gw, client } = make({ daily: 1, now: () => t });
      const big = 'z'.repeat(4 * 11000);
      await gw.complete(req(big));
      await expect(gw.complete(req('after'))).rejects.toMatchObject({
        code: 'BUDGET_EXCEEDED',
        scope: 'daily',
      });
      t = new Date('2026-10-30T00:00:00.000Z');
      expect(await gw.spentToday()).toBe(0);
      await expect(gw.complete(req('after'))).resolves.toMatchObject({ cacheHit: false });
      expect(client.calls).toBe(2);
      // 前一天的计数仍在(TTL 2 天),不受影响
      expect(Number(await kv.get(`${prefix}llm:spend:day:20261029`))).toBeGreaterThanOrEqual(
        10_000,
      );
    });

    it('dailyBudgetCents=0 表示禁止调用,只允许缓存命中', async () => {
      const { gw, client } = make({ daily: 0 });
      await expect(gw.complete(req('new'))).rejects.toMatchObject({
        code: 'BUDGET_EXCEEDED',
        scope: 'daily',
      });
      const cached = JSON.stringify({ text: 'old', usage: { tokensIn: 3, tokensOut: 2 } });
      await kv.set(`${prefix}llm:${cacheHash(req('old'))}`, cached, 'EX', 60);
      await expect(gw.complete(req('old'))).resolves.toMatchObject({
        text: 'old',
        cacheHit: true,
        costMicroUsd: 0,
      });
      expect(client.calls).toBe(0);
    });

    it('未知模型没有价格,拒绝调用', async () => {
      const { gw, client } = make();
      await expect(gw.complete(req('a', { model: 'nope' }))).rejects.toBeInstanceOf(
        UnknownModelPriceError,
      );
      expect(client.calls).toBe(0);
    });
  });
}

suite('LlmGateway(内存 KV)', async () => ({ kv: new MemKv(), cleanup: async () => {} }));
suite(
  'LlmGateway(真实 Redis,独立库号 + rl-dev-t210: 前缀)',
  async () => {
    const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    return {
      kv: r,
      cleanup: async () => {
        const keys = await r.keys('rl-dev-t210:*');
        if (keys.length) await r.del(...keys);
        await r.quit();
      },
    };
  },
  redisOk,
);

describe('FakeLlm', () => {
  it('确定性:同请求同输出,不同请求不同输出;json 模式可解析', async () => {
    const f = new FakeLlm();
    const r = { model: 'fake', messages: [{ role: 'user' as const, content: 'abc' }] };
    expect(await f.call(r)).toEqual(await new FakeLlm().call(r));
    expect((await f.call({ ...r, messages: [{ role: 'user', content: 'abd' }] })).text).not.toBe(
      (await f.call(r)).text,
    );
    const j = JSON.parse((await f.call({ ...r, json: true })).text) as { summary: string };
    expect(j.summary).toMatch(/^fake summary /);
    expect((await f.call({ ...r, maxTokens: 1 })).usage.tokensOut).toBe(1);
  });
});

describe('pricing', () => {
  it('按每百万 token 美元计价,向上取整为 micro-USD', () => {
    expect(costMicroUsd(DEFAULT_PRICES['gpt-4o-mini']!, 1000, 100)).toBe(210);
    expect(costMicroUsd(DEFAULT_PRICES['gpt-4o-mini']!, 1, 0)).toBe(1);
    expect(costMicroUsd(DEFAULT_PRICES.fake!, 1000, 1000)).toBe(0);
  });
});

describe('readLlmConfig', () => {
  it('默认 fake、日预算 500 美分、任务预算 30 美分,不需要 key', () => {
    const c = readLlmConfig({});
    expect(c).toMatchObject({ provider: 'fake', dailyBudgetCents: 500, taskBudgetCents: 30 });
    expect(createLlmClient(c)).toBeInstanceOf(FakeLlm);
  });
  it('读取预算环境变量并校验', () => {
    expect(
      readLlmConfig({ DAILY_LLM_BUDGET_CENTS: '0', LLM_TASK_BUDGET_CENTS: ' 50 ' }),
    ).toMatchObject({
      dailyBudgetCents: 0,
      taskBudgetCents: 50,
    });
    expect(() => readLlmConfig({ DAILY_LLM_BUDGET_CENTS: '-1' })).toThrow(/DAILY_LLM_BUDGET_CENTS/);
    expect(() => readLlmConfig({ DAILY_LLM_BUDGET_CENTS: '5.5' })).toThrow(
      /DAILY_LLM_BUDGET_CENTS/,
    );
  });
  it('未知 provider 显式报错而不是悄悄用 fake', () => {
    expect(() => readLlmConfig({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' })).toThrow(
      /LLM_PROVIDER/,
    );
  });
});

describe('complete() 记账失败(与流式路径对齐)', () => {
  const boom = new Error('db down');
  function setup(o: { insertFails?: (row: { ok: boolean }) => boolean; kvFails?: boolean } = {}) {
    const kv = new MemKv();
    if (o.kvFails)
      kv.incrby = async () => {
        throw boom;
      };
    const usage = new MemoryStore();
    const orig = usage.insertLlmUsage.bind(usage);
    let inserts = 0;
    usage.insertLlmUsage = async (row) => {
      inserts++;
      if (o.insertFails?.(row)) throw boom;
      return orig(row);
    };
    const warns: { obj: Record<string, unknown>; msg: string }[] = [];
    const gw = new LlmGateway({
      client: new FakeLlm(),
      kv,
      usage,
      prices: PRICES,
      dailyBudgetCents: 500,
      now: () => new Date('2026-10-29T05:00:00Z'),
      log: { warn: (obj, msg) => warns.push({ obj: obj as Record<string, unknown>, msg }) },
    });
    return { gw, usage, warns, inserts: () => inserts };
  }

  it('成功路径:恰好一行 ok=1、预算只计一次;缓存命中不再计费', async () => {
    const { gw, usage, warns } = setup();
    const r = await gw.complete(req('hello'));
    expect(r.costMicroUsd).toBeGreaterThan(0);
    const rows = await usage.llmUsageByTask(11);
    expect(rows.map((x) => [x.ok, x.costMicroUsd])).toEqual([[true, r.costMicroUsd]]);
    expect(await gw.spentToday()).toBe(r.costMicroUsd);
    await gw.complete(req('hello'));
    expect(await gw.spentToday()).toBe(r.costMicroUsd);
    expect(warns).toEqual([]);
  });

  it('addSpend 成功、insert 抛错:LlmError(LLM_UNAVAILABLE, cause=原错误),补一行 ok=0 带真实 cost,warn 带 cost', async () => {
    const { gw, usage, warns } = setup({ insertFails: (row) => row.ok });
    const err = (await gw.complete(req('hello')).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.cause).toBe(boom);
    const spent = await gw.spentToday();
    expect(spent).toBeGreaterThan(0);
    const rows = await usage.llmUsageByTask(11);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, costMicroUsd: spent });
    expect(rows[0]!.tokensIn).toBeGreaterThan(0);
    expect(warns.map((w) => w.msg)).toEqual(['llm usage insert failed after spend counted']);
    expect(warns[0]!.obj).toMatchObject({ costMicroUsd: spent });
  });

  it('insert 与补行都抛错:仍抛原错误包成的 LlmError,不被补行错误盖掉,只打 warn', async () => {
    const { gw, usage, warns, inserts } = setup({ insertFails: () => true });
    const err = (await gw.complete(req('hello')).catch((e: unknown) => e)) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.message).toBe('LLM 用量记账失败');
    expect(err.cause).toBe(boom);
    expect(inserts()).toBe(2);
    expect(await usage.llmUsageByTask(11)).toEqual([]);
    expect(warns.map((w) => w.msg)).toEqual([
      'llm usage insert failed after spend counted',
      'llm usage failure row write failed',
    ]);
    expect(warns[1]!.obj.costMicroUsd).toBe(await gw.spentToday());
  });

  it('addSpend 自己抛错:LlmError,补行 ok=0 cost 0(预算未计)', async () => {
    const { gw, usage, warns } = setup({ kvFails: true });
    const err = (await gw.complete(req('hello')).catch((e: unknown) => e)) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.cause).toBe(boom);
    expect((await usage.llmUsageByTask(11)).map((x) => [x.ok, x.costMicroUsd])).toEqual([
      [false, 0],
    ]);
    expect(warns).toEqual([]);
  });

  it('记账成功后写缓存抛错:只 warn,照常返回结果,不抛;只一行 ok=1、预算只计一次', async () => {
    const { gw, usage, warns } = setup();
    const kv = (gw as unknown as { o: { kv: MemKv } }).o.kv;
    kv.set = async () => {
      throw new Error('redis set down');
    };
    const r = await gw.complete(req('hello'));
    expect(r.cacheHit).toBe(false);
    expect(r.costMicroUsd).toBeGreaterThan(0);
    expect((await usage.llmUsageByTask(11)).map((x) => [x.ok, x.costMicroUsd])).toEqual([
      [true, r.costMicroUsd],
    ]);
    expect(await gw.spentToday()).toBe(r.costMicroUsd);
    expect(warns.map((w) => w.msg)).toEqual(['llm cache write failed']);
    expect(warns[0]!.obj).toMatchObject({ purpose: 'summary', err: 'redis set down' });
    expect(JSON.stringify(warns[0]!.obj)).not.toContain('hello');
  });

  it('缓存命中时写命中行抛错:只 warn,照常返回命中结果', async () => {
    const { gw, warns } = setup({
      insertFails: (row) => (row as { cacheHit?: boolean }).cacheHit === true,
    });
    const first = await gw.complete(req('hello'));
    const r = await gw.complete(req('hello'));
    expect(r).toMatchObject({ cacheHit: true, costMicroUsd: 0, text: first.text });
    expect(await gw.spentToday()).toBe(first.costMicroUsd);
    expect(warns.map((w) => w.msg)).toEqual(['llm usage cache-hit row write failed']);
    expect(JSON.stringify(warns[0]!.obj)).not.toContain('hello');
  });

  it('cost=0(零价模型)时 insert 抛错:视为已计入,补行带真实 token、cost 0', async () => {
    const { gw, usage, warns } = setup({ insertFails: (row) => row.ok });
    (gw as unknown as { o: { prices: PriceTable } }).o.prices = {
      ...PRICES,
      'zero-model': { inputPerMTok: 0, outputPerMTok: 0 },
    };
    const err = (await gw
      .complete(req('hello', { model: 'zero-model' }))
      .catch((e: unknown) => e)) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    const rows = await usage.llmUsageByTask(11);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, costMicroUsd: 0 });
    expect(rows[0]!.tokensIn).toBeGreaterThan(0);
    expect(warns.map((w) => w.msg)).toEqual(['llm usage insert failed after spend counted']);
  });

  for (const stage of ['expire', 'task-incrby'] as const) {
    it(`addSpend 部分成功(日预算 INCRBY 后 ${stage} 抛错):LlmError,补行带真实 cost`, async () => {
      const { gw, usage, warns } = setup();
      const kv = (gw as unknown as { o: { kv: MemKv } }).o.kv;
      const boom = new Error('redis partial');
      if (stage === 'expire')
        kv.expire = async () => {
          throw boom;
        };
      else {
        const orig = kv.incrby.bind(kv);
        kv.incrby = async (k, n) => {
          if (k.includes('task')) throw boom;
          return orig(k, n);
        };
      }
      const err = (await gw.complete(req('hello')).catch((e: unknown) => e)) as LlmError;
      expect(err.code).toBe('LLM_UNAVAILABLE');
      expect(err.cause).toBe(boom);
      const spent = await gw.spentToday();
      expect(spent).toBeGreaterThan(0);
      const rows = await usage.llmUsageByTask(11);
      expect(rows.map((x) => [x.ok, x.costMicroUsd])).toEqual([[false, spent]]);
      expect(warns.map((w) => w.msg)).toEqual(['llm usage insert failed after spend counted']);
    });
  }

  it('模型失败时补行也抛错:仍抛 LLM 调用失败,不被盖掉', async () => {
    const { gw, warns } = setup({ insertFails: () => true });
    (gw as unknown as { o: { client: FakeLlm } }).o.client = new FakeLlm({ fail: () => true });
    const err = (await gw.complete(req('x')).catch((e: unknown) => e)) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.message).toContain('LLM 调用失败');
    expect(warns.map((w) => w.msg)).toEqual(['llm usage failure row write failed']);
  });
});
