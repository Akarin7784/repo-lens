import { describe, expect, it } from 'vitest';
import { readEmbeddingConfig, type DashscopeConfig } from './config.js';
import {
  DASHSCOPE_MAX_INPUT_CHARS,
  DashscopeEmbedder,
  EmbeddingError,
  QUERY_CALL,
  INDEX_CALL,
  TokenBucket,
} from './dashscope.js';

const FAKE_KEY = 'test-key-not-real';
const cfg: DashscopeConfig & { apiKey: string } = {
  apiKey: FAKE_KEY,
  baseUrl: 'https://example.invalid/v1',
  model: 'text-embedding-v3',
  dim: 4,
  batchSize: 10,
  tpm: 1_000_000,
  taskBudgetCents: 50,
};

type Call = { url: string; body: { input: string[]; [k: string]: unknown }; timeoutMs?: number };
function fakeFetch(responder: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = { url, body: JSON.parse(String(init.body)) };
    calls.push(c);
    return responder(c, calls.length);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (input: string[], reverse = false) => {
  const data = input.map((_, i) => ({ index: i, embedding: [i, 0, 0, 1] }));
  return new Response(
    JSON.stringify({ data: reverse ? data.reverse() : data, usage: { total_tokens: 7 } }),
    { status: 200 },
  );
};
const mk = (f: typeof fetch, c = cfg) => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const e = new DashscopeEmbedder(c, {
    fetch: f,
    sleep,
    backoffMs: 0,
    bucket: new TokenBucket(1e9, () => 0, sleep),
  });
  return { e, sleeps };
};

describe('DashscopeEmbedder', () => {
  it('请求体:模型、维度、无 e5 前缀、无 text_type/instruct;按 index 重排', async () => {
    const { f, calls } = fakeFetch((c) => ok(c.body.input, true));
    const { e } = mk(f);
    const v = await e.embedDocuments(['a', 'b', 'c']);
    expect(v.map((x) => x[0])).toEqual([0, 1, 2]);
    expect(calls[0]!.url).toBe('https://example.invalid/v1/embeddings');
    expect(calls[0]!.body).toEqual({
      model: 'text-embedding-v3',
      input: ['a', 'b', 'c'],
      dimensions: 4,
      encoding_format: 'float',
    });
    await e.embedQuery('q');
    expect(calls[1]!.body.input).toEqual(['q']);
    expect(e.usageTokens).toBe(14);
    expect([e.model, e.revision, e.dim]).toEqual(['dashscope:text-embedding-v3', '4', 4]);
  });

  it('批量超过上限直接拒绝(不发请求)', async () => {
    const { f, calls } = fakeFetch((c) => ok(c.body.input));
    await expect(mk(f).e.embedDocuments(Array(11).fill('x'))).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('超长文本截断到上限并计数', async () => {
    const { f, calls } = fakeFetch((c) => ok(c.body.input));
    const { e } = mk(f);
    await e.embedDocuments(['x'.repeat(DASHSCOPE_MAX_INPUT_CHARS + 50), 'short']);
    expect(calls[0]!.body.input[0]).toHaveLength(DASHSCOPE_MAX_INPUT_CHARS);
    expect(calls[0]!.body.input[1]).toBe('short');
    expect(e.truncated).toBe(1);
  });

  it('索引 429 最多重试 3 次;查询最多重试 1 次', async () => {
    const r429 = () => new Response('rate limited', { status: 429 });
    const a = fakeFetch(r429);
    await expect(mk(a.f).e.embedDocuments(['x'])).rejects.toMatchObject({
      kind: 'rate-limit',
      status: 429,
    });
    expect(a.calls).toHaveLength(1 + INDEX_CALL.retries);
    const b = fakeFetch(r429);
    await expect(mk(b.f).e.embedQuery('x')).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(b.calls).toHaveLength(1 + QUERY_CALL.retries);
    expect([INDEX_CALL, QUERY_CALL]).toEqual([
      { timeoutMs: 15000, retries: 3 },
      { timeoutMs: 5000, retries: 1 },
    ]);
  });

  it('429 后成功;401/400 不重试', async () => {
    const a = fakeFetch((c, n) => (n === 1 ? new Response('', { status: 429 }) : ok(c.body.input)));
    expect(await mk(a.f).e.embedDocuments(['x'])).toHaveLength(1);
    expect(a.calls).toHaveLength(2);
    for (const status of [401, 400]) {
      const b = fakeFetch(() => new Response('{}', { status }));
      await expect(mk(b.f).e.embedDocuments(['x'])).rejects.toMatchObject({
        status,
        retryable: false,
      });
      expect(b.calls).toHaveLength(1);
    }
  });

  it('超时 / 网络错误归类并可重试', async () => {
    const t = fakeFetch(() =>
      Promise.reject(Object.assign(new Error('x'), { name: 'TimeoutError' })),
    );
    await expect(mk(t.f).e.embedQuery('q')).rejects.toMatchObject({ kind: 'timeout' });
    expect(t.calls).toHaveLength(2);
    const n = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(mk(n.f).e.embedQuery('q')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('错误对象不含第三方原始响应体、请求文本或 key', async () => {
    const leaky = `{"error":{"message":"Incorrect API key provided: ${FAKE_KEY}"},"echo":"SECRET_TEXT"}`;
    for (const status of [400, 401, 429, 500]) {
      const { f } = fakeFetch(() => new Response(leaky, { status }));
      const err = await mk(f)
        .e.embedDocuments(['SECRET_TEXT'])
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(EmbeddingError);
      const dump =
        JSON.stringify(err) +
        String(err) +
        (err as Error).stack +
        JSON.stringify(Object.entries(err as object));
      expect(dump).not.toContain(FAKE_KEY);
      expect(dump).not.toContain('SECRET_TEXT');
      expect(dump).not.toContain('Incorrect');
      expect((err as Error).cause).toBeUndefined();
    }
  });

  it('响应条数 / 维度不符视为 bad-response', async () => {
    const { f } = fakeFetch(
      () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 }),
    );
    await expect(mk(f).e.embedDocuments(['a'])).rejects.toMatchObject({ kind: 'bad-response' });
  });
});

describe('TokenBucket(进程内)', () => {
  it('不足时按 TPM 等待', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const b = new TokenBucket(
      600,
      () => t,
      async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    );
    await b.take(600);
    await b.take(60);
    expect(sleeps).toEqual([6000]);
  });
});

describe('EMBEDDING_PROVIDER 配置', () => {
  it('默认 local:dashscope=null,其余字段与原来一致', () => {
    const c = readEmbeddingConfig({});
    expect(c.dashscope).toBeNull();
    expect(c).toMatchObject({
      provider: 'fake',
      model: 'fake-384',
      revision: 'fake',
      batchSize: 16,
      qdrant: null,
    });
    const onnx = readEmbeddingConfig({ EMBEDDER: 'onnx', EMBEDDING_PROVIDER: 'local' });
    expect(onnx).toMatchObject({
      provider: 'onnx',
      model: 'Xenova/multilingual-e5-small',
      batchSize: 16,
      dashscope: null,
    });
  });
  it('dashscope:默认值,批大小限 10,预算独立', () => {
    const c = readEmbeddingConfig({ EMBEDDING_PROVIDER: 'dashscope' });
    expect(c.dashscope).toEqual({
      apiKey: undefined,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'text-embedding-v3',
      dim: 1024,
      batchSize: 10,
      tpm: 1_000_000,
      taskBudgetCents: 50,
    });
    expect(
      readEmbeddingConfig({ EMBEDDING_PROVIDER: 'dashscope', EMBEDDING_BATCH_SIZE: '4' }).dashscope!
        .batchSize,
    ).toBe(4);
    expect(() => readEmbeddingConfig({ EMBEDDING_PROVIDER: 'x' })).toThrow();
    expect(() =>
      readEmbeddingConfig({ EMBEDDING_PROVIDER: 'dashscope', DASHSCOPE_EMBEDDING_DIM: '1000' }),
    ).toThrow();
  });
  it('非法配置报错只含变量名,不回显 key', () => {
    let msg = '';
    try {
      readEmbeddingConfig({
        EMBEDDING_PROVIDER: 'dashscope',
        DASHSCOPE_API_KEY: 'sk-abcdef',
        DASHSCOPE_EMBEDDING_BASE_URL: 'nope',
      });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain('DASHSCOPE_EMBEDDING_BASE_URL');
    expect(msg).not.toContain('sk-abcdef');
  });
});
