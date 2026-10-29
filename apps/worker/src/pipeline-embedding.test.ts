import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, publicJobId } from '@repolens/db';
import { FakeEmbedder, MemoryVectorStore, type VectorStore } from '@repolens/rag';
import { MemoryEventSink } from './events.js';
import { runPipeline } from './pipeline/run.js';
import { makeGitRepo, SAMPLE_REPO, testConfig } from './test-utils.js';

async function setup() {
  const { url, sha } = makeGitRepo({
    ...SAMPLE_REPO,
    'src/big.ts': `export const big = '${'x'.repeat(600 * 1024)}';\n`,
  });
  const store = new MemoryStore();
  const repo = await store.upsertRepo({ url, owner: 'o', name: 'n' });
  const jobId = publicJobId(repo.id, sha);
  await store.createTask({ jobId, repoId: repo.id, commitSha: sha });
  return { store, data: { jobId, repoId: repo.id, repoUrl: url, commitSha: sha } };
}
const errs = (ev: MemoryEventSink) =>
  ev.events
    .filter((e) => e.event === 'stage_error')
    .map((e) => e.data as { stage: string; message: string });

describe('embedding 阶段(T-214)', () => {
  it('写入向量库(按批)、超大文件不进;同 commit 重跑复用不再 embedding', async () => {
    const { store, data } = await setup();
    const config = testConfig({
      embedding: { ...testConfig().embedding, batchSize: 1 },
    });
    const embedder = new FakeEmbedder();
    const spy = vi.spyOn(embedder, 'embedDocuments');
    const vectorStore = new MemoryVectorStore();
    const deps = { store, config, embedder, vectorStore, allowFileProtocol: true };
    const ev1 = new MemoryEventSink();
    await runPipeline(data, { ...deps, events: ev1 });
    const paths = [...vectorStore.points.values()].map((p) => p.payload.path).sort();
    expect(paths).toContain('src/index.ts');
    expect(paths).not.toContain('src/big.ts');
    expect(spy.mock.calls.every((c) => c[0].length === 1)).toBe(true);
    const n = spy.mock.calls.length;
    expect(n).toBe(vectorStore.points.size);
    const msgs = ev1.events.flatMap((e) =>
      e.event === 'progress' && e.data.stage === 'embedding' ? [e.data.message ?? ''] : [],
    );
    expect(msgs.at(-1)).toMatch(/^向量化完成:\d+ 块/);
    expect(errs(ev1)).toEqual([]);
    expect((await store.getTask(data.jobId))?.stats).toMatchObject({
      embeddingStatus: 'ready',
      embeddingChunks: vectorStore.points.size,
    });

    // 重跑:删掉解析断点(走图已入库分支),point 数与切块数不同 → 按整文件重建;再跑一次 → 复用
    const root = join(config.workdir, String(data.repoId), data.commitSha);
    rmSync(`${root}.analysis.json`);
    await runPipeline(data, { ...deps, events: new MemoryEventSink() });
    const after = spy.mock.calls.length;
    const ev3 = new MemoryEventSink();
    await runPipeline(data, { ...deps, events: ev3 });
    expect(spy.mock.calls.length).toBe(after);
    expect(JSON.stringify(ev3.events)).toContain('复用');
    expect((await store.getTask(data.jobId))?.stats.embeddingStatus).toBe('reused');
    expect([...vectorStore.points.values()].map((p) => p.payload.path)).not.toContain('src/big.ts');
  });

  it('跨任务复用:同 (repo, commit) 的新任务读最近成功任务的 digest 复用;digest 不同则重建', async () => {
    const { store, data } = await setup();
    const embedder = new FakeEmbedder();
    const spy = vi.spyOn(embedder, 'embedDocuments');
    const vectorStore = new MemoryVectorStore();
    const deps = { store, config: testConfig(), embedder, vectorStore, allowFileProtocol: true };
    await runPipeline(data, { ...deps, events: new MemoryEventSink() });
    const first = spy.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    const digest = (await store.getTask(data.jobId))?.stats.embeddingDigest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // 新任务(不同 jobId,同 repo + commit):本行 stats 为空,只能从上一个成功任务拿到 digest
    const data2 = { ...data, jobId: `${data.jobId}-b` };
    await store.createTask({ jobId: data2.jobId, repoId: data.repoId, commitSha: data.commitSha });
    await runPipeline(data2, { ...deps, events: new MemoryEventSink() });
    expect(spy.mock.calls.length).toBe(first);
    expect((await store.getTask(data2.jobId))?.stats).toMatchObject({
      embeddingStatus: 'reused',
      embeddingDigest: digest,
    });

    // 内容变了(以记录的 digest 不同模拟,如排除规则变化):点数相同也不复用,重建
    for (const id of [data.jobId, data2.jobId]) {
      const t = (await store.getTask(id))!;
      await store.updateTask(id, { stats: { ...t.stats, embeddingDigest: 'stale' } });
    }
    const data3 = { ...data, jobId: `${data.jobId}-c` };
    await store.createTask({ jobId: data3.jobId, repoId: data.repoId, commitSha: data.commitSha });
    await runPipeline(data3, { ...deps, events: new MemoryEventSink() });
    expect(spy.mock.calls.length).toBe(first * 2);
    expect((await store.getTask(data3.jobId))?.stats.embeddingStatus).toBe('ready');
  });

  it('向量库失败只发 stage_error,任务仍 done', async () => {
    const { store, data } = await setup();
    const broken: VectorStore = {
      ...new MemoryVectorStore(),
      ensureCollection: async () => {
        throw new Error('Qdrant GET /collections/code_chunks 返回 503');
      },
    } as unknown as VectorStore;
    const events = new MemoryEventSink();
    await runPipeline(data, {
      store,
      events,
      config: testConfig(),
      embedder: new FakeEmbedder(),
      vectorStore: broken,
      allowFileProtocol: true,
    });
    expect((await store.getTask(data.jobId))?.stage).toBe('done');
    expect((await store.getTask(data.jobId))?.stats.embeddingStatus).toBe('failed');
    expect(errs(events)).toEqual([
      { jobId: data.jobId, stage: 'embedding', message: expect.stringContaining('向量化失败') },
    ]);
  });

  it('未配置向量库时跳过', async () => {
    const { store, data } = await setup();
    const events = new MemoryEventSink();
    await runPipeline(data, { store, events, config: testConfig(), allowFileProtocol: true });
    expect(JSON.stringify(events.events)).toContain('未配置向量库,跳过向量化');
    expect((await store.getTask(data.jobId))?.stats.embeddingStatus).toBe('skipped');
    expect((await store.getTask(data.jobId))?.stage).toBe('done');
  });
});
