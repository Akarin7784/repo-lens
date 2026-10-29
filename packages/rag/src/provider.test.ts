import { describe, expect, it } from 'vitest';
import { CachedEmbedder, MemoryEmbeddingKv } from './cache.js';
import { DASHSCOPE_MAX_INPUT_CHARS, DashscopeEmbedder, TokenBucket } from './dashscope.js';
import { FakeEmbedder } from './embedder.js';
import { chunksDigest } from './indexer.js';
import { DASHSCOPE_MODELS } from './models.js';
import {
  EmbeddingBudgetExceeded,
  MeteredEmbedder,
  TaskBudgetMeter,
  qdrantCollectionFor,
  tokensToCents,
} from './provider.js';
import type { CodeChunkRecord } from './chunks.js';

const CH = [
  { path: 'src/a.ts', startLine: 1, endLine: 3, symbol: 'a', contentHash: 'h1' },
  { path: 'b.ts', startLine: 2, endLine: 9, symbol: null, contentHash: 'h2' },
] as unknown as CodeChunkRecord[];

type Body = { input: string[]; model: string; dimensions: number };
function ds(opts: { dim?: number; usage?: boolean; fail?: (n: number) => boolean } = {}) {
  const dim = opts.dim ?? 8;
  const bodies: Body[] = [];
  const fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Body;
    bodies.push(b);
    if (opts.fail?.(bodies.length))
      return new Response('{"error":{"message":"RAW_THIRD_PARTY_BODY"}}', { status: 400 });
    return new Response(
      JSON.stringify({
        data: b.input.map((_, i) => ({ index: i, embedding: new Array(dim).fill(i + 1) })),
        ...(opts.usage === false ? {} : { usage: { total_tokens: 10 * b.input.length } }),
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  const sleep = async () => {};
  const e = new DashscopeEmbedder(
    {
      apiKey: 'test-key-not-real',
      baseUrl: 'https://example.invalid/v1',
      model: 'text-embedding-v3',
      dim,
      batchSize: 10,
      tpm: 1_000_000,
      taskBudgetCents: 50,
    },
    { fetch, sleep, backoffMs: 0, bucket: new TokenBucket(1e9, () => 0, sleep) },
  );
  return { e, bodies };
}

describe('digest / 缓存键 / 集合带提供方(T-214c)', () => {
  it('local digest 与改动前完全一致(固定值)', () => {
    expect(chunksDigest(new FakeEmbedder(), CH)).toBe(
      '1272a5df4940d1d6fc78c36f9faf71abacb50b7725f03ec374afbda951017970',
    );
    expect(
      chunksDigest(
        {
          model: 'Xenova/multilingual-e5-small',
          revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
        },
        CH,
      ),
    ).toBe('55c1b144537d0b4bf9bf3bbeecf68d696f30d2b849dd279994ea32a4d71ef577');
    // 显式 provider=local 也不追加
    expect(chunksDigest({ ...new FakeEmbedder(), provider: 'local' }, CH)).toBe(
      chunksDigest(new FakeEmbedder(), CH),
    );
  });

  it('dashscope digest 含 provider、model、维度:换模型或维度即不同', () => {
    const a = chunksDigest(ds({ dim: 8 }).e, CH);
    const b = chunksDigest(ds({ dim: 16 }).e, CH);
    expect(a).not.toBe(b);
    expect(a).not.toBe(chunksDigest(new FakeEmbedder(), CH));
    const other = {
      provider: 'dashscope' as const,
      model: 'dashscope:qwen3.7-text-embedding',
      revision: '8',
      dim: 8,
    };
    expect(chunksDigest(other, CH)).not.toBe(a);
    // provider / dim 行本身进 digest:同 model、revision 仅 provider 或 dim 不同也不同
    const fe = new FakeEmbedder();
    const asDs = { model: fe.model, revision: fe.revision, provider: 'dashscope' as const, dim: 8 };
    expect(chunksDigest(asDs, CH)).not.toBe(chunksDigest(fe, CH));
    expect(chunksDigest(asDs, CH)).not.toBe(chunksDigest({ ...asDs, dim: 16 }, CH));
  });

  it('缓存键模型段为 dashscope:<model>@<dim>,与 local 不冲突', async () => {
    const kv = new MemoryEmbeddingKv();
    const c = new CachedEmbedder(ds({ dim: 8 }).e, kv);
    await c.embedDocuments(['x']);
    const keys = [...kv.m.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('dashscope:text-embedding-v3@8');
  });

  it('Qdrant 集合:local 不变;dashscope 为 <base>_dashscope_<model>_<dim>', () => {
    expect(qdrantCollectionFor('code_chunks', null)).toBe('code_chunks');
    expect(
      qdrantCollectionFor('code_chunks', { model: 'qwen3.7-text-embedding-flash', dim: 256 }),
    ).toBe('code_chunks_dashscope_qwen3_7-text-embedding-flash_256');
    expect(qdrantCollectionFor('code_chunks', { model: 'text-embedding-v3', dim: 1024 })).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });
});

describe('任务预算计量(T-214c)', () => {
  it('按 usage.total_tokens 累计;缓存命中不计费、不发请求', async () => {
    const { e, bodies } = ds();
    const meter = new TaskBudgetMeter(50);
    const kv = new MemoryEmbeddingKv();
    const c = new CachedEmbedder(new MeteredEmbedder(e, meter), kv);
    await c.embedDocuments(['a', 'b']);
    expect(meter).toMatchObject({ tokens: 20, estimatedTokens: 0, source: 'usage' });
    await c.embedDocuments(['a', 'b']);
    expect(bodies).toHaveLength(1);
    expect(meter.tokens).toBe(20);
    expect(meter.requests).toBe(1);
  });

  it('响应缺 usage:按上界(截到 6000 字符)估算并标注 estimate / mixed', async () => {
    const meter = new TaskBudgetMeter(50);
    await new MeteredEmbedder(ds({ usage: false }).e, meter).embedDocuments([
      'abc',
      'x'.repeat(9000),
    ]);
    expect(meter).toMatchObject({
      tokens: 3 + DASHSCOPE_MAX_INPUT_CHARS,
      estimatedTokens: 3 + DASHSCOPE_MAX_INPUT_CHARS,
      source: 'estimate',
    });
    await new MeteredEmbedder(ds().e, meter).embedDocuments(['q']);
    expect(meter.source).toBe('mixed');
    expect(new TaskBudgetMeter(1).source).toBe('none');
  });

  it('超预算:请求前抛 EmbeddingBudgetExceeded,不发请求', async () => {
    const { e, bodies } = ds();
    const m0 = new MeteredEmbedder(e, new TaskBudgetMeter(0));
    await expect(m0.embedDocuments(['a'])).rejects.toBeInstanceOf(EmbeddingBudgetExceeded);
    expect(bodies).toHaveLength(0);
    // 已花接近预算:下一批的上界放不下即停
    const meter = new TaskBudgetMeter(tokensToCents(25));
    const m = new MeteredEmbedder(e, meter);
    await m.embedDocuments(['a', 'b']);
    await expect(m.embedDocuments(['x'.repeat(100)])).rejects.toBeInstanceOf(
      EmbeddingBudgetExceeded,
    );
    expect(bodies).toHaveLength(1);
  });

  it('费用按模型单价换算(flash 为 v3 的 1/4)', () => {
    const v3 = DASHSCOPE_MODELS['text-embedding-v3']!.yuanPer1kTokens;
    const fl = DASHSCOPE_MODELS['qwen3.7-text-embedding-flash']!.yuanPer1kTokens;
    const a = new TaskBudgetMeter(50, v3);
    const b = new TaskBudgetMeter(50, fl);
    a.charge(1_000_000, []);
    b.charge(1_000_000, []);
    expect(b.cents * 4).toBeCloseTo(a.cents, 10);
    // 0.0005 元/千 token × 1M token = 0.5 元 ≈ 7.496 美分
    expect(a.cents).toBeCloseTo(50 / 6.67, 6);
  });

  it('请求失败:错误不含第三方原始响应体,不计费', async () => {
    const { e } = ds({ fail: () => true });
    const meter = new TaskBudgetMeter(50);
    let err: unknown;
    try {
      await new MeteredEmbedder(e, meter).embedDocuments(['a']);
    } catch (x) {
      err = x;
    }
    expect(err).toMatchObject({ kind: 'bad-request', status: 400 });
    expect(JSON.stringify(err) + String(err)).not.toContain('RAW_THIRD_PARTY_BODY');
    expect(meter.tokens).toBe(0);
  });
});
