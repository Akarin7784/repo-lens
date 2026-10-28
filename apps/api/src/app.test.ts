import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  GraphDataSchema,
  HealthResponseSchema,
  NodeDetailSchema,
  RepoStatusSchema,
  CreateRepoResponseSchema,
} from '@repolens/shared';
import { MemoryStore, publicJobId, redisKeys, type GraphInput } from '@repolens/db';
import { buildApp, type AnalyzeJobData, type JobQueue } from './app.js';
import { createGitHost, parseLsRemote, type GitHost } from './githost.js';

describe('GET /health', () => {
  it('返回 ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(HealthResponseSchema.parse(res.json()).status).toBe('ok');
    await app.close();
  });
});

describe('githost', () => {
  it('parseLsRemote 解析 HEAD / 分支 / 附注标签', () => {
    const a = 'a'.repeat(40),
      b = 'b'.repeat(40),
      c = 'c'.repeat(40);
    const out = `${a}\tHEAD\n${b}\trefs/heads/main\n${b}\trefs/tags/v1\n${c}\trefs/tags/v1^{}\n`;
    expect(parseLsRemote(out)).toBe(a);
    expect(parseLsRemote(out, 'main')).toBe(b);
    expect(parseLsRemote(out, 'v1')).toBe(c);
    expect(parseLsRemote(out, 'nope')).toBeNull();
  });
  it('真实 git ls-remote(本地仓库)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rl-ls-'));
    writeFileSync(join(dir, 'a.ts'), 'export {}\n');
    const g = (...a: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        encoding: 'utf8',
      }).trim();
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g('commit', '-qm', 'x');
    const sha = g('rev-parse', 'HEAD');
    const host = createGitHost();
    expect(await host.lsRemote(dir)).toBe(sha);
    expect(await host.lsRemote(dir, 'main')).toBe(sha);
    expect(await host.lsRemote(join(dir, 'missing'))).toBeNull();
  });
});

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
async function redisUp() {
  const r = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
  });
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const hasRedis = await redisUp();
if (!hasRedis) console.warn(`[api] Redis 不可达(${REDIS_URL}),跳过依赖 Redis 的路由测试`);

const SHA = '1'.repeat(40);
let ipSeq = 0;
const nextIp = () => `10.${process.pid % 250}.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

describe.skipIf(!hasRedis)('路由(真实 Redis + 内存 Store)', () => {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  let store: MemoryStore;
  let jobs: AnalyzeJobData[];
  let git: GitHost & {
    sha: string | null;
    info: { sizeKb: number | null; language: string | null } | null;
  };
  const queue: JobQueue = {
    enqueue: async (d) => void jobs.push(d),
    removeFailed: async () => {},
  };
  const make = () => buildApp({ store, redis, queue, git, logger: false, pingIntervalMs: 50 });
  beforeEach(() => {
    store = new MemoryStore();
    jobs = [];
    git = {
      sha: SHA,
      info: { sizeKb: 100, language: 'TypeScript' },
      lsRemote: async () => git.sha,
      repoInfo: async () => git.info,
    };
  });
  afterAll(() => redis.disconnect());

  const post = (app: ReturnType<typeof make>, repoUrl: string, ip = nextIp()) =>
    app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { repoUrl },
      headers: { 'x-forwarded-for': ip },
    });

  it('POST 202 入队,重复提交同 commit 返回 200 且不重复入队', async () => {
    const app = make();
    const r1 = await post(app, 'https://github.com/pmndrs/zustand.git');
    expect(r1.statusCode).toBe(202);
    const b = CreateRepoResponseSchema.parse(r1.json());
    expect(b).toMatchObject({
      status: 'queued',
      repo: 'pmndrs/zustand',
      commitSha: SHA,
      jobId: `${b.repoId}:${SHA}`,
    });
    expect(jobs).toEqual([
      {
        jobId: b.jobId,
        repoId: b.repoId,
        repoUrl: 'https://github.com/pmndrs/zustand',
        commitSha: SHA,
      },
    ]);
    const r2 = await post(app, 'https://github.com/pmndrs/zustand');
    expect(r2.statusCode).toBe(200);
    expect(r2.json().jobId).toBe(b.jobId);
    expect(jobs).toHaveLength(1);
    await app.close();
  });

  it('失败任务再次提交会重置并重新入队', async () => {
    const app = make();
    const b = (await post(app, 'https://github.com/a/b')).json();
    await store.updateTask(b.jobId, { stage: 'failed', errorMsg: 'x' });
    const r = await post(app, 'https://github.com/a/b');
    expect(r.statusCode).toBe(202);
    expect(jobs).toHaveLength(2);
    expect((await store.getTask(b.jobId))?.stage).toBe('queued');
    await app.close();
  });

  it.each([
    ['https://gitlab.com/a/b'],
    ['http://github.com/a/b'],
    ['https://github.com/a/b/tree/main'],
    ['https://github.com/../b'],
    ['not a url'],
  ])('400 INVALID_REPO_URL: %s', async (u) => {
    const app = make();
    const r = await post(app, u);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REPO_URL');
    await app.close();
  });

  it('404 / 413 / 422', async () => {
    const app = make();
    git.sha = null;
    expect((await post(app, 'https://github.com/a/nope')).json().error.code).toBe('REPO_NOT_FOUND');
    git.sha = SHA;
    git.info = { sizeKb: 400 * 1024, language: 'TypeScript' };
    expect((await post(app, 'https://github.com/a/big')).statusCode).toBe(413);
    git.info = { sizeKb: 1, language: 'Python' };
    const r = await post(app, 'https://github.com/a/py');
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('UNSUPPORTED_LANGUAGE');
    git.info = null; // GitHub API 不可用时不阻塞
    expect((await post(app, 'https://github.com/a/ok')).statusCode).toBe(202);
    await app.close();
  });

  it('429:同一 IP 每小时第 6 次', async () => {
    const app = make();
    const ip = nextIp();
    await redis.del(redisKeys.rateLimitIp(ip));
    for (let i = 0; i < 5; i++)
      expect((await post(app, `https://github.com/a/r${i}`, ip)).statusCode).toBe(202);
    const r = await post(app, 'https://github.com/a/r6', ip);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('RATE_LIMITED');
    expect(await redis.ttl(redisKeys.rateLimitIp(ip))).toBeGreaterThan(3500);
    await app.close();
  });

  async function seedGraph() {
    const repo = await store.upsertRepo({ url: 'https://github.com/o/g', owner: 'o', name: 'g' });
    const jobId = publicJobId(repo.id, SHA);
    await store.createTask({ jobId, repoId: repo.id, commitSha: SHA });
    const f = (path: string, moduleId: string, ext: string[] = []) => ({
      path,
      lang: 'ts',
      loc: 10,
      contentHash: 'h',
      moduleId,
      dirPath: path.split('/').slice(0, -1).join('/') || '.',
      externalDeps: ext,
    });
    const input: GraphInput = {
      files: [
        f('src/a/index.ts', 'm:src/a', ['react']),
        f('src/a/x/deep.ts', 'm:src/a'),
        f('src/b/index.ts', 'm:src/b', ['react', 'zod']),
        f('src/b/util.ts', 'm:src/b'),
        f('main.ts', 'm:.'),
      ],
      symbols: [
        {
          path: 'src/b/util.ts',
          name: 'helper',
          kind: 'function',
          startLine: 1,
          endLine: 3,
          exported: true,
        },
      ],
      edges: [
        {
          srcId: 'f:src/a/index.ts',
          dstId: 'f:src/b/util.ts',
          kind: 'static',
          srcPath: 'src/a/index.ts',
        },
        {
          srcId: 'f:src/a/x/deep.ts',
          dstId: 'f:src/b/util.ts',
          kind: 'type-only',
          srcPath: 'src/a/x/deep.ts',
        },
        {
          srcId: 'f:src/a/x/deep.ts',
          dstId: 'f:src/b/index.ts',
          kind: 'static',
          srcPath: 'src/a/x/deep.ts',
        },
        {
          srcId: 'f:src/a/index.ts',
          dstId: 'f:src/a/x/deep.ts',
          kind: 'static',
          srcPath: 'src/a/index.ts',
        },
        {
          srcId: 'f:src/b/index.ts',
          dstId: 'f:src/b/util.ts',
          kind: 'static',
          srcPath: 'src/b/index.ts',
        },
        {
          srcId: 'f:src/b/util.ts',
          dstId: 'f:src/a/index.ts',
          kind: 'static',
          srcPath: 'src/b/util.ts',
        },
        { srcId: 'f:main.ts', dstId: 'f:src/a/index.ts', kind: 'static', srcPath: 'main.ts' },
      ],
    };
    await store.saveGraph(repo.id, SHA, input);
    await store.updateTask(jobId, {
      stage: 'done',
      progress: 100,
      stats: { files: 5, modules: 3, edges: 7, cycles: [['f:src/a/index.ts', 'f:src/b/util.ts']] },
    });
    for (const k of await redis.keys(redisKeys.graphPattern(repo.id, SHA))) await redis.del(k);
    return { repoId: repo.id, jobId };
  }

  it('GET /api/repos/:id 状态', async () => {
    const app = make();
    const { repoId, jobId } = await seedGraph();
    const r = RepoStatusSchema.parse((await app.inject(`/api/repos/${repoId}`)).json());
    expect(r).toEqual({
      repoId,
      jobId,
      status: 'done',
      stage: 'done',
      progress: 100,
      stats: { files: 5, modules: 3, edges: 7 },
      error: null,
    });
    expect((await app.inject('/api/repos/999')).statusCode).toBe(404);
    await app.close();
  });

  it('图:根层只有 module,边聚合;子层;includeExternal;缓存', async () => {
    const app = make();
    const { repoId } = await seedGraph();
    const r1 = await app.inject(`/api/repos/${repoId}/graph`);
    expect(r1.headers['x-cache']).toBe('miss');
    const g = GraphDataSchema.parse(r1.json());
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['m:.', 'm:src/a', 'm:src/b']);
    const ab = g.edges.find((e) => e.id === 'a:m:src/a->m:src/b')!;
    expect(ab).toMatchObject({
      weight: 3,
      kind: 'static',
      aggregated: true,
      srcFileId: 'f:src/a/index.ts',
    });
    expect(g.edges.every((e) => e.type === 'imports' && e.aggregated)).toBe(true);
    expect(g.nodes.some((n) => n.type === 'external')).toBe(false);
    expect(g.meta.cycles).toEqual([['m:src/a', 'm:src/b']]);
    expect((await app.inject(`/api/repos/${repoId}/graph`)).headers['x-cache']).toBe('hit');

    const sub = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repoId}/graph?parentId=m:src/a`)).json(),
    );
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(['d:src/a/x', 'f:src/a/index.ts']);
    expect(sub.edges).toEqual([
      expect.objectContaining({
        source: 'f:src/a/index.ts',
        target: 'd:src/a/x',
        aggregated: true,
        weight: 1,
      }),
    ]);
    const leaf = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repoId}/graph?parentId=m:src/b`)).json(),
    );
    expect(leaf.edges[0]).toMatchObject({
      id: 'e:f:src/b/index.ts->f:src/b/util.ts:static',
      weight: 1,
    });
    expect(leaf.edges[0]!.aggregated).toBeUndefined();

    const ext = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repoId}/graph?includeExternal=true`)).json(),
    );
    expect(ext.nodes.filter((n) => n.type === 'external').map((n) => [n.id, n.weight])).toEqual([
      ['x:react', 2],
      ['x:zod', 1],
    ]);
    expect(ext.edges.filter((e) => e.target.startsWith('x:')).length).toBe(3);

    expect((await app.inject(`/api/repos/${repoId}/graph?parentId=d:nope`)).statusCode).toBe(404);
    expect((await app.inject(`/api/repos/${repoId}/graph?parentId=f:main.ts`)).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it('图:单层 >300 节点截断(按 weight),x: 占名额', async () => {
    const app = make();
    const repo = await store.upsertRepo({
      url: 'https://github.com/o/big',
      owner: 'o',
      name: 'big',
    });
    const jobId = publicJobId(repo.id, SHA);
    await store.createTask({ jobId, repoId: repo.id, commitSha: SHA });
    const files = Array.from({ length: 420 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}.ts`,
      lang: 'ts',
      loc: 1,
      contentHash: 'h',
      moduleId: 'm:.',
      dirPath: '.',
      externalDeps: [`pkg${i % 60}`],
    }));
    const edges = files.slice(1).map((f) => ({
      srcId: `f:${f.path}`,
      dstId: 'f:f000.ts',
      kind: 'static' as const,
      srcPath: f.path,
    }));
    await store.saveGraph(repo.id, SHA, { files, symbols: [], edges });
    await store.updateTask(jobId, { stage: 'graph_ready', progress: 50 });
    for (const k of await redis.keys(redisKeys.graphPattern(repo.id, SHA))) await redis.del(k);
    const g = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repo.id}/graph?parentId=m:.`)).json(),
    );
    expect(g.nodes).toHaveLength(300);
    expect(g.nodes[0]!.id).toBe('f:f000.ts');
    const e = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repo.id}/graph?parentId=m:.&includeExternal=true`)).json(),
    );
    expect(e.nodes).toHaveLength(300);
    expect(e.nodes.filter((n) => n.type === 'external')).toHaveLength(50);
    await app.close();
  });

  it('图未生成 409,节点详情', async () => {
    const app = make();
    const b = (await post(app, 'https://github.com/a/pending')).json();
    const r = await app.inject(`/api/repos/${b.repoId}/graph`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('REPO_NOT_READY');
    const { repoId } = await seedGraph();
    const d = NodeDetailSchema.parse(
      (await app.inject(`/api/repos/${repoId}/nodes/f:src/b/util.ts`)).json(),
    );
    expect(d).toMatchObject({
      kind: 'file',
      exports: ['helper'],
      inDegree: 3,
      outDegree: 1,
      loc: 10,
    });
    expect(d.topDependents).toEqual(['f:src/a/index.ts', 'f:src/a/x/deep.ts', 'f:src/b/index.ts']);
    const m = NodeDetailSchema.parse(
      (await app.inject(`/api/repos/${repoId}/nodes/m:src/a`)).json(),
    );
    expect(m).toMatchObject({
      kind: 'module',
      loc: 20,
      inDegree: 2,
      outDegree: 2,
      topDependents: ['f:main.ts', 'f:src/b/util.ts'],
    });
    const x = NodeDetailSchema.parse(
      (await app.inject(`/api/repos/${repoId}/nodes/x:react`)).json(),
    );
    expect(x).toMatchObject({ kind: 'external', inDegree: 2 });
    expect((await app.inject(`/api/repos/${repoId}/nodes/f:nope.ts`)).statusCode).toBe(404);
    await app.close();
  });

  describe('SSE', () => {
    async function listen() {
      const app = make();
      await app.listen({ port: 0, host: '127.0.0.1' });
      return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
    }
    async function readAll(res: Response) {
      return await res.text();
    }

    it('XREAD 推送 + ping + done 后关闭 + Last-Event-ID 续传', async () => {
      const { app, base } = await listen();
      const repo = await store.upsertRepo({
        url: 'https://github.com/o/sse',
        owner: 'o',
        name: 'sse',
      });
      const jobId = publicJobId(repo.id, SHA);
      await store.createTask({ jobId, repoId: repo.id, commitSha: SHA });
      const key = redisKeys.jobEvents(jobId);
      await redis.del(key);
      const add = (event: string, data: object) =>
        redis.xadd(key, 'MAXLEN', '~', '500', '*', 'event', event, 'data', JSON.stringify(data));
      const id1 = await add('progress', { jobId, stage: 'cloning', progress: 0 });
      const res = await fetch(`${base}/api/jobs/${jobId}/events`);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      setTimeout(() => void add('done', { jobId, status: 'done' }), 200);
      const body = await readAll(res);
      expect(body).toContain(`id: ${id1}\nevent: progress\n`);
      expect(body).toContain(': ping');
      expect(body.trim().endsWith(`"status":"done"}`)).toBe(true);
      const again = await readAll(
        await fetch(`${base}/api/jobs/${jobId}/events`, { headers: { 'last-event-id': id1! } }),
      );
      expect(again).not.toContain('event: progress');
      expect(again).toContain('event: done');
      await app.close();
    });

    it('流已过期且任务已结束:由 DB 合成终态;未知 job 404', async () => {
      const { app, base } = await listen();
      const { jobId } = await seedGraph();
      await redis.del(redisKeys.jobEvents(jobId));
      const body = await readAll(await fetch(`${base}/api/jobs/${jobId}/events`));
      expect(body).toContain('event: graph_ready');
      expect(body).toContain('event: done');
      expect((await fetch(`${base}/api/jobs/1:${'f'.repeat(40)}/events`)).status).toBe(404);
      expect((await fetch(`${base}/api/jobs/garbage/events`)).status).toBe(404);
      await app.close();
    });
  });
});
