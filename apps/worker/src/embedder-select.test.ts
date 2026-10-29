import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DashscopeEmbedder,
  FakeEmbedder,
  MemoryEmbeddingKv,
  readEmbeddingConfig,
  TaskBudgetMeter,
  type Embedder,
} from '@repolens/rag';
import {
  buildEmbeddingDeps,
  selectEmbedder,
  UnavailableEmbedder,
  type EmbedderCtors,
} from './embedder-select.js';

const FAKE_KEY = 'test-key-not-real';
const MISSING_DIR = '/nonexistent-models-dir-for-test';

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
  return { urls, onnx, ctors };
}

const globalFetch = vi.fn(() => Promise.reject(new Error('unexpected global fetch')));
afterEach(() => {
  vi.unstubAllGlobals();
  globalFetch.mockClear();
});

describe('selectEmbedder', () => {
  it('dashscope + EMBEDDER=onnx:不构造 OnnxEmbedder,零次 /models 请求,model/dim 来自配置', async () => {
    vi.stubGlobal('fetch', globalFetch);
    const emb = readEmbeddingConfig({
      EMBEDDING_PROVIDER: 'dashscope',
      EMBEDDER: 'onnx',
      EMBEDDING_MODEL_DIR: MISSING_DIR,
      DASHSCOPE_API_KEY: FAKE_KEY,
    });
    const { urls, onnx, ctors } = spies();
    const { base, dashscope } = selectEmbedder(emb, ctors);
    expect(onnx).toHaveBeenCalledTimes(0);
    expect(dashscope).toBe(base);
    expect(base.model).toBe(`dashscope:${emb.dashscope!.model}`);
    expect(base.dim).toBe(emb.dashscope!.dim);
    await base.embedDocuments(['a', 'b']);
    await base.embedQuery('q');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.endsWith('/embeddings'))).toBe(true);
    expect(urls.some((u) => /\/models(\/|$)/.test(u))).toBe(false);
    expect(globalFetch).toHaveBeenCalledTimes(0);
  });

  it('dashscope 缺 key:不构造 OnnxEmbedder,不退回本地/假向量,维度仍按配置', async () => {
    const emb = readEmbeddingConfig({
      EMBEDDING_PROVIDER: 'dashscope',
      EMBEDDER: 'onnx',
      EMBEDDING_MODEL_DIR: MISSING_DIR,
    });
    const { onnx, ctors } = spies();
    const { base, dashscope } = selectEmbedder(emb, ctors);
    expect(onnx).toHaveBeenCalledTimes(0);
    expect(dashscope).toBeNull();
    expect(base).toBeInstanceOf(UnavailableEmbedder);
    expect(base).not.toBeInstanceOf(FakeEmbedder);
    expect(base.dim).toBe(emb.dashscope!.dim);
    expect(base.provider).toBe('dashscope');
    expect(base.model).toBe(`dashscope:${emb.dashscope!.model}`);
    await expect(base.embedQuery('q')).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });

  it('local + onnx:行为不变,构造一次 OnnxEmbedder', () => {
    const emb = readEmbeddingConfig({ EMBEDDER: 'onnx', EMBEDDING_MODEL_DIR: MISSING_DIR });
    const { onnx, ctors } = spies();
    const { base, dashscope } = selectEmbedder(emb, ctors);
    expect(onnx).toHaveBeenCalledTimes(1);
    expect(onnx.mock.calls[0]![0].modelDir).toBe(MISSING_DIR);
    expect(dashscope).toBeNull();
    expect(base).toBe(onnx.mock.results[0]!.value as Embedder);
  });

  it('local + fake:行为不变,FakeEmbedder', () => {
    const { onnx, ctors } = spies();
    const { base } = selectEmbedder(readEmbeddingConfig({ EMBEDDER: 'fake' }), ctors);
    expect(onnx).toHaveBeenCalledTimes(0);
    expect(base).toBeInstanceOf(FakeEmbedder);
  });

  it('api 与 worker 读同一配置函数:dashscope 下 model/dim 一致', () => {
    const env = { EMBEDDING_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: FAKE_KEY };
    const a = readEmbeddingConfig(env).dashscope!;
    const { base } = selectEmbedder(readEmbeddingConfig(env), spies().ctors);
    // api 侧(apps/api/src/index.ts)直接 new DashscopeEmbedder(ds),这里对照同一构造
    const api = new DashscopeEmbedder({ ...a, apiKey: FAKE_KEY });
    expect([base.model, base.dim, base.provider]).toEqual([api.model, api.dim, api.provider]);
    expect(base.dim).toBe(a.dim);
  });
});

describe('buildEmbeddingDeps', () => {
  it('dashscope 缺 key:embeddingSkipReason=no-key,taskEmbedder 为 undefined', () => {
    const emb = readEmbeddingConfig({ EMBEDDING_PROVIDER: 'dashscope' });
    const { dashscope } = selectEmbedder(emb, spies().ctors);
    const d = buildEmbeddingDeps(emb, dashscope, new MemoryEmbeddingKv());
    expect(d.embeddingSkipReason).toBe('no-key');
    expect(d.taskEmbedder).toBeUndefined();
  });

  it('dashscope 有 key:有 taskEmbedder(计量 + 百炼),无 skip reason', async () => {
    const emb = readEmbeddingConfig({
      EMBEDDING_PROVIDER: 'dashscope',
      DASHSCOPE_API_KEY: FAKE_KEY,
    });
    const s = spies();
    const { dashscope } = selectEmbedder(emb, s.ctors);
    const d = buildEmbeddingDeps(emb, dashscope, new MemoryEmbeddingKv());
    expect(d.embeddingSkipReason).toBeUndefined();
    expect(d.taskEmbedder).toBeTypeOf('function');
    const meter = new TaskBudgetMeter(50);
    const e = d.taskEmbedder!(meter);
    expect([e.provider, e.model, e.dim]).toEqual([
      dashscope!.provider,
      dashscope!.model,
      dashscope!.dim,
    ]);
    await e.embedDocuments(['a']);
    expect(meter.requests).toBeGreaterThan(0);
    expect(s.urls.every((u) => u.endsWith('/embeddings'))).toBe(true);
  });

  it('local:两项都 undefined', () => {
    const emb = readEmbeddingConfig({ EMBEDDER: 'fake' });
    const d = buildEmbeddingDeps(emb, null, new MemoryEmbeddingKv());
    expect(d).toEqual({ embeddingSkipReason: undefined, taskEmbedder: undefined });
  });
});

describe('index.ts 装配', () => {
  // index.ts 是有副作用的入口(连 Redis/MySQL),不能直接 import;这里核对源码确实改调纯函数,防止改回内联推导
  it('使用 buildEmbeddingDeps,且不再内联 no-key / MeteredEmbedder 推导', () => {
    const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/buildEmbeddingDeps\(emb, dashscope, redis\)/);
    expect(src).toMatch(/\.\.\.embeddingDeps/);
    expect(src).not.toMatch(/embeddingSkipReason:/);
    expect(src).not.toMatch(/new MeteredEmbedder/);
  });
});
