import { z } from 'zod';
import { FileIdSchema, ModuleIdSchema } from './ids.js';

export const TokenEventSchema = z.object({
  event: z.literal('token'),
  data: z.object({ text: z.string() }),
});

/** 只下发校验通过的引用,没有 verified 字段 */
export const CitationSchema = z
  .object({
    id: z.number().int().positive(),
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    nodeId: FileIdSchema,
    moduleId: ModuleIdSchema.optional(),
  })
  .strict()
  .refine((c) => c.endLine >= c.startLine, 'endLine 不能小于 startLine');
export type Citation = z.infer<typeof CitationSchema>;
export const CitationEventSchema = z.object({ event: z.literal('citation'), data: CitationSchema });

export const ChatDoneSchema = z.object({
  messageId: z.number().int().positive(),
  droppedCitations: z.number().int().nonnegative(),
  fallback: z.literal('retrieval').optional(),
  usage: z.object({ in: z.number().int().nonnegative(), out: z.number().int().nonnegative() }),
});
export const ChatDoneEventSchema = z.object({ event: z.literal('done'), data: ChatDoneSchema });

export const CHAT_ERROR_CODES = [
  'LLM_UNAVAILABLE',
  'BUDGET_EXCEEDED',
  'REPO_NOT_READY',
  'RATE_LIMITED',
] as const;
/** 出错时替代 done,之后直接结束流 */
export const ChatErrorEventSchema = z.object({
  event: z.literal('error'),
  data: z.object({ code: z.enum(CHAT_ERROR_CODES), message: z.string(), retryable: z.boolean() }),
});

/** 可选,前端可忽略 */
export const ToolEventSchema = z.object({
  event: z.literal('tool'),
  data: z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()) }),
});

/** POST /api/repos/:id/chat 的 SSE 事件。注意:不设 reset 事件(定位类问题由后端缓冲) */
export const ChatEventSchema = z.discriminatedUnion('event', [
  TokenEventSchema,
  CitationEventSchema,
  ChatDoneEventSchema,
  ChatErrorEventSchema,
  ToolEventSchema,
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
