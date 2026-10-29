import { describe, expect, it, vi } from 'vitest';
import {
  CachedEmbedder,
  FakeEmbedder,
  MemoryEmbeddingKv,
  MemoryVectorStore,
  QdrantVectorStore,
  buildChunks,
  embKey,
  indexChunks,
  readEmbeddingConfig,
  type Embedder,
} from './index.js';

const SECRET = 'AKIA' + 'ABCDEFGHIJKLMNOP';

describe('readEmbeddingConfig', () => {
  it('默认 fake、批大小 16、无 Qdrant', () => {
    const c = readEmbeddingConfig({});
    expect(c).toMatchObject({ provider: 'fake', batchSize: 16, qdrant: null });
  });
  it('onnx + 批大小 + Qdrant;空串按缺省处理', () => {
    const c = readEmbeddingConfig({
      EMBEDDER: 'onnx',
      EMBEDDING_MODEL: '',
      EMBEDDING_BATCH_SIZE: '8',
      QDRANT_URL: 'http://qdrant:6333',
      QDRANT_API_KEY: 'k',
    });
    expect(c.model).toBe('Xenova/multilingual-e5-small');
    expect(c.batchSize).toBe(8);
    expect(c.qdrant).toEqual({ url: 'http://qdrant:6333', apiKey: 'k', collection: 'code_chunks' });
  });
  it('非法值报变量名不回显值', () => {
    expect(() => readEmbeddingConfig({ EMBEDDING_BATCH_SIZE: '0' })).toThrow(
      /EMBEDDING_BATCH_SIZE/,
    );
    expect(() => readEmbeddingConfig({ EMBEDDER: 'openai' })).toThrow(/EMBEDDER/);
    try {
      readEmbeddingConfig({ QDRANT_URL: 'not a url secretvalue' });
    } catch (e) {
      expect(String(e)).not.toContain('secretvalue');
    }
  });
});

describe('Embedder 前缀与缓存', () => {
  it('query / passage 前缀不同,384 维且归一化', async () => {
    const e = new FakeEmbedder();
    const q = await e.embedQuery('cors middleware');
    const [d] = await e.embedDocuments(['cors middleware']);
    expect(q).toHaveLength(384);
    expect(Math.hypot(...q)).toBeCloseTo(1, 5);
    expect(q).not.toEqual(d);
  });
  it('缓存键 emb:{model}:{role}:{hash},命中后不再编码', async () => {
    expect(embKey('m', 'query', 'x')).toMatch(/^emb:m:query:[0-9a-f]{64}$/);
    const inner = new FakeEmbedder();
    const kv = new MemoryEmbeddingKv();
    const e = new CachedEmbedder(inner, kv);
    const a = await e.embedDocuments(['a b', 'c d']);
    expect(inner.encoded).toBe(2);
    const b = await e.embedDocuments(['c d', 'a b', 'e f']);
    expect(inner.encoded).toBe(3);
    expect(b[0]![0]).toBeCloseTo(a[1]![0]!, 6);
    await e.embedQuery('a b');
    expect(inner.encoded).toBe(4); // 同文本的 query 角色不复用 passage 缓存
    expect([...kv.m.keys()].filter((k) => k.includes(':query:'))).toHaveLength(1);
  });
});

describe('buildChunks 排除规则', () => {
  const src: Record<string, string> = {
    'src/a.ts': 'export function a() {\n  return 1;\n}\n',
    'src/keys.ts': `export const k = '${SECRET}';\n`,
    'src/big.ts': 'x'.repeat(600 * 1024),
    'src/bin.ts': 'a\u0000b\u0000c',
    '.env': 'A=1',
  };
  const files = [
    { path: 'src/a.ts', chunks: [{ symbol: 'a', startLine: 1, endLine: 3 }] },
    { path: 'src/keys.ts', chunks: [{ symbol: 'k', startLine: 1, endLine: 1 }] },
    { path: 'src/big.ts', chunks: [{ symbol: null, startLine: 1, endLine: 1 }] },
    { path: 'src/bin.ts', chunks: [{ symbol: null, startLine: 1, endLine: 1 }] },
    { path: '.env', chunks: [], sensitive: 'env-file' },
    { path: 'src/gone.ts', chunks: [{ symbol: null, startLine: 1, endLine: 1 }] },
  ];
  it('敏感 / 超大 / 二进制 / 读不到的文件不进 chunk,也不进向量库', async () => {
    const read = vi.fn(async (p: string) => src[p] ?? null);
    const r = await buildChunks(files, read);
    expect(r.chunks.map((c) => c.path)).toEqual(['src/a.ts']);
    expect(r.chunks[0]!.text).toBe('src/a.ts a\nexport function a() {\n  return 1;\n}');
    expect(r.excluded.map((x) => x.path).sort()).toEqual(
      ['.env', 'src/big.ts', 'src/bin.ts', 'src/gone.ts', 'src/keys.ts'].sort(),
    );
    expect(read).not.toHaveBeenCalledWith('.env');
    for (const c of r.chunks) expect(c.text).not.toContain(SECRET);

    const store = new MemoryVectorStore();
    const emb = new FakeEmbedder();
    const spy = vi.spyOn(emb, 'embedDocuments');
    await indexChunks({ repoId: 1, commitSha: 'c1', chunks: r.chunks, batchSize: 4 }, emb, store);
    const sent = spy.mock.calls.flat(2).join('\n');
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain('\u0000');
    expect([...store.points.values()].map((p) => p.payload.path)).toEqual(['src/a.ts']);
  });
});

describe('buildChunks:analyzer 已标敏感但仍带切块', () => {
  it('按 sensitive 标记拒绝,且不读源文件', async () => {
    const read = vi.fn(async () => 'export const harmless = 1;\n');
    const r = await buildChunks(
      [
        {
          path: 'src/x.ts',
          chunks: [{ symbol: null, startLine: 1, endLine: 1 }],
          sensitive: 'secret-content',
        },
      ],
      read,
    );
    expect(r.chunks).toEqual([]);
    expect(r.excluded).toEqual([{ path: 'src/x.ts', rule: 'secret-content' }]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('indexChunks', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => ({
    path: `src/f${i}.ts`,
    symbol: `f${i}`,
    startLine: 1,
    endLine: 2,
    text: `src/f${i}.ts f${i}\nfunction f${i}() {}`,
    contentHash: String(i),
  }));
  it('按 batchSize 分批;同 commit 重跑复用;不同 commit 互不影响', async () => {
    const store = new MemoryVectorStore();
    const emb = new FakeEmbedder();
    const spy = vi.spyOn(emb, 'embedDocuments');
    const r1 = await indexChunks({ repoId: 1, commitSha: 'c1', chunks, batchSize: 2 }, emb, store);
    expect(r1).toMatchObject({ chunks: 5, reused: false });
    expect(r1.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(spy.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 1]);
    const r2 = await indexChunks(
      { repoId: 1, commitSha: 'c1', chunks, batchSize: 2, prevDigest: r1.digest },
      emb,
      store,
    );
    expect(r2).toEqual({ chunks: 5, reused: true, digest: r1.digest });
    expect(spy).toHaveBeenCalledTimes(3);
    await indexChunks(
      { repoId: 1, commitSha: 'c2', chunks: chunks.slice(0, 2), batchSize: 8 },
      emb,
      store,
    );
    expect(await store.count(1, 'c1')).toBe(5);
    expect(await store.count(1, 'c2')).toBe(2);
    const q = await emb.embedQuery('f3');
    const hits = await store.search(1, 'c1', q, 1);
    expect(hits[0]!.payload.path).toBe('src/f3.ts');
  });
  it('点数相同但内容 hash 汇总不同(如排除规则变化)时不复用、重建', async () => {
    const store = new MemoryVectorStore();
    const emb = new FakeEmbedder();
    const r1 = await indexChunks({ repoId: 1, commitSha: 'c1', chunks, batchSize: 8 }, emb, store);
    const changed = chunks.map((c, i) => (i === 0 ? { ...c, contentHash: 'changed' } : c));
    const spy = vi.spyOn(emb, 'embedDocuments');
    const r2 = await indexChunks(
      { repoId: 1, commitSha: 'c1', chunks: changed, batchSize: 8, prevDigest: r1.digest },
      emb,
      store,
    );
    expect(r2.reused).toBe(false);
    expect(r2.digest).not.toBe(r1.digest);
    expect(spy).toHaveBeenCalledTimes(1);
    // 没有上次的汇总(旧任务)也不复用
    const r3 = await indexChunks(
      { repoId: 1, commitSha: 'c1', chunks: changed, batchSize: 8 },
      emb,
      store,
    );
    expect(r3.reused).toBe(false);
  });
  it('上次中途失败(point 数不齐)时删掉旧 point 重建', async () => {
    const store = new MemoryVectorStore();
    const flaky: Embedder = new FakeEmbedder();
    let n = 0;
    const orig = flaky.embedDocuments.bind(flaky);
    flaky.embedDocuments = async (t) => {
      if (++n === 2) throw new Error('boom');
      return orig(t);
    };
    await expect(
      indexChunks({ repoId: 1, commitSha: 'c1', chunks, batchSize: 2 }, flaky, store),
    ).rejects.toThrow('boom');
    expect(await store.count(1, 'c1')).toBe(2);
    const r = await indexChunks({ repoId: 1, commitSha: 'c1', chunks, batchSize: 2 }, flaky, store);
    expect(r.reused).toBe(false);
    expect(await store.count(1, 'c1')).toBe(5);
  });
});

describe('QdrantVectorStore', () => {
  it('建 collection(dense/384/Cosine)+ payload index,api-key 走请求头,按 repo+commit 过滤', async () => {
    const calls: { method: string; url: string; body: unknown; key: string | undefined }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      calls.push({
        method: init.method!,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        key: h['api-key'],
      });
      if (init.method === 'GET') return new Response('{}', { status: 404 });
      if (url.includes('/points/count'))
        return new Response(JSON.stringify({ result: { count: 0 } }));
      return new Response('{"result":true}');
    }) as unknown as typeof fetch;
    const s = new QdrantVectorStore(
      { url: 'http://q:6333/', apiKey: 'test-key', collection: 'code_chunks' },
      fetchFn,
    );
    await indexChunks(
      {
        repoId: 7,
        commitSha: 'abc',
        chunks: [
          { path: 'a.ts', symbol: null, startLine: 1, endLine: 1, text: 'a', contentHash: 'h' },
        ],
        batchSize: 8,
      },
      new FakeEmbedder(),
      s,
    );
    expect(calls.every((c) => c.key === 'test-key')).toBe(true);
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      url: 'http://q:6333/collections/code_chunks',
      body: { vectors: { dense: { size: 384, distance: 'Cosine' } } },
    });
    expect(
      calls
        .filter((c) => c.url.includes('/index'))
        .map((c) => (c.body as { field_name: string }).field_name),
    ).toEqual(['repo_id', 'commit_sha', 'path']);
    const count = calls.find((c) => c.url.includes('/points/count'))!;
    expect(JSON.stringify(count.body)).toContain('"repo_id","match":{"value":7}');
    const up = calls.find((c) => c.url.endsWith('/points?wait=true'))!;
    const pt = (up.body as { points: { id: string; vector: { dense: number[] } }[] }).points[0]!;
    expect(pt.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(pt.vector.dense).toHaveLength(384);
  });
  it('错误信息不含 api-key 与请求体', async () => {
    const s = new QdrantVectorStore(
      { url: 'http://q:6333', apiKey: 'test-key', collection: 'c' },
      (async () => new Response('bad', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(s.count(1, 'x')).rejects.toThrow(
      /^Qdrant POST \/collections\/c\/points\/count 返回 500$/,
    );
  });
});
