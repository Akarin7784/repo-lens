import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeEmbedder } from './embedder.js';
import { DashscopeEmbedder } from './dashscope.js';
import { chunksDigest, indexChunks } from './indexer.js';
import { MemoryVectorStore } from './vector-store.js';
import { hybridSearch } from './retrieval.js';
import {
  evalIndexedSource,
  evalUsageLine,
  trackEvalIndexUsage,
  evalEmbeddingLine,
  evalVectorCacheFile,
  makeEvalEmbedder,
  selectEvalEmbedding,
} from './eval-embedding.js';

const FAKE_KEY = 'sk-test-not-a-real-key';

describe('评测 embedding 选择(scripts/rag-eval.mjs)', () => {
  it('默认 local:模型、维度、集合名与向量缓存路径固定(行为不变)', () => {
    const c = selectEvalEmbedding({});
    expect(c).toEqual({
      provider: 'local',
      model: 'Xenova/multilingual-e5-small',
      dim: 384,
      collection: 'eval_local_Xenova_multilingual-e5-small_384',
      dashscope: null,
    });
    expect(evalVectorCacheFile(c, null)).toBe('/tmp/rl-eval-vectors.json');
    expect(evalVectorCacheFile(c, 'v3')).toBe('/tmp/rl-eval-vectors-v3.json');
    // local 不读 EMBEDDING_MODEL / DASHSCOPE_*,也不要求 key
    expect(
      selectEvalEmbedding({
        EMBEDDING_MODEL: 'other',
        DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding',
      }),
    ).toEqual(c);
    expect(evalEmbeddingLine(c)).toBe(
      'EVAL embedding provider=local model=Xenova/multilingual-e5-small dim=384 collection=eval_local_Xenova_multilingual-e5-small_384',
    );
  });

  it('dashscope:默认模型为 qwen3.7-text-embedding;集合名带 provider+model+请求维度', () => {
    const c = selectEvalEmbedding({ EMBEDDING_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: FAKE_KEY });
    expect([c.provider, c.model, c.dim, c.collection]).toEqual([
      'dashscope',
      'qwen3.7-text-embedding',
      1024,
      'eval_dashscope_qwen3_7-text-embedding_1024',
    ]);
    const q = selectEvalEmbedding({
      EMBEDDING_PROVIDER: 'dashscope',
      DASHSCOPE_API_KEY: FAKE_KEY,
      DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash',
      DASHSCOPE_EMBEDDING_DIM: '512',
    });
    expect(q.collection).toBe('eval_dashscope_qwen3_7-text-embedding-flash_512');
    expect(evalVectorCacheFile(q, null)).toBe(
      '/tmp/rl-eval-vectors-eval_dashscope_qwen3_7-text-embedding-flash_512.json',
    );
    expect(evalVectorCacheFile(q, null)).not.toBe(evalVectorCacheFile(c, null));
  });

  it('dashscope:key 只读 DASHSCOPE_API_KEY,缺失报错只报变量名;开始行不含 key', () => {
    expect(() =>
      selectEvalEmbedding({ EMBEDDING_PROVIDER: 'dashscope', DEEPSEEK_API_KEY: FAKE_KEY }),
    ).toThrow(/DASHSCOPE_API_KEY/);
    const c = selectEvalEmbedding({ EMBEDDING_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: FAKE_KEY });
    expect(c.dashscope?.apiKey).toBe(FAKE_KEY);
    expect(evalEmbeddingLine(c)).not.toContain(FAKE_KEY);
    expect(() => selectEvalEmbedding({ EMBEDDING_PROVIDER: 'openai' })).toThrow(
      /EMBEDDING_PROVIDER/,
    );
    let msg = '';
    try {
      selectEvalEmbedding({
        EMBEDDING_PROVIDER: 'dashscope',
        DASHSCOPE_API_KEY: FAKE_KEY,
        DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash',
        DASHSCOPE_EMBEDDING_DIM: '2560',
      });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain('DASHSCOPE_EMBEDDING_DIM');
    expect(msg).not.toContain(FAKE_KEY);
  });

  it('makeEvalEmbedder:local 走 local 工厂;dashscope 用假 fetch,不发真实请求;维度不符报错', async () => {
    const local = makeEvalEmbedder(selectEvalEmbedding({}), {
      local: () => new FakeEmbedder(),
      dashscope: () => {
        throw new Error('不应调用');
      },
    });
    expect(local.dim).toBe(384);
    const c = selectEvalEmbedding({
      EMBEDDING_PROVIDER: 'dashscope',
      DASHSCOPE_API_KEY: FAKE_KEY,
      DASHSCOPE_EMBEDDING_MODEL: 'text-embedding-v3', // 64 维仅 v3 支持
      DASHSCOPE_EMBEDDING_DIM: '64',
    });
    const urls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      urls.push(url);
      const n = (JSON.parse(String(init.body)).input as string[]).length;
      return new Response(
        JSON.stringify({
          data: Array.from({ length: n }, (_, index) => ({
            index,
            embedding: Array(64).fill(0.125),
          })),
          usage: { total_tokens: n },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const ds = makeEvalEmbedder(c, {
      local: () => new FakeEmbedder(),
      dashscope: (cfg) => new DashscopeEmbedder(cfg, { fetch: fakeFetch }),
    });
    expect((await ds.embedQuery('q')).length).toBe(64);
    expect(urls).toHaveLength(1);
    expect(() =>
      makeEvalEmbedder(c, { local: () => new FakeEmbedder(), dashscope: () => new FakeEmbedder() }),
    ).toThrow(/维度 384 != 请求维度 64/);
  });
});

describe('评测索引用量行(EVAL embedding usage)', () => {
  const c = selectEvalEmbedding({
    EMBEDDING_PROVIDER: 'dashscope',
    DASHSCOPE_API_KEY: FAKE_KEY,
    DASHSCOPE_EMBEDDING_MODEL: 'text-embedding-v3', // 64 维仅 v3 支持
    DASHSCOPE_EMBEDDING_DIM: '64',
    EMBEDDING_BATCH_SIZE: '2',
  });
  // usageFor(批序号) 返回 total_tokens;undefined 表示响应不带 usage
  const mkFetch = (usageFor: (call: number) => number | undefined) => {
    let call = 0;
    return (async (_url: string, init: RequestInit) => {
      const n = (JSON.parse(String(init.body)).input as string[]).length;
      const u = usageFor(call++);
      return new Response(
        JSON.stringify({
          data: Array.from({ length: n }, (_, index) => ({
            index,
            embedding: Array(64).fill(0.125),
          })),
          ...(u === undefined ? {} : { usage: { total_tokens: u } }),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  };
  const chunks = ['aaa', 'bbbbbb', 'c'].map((text, i) => ({
    path: `f${i}.ts`,
    symbol: null,
    startLine: 1,
    endLine: 1,
    text,
    contentHash: `h${i}`,
  }));
  const run = async (usageFor: (call: number) => number | undefined) => {
    const inner = new DashscopeEmbedder(c.dashscope!, { fetch: mkFetch(usageFor) });
    const t = trackEvalIndexUsage(inner);
    const store = new MemoryVectorStore();
    await indexChunks(
      { repoId: 1, commitSha: 'c1', chunks: chunks as never, batchSize: 2 },
      t.embedder,
      store,
    );
    return { inner, t, store };
  };

  it('实测:累计每批 usage.total_tokens,不估算;包装器不改 digest', async () => {
    const { inner, t } = await run((i) => [7, 5][i]);
    expect(t.usage).toEqual({
      batches: 2,
      measuredTokens: 12,
      estimatedBatches: 0,
      estimatedTokens: 0,
    });
    expect(evalUsageLine(c, t.usage)).toBe(
      'EVAL embedding usage reused=0 totalTokens=12 batches=2',
    );
    expect(chunksDigest(t.embedder, chunks as never)).toBe(chunksDigest(inner, chunks as never));
  });

  it('无 usage:按估算单列并标明,不混进 totalTokens', async () => {
    const { t } = await run((i) => (i === 0 ? 7 : undefined));
    // 第 2 批只有 'c' → estimateTokens=1
    expect(t.usage).toEqual({
      batches: 2,
      measuredTokens: 7,
      estimatedBatches: 1,
      estimatedTokens: 1,
    });
    expect(evalUsageLine(c, t.usage)).toBe(
      'EVAL embedding usage reused=0 totalTokens=7 batches=2 estimatedTokens=1(估算,未计入totalTokens) estimatedBatches=1',
    );
  });

  it('复用向量缓存:写 reused=1 totalTokens=未测,不写 0', () => {
    const line = evalUsageLine(c, null);
    expect(line).toBe('EVAL embedding usage reused=1 totalTokens=未测');
    expect(line).not.toMatch(/totalTokens=0/);
    expect(evalUsageLine(selectEvalEmbedding({}), null)).toBe(line);
  });

  it('local:不计 token,透传 embedDocuments;行内不含密钥', async () => {
    const t = trackEvalIndexUsage(new FakeEmbedder());
    expect((await t.embedder.embedDocuments(['x'])).length).toBe(1);
    expect(t.usage.batches).toBe(0);
    expect(evalUsageLine(selectEvalEmbedding({}), t.usage)).toBe(
      'EVAL embedding usage reused=0 totalTokens=不适用(local)',
    );
    expect(evalUsageLine(c, t.usage)).not.toContain(FAKE_KEY);
  });
});

describe('评测传给 hybridSearch 的索引来源(evalIndexedSource)', () => {
  const c = selectEvalEmbedding({
    EMBEDDING_PROVIDER: 'dashscope',
    DASHSCOPE_API_KEY: FAKE_KEY,
    DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding',
    DASHSCOPE_EMBEDDING_DIM: '1024',
  });
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body)).input as string[];
    return new Response(
      JSON.stringify({
        data: input.map((t, index) => ({
          index,
          embedding: Array.from({ length: 1024 }, (_, k) => ((t.length + k) % 7) + 1),
        })),
        usage: { total_tokens: input.length },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const setup = async () => {
    const emb = new DashscopeEmbedder(c.dashscope!, { fetch: fakeFetch });
    const chunks = ['src/a.ts', 'src/b.ts'].map((path, i) => ({
      path,
      symbol: `f${i}`,
      startLine: 1,
      endLine: 3,
      text: `${path} f${i}\nexport function f${i}() {}`,
      contentHash: `h${i}`,
    }));
    const vs = new MemoryVectorStore();
    await indexChunks(
      { repoId: 1, commitSha: 'c1', chunks: chunks as never, batchSize: 2 },
      emb,
      vs,
    );
    const rows = [...vs.points.values()].map((p) => ({
      path: p.payload.path,
      symbol: p.payload.symbol,
      startLine: p.payload.start_line,
      endLine: p.payload.end_line,
      content: chunks.find((x) => x.path === p.payload.path)!.text,
      qdrantPointId: p.id,
    }));
    const q = { repoId: 1, commitSha: 'c1', question: 'f0', rewritten: 'f0', chunks: rows };
    return { emb, vs, q };
  };

  it('dashscope:返回真实 provider/model/dim', () => {
    expect(evalIndexedSource(c)).toEqual({
      indexedProvider: 'dashscope',
      indexedModel: 'qwen3.7-text-embedding',
      indexedDim: 1024,
    });
  });

  it('dashscope 带来源走 hybrid;不带(修复前)被当作 local → provider-mismatch,keyword-only', async () => {
    const { emb, vs, q } = await setup();
    const base = { ...q, embeddingStatus: 'ready', embedder: emb, vectorStore: vs, limit: 5 };
    const fixed = await hybridSearch({ ...base, ...evalIndexedSource(c) });
    expect(fixed.retrieval).toBe('hybrid');
    expect(fixed.hits.some((h) => h.sources.includes('vector'))).toBe(true);
    const before = await hybridSearch(base);
    expect(before).toMatchObject({
      retrieval: 'keyword-only',
      degradedReason: 'provider-mismatch',
    });
  });

  it('rag-eval.mjs 里每处 hybridSearch 调用都展开 evalIndexedSource(EMB)(共 3 处)', () => {
    const src = readFileSync(new URL('../../../scripts/rag-eval.mjs', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/hybridSearch\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);
    expect(calls).toHaveLength(3);
    for (const body of calls) expect(body).toContain('...evalIndexedSource(EMB)');
  });

  it('local:不传任何来源字段(与改动前一致)', () => {
    expect(evalIndexedSource(selectEvalEmbedding({}))).toEqual({});
  });
});
