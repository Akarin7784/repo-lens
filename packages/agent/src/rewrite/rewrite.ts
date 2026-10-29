/**
 * T-214 查询改写:中文问题经 LLM 网关(缓存 / 预算 / 熔断)改写成英文检索词,
 * 供向量检索(e5)和关键词检索(英文代码标识符)使用。
 * 任何失败(超预算、熔断打开、调用失败、输出为空或异常)都回退为原问题,不抛错。
 * 每次调用通过 log 回调记录改写前后(只记问题文本,不记 key)。
 */
import { createHash } from 'node:crypto';
import type { LlmGateway } from '../llm/gateway.js';
import { LlmError } from '../llm/types.js';

/** 提示词或后处理改动必须递增;它是改写缓存 key 的一部分。rw-2:不输出文件名;rw-3:保留类别词及其标识符形态 */
export const REWRITE_PROMPT_VERSION = 'rw-3';

/** 改写固定温度 0:同一问题、同一提示词版本的结果可复现 */
export const REWRITE_TEMPERATURE = 0;

/**
 * 改写提示词。示例刻意选与被测仓库无关的通用主题(购物车、日志),
 * 不得出现验收留出集(docs/RAG_HOLDOUT.md)的题目原话或中文关键词组合。
 */
export const REWRITE_SYSTEM = [
  'You turn a developer question about a code repository into a short English search query for code search.',
  'Rules:',
  '- Output one line only: English keywords, no explanation, no quotes.',
  '- Keep identifiers and English words from the question unchanged.',
  '- Add likely code identifiers (camelCase function or class names) and concept words a codebase would use.',
  '- Keep the general category word of the topic and its identifier forms: noun, plural, agent noun ending in -er/-or, PascalCase class name (e.g. log, logs, logger, Logger).',
  '- Never output file names, paths or file extensions (no .ts, .js, no slashes).',
  '- At most 16 words.',
  'Examples:',
  'Q: 购物车总价的计算逻辑? A: shopping cart carts Cart CartItem total price calculateTotal subtotal',
  'Q: 日志写出的代码? A: logging log logs logger Logger writeLog level appender',
].join('\n');

export interface RewriteLog {
  original: string;
  rewritten: string;
  /** rewritten 为 true 表示用了改写结果;false 时 reason 说明回退原因 */
  used: boolean;
  reason?: 'not-chinese' | 'budget' | 'breaker' | 'unavailable' | 'empty' | 'error';
  cacheHit?: boolean;
  costMicroUsd?: number;
}

/** 改写结果缓存(问题 + 提示词版本 + 模型):命中时不调模型,同一问题多次改写结果一致 */
export interface RewriteCache {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
}

export function rewriteCacheKey(question: string, model: string): string {
  const h = createHash('sha256').update(question.trim()).digest('hex');
  return `rewrite:${REWRITE_PROMPT_VERSION}:${model}:${h}`;
}

const FILE_NAME = /(?:^|\s)(?:[\w.-]*\/)*[\w-]+\.(?:[cm]?[jt]sx?|json|md)(?=\s|$)/g;

/** 后处理:去掉文件名/路径形式的词(提示词已要求不输出,这里兜底),合并空白 */
export function stripFileNames(line: string): string {
  return line.replace(FILE_NAME, ' ').replace(/\s+/g, ' ').trim();
}

export interface RewriteOptions {
  gateway: LlmGateway;
  model: string;
  repoId?: number;
  sessionId?: number;
  log?: (entry: RewriteLog) => void;
  cache?: RewriteCache;
  signal?: AbortSignal;
}

const HAS_CJK = /[\u3400-\u9fff]/;

/** 改写;返回最终用于检索的查询(失败回退原问题) */
export async function rewriteQuery(question: string, o: RewriteOptions): Promise<string> {
  const q = question.trim();
  const done = (rewritten: string, extra: Omit<RewriteLog, 'original' | 'rewritten'>) => {
    o.log?.({ original: q, rewritten, ...extra });
    return rewritten;
  };
  if (!HAS_CJK.test(q)) return done(q, { used: false, reason: 'not-chinese' });
  const ck = rewriteCacheKey(q, o.model);
  const cached = o.cache ? await o.cache.get(ck) : null;
  if (cached) return done(cached, { used: true, cacheHit: true, costMicroUsd: 0 });
  try {
    const r = await o.gateway.complete({
      purpose: 'chat',
      model: o.model,
      repoId: o.repoId,
      sessionId: o.sessionId,
      temperature: REWRITE_TEMPERATURE,
      maxTokens: 64,
      signal: o.signal,
      messages: [
        { role: 'system', content: REWRITE_SYSTEM },
        { role: 'user', content: `Q: ${q} A:` },
      ],
    });
    const raw = (r.text.split('\n').find((l) => l.trim()) ?? '')
      .replace(/^\s*A:\s*/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim()
      .slice(0, 300);
    const line = stripFileNames(raw);
    if (!line || HAS_CJK.test(line)) return done(q, { used: false, reason: 'empty' });
    await o.cache?.set(ck, line);
    return done(line, { used: true, cacheHit: r.cacheHit, costMicroUsd: r.costMicroUsd });
  } catch (err) {
    const reason =
      err instanceof LlmError
        ? err.code === 'BUDGET_EXCEEDED'
          ? 'budget'
          : (err.cause as { name?: string } | undefined)?.name === 'CircuitOpenError'
            ? 'breaker'
            : 'unavailable'
        : 'error';
    return done(q, { used: false, reason });
  }
}
