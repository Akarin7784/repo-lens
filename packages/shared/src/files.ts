import { z } from 'zod';
import { CommitShaSchema } from './ids.js';
import { SENSITIVE_PLACEHOLDER } from './sensitive.js';

/** T-213:单次最多返回的行数(WEEK2_PLAN T-213) */
export const FILE_MAX_LINES = 2000;

/**
 * 仓库内相对路径的安全校验(api `/files` 与 worker 共用):拒绝空串、NUL、反斜杠、绝对路径、盘符,
 * 以及任何 `..` / `.` / 空段(即必须已是规范化 POSIX 路径)。合法时原样返回,否则 null。
 * 纯字符串实现,不依赖 node:path,浏览器端也能用。
 */
export function safeRelPath(p: string): string | null {
  if (!p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p))
    return null;
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return null;
  return p;
}

/** `excluded.reason` 枚举(只增不改):敏感 / 过大 / 二进制 */
export const EXCLUDED_REASONS = ['sensitive', 'too-large', 'binary'] as const;
export type ExcludedReason = (typeof EXCLUDED_REASONS)[number];

/** 共享排除规则 id(exclusionRule 的返回值)→ excluded.reason;敏感规则 id 一律归为 sensitive */
export function excludedReasonOf(rule: string): ExcludedReason {
  return rule === 'too-large' || rule === 'binary' ? rule : 'sensitive';
}

/** 已排除文件的提示文案:敏感用 SENSITIVE_PLACEHOLDER,体积/二进制各自说明 */
export function excludedNotice(reason: ExcludedReason): string {
  if (reason === 'too-large') return '[已排除:文件过大,内容不展示、不送模型、不建索引]';
  if (reason === 'binary') return '[已排除:二进制文件,内容不展示、不送模型、不建索引]';
  return SENSITIVE_PLACEHOLDER;
}

/** GET /api/repos/:id/files 响应(T-213;字段只增不改) */
export const FileContentSchema = z.object({
  /** 规范化后的仓库相对路径 */
  path: z.string().min(1),
  /** 内容来自哪个 commit 的快照(与 graph 同源:最近一次已出图任务) */
  commitSha: CommitShaSchema,
  /** 文件总行数(末尾换行不算新行;排除时为 null) */
  totalLines: z.number().int().nonnegative().nullable(),
  /** 实际返回的行区间,1 起、闭区间;空文件或排除时为 null */
  start: z.number().int().positive().nullable(),
  end: z.number().int().positive().nullable(),
  /** 未显式给 end 且后面还有内容时为 true(单次上限 FILE_MAX_LINES 行) */
  hasMore: z.boolean(),
  /** 区间内原文(行间以 \n 连接,不含末尾换行);排除时为 null */
  content: z.string().nullable(),
  /** 命中共享排除规则(敏感 / 过大 / 二进制)时非 null,content 一定为 null */
  excluded: z.object({ reason: z.enum(EXCLUDED_REASONS), notice: z.string().min(1) }).nullable(),
});
export type FileContent = z.infer<typeof FileContentSchema>;
