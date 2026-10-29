import { API_ERROR_CODES, ApiErrorSchema } from '@repolens/shared';

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** shared 错误码 → 面向用户的中文提示(后端 message 作为补充细节显示) */
export const ERROR_TEXT: Record<ApiErrorCode, string> = {
  UNSUPPORTED_LANGUAGE: '暂不支持这个仓库的语言,目前只支持 TypeScript 仓库。',
  INVALID_REPO_URL: '仓库地址无效,请输入 https://github.com/<owner>/<repo>。',
  BAD_REQUEST: '请求参数不合法。',
  REPO_TOO_LARGE: '仓库体积超过上限,暂时无法分析。',
  REPO_NOT_PUBLIC: '只支持公开仓库。',
  REPO_NOT_FOUND: '仓库不存在、不可访问,或分支/提交无效。',
  REPO_NOT_READY: '依赖图还没生成好,请稍后再试。',
  RATE_LIMITED: '提交太频繁了,请稍后再试。',
  INTERNAL: '服务内部错误,请稍后重试。',
};

/** 前端自己的错误(网络不可达、响应不符合 shared schema),不属于 shared 错误码 */
export type ClientErrorCode = 'NETWORK' | 'INVALID_RESPONSE';
export const CLIENT_ERROR_TEXT: Record<ClientErrorCode, string> = {
  NETWORK: '无法连接分析服务,请检查 API 地址或稍后重试。',
  INVALID_RESPONSE: '服务返回的数据格式不符合约定。',
};

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode | ClientErrorCode,
    /** 后端或校验给出的原始说明 */
    readonly detail: string,
    readonly status?: number,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ApiRequestError';
  }

  /** 中文提示:错误码对应的固定文案 + 原始说明(和文案重复时省略) */
  get userMessage(): string {
    const base =
      this.code in ERROR_TEXT
        ? ERROR_TEXT[this.code as ApiErrorCode]
        : CLIENT_ERROR_TEXT[this.code as ClientErrorCode];
    return this.detail && !base.includes(this.detail) ? `${base}(${this.detail})` : base;
  }
}

/** 把非 2xx 响应体解析成 ApiRequestError;响应体不符合 ApiErrorSchema 时按 HTTP 状态归类 */
export function toApiError(status: number, body: unknown): ApiRequestError {
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success)
    return new ApiRequestError(parsed.data.error.code, parsed.data.error.message, status);
  return new ApiRequestError(
    status >= 500 ? 'INTERNAL' : 'INVALID_RESPONSE',
    `HTTP ${status}`,
    status,
  );
}

export function userMessageOf(e: unknown): string {
  if (e instanceof ApiRequestError) return e.userMessage;
  return CLIENT_ERROR_TEXT.NETWORK;
}
