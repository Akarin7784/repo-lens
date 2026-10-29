import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '@repolens/db';
import { describe, expect, it } from 'vitest';
import { BreakerClient } from '../llm/breaker.js';
import { LlmGateway } from '../llm/gateway.js';
import { MemoryLlmKv } from '../llm/memory-kv.js';
import { DEFAULT_PRICES, type PriceTable } from '../llm/pricing.js';
import type { LlmCall, LlmClient } from '../llm/types.js';
import {
  REWRITE_PROMPT_VERSION,
  REWRITE_SYSTEM,
  rewriteCacheKey,
  rewriteQuery,
  stripFileNames,
  type RewriteLog,
} from './rewrite.js';

class StubLlm implements LlmClient {
  readonly provider = 'stub';
  calls = 0;
  constructor(private readonly reply: (req: LlmCall) => string) {}
  async call(req: LlmCall) {
    this.calls++;
    return { text: this.reply(req), usage: { tokensIn: 100, tokensOut: 10 } };
  }
}
const PRICES: PriceTable = { ...DEFAULT_PRICES, m: { inputPerMTok: 1, outputPerMTok: 1 } };
function gw(client: LlmClient, dailyBudgetCents = 1000) {
  return new LlmGateway({
    client,
    kv: new MemoryLlmKv(),
    usage: new MemoryStore(),
    prices: PRICES,
    dailyBudgetCents,
  });
}

describe('查询改写 rewriteQuery(T-214)', () => {
  it('中文问题改写成英文并记录前后;同问题第二次命中缓存不再调用模型', async () => {
    const llm = new StubLlm(() => 'A: database pool createPool\nextra');
    const g = gw(llm);
    const logs: RewriteLog[] = [];
    const q = '连接池在哪里?';
    expect(await rewriteQuery(q, { gateway: g, model: 'm', log: (l) => logs.push(l) })).toBe(
      'database pool createPool',
    );
    await rewriteQuery(q, { gateway: g, model: 'm', log: (l) => logs.push(l) });
    expect(llm.calls).toBe(1);
    expect(logs[0]).toMatchObject({
      original: q,
      rewritten: 'database pool createPool',
      used: true,
    });
    expect(logs[1]).toMatchObject({ used: true, cacheHit: true, costMicroUsd: 0 });
  });

  it('非中文问题不调用模型,原样返回', async () => {
    const llm = new StubLlm(() => 'x');
    const logs: RewriteLog[] = [];
    expect(
      await rewriteQuery('where is X', { gateway: gw(llm), model: 'm', log: (l) => logs.push(l) }),
    ).toBe('where is X');
    expect(llm.calls).toBe(0);
    expect(logs[0]?.reason).toBe('not-chinese');
  });

  it('调用失败、超预算、熔断打开、输出为空或仍是中文时回退原问题且不抛错', async () => {
    const q = '参数怎么解析?';
    const cases: [LlmClient, string, number?][] = [
      [{ provider: 'x', call: async () => Promise.reject(new Error('boom')) }, 'unavailable'],
      [new StubLlm(() => 'ok words'), 'budget', 0],
      [new StubLlm(() => '   '), 'empty'],
      [new StubLlm(() => '仍然是中文'), 'empty'],
    ];
    for (const [client, reason, budget] of cases) {
      const logs: RewriteLog[] = [];
      const out = await rewriteQuery(q, {
        gateway: gw(client, budget ?? 1000),
        model: 'm',
        log: (l) => logs.push(l),
      });
      expect(out).toBe(q);
      expect(logs[0]).toMatchObject({ original: q, rewritten: q, used: false, reason });
    }
    // 熔断打开:BreakerClient 抛 CircuitOpenError,网关包成 LLM_UNAVAILABLE(cause)
    const kv = new MemoryLlmKv();
    const inner = new StubLlm(() => 'never');
    const br = new BreakerClient(inner, kv, { failures: 1 });
    await kv.set('cb:llm:stub', '1');
    const logs: RewriteLog[] = [];
    expect(await rewriteQuery(q, { gateway: gw(br), model: 'm', log: (l) => logs.push(l) })).toBe(
      q,
    );
    expect(inner.calls).toBe(0);
    expect(logs[0]?.reason).toBe('breaker');
  });

  it('提示词与示例不含留出集题目原话、中文关键词组合及 request body、set/get', () => {
    const holdout = readFileSync(
      fileURLToPath(new URL('../../../../docs/RAG_HOLDOUT.md', import.meta.url)),
      'utf8',
    );
    const questions = [...holdout.matchAll(/^\| (?:H\d|S1) \| ([^|]+) \|/gm)].map((m) =>
      m[1]!.trim(),
    );
    expect(questions.length).toBe(9);
    for (const q of questions) {
      expect(REWRITE_SYSTEM).not.toContain(q);
      // 任意相邻两个中文字的组合都不得出现在提示词里
      const cjk = q.replace(/[^\u3400-\u9fff]/g, '');
      for (let i = 0; i + 2 <= cjk.length; i++) {
        const bi = cjk.slice(i, i + 2);
        if (['怎么', '如何', '哪个', '哪里', '是什'].includes(bi)) continue; // 通用疑问词
        expect(REWRITE_SYSTEM, bi).not.toContain(bi);
      }
    }
    for (const w of ['request body', 'set/get', 'middleware', 'context', 'csrf', 'router'])
      expect(REWRITE_SYSTEM.toLowerCase()).not.toContain(w);
  });

  it('提示词不引导输出文件名:规则禁止,示例答案不含文件名;版本为 rw-2', () => {
    expect(REWRITE_PROMPT_VERSION).toBe('rw-2');
    expect(REWRITE_SYSTEM).toMatch(/Never output file names/);
    for (const l of REWRITE_SYSTEM.split('\n').filter((x) => x.startsWith('Q:')))
      expect(l.split(' A: ')[1]).not.toMatch(/\.[cm]?[jt]sx?\b|\//);
  });

  it('模型仍输出文件名时后处理去掉,标识符保留', async () => {
    expect(stripFileNames('pool create pool.ts src/db/conn.js createPool')).toBe(
      'pool create createPool',
    );
    const g = gw(new StubLlm(() => 'queue worker job.ts enqueue'));
    expect(await rewriteQuery('队列在哪?', { gateway: g, model: 'm' })).toBe(
      'queue worker enqueue',
    );
  });

  it('温度固定 0;按「问题 + 提示词版本」缓存,换网关(无网关缓存)两次改写也一致且只调一次模型', async () => {
    let n = 0;
    const temps: (number | undefined)[] = [];
    const llm = new StubLlm((req) => {
      temps.push(req.temperature);
      return `queue run${++n}`;
    });
    const store = new Map<string, string>();
    const cache = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
    };
    const q = '队列怎么消费?';
    const a = await rewriteQuery(q, { gateway: gw(llm), model: 'm', cache });
    const logs: RewriteLog[] = [];
    const b = await rewriteQuery(`  ${q} `, {
      gateway: gw(llm),
      model: 'm',
      cache,
      log: (l) => logs.push(l),
    });
    expect([a, b, llm.calls, temps]).toEqual(['queue run1', 'queue run1', 1, [0]]);
    expect(logs[0]).toMatchObject({ cacheHit: true, used: true });
    expect([...store.keys()]).toEqual([rewriteCacheKey(q, 'm')]);
    expect(rewriteCacheKey(q, 'm')).toContain(`:${REWRITE_PROMPT_VERSION}:`);
    expect(rewriteCacheKey(q, 'm')).not.toBe(rewriteCacheKey(q, 'other'));
  });

  it('回退原问题的结果不写缓存', async () => {
    const store = new Map<string, string>();
    const cache = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
    };
    await rewriteQuery('队列在哪?', { gateway: gw(new StubLlm(() => '')), model: 'm', cache });
    expect(store.size).toBe(0);
  });
});
