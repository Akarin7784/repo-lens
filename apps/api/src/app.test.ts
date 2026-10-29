import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
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
  ApiErrorSchema,
} from '@repolens/shared';
import {
  GRAPH_PROJECTION_VERSION,
  MemoryStore,
  publicJobId,
  redisKeys,
  type GraphInput,
} from '@repolens/db';
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
// 限流 key(rl:ip:/rl:sub:{ip}:{hour})按 IP 计数,共享 Redis 上会跨次运行累积。
// 每次运行随机取一段 IP(10.a.b.x),每个请求都带独立 IP,避免误报 429。
const IP_BASE = randomInt(0, 250 * 200);
let ipSeq = 0;
const nextIp = () => {
  const n = IP_BASE * 250 + ++ipSeq;
  return `10.${Math.floor(n / 62500) % 250}.${Math.floor(n / 250) % 250}.${n % 250}`;
};

describe.skipIf(!hasRedis)('路由(真实 Redis + 内存 Store)', () => {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  let store: MemoryStore;
  let jobs: AnalyzeJobData[];
  let git: GitHost & {
    sha: string | null;
    info:
      | { sizeKb: number | null; language: string | null; private?: boolean | null }
      | 'not-found'
      | null;
  };
  const queue: JobQueue = {
    enqueue: async (d) => void jobs.push(d),
    removeFailed: async () => {},
  };
  const make = () => {
    const app = buildApp({ store, redis, queue, git, logger: false, pingIntervalMs: 50 });
    // 未显式带 x-forwarded-for 的请求补一个独立 IP,不落到共享的 127.0.0.1 计数上
    const inject = app.inject.bind(app) as (o: unknown) => ReturnType<typeof app.inject>;
    const withIp = (o: string | { headers?: Record<string, string> }) =>
      typeof o === 'string'
        ? { url: o, headers: { 'x-forwarded-for': nextIp() } }
        : { ...o, headers: { 'x-forwarded-for': nextIp(), ...o.headers } };
    app.inject = ((o: string | { headers?: Record<string, string> }) =>
      inject(withIp(o))) as unknown as typeof app.inject;
    return app;
  };
  beforeEach(() => {
    store = new MemoryStore();
    jobs = [];
    git = {
      sha: SHA,
      info: { sizeKb: 100, language: 'TypeScript' },
      lsRemote: async () => git.sha,
      repoInfo: async () =>
        git.info === 'not-found' ? 'not-found' : git.info && { private: null, ...git.info },
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

  it.each([
    ['缺 repoUrl', { ref: 'main' }],
    ['空对象', {}],
    ['ref 为空串', { repoUrl: 'https://github.com/a/b', ref: '' }],
    ['ref 非字符串', { repoUrl: 'https://github.com/a/b', ref: 1 }],
    ['未知结构', [1, 2]],
  ])('400 BAD_REQUEST(非仓库地址的校验错误): %s', async (_n, payload) => {
    const app = make();
    const r = await app.inject({ method: 'POST', url: '/api/repos', payload });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('repoUrl 非字符串仍是 INVALID_REPO_URL;非法 JSON 是 BAD_REQUEST', async () => {
    const app = make();
    const r1 = await app.inject({ method: 'POST', url: '/api/repos', payload: { repoUrl: 42 } });
    expect([r1.statusCode, r1.json().error.code]).toEqual([400, 'INVALID_REPO_URL']);
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/repos',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect([r2.statusCode, r2.json().error.code]).toEqual([400, 'BAD_REQUEST']);
    await app.close();
  });

  it('框架自带的 4xx 保留原状态码,code 统一 BAD_REQUEST', async () => {
    const app = make();
    const r415 = await app.inject({
      method: 'POST',
      url: '/api/repos',
      headers: { 'content-type': 'application/xml' },
      payload: '<repoUrl>https://github.com/a/b</repoUrl>',
    });
    expect([r415.statusCode, r415.json().error.code]).toEqual([415, 'BAD_REQUEST']);
    const r413 = await app.inject({
      method: 'POST',
      url: '/api/repos',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ repoUrl: 'https://github.com/a/b', pad: 'x'.repeat(1_100_000) }),
    });
    expect([r413.statusCode, r413.json().error.code]).toEqual([413, 'BAD_REQUEST']);
    expect(jobs).toHaveLength(0);
    await app.close();
  });

  it('repoInfo 返回 private:true → 422 REPO_NOT_PUBLIC,不建仓库不建任务不入队', async () => {
    const app = make();
    git.info = { sizeKb: 1, language: 'TypeScript', private: true };
    const r = await post(app, 'https://github.com/a/secret');
    expect(r.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(r.json())).toEqual({
      error: { code: 'REPO_NOT_PUBLIC', message: '只支持公开仓库' },
    });
    expect(jobs).toHaveLength(0);
    expect(await store.getRepo(1)).toBeFalsy(); // 新 MemoryStore,没建任何仓库
    // private:false / 未知(null)照常入队
    git.info = { sizeKb: 1, language: 'TypeScript', private: false };
    expect((await post(app, 'https://github.com/a/pub')).statusCode).toBe(202);
    git.info = { sizeKb: 1, language: 'TypeScript', private: null };
    expect((await post(app, 'https://github.com/a/pub2')).statusCode).toBe(202);
    await app.close();
  });

  it('repoInfo 拿不到(404 → null)且 ls-remote 也失败:仍是 REPO_NOT_FOUND,不区分私有与不存在', async () => {
    const app = make();
    git.sha = null;
    git.info = null;
    const r = await post(app, 'https://github.com/a/maybe-private');
    expect([r.statusCode, r.json().error.code]).toEqual([404, 'REPO_NOT_FOUND']);
    await app.close();
  });

  it('SHA ref + repoInfo 明确 404:REPO_NOT_FOUND,不建仓库/任务、不扣 rl:ip;403/5xx/网络错误(null)照常放行', async () => {
    const app = make();
    git.sha = SHA; // ref 是 40 位 SHA 时 lsRemote 原样返回,不联网
    git.info = 'not-found';
    const ip = nextIp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { repoUrl: 'https://github.com/a/private-or-missing', ref: SHA },
      headers: { 'x-forwarded-for': ip },
    });
    expect([r.statusCode, r.json().error.code]).toEqual([404, 'REPO_NOT_FOUND']);
    expect(jobs).toHaveLength(0);
    expect(await store.getRepo(1)).toBeFalsy();
    expect(await redis.get(redisKeys.rateLimitIp(ip))).toBeNull();
    // 其他失败(githost 归一为 null)不拒绝
    git.info = null;
    const ok = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { repoUrl: 'https://github.com/a/public', ref: SHA },
      headers: { 'x-forwarded-for': ip },
    });
    expect(ok.statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
    expect(await redis.get(redisKeys.rateLimitIp(ip))).toBe('1');
    await app.close();
  });

  it('createGitHost.repoInfo:只有 404 归为 not-found;403、5xx、网络错误为 null', async () => {
    const host = (f: () => Promise<Response>) =>
      createGitHost({ fetch: f as unknown as typeof fetch });
    const resp = (status: number, body: unknown = {}) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    expect(await host(() => resp(404)).repoInfo('a', 'b')).toBe('not-found');
    expect(
      await host(() => resp(403, { message: 'API rate limit exceeded' })).repoInfo('a', 'b'),
    ).toBeNull();
    expect(await host(() => resp(500)).repoInfo('a', 'b')).toBeNull();
    expect(await host(() => resp(502)).repoInfo('a', 'b')).toBeNull();
    expect(
      await host(() => Promise.reject(new TypeError('fetch failed'))).repoInfo('a', 'b'),
    ).toBeNull();
    expect(
      await host(() => resp(200, { size: 10, language: 'TypeScript', private: false })).repoInfo(
        'a',
        'b',
      ),
    ).toEqual({ sizeKb: 10, language: 'TypeScript', private: false });
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

  it('限流只计真正入队:复用已有任务不计数,新任务与 failed 重试计数,超限 429', async () => {
    const app = make();
    const ip = nextIp();
    await redis.del(redisKeys.rateLimitIp(ip));
    const k = redisKeys.rateLimitIp(ip);
    // 新任务:计数 1
    const first = await post(app, 'https://github.com/a/reuse', ip);
    expect(first.statusCode).toBe(202);
    expect(await redis.get(k)).toBe('1');
    // 已分析完成的同仓库同 commit:重复提交 10 次都复用,不计数
    await store.updateTask(first.json().jobId, { stage: 'done', progress: 100 });
    for (let i = 0; i < 10; i++) {
      const r = await post(app, 'https://github.com/a/reuse', ip);
      expect(r.statusCode).toBe(200);
      expect(r.json().jobId).toBe(first.json().jobId);
    }
    expect(await redis.get(k)).toBe('1');
    // 排队中的任务也复用、不计数
    const q = await post(app, 'https://github.com/a/queued', ip);
    expect(q.statusCode).toBe(202);
    expect((await post(app, 'https://github.com/a/queued', ip)).statusCode).toBe(200);
    expect(await redis.get(k)).toBe('2');
    // failed 重试会重新入队:计数
    await store.updateTask(q.json().jobId, { stage: 'failed' });
    expect((await post(app, 'https://github.com/a/queued', ip)).statusCode).toBe(202);
    expect(await redis.get(k)).toBe('3');
    // 再来两个新任务到 5,第 6 个新任务 429,且不建任务、不入队
    for (const n of ['n4', 'n5'])
      expect((await post(app, `https://github.com/a/${n}`, ip)).statusCode).toBe(202);
    const over = await post(app, 'https://github.com/a/n6', ip);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    // 超限后,复用已完成任务仍然 200
    expect((await post(app, 'https://github.com/a/reuse', ip)).statusCode).toBe(200);
    await app.close();
  });

  it('被拒绝/出错的提交不计入 5 次新任务限额', async () => {
    const app = make();
    const ip = nextIp();
    const k = redisKeys.rateLimitIp(ip);
    await redis.del(k, redisKeys.submitLimitIp(ip));
    // 地址非法、仓库不存在、过大、语言不支持:各 3 次,共 12 次,都不计入新任务
    for (let i = 0; i < 3; i++) {
      expect((await post(app, 'https://gitlab.com/a/b', ip)).statusCode).toBe(400);
      git.sha = null;
      expect((await post(app, `https://github.com/a/missing${i}`, ip)).statusCode).toBe(404);
      git.sha = SHA;
      git.info = { sizeKb: 10_000_000, language: 'TypeScript' };
      expect((await post(app, `https://github.com/a/big${i}`, ip)).statusCode).toBe(413);
      git.info = { sizeKb: 100, language: 'Go' };
      expect((await post(app, `https://github.com/a/go${i}`, ip)).statusCode).toBe(422);
      git.info = { sizeKb: 100, language: 'TypeScript' };
    }
    expect(await redis.get(k)).toBeNull();
    // 入队出错(500):已计数的 1 次被退还
    const bad = buildApp({
      store,
      redis,
      git,
      logger: false,
      queue: {
        enqueue: async () => Promise.reject(new Error('redis down')),
        removeFailed: async () => {},
      },
    });
    expect((await post(bad, 'https://github.com/a/err', ip)).statusCode).toBe(500);
    await bad.close();
    expect(await redis.get(k)).toBe('0');
    // 之后仍可建 5 个新任务,第 6 个 429
    for (let i = 0; i < 5; i++)
      expect((await post(app, `https://github.com/a/ok${i}`, ip)).statusCode).toBe(202);
    expect((await post(app, 'https://github.com/a/ok6', ip)).statusCode).toBe(429);
    expect(await redis.get(redisKeys.submitLimitIp(ip))).toBe('19');
    await app.close();
  });

  it('宽松总量计数:同一来源每小时第 61 次提交 429(含被拒绝的),且 TTL 为 1 小时', async () => {
    const app = make();
    const ip = nextIp();
    const sk = redisKeys.submitLimitIp(ip);
    await redis.del(sk, redisKeys.rateLimitIp(ip));
    for (let i = 0; i < 60; i++)
      expect((await post(app, 'https://gitlab.com/a/b', ip)).statusCode).toBe(400);
    const r = await post(app, 'https://github.com/a/fine', ip);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('RATE_LIMITED');
    expect(await redis.ttl(sk)).toBeGreaterThan(3500);
    // 被总量拦下的请求不建任务、不占新任务名额
    expect(jobs).toHaveLength(0);
    expect(await redis.get(redisKeys.rateLimitIp(ip))).toBeNull();
    // 另一来源不受影响
    expect((await post(app, 'https://github.com/a/fine')).statusCode).toBe(202);
    await app.close();
  });

  it('两个上限可配置;复用不计新仓库额度但计总量', async () => {
    const app = buildApp({
      store,
      redis,
      queue,
      git,
      logger: false,
      rateLimitPerHour: 1,
      submitLimitPerHour: 4,
    });
    const ip = nextIp();
    const [ik, sk] = [redisKeys.rateLimitIp(ip), redisKeys.submitLimitIp(ip)];
    await redis.del(sk, ik);
    expect((await post(app, 'https://github.com/a/c1', ip)).statusCode).toBe(202);
    // 复用:新仓库额度(1)已满也仍然 200,且不再增加 rl:ip,但 rl:sub 照计
    expect((await post(app, 'https://github.com/a/c1', ip)).statusCode).toBe(200);
    expect((await post(app, 'https://github.com/a/c1', ip)).statusCode).toBe(200);
    expect(await redis.get(ik)).toBe('1');
    expect(await redis.get(sk)).toBe('3');
    // 第 2 个新仓库超出 rateLimitPerHour=1
    const r1 = await post(app, 'https://github.com/a/c2', ip);
    expect(r1.statusCode).toBe(429);
    expect(r1.json().error.code).toBe('RATE_LIMITED');
    // 第 5 次请求超出 submitLimitPerHour=4,复用也被拦
    const r2 = await post(app, 'https://github.com/a/c1', ip);
    expect(r2.statusCode).toBe(429);
    expect(r2.json().error.code).toBe('RATE_LIMITED');
    expect(await redis.get(sk)).toBe('5');
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

  it('inCycle 由存储的边现场计算:stats 为空(重跑复用已入库图)时 /graph 与 /nodes 仍一致', async () => {
    const app = make();
    const { repoId, jobId } = await seedGraph();
    // 模拟重试/重跑:图已入库走 "跳过解析",stats 被写成 {}(或残留错误的 cycles)
    await store.updateTask(jobId, { stats: {} });
    for (const k of await redis.keys(redisKeys.graphPattern(repoId, SHA))) await redis.del(k);
    const root = GraphDataSchema.parse((await app.inject(`/api/repos/${repoId}/graph`)).json());
    expect(root.edges.find((e) => e.id === 'a:m:src/a->m:src/b')?.inCycle).toBe(true);
    expect(root.meta.cycles).toEqual([['m:src/a', 'm:src/b']]);
    const sub = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repoId}/graph?parentId=m:src/a`)).json(),
    );
    expect(sub.edges.some((e) => e.inCycle === true)).toBe(true);
    const get = async (id: string) =>
      NodeDetailSchema.parse((await app.inject(`/api/repos/${repoId}/nodes/${id}`)).json());
    // 环:a/index → a/x/deep → b/index → b/util → a/index(type-only 边不算)
    for (const f of ['src/a/index.ts', 'src/a/x/deep.ts', 'src/b/index.ts', 'src/b/util.ts'])
      expect((await get(`f:${f}`)).inCycle).toBe(true);
    expect((await get('f:main.ts')).inCycle).toBe(false);
    await store.updateTask(jobId, { stats: { cycles: [['f:main.ts']] } });
    expect((await get('f:main.ts')).inCycle).toBe(false);
    await app.close();
  });

  describe('GET /api/repos/:id 的 repo 与 commitSha', () => {
    const SHA2 = 'b'.repeat(40);
    const detail = async (app: ReturnType<typeof make>, id: number) =>
      RepoStatusSchema.parse((await app.inject(`/api/repos/${id}`)).json());

    it('没有已完成任务:取最新任务的 commit,与 POST 响应一致', async () => {
      const app = make();
      const created = await post(app, 'https://github.com/Acme/NoDone');
      expect(created.statusCode).toBe(202);
      const c = created.json();
      const r = await detail(app, c.repoId);
      expect({ repo: r.repo, commitSha: r.commitSha, jobId: r.jobId, status: r.status }).toEqual({
        repo: 'Acme/NoDone',
        commitSha: c.commitSha,
        jobId: c.jobId,
        status: 'queued',
      });
      // 还是没有 done:新 commit 的任务成为最新,commitSha 跟着它走
      git.sha = SHA2;
      const c2 = (await post(app, 'https://github.com/Acme/NoDone')).json();
      git.sha = SHA;
      const r2 = await detail(app, c.repoId);
      expect([r2.commitSha, r2.jobId]).toEqual([SHA2, c2.jobId]);
      await app.close();
    });

    it('有已完成任务:取 done 任务的 commit', async () => {
      const app = make();
      const c = (await post(app, 'https://github.com/Acme/Done')).json();
      await store.updateTask(c.jobId, { stage: 'done', progress: 100 });
      const r = await detail(app, c.repoId);
      expect([r.commitSha, r.status, r.jobId]).toEqual([SHA, 'done', c.jobId]);
      await app.close();
    });

    it('重新分析期间有更新的 running 任务:commitSha 仍是 done 任务的,状态与 jobId 是最新任务的', async () => {
      const app = make();
      const c = (await post(app, 'https://github.com/Acme/Rerun')).json();
      await store.updateTask(c.jobId, { stage: 'done', progress: 100 });
      git.sha = SHA2;
      const c2 = (await post(app, 'https://github.com/Acme/Rerun')).json();
      git.sha = SHA;
      expect(c2.commitSha).toBe(SHA2);
      await store.updateTask(c2.jobId, { stage: 'parsing', progress: 30 });
      const r = await detail(app, c.repoId);
      expect([r.commitSha, r.jobId, r.status]).toEqual([SHA, c2.jobId, 'running']);
      await app.close();
    });
  });

  it('GET /api/repos/:id 状态', async () => {
    const app = make();
    const { repoId, jobId } = await seedGraph();
    const r = RepoStatusSchema.parse((await app.inject(`/api/repos/${repoId}`)).json());
    expect(r).toEqual({
      repoId,
      jobId,
      repo: 'o/g',
      commitSha: SHA,
      status: 'done',
      stage: 'done',
      progress: 100,
      stats: { files: 5, modules: 3, edges: 7 },
      error: null,
      embeddingStatus: null,
    });
    // T-214:worker 写入 stats.embeddingStatus 后透出;旧响应缺省按 null 解析
    await store.updateTask(jobId, {
      stats: { files: 5, modules: 3, edges: 7, embeddingStatus: 'failed' },
    });
    expect((await app.inject(`/api/repos/${repoId}`)).json().embeddingStatus).toBe('failed');
    const old: Record<string, unknown> = { ...r };
    delete old.embeddingStatus;
    expect(RepoStatusSchema.parse(old).embeddingStatus).toBeNull();
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
    const hit = await app.inject(`/api/repos/${repoId}/graph`);
    expect([hit.headers['x-cache'], hit.headers['x-graph-truncated']]).toEqual(['hit', 'false']);
    expect(hit.json()).toEqual(r1.json());

    const sub = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repoId}/graph?parentId=m:src/a`)).json(),
    );
    // 范围外的同层祖先(m:., m:src/b)作为边界节点一并返回,保证边两端都在 nodes 里
    expect(sub.nodes.map((n) => n.id).sort()).toEqual([
      'd:src/a/x',
      'f:src/a/index.ts',
      'm:.',
      'm:src/b',
    ]);
    // 子树内边 + 跨子树边:范围外一端写成同层祖先(m:src/b、m:.),方向保留,按 (s,t) 去重
    const pick = (es: typeof sub.edges) =>
      es.map((e) => [e.source, e.target, e.weight, e.kind, e.aggregated ?? false]).sort();
    expect(pick(sub.edges)).toEqual(
      [
        ['f:src/a/index.ts', 'd:src/a/x', 1, 'static', true],
        ['f:src/a/index.ts', 'm:src/b', 1, 'static', true],
        ['d:src/a/x', 'm:src/b', 2, 'static', true], // static 与 type-only 各 1,并列按字母取 static
        ['m:src/b', 'f:src/a/index.ts', 1, 'static', true],
        ['m:.', 'f:src/a/index.ts', 1, 'static', true],
      ].sort(),
    );
    expect(sub.edges.every((e) => e.source !== e.target && e.type === 'imports')).toBe(true);
    expect(new Set(sub.edges.map((e) => e.id)).size).toBe(sub.edges.length);
    const leaf = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repoId}/graph?parentId=m:src/b`)).json(),
    );
    expect(leaf.edges[0]).toMatchObject({
      id: 'e:f:src/b/index.ts->f:src/b/util.ts:static',
      weight: 1,
    });
    expect(leaf.edges[0]!.aggregated).toBeUndefined();
    expect(pick(leaf.edges.slice(1))).toEqual(
      [
        ['m:src/a', 'f:src/b/util.ts', 2, 'static', true],
        ['m:src/a', 'f:src/b/index.ts', 1, 'static', true],
        ['f:src/b/util.ts', 'm:src/a', 1, 'static', true],
      ].sort(),
    );
    // 多层:展开 d:src/a/x 时,范围外一端写成 d:src/a/x 祖先链上的兄弟层节点
    const deep = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repoId}/graph?parentId=d:src/a/x`)).json(),
    );
    expect(pick(deep.edges)).toEqual(
      [
        ['f:src/a/x/deep.ts', 'm:src/b', 2, 'static', true],
        ['f:src/a/index.ts', 'f:src/a/x/deep.ts', 1, 'static', true],
      ].sort(),
    );

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

  it('非法图查询 → 400 BAD_REQUEST;格式合法但不存在 → 404', async () => {
    const app = make();
    const { repoId } = await seedGraph();
    const bad = [
      `/api/repos/${repoId}/graph?parentId=nope`, // 无前缀
      `/api/repos/${repoId}/graph?parentId=q:x`, // 未知前缀
      `/api/repos/${repoId}/graph?parentId=`, // 空
      `/api/repos/${repoId}/graph?includeExternal=yes`,
      `/api/repos/${repoId}/graph?depth=abc`, // 未定义参数
      `/api/repos/${repoId}/graph?level=-1`,
      `/api/repos/${repoId}/graph?_t=123`, // 缓存破坏参数同样 400(strict)
      `/api/repos/${repoId}/graph?parentId=m:src/a&depth=1`, // 合法参数 + 未知参数
      `/api/repos/abc`, // 所有带 :id 的路由
      `/api/repos/abc/graph`, // repo id 格式非法
      `/api/repos/0/graph`,
      `/api/repos/1.5/graph`,
      `/api/repos/${repoId}/nodes/bad`, // 节点 id 格式非法
      `/api/repos/abc/nodes/f:a.ts`,
    ];
    for (const url of bad) {
      const r = await app.inject(url);
      expect({ url, status: r.statusCode, code: r.json().error.code }).toEqual({
        url,
        status: 400,
        code: 'BAD_REQUEST',
      });
    }
    for (const url of [
      `/api/repos/${repoId}/graph?parentId=d:nope`,
      `/api/repos/${repoId}/graph?parentId=m:nope`,
      `/api/repos/${repoId}/nodes/f:nope.ts`,
      `/api/repos/999999/graph`,
    ]) {
      const r = await app.inject(url);
      expect({ url, status: r.statusCode, code: r.json().error.code }).toEqual({
        url,
        status: 404,
        code: 'REPO_NOT_FOUND',
      });
    }
    // 合法参数仍 200
    expect((await app.inject(`/api/repos/${repoId}/graph?includeExternal=false`)).statusCode).toBe(
      200,
    );
    await app.close();
  });

  it('图缓存 key 带投影版本号:旧版本/无版本的缓存不会被命中', async () => {
    const app = make();
    const { repoId } = await seedGraph();
    const stale = Buffer.from('stale-not-gzip');
    // #10 的无版本 key 与上一版本 key 都写入脏数据
    await redis.set(`graph:${repoId}:${SHA}:root`, stale);
    await redis.set(redisKeys.graph(repoId, SHA, null, false, GRAPH_PROJECTION_VERSION - 1), stale);
    await redis.del(redisKeys.graph(repoId, SHA, null));
    const r = await app.inject(`/api/repos/${repoId}/graph`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-cache']).toBe('miss');
    expect(GraphDataSchema.parse(r.json()).nodes.length).toBe(3);
    const key = redisKeys.graph(repoId, SHA, null);
    expect(key.startsWith(`graph:v${GRAPH_PROJECTION_VERSION}:`)).toBe(true);
    expect(await redis.exists(key)).toBe(1);
    expect((await app.inject(`/api/repos/${repoId}/graph`)).headers['x-cache']).toBe('hit');
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
    // 子节点自身超 300:照旧截断,并用响应头标记(缓存命中时同样带上)
    const t1 = await app.inject(`/api/repos/${repo.id}/graph?parentId=m:.`);
    expect([t1.headers['x-cache'], t1.headers['x-graph-truncated']]).toEqual(['hit', 'true']);
    const root = await app.inject(`/api/repos/${repo.id}/graph`);
    expect(root.headers['x-graph-truncated']).toBe('false');
    const e = GraphDataSchema.parse(
      (await app.inject(`/api/repos/${repo.id}/graph?parentId=m:.&includeExternal=true`)).json(),
    );
    expect(e.nodes).toHaveLength(300);
    expect(e.nodes.filter((n) => n.type === 'external')).toHaveLength(50);
    await app.close();
  });

  it('/nodes:路径命中敏感规则的文件 exports 为空(即使库里残留 symbols)', async () => {
    const app = make();
    const repo = await store.upsertRepo({
      url: 'https://github.com/o/sens',
      owner: 'o',
      name: 'sens',
    });
    await store.createTask({ jobId: publicJobId(repo.id, SHA), repoId: repo.id, commitSha: SHA });
    const f = (path: string) => ({
      path,
      lang: 'ts',
      loc: 3,
      contentHash: 'h',
      moduleId: 'm:.',
      dirPath: path.split('/').slice(0, -1).join('/') || '.',
      externalDeps: [],
    });
    const sym = (path: string, name: string) => ({
      path,
      name,
      kind: 'function' as const,
      startLine: 1,
      endLine: 1,
      exported: true,
    });
    await store.saveGraph(repo.id, SHA, {
      files: [f('config/secrets.json'), f('src/ok.ts')],
      symbols: [sym('config/secrets.json', 'FAKE_TOKEN'), sym('src/ok.ts', 'ok')],
      edges: [],
    });
    await store.updateTask(publicJobId(repo.id, SHA), { stage: 'graph_ready', progress: 50 });
    const get = async (id: string) =>
      NodeDetailSchema.parse((await app.inject(`/api/repos/${repo.id}/nodes/${id}`)).json());
    expect((await get('f:config/secrets.json')).exports).toEqual([]);
    expect((await get('f:src/ok.ts')).exports).toEqual(['ok']);
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
    expect(x).toMatchObject({ kind: 'external', inDegree: 2, summary: null });
    expect(m.summary).toBeNull();
    // T-211:module 摘要存在 level 'dir' 下,文件摘要在 level 'file'
    const sum = {
      inputHash: 'h',
      model: 'fake',
      source: 'llm' as const,
      tokensIn: 1,
      tokensOut: 1,
    };
    const get = async (id: string) =>
      NodeDetailSchema.parse((await app.inject(`/api/repos/${repoId}/nodes/${id}`)).json());
    // 没摘要:summarySource 为 null
    expect((await get('f:src/b/util.ts')).summarySource).toBeNull();
    await store.upsertSummary(repoId, SHA, {
      ...sum,
      level: 'dir',
      targetId: 'm:src/a',
      content: 'mod A',
    });
    await store.upsertSummary(repoId, SHA, {
      ...sum,
      level: 'file',
      targetId: 'f:src/b/util.ts',
      model: 'rule',
      source: 'rule',
      content: 'util',
    });
    // T-211c:别的 commit 的摘要不串到本图
    await store.upsertSummary(repoId, 'c'.repeat(40), {
      ...sum,
      level: 'file',
      targetId: 'f:main.ts',
      content: '其他 commit',
    });
    expect(await get('m:src/a')).toMatchObject({ summary: 'mod A', summarySource: 'llm' });
    expect(await get('f:src/b/util.ts')).toMatchObject({ summary: 'util', summarySource: 'rule' });
    expect(await get('f:main.ts')).toMatchObject({ summary: null, summarySource: null });
    // inCycle:由存储的边现场算 SCC = {a/index, a/x/deep, b/index, b/util}(不读 stats.cycles)
    expect((await get('f:src/a/index.ts')).inCycle).toBe(true);
    expect((await get('f:src/b/util.ts')).inCycle).toBe(true);
    expect((await get('m:src/a')).inCycle).toBe(true);
    expect((await get('f:main.ts')).inCycle).toBe(false);
    expect((await get('f:src/a/x/deep.ts')).inCycle).toBe(true);
    expect((await get('x:react')).inCycle).toBe(false);
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
