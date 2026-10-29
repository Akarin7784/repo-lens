import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CHUNKER_VERSION } from '@repolens/shared';
import {
  CURRENT_EMBEDDING_VERSIONS,
  CachedEmbedder,
  DEFAULT_EMBEDDING_MODEL_REVISION,
  EMBED_TEXT_VERSION,
  FakeEmbedder,
  MemoryEmbeddingKv,
  MemoryVectorStore,
  chunksDigest,
  indexChunks,
  readEmbeddingConfig,
} from './index.js';

const chunks = Array.from({ length: 4 }, (_, i) => ({
  path: `src/v${i}.ts`,
  symbol: `v${i}`,
  startLine: 1,
  endLine: 3,
  text: `src/v${i}.ts v${i}\nexport const v${i} = ${i};`,
  contentHash: `h${i}`,
}));

describe('embedding 版本:切块版本 / 文本模板版本 / 模型 revision 进 digest 与复用判断', () => {
  const cur = CURRENT_EMBEDDING_VERSIONS;
  const emb = { model: 'm', revision: 'r1' };

  it('当前版本取自 CHUNKER_VERSION 与 EMBED_TEXT_VERSION', () => {
    expect(cur).toEqual({ chunker: CHUNKER_VERSION, embedText: EMBED_TEXT_VERSION });
  });

  it('三者任一变化 digest 都变;都不变时 digest 稳定且与块顺序无关', () => {
    const d = chunksDigest(emb, chunks);
    expect(chunksDigest(emb, [...chunks].reverse())).toBe(d);
    const variants = [
      chunksDigest(emb, chunks, { ...cur, chunker: cur.chunker + 1 }),
      chunksDigest(emb, chunks, { ...cur, embedText: cur.embedText + 1 }),
      chunksDigest({ ...emb, revision: 'r2' }, chunks),
    ];
    for (const v of variants) expect(v).not.toBe(d);
    expect(new Set(variants).size).toBe(3);
  });

  it.each([
    ['切块版本', { chunker: CHUNKER_VERSION - 1 }, 'fake'],
    ['文本模板版本', { embedText: EMBED_TEXT_VERSION - 1 }, 'fake'],
    ['模型 revision', {}, 'old-revision'],
  ])('%s 不同的上次 digest:点数相同也不复用、重建', async (_n, v, oldRev) => {
    const store = new MemoryVectorStore();
    const old = new FakeEmbedder('fake-384', oldRev);
    await indexChunks({ repoId: 1, commitSha: 'c', chunks, batchSize: 8 }, old, store);
    const prevDigest = chunksDigest(old, chunks, { ...cur, ...v });
    const now = new FakeEmbedder();
    const spy = vi.spyOn(now, 'embedDocuments');
    const r = await indexChunks(
      { repoId: 1, commitSha: 'c', chunks, batchSize: 8, prevDigest },
      now,
      store,
    );
    expect(await store.count(1, 'c')).toBe(chunks.length);
    expect(r.reused).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    // 版本一致时才复用
    const again = await indexChunks(
      { repoId: 1, commitSha: 'c', chunks, batchSize: 8, prevDigest: r.digest },
      now,
      store,
    );
    expect(again.reused).toBe(true);
  });

  it('配置:onnx 默认 revision 与 Dockerfile 一致,可覆盖;fake 为 fake', () => {
    expect(readEmbeddingConfig({ EMBEDDER: 'onnx' }).revision).toBe(
      DEFAULT_EMBEDDING_MODEL_REVISION,
    );
    expect(
      readEmbeddingConfig({ EMBEDDER: 'onnx', EMBEDDING_MODEL_REVISION: 'abc' }).revision,
    ).toBe('abc');
    expect(readEmbeddingConfig({}).revision).toBe('fake');
    const docker = readFileSync(
      fileURLToPath(new URL('../../../apps/worker/Dockerfile', import.meta.url)),
      'utf8',
    );
    const revs = [...docker.matchAll(/EMBEDDING_MODEL_REVISION=(\w+)/g)].map((m) => m[1]);
    expect(revs.length).toBe(2); // 下载阶段 + 运行时 ENV
    expect(new Set(revs)).toEqual(new Set([DEFAULT_EMBEDDING_MODEL_REVISION]));
    expect(docker).toMatch(/^ENV EMBEDDING_MODEL_REVISION=\$EMBEDDING_MODEL_REVISION$/m);
  });

  it('向量缓存键含 revision:换 revision 不命中旧向量', async () => {
    const kv = new MemoryEmbeddingKv();
    const a = new FakeEmbedder('m', 'r1');
    const b = new FakeEmbedder('m', 'r2');
    await new CachedEmbedder(a, kv).embedDocuments(['x']);
    await new CachedEmbedder(b, kv).embedDocuments(['x']);
    expect(b.encoded).toBe(1);
    expect([...kv.m.keys()].sort()).toEqual([
      expect.stringMatching(/^emb:m@r1:passage:/),
      expect.stringMatching(/^emb:m@r2:passage:/),
    ]);
  });
});
