import { ChatEventSchema, type ChatEvent, type ChatRequest } from '@repolens/shared';
import { apiBase } from '../api/config';
import { ERROR_TEXT, looseError } from '../api/errors';
import type { ChatErrorInfo } from './answer';
import { parseSse } from './sse';

/** 传输层产出:通过 shared ChatEventSchema 的事件,或一个「不合法事件」标记 */
export type ChatItem = { ok: true; event: ChatEvent } | { ok: false };

/**
 * 问答传输层接口。生产实现是 fetch POST + SSE;测试和 dev 预览注入假流(apps/web/dev/fakeChatStream.ts),
 * 面板本身不知道数据从哪来。
 */
export type ChatTransport = (
  repoId: number,
  req: ChatRequest,
  signal: AbortSignal,
) => AsyncIterable<ChatItem>;

/** 流开始前就失败(HTTP 非 2xx / 网络错误):带上可展示的错误信息 */
export class ChatTransportError extends Error {
  constructor(readonly info: ChatErrorInfo) {
    super(`${info.code}: ${info.message}`);
  }
}

/** 把一帧 SSE 校验成 ChatEvent;未知事件名或字段不符合 schema 一律视为不合法(丢弃并计数) */
export function toChatItem(event: string, data: string): ChatItem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false };
  }
  const r = ChatEventSchema.safeParse({ event, data: parsed });
  return r.success ? { ok: true, event: r.data } : { ok: false };
}

/**
 * 生产传输:POST {base}/api/repos/:id/chat,请求体按 shared ChatRequestSchema(message / sessionId? / contextNodeIds?)。
 * 注意:后端问答 API 尚未实现(W3 后端 PR),当前会得到 404 → 「问答服务暂未上线」。
 */
export function createFetchTransport(
  base = apiBase(),
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): ChatTransport {
  return async function* (repoId, req, signal) {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/repos/${repoId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(req),
        signal,
      });
    } catch (e) {
      if (signal.aborted) return;
      throw new ChatTransportError({ code: 'NETWORK', message: String(e), retryable: true });
    }
    if (!res.ok || !res.body) {
      const body: unknown = await res.json().catch(() => null);
      const err = looseError(body);
      // 404 且没有约定的错误体:路由本身不存在(后端问答 API 未上线)
      if (res.status === 404 && !err)
        throw new ChatTransportError({ code: 'NOT_AVAILABLE', message: '', retryable: false });
      throw new ChatTransportError({
        code: err?.code ?? 'HTTP',
        message: err
          ? `${ERROR_TEXT[err.code]}${err.message ? `(${err.message})` : ''}`
          : `HTTP ${res.status}`,
        retryable: res.status >= 500 || res.status === 429 || err?.code === 'REPO_NOT_READY',
      });
    }
    try {
      for await (const f of parseSse(res.body, signal)) yield toChatItem(f.event, f.data);
    } catch (e) {
      if (signal.aborted) return;
      throw new ChatTransportError({ code: 'NETWORK', message: String(e), retryable: true });
    }
  };
}
