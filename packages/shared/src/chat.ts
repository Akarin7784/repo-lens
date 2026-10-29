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
  /** P4:落库的 assistant 消息 id;写 assistant 消息失败时 done 不带 messageId(不兜底、不造假 id)。前端 #99 已按可选处理 */
  messageId: z.number().int().positive().optional(),
  /** 本轮所属 chat_session;schema 上可选(只增不改),服务端始终填写。前端下一轮请求带回它即可续聊 */
  sessionId: z.number().int().positive().optional(),
  droppedCitations: z.number().int().nonnegative(),
  fallback: z.literal('retrieval').optional(),
  /** T-214 定案:本次检索是否用上向量;keyword-only 时前端显示「已降级为关键词检索」。可选,只增不改 */
  retrieval: z.enum(['hybrid', 'keyword-only']).optional(),
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
