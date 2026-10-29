import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { DEFAULT_PRICES, FakeLlm, LlmGateway, MemoryLlmKv } from '@repolens/agent';
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
      'summarizing:54',
      'summarizing:59',
      'summarizing:64',
      'summarizing:69',
      'summarizing:74',
      'summarizing:79',
      'summarizing:84',
      'summarizing:85',
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

  it('非 TS/JS 仓库(Python):UNSUPPORTED_LANGUAGE,包装为 UnrecoverableError', async () => {
    const { store, data } = await setup({
      'main.py': 'print(1)\n',
      'lib/util.py': 'x = 1\n',
    } as never);
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

describe('summarizing(T-211)', () => {
  const gw = (store: MemoryStore, o: { price?: number; task?: number } = {}) => {
    const client = new FakeLlm();
    const gateway = new LlmGateway({
      client,
      kv: new MemoryLlmKv(),
      usage: store,
      prices: o.price ? { fake: { inputPerMTok: o.price, outputPerMTok: 0 } } : DEFAULT_PRICES,
      dailyBudgetCents: 1_000_000,
      taskBudgetCents: o.task ?? 30,
    });
    return { client, gateway };
  };

  it('done 后 module 摘要非空;同 commit 重跑不新增 llm_usage、不调模型', async () => {
    const { store, data } = await setup();
    const { client, gateway } = gw(store);
    const config = testConfig();
    const events = new MemoryEventSink();
    await runPipeline(data, { store, events, config, gateway, allowFileProtocol: true });
    expect(events.events.some((e) => e.event === 'stage_error')).toBe(false);
    const rows = await store.listSummaries(data.repoId);
    const mod = rows.find((r) => r.targetId.startsWith('m:'));
    expect(mod?.level).toBe('dir');
    expect(mod?.content).toMatch(/fake summary/);
    expect(rows.find((r) => r.level === 'repo')?.content.length).toBeGreaterThan(0);
    // T-211c:按当前 commit 存,正常路径 source=llm
    for (const r of rows) expect(r).toMatchObject({ commitSha: data.commitSha, source: 'llm' });
    const task = (await store.getTask(data.jobId))!;
    const usage1 = (await store.llmUsageByTask(task.id)).length;
    expect(usage1).toBe(rows.length);
    const calls = client.calls;

    // 重跑时 worker 只按输入哈希逐节点查(findSummaryByInput),不整表读所有 commit
    let listed = 0;
    const orig = store.listSummaries.bind(store);
    store.listSummaries = async (id) => (listed++, orig(id));
    await runPipeline(data, {
      store,
      events: new MemoryEventSink(),
      config,
      gateway,
      allowFileProtocol: true,
    });
    expect((await store.llmUsageByTask(task.id)).length).toBe(usage1);
    expect(client.calls).toBe(calls);
    expect(listed).toBe(0);
    store.listSummaries = orig;
  });

  it('预算熔断:改用规则摘要,只发一次 stage_error(summarizing),任务仍 done', async () => {
    const { store, data } = await setup();
    const { gateway } = gw(store, { price: 1_000_000 });
    const events = new MemoryEventSink();
    await runPipeline(data, {
      store,
      events,
      config: testConfig(),
      gateway,
      allowFileProtocol: true,
    });
    const errs = events.events.filter((e) => e.event === 'stage_error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.data).toMatchObject({ stage: 'summarizing' });
    expect(events.events.at(-1)).toMatchObject({ event: 'done', data: { status: 'done' } });
    const rows = await store.listSummaries(data.repoId);
    expect(rows.some((r) => r.model === 'rule')).toBe(true);
    for (const r of rows) expect(r.content.length).toBeGreaterThan(0);
    // T-211c:熔断降级行 source=rule
    for (const r of rows) expect(r.source).toBe(r.model === 'rule' ? 'rule' : 'llm');
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
