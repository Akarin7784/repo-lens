import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  ChatRequestSchema,
  sensitiveContentRule,
  type Citation,
  type ChatEvent,
} from '@repolens/shared';
import { LLM_CACHE_TTL_S, redisKeys, type CodeChunkRow, type Store } from '@repolens/db';
import {
  LlmError,
  rewriteQuery,
  type LlmGateway,
  type RewriteCache,
  type RewriteLog,
} from '@repolens/agent';
import { hybridSearch, type Embedder, type VectorStore } from '@repolens/rag';
import { HttpError } from '../errors.js';
import { ipKey } from '../ip-key.js';
import { citationWithinSnippet, prepareSnippet, type PreparedSnippet } from './chunk-guard.js';
import { CitationStream, type CitationOutput } from './citations.js';
import { assemblePrompt, type Snippet } from './prompt.js';

/** 检索 top-k(与评测一致) */
export const CHAT_TOP_K = 5;
/** 会话标题:问题前 50 字 */
const TITLE_CHARS = 50;
/** 终答输出上限 */
const ANSWER_MAX_TOKENS = 1024;

export interface ChatMetrics {
  /** assistant 消息写库失败次数(chat_persist_fail_total) */
  persistFailTotal: number;
  /** 当前进行中的问答流数(含流开始前已占位的请求) */
  activeStreams: number;
}

export interface ChatDeps {
  gateway: LlmGateway;
  /** LLM_CHAT_MODEL(改写与终答同一模型) */
  model: string;
  /** 查询用 embedder 与向量库;未配置时 hybridSearch 降级 keyword-only(no-vector-store) */
  embedder?: Embedder | null;
  vectorStore?: VectorStore | null;
  /** RATE_LIMIT_CHAT_PER_HOUR,默认 30 */
  perHour?: number;
  /** CHAT_MAX_CONCURRENT_STREAMS,默认 8(进程内计数) */
  maxStreams?: number;
  /** CHAT_USER_KEY_SECRET;未配置时 user_key 存 null */
  userKeySecret?: string | null;
  /** 改写缓存;生产为 Redis(redisRewriteCache) */
  rewriteCache?: RewriteCache;
  /** 测试注入点;默认就是 @repolens/agent 的 rewriteQuery */
  rewrite?: typeof rewriteQuery;
  metrics?: ChatMetrics;
  pingIntervalMs?: number;
}

/** 路由实际使用的改写函数(测试断言它就是 agent 导出的 rewriteQuery) */
export const resolveRewrite = (d: Pick<ChatDeps, 'rewrite'>) => d.rewrite ?? rewriteQuery;

export function redisRewriteCache(redis: Pick<Redis, 'get' | 'set'>): RewriteCache {
  return {
    get: (k) => redis.get(k),
    set: async (k, v) => {
      await redis.set(k, v, 'EX', LLM_CACHE_TTL_S);
    },
  };
}

/** user_key:配置密钥时 HMAC-SHA256(secret, ipKey) 前 32 位十六进制;否则 null(不存裸 IP 哈希) */
export function userKeyOf(ip: string, secret: string | null | undefined): string | null {
  if (!secret) return null;
  return createHmac('sha256', secret).update(ipKey(ip)).digest('hex').slice(0, 32);
}

export const questionHash = (q: string) =>
  createHash('sha256').update(q.trim()).digest('hex').slice(0, 16);

const HAS_CJK = /[\u3400-\u9fff]/;
const chunkKey = (c: { path: string; symbol: string | null; startLine: number; endLine: number }) =>
  `${c.path}\0${c.symbol ?? ''}\0${c.startLine}\0${c.endLine}`;

const frame = (e: ChatEvent) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;

interface Hit {
  (key: string): Promise<number>;
}

/**
 * POST /api/repos/:id/chat。流开始前的检查顺序:id → schema → 限流 / 并发 → 404 / 409,
 * 都走 HTTP + ApiError;流开始后只用 SSE error 事件。
 */
export function registerChatRoute(
  app: FastifyInstance,
  o: { store: Store; hit: Hit; chat: ChatDeps; repoIdOf: (raw: string) => number },
) {
  const { store, chat } = o;
  const perHour = chat.perHour ?? 30;
  const maxStreams = chat.maxStreams ?? 8;
  const rewrite = resolveRewrite(chat);
  const metrics = chat.metrics ?? { persistFailTotal: 0, activeStreams: 0 };

  app.post<{ Params: { id: string } }>('/api/repos/:id/chat', async (req, reply) => {
    // 1. id
    const repoId = o.repoIdOf(req.params.id);
    // 2. schema:details 只给字段路径,不回显用户内容
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError('BAD_REQUEST', '请求体无效', {
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    const { message: question, sessionId: reqSession } = parsed.data;
    // 3. 限流(计入之后的 404/409/失败)+ 全局并发
    const ik = ipKey(req.ip);
    if ((await o.hit(redisKeys.chatLimitIp(ik))) > perHour)
      throw new HttpError('RATE_LIMITED', `每个 IP 每小时最多提问 ${perHour} 次`);
    if (metrics.activeStreams >= maxStreams)
      // 设计 §7 要 details.reason='concurrency',但 ApiErrorSchema 的 reason 只允许 REPO_NOT_READY 枚举;
      // 共享契约未扩展前不带 details(见 PR「契约缺口」)
      throw new HttpError('RATE_LIMITED', '当前问答并发已满,请稍后再试');
    metrics.activeStreams++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      metrics.activeStreams--;
    };
    let hijacked = false;
    try {
      // 4. 404 / 409
      const repo = await store.getRepo(repoId);
      if (!repo) throw new HttpError('REPO_NOT_FOUND', '仓库不存在');
      let sessionId: number;
      if (reqSession !== undefined) {
        const s = await store.getChatSession(reqSession);
        if (!s || s.repoId !== repoId) throw new HttpError('REPO_NOT_FOUND', '会话不存在');
        sessionId = s.id;
      } else sessionId = 0;
      const task = await store.latestDoneTask(repoId);
      if (!task) throw new HttpError('REPO_NOT_READY', '仓库尚未分析完成');

      if (!sessionId)
        sessionId = (
          await store.createChatSession({
            repoId,
            userKey: userKeyOf(req.ip, chat.userKeySecret),
            title: question.slice(0, TITLE_CHARS),
          })
        ).id;
      // user 消息存原文;写不进去时 500,不建流
      await store.insertChatMessage({ sessionId, role: 'user', content: question });

      hijacked = true;
      reply.hijack();
      await runStream({ req, raw: reply.raw, repoId, sessionId, task, question });
    } finally {
      release();
      if (hijacked && !reply.raw.writableEnded) reply.raw.end();
    }
  });

  async function runStream(s: {
    req: { log: FastifyInstance['log'] };
    raw: import('node:http').ServerResponse;
    repoId: number;
    sessionId: number;
    task: NonNullable<Awaited<ReturnType<Store['latestDoneTask']>>>;
    question: string;
  }) {
    const { raw, repoId, sessionId, task, question } = s;
    const log = s.req.log;
    const started = Date.now();
    const ac = new AbortController();
    // 断开检测:response 的 close 且未正常结束(不能用 req.raw close,见 PR 说明)
    raw.on('close', () => {
      if (!raw.writableEnded) ac.abort(new Error('client disconnected'));
    });
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.flushHeaders?.();
    const ping = setInterval(() => {
      if (!ac.signal.aborted) raw.write(': ping\n\n');
    }, chat.pingIntervalMs ?? 15_000);
    const send = (e: ChatEvent) => {
      if (!ac.signal.aborted && !raw.writableEnded) raw.write(frame(e));
    };

    let answer = '';
    const citations: Citation[] = [];
    let cs: CitationStream | null = null;
    let routeDropped = 0;
    let retrievalIds: string[] = [];
    const emit = (outs: CitationOutput[], snippets: readonly Snippet[]) => {
      for (const x of outs) {
        if (x.type === 'token') {
          answer += x.text;
          send({ event: 'token', data: { text: x.text } });
        } else {
          // 路由层断言:引用必须落在某个同路径片段的有效区间内
          const ok = snippets.some(
            (sn) => sn.path === x.citation.path && citationWithinSnippet(x.citation, sn),
          );
          if (!ok) {
            routeDropped++;
            continue;
          }
          citations.push(x.citation);
          send({ event: 'citation', data: x.citation });
        }
      }
    };
    const persistAssistant = async () => {
      try {
        const row = await store.insertChatMessage({
          sessionId,
          role: 'assistant',
          content: answer,
          citations,
          droppedCitations: (cs?.dropped ?? 0) + routeDropped,
          retrievalIds,
          latencyMs: Date.now() - started,
        });
        return row.id;
      } catch (err) {
        metrics.persistFailTotal++;
        log.error(
          { repoId, sessionId, err: (err as Error)?.name ?? 'Error' },
          'chat assistant message persist failed',
        );
        return undefined;
      }
    };

    try {
      // 改写(只中文问题)
      let rewritten = question;
      if (HAS_CJK.test(question)) {
        send({ event: 'tool', data: { name: 'rewrite', args: {} } });
        rewritten = await rewrite(question, {
          gateway: chat.gateway,
          model: chat.model,
          repoId,
          sessionId,
          cache: chat.rewriteCache,
          signal: ac.signal,
          log: (e: RewriteLog) => logRewrite(log, repoId, sessionId, e),
        });
      }
      if (ac.signal.aborted) return;
      // 检索:chunks 从 code_chunk 重读(hybridSearch 结果不带 content / content_hash)
      send({ event: 'tool', data: { name: 'retrieve', args: { k: CHAT_TOP_K } } });
      const rows = await store.listCodeChunks(repoId, task.commitSha);
      const st = task.stats;
      const result = await hybridSearch({
        repoId,
        commitSha: task.commitSha,
        question,
        rewritten,
        chunks: rows,
        embeddingStatus: st.embeddingStatus,
        embedder: chat.embedder,
        vectorStore: chat.vectorStore,
        // 三项都来自该 commit 的 done 任务 stats,不从环境变量推断;缺字段口径见 embeddingMismatch
        indexedProvider: st.embeddingProvider,
        indexedModel: st.embeddingModel,
        indexedDim: st.embeddingDim,
        limit: CHAT_TOP_K,
      });
      if (result.retrieval !== 'hybrid')
        log.info(
          { repoId, sessionId, degradedReason: result.degradedReason },
          'chat retrieval degraded',
        );
      const byKey = new Map<string, CodeChunkRow>(rows.map((r) => [chunkKey(r), r]));
      const prepared: (PreparedSnippet & { pointId: string })[] = [];
      for (const h of result.hits) {
        const row = byKey.get(chunkKey(h));
        const p = row ? prepareSnippet(row) : null;
        if (!row || !p) {
          log.warn({ repoId, path: h.path }, 'chat snippet rejected');
          continue;
        }
        prepared.push({ ...p, pointId: row.qdrantPointId });
      }
      const prompt = assemblePrompt(question, prepared);
      const usedIds = new Set(prompt.snippets.map((sn) => `${sn.path}\0${sn.startLine}`));
      retrievalIds = prepared
        .filter((p) => usedIds.has(`${p.path}\0${p.startLine}`))
        .map((p) => p.pointId);
      cs = new CitationStream(prompt.snippets);

      let usage = { in: 0, out: 0 };
      let fallback = false;
      let gotToken = false;
      try {
        const it = chat.gateway.stream({
          purpose: 'chat',
          model: chat.model,
          repoId,
          sessionId,
          maxTokens: ANSWER_MAX_TOKENS,
          temperature: 0,
          signal: ac.signal,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        });
        for (;;) {
          const r = await it.next();
          if (r.done) {
            usage = { in: r.value.usage.tokensIn, out: r.value.usage.tokensOut };
            break;
          }
          gotToken = true;
          emit(cs.push(r.value.text), prompt.snippets);
        }
        emit(cs.end(), prompt.snippets);
      } catch (err) {
        if (ac.signal.aborted) {
          await persistAssistant();
          return;
        }
        const preToken =
          !gotToken &&
          err instanceof LlmError &&
          (err.code === 'BUDGET_EXCEEDED' ||
            (err.cause as { name?: string } | undefined)?.name === 'CircuitOpenError');
        if (!preToken) {
          await persistAssistant();
          send({
            event: 'error',
            data: { code: 'LLM_UNAVAILABLE', message: '回答生成中断,请重试', retryable: true },
          });
          return;
        }
        // 预算 / 熔断:不报 error,列出检索片段(引用照常校验)
        fallback = true;
        cs = new CitationStream(prompt.snippets);
        const text =
          prompt.snippets.length > 0
            ? `模型暂不可用,以下是检索到的相关代码:\n${prompt.snippets
                .map((sn) => `- ${sn.path} [[S${sn.n}:${sn.startLine}-${sn.endLine}]]`)
                .join('\n')}`
            : '模型暂不可用,且没有检索到相关代码。';
        emit([...cs.push(text), ...cs.end()], prompt.snippets);
      }
      const messageId = await persistAssistant();
      send({
        event: 'done',
        data: {
          ...(messageId !== undefined ? { messageId } : {}),
          sessionId,
          droppedCitations: cs.dropped + routeDropped,
          ...(fallback ? { fallback: 'retrieval' as const } : {}),
          retrieval: result.retrieval,
          usage,
        },
      });
    } catch (err) {
      log.error({ repoId, sessionId, err: (err as Error)?.name ?? 'Error' }, 'chat stream failed');
      if (!ac.signal.aborted) {
        await persistAssistant();
        send({
          event: 'error',
          data: { code: 'LLM_UNAVAILABLE', message: '问答服务出错,请重试', retryable: true },
        });
      }
    } finally {
      clearInterval(ping);
      // 无条件 abort:网关只在 for-await 走完或抛错时记账,提前退出时靠它关上游
      ac.abort();
      if (!raw.writableEnded) raw.end();
    }
  }
}

/** 改写日志:不放用户原文(original 丢掉,只记 hash);rewritten 命中敏感规则时只记 hash */
export function logRewrite(
  log: { info(obj: object, msg: string): void },
  repoId: number,
  sessionId: number,
  e: RewriteLog,
) {
  const redacted = e.rewritten && sensitiveContentRule(e.rewritten) !== null;
  log.info(
    {
      repoId,
      sessionId,
      rewriteUsed: e.used,
      reason: e.reason,
      cacheHit: e.cacheHit,
      costMicroUsd: e.costMicroUsd,
      questionHash: questionHash(e.original),
      ...(redacted
        ? { rewrittenHash: questionHash(e.rewritten), rewrittenRedacted: true }
        : { rewritten: e.used ? e.rewritten : undefined }),
    },
    'chat rewrite',
  );
}
