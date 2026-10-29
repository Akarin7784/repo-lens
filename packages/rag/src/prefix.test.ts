import { describe, expect, it } from 'vitest';
import { CachedEmbedder, MemoryEmbeddingKv, embKey } from './cache.js';
import { EMBEDDING_DIM } from './config.js';
import { FakeEmbedder, OnnxEmbedder, type Extractor } from './embedder.js';

// 断言用字面量,不引用 E5_PREFIX:把前缀改成空串时这里必须失败
function capturingOnnx() {
  const sent: string[][] = [];
  const ext: Extractor = async (texts) => {
    sent.push(texts);
    return { tolist: () => texts.map(() => new Array<number>(EMBEDDING_DIM).fill(0.1)) };
  };
  return { emb: new OnnxEmbedder('m', '/nonexistent', async () => ext), sent };
}

describe('e5 前缀', () => {
  it('embedDocuments 送进模型的文本以 `passage: ` 开头', async () => {
    const { emb, sent } = capturingOnnx();
    await emb.embedDocuments(['function a() {}', 'b']);
    expect(sent).toEqual([['passage: function a() {}', 'passage: b']]);
  });
  it('embedQuery 送进模型的文本以 `query: ` 开头', async () => {
    const { emb, sent } = capturingOnnx();
    await emb.embedQuery('where is a');
    expect(sent).toEqual([['query: where is a']]);
  });
  it('FakeEmbedder 同样区分前缀:同一文本 query 与 passage 向量不同', async () => {
    const f = new FakeEmbedder();
    expect(await f.embedQuery('x y')).not.toEqual((await f.embedDocuments(['x y']))[0]);
  });
  it('同一文本两种 role 缓存键不同,且各自命中各自的键', async () => {
    expect(embKey('m', 'query', 't')).not.toBe(embKey('m', 'passage', 't'));
    expect(embKey('m', 'query', 't')).toMatch(/^emb:m:query:[0-9a-f]{64}$/);
    expect(embKey('m', 'passage', 't')).toMatch(/^emb:m:passage:[0-9a-f]{64}$/);
    const kv = new MemoryEmbeddingKv();
    const { emb, sent } = capturingOnnx();
    const c = new CachedEmbedder(emb, kv);
    await c.embedQuery('t');
    await c.embedDocuments(['t']);
    expect(sent).toEqual([['query: t'], ['passage: t']]);
    expect([...kv.m.keys()].sort()).toEqual(
      [embKey('m', 'passage', 't'), embKey('m', 'query', 't')].sort(),
    );
  });
});
