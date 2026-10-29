import { describe, expect, it } from 'vitest';
import { MemoryStore, publicJobId } from '@repolens/db';
import {
  CachedEmbedder,
  DashscopeEmbedder,
  MemoryEmbeddingKv,
  MemoryVectorStore,
  MeteredEmbedder,
  TokenBucket,
  readEmbeddingConfig,
  type TaskBudgetMeter,
} from '@repolens/rag';
import { MemoryEventSink } from './events.js';
import { runEmbedding, runPipeline, type PipelineDeps } from './pipeline/run.js';
import { makeGitRepo, SAMPLE_REPO, testConfig } from './test-utils.js';

// T-214c(b):外部提供方在 pipeline 里的接线。全部用假 fetch,不连真实接口、不用真实 key。
const FAKE_KEY = 'test-key-not-real';
const AWS = 'AKIAFAKEFAKEFAKE3333';
const RAW = 'RAW_THIRD_PARTY_BODY_9f1c';

type Body = { input: string[]; model: string; dimensions: number };
function fakeApi(o: { fail?: (n: number) => boolean; usage?: boolean } = {}) {
  const bodies: Body[] = [];
  const ok: Body[] = [];
  const fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Body;
    bodies.push(b);
    if (o.fail?.(bodies.length))
      return new Response(JSON.stringify({ error: { message: RAW, code: 'InvalidParameter' } }), {
        status: 400,
      });
    ok.push(b);
    return new Response(
      JSON.stringify({
        data: b.input.map((_, i) => ({ index: i, embedding: new Array(b.dimensions).fill(i + 1) })),
        ...(o.usage === false ? {} : { usage: { total_tokens: 5 * b.input.length } }),
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies, ok };
}

async function setup(env: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const { url, sha } = makeGitRepo({
    ...SAMPLE_REPO,
    'src/aws.ts': `export const id = '${AWS}';\n`,
    '.env': `TOKEN=${AWS}\n`,
    ...extra,
  });
  const store = new MemoryStore();
  const repo = await store.upsertRepo({ url, owner: 'o', name: 'n' });
  const jobId = publicJobId(repo.id, sha);
  await store.createTask({ jobId, repoId: repo.id, commitSha: sha });
  const embedding = readEmbeddingConfig({
    EMBEDDING_PROVIDER: 'dashscope',
    DASHSCOPE_API_KEY: FAKE_KEY,
    // 固定 v3:本用例需要 64 维(qwen3.7 不支持),不随默认模型变化
    DASHSCOPE_EMBEDDING_MODEL: 'text-embedding-v3',
    DASHSCOPE_EMBEDDING_DIM: '64',
    EMBEDDING_BATCH_SIZE: '2',
    ...env,
  });
  const config = testConfig({ embedding });
  return { store, config, data: { jobId, repoId: repo.id, repoUrl: url, commitSha: sha } };
}

function wire(
  config: ReturnType<typeof testConfig>,
  api: ReturnType<typeof fakeApi>,
  kv = new MemoryEmbeddingKv(),
) {
  const ds = config.embedding.dashscope!;
  const sleep = async () => {};
  const e = new DashscopeEmbedder(
    { ...ds, apiKey: ds.apiKey! },
    { fetch: api.fetch, sleep, backoffMs: 0, bucket: new TokenBucket(1e9, () => 0, sleep) },
  );
  return {
    embedder: new CachedEmbedder(e, kv),
    taskEmbedder: (m: TaskBudgetMeter) => new CachedEmbedder(new MeteredEmbedder(e, m), kv),
    kv,
  };
}

const errs = (ev: MemoryEventSink) =>
  ev.events.filter((e) => e.event === 'stage_error').map((e) => e.data as { message: string });

describe('pipeline 外部 embedding(T-214c b)', () => {
  it('ready:按上限分批、stats 记提供方/模型/维度/usage;只发送排除规则过滤后的块', async () => {
    const { store, config, data } = await setup();
    const api = fakeApi();
    const vectorStore = new MemoryVectorStore();
    const deps = {
      store,
      config,
      vectorStore,
      allowFileProtocol: true,
      ...wire(config, api),
    } as Omit<PipelineDeps, 'events'>;
    await runPipeline(data, { ...deps, events: new MemoryEventSink() });
    const stats = (await store.getTask(data.jobId))!.stats;
    expect(stats).toMatchObject({
      embeddingStatus: 'ready',
      embeddingProvider: 'dashscope',
      embeddingModel: 'text-embedding-v3',
      embeddingDim: 64,
      embeddingTokenSource: 'usage',
    });
    const sent = api.bodies.flatMap((b) => b.input);
    expect(stats.embeddingTokens).toBe(5 * sent.length);
    expect(api.bodies.length).toBeGreaterThan(1);
    expect(api.bodies.every((b) => b.input.length <= 2 && b.dimensions === 64)).toBe(true);
    expect(api.bodies.every((b) => b.model === 'text-embedding-v3')).toBe(true);
    expect(sent.every((t) => t.trim() !== '')).toBe(true);
    expect(sent.join('\n')).not.toContain(AWS);
    expect(sent.some((t) => t.startsWith('src/aws.ts') || t.startsWith('.env'))).toBe(false);
    expect(sent.some((t) => t.startsWith('src/index.ts'))).toBe(true);
    expect(vectorStore.points.size).toBe(sent.length);
  });

  it('中途失败:已成功的批已写缓存,重跑不重复请求;stats / 事件不含第三方原始响应体', async () => {
    const { store, config, data } = await setup();
    const kv = new MemoryEmbeddingKv();
    const vectorStore = new MemoryVectorStore();
    const base = { store, config, vectorStore, allowFileProtocol: true } as Omit<
      PipelineDeps,
      'events'
    >;
    const a1 = fakeApi({ fail: (n) => n === 2 });
    const ev1 = new MemoryEventSink();
    await runPipeline(data, { ...base, ...wire(config, a1, kv), events: ev1 });
    const s1 = (await store.getTask(data.jobId))!.stats;
    expect(s1).toMatchObject({
      embeddingStatus: 'failed',
      embeddingErrorKind: 'bad-request',
      embeddingErrorStatus: 400,
    });
    expect(JSON.stringify(s1)).not.toContain(RAW);
    expect(JSON.stringify(ev1.events)).not.toContain(RAW);
    expect(JSON.stringify(s1) + JSON.stringify(ev1.events)).not.toContain(FAKE_KEY);
    const firstOk = a1.ok.flatMap((b) => b.input);
    expect(firstOk.length).toBeGreaterThan(0);

    const a2 = fakeApi();
    await runPipeline(data, { ...base, ...wire(config, a2, kv), events: new MemoryEventSink() });
    expect((await store.getTask(data.jobId))!.stats.embeddingStatus).toBe('ready');
    const second = a2.bodies.flatMap((b) => b.input);
    for (const t of firstOk) expect(second).not.toContain(t);
    // 两次成功请求合起来每块恰好一次
    const all = [...firstOk, ...second];
    expect(new Set(all).size).toBe(all.length);
    expect(vectorStore.points.size).toBe(all.length);
  });

  it('响应缺 usage:按上界估算,stats 标 estimate', async () => {
    const { store, config, data } = await setup();
    const api = fakeApi({ usage: false });
    const deps = {
      store,
      config,
      vectorStore: new MemoryVectorStore(),
      allowFileProtocol: true,
      ...wire(config, api),
    } as Omit<PipelineDeps, 'events'>;
    await runPipeline(data, { ...deps, events: new MemoryEventSink() });
    const stats = (await store.getTask(data.jobId))!.stats;
    expect(stats.embeddingTokenSource).toBe('estimate');
    const chars = api.bodies.flatMap((b) => b.input).reduce((s, t) => s + t.length, 0);
    expect(stats.embeddingTokens).toBe(chars);
  });

  it('预算用尽:不发请求,embeddingStatus=skipped 且 stats 记原因 budget', async () => {
    const { store, config, data } = await setup({ EMBEDDING_TASK_BUDGET_CENTS: '0' });
    const api = fakeApi();
    const ev = new MemoryEventSink();
    const deps = {
      store,
      config,
      vectorStore: new MemoryVectorStore(),
      allowFileProtocol: true,
      ...wire(config, api),
    } as Omit<PipelineDeps, 'events'>;
    await runPipeline(data, { ...deps, events: ev });
    expect(api.bodies).toHaveLength(0);
    expect((await store.getTask(data.jobId))!.stats).toMatchObject({
      embeddingStatus: 'skipped',
      embeddingSkipReason: 'budget',
      embeddingProvider: 'dashscope',
    });
    expect(errs(ev).some((e) => e.message.includes('预算'))).toBe(true);
  });

  it('缺 key:skipped + 告警(原因 no-key),不调用外部接口', async () => {
    const { store, config, data } = await setup({ DASHSCOPE_API_KEY: '' });
    expect(config.embedding.dashscope!.apiKey).toBeUndefined();
    const api = fakeApi();
    const ev = new MemoryEventSink();
    await runPipeline(data, {
      store,
      config,
      vectorStore: new MemoryVectorStore(),
      embedder: new CachedEmbedder(
        new DashscopeEmbedder(
          { ...config.embedding.dashscope!, apiKey: 'x' },
          { fetch: api.fetch },
        ),
        new MemoryEmbeddingKv(),
      ),
      embeddingSkipReason: 'no-key',
      allowFileProtocol: true,
      events: ev,
    } as PipelineDeps);
    expect(api.bodies).toHaveLength(0);
    expect((await store.getTask(data.jobId))!.stats).toMatchObject({
      embeddingStatus: 'skipped',
      embeddingSkipReason: 'no-key',
    });
    expect(errs(ev).some((e) => e.message.includes('DASHSCOPE_API_KEY'))).toBe(true);
  });
  it('local 与 dashscope 批量取不同值:EMBEDDING_BATCH_SIZE=20 时 dashscope 单批不超过 10', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 14 }, (_, k) => [`src/m${k}.ts`, `export const m${k} = ${k};\n`]),
    );
    const { store, config, data } = await setup({ EMBEDDING_BATCH_SIZE: '20' }, many);
    expect(config.embedding.batchSize).toBe(20);
    expect(config.embedding.dashscope!.batchSize).toBe(10);
    const api = fakeApi();
    const deps = {
      store,
      config,
      vectorStore: new MemoryVectorStore(),
      allowFileProtocol: true,
      ...wire(config, api),
    } as Omit<PipelineDeps, 'events'>;
    await runPipeline(data, { ...deps, events: new MemoryEventSink() });
    expect((await store.getTask(data.jobId))!.stats.embeddingStatus).toBe('ready');
    const sizes = api.bodies.map((b) => b.input.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
    expect(Math.max(...sizes)).toBe(10);
  });

  it('空白 chunk 不会被发出:空串与纯空白块在发送前过滤', async () => {
    const { store, config, data } = await setup();
    const api = fakeApi();
    const vectorStore = new MemoryVectorStore();
    const chunk = (path: string, text: string) => ({
      path,
      symbol: null,
      startLine: 1,
      endLine: 1,
      text,
      contentHash: `h-${path}`,
    });
    const prepared = {
      chunks: [
        chunk('src/a.ts', 'src/a.ts\nexport const a = 1;'),
        chunk('src/empty.ts', ''),
        chunk('src/blank.ts', '  \n\t '),
        chunk('src/b.ts', 'src/b.ts\nexport const b = 2;'),
      ],
      excluded: [],
    };
    const deps = { store, config, vectorStore, ...wire(config, api) } as unknown as PipelineDeps;
    const r = await runEmbedding(data, deps, '/nonexistent', async () => {}, null, prepared);
    const sent = api.bodies.flatMap((b) => b.input);
    expect(sent).toHaveLength(2);
    expect(sent.every((t) => t.trim() !== '')).toBe(true);
    expect(r.chunks).toBe(2);
    expect(await vectorStore.count(data.repoId, data.commitSha)).toBe(2);
  });
});
