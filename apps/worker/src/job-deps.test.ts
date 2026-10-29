import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRICES, FakeLlm, LlmGateway, MemoryLlmKv } from '@repolens/agent';
import { MemoryStore } from '@repolens/db';
import {
  DashscopeEmbedder,
  FakeEmbedder,
  MemoryEmbeddingKv,
  readEmbeddingConfig,
  TaskBudgetMeter,
} from '@repolens/rag';
import { testConfig } from './test-utils.js';
import { buildJobDeps, type JobDepsRedis } from './job-deps.js';
import type { EmbedderCtors } from './embedder-select.js';

const FAKE_KEY = 'test-key-not-real';
const MISSING_DIR = '/nonexistent-models-dir-for-test';

function fakeRedis(kv = new MemoryEmbeddingKv()): JobDepsRedis {
  return {
    mget: (keys) => kv.mget(keys),
    setex: (k, t, v) => kv.setex(k, t, v),
    set: async () => null,
    get: async () => null,
    del: async () => 0,
    eval: async () => 0,
    async *scanStream() {
      /* 空:单测不跑图缓存失效 */
    },
  };
}

function spies() {
  const urls: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    const input = (JSON.parse(String(init.body)) as { input: string[] }).input;
    const dim = 1024;
    return new Response(
      JSON.stringify({
        data: input.map((_, i) => ({
          index: i,
          embedding: Array.from({ length: dim }, () => 0.01),
        })),
        usage: { total_tokens: input.length },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  const onnx = vi.fn<EmbedderCtors['onnx']>(() => new FakeEmbedder());
  const ctors: EmbedderCtors = {
    onnx,
    dashscope: (ds) => new DashscopeEmbedder(ds, { fetch: fetchFn }),
  };
  return { urls, onnx, ctors, kv: new MemoryEmbeddingKv() };
}

function gateway() {
  return new LlmGateway({
    client: new FakeLlm(),
    kv: new MemoryLlmKv(),
    usage: new MemoryStore(),
    prices: DEFAULT_PRICES,
    dailyBudgetCents: 500,
    taskBudgetCents: 30,
  });
}

const globalFetch = vi.fn(() => Promise.reject(new Error('unexpected global fetch')));
afterEach(() => {
  vi.unstubAllGlobals();
  globalFetch.mockClear();
});

describe('buildJobDeps', () => {
  it('dashscope 缺 key:deps.embeddingSkipReason=no-key,无 taskEmbedder', () => {
    const emb = readEmbeddingConfig({
      EMBEDDING_PROVIDER: 'dashscope',
      EMBEDDER: 'onnx',
      EMBEDDING_MODEL_DIR: MISSING_DIR,
    });
    const s = spies();
    const deps = buildJobDeps({
      config: testConfig({ embedding: emb }),
      emb,
      redis: fakeRedis(s.kv),
      gateway: gateway(),
      store: new MemoryStore(),
      events: { emit: async () => {} },
      ctors: s.ctors,
    });
    expect(s.onnx).toHaveBeenCalledTimes(0);
    expect(deps.embeddingSkipReason).toBe('no-key');
    expect(deps.taskEmbedder).toBeUndefined();
    expect(deps.embedder).toBeDefined();
  });

  it('dashscope 有 key:有 taskEmbedder,无 skip;同文本第二次不增 fetch', async () => {
    const emb = readEmbeddingConfig({
      EMBEDDING_PROVIDER: 'dashscope',
      DASHSCOPE_API_KEY: FAKE_KEY,
    });
    const s = spies();
    const deps = buildJobDeps({
      config: testConfig({ embedding: emb }),
      emb,
      redis: fakeRedis(s.kv),
      gateway: gateway(),
      store: new MemoryStore(),
      events: { emit: async () => {} },
      ctors: s.ctors,
    });
    expect(deps.embeddingSkipReason).toBeUndefined();
    expect(deps.taskEmbedder).toBeTypeOf('function');
    const meter = new TaskBudgetMeter(50);
    const e = deps.taskEmbedder!(meter);
    await e.embedDocuments(['same-text']);
    const n = s.urls.length;
    expect(n).toBeGreaterThan(0);
    expect(meter.requests).toBeGreaterThan(0);
    const reqs = meter.requests;
    await e.embedDocuments(['same-text']);
    expect(s.urls.length).toBe(n);
    expect(meter.requests).toBe(reqs);
  });

  it('local:embeddingSkipReason 与 taskEmbedder 都 undefined', () => {
    const emb = readEmbeddingConfig({ EMBEDDER: 'fake' });
    const deps = buildJobDeps({
      config: testConfig({ embedding: emb }),
      emb,
      redis: fakeRedis(),
      gateway: gateway(),
      store: new MemoryStore(),
      events: { emit: async () => {} },
    });
    expect(deps.embeddingSkipReason).toBeUndefined();
    expect(deps.taskEmbedder).toBeUndefined();
    expect(deps.embedder).toBeDefined();
  });

  it('返回对象自带 embedding 字段,不被后续同名覆盖(装配完整性)', () => {
    const emb = readEmbeddingConfig({ EMBEDDING_PROVIDER: 'dashscope' });
    const deps = buildJobDeps({
      config: testConfig({ embedding: emb }),
      emb,
      redis: fakeRedis(),
      gateway: gateway(),
      store: new MemoryStore(),
      events: { emit: async () => {} },
      ctors: spies().ctors,
    });
    // 若有人在 buildJobDeps 里 ...embeddingDeps 后再写 embeddingSkipReason: undefined 会失败
    expect(Object.prototype.hasOwnProperty.call(deps, 'embeddingSkipReason')).toBe(true);
    expect(deps.embeddingSkipReason).toBe('no-key');
    expect(Object.prototype.hasOwnProperty.call(deps, 'taskEmbedder')).toBe(true);
    expect(deps.taskEmbedder).toBeUndefined();
  });
});
