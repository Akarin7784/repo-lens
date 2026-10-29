import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, publicJobId } from '@repolens/db';
import {
  FakeEmbedder,
  MemoryVectorStore,
  embedLockKey,
  type LockKv,
  type VectorStore,
} from '@repolens/rag';
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
const progressMessages = (ev: MemoryEventSink) =>
  ev.events
    .filter((e) => e.event === 'progress')
    .map((e) => (e.data as { message?: string }).message);
const errs = (ev: MemoryEventSink) =>
  ev.events
    .filter((e) => e.event === 'stage_error')
    .map((e) => e.data as { stage: string; message: string });

/**
 * 进程内 LockKv:按脚本内容模拟 lock.ts 的几个 Lua 脚本(不连 Redis),只用于 pipeline 层测试。
 * renewOk=false 模拟续期/持锁校验失败(丢锁)。
 */
class MemLockKv implements LockKv {
  m = new Map<string, string>();
  /** NX 被拒次数(说明调用方确实走了等待路径) */
  nxRejected = 0;
  /** 同步点:第一次 NX 被拒时回调一次(例如释放「另一任务」的锁),不依赖任何延迟 */
  onFirstReject?: () => void;
  constructor(public renewOk = true) {}
  async set(k: string, v: string) {
    if (this.m.has(k)) {
      if (this.nxRejected++ === 0) this.onFirstReject?.();
      return null;
    }
    this.m.set(k, v);
    return 'OK' as const;
  }
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async del(k: string) {
    return this.m.delete(k) ? 1 : 0;
  }
  async eval(script: string, n: number, ...args: string[]) {
    const keys = args.slice(0, n);
    const argv = args.slice(n);
    const mine = this.m.get(keys[0]!) === argv[0];
    if (script.includes('pexpire')) return mine && this.renewOk ? 1 : 0;
    if (script.includes("'del'")) return mine ? (this.m.delete(keys[0]!), 1) : 0;
    if (mine && this.renewOk) {
      this.m.set(keys[1]!, argv[1]!);
      return 1;
    }
    return 0;
  }
}

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

  it('未配置向量库时仍写 code_chunk(关键词检索数据源),超大文件不进', async () => {
    const { store, data } = await setup();
    await runPipeline(data, {
      store,
      events: new MemoryEventSink(),
      config: testConfig(),
      allowFileProtocol: true,
    });
    const rows = await store.listCodeChunks(data.repoId, data.commitSha);
    expect(rows.map((r) => r.path)).toContain('src/index.ts');
    expect(rows.map((r) => r.path)).not.toContain('src/big.ts');
    expect((await store.getTask(data.jobId))?.stats.codeChunks).toBe(rows.length);
  });

  it('锁等待超时:embeddingStatus=failed,只有一个 stage_error,任务仍 done', async () => {
    const { store, data } = await setup();
    const kv = new MemLockKv();
    kv.m.set(embedLockKey(data.repoId, data.commitSha), 'other');
    const events = new MemoryEventSink();
    const config = testConfig({ embedding: { ...testConfig().embedding, lockMaxWaitSec: 1 } });
    await runPipeline(data, {
      store,
      events,
      config,
      embedder: new FakeEmbedder(),
      vectorStore: new MemoryVectorStore(),
      lockKv: kv,
      lockPollMs: 20,
      allowFileProtocol: true,
    });
    const t = await store.getTask(data.jobId);
    expect(t?.stage).toBe('done');
    expect(t?.stats.embeddingStatus).toBe('failed');
    expect(errs(events)).toEqual([
      { jobId: data.jobId, stage: 'embedding', message: expect.stringContaining('等待同 commit') },
    ]);
  });

  it('丢锁:embeddingStatus=failed,只有一个 stage_error,不写完成标记', async () => {
    const { store, data } = await setup();
    const kv = new MemLockKv(false);
    const events = new MemoryEventSink();
    const vectorStore = new MemoryVectorStore();
    await runPipeline(data, {
      store,
      events,
      config: testConfig(),
      embedder: new FakeEmbedder(),
      vectorStore,
      lockKv: kv,
      lockPollMs: 20,
      allowFileProtocol: true,
    });
    const t = await store.getTask(data.jobId);
    expect(t?.stage).toBe('done');
    expect(t?.stats.embeddingStatus).toBe('failed');
    expect(errs(events)).toEqual([
      { jobId: data.jobId, stage: 'embedding', message: expect.stringContaining('已丢失') },
    ]);
    expect(vectorStore.points.size).toBe(0);
    expect(kv.m.has(`${embedLockKey(data.repoId, data.commitSha)}:done`)).toBe(false);
  });

  it('等待者复用前核对点数:完成标记 digest 一致但点数不符 → failed', async () => {
    const { store, data } = await setup();
    const vectorStore = new MemoryVectorStore();
    const deps = {
      store,
      config: testConfig(),
      embedder: new FakeEmbedder(),
      vectorStore,
      allowFileProtocol: true,
    };
    await runPipeline(data, { ...deps, events: new MemoryEventSink() });
    const digest = (await store.getTask(data.jobId))?.stats.embeddingDigest as string;
    // 另一任务"持锁"并写好与本次相同 digest 的完成标记后释放,但向量库被清掉一个点
    const kv = new MemLockKv();
    const key = embedLockKey(data.repoId, data.commitSha);
    kv.m.set(key, 'other');
    kv.m.set(`${key}:done`, digest);
    const pointsBefore = vectorStore.points.size;
    vectorStore.points.delete([...vectorStore.points.keys()][0]!);
    // 同步点:等待者第一次抢锁被拒之后才释放,保证走「等待 → 复用核对」路径,与流水线快慢无关
    kv.onFirstReject = () => kv.m.delete(key);
    await store.createTask({
      jobId: `${data.jobId}-w`,
      repoId: data.repoId,
      commitSha: data.commitSha,
    });
    const events = new MemoryEventSink();
    await runPipeline(
      { ...data, jobId: `${data.jobId}-w` },
      { ...deps, events, lockKv: kv, lockPollMs: 20 },
    );
    expect(errs(events)).toEqual([
      {
        jobId: `${data.jobId}-w`,
        stage: 'embedding',
        message: expect.stringContaining('复用校验失败'),
      },
    ]);
    expect(kv.nxRejected).toBeGreaterThanOrEqual(1);
    expect(progressMessages(events)).toContain('等待同 commit 的另一任务完成向量化');
    // 没有自己拿锁重建(ran:false):缺的那个点没被补回,完成标记仍是持有者写的
    expect(vectorStore.points.size).toBe(pointsBefore - 1);
    expect(kv.m.get(`${key}:done`)).toBe(digest);
  });

  it('等待者到达时锁已释放:自己拿锁重建,补齐点数,无报错', async () => {
    const { store, data } = await setup();
    const vectorStore = new MemoryVectorStore();
    const deps = {
      store,
      config: testConfig(),
      embedder: new FakeEmbedder(),
      vectorStore,
      allowFileProtocol: true,
    };
    await runPipeline(data, { ...deps, events: new MemoryEventSink() });
    const digest = (await store.getTask(data.jobId))?.stats.embeddingDigest as string;
    const total = vectorStore.points.size;
    // 另一任务已完成并释放锁(只留完成标记),但向量库少了一个点
    const kv = new MemLockKv();
    const key = embedLockKey(data.repoId, data.commitSha);
    kv.m.set(`${key}:done`, digest);
    vectorStore.points.delete([...vectorStore.points.keys()][0]!);
    await store.createTask({
      jobId: `${data.jobId}-w`,
      repoId: data.repoId,
      commitSha: data.commitSha,
    });
    const events = new MemoryEventSink();
    await runPipeline(
      { ...data, jobId: `${data.jobId}-w` },
      { ...deps, events, lockKv: kv, lockPollMs: 20 },
    );
    expect(errs(events)).toEqual([]);
    expect(kv.nxRejected).toBe(0);
    expect(progressMessages(events)).not.toContain('等待同 commit 的另一任务完成向量化');
    expect(vectorStore.points.size).toBe(total);
    expect(kv.m.has(key)).toBe(false);
    expect(kv.m.get(`${key}:done`)).toBe(digest);
    const t = await store.getTask(`${data.jobId}-w`);
    expect(t?.stats.embeddingStatus).toBe('ready');
  });
});
