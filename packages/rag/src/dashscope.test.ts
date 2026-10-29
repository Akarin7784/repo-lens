import { describe, expect, it } from 'vitest';
import { readEmbeddingConfig, type DashscopeConfig } from './config.js';
import { DASHSCOPE_MODELS } from './models.js';
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

type Call = {
  url: string;
  body: { input: string[]; [k: string]: unknown };
  signal?: AbortSignal | null;
};
function fakeFetch(responder: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = { url, body: JSON.parse(String(init.body)), signal: init.signal };
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

  it('每次请求都带超时 signal', async () => {
    const { f, calls } = fakeFetch((c) => ok(c.body.input));
    const { e } = mk(f);
    await e.embedDocuments(['a']);
    await e.embedQuery('q');
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it('响应 index 越界 / 重复 / 缺失 / 非整数视为 bad-response', async () => {
    const vec = [1, 0, 0, 0];
    for (const idx of [
      [0, 5],
      [0, 0],
      [0, -1],
      [0, 1.5],
      [0, '1'],
      [0, null],
    ]) {
      const { f } = fakeFetch(
        () =>
          new Response(JSON.stringify({ data: idx.map((index) => ({ index, embedding: vec })) }), {
            status: 200,
          }),
      );
      await expect(mk(f).e.embedDocuments(['a', 'b'])).rejects.toMatchObject({
        kind: 'bad-response',
      });
    }
  });

  it('截断落在高代理项时退一位,不留孤立代理项', async () => {
    const { f, calls } = fakeFetch((c) => ok(c.body.input));
    const { e } = mk(f);
    const t = 'x'.repeat(DASHSCOPE_MAX_INPUT_CHARS - 1) + '😀' + 'tail';
    await e.embedDocuments([t]);
    const sent = calls[0]!.body.input[0]!;
    expect(sent).toHaveLength(DASHSCOPE_MAX_INPUT_CHARS - 1);
    expect(/[\uD800-\uDBFF]$/.test(sent)).toBe(false);
    expect(e.truncated).toBe(1);
  });

  it('索引 429 遵守 Retry-After,上限 10 秒', async () => {
    const r = (s: string) => () => new Response('', { status: 429, headers: { 'retry-after': s } });
    for (const [h, want] of [
      ['3', 3000],
      ['60', 10_000],
    ] as const) {
      const a = fakeFetch(r(h));
      const m = mk(a.f);
      await expect(m.e.embedDocuments(['x'])).rejects.toMatchObject({ kind: 'rate-limit' });
      expect(a.calls).toHaveLength(1 + INDEX_CALL.retries);
      expect(m.sleeps).toEqual(new Array(INDEX_CALL.retries).fill(want));
    }
  });

  it('查询 429:Retry-After ≤ 2 秒等待后重试一次;> 2 秒不重试', async () => {
    const r = (s: string) => () => new Response('', { status: 429, headers: { 'retry-after': s } });
    const a = fakeFetch(r('2'));
    const ma = mk(a.f);
    await expect(ma.e.embedQuery('q')).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(a.calls).toHaveLength(2);
    expect(ma.sleeps).toEqual([2000]);
    const b = fakeFetch(r('3'));
    const mb = mk(b.f);
    await expect(mb.e.embedQuery('q')).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(b.calls).toHaveLength(1);
    expect(mb.sleeps).toEqual([]);
  });

  it('Retry-After 为 0 或过去日期:取 max(Retry-After, 常规退避),不立即重打', async () => {
    for (const h of ['0', 'Thu, 01 Jan 1970 00:00:00 GMT']) {
      const a = fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': h } }));
      const sleeps: number[] = [];
      const sleep = async (ms: number) => void sleeps.push(ms);
      const e = new DashscopeEmbedder(cfg, {
        fetch: a.f,
        sleep,
        backoffMs: 1000,
        bucket: new TokenBucket(1e9, () => 0, sleep),
      });
      await expect(e.embedQuery('q')).rejects.toMatchObject({ kind: 'rate-limit' });
      expect(a.calls).toHaveLength(2);
      expect(sleeps).toHaveLength(1);
      // 常规退避 1s·2^0 + ≤25% 抖动
      expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
      expect(sleeps[0]).toBeLessThanOrEqual(1250);
    }
  });

  it('Retry-After 小于常规退避时取常规退避;大于时取 Retry-After', async () => {
    const r = (s: string) => () => new Response('', { status: 429, headers: { 'retry-after': s } });
    const run = async (h: string) => {
      const a = fakeFetch(r(h));
      const sleeps: number[] = [];
      const sleep = async (ms: number) => void sleeps.push(ms);
      const e = new DashscopeEmbedder(cfg, {
        fetch: a.f,
        sleep,
        backoffMs: 1000,
        bucket: new TokenBucket(1e9, () => 0, sleep),
      });
      await expect(e.embedDocuments(['x'])).rejects.toMatchObject({ kind: 'rate-limit' });
      return sleeps;
    };
    const lo = await run('0.5');
    expect(lo[0]).toBeGreaterThanOrEqual(1000);
    expect(lo[2]).toBeGreaterThanOrEqual(4000);
    expect(await run('8')).toEqual([8000, 8000, 8000]);
  });

  it('按模型参数化:请求体 model / dimensions 取自配置', async () => {
    const a = fakeFetch((c) => {
      const n = c.body.dimensions as number;
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: new Array(n).fill(0.1) }] }),
        { status: 200 },
      );
    });
    const m = mk(a.f, { ...cfg, model: 'qwen3.7-text-embedding-flash', dim: 256 });
    expect(m.e.model).toBe('dashscope:qwen3.7-text-embedding-flash');
    expect(m.e.revision).toBe('256');
    expect((await m.e.embedDocuments(['x']))[0]).toHaveLength(256);
    expect(a.calls[0]!.body).toMatchObject({
      model: 'qwen3.7-text-embedding-flash',
      dimensions: 256,
    });
  });

  it('返回维度与请求维度不一致(如 flash 静默回落 1024)视为 bad-response', async () => {
    const a = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: new Array(1024).fill(0.1) }] }),
          { status: 200 },
        ),
    );
    const m = mk(a.f, { ...cfg, model: 'qwen3.7-text-embedding', dim: 2560 });
    await expect(m.e.embedDocuments(['x'])).rejects.toMatchObject({ kind: 'bad-response' });
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
      { timeoutMs: 15000, retries: 3, maxRetryAfterMs: Infinity },
      { timeoutMs: 5000, retries: 1, maxRetryAfterMs: 2000 },
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

  it('读响应体时超时 / 中止归为 timeout 并重试,不当成 bad-response', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const t = fakeFetch(() => {
        const r = new Response('{}', { status: 200 });
        Object.defineProperty(r, 'json', {
          value: () => Promise.reject(Object.assign(new Error('x'), { name })),
        });
        return r;
      });
      await expect(mk(t.f).e.embedQuery('q')).rejects.toMatchObject({
        kind: 'timeout',
        retryable: true,
      });
      expect(t.calls).toHaveLength(1 + QUERY_CALL.retries);
    }
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
      model: 'qwen3.7-text-embedding',
      dim: 1024,
      batchSize: 10,
      tpm: 800_000,
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
  it('能力表:按模型取默认维度 / TPM / 批量;表外模型与表外维度报错只含变量名', () => {
    const d = (env: Record<string, string>) =>
      readEmbeddingConfig({ EMBEDDING_PROVIDER: 'dashscope', ...env }).dashscope!;
    const q = d({ DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding' });
    expect(q).toMatchObject({ dim: 1024, tpm: 800_000, batchSize: 10 });
    const f = d({ DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash' });
    expect(f).toMatchObject({ dim: 1024, tpm: 800_000, batchSize: 10 });
    // 文档批量 20,但实际默认上限仍 10
    expect(
      d({ DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding', EMBEDDING_BATCH_SIZE: '64' })
        .batchSize,
    ).toBe(10);
    expect(DASHSCOPE_MODELS['qwen3.7-text-embedding']!.docBatchMax).toBe(20);
    expect(DASHSCOPE_MODELS['text-embedding-v3']!.docBatchMax).toBe(10);
    expect(
      d({ DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding', DASHSCOPE_EMBEDDING_DIM: '2560' })
        .dim,
    ).toBe(2560);
    expect(d({ DASHSCOPE_EMBEDDING_TPM: '5000' }).tpm).toBe(5000);
    for (const dim of ['2560', '2048', '1536', '128']) {
      expect(() =>
        d({
          DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash',
          DASHSCOPE_EMBEDDING_DIM: dim,
        }),
      ).toThrow(/DASHSCOPE_EMBEDDING_DIM/);
    }
    for (const dim of ['1024', '768', '512', '256'])
      expect(
        d({
          DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash',
          DASHSCOPE_EMBEDDING_DIM: dim,
        }).dim,
      ).toBe(Number(dim));
    expect(() =>
      d({ DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding', DASHSCOPE_EMBEDDING_DIM: '128' }),
    ).toThrow(/DASHSCOPE_EMBEDDING_DIM/);
    let msg = '';
    try {
      d({ DASHSCOPE_EMBEDDING_MODEL: 'secret-model-xyz' });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain('DASHSCOPE_EMBEDDING_MODEL');
    expect(msg).not.toContain('secret-model-xyz');
    // 原型链上的名字不算表内模型
    expect(() => d({ DASHSCOPE_EMBEDDING_MODEL: 'constructor' })).toThrow(
      /DASHSCOPE_EMBEDDING_MODEL/,
    );
    // local 下不校验 dashscope 模型,行为不变
    expect(readEmbeddingConfig({ DASHSCOPE_EMBEDDING_MODEL: 'whatever' }).dashscope).toBeNull();
  });
  it('BASE_URL 只允许 https + 官方主机;报错不回显值', () => {
    const ds = (u: string) =>
      readEmbeddingConfig({ EMBEDDING_PROVIDER: 'dashscope', DASHSCOPE_EMBEDDING_BASE_URL: u });
    expect(ds('https://dashscope-intl.aliyuncs.com/compatible-mode/v1').dashscope!.baseUrl).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    expect(
      ds('https://abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').dashscope!.baseUrl,
    ).toBe('https://abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
    for (const bad of [
      'http://dashscope.aliyuncs.com/compatible-mode/v1',
      'http://abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      'https://evil-proxy.example.com/v1',
      'https://dashscope.aliyuncs.com.evil.example/v1',
      'https://evil.com/.maas.aliyuncs.com',
      'https://x.maas.aliyuncs.com.evil.com/v1',
      'https://evil@abc123.cn-beijing.maas.aliyuncs.com/v1',
      'https://u:p@dashscope.aliyuncs.com/compatible-mode/v1',
      'https://abc123.cn-beijing.maas.aliyuncs.com:8443/v1',
      'https://dashscope.aliyuncs.com:443x/v1',
      'https://47.93.1.2/compatible-mode/v1',
      'https://[::1]/v1',
      'https://a.b.c.maas.aliyuncs.com/v1',
      // 正则去掉 $ 时会被前缀匹配放行(变异检查用例)
      'https://a.b.maas.aliyuncs.com.evil.com',
    ]) {
      let msg = '';
      try {
        ds(bad);
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain('DASHSCOPE_EMBEDDING_BASE_URL');
      expect(msg).not.toContain(bad);
      expect(msg).not.toContain('evil');
      expect(msg).not.toContain('maas');
    }
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
