/**
 * T-214 查询改写:中文问题经 LLM 网关(缓存 / 预算 / 熔断)改写成英文检索词,
 * 供向量检索(e5)和关键词检索(英文代码标识符)使用。
 * 任何失败(超预算、熔断打开、调用失败、输出为空或异常)都回退为原问题,不抛错。
 * 每次调用通过 log 回调记录改写前后(只记问题文本,不记 key)。
 */
import type { LlmGateway } from '../llm/gateway.js';
import { LlmError } from '../llm/types.js';

export const REWRITE_PROMPT_VERSION = 'rw-1';

/**
 * 改写提示词。示例刻意选与被测仓库无关的通用主题(数据库连接池、命令行参数),
 * 不得出现验收留出集(docs/RAG_HOLDOUT.md)的题目原话或中文关键词组合。
 */
export const REWRITE_SYSTEM = [
  'You turn a developer question about a code repository into a short English search query for code search.',
  'Rules:',
  '- Output one line only: English keywords, no explanation, no quotes.',
  '- Keep identifiers, file names and English words from the question unchanged.',
  '- Add likely code identifiers (camelCase function or class names) and file-name words a codebase would use.',
  '- At most 16 words.',
  'Examples:',
  'Q: 连接池的创建代码? A: database connection pool create createPool pool.ts',
  'Q: 命令行参数的解析逻辑? A: parse command line arguments argv parseArgs cli options',
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

export interface RewriteOptions {
  gateway: LlmGateway;
  model: string;
  repoId?: number;
  sessionId?: number;
  log?: (entry: RewriteLog) => void;
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
  try {
    const r = await o.gateway.complete({
      purpose: 'chat',
      model: o.model,
      repoId: o.repoId,
      sessionId: o.sessionId,
      temperature: 0,
      maxTokens: 64,
      signal: o.signal,
      messages: [
        { role: 'system', content: REWRITE_SYSTEM },
        { role: 'user', content: `Q: ${q} A:` },
      ],
    });
    const line = (r.text.split('\n').find((l) => l.trim()) ?? '')
      .replace(/^\s*A:\s*/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim()
      .slice(0, 300);
    if (!line || HAS_CJK.test(line)) return done(q, { used: false, reason: 'empty' });
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
