import { MemoryStore } from '@repolens/db';
import { describe, expect, it } from 'vitest';
import { BreakerClient, CircuitOpenError } from './breaker.js';
import { FakeLlm, estimateTokens } from './fake.js';
import { LlmGateway } from './gateway.js';
import { MemoryLlmKv } from './memory-kv.js';
import { DEFAULT_PRICES, type PriceTable } from './pricing.js';
import {
  LlmError,
  type LlmCall,
  type LlmClient,
  type LlmRequest,
  type LlmStreamEvent,
} from './types.js';

const PRICES: PriceTable = {
  ...DEFAULT_PRICES,
  'test-model': { inputPerMTok: 1, outputPerMTok: 1 },
};
const req = (extra: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'test-model',
  messages: [{ role: 'user', content: '中间件怎么串联?' }],
  purpose: 'chat',
  repoId: 1,
  sessionId: 7,
  ...extra,
});

function make(o: { inner?: LlmClient; daily?: number; failures?: number } = {}) {
  const kv = new MemoryLlmKv();
  const inner = o.inner ?? new FakeLlm({ streamText: () => 'abcdefghijklmnopqrstuvwxyz' });
  const client = new BreakerClient(inner, kv, { failures: o.failures ?? 2 });
  const usage = new MemoryStore();
  const gw = new LlmGateway({
    client,
    kv,
    usage,
    prices: PRICES,
    dailyBudgetCents: o.daily ?? 500,
    now: () => new Date('2026-10-29T10:00:00Z'),
  });
  const fails = () => Number(kv.m.get(`cb:llm:${inner.provider}:fails`) ?? 0);
  const open = () => kv.m.has(`cb:llm:${inner.provider}`);
  const rows = () =>
    (
      usage as unknown as {
        usage: {
          ok: boolean;
          costMicroUsd: number;
          purpose: string;
          sessionId: number | null;
          tokensOut: number;
        }[];
      }
    ).usage;
  return { gw, kv, inner, usage, fails, open, rows };
}

async function drain(g: AsyncGenerator<{ text: string }, unknown>, onChunk?: (n: number) => void) {
  const texts: string[] = [];
  let r = await g.next();
  while (!r.done) {
    texts.push(r.value.text);
    onChunk?.(texts.length);
    r = await g.next();
  }
  return { texts, result: r.value };
}

describe('FakeLlm.stream', () => {
  it('按 chunkSize 切分,最后给估算 usage', async () => {
    const f = new FakeLlm({ streamText: () => 'hello world!', chunkSize: 5 });
    const evs: LlmStreamEvent[] = [];
    for await (const e of f.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] }))
      evs.push(e);
    expect(evs).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' worl' },
      { type: 'text', text: 'd!' },
      {
        type: 'usage',
        usage: { tokensIn: estimateTokens('user:q'), tokensOut: estimateTokens('hello world!') },
      },
    ]);
  });
  it('默认文本确定性', async () => {
    const call: LlmCall = { model: 'm', messages: [{ role: 'user', content: 'q' }] };
    const collect = async () => {
      let t = '';
      for await (const e of new FakeLlm().stream(call)) if (e.type === 'text') t += e.text;
      return t;
    };
    expect(await collect()).toBe(await collect());
    expect(await collect()).toMatch(/^fake response [0-9a-f]{12}$/);
  });
});

describe('LlmGateway.stream', () => {
  it('正常:逐段输出,按 usage 计费并写 ok=1 的 chat 用量', async () => {
    const { gw, rows, fails } = make();
    const { texts, result } = await drain(gw.stream(req()));
    expect(texts.join('')).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(texts.length).toBeGreaterThan(1);
    const r = result as {
      text: string;
      costMicroUsd: number;
      cacheHit: boolean;
      usage: { tokensOut: number };
    };
    expect(r.text).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(r.cacheHit).toBe(false);
    expect(r.usage.tokensOut).toBe(estimateTokens('abcdefghijklmnopqrstuvwxyz'));
    expect(await gw.spentToday()).toBe(r.costMicroUsd);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      ok: true,
      purpose: 'chat',
      sessionId: 7,
      costMicroUsd: r.costMicroUsd,
    });
    expect(fails()).toBe(0);
  });

  it('计费以服务商 usage 为准(不按文本估算)', async () => {
    const inner: LlmClient = {
      provider: 'fake',
      call: async () => ({ text: '', usage: { tokensIn: 0, tokensOut: 0 } }),
      async *stream() {
        yield { type: 'text', text: 'x' };
        yield { type: 'usage', usage: { tokensIn: 1_000_000, tokensOut: 2_000_000 } };
      },
    };
    const { gw } = make({ inner });
    const { result } = await drain(gw.stream(req()));
    // test-model:输入、输出都是 1 USD / MTok
    expect((result as { costMicroUsd: number }).costMicroUsd).toBe(3_000_000);
  });

  it('预算超限:抛 BUDGET_EXCEEDED,不调用模型、不写用量', async () => {
    const { gw, inner, rows } = make({ daily: 0 });
    await expect(drain(gw.stream(req()))).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
      scope: 'daily',
    });
    expect((inner as FakeLlm).streams).toBe(0);
    expect(rows()).toHaveLength(0);
  });

  it('熔断打开:抛 LLM_UNAVAILABLE(cause 为 CircuitOpenError),不打上游', async () => {
    const inner = new FakeLlm({ fail: () => true });
    const { gw, open } = make({ inner, failures: 2 });
    for (let i = 0; i < 2; i++)
      await expect(drain(gw.stream(req()))).rejects.toBeInstanceOf(LlmError);
    expect(open()).toBe(true);
    const before = inner.streams;
    const err = await drain(gw.stream(req())).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect((err as LlmError).cause).toBeInstanceOf(CircuitOpenError);
    expect(inner.streams).toBe(before);
  });

  it('上游中途断流:已吐出的段保留,计一次熔断失败,写 ok=0', async () => {
    const inner = new FakeLlm({
      streamText: () => 'abcdefghijklmnop',
      chunkSize: 4,
      breakAfterChunks: 2,
    });
    const { gw, fails, rows } = make({ inner, failures: 5 });
    const got: string[] = [];
    const g = gw.stream(req());
    const err = await (async () => {
      try {
        for (let r = await g.next(); !r.done; r = await g.next()) got.push(r.value.text);
      } catch (e) {
        return e;
      }
    })();
    expect(got).toEqual(['abcd', 'efgh']);
    expect(err).toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect(fails()).toBe(1);
    expect(rows().map((r) => [r.ok, r.costMicroUsd])).toEqual([[false, 0]]);
    expect(await gw.spentToday()).toBe(0);
  });

  it('没给 usage 就结束的流算断流,计失败', async () => {
    const inner: LlmClient = {
      provider: 'fake',
      call: async () => ({ text: '', usage: { tokensIn: 0, tokensOut: 0 } }),
      async *stream() {
        yield { type: 'text', text: 'x' };
      },
    };
    const { gw, fails } = make({ inner, failures: 5 });
    await expect(drain(gw.stream(req()))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect(fails()).toBe(1);
  });

  it('用户中止:抛「已取消」,不计熔断失败,不计花费', async () => {
    const inner = new FakeLlm({ streamText: () => 'abcdefghijklmnop', chunkSize: 4 });
    const { gw, fails, rows } = make({ inner, failures: 1 });
    const ac = new AbortController();
    const err = await drain(gw.stream(req({ signal: ac.signal })), (n) => {
      if (n === 1) ac.abort(new Error('client disconnected'));
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'LLM_UNAVAILABLE', message: 'LLM 调用已取消' });
    expect(fails()).toBe(0);
    expect(rows().map((r) => [r.ok, r.costMicroUsd])).toEqual([[false, 0]]);
    expect(await gw.spentToday()).toBe(0);
    // failures=1 时若误计失败,下一次就会被熔断拒绝
    await expect(drain(gw.stream(req()))).resolves.toBeTruthy();
  });

  it('调用前已取消:不调用模型、不写用量', async () => {
    const { gw, inner, rows } = make();
    const ac = new AbortController();
    ac.abort();
    await expect(drain(gw.stream(req({ signal: ac.signal })))).rejects.toMatchObject({
      message: 'LLM 调用已取消',
    });
    expect((inner as FakeLlm).streams).toBe(0);
    expect(rows()).toHaveLength(0);
  });

  it('客户端不支持流式:LLM_UNAVAILABLE;BreakerClient 不凭空提供 stream', async () => {
    const inner: LlmClient = {
      provider: 'x',
      call: async () => ({ text: '', usage: { tokensIn: 0, tokensOut: 0 } }),
    };
    expect(new BreakerClient(inner, new MemoryLlmKv()).stream).toBeUndefined();
    const { gw } = make({ inner });
    await expect(drain(gw.stream(req()))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });

  it('stream 不影响 complete 的缓存', async () => {
    const { gw, kv } = make();
    await drain(gw.stream(req()));
    expect([...kv.m.keys()].some((k) => /^llm:[0-9a-f]{64}$/.test(k))).toBe(false);
  });
});
