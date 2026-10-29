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
  FILE_NOT_FOUND: '文件不存在(可能已被删除或路径有误)。',
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
    /** error.details.reason(目前仅 REPO_NOT_READY 带);前端只当字符串,未知值由调用方回退 */
    readonly reason?: string,
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
    return new ApiRequestError(
      parsed.data.error.code,
      parsed.data.error.message,
      status,
      parsed.data.error.details?.reason,
    );
  // details.reason 是后端「只增不改」的枚举:出现前端还不认识的新值时 shared schema 会整体校验失败,
  // 这里退一步只校验 code/message,reason 收窄为字符串,未知值由文案层回退成通用文案
  const loose = looseError(body);
  if (loose) return new ApiRequestError(loose.code, loose.message, status, loose.reason);
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

function looseError(
  body: unknown,
): { code: ApiErrorCode; message: string; reason?: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return null;
  const { code, message, details } = err as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof code !== 'string' || !(code in ERROR_TEXT) || typeof message !== 'string') return null;
  const reason =
    typeof details === 'object' && details !== null
      ? (details as { reason?: unknown }).reason
      : undefined;
  return {
    code: code as ApiErrorCode,
    message,
    reason: typeof reason === 'string' ? reason : undefined,
  };
}

/** T-223 代码预览:409 REPO_NOT_READY 按 details.reason 的文案;缺失或未知时用 ERROR_TEXT 的通用 409 文案 */
export const NOT_READY_TEXT: Record<string, string> = {
  GRAPH_NOT_READY: '分析还没完成,完成后可预览。',
  SNAPSHOT_MISSING: '源码快照已被清理,需要重新分析才能预览。',
  REPOS_DIR_NOT_CONFIGURED: '服务端未配置源码目录,暂时无法预览。',
};
export const PREVIEW_NOT_READY_FALLBACK = '源码暂时不可预览(服务端尚未就绪),请稍后再试。';
export const PREVIEW_FILE_NOT_FOUND = '文件在这个提交里不存在。';

/** T-223 已排除(不是错误):按 excluded.reason;未知值回退通用文案 */
export const EXCLUDED_TEXT: Record<string, string> = {
  sensitive: '疑似敏感文件(密钥、凭据等),为安全起见不展示内容,也不会发送给模型服务。',
  'too-large': '文件过大,不展示内容。',
  binary: '二进制文件,无法预览。',
};
export const EXCLUDED_FALLBACK = '该文件已被排除。';

/** 代码预览的错误文案。kind=notice 表示「说明性状态」(不可重试、不用红色),retry 表示可重试 */
export function previewErrorOf(e: unknown): { text: string; retry: boolean } {
  if (e instanceof ApiRequestError) {
    if (e.code === 'FILE_NOT_FOUND') return { text: PREVIEW_FILE_NOT_FOUND, retry: false };
    if (e.code === 'REPO_NOT_READY') {
      const t =
        e.reason !== undefined && Object.hasOwn(NOT_READY_TEXT, e.reason)
          ? NOT_READY_TEXT[e.reason]!
          : PREVIEW_NOT_READY_FALLBACK;
      return {
        text: t,
        retry:
          e.reason === undefined ||
          e.reason === 'GRAPH_NOT_READY' ||
          !Object.hasOwn(NOT_READY_TEXT, e.reason),
      };
    }
    return {
      text: e.userMessage,
      retry:
        e.code === 'NETWORK' ||
        e.code === 'INTERNAL' ||
        e.code === 'INVALID_RESPONSE' ||
        e.code === 'RATE_LIMITED',
    };
  }
  return { text: CLIENT_ERROR_TEXT.NETWORK, retry: true };
}
