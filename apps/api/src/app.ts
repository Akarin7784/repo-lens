import { gunzipSync, gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import {
  CreateRepoRequestSchema,
  FileContentSchema,
  FileQuerySchema,
  GraphDataSchema,
  GraphQuerySchema,
  NodeIdSchema,
  type CreateRepoResponse,
  type HealthResponse,
  type NodeDetail,
  type RepoStatus,
  sensitivePathRule,
  EmbeddingProviderSchema,
} from '@repolens/shared';
import {
  GRAPH_CACHE_TTL_S,
  RATE_LIMIT_TTL_S,
  parseJobId,
  publicJobId,
  redisKeys,
  type Store,
  type TaskRow,
} from '@repolens/db';
import { HttpError } from './errors.js';
import { readRepoFile } from './files.js';
import type { GitHost } from './githost.js';
import { GraphIndex, nodeDetail, projectGraphWithInfo } from './projection.js';
import { streamJobEvents } from './sse.js';
import { ipKey } from './ip-key.js';
import { registerChatRoute, type ChatDeps } from './chat/route.js';

export interface AnalyzeJobData {
  jobId: string;
  repoId: number;
  repoUrl: string;
  commitSha: string;
}
/** 队列适配(生产为 BullMQ,测试为内存) */
export interface JobQueue {
  enqueue(data: AnalyzeJobData): Promise<void>;
  /** 删除已失败的旧 job,便于同 id 重新入队 */
  removeFailed(jobId: string): Promise<void>;
}

export interface AppDeps {
  store: Store;
  redis: Redis;
  queue: JobQueue;
  git: GitHost;
  rateLimitPerHour?: number;
  /** 同一来源每小时 POST /api/repos 的总提交上限(含被拒绝/出错的提交),默认 60 */
  submitLimitPerHour?: number;
  maxRepoMb?: number;
  pingIntervalMs?: number;
  /** 测试可传 { stream } 捕获日志 */
  logger?: boolean | { level?: string; stream: { write(msg: string): void } };
  /** T-213:worker 快照根目录(与 worker 的 REPOS_DIR 相同,api 只读挂载) */
  reposDir?: string;
  /** P4-e:配置后注册 POST /api/repos/:id/chat */
  chat?: ChatDeps;
}

const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SUPPORTED_LANGS = new Set(['TypeScript', 'JavaScript']);

export function statusOf(stage: TaskRow['stage']): RepoStatus['status'] {
  return stage === 'queued' || stage === 'done' || stage === 'failed' ? stage : 'running';
}

export function buildApp(deps?: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps?.logger ?? process.env.NODE_ENV !== 'test',
    trustProxy: true,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send(err.body());
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode;
    // 框架自带的 4xx(非法 JSON 400、请求体过大 413、不支持的 Content-Type 415 等)保留原状态码,code 统一 BAD_REQUEST
    if (status && status >= 400 && status < 500)
      return reply
        .status(status)
        .send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务内部错误' } });
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'api',
    time: new Date().toISOString(),
  }));
  if (!deps) return app;
  const { store, redis, queue, git } = deps;
  const limit = deps.rateLimitPerHour ?? 5;
  const submitLimit = deps.submitLimitPerHour ?? 60;
  const maxRepoKb = (deps.maxRepoMb ?? 300) * 1024;

  async function hit(key: string) {
    const [[, n]] = (await redis.multi().incr(key).expire(key, RATE_LIMIT_TTL_S, 'NX').exec()) as [
      [unknown, number],
    ];
    return n;
  }
  /** 新任务限额(默认 5/h):只计真正入队的提交;超限时不退还(超限请求本身不入队,计数值只用于比较) */
  async function rateLimit(ip: string) {
    const n = await hit(redisKeys.rateLimitIp(ip));
    if (n > limit) throw new HttpError('RATE_LIMITED', `每个 IP 每小时最多提交 ${limit} 个新任务`);
  }
  /** 宽松总量计数(默认 60/h):所有提交都计,包括被拒绝、出错、复用的 */
  async function submitLimitCheck(ip: string) {
    const n = await hit(redisKeys.submitLimitIp(ip));
    if (n > submitLimit)
      throw new HttpError('RATE_LIMITED', `每个 IP 每小时最多提交 ${submitLimit} 次请求`);
  }

  app.post('/api/repos', async (req, reply) => {
    await submitLimitCheck(ipKey(req.ip));
    const body = CreateRepoRequestSchema.safeParse(req.body);
    if (!body.success) {
      // 只有 repoUrl 本身存在但不合法才是 INVALID_REPO_URL;缺字段、ref 非法、请求体不是对象等都是 BAD_REQUEST
      const raw = (req.body ?? null) as Record<string, unknown> | null;
      const urlIssue = body.error.issues.find((i) => i.path[0] === 'repoUrl');
      const hasUrl = typeof raw === 'object' && raw !== null && 'repoUrl' in raw;
      if (urlIssue && hasUrl) throw new HttpError('INVALID_REPO_URL', urlIssue.message);
      throw new HttpError('BAD_REQUEST', body.error.issues[0]?.message ?? '请求体无效');
    }
    const [, owner, name] = GH.exec(body.data.repoUrl)!;
    if ([owner, name].some((s) => s === '.' || s === '..'))
      throw new HttpError('INVALID_REPO_URL', '仓库路径无效');
    const url = `https://github.com/${owner}/${name}`;

    const commitSha = await git.lsRemote(url, body.data.ref);
    if (!commitSha) throw new HttpError('REPO_NOT_FOUND', '仓库不存在、不可访问或 ref 无效');
    const meta = await git.repoInfo(owner!, name!);
    // ref 为 40 位 SHA 时 lsRemote 不联网,仓库是否存在只能靠 repoInfo:GitHub 明确 404(不存在,或无 token 时的私有仓库)
    // 在建仓库/任务、计 rl:ip 之前拒绝,文案不区分私有与不存在。403 限流、5xx、网络错误返回 null,照常放行。
    if (meta === 'not-found')
      throw new HttpError('REPO_NOT_FOUND', '仓库不存在、不可访问或 ref 无效');
    const info = meta;
    // 只分析公开仓库:GitHub 明确返回 private:true 时在建仓库/任务之前拒绝。
    if (info?.private === true) throw new HttpError('REPO_NOT_PUBLIC', '只支持公开仓库');
    if (info?.sizeKb && info.sizeKb > maxRepoKb)
      throw new HttpError('REPO_TOO_LARGE', `仓库超过 ${maxRepoKb / 1024}MB 上限`);
    if (info?.language && !SUPPORTED_LANGS.has(info.language))
      throw new HttpError(
        'UNSUPPORTED_LANGUAGE',
        `第 1 周仅支持 TypeScript 仓库(检测到 ${info.language})`,
      );

    const repo = await store.upsertRepo({ url, owner: owner!, name: name! });
    const jobId = publicJobId(repo.id, commitSha);
    // 限流只计"真正入队"的提交:同仓库同 commit 已有未失败的任务(done/queued/running)时直接复用,不计数;
    // 新任务或 failed 重试会入队,先计数,超限 429 且不建任务。
    const existing = await store.getTask(jobId);
    const counted = !existing || existing.stage === 'failed';
    if (counted) await rateLimit(ipKey(req.ip));
    // 已计数但最终没有入队(并发下别人先建了未失败的任务,或建任务/入队出错)时退还 1 次
    let refunded = !counted;
    const refund = async () => {
      if (refunded) return;
      refunded = true;
      await redis.decr(redisKeys.rateLimitIp(ipKey(req.ip)));
    };
    let task: Awaited<ReturnType<typeof store.createTask>>['task'];
    let created: boolean;
    const data: AnalyzeJobData = { jobId, repoId: repo.id, repoUrl: url, commitSha };
    let status: CreateRepoResponse['status'];
    try {
      ({ task, created } = await store.createTask({ jobId, repoId: repo.id, commitSha }));
      status = statusOf(task.stage);
      if (!created && task.stage !== 'failed') await refund();
      if (created) {
        await queue.enqueue(data);
      } else if (task.stage === 'failed') {
        await store.updateTask(jobId, {
          stage: 'queued',
          progress: 0,
          errorCode: null,
          errorMsg: null,
          stats: {},
          finishedAt: null,
        });
        await redis.del(redisKeys.jobEvents(jobId));
        await queue.removeFailed(jobId);
        await queue.enqueue(data);
        status = 'queued';
      }
    } catch (e) {
      await refund();
      throw e;
    }
    const res: CreateRepoResponse = {
      repoId: repo.id,
      jobId,
      status,
      repo: `${owner}/${name}`,
      commitSha,
    };
    return reply.status(created || task.stage === 'failed' ? 202 : 200).send(res);
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (req, reply) => {
    const jobId = req.params.id;
    const task = parseJobId(jobId) ? await store.getTask(jobId) : null;
    if (!task) throw new HttpError('REPO_NOT_FOUND', '任务不存在');
    const q = req.query as { lastEventId?: string };
    const last = (req.headers['last-event-id'] as string | undefined) ?? q.lastEventId;
    await streamJobEvents(reply as FastifyReply, {
      redis,
      store,
      task,
      lastEventId: last && /^\d+-\d+$/.test(last) ? last : '0',
      pingIntervalMs: deps.pingIntervalMs ?? 15_000,
    });
  });

  const repoIdOf = (raw: string) => {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError('BAD_REQUEST', '仓库 id 格式无效');
    return id;
  };

  if (deps.chat) registerChatRoute(app, { store, hit, chat: deps.chat, repoIdOf });

  app.get<{ Params: { id: string } }>('/api/repos/:id', async (req) => {
    const repoId = repoIdOf(req.params.id);
    const repo = await store.getRepo(repoId);
    const task = repo ? await store.latestTask(repoId) : null;
    if (!repo || !task) throw new HttpError('REPO_NOT_FOUND', '仓库不存在');
    // commitSha 优先取最近一次已完成任务的(重新分析期间仍指向能看的那版),没有已完成任务才取最新任务的
    const done = await store.latestDoneTask(repoId);
    const s = task.stats;
    const res: RepoStatus = {
      repoId,
      jobId: task.jobId,
      repo: `${repo.owner}/${repo.name}`,
      commitSha: (done ?? task).commitSha,
      status: statusOf(task.stage),
      stage: (task.stage === 'failed'
        ? (s.failedStage ?? 'queued')
        : task.stage) as RepoStatus['stage'],
      progress: task.progress,
      stats: {
        ...(s.files !== undefined ? { files: s.files } : {}),
        ...(s.modules !== undefined ? { modules: s.modules } : {}),
        ...(s.edges !== undefined ? { edges: s.edges } : {}),
      },
      error: task.errorMsg,
      // 与 commitSha 同源:取最近已完成任务的向量化状态
      embeddingStatus: (done ?? task).stats.embeddingStatus ?? null,
      // 同源:只透出合法取值,旧任务或异常值省略
      ...(() => {
        const p = EmbeddingProviderSchema.safeParse((done ?? task).stats.embeddingProvider);
        return p.success ? { embeddingProvider: p.data } : {};
      })(),
    };
    return res;
  });

  /** 加载最近一个已出图的任务对应的全量图索引 */
  async function loadIndex(repoId: number) {
    const repo = await store.getRepo(repoId);
    if (!repo) throw new HttpError('REPO_NOT_FOUND', '仓库不存在');
    const task = await store.latestGraphTask(repoId);
    if (!task)
      throw new HttpError('REPO_NOT_READY', '依赖图尚未生成', { reason: 'GRAPH_NOT_READY' });
    return { task, ix: new GraphIndex(await store.loadGraph(repoId, task.commitSha)) };
  }

  app.get<{ Params: { id: string } }>('/api/repos/:id/graph', async (req, reply) => {
    const repoId = repoIdOf(req.params.id);
    // shared 的 GraphQuerySchema 不拒绝未知参数;API 侧加 strict,depth/level 等未定义参数一律 400
    const q = GraphQuerySchema.strict().safeParse(req.query);
    if (!q.success) throw new HttpError('BAD_REQUEST', `参数无效:${q.error.issues[0]?.message}`);
    const parentId = q.data.parentId ?? null;
    const ext = q.data.includeExternal ?? false;
    const repo = await store.getRepo(repoId);
    if (!repo) throw new HttpError('REPO_NOT_FOUND', '仓库不存在');
    const task = await store.latestGraphTask(repoId);
    if (!task)
      throw new HttpError('REPO_NOT_READY', '依赖图尚未生成', { reason: 'GRAPH_NOT_READY' });
    // key 带投影版本号(GRAPH_PROJECTION_VERSION),改投影逻辑时递增,旧缓存自然失效
    const key = redisKeys.graph(repoId, task.commitSha, parentId, ext);
    const cached = await redis.getBuffer(key);
    reply.header('content-type', 'application/json; charset=utf-8');
    // 缓存值 = 1 字节截断标记('0'/'1') + gzip(JSON)
    if (cached)
      return reply
        .header('x-cache', 'hit')
        .header('x-graph-truncated', cached[0] === 0x31 ? 'true' : 'false')
        .send(gunzipSync(cached.subarray(1)));
    const ix = new GraphIndex(await store.loadGraph(repoId, task.commitSha));
    const p = projectGraphWithInfo(ix, {
      repoId,
      commitSha: task.commitSha,
      parentId,
      includeExternal: ext,
      cycles: ix.cycles,
    });
    if (!p) throw new HttpError('REPO_NOT_FOUND', `节点 ${parentId} 不存在或不可展开`);
    const json = JSON.stringify(GraphDataSchema.parse(p.graph));
    const flag = Buffer.from(p.truncated ? '1' : '0');
    await redis.set(key, Buffer.concat([flag, gzipSync(json)]), 'EX', GRAPH_CACHE_TTL_S);
    return reply
      .header('x-cache', 'miss')
      .header('x-graph-truncated', String(p.truncated))
      .send(json);
  });

  // T-213:读文件片段。commit 与 graph 同源(最近一次已出图任务),源码来自 worker 保留的快照
  app.get<{ Params: { id: string } }>('/api/repos/:id/files', async (req) => {
    const repoId = repoIdOf(req.params.id);
    const q = FileQuerySchema.strict().safeParse(req.query);
    if (!q.success) throw new HttpError('BAD_REQUEST', `参数无效:${q.error.issues[0]?.message}`);
    const repo = await store.getRepo(repoId);
    if (!repo) throw new HttpError('REPO_NOT_FOUND', '仓库不存在');
    const task = await store.latestGraphTask(repoId);
    if (!task)
      throw new HttpError('REPO_NOT_READY', '依赖图尚未生成', { reason: 'GRAPH_NOT_READY' });
    if (!deps.reposDir)
      throw new HttpError('REPO_NOT_READY', '未配置源码快照目录(REPOS_DIR)', {
        reason: 'REPOS_DIR_NOT_CONFIGURED',
      });
    const res = await readRepoFile({
      reposDir: deps.reposDir,
      repoId,
      commitSha: task.commitSha,
      ...q.data,
    });
    return FileContentSchema.parse(res);
  });

  // nodeId 含 '/'(如 f:src/a.ts),用通配符接收;编码与未编码两种写法都支持
  app.get<{ Params: { id: string; '*': string } }>('/api/repos/:id/nodes/*', async (req) => {
    const nodeId = decodeURIComponent(req.params['*']);
    const repoId = repoIdOf(req.params.id);
    if (!NodeIdSchema.safeParse(nodeId).success)
      throw new HttpError('BAD_REQUEST', '节点 id 格式无效');
    const { ix, task } = await loadIndex(repoId);
    const d = nodeDetail(ix, nodeId, ix.cycles);
    if (!d) throw new HttpError('REPO_NOT_FOUND', '节点不存在');
    let exports: string[] = [];
    if (d.kind === 'file') {
      const row = (await store.loadGraph(repoId, task.commitSha)).files.find(
        (f) => f.path === d.path,
      );
      // 双保险:路径命中敏感规则的文件一律不返回导出名(内容规则在 worker 持久化时已过滤)
      if (row && !sensitivePathRule(d.path)) exports = await store.exportsOf(row.id);
    }
    // T-211c:按图所属 commit 读摘要(module 存在 level 'dir' 下);没有摘要时来源为 null
    const level = d.kind === 'file' ? 'file' : d.kind === 'external' ? null : 'dir';
    const s = level ? await store.getSummary(repoId, task.commitSha, level, nodeId) : null;
    const res: NodeDetail = {
      ...d,
      exports,
      summary: s?.content ?? null,
      summarySource: s ? s.source : null,
    };
    return res;
  });

  return app;
}
