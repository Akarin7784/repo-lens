import {
  CHAT_CONTEXT_NODES_MAX,
  ChatEventSchema,
  ChatRequestSchema,
  NodeIdSchema,
  type ChatEvent,
  type ChatRequest,
} from '@repolens/shared';
import { apiBase } from '../api/config';
import { looseError } from '../api/errors';
import type { ChatErrorInfo } from './answer';
import { parseSse } from './sse';

/**
 * 请求体唯一构造点:字段名只在这里出现,校验直接用 shared ChatRequestSchema
 * (message trim 后 1–CHAT_MESSAGE_MAX、contextNodeIds ≤ CHAT_CONTEXT_NODES_MAX、strict)。
 * 不带 sessionId:多轮会话等后端 P4 真正填写 done.sessionId 后再做。
 * 不合法的节点 id 先丢弃(只是上下文提示,不应让整条问题发不出去),再截前 CHAT_CONTEXT_NODES_MAX 个。
 * 返回 null 表示问题不合法(trim 后为空或超长),不发请求。
 */
export function buildChatRequest(
  question: string,
  contextNodeIds?: readonly string[],
): ChatRequest | null {
  const ctx = contextNodeIds
    ?.filter((id) => NodeIdSchema.safeParse(id).success)
    .slice(0, CHAT_CONTEXT_NODES_MAX);
  const r = ChatRequestSchema.safeParse({
    message: question,
    ...(ctx?.length ? { contextNodeIds: ctx } : {}),
  });
  return r.success ? r.data : null;
}

/** 回答文本里模型输出的 [[Sn:a-b]] 标记:路径/行号一律以 citation 事件为准,原始标记不显示 */
const MARKER = /\[\[S\d+:\d+-\d+\]\]/g;
/** 流式中未闭合的标记尾巴(如 "[[S2:1"),先隐藏,等后续 token 补齐 */
const PARTIAL = /\[(?:\[(?:S\d*(?::\d*(?:-\d*(?:\])?)?)?)?)?$/;
export function stripCitationMarkers(text: string, streaming: boolean): string {
  const t = text.replace(MARKER, '');
  // 流式中连单个 "[" 也先藏;流结束后只藏以 "[[" 开头的残留半截标记,保留正常方括号
  return streaming
    ? t.replace(PARTIAL, '')
    : t.replace(/\[\[(?:S\d*(?::\d*(?:-\d*(?:\])?)?)?)?$/, '');
}

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
    if (!res.ok) {
      // 开流前错误 = HTTP 状态 + ApiError JSON;解析失败就用通用文案,绝不显示原始响应体
      const body: unknown = await res.json().catch(() => null);
      const err = looseError(body);
      // 404 且没有约定的错误体:路由本身不存在(后端问答 API 未上线)
      if (res.status === 404 && !err)
        throw new ChatTransportError({ code: 'NOT_AVAILABLE', message: '', retryable: false });
      throw new ChatTransportError({
        code: err?.code ?? 'HTTP',
        message: err?.message ? err.message.slice(0, 200) : '',
        retryable: res.status >= 500 || res.status === 429 || err?.code === 'REPO_NOT_READY',
      });
    }
    // 2xx 也要确认是 SSE:JSON/HTML(如网关错误页、被代理改写)不能按流解析
    const ctype = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (ctype !== 'text/event-stream' || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      throw new ChatTransportError({ code: 'BAD_RESPONSE', message: '', retryable: true });
    }
    try {
      for await (const f of parseSse(res.body, signal)) yield toChatItem(f.event, f.data);
    } catch (e) {
      if (signal.aborted) return;
      throw new ChatTransportError({ code: 'NETWORK', message: String(e), retryable: true });
    }
  };
}
