import { z } from 'zod';
import { CommitShaSchema, NodeIdSchema } from './ids.js';
import { ProgressStageSchema } from './progress.js';

/** T-214 向量化状态 */
export const EmbeddingStatusSchema = z.enum(['ready', 'reused', 'skipped', 'failed']);
export const EmbeddingProviderSchema = z.enum(['local', 'dashscope']);
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
  'FILE_NOT_FOUND',
  'REPO_NOT_READY',
  'RATE_LIMITED',
  'INTERNAL',
  /** HTTP 503:服务端 git 不可用(未安装)或 ls-remote 超时;details.gitReason 为 GIT_MISSING / GIT_TIMEOUT / GIT_OUTPUT_TOO_LARGE(不占用 reason 枚举) */
  'GIT_UNAVAILABLE',
] as const;
/** BAD_REQUEST(HTTP 400):查询参数格式非法(如 parentId 不合法、start>end);格式合法但资源不存在用 404。*/
/** 例:422 { error: { code: 'UNSUPPORTED_LANGUAGE', message: '目前仅支持 TypeScript/JavaScript 仓库' } } */
/**
 * 409 REPO_NOT_READY 的子原因(`error.details.reason`):
 * GRAPH_NOT_READY=依赖图尚未生成;SNAPSHOT_MISSING=源码快照缺失或已被清理;
 * REPOS_DIR_NOT_CONFIGURED=api 未配置 REPOS_DIR。只增不改。
 */
export const REPO_NOT_READY_REASONS = [
  'GRAPH_NOT_READY',
  'SNAPSHOT_MISSING',
  'REPOS_DIR_NOT_CONFIGURED',
] as const;
export type RepoNotReadyReason = (typeof REPO_NOT_READY_REASONS)[number];
/**
 * 429 RATE_LIMITED 的子原因(`error.details.reason`,可选,旧前端可忽略):
 * rate_limit=按 IP 的每小时提问次数用完(按 UTC 整点分桶),带 `retryAfterSec`=距下一个整点的秒数(向上取整,1–3600);
 * concurrency=全局问答并发已满,不带 `retryAfterSec`(何时有空位不可预测)。只增不改。
 */
export const RATE_LIMITED_REASONS = ['rate_limit', 'concurrency'] as const;
export type RateLimitedReason = (typeof RATE_LIMITED_REASONS)[number];
/** FILE_NOT_FOUND(HTTP 404):仓库存在但快照里没有该文件;REPO_NOT_FOUND 只表示仓库/任务/节点不存在 */
export const ApiErrorSchema = z.object({
  error: z
    .object({
      code: z.enum(API_ERROR_CODES),
      message: z.string(),
      /**
       * 可选细节;REPO_NOT_READY 与 RATE_LIMITED 可带 reason(各自枚举),RATE_LIMITED 的 rate_limit 另可带 retryAfterSec。
       * 允许附加其他字段(只增不改);reason 若出现必须是该 code 对应的枚举值。
       */
      details: z
        .object({
          /**
           * 保持严格 enum:以后加新 reason 必须同步发 shared(schema 与测试一起改),
           * 否则新值在这里校验失败;web 端靠 looseError 对未知 reason 兜底(按通用错误文案处理)。
           */
          reason: z.enum([...REPO_NOT_READY_REASONS, ...RATE_LIMITED_REASONS]).optional(),
          /** 只能与 reason='rate_limit' 同现;正整数秒,≤3600(小时桶) */
          retryAfterSec: z.number().int().positive().max(3600).optional(),
        })
        .passthrough()
        .optional(),
    })
    .superRefine((e, ctx) => {
      const reason = e.details?.reason;
      if (e.details?.retryAfterSec !== undefined && reason !== 'rate_limit')
        ctx.addIssue({
          code: 'custom',
          path: ['details', 'retryAfterSec'],
          message: "retryAfterSec 只能与 reason='rate_limit' 同现",
        });
      if (reason === undefined) return;
      const rl = (RATE_LIMITED_REASONS as readonly string[]).includes(reason);
      if (rl !== (e.code === 'RATE_LIMITED'))
        ctx.addIssue({
          code: 'custom',
          path: ['details', 'reason'],
          message: `reason ${reason} 与 code ${e.code} 不匹配`,
        });
    }),
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
  /**
   * P4:commitSha 对应任务索引时用的 embedding provider(worker 写入 stats.embeddingProvider)。
   * 问答检索据此判断查询与索引是否同源。只增不改:旧任务没有该字段时省略。
   */
  embeddingProvider: EmbeddingProviderSchema.optional(),
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

/**
 * POST /api/repos/:id/chat(路由尚未实现,P4)。
 * - message:去掉首尾空白后 1..2000 字符(解析结果为 trim 后的值)。
 * - contextNodeIds:可选,最多 20 个合法节点 id;W3 只做格式校验,服务端忽略(不参与检索)。
 * - 未知字段一律拒绝(.strict())。
 */
export const CHAT_MESSAGE_MAX = 2000;
export const CHAT_CONTEXT_NODES_MAX = 20;
export const ChatRequestSchema = z
  .object({
    sessionId: z.number().int().positive().optional(),
    message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
    contextNodeIds: z.array(NodeIdSchema).max(CHAT_CONTEXT_NODES_MAX).optional(),
  })
  .strict();

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
