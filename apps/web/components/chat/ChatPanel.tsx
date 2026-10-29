'use client';
import { CHAT_MESSAGE_MAX, type Citation } from '@repolens/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerReducer,
  initialAnswer,
  isTerminal,
  type Answer,
  type AnswerAction,
} from '../../lib/chat/answer';
import { chatErrorText, RATE_LIMIT_COOLDOWN_S } from '../../lib/chat/errors';
import {
  buildChatRequest,
  ChatTransportError,
  stripCitationMarkers,
  type ChatTransport,
} from '../../lib/chat/transport';
import { getDisclosure, type EmbeddingProvider } from '../../lib/privacy/disclosure';

/** FRONTEND_DESIGN §6.1:20 秒内既没有 token 也没有 done/error,前端主动 abort */
export const CLIENT_TIMEOUT_MS = 20_000;

type Msg = { id: number; question: string; answer: Answer };

type Props = {
  repoId: number;
  transport: ChatTransport;
  /** 点击引用(角标或卡片):工作区据此跳到文件预览并在图上选中/展开到可见层 */
  onCitationClick?: (c: Citation) => void;
  /** 图上选中的节点作为上下文(ChatRequest.contextNodeIds) */
  contextNodeIds?: string[];
  /** T-234:该仓库任务的 embedding 提供方(RepoStatus.embeddingProvider);缺省 = 未知,按保守口径披露 */
  embeddingProvider?: EmbeddingProvider;
};

/**
 * T-230 问答面板(W3)。事件契约来自 packages/shared/src/chat.ts,排版按 FRONTEND_DESIGN §8.4。
 * - 一次只有一个进行中的回答:发新问题 / 重试 / 卸载都会 abort 上一个请求,旧请求的迟到事件被丢弃。
 * - 正文一律按纯文本渲染(React 文本节点,不用 dangerouslySetInnerHTML),模型输出里的 HTML 不会被执行。
 */
export function ChatPanel({
  repoId,
  transport,
  onCitationClick,
  contextNodeIds,
  embeddingProvider,
}: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const active = useRef<{ id: number; ctrl: AbortController } | null>(null);
  const nextId = useRef(1);

  const apply = useCallback((id: number, act: AnswerAction) => {
    setMsgs((ms) =>
      ms.map((m) => (m.id === id ? { ...m, answer: answerReducer(m.answer, act) } : m)),
    );
  }, []);

  const abortActive = useCallback(() => {
    const a = active.current;
    if (!a) return;
    active.current = null;
    a.ctrl.abort();
    apply(a.id, { type: 'aborted' });
  }, [apply]);

  // 卸载(切换仓库/离开页面)时取消进行中的请求
  useEffect(() => abortActive, [abortActive]);

  const run = useCallback(
    async (id: number, question: string) => {
      abortActive();
      const ctrl = new AbortController();
      active.current = { id, ctrl };
      const mine = () => active.current?.id === id && !ctrl.signal.aborted;
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        if (!mine()) return;
        apply(id, { type: 'timeout' });
        active.current = null;
        ctrl.abort();
      }, CLIENT_TIMEOUT_MS);
      const stopTimer = () => {
        clearTimeout(timer);
        timer = undefined;
      };
      try {
        const req = buildChatRequest(question, contextNodeIds);
        if (!req) return;
        for await (const item of transport(repoId, req, ctrl.signal)) {
          if (!mine()) return;
          if (!item.ok) {
            apply(id, { type: 'invalid' });
            continue;
          }
          const ev = item.event.event;
          if (ev === 'token' || ev === 'done' || ev === 'error') stopTimer();
          apply(id, { type: 'event', event: item.event });
          if (ev === 'done' || ev === 'error') break;
        }
        if (mine()) apply(id, { type: 'ended' });
      } catch (e) {
        if (!mine()) return;
        apply(id, {
          type: 'failed',
          error:
            e instanceof ChatTransportError
              ? e.info
              : { code: 'NETWORK', message: String(e), retryable: true },
        });
      } finally {
        stopTimer();
        if (active.current?.id === id) active.current = null;
      }
    },
    [abortActive, apply, contextNodeIds, repoId, transport],
  );

  const ask = (question: string) => {
    // 问题是否合法只看 buildChatRequest(shared ChatRequestSchema:trim 后 1–CHAT_MESSAGE_MAX),不在面板里另写一份
    const q = buildChatRequest(question)?.message;
    if (!q) return;
    const id = nextId.current++;
    setMsgs((ms) => [...ms, { id, question: q, answer: initialAnswer }]);
    void run(id, q);
  };

  const retry = (m: Msg) => {
    setMsgs((ms) => ms.map((x) => (x.id === m.id ? { ...x, answer: initialAnswer } : x)));
    void run(m.id, m.question);
  };

  const budgetOut = msgs.some((m) => m.answer.error?.code === 'BUDGET_EXCEEDED');
  const busy = msgs.some((m) => !isTerminal(m.answer.status));

  return (
    <section aria-label="问答" className="flex h-full min-h-0 flex-col">
      <ol className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {msgs.length === 0 && (
          <li className="text-[13px] text-muted">就这个仓库提问,回答会附上文件与行号引用。</li>
        )}
        {msgs.map((m) => (
          <li key={m.id} className="space-y-3">
            <p className="ml-auto w-fit max-w-[80%] whitespace-pre-wrap rounded-[12px] bg-panel px-4 py-3 font-sans text-[14px] text-fg">
              {m.question}
            </p>
            <AnswerView a={m.answer} onCite={onCitationClick} onRetry={() => retry(m)} />
          </li>
        ))}
      </ol>
      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
          setInput('');
        }}
      >
        <p data-testid="chat-disclosure" className="mb-2 text-[12px] leading-[1.6] text-muted">
          {getDisclosure(embeddingProvider)}
        </p>
        {budgetOut && <p className="mb-2 text-[12px] text-muted">今日额度已用完,明天再试。</p>}
        <div className="flex gap-2">
          <textarea
            aria-label="提问"
            value={input}
            disabled={budgetOut}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask(input);
                setInput('');
              }
            }}
            rows={2}
            maxLength={CHAT_MESSAGE_MAX}
            placeholder="输入关于这个仓库的问题"
            className="min-w-0 flex-1 resize-none rounded-control border border-line bg-bg px-3 py-2 font-sans text-[14px] text-fg disabled:opacity-60"
          />
          <div className="flex flex-col gap-1">
            <button
              type="submit"
              disabled={budgetOut || !buildChatRequest(input)}
              className="rounded-control bg-accent-strong px-3 py-2 text-[13px] text-on-accent disabled:opacity-50"
            >
              发送
            </button>
            {busy && (
              <button
                type="button"
                onClick={abortActive}
                className="rounded-control border border-line px-3 py-1 text-[12px] text-muted"
              >
                停止
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

function AnswerView({
  a,
  onCite,
  onRetry,
}: {
  a: Answer;
  onCite?: (c: Citation) => void;
  onRetry: () => void;
}) {
  const byId = new Map(a.citations.map((c) => [c.id, c]));
  return (
    <div data-testid="answer" data-status={a.status} className="max-w-[68ch] font-sans">
      {a.status === 'thinking' && (
        <div role="status" className="space-y-2">
          <div className="h-2 animate-pulse rounded bg-panel" />
          <div className="h-2 w-5/6 animate-pulse rounded bg-panel" />
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            正在思考…
          </p>
          {a.toolHint && <p className="text-[12px] text-muted">{a.toolHint}</p>}
        </div>
      )}
      {a.segments.length > 0 && (
        <p className="whitespace-pre-wrap text-[15px] leading-[1.7] text-fg">
          {a.segments.map((s, i) => {
            if (s.kind === 'text')
              return (
                <span key={i}>
                  {stripCitationMarkers(
                    s.text,
                    a.status === 'streaming' && i === a.segments.length - 1,
                  )}
                </span>
              );
            const c = byId.get(s.id);
            return (
              <sup key={i}>
                <button
                  type="button"
                  aria-label={c ? `引用 ${s.id}:${c.path}` : `引用 ${s.id}`}
                  onClick={() => c && onCite?.(c)}
                  className="px-0.5 text-[11px] text-accent-strong hover:underline"
                >
                  [{s.id}]
                </button>
              </sup>
            );
          })}
        </p>
      )}
      {a.citations.length > 0 && (
        <ul aria-label="引用" className="mt-3 flex flex-wrap gap-2">
          {a.citations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onCite?.(c)}
                title="打开文件预览;行号高亮依赖 W3 后端 /files line/endLine(未实现)"
                className="rounded-full border border-line bg-bg px-3 py-1 font-mono text-[12px] text-fg hover:border-accent-strong"
              >
                [{c.id}] {c.path}:{c.startLine}–{c.endLine}
              </button>
            </li>
          ))}
        </ul>
      )}
      <AnswerNotes a={a} onRetry={onRetry} />
    </div>
  );
}

function AnswerNotes({ a, onRetry }: { a: Answer; onRetry: () => void }) {
  const notes: React.ReactNode[] = [];
  if (a.done) {
    if (a.done.droppedCitations > 0)
      notes.push(<span key="drop">已过滤 {a.done.droppedCitations} 条无法校验的引用</span>);
    if (a.done.fallback === 'retrieval')
      notes.push(
        <span
          key="fb"
          title="问答额度已用完或生成服务暂不可用,本次未生成回答"
          className="rounded-full bg-panel px-2 py-0.5"
        >
          未生成回答:问答服务暂不可用或额度已用完,以下仅列出检索到的相关代码位置
        </span>,
      );
    if (a.done.retrieval === 'keyword-only')
      notes.push(
        <span key="kw" className="rounded-full bg-panel px-2 py-0.5">
          已降级为关键词检索
        </span>,
      );
  }
  let problem: { text: string; retry: boolean; cooldown?: boolean } | null = null;
  if (a.status === 'error' && a.error)
    problem = {
      // 流中途出错(如后端总时限超时):已显示的部分保留在本页,但后端不保存半条回答,刷新后不会恢复
      text:
        a.segments.length > 0
          ? `${chatErrorText(a.error)}。回答未完成,以上为中断前已输出的部分(刷新后不保留)`
          : chatErrorText(a.error),
      retry: a.error.retryable,
      cooldown: a.error.code === 'RATE_LIMITED',
    };
  else if (a.status === 'timeout') problem = { text: '回答超时,请重试', retry: true };
  else if (a.status === 'interrupted')
    problem = { text: '回答中途断开,已保留已输出内容(刷新后不保留),可重试', retry: true };
  else if (a.status === 'aborted') problem = { text: '已停止', retry: true };
  if (notes.length === 0 && !problem) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
      {notes}
      {problem && (
        <span
          role={a.status === 'aborted' ? 'status' : 'alert'}
          // 用户主动停止不是错误:中性色、status 角色;其余为错误样式
          className={a.status === 'aborted' ? 'text-muted' : 'text-accent-strong'}
        >
          {problem.text}
        </span>
      )}
      {problem?.retry && <RetryButton cooldown={!!problem.cooldown} onRetry={onRetry} />}
    </div>
  );
}

function RetryButton({ cooldown, onRetry }: { cooldown: boolean; onRetry: () => void }) {
  const [left, setLeft] = useState(cooldown ? RATE_LIMIT_COOLDOWN_S : 0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return (
    <button
      type="button"
      disabled={left > 0}
      onClick={onRetry}
      className="rounded-control border border-line px-2 py-0.5 text-fg disabled:opacity-50"
    >
      {left > 0 ? `重试(${left}s)` : '重试'}
    </button>
  );
}
