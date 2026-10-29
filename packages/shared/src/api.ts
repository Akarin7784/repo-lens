import { z } from 'zod';
import { CommitShaSchema, NodeIdSchema } from './ids.js';
import { ProgressStageSchema } from './progress.js';

/** T-214 向量化状态 */
export const EmbeddingStatusSchema = z.enum(['ready', 'reused', 'skipped', 'failed']);
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;

const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/;

/** POST /api/repos */
export const CreateRepoRequestSchema = z.object({
  repoUrl: z.string().regex(GITHUB_URL, '仅支持 https://github.com/<owner>/<repo>'),
  ref: z.string().min(1).optional(),
});
export const CreateRepoResponseSchema = z.object({
  repoId: z.number().int().positive(),
  jobId: z.string().min(1),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  repo: z.string(),
  commitSha: CommitShaSchema,
});

export const API_ERROR_CODES = [
  'UNSUPPORTED_LANGUAGE',
  'INVALID_REPO_URL',
  'BAD_REQUEST',
  'REPO_TOO_LARGE',
  'REPO_NOT_PUBLIC',
  'REPO_NOT_FOUND',
  'REPO_NOT_READY',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
/** BAD_REQUEST(HTTP 400):查询参数格式非法(如 parentId 不合法、start>end);格式合法但资源不存在用 404。*/
/** 例:422 { error: { code: 'UNSUPPORTED_LANGUAGE', message: '第 1 周仅支持 TypeScript 仓库' } } */
export const ApiErrorSchema = z.object({
  error: z.object({ code: z.enum(API_ERROR_CODES), message: z.string() }),
});

/** GET /api/repos/:id;`repo`/`commitSha` 与 CreateRepoResponse 同名同义;commitSha 优先取最近一次 done 任务的 commit,没有 done 任务时取最新任务的;jobId/status/stage 始终是最新任务的 */
export const RepoStatusSchema = z.object({
  repoId: z.number().int().positive(),
  jobId: z.string().min(1),
  /** `owner/name` */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  commitSha: CommitShaSchema,
  status: z.enum(['queued', 'running', 'done', 'failed']),
  stage: ProgressStageSchema,
  progress: z.number().min(0).max(100),
  stats: z.object({ files: z.number(), modules: z.number(), edges: z.number() }).partial(),
  error: z.string().nullable(),
  /**
   * T-214:commitSha 对应任务的向量化状态。ready=本次写入,reused=复用已有向量,
   * skipped=未配置向量库,failed=向量化失败(图与摘要照常可用)。旧任务或尚未跑到该阶段为 null。
   * 检索(T-214 第二部分 / W3 /chat)只有 ready|reused 时用向量检索,否则降级为纯关键词检索,不报错。
   * 只增不改:缺省按 null 解析。
   */
  embeddingStatus: EmbeddingStatusSchema.nullable().default(null),
});

/** GET /api/repos/:id/graph?parentId= */
/** includeExternal=true 时额外返回派生的 x:<包名> 节点及指向它们的边(默认不返回) */
export const GraphQuerySchema = z.object({
  parentId: NodeIdSchema.optional(),
  includeExternal: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/** GET /api/repos/:id/files?path=&start=&end= */
export const FileQuerySchema = z.object({
  path: z.string().min(1),
  start: z.coerce.number().int().positive().optional(),
  end: z.coerce.number().int().positive().optional(),
});

/** GET /api/repos/:id/nodes/:nodeId */
export const NodeDetailSchema = z.object({
  id: NodeIdSchema,
  kind: z.enum(['module', 'dir', 'file', 'external']),
  path: z.string(),
  summary: z.string().nullable(),
  exports: z.array(z.string()),
  loc: z.number().int().nonnegative(),
  inDegree: z.number().int().nonnegative(),
  outDegree: z.number().int().nonnegative(),
  topDependents: z.array(NodeIdSchema),
  /** T-211c:摘要来源;summary 为 null 时为 null。缺省按 null 解析(只增不减,兼容旧响应/旧 mock) */
  summarySource: z.enum(['llm', 'rule']).nullable().default(null),
  /** T-211c:节点是否处于某个环(SCC 成员集合)中;module/dir 为其下任一文件在环中。缺省按 false 解析 */
  inCycle: z.boolean().default(false),
});

/** POST /api/repos/:id/chat */
export const ChatRequestSchema = z.object({
  sessionId: z.number().int().positive().optional(),
  message: z.string().min(1).max(4000),
  contextNodeIds: z.array(NodeIdSchema).max(50).optional(),
});

/** GET /health */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  time: z.string(),
});

export type CreateRepoRequest = z.infer<typeof CreateRepoRequestSchema>;
export type CreateRepoResponse = z.infer<typeof CreateRepoResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
export type GraphQuery = z.infer<typeof GraphQuerySchema>;
export type FileQuery = z.infer<typeof FileQuerySchema>;
export type NodeDetail = z.infer<typeof NodeDetailSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
