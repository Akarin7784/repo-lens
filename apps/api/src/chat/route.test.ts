import { randomInt } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { ApiErrorSchema, ChatEventSchema, probeService, type ChatEvent } from '@repolens/shared';
import { MemoryStore, redisKeys, type CodeChunkRow, type TaskStats } from '@repolens/db';
import {
  DEFAULT_PRICES,
  FakeLlm,
  LlmGateway,
  MemoryLlmKv,
  rewriteQuery,
  type LlmCall,
  type LlmClient,
  type LlmStreamEvent,
} from '@repolens/agent';
import {
  buildChunks,
  FakeEmbedder,
  indexChunks,
  MemoryVectorStore,
  pointId,
  type ChunkSpan,
} from '@repolens/rag';
import { buildApp, type JobQueue } from '../app.js';
import type { GitHost } from '../githost.js';
import { ipKey } from '../ip-key.js';
import { prepareSnippet } from './chunk-guard.js';
import {
  questionHash,
  resolveRewrite,
  secondsToNextHour,
  userKeyOf,
  type ChatDeps,
  type ChatMetrics,
} from './route.js';
import { readChatLimits } from '../limits.js';

// 未设 TEST_REDIS_URL 时用专用 db 11(不连共享 db 0;agent llm.test 用 5、worker embed-lock 用 6)
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/11';
// REQUIRE_DB_TESTS=1(CI)时不可达直接抛错,不允许静默跳过
const hasRedis = await probeService(
  'Redis',
  '[api chat] Redis 不可达,跳过问答路由测试',
  async () => {
    const r = new Redis(REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 0,
    });
    try {
      await r.connect();
      if ((await r.ping()) !== 'PONG') throw new Error('ping 未返回 PONG');
    } finally {
      r.disconnect();
    }
  },
);

const SHA = '2'.repeat(40);
const IP_BASE = randomInt(0, 250 * 200);
let ipSeq = 0;
const usedIps: string[] = [];
const nextIp = () => {
  const n = IP_BASE * 250 + ++ipSeq;
  const ip = `10.${Math.floor(n / 62500) % 250}.${Math.floor(n / 250) % 250}.${n % 250}`;
  usedIps.push(ip);
  return ip;
};

// 真实源码 + buildChunks 输出(code_chunk.content 带首行标题)
const SRC = [
  'export function parseConfig(raw: string) {',
  '  const cfg = JSON.parse(raw);',
  '  return validateConfig(cfg);',
  '}',
  '',
  'export function validateConfig(cfg: unknown) {',
  '  if (!cfg) throw new Error("empty config");',
  '  return cfg;',
  '}',
].join('\n');
const SPANS: ChunkSpan[] = [
  { symbol: 'parseConfig', startLine: 1, endLine: 4 },
  { symbol: 'validateConfig', startLine: 6, endLine: 9 },
];
// 超长片段:buildChunks 截到 4000 字符,prepareSnippet 丢掉最后一行
const LONG_SRC = Array.from(
  { length: 200 },
  (_, i) => `export const configValue${i} = ${'1'.repeat(30)};`,
).join('\n');

async function rowsFor(repoId: number, path: string, src: string, spans: ChunkSpan[]) {
  const { chunks } = await buildChunks([{ path, chunks: spans }], async () => src);
  const rows: CodeChunkRow[] = chunks.map((c) => ({
    path: c.path,
    symbol: c.symbol,
    startLine: c.startLine,
    endLine: c.endLine,
    content: c.text,
    contentHash: c.contentHash,
    qdrantPointId: pointId(repoId, SHA, {
      path: c.path,
      symbol: c.symbol,
      start_line: c.startLine,
      end_line: c.endLine,
    }),
  }));
  return { chunks, rows };
}

function parseSse(body: string): ChatEvent[] {
  return body
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const [ev, data] = b.split('\n');
      return ChatEventSchema.parse({
        event: ev!.slice('event: '.length),
        data: JSON.parse(data!.slice('data: '.length)),
      });
    });
}

/** 慢速流客户端:每段之间等 delayMs,记录 signal 是否被中止(FakeLlm 没有延迟选项) */
class SlowLlm implements LlmClient {
  readonly provider = 'fake';
  aborted = false;
  streams = 0;
  constructor(
    private readonly text: string,
    private readonly delayMs: number,
  ) {}
  async call(): Promise<never> {
    throw new Error('not used');
  }
  async *stream(req: LlmCall): AsyncGenerator<LlmStreamEvent> {
    this.streams++;
    req.signal?.addEventListener('abort', () => (this.aborted = true));
    for (const ch of this.text.match(/.{1,4}/gs) ?? []) {
      await new Promise((r) => setTimeout(r, this.delayMs));
      if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
      yield { type: 'text', text: ch };
    }
    yield { type: 'usage', usage: { tokensIn: 1, tokensOut: 1 } };
  }
}

/** 吐 first 后永不结束;honorSignal 时在 abort 后抛出(像真实客户端),否则完全不理 signal */
class HangLlm implements LlmClient {
  readonly provider = 'fake';
  constructor(
    private readonly first: string,
    private readonly honorSignal: boolean,
  ) {}
  async call(): Promise<never> {
    throw new Error('not used');
  }
  async *stream(req: LlmCall): AsyncGenerator<LlmStreamEvent> {
    yield { type: 'text', text: this.first };
    await new Promise<void>((_, rej) => {
      if (this.honorSignal)
        req.signal?.addEventListener('abort', () => rej(req.signal!.reason), { once: true });
    });
  }
}

/** 吐完正文后以 finish_reason:length 结束(usage 带 truncated) */
class TruncLlm implements LlmClient {
  readonly provider = 'fake';
  async call(): Promise<never> {
    throw new Error('not used');
  }
  async *stream(): AsyncGenerator<LlmStreamEvent> {
    yield { type: 'text', text: 'parseConfig 解析到一半' };
    yield { type: 'usage', usage: { tokensIn: 3, tokensOut: 2 }, truncated: true };
  }
}

describe('secondsToNextHour(429 rate_limit 的 retryAfterSec)', () => {
  it('距下一个 UTC 整点的秒数,向上取整,范围 1–3600', () => {
    expect(secondsToNextHour(new Date('2026-10-30T01:00:00.000Z'))).toBe(3600);
    expect(secondsToNextHour(new Date('2026-10-30T01:59:59.001Z'))).toBe(1);
    expect(secondsToNextHour(new Date('2026-10-30T01:30:00.000Z'))).toBe(1800);
    expect(secondsToNextHour(new Date('2026-10-30T01:30:00.500Z'))).toBe(1800);
    expect(secondsToNextHour(new Date('2026-10-30T01:29:59.500Z'))).toBe(1801);
  });
});

describe('readChatLimits', () => {
  it('CHAT_STREAM_TIMEOUT_MS 默认 90000,可配置,非法值报错', () => {
    expect(readChatLimits({}).streamTimeoutMs).toBe(90_000);
    expect(readChatLimits({ CHAT_STREAM_TIMEOUT_MS: '5000' }).streamTimeoutMs).toBe(5000);
    expect(() => readChatLimits({ CHAT_STREAM_TIMEOUT_MS: '0' })).toThrow();
  });
});

describe('resolveRewrite', () => {
  it('默认就是 agent 的 rewriteQuery(rw-3)', () => {
    expect(resolveRewrite({})).toBe(rewriteQuery);
  });
  it('userKeyOf:有密钥时 HMAC(ipKey),IPv6 同 /64 同 key;无密钥 null', () => {
    const s = 'k'.repeat(32);
    expect(userKeyOf('1.2.3.4', null)).toBeNull();
    const a = userKeyOf('2001:db8:1:2:aaaa::1', s);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(userKeyOf('2001:db8:1:2:bbbb::9', s)).toBe(a);
    expect(userKeyOf('2001:db8:1:3::1', s)).not.toBe(a);
    expect(ipKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });
});

describe.skipIf(!hasRedis)(
  'POST /api/repos/:id/chat(真实 Redis + 内存 Store + 真实 buildChunks)',
  () => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    let store: MemoryStore;
    let metrics: ChatMetrics;
    let logs: string[];
    const queue: JobQueue = { enqueue: async () => {}, removeFailed: async () => {} };
    const git: GitHost = { lsRemote: async () => SHA, repoInfo: async () => null };

    const gatewayOf = (client: LlmClient, dailyBudgetCents = 500) =>
      new LlmGateway({
        client,
        kv: new MemoryLlmKv(),
        usage: store,
        prices: DEFAULT_PRICES,
        dailyBudgetCents,
        taskBudgetCents: 100,
      });

    const make = (chat: Partial<ChatDeps> & { gateway: LlmGateway }) =>
      buildApp({
        store,
        redis,
        queue,
        git,
        pingIntervalMs: 1000,
        logger: { level: 'info', stream: { write: (m: string) => void logs.push(m) } },
        chat: { model: 'fake', metrics, pingIntervalMs: 1000, ...chat },
      });

    async function seed(
      o: { stats?: Partial<TaskStats>; done?: boolean; long?: boolean; tamper?: boolean } = {},
    ) {
      const repo = await store.upsertRepo({ url: 'https://github.com/o/c', owner: 'o', name: 'c' });
      const { task } = await store.createTask({
        jobId: `j${repo.id}`,
        repoId: repo.id,
        commitSha: SHA,
      });
      const a = await rowsFor(repo.id, 'src/config.ts', SRC, SPANS);
      const b = o.long
        ? await rowsFor(repo.id, 'src/values.ts', LONG_SRC, [
            { symbol: null, startLine: 1, endLine: 200 },
          ])
        : { chunks: [], rows: [] };
      const rows = [...a.rows, ...b.rows];
      if (o.tamper) for (const r of rows) r.content = r.content.replace('config', 'c0nfig');
      await store.replaceCodeChunks(repo.id, SHA, rows);
      const vectors = new MemoryVectorStore();
      const embedder = new FakeEmbedder();
      await indexChunks(
        { repoId: repo.id, commitSha: SHA, chunks: [...a.chunks, ...b.chunks], batchSize: 16 },
        embedder,
        vectors,
      );
      if (o.done !== false)
        await store.updateTask(task.jobId, {
          stage: 'done',
          progress: 100,
          stats: { embeddingStatus: 'ready', ...o.stats } as TaskStats,
        });
      return { repoId: repo.id, rows, vectors, embedder };
    }

    const post = (
      app: ReturnType<typeof make>,
      repoId: number | string,
      body: unknown,
      ip = nextIp(),
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/repos/${repoId}/chat`,
        headers: { 'x-forwarded-for': ip },
        payload: body as object,
      });

    beforeEach(() => {
      store = new MemoryStore();
      metrics = { persistFailTotal: 0, activeStreams: 0 };
      logs = [];
    });
    afterAll(async () => {
      const h = Math.floor(Date.now() / 3_600_000);
      const keys = usedIps.flatMap((ip) =>
        [-1, 0, 1].map((d) => redisKeys.chatLimitIp(ip, new Date((h + d) * 3_600_000))),
      );
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    });

    it('正常流:tool retrieve → token/citation → done;引用用有效区间;两条消息落库;日志无原文', async () => {
      const { repoId, rows } = await seed();
      const llm = new FakeLlm({
        streamText: () => 'parseConfig 解析 JSON [[S1:1-99]] 完毕',
        chunkSize: 3,
      });
      const app = make({ gateway: gatewayOf(llm) });
      const q = 'how does parseConfig work';
      const res = await post(app, repoId, { message: q });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const evs = parseSse(res.body);
      expect(evs.map((e) => e.event)[0]).toBe('tool');
      expect(
        evs.filter((e) => e.event === 'tool').map((e) => (e.data as { name: string }).name),
      ).toEqual(['retrieve']);
      const last = evs.at(-1)!;
      expect(last.event).toBe('done');
      expect(evs.filter((e) => e.event === 'done' || e.event === 'error')).toHaveLength(1);
      const done = last.data as { sessionId: number; messageId?: number; retrieval: string };
      // 无向量库 → keyword-only
      expect(done.retrieval).toBe('keyword-only');
      const cites = evs
        .filter((e) => e.event === 'citation')
        .map((e) => e.data as { path: string; startLine: number; endLine: number });
      expect(cites).toHaveLength(1);
      const top = prepareSnippet(
        rows.find((r) => r.path === cites[0]!.path && r.startLine === cites[0]!.startLine)!,
      )!;
      expect(cites[0]!.endLine).toBe(top.endLine);
      const msgs = await store.listChatMessages(done.sessionId);
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(msgs[0]!.content).toBe(q);
      expect(msgs[1]!.id).toBe(done.messageId);
      const ids = msgs[1]!.retrievalIds as string[];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => rows.some((r) => r.qdrantPointId === id))).toBe(true);
      const session = await store.getChatSession(done.sessionId);
      expect(session!.title).toBe(q.slice(0, 50));
      expect(session!.userKey).toBeNull();
      expect(logs.join('')).not.toContain(q);
      expect(metrics.activeStreams).toBe(0);
      await app.close();
    });

    it('超长片段:prompt 编号与 citation 都截到 prepareSnippet 的有效 endLine', async () => {
      const { repoId, rows } = await seed({ long: true });
      const long = rows.find((r) => r.path === 'src/values.ts')!;
      const eff = prepareSnippet(long)!;
      expect(eff.endLine).toBeLessThan(long.endLine);
      let user = '';
      const llm = new FakeLlm({
        streamText: (req) => {
          user = req.messages[1]!.content;
          const n = /S(\d+) src\/values\.ts/.exec(user)?.[1] ?? '1';
          return `see [[S${n}:1-200]]`;
        },
      });
      const app = make({ gateway: gatewayOf(llm) });
      const res = await post(app, repoId, { message: 'configValue199 configValue0 values' });
      const cites = parseSse(res.body)
        .filter((e) => e.event === 'citation')
        .map((e) => e.data as { path: string; endLine: number });
      expect(user).toContain(`${eff.endLine}|`);
      expect(user).not.toContain(`${long.endLine}|`);
      expect(cites.find((c) => c.path === 'src/values.ts')!.endLine).toBe(eff.endLine);
      await app.close();
    });

    it('hash 不符的片段全部丢弃 → prompt 走「无可用片段」', async () => {
      const { repoId } = await seed({ tamper: true });
      let user = '';
      const llm = new FakeLlm({
        streamText: (req) => ((user = req.messages[1]!.content), 'x [[S1:1-2]]'),
      });
      const app = make({ gateway: gatewayOf(llm) });
      const evs = parseSse((await post(app, repoId, { message: 'parseConfig' })).body);
      expect(user).toContain('无可用片段');
      expect(evs.filter((e) => e.event === 'citation')).toHaveLength(0);
      expect((evs.at(-1)!.data as { droppedCitations: number }).droppedCitations).toBe(1);
      await app.close();
    });

    it('三项 stats:local 缺字段=一致 → hybrid;dashscope 缺 model=不一致 → keyword-only', async () => {
      const llm = new FakeLlm({ streamText: () => 'ok' });
      const a = await seed({ stats: { embeddingProvider: undefined } });
      const app = make({ gateway: gatewayOf(llm), embedder: a.embedder, vectorStore: a.vectors });
      const d1 = parseSse((await post(app, a.repoId, { message: 'parseConfig' })).body).at(-1)!;
      expect((d1.data as { retrieval: string }).retrieval).toBe('hybrid');
      await app.close();
      store = new MemoryStore();
      const b = await seed({
        stats: { embeddingProvider: 'dashscope', embeddingDim: 384 } as Partial<TaskStats>,
      });
      const ds = {
        provider: 'dashscope',
        model: 'dashscope:text-embedding-v4',
        dim: b.embedder.dim,
        embedQuery: (t: string) => b.embedder.embedQuery(t),
        embedDocuments: (t: string[]) => b.embedder.embedDocuments(t),
      };
      const app2 = make({ gateway: gatewayOf(llm), embedder: ds as never, vectorStore: b.vectors });
      const d2 = parseSse((await post(app2, b.repoId, { message: 'parseConfig' })).body).at(-1)!;
      expect((d2.data as { retrieval: string }).retrieval).toBe('keyword-only');
      expect(logs.join('')).toContain('"degradedReason":"model-mismatch"');
      await app2.close();
    });

    it('检查顺序:id → schema → 限流 → 404;schema 错不计数,404 计数', async () => {
      const app = make({ gateway: gatewayOf(new FakeLlm()), perHour: 1 });
      const ip = nextIp();
      expect((await post(app, 'abc', { message: 'x' }, ip)).statusCode).toBe(400);
      const bad = await post(app, 999, { message: '' }, ip);
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('message":""');
      expect((await post(app, 999, { message: 'x', extra: 1 }, ip)).statusCode).toBe(400);
      expect((await post(app, 999, { message: 'x' }, ip)).statusCode).toBe(404);
      const r = await post(app, 999, { message: 'x' }, ip);
      expect(r.statusCode).toBe(429);
      expect(ApiErrorSchema.parse(r.json()).error.code).toBe('RATE_LIMITED');
      // IPv6 同 /64 共用计数
      expect((await post(app, 999, { message: 'x' }, '2001:db8:9:9:1::1')).statusCode).toBe(404);
      usedIps.push(ipKey('2001:db8:9:9::1'));
      expect((await post(app, 999, { message: 'x' }, '2001:db8:9:9:2::2')).statusCode).toBe(429);
      await redis.del(redisKeys.chatLimitIp(ipKey('2001:db8:9:9::1')));
      await app.close();
    });

    it('404(仓库 / 他库会话)与 409(无 done 任务)', async () => {
      const app = make({ gateway: gatewayOf(new FakeLlm()) });
      const { repoId } = await seed();
      const other = await store.createChatSession({
        repoId: repoId + 100,
        userKey: null,
        title: null,
      });
      expect((await post(app, repoId + 1, { message: 'x' })).statusCode).toBe(404);
      expect((await post(app, repoId, { message: 'x', sessionId: other.id })).statusCode).toBe(404);
      expect((await post(app, repoId, { message: 'x', sessionId: 9999 })).statusCode).toBe(404);
      const r2 = await store.upsertRepo({ url: 'https://github.com/o/n', owner: 'o', name: 'n' });
      await store.createTask({ jobId: 'jn', repoId: r2.id, commitSha: SHA });
      const r = await post(app, r2.id, { message: 'x' });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('REPO_NOT_READY');
      expect(metrics.activeStreams).toBe(0);
      await app.close();
    });

    it('finish_reason:length → done.truncated:true,回答照常落库;正常结束不带 truncated', async () => {
      const { repoId } = await seed();
      const app = make({ gateway: gatewayOf(new TruncLlm()) });
      const evs = parseSse((await post(app, repoId, { message: 'parseConfig' })).body);
      const last = evs.at(-1)!;
      expect(last.event).toBe('done');
      expect(ChatEventSchema.parse(last)).toEqual(last);
      const d = last.data as { truncated?: boolean; sessionId: number; messageId?: number };
      expect(d.truncated).toBe(true);
      const msgs = await store.listChatMessages(d.sessionId);
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(msgs[1]!.id).toBe(d.messageId);
      expect(msgs[1]!.content).toContain('解析到一半');
      const app2 = make({ gateway: gatewayOf(new FakeLlm()) });
      const d2 = parseSse((await post(app2, repoId, { message: 'parseConfig' })).body).at(-1)!;
      expect(d2.event).toBe('done');
      expect(d2.data).not.toHaveProperty('truncated');
      await app.close();
      await app2.close();
    });

    it('rate_limit 429:details={reason:rate_limit, retryAfterSec=距下一整点秒数}', async () => {
      const now = new Date('2026-10-30T03:45:10.200Z');
      const app = make({ gateway: gatewayOf(new FakeLlm()), perHour: 1, now: () => now });
      const ip = nextIp();
      expect((await post(app, 999, { message: 'x' }, ip)).statusCode).toBe(404);
      const r = await post(app, 999, { message: 'x' }, ip);
      expect(r.statusCode).toBe(429);
      const e = ApiErrorSchema.parse(r.json()).error;
      expect(e.code).toBe('RATE_LIMITED');
      expect(e.details).toEqual({ reason: 'rate_limit', retryAfterSec: 890 });
      await redis.del(redisKeys.chatLimitIp(ipKey(ip), now));
      await app.close();
    });

    it('并发上限:占满后 429,流结束后释放', async () => {
      const { repoId } = await seed();
      const slow = new SlowLlm('slow answer text', 30);
      const app = make({ gateway: gatewayOf(slow), maxStreams: 1 });
      const first = post(app, repoId, { message: 'parseConfig' });
      await vi.waitFor(() => expect(slow.streams).toBe(1));
      const ip = nextIp();
      const second = await post(app, repoId, { message: 'parseConfig' }, ip);
      expect(second.statusCode).toBe(429);
      const e = ApiErrorSchema.parse(second.json()).error;
      expect(e.code).toBe('RATE_LIMITED');
      // concurrency 不给 retryAfterSec
      expect(e.details).toEqual({ reason: 'concurrency' });
      // 刚扣的 rl:chat 计数已回退
      expect(Number(await redis.get(redisKeys.chatLimitIp(ipKey(ip))))).toBe(0);
      expect(await redis.ttl(redisKeys.chatLimitIp(ipKey(ip)))).toBeGreaterThan(0);
      expect((await first).statusCode).toBe(200);
      expect(metrics.activeStreams).toBe(0);
      expect((await post(app, repoId, { message: 'parseConfig' })).statusCode).toBe(200);
      await app.close();
    });

    it('并发被拒时回退失败:只打 warn 日志,仍返回 429 concurrency', async () => {
      const { repoId } = await seed();
      const slow = new SlowLlm('slow answer text', 30);
      const app = make({
        gateway: gatewayOf(slow),
        maxStreams: 1,
        unhit: async () => {
          throw new Error('redis down');
        },
      });
      const first = post(app, repoId, { message: 'parseConfig' });
      await vi.waitFor(() => expect(slow.streams).toBe(1));
      const ip = nextIp();
      const second = await post(app, repoId, { message: 'parseConfig' }, ip);
      expect(second.statusCode).toBe(429);
      expect(ApiErrorSchema.parse(second.json()).error.details).toEqual({ reason: 'concurrency' });
      expect(logs.join('')).toContain('chat rate-limit rollback failed');
      // 回退失败:计数保持已扣的 1
      expect(Number(await redis.get(redisKeys.chatLimitIp(ipKey(ip))))).toBe(1);
      expect((await first).statusCode).toBe(200);
      await app.close();
    });

    it('真实 socket 断开:上游 signal 被 abort,计数释放,不再写 done', async () => {
      const { repoId } = await seed();
      const slow = new SlowLlm('x'.repeat(400), 20);
      const rec = spyRows();
      const app = make({ gateway: gatewayOf(slow) });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      const body = JSON.stringify({ message: 'parseConfig' });
      let got = '';
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: `/api/repos/${repoId}/chat`,
            headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
          },
          (res) => {
            res.on('data', (d: Buffer) => {
              got += d.toString();
              if (got.includes('event: token')) {
                req.destroy();
                resolve();
              }
            });
          },
        );
        req.on('error', () => {});
        req.end(body);
        setTimeout(() => reject(new Error('no token')), 5000);
      });
      await vi.waitFor(() => expect(slow.aborted).toBe(true));
      await vi.waitFor(() => expect(metrics.activeStreams).toBe(0));
      expect(got).not.toContain('event: done');
      expect(rec.roles).toEqual(['user']);
      await vi.waitFor(() => expect(rec.usage).toEqual([{ purpose: 'chat', ok: false }]));
      await app.close();
    });

    it('中文问题:改写失败(call 抛错)回落原问题,流照常完成', async () => {
      const { repoId } = await seed();
      const fake = new FakeLlm({ streamText: () => 'ok [[S1:1-2]]' });
      const client: LlmClient = {
        provider: 'fake',
        call: async () => {
          throw new Error('boom');
        },
        stream: (r) => fake.stream(r),
      };
      const rewrite = vi.fn(rewriteQuery);
      const app = make({ gateway: gatewayOf(client), rewrite });
      const q = '配置是怎么解析的 parseConfig';
      const evs = parseSse((await post(app, repoId, { message: q })).body);
      expect(
        evs.filter((e) => e.event === 'tool').map((e) => (e.data as { name: string }).name),
      ).toEqual(['rewrite', 'retrieve']);
      expect(await rewrite.mock.results[0]!.value).toBe(q);
      expect(evs.at(-1)!.event).toBe('done');
      const all = logs.join('');
      expect(all).not.toContain(q);
      expect(all).toContain(questionHash(q));
      await app.close();
    });

    it('预算为 0:改写回落原问题,终答走 fallback(done.fallback=retrieval,usage 0/0)', async () => {
      const { repoId } = await seed();
      const llm = new FakeLlm();
      const app = make({ gateway: gatewayOf(llm, 0) });
      const evs = parseSse((await post(app, repoId, { message: '解析配置 parseConfig' })).body);
      expect(llm.calls + llm.streams).toBe(0);
      const done = evs.at(-1)!;
      expect(done.event).toBe('done');
      expect(done.data).toMatchObject({ fallback: 'retrieval', usage: { in: 0, out: 0 } });
      expect(evs.filter((e) => e.event === 'citation').length).toBeGreaterThan(0);
      expect(evs.some((e) => e.event === 'error')).toBe(false);
      await app.close();
    });

    const spyRows = () => {
      const roles: string[] = [];
      const usage: { purpose: string; ok: boolean }[] = [];
      const im = store.insertChatMessage.bind(store);
      vi.spyOn(store, 'insertChatMessage').mockImplementation(async (m) => {
        roles.push(m.role);
        return im(m);
      });
      const iu = store.insertLlmUsage.bind(store);
      vi.spyOn(store, 'insertLlmUsage').mockImplementation(async (u) => {
        usage.push({ purpose: u.purpose, ok: u.ok });
        return iu(u);
      });
      return { roles, usage };
    };

    for (const honor of [true, false])
      it(`总时限:永不结束的流(${honor ? '响应' : '不理'} signal)→ error 可重试,释放名额,不写 assistant`, async () => {
        const { repoId } = await seed();
        const rec = spyRows();
        const gw = gatewayOf(new HangLlm('partial ', honor));
        const origStream = gw.stream.bind(gw);
        const returned = vi.fn();
        vi.spyOn(gw, 'stream').mockImplementation((r) => {
          const g = origStream(r);
          const ret = g.return.bind(g);
          g.return = (v) => (returned(), ret(v));
          return g;
        });
        const app = make({
          gateway: gw,
          streamTimeoutMs: 150,
          maxStreams: 1,
        });
        const res = await post(app, repoId, { message: 'parseConfig' });
        const evs = parseSse(res.body);
        expect(evs.some((e) => e.event === 'token')).toBe(true);
        expect(evs.at(-1)).toMatchObject({
          event: 'error',
          data: { code: 'LLM_UNAVAILABLE', retryable: true },
        });
        expect(evs.some((e) => e.event === 'done')).toBe(false);
        expect(metrics.activeStreams).toBe(0);
        expect(rec.roles).toEqual(['user']);
        // finally 里对上游迭代器调用了 return(不 await)
        expect(returned).toHaveBeenCalled();
        // 响应 signal 的上游:网关按现有口径记一条 ok=0 的 chat usage
        if (honor)
          await vi.waitFor(() => expect(rec.usage).toEqual([{ purpose: 'chat', ok: false }]));
        // 名额已释放:同一 app 还能再开流
        expect((await post(app, repoId, { message: 'parseConfig' })).statusCode).toBe(200);
        await app.close();
      });

    it('中途断流 → error{LLM_UNAVAILABLE, retryable}', async () => {
      const { repoId } = await seed();
      const rec = spyRows();
      const app = make({
        gateway: gatewayOf(new FakeLlm({ streamText: () => 'a'.repeat(50), breakAfterChunks: 2 })),
      });
      const evs = parseSse((await post(app, repoId, { message: 'parseConfig' })).body);
      expect(evs.at(-1)).toMatchObject({
        event: 'error',
        data: { code: 'LLM_UNAVAILABLE', retryable: true },
      });
      expect(evs.some((e) => e.event === 'done')).toBe(false);
      expect(rec.roles).toEqual(['user']);
      expect(rec.usage).toEqual([{ purpose: 'chat', ok: false }]);
      await app.close();
    });

    it('assistant 写库失败:仍发 done(无 messageId),计数 +1,不发 error', async () => {
      const { repoId } = await seed();
      const orig = store.insertChatMessage.bind(store);
      vi.spyOn(store, 'insertChatMessage').mockImplementation(async (m) => {
        if (m.role === 'assistant') throw new Error('db down');
        return orig(m);
      });
      const app = make({ gateway: gatewayOf(new FakeLlm({ streamText: () => 'ok' })) });
      const evs = parseSse((await post(app, repoId, { message: 'parseConfig' })).body);
      const done = evs.at(-1)!;
      expect(done.event).toBe('done');
      expect(done.data).not.toHaveProperty('messageId');
      expect(evs.some((e) => e.event === 'error')).toBe(false);
      expect(metrics.persistFailTotal).toBe(1);
      await app.close();
    });

    it('user 消息写库失败 → 500,不建流;有密钥时 user_key 为 HMAC', async () => {
      const { repoId } = await seed();
      const secret = 's'.repeat(32);
      const app = make({
        gateway: gatewayOf(new FakeLlm({ streamText: () => 'ok' })),
        userKeySecret: secret,
      });
      const ip = nextIp();
      const ok = parseSse((await post(app, repoId, { message: 'parseConfig' }, ip)).body).at(-1)!;
      const sid = (ok.data as { sessionId: number }).sessionId;
      expect((await store.getChatSession(sid))!.userKey).toBe(userKeyOf(ip, secret));
      vi.spyOn(store, 'insertChatMessage').mockRejectedValue(new Error('db down'));
      const r = await post(app, repoId, { message: 'parseConfig' });
      expect(r.statusCode).toBe(500);
      expect(r.headers['content-type']).not.toContain('event-stream');
      expect(metrics.activeStreams).toBe(0);
      await app.close();
    });
  },
);
