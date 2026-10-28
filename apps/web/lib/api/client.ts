import {
  CreateRepoResponseSchema,
  GraphDataSchema,
  RepoStatusSchema,
  type CreateRepoRequest,
  type CreateRepoResponse,
  type GraphData,
  type RepoStatus,
} from '@repolens/shared';
import { apiBase } from './config';
import { ApiRequestError, toApiError } from './errors';

/** zod schema 的最小结构(web 不直接依赖 zod,schema 全部来自 @repolens/shared) */
type Schema<T> = {
  safeParse(
    v: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
};

export type ApiClient = {
  createRepo(req: CreateRepoRequest): Promise<CreateRepoResponse>;
  getRepoStatus(repoId: number): Promise<RepoStatus>;
  getGraph(repoId: number, parentId: string | null): Promise<GraphData>;
  /** SSE 地址(EventSource 需要完整 URL) */
  jobEventsUrl(jobId: string): string;
};

/**
 * 所有响应都过 shared 的 zod schema:2xx 不符合 → INVALID_RESPONSE;非 2xx → ApiErrorSchema 里的错误码。
 * fetch 可注入,方便单测。
 */
export function createApiClient(
  base = apiBase(),
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): ApiClient {
  async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      });
    } catch (e) {
      throw new ApiRequestError('NETWORK', e instanceof Error ? e.message : String(e));
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON 响应体,下面按状态码处理 */
    }
    if (!res.ok) throw toApiError(res.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new ApiRequestError(
        'INVALID_RESPONSE',
        parsed.error.issues[0]?.message ?? '响应校验失败',
        res.status,
      );
    return parsed.data;
  }

  return {
    createRepo: (req) =>
      request('/api/repos', CreateRepoResponseSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      }),
    getRepoStatus: (repoId) => request(`/api/repos/${repoId}`, RepoStatusSchema),
    getGraph: (repoId, parentId) =>
      request(
        `/api/repos/${repoId}/graph${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''}`,
        GraphDataSchema,
      ),
    jobEventsUrl: (jobId) => `${base}/api/jobs/${encodeURIComponent(jobId)}/events`,
  };
}
