import { describe, expect, it } from 'vitest';
import { FakeEmbedder } from './embedder.js';
import { DashscopeEmbedder, QUERY_CALL, TokenBucket } from './dashscope.js';
import {
  EXACT_MAX,
  embeddingMismatch,
  bm25,
  buildKeywordIndex,
  exactMatches,
  hybridSearch,
  rrf,
  stem,
  tokenize,
  type RetrievableChunk,
} from './retrieval.js';
import { MemoryVectorStore, pointId } from './vector-store.js';

const mk = (path: string, symbol: string | null, content: string): RetrievableChunk => ({
  path,
  symbol,
  startLine: 1,
  endLine: 5,
  content: `${path} ${symbol ?? ''}\n${content}`,
  qdrantPointId: pointId(1, 'c', { path, symbol, start_line: 1, end_line: 5 }),
});
const CHUNKS = [
  mk('src/db/pool.ts', 'createPool', 'export function createPool(opts) { return new Pool(opts) }'),
  mk('src/cli/args.ts', 'parseArgs', 'export function parseArgs(argv: string[]) { /* flags */ }'),
  mk('src/util/str.ts', 'trim', 'export const trim = (s) => s.trim()'),
];

async function vectors() {
  const emb = new FakeEmbedder();
  const vs = new MemoryVectorStore();
  const vecs = await emb.embedDocuments(CHUNKS.map((c) => c.content));
  await vs.upsert(
    CHUNKS.map((c, i) => ({
      id: c.qdrantPointId,
      vector: vecs[i]!,
      payload: {
        repo_id: 1,
        commit_sha: 'c',
        path: c.path,
        symbol: c.symbol,
        start_line: 1,
        end_line: 5,
        content_hash: String(i),
      },
    })),
  );
  return { emb, vs };
}
const base = { repoId: 1, commitSha: 'c', chunks: CHUNKS };

describe('混合检索 hybridSearch(T-214)', () => {
  it('tokenize 拆 camelCase、去停用词', () => {
    expect(tokenize('where is createPool defined')).toEqual(['create', 'pool', 'createpool']);
  });

  it('rrf:多路同时靠前的排第一', () => {
    const s = rrf([['a', 'b'], ['b', 'a'], ['b']]);
    expect([...s.entries()].sort((x, y) => y[1] - x[1])[0]![0]).toBe('b');
  });

  it('embeddingStatus=ready:hybrid,关键词与精确匹配把 parseArgs 排第一', async () => {
    const { emb, vs } = await vectors();
    const r = await hybridSearch({
      ...base,
      question: '命令行参数的解析逻辑?',
      rewritten: 'parse command line arguments argv parseArgs',
      embeddingStatus: 'ready',
      embedder: emb,
      vectorStore: vs,
    });
    expect(r.retrieval).toBe('hybrid');
    expect(r.hits[0]).toMatchObject({ path: 'src/cli/args.ts', symbol: 'parseArgs' });
    expect(r.hits[0]!.sources).toEqual(expect.arrayContaining(['vector', 'keyword', 'exact']));
  });

  it.each(['skipped', 'failed', null])(
    'embeddingStatus=%s:keyword-only,不查向量、不抛错',
    async (status) => {
      const { emb, vs } = await vectors();
      let searched = 0;
      const spy = { ...vs, search: async () => (searched++, []) } as unknown as MemoryVectorStore;
      const r = await hybridSearch({
        ...base,
        question: 'createPool',
        rewritten: 'createPool',
        embeddingStatus: status,
        embedder: emb,
        vectorStore: spy,
      });
      expect(r.retrieval).toBe('keyword-only');
      expect(r.degradedReason).toBe(`status:${status ?? 'none'}`);
      expect(searched).toBe(0);
      expect(r.hits[0]?.symbol).toBe('createPool');
    },
  );

  it('向量查询出错时降级 keyword-only,不抛错', async () => {
    const { emb } = await vectors();
    const broken = { search: async () => Promise.reject(new Error('qdrant down')) };
    const r = await hybridSearch({
      ...base,
      question: 'pool',
      rewritten: 'pool',
      embeddingStatus: 'reused',
      embedder: emb,
      vectorStore: broken as never,
    });
    expect(r).toMatchObject({ retrieval: 'keyword-only', degradedReason: 'vector-error' });
    expect(r.hits[0]?.path).toBe('src/db/pool.ts');
  });

  it('未配置向量库 / 无切块:keyword-only,空结果', async () => {
    const r = await hybridSearch({
      ...base,
      chunks: [],
      question: 'x',
      rewritten: 'x',
      embeddingStatus: 'ready',
    });
    expect(r).toEqual({ retrieval: 'keyword-only', hits: [], degradedReason: 'no-vector-store' });
  });

  it('stem:router 不并入 route;复数/-ing/-ed 归一;短词不动', () => {
    expect(stem('router')).toBe('router');
    expect(stem('routers')).toBe('router');
    expect(new Set(['route', 'routes', 'routing', 'routed'].map(stem))).toEqual(new Set(['rout']));
    expect(stem('cookie')).toBe(stem('cookies'));
    expect(stem('match')).toBe(stem('matches'));
    expect(['ts', 'js', 'bus', 'class'].map(stem)).toEqual(['ts', 'js', 'bus', 'class']);
  });

  it('BM25:查询 route 不命中只含 router 的块;单字符词不入索引', () => {
    const cs = [
      mk('src/a/router.ts', 'Router', 'class Router {}'),
      mk('src/b/route.ts', 'route', 'function route() {}'),
    ];
    const idx = buildKeywordIndex(cs);
    expect(bm25(idx, 'route', 5).map(([i]) => i)).toEqual([1]);
    expect([...idx.df.keys()].every((t) => t.length >= 2)).toBe(true);
    expect(bm25(idx, 'x y z', 5)).toEqual([]);
  });

  it('精确匹配按文件去重并封顶,符号命中排在路径命中前', () => {
    const cs = [
      mk('src/store.ts', 'Store.get', 'get() {}'),
      mk('src/store.ts', 'Store.put', 'put() {}'),
      mk('src/other/store.ts', 'helper', ''),
      ...Array.from({ length: 30 }, (_, i) => mk(`src/m${i}.ts`, 'makeStore', '')),
    ];
    const r = exactMatches(cs, 'other/store.ts makeStore put', 50);
    expect(r.length).toBe(EXACT_MAX);
    expect(new Set(r.map((i) => cs[i]!.path)).size).toBe(r.length);
    expect(r[0]).toBe(3); // 第一个 makeStore 符号命中
    expect(r).not.toContain(2); // 路径命中排在符号命中之后,已被上限截掉
    const few = exactMatches(cs.slice(0, 3), 'other/store.ts Store.put getStore', 50);
    expect(few).toEqual([2]);
    expect(exactMatches(cs.slice(0, 3), 'src/store.ts', 50)).toEqual([0]);
  });
});

describe('hybridSearch 提供方降级(T-214c)', () => {
  it('索引提供方与当前 embedder 不一致:keyword-only(provider-mismatch),不查向量', async () => {
    const { emb, vs } = await vectors();
    let searched = 0;
    const spy = { ...vs, search: async () => (searched++, []) } as unknown as MemoryVectorStore;
    const r = await hybridSearch({
      ...base,
      question: 'createPool',
      rewritten: 'createPool',
      embeddingStatus: 'ready',
      embedder: emb,
      vectorStore: spy,
      indexedProvider: 'dashscope',
    });
    expect(r).toMatchObject({ retrieval: 'keyword-only', degradedReason: 'provider-mismatch' });
    expect(searched).toBe(0);
    expect(r.hits[0]?.symbol).toBe('createPool');
  });

  it('未记录 indexedProvider 视为 local:local embedder 仍走 hybrid', async () => {
    const { emb, vs } = await vectors();
    const r = await hybridSearch({
      ...base,
      question: 'q',
      rewritten: 'parse command line arguments argv parseArgs',
      embeddingStatus: 'ready',
      embedder: emb,
      vectorStore: vs,
      indexedProvider: null,
    });
    expect(r.retrieval).toBe('hybrid');
  });

  it('dashscope embedQuery 失败(5 秒超时 / 429 等,重试 1 次后仍失败):keyword-only(vector-error)', async () => {
    const { vs } = await vectors();
    let calls = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const ds = new DashscopeEmbedder(
      {
        apiKey: 'test-key-not-real',
        baseUrl: 'https://example.invalid/v1',
        model: 'text-embedding-v3',
        dim: 384,
        batchSize: 10,
        tpm: 1_000_000,
        taskBudgetCents: 50,
      },
      {
        fetch: (async () => {
          calls++;
          throw new DOMException('timed out', 'TimeoutError');
        }) as unknown as typeof fetch,
        sleep,
        bucket: new TokenBucket(1e9, () => 0, sleep),
      },
    );
    const r = await hybridSearch({
      ...base,
      question: 'createPool',
      rewritten: 'createPool',
      embeddingStatus: 'ready',
      embedder: ds,
      vectorStore: vs,
      indexedProvider: 'dashscope',
      indexedModel: 'text-embedding-v3',
      indexedDim: 384,
    });
    expect(r).toMatchObject({ retrieval: 'keyword-only', degradedReason: 'vector-error' });
    expect(calls).toBe(1 + QUERY_CALL.retries);
    // 最坏耗时上界:两次 5 秒超时 + 一次退避(≤1.25 秒;429 时 Retry-After ≤2 秒)≤ 12 秒
    expect(QUERY_CALL.timeoutMs * (1 + QUERY_CALL.retries) + QUERY_CALL.maxRetryAfterMs).toBe(
      12_000,
    );
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(QUERY_CALL.maxRetryAfterMs);
  });
});

describe('embedding 同源比较 model/dim(P4-b)', () => {
  const ds = { provider: 'dashscope' as const, model: 'dashscope:text-embedding-v3', dim: 1024 };
  it('dashscope:provider/model/dim 全一致(model 去掉 dashscope: 前缀比较)', () => {
    expect(
      embeddingMismatch(ds, { provider: 'dashscope', model: 'text-embedding-v3', dim: 1024 }),
    ).toBeNull();
  });
  it('dashscope:model 不同 → model-mismatch;dim 不同 → dim-mismatch', () => {
    expect(
      embeddingMismatch(ds, { provider: 'dashscope', model: 'qwen3.7-text-embedding', dim: 1024 }),
    ).toBe('model-mismatch');
    expect(
      embeddingMismatch(ds, { provider: 'dashscope', model: 'text-embedding-v3', dim: 512 }),
    ).toBe('dim-mismatch');
  });
  it('dashscope 旧任务缺 model 或 dim:视为不一致', () => {
    expect(embeddingMismatch(ds, { provider: 'dashscope', dim: 1024 })).toBe('model-mismatch');
    expect(embeddingMismatch(ds, { provider: 'dashscope', model: 'text-embedding-v3' })).toBe(
      'dim-mismatch',
    );
  });
  it('local 缺 model/dim:视为一致(与改动前行为相同);provider 不同仍优先报 provider-mismatch', async () => {
    const { emb } = await vectors();
    expect(embeddingMismatch(emb, {})).toBeNull();
    expect(embeddingMismatch(emb, { provider: null, model: null, dim: null })).toBeNull();
    expect(embeddingMismatch(ds, { model: 'x', dim: 1 })).toBe('provider-mismatch');
  });
  it('hybridSearch 读取 indexedModel/indexedDim:不一致时 keyword-only 且不查向量', async () => {
    const { vs } = await vectors();
    let searched = 0;
    let embedded = 0;
    const spy = { ...vs, search: async () => (searched++, []) } as unknown as MemoryVectorStore;
    const fake = {
      ...ds,
      embedQuery: async () => (embedded++, new Array(1024).fill(0)),
    } as unknown as Parameters<typeof hybridSearch>[0]['embedder'];
    for (const [m, d, why] of [
      ['qwen3.7-text-embedding', 1024, 'model-mismatch'],
      ['text-embedding-v3', 64, 'dim-mismatch'],
    ] as const) {
      const r = await hybridSearch({
        ...base,
        question: 'createPool',
        rewritten: 'createPool',
        embeddingStatus: 'ready',
        embedder: fake,
        vectorStore: spy,
        indexedProvider: 'dashscope',
        indexedModel: m,
        indexedDim: d,
      });
      expect(r).toMatchObject({ retrieval: 'keyword-only', degradedReason: why });
    }
    expect(searched).toBe(0);
    expect(embedded).toBe(0);
  });
});
