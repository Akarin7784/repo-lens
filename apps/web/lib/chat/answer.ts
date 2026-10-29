import type { Citation, ChatEvent } from '@repolens/shared';

/**
 * T-230:单条回答的状态机(纯函数,便于单测)。契约见 packages/shared/src/chat.ts 与 FRONTEND_DESIGN §6.1。
 *
 * thinking ──token──▶ streaming ──done──▶ done
 *     │                   │
 *     ├──────error────────┴──▶ error        (error 替代 done,之后流结束)
 *     ├──────流提前结束(无 done/error)──▶ interrupted   (保留已输出内容,引用仍可点)
 *     └──────20s 无 token 且无终止事件──▶ timeout
 *
 * 顺序/异常处理:
 * - 终止态(done/error/interrupted/timeout/aborted)之后到达的任何事件都忽略(后端承诺 error 后不再发 done)。
 * - citation 可以在第一个 token 之前到达(定位类问题后端缓冲后一次性下发):先记下,角标插在当时的正文末尾。
 * - citation.id 就是显示编号:每次到达都在原位追加 [id] 角标;同一 id 重复到达不新增引用列表项(列表保留第一次的位置信息)。
 * - 引用列表按首次到达顺序排列,不按 id 排序(乱序到达时如 [2] 先于 [1])。
 * - tool 事件只更新「正在读取 xxx」提示,不影响正文。
 */
export type ChatErrorInfo = {
  /** 契约内 4 个错误码,或前端自有的 HTTP / NETWORK / INVALID_EVENT */
  code: string;
  message: string;
  retryable: boolean;
};

export type Segment = { kind: 'text'; text: string } | { kind: 'cite'; id: number };

export type AnswerStatus =
  'thinking' | 'streaming' | 'done' | 'error' | 'interrupted' | 'timeout' | 'aborted';

export type Answer = {
  status: AnswerStatus;
  segments: Segment[];
  citations: Citation[];
  toolHint: string | null;
  done: {
    /** 可选:后端写 assistant 消息失败时 done 不带 messageId(shared 放宽的前置,T-232);缺失时保持 undefined,不兜底 */
    messageId?: number;
    /** 本轮所属 chat_session(#108 起服务端始终填写);先保存不使用,多轮续聊另做。缺失时保持 undefined */
    sessionId?: number;
    droppedCitations: number;
    fallback?: 'retrieval';
    retrieval?: 'hybrid' | 'keyword-only';
  } | null;
  error: ChatErrorInfo | null;
  /** 不符合 shared schema 而被丢弃的事件数(只计数,不展示给用户) */
  invalidEvents: number;
};

export const initialAnswer: Answer = {
  status: 'thinking',
  segments: [],
  citations: [],
  toolHint: null,
  done: null,
  error: null,
  invalidEvents: 0,
};

export type AnswerAction =
  | { type: 'event'; event: ChatEvent }
  | { type: 'invalid' }
  | { type: 'ended' }
  | { type: 'failed'; error: ChatErrorInfo }
  | { type: 'timeout' }
  | { type: 'aborted' };

export const isTerminal = (s: AnswerStatus) =>
  s === 'done' || s === 'error' || s === 'interrupted' || s === 'timeout' || s === 'aborted';

function toolHint(name: string, args: Record<string, unknown>): string {
  const p = args.path ?? args.file ?? args.nodeId;
  return typeof p === 'string' ? `正在读取 ${p}` : `正在调用 ${name}`;
}

export function answerReducer(a: Answer, act: AnswerAction): Answer {
  if (isTerminal(a.status)) return a;
  switch (act.type) {
    case 'invalid':
      return { ...a, invalidEvents: a.invalidEvents + 1 };
    case 'ended':
      // 流正常关闭却没有 done/error:按「回答中断」处理
      return { ...a, status: 'interrupted', toolHint: null };
    case 'failed':
      return { ...a, status: 'error', error: act.error, toolHint: null };
    case 'timeout':
      // FRONTEND_DESIGN §6.1:20s 兜底只针对「还没有 token」;已在流式输出时不触发
      return a.status === 'thinking' ? { ...a, status: 'timeout', toolHint: null } : a;
    case 'aborted':
      return { ...a, status: 'aborted', toolHint: null };
    case 'event': {
      const e = act.event;
      switch (e.event) {
        case 'tool':
          return { ...a, toolHint: toolHint(e.data.name, e.data.args) };
        case 'token': {
          if (e.data.text === '') return a;
          const segs = a.segments.slice();
          const last = segs[segs.length - 1];
          if (last?.kind === 'text')
            segs[segs.length - 1] = { kind: 'text', text: last.text + e.data.text };
          else segs.push({ kind: 'text', text: e.data.text });
          return { ...a, status: 'streaming', segments: segs, toolHint: null };
        }
        case 'citation':
          return {
            ...a,
            citations: a.citations.some((c) => c.id === e.data.id)
              ? a.citations
              : [...a.citations, e.data],
            segments: [...a.segments, { kind: 'cite', id: e.data.id }],
          };
        case 'done': {
          const { messageId, sessionId, droppedCitations, fallback, retrieval } = e.data;
          return {
            ...a,
            status: 'done',
            toolHint: null,
            done: { messageId, sessionId, droppedCitations, fallback, retrieval },
          };
        }
        case 'error':
          return { ...a, status: 'error', error: e.data, toolHint: null };
      }
    }
  }
  return a;
}
