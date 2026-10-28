import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { MemoryStore, publicJobId } from '@repolens/db';
import { MemoryEventSink } from './events.js';
import { processAnalyzeJob } from './queue.js';
import { safeRelPath } from './pipeline/paths.js';
import { runPipeline } from './pipeline/run.js';
import { makeGitRepo, SAMPLE_REPO, testConfig } from './test-utils.js';

async function setup(files = SAMPLE_REPO) {
  const { url, sha } = makeGitRepo(files);
  const store = new MemoryStore();
  const repo = await store.upsertRepo({ url, owner: 'o', name: 'n' });
  const jobId = publicJobId(repo.id, sha);
  await store.createTask({ jobId, repoId: repo.id, commitSha: sha });
  return { store, data: { jobId, repoId: repo.id, repoUrl: url, commitSha: sha } };
}
const seq = (ev: MemoryEventSink) =>
  ev.events.map((e) => (e.event === 'progress' ? `${e.data.stage}:${e.data.progress}` : e.event));

describe('runPipeline', () => {
  it('完整跑通:阶段顺序、排除规则、资源 import、srcFileId 映射', async () => {
    const { store, data } = await setup();
    const events = new MemoryEventSink();
    const stats = await runPipeline(data, {
      store,
      events,
      config: testConfig(),
      allowFileProtocol: true,
    });
    expect(seq(events)).toEqual([
      'cloning:0',
      'cloning:8',
      'scanning:12',
      'parsing:12',
      'parsing:20',
      'parsing:29',
      'parsing:38',
      'parsing:40',
      'graph_ready:50',
      'graph_ready',
      'summarizing:50',
      'embedding:85',
      'done:100',
      'done',
    ]);
    const pcts = events.events.flatMap((e) => (e.event === 'progress' ? [e.data.progress] : []));
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b)); // 进度单调不减
    expect(stats).toMatchObject({ files: 3, edges: 2, assetImports: 1, resolverMode: 'ts-morph' });
    const g = await store.loadGraph(data.repoId, data.commitSha);
    expect(g.files.map((f) => f.path).sort()).toEqual([
      'src/index.ts',
      'src/types.ts',
      'src/util/b.ts',
    ]);
    const idx = g.files.find((f) => f.path === 'src/index.ts')!;
    expect(g.edges.find((e) => e.srcId === 'f:src/index.ts')?.srcFileId).toBe(idx.id);
    const t = await store.getTask(data.jobId);
    expect(t).toMatchObject({ stage: 'done', progress: 100, attempts: 1 });
    expect(events.events.find((e) => e.event === 'graph_ready')?.data).toEqual({
      jobId: data.jobId,
      repoId: data.repoId,
      graphUrl: `/api/repos/${data.repoId}/graph`,
    });
  });

  it('重试从断点继续:跳过克隆与解析', async () => {
    const { store, data } = await setup();
    const config = testConfig();
    await runPipeline(data, {
      store,
      events: new MemoryEventSink(),
      config,
      allowFileProtocol: true,
    });
    const ev = new MemoryEventSink();
    await runPipeline(
      data,
      { store, events: ev, config, allowFileProtocol: true },
      {
        attemptsMade: 1,
        maxAttempts: 3,
      },
    );
    const msgs = ev.events.flatMap((e) => (e.event === 'progress' ? [e.data.message] : []));
    expect(msgs).toContain('快照已存在,跳过克隆');
    expect(msgs).toContain('图已入库,跳过解析');
    expect((await store.getTask(data.jobId))?.attempts).toBe(2);
  });

  it('超限不可重试:stage_error(scanning)+ done failed', async () => {
    const { store, data } = await setup();
    const ev = new MemoryEventSink();
    await expect(
      runPipeline(
        data,
        { store, events: ev, config: testConfig({ maxFiles: 1 }), allowFileProtocol: true },
        {
          attemptsMade: 0,
          maxAttempts: 3,
        },
      ),
    ).rejects.toMatchObject({ code: 'REPO_TOO_LARGE', retryable: false });
    expect(ev.events.slice(-2)).toEqual([
      {
        event: 'stage_error',
        data: { jobId: data.jobId, stage: 'scanning', message: '源码文件超过上限 1' },
      },
      { event: 'done', data: { jobId: data.jobId, status: 'failed' } },
    ]);
    const t = await store.getTask(data.jobId);
    expect(t).toMatchObject({ stage: 'failed', errorCode: 'REPO_TOO_LARGE' });
    expect(t?.stats.failedStage).toBe('scanning');
  });

  it('网络类错误可重试:非最后一次不置 failed,最后一次才置 failed', async () => {
    const { store, data } = await setup();
    const bad = { ...data, repoUrl: 'file:///nonexistent/repo' };
    const ev = new MemoryEventSink();
    const deps = { store, events: ev, config: testConfig(), allowFileProtocol: true };
    await expect(runPipeline(bad, deps, { attemptsMade: 0, maxAttempts: 3 })).rejects.toMatchObject(
      {
        code: 'CLONE_FAILED',
      },
    );
    expect((await store.getTask(data.jobId))?.stage).toBe('cloning');
    expect(ev.events.at(-1)?.event).toBe('stage_error');
    await expect(runPipeline(bad, deps, { attemptsMade: 2, maxAttempts: 3 })).rejects.toThrow();
    expect((await store.getTask(data.jobId))?.stage).toBe('failed');
    expect(ev.events.at(-1)).toEqual({
      event: 'done',
      data: { jobId: data.jobId, status: 'failed' },
    });
  });

  it('生产配置拒绝 file:// 等非 https 协议', async () => {
    const { store, data } = await setup();
    await expect(
      runPipeline(data, { store, events: new MemoryEventSink(), config: testConfig() }),
    ).rejects.toMatchObject({ code: 'CLONE_FAILED' });
  });

  it('非 TS 仓库:UNSUPPORTED_LANGUAGE,包装为 UnrecoverableError', async () => {
    const { store, data } = await setup({ 'src/a.js': 'export const a = 1;\n' } as never);
    const job = { data, attemptsMade: 0, opts: { attempts: 3 } };
    await expect(
      processAnalyzeJob(job, {
        store,
        events: new MemoryEventSink(),
        config: testConfig(),
        allowFileProtocol: true,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await store.getTask(data.jobId))?.errorCode).toBe('UNSUPPORTED_LANGUAGE');
  });
});

describe('safeRelPath', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['../etc/passwd', null],
    ['src/../../x', null],
    ['/abs', null],
    ['a\0b', null],
    ['a\\b', null],
    ['C:/x', null],
    ['./a', null],
    ['a//b', null],
  ])('%s → %s', (p, want) => expect(safeRelPath(p)).toBe(want));
});
