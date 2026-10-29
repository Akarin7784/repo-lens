import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '@repolens/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BreakerClient, CircuitOpenError } from './breaker.js';
import { createLlmClient, readLlmConfig } from './config.js';
import { DeepSeekClient, LlmHttpError } from './deepseek.js';
import { LlmGateway } from './gateway.js';
import { DEFAULT_PRICES, costMicroUsd } from './pricing.js';
import type { LlmClient } from './types.js';

/** 最小内存 KV(TTL 不模拟,到期用置空表示) */
class MemoryKv {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) || null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async incrby(k: string, n: number) {
    const v = Number(this.m.get(k) || 0) + n;
    this.m.set(k, String(v));
    return v;
  }
  async expire() {
    return 1;
  }
}

// 本地假 DeepSeek:只监听 127.0.0.1 随机端口,不访问真实接口
const KEY = 'sk-test-not-a-real-key-123';
let server: Server;
let base: string;
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let last: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
const readBody = (r: IncomingMessage) =>
  new Promise<string>((ok) => {
    let s = '';
    r.on('data', (c) => (s += c));
    r.on('end', () => ok(s));
  });

beforeAll(async () => {
  server = createServer(async (rq, rs) => {
    last = { url: rq.url, auth: rq.headers.authorization, body: JSON.parse(await readBody(rq)) };
    rs.writeHead(reply.status, { 'content-type': 'application/json' });
    rs.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const okBody = (content = '{"summary":"x"}') => ({
  id: 'c1',
  object: 'chat.completion',
  model: 'deepseek-flash',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400,
  },
});
const call = { model: 'deepseek-flash', messages: [{ role: 'user' as const, content: 'hi json' }] };

beforeEach(() => {
  reply = { status: 200, body: okBody() };
  last = {};
});

describe('DeepSeekClient(本地假 HTTP 服务)', () => {
  it('POST /chat/completions,Bearer 鉴权、关闭思考、json 模式;usage 映射含缓存命中', async () => {
    const c = new DeepSeekClient(KEY, { baseUrl: `${base}/` });
    const r = await c.call({ ...call, json: true, maxTokens: 300, temperature: 0.2 });
    expect(last.url).toBe('/chat/completions');
    expect(last.auth).toBe(`Bearer ${KEY}`);
    expect(last.body).toMatchObject({
      model: 'deepseek-flash',
      stream: false,
      reasoning_effort: 'none',
      max_tokens: 300,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    expect(r).toEqual({
      text: '{"summary":"x"}',
      usage: { tokensIn: 1000, tokensOut: 200, cachedTokensIn: 600 },
    });
  });
  it('非 json 请求不带 response_format;没有缓存字段时 cachedTokensIn=0', async () => {
    const b = okBody('plain');
    delete (b.usage as Partial<typeof b.usage>).prompt_cache_hit_tokens;
    reply = { status: 200, body: b };
    const r = await new DeepSeekClient(KEY, { baseUrl: base }).call(call);
    expect(last.body).not.toHaveProperty('response_format');
    expect(r.usage.cachedTokensIn).toBe(0);
  });
  it('非 2xx 抛 LlmHttpError,带状态码与 error.message,不含 key', async () => {
    reply = { status: 401, body: { error: { message: 'Authentication Fails', type: 'auth' } } };
    const err = await new DeepSeekClient(KEY, { baseUrl: base }).call(call).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/401: Authentication Fails/);
    expect(String(err.message) + String(err.stack)).not.toContain(KEY);
  });
  it('响应缺 usage / 非 JSON 时报错', async () => {
    reply = { status: 200, body: { choices: [{ message: { content: 'x' } }] } };
    await expect(new DeepSeekClient(KEY, { baseUrl: base }).call(call)).rejects.toThrow(/usage/);
    reply = { status: 200, body: 'not json' };
    await expect(new DeepSeekClient(KEY, { baseUrl: base }).call(call)).rejects.toThrow(/JSON/);
  });
  it('超时会中止请求', async () => {
    const slow = createServer(() => {
      /* 永不响应 */
    });
    await new Promise<void>((ok) => slow.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    await expect(
      new DeepSeekClient(KEY, { baseUrl: url, timeoutMs: 100 }).call(call),
    ).rejects.toThrow();
    slow.closeAllConnections();
    await new Promise<void>((ok) => slow.close(() => ok()));
  });
  it('key 不出现在客户端对象的序列化里', () => {
    const c = new DeepSeekClient(KEY, { baseUrl: base });
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(Object.values(c).join(' ')).not.toContain(KEY);
  });
});

describe('BreakerClient cb:llm:{provider}', () => {
  const failing = (): LlmClient & { n: number; ok: boolean } => ({
    provider: 'deepseek',
    n: 0,
    ok: false,
    async call() {
      this.n++;
      if (!this.ok) throw new Error('boom');
      return { text: 'ok', usage: { tokensIn: 1, tokensOut: 1 } };
    },
  });
  it('连续 5 次失败后打开 60 秒,期间不调用底层;到期后放行', async () => {
    const kv = new MemoryKv();
    const inner = failing();
    const b = new BreakerClient(inner, kv, { keyPrefix: 'p:' });
    for (let i = 0; i < 5; i++) await expect(b.call(call)).rejects.toThrow('boom');
    expect(await kv.get('p:cb:llm:deepseek')).toBe('1');
    await expect(b.call(call)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.n).toBe(5);
    // 模拟 60 秒到期
    await kv.set('p:cb:llm:deepseek', '');
    inner.ok = true;
    await expect(b.call(call)).resolves.toMatchObject({ text: 'ok' });
  });
  it('中间一次成功清零连续失败计数', async () => {
    const kv = new MemoryKv();
    const inner = failing();
    const b = new BreakerClient(inner, kv);
    for (let i = 0; i < 4; i++) await expect(b.call(call)).rejects.toThrow();
    inner.ok = true;
    await b.call(call);
    inner.ok = false;
    for (let i = 0; i < 4; i++) await expect(b.call(call)).rejects.toThrow('boom');
    expect(await kv.get('cb:llm:deepseek')).toBeNull();
  });
});

describe('readLlmConfig / createLlmClient(deepseek)', () => {
  it('LLM_PROVIDER=deepseek 需要 key,报错信息不回显任何值', () => {
    expect(() => readLlmConfig({ LLM_PROVIDER: 'deepseek' })).toThrow(/DEEPSEEK_API_KEY/);
  });
  it('默认模型 deepseek-flash 与官方 base URL;可被 LLM_*_MODEL / DEEPSEEK_BASE_URL 覆盖', () => {
    const c = readLlmConfig({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: KEY });
    expect(c).toMatchObject({
      provider: 'deepseek',
      summaryModel: 'deepseek-flash',
      chatModel: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      hasApiKey: true,
      dailyBudgetCents: 500,
      taskBudgetCents: 30,
    });
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(
      readLlmConfig({
        LLM_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: KEY,
        LLM_CHAT_MODEL: 'deepseek-v4-pro',
        DEEPSEEK_BASE_URL: base,
      }),
    ).toMatchObject({
      chatModel: 'deepseek-v4-pro',
      summaryModel: 'deepseek-flash',
      baseUrl: base,
    });
    expect(() =>
      readLlmConfig({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: 'x' }),
    ).toThrow(/DEEPSEEK_BASE_URL/);
  });
  it('fake 下忽略模型变量', () => {
    expect(readLlmConfig({ LLM_CHAT_MODEL: 'deepseek-flash' }).chatModel).toBe('fake');
  });
  it('createLlmClient:有 kv 时套熔断,否则裸客户端', () => {
    const env = { LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: base };
    const c = readLlmConfig(env);
    expect(createLlmClient(c, { env })).toBeInstanceOf(DeepSeekClient);
    expect(createLlmClient(c, { env, kv: new MemoryKv() })).toBeInstanceOf(BreakerClient);
  });
});

describe('按真实 usage 记账(deepseek-flash,高峰价)', () => {
  it('缓存命中输入按 0.006、未命中 0.30、输出 1.2 美元/百万 token', () => {
    const p = DEFAULT_PRICES['deepseek-flash']!;
    // 400*0.30 + 600*0.006 + 200*1.2 = 120 + 3.6 + 240 = 363.6 → 364 micro-USD
    expect(costMicroUsd(p, 1000, 200, 600)).toBe(364);
    expect(costMicroUsd(p, 1000, 200)).toBe(540);
    expect(costMicroUsd(p, 10, 0, 999)).toBe(1); // cached 截断到 tokensIn
  });
  it('网关 → 熔断 → DeepSeekClient → 假服务:cost 与 llm_usage 一致', async () => {
    const env = { LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: base };
    const kv = new MemoryKv();
    const usage = new MemoryStore();
    const gw = new LlmGateway({
      client: createLlmClient(readLlmConfig(env), { env, kv }),
      kv,
      usage,
      prices: DEFAULT_PRICES,
      dailyBudgetCents: 500,
      taskBudgetCents: 30,
    });
    const r = await gw.complete({ ...call, purpose: 'summary', repoId: 1, taskId: 7 });
    expect(r).toMatchObject({ costMicroUsd: 364, cacheHit: false });
    const rows = await usage.llmUsageByTask(7);
    expect(rows[0]).toMatchObject({ tokensIn: 1000, tokensOut: 200, costMicroUsd: 364, ok: true });
  });
});
