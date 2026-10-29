import { describe, expect, it } from 'vitest';
import { FakeEmbedder } from './embedder.js';
import { hybridSearch, rrf, tokenize, type RetrievableChunk } from './retrieval.js';
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
});
