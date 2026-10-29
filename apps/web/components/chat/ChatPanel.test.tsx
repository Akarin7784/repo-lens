import type { ChatEvent } from '@repolens/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeTransport, DEMO_SCRIPT, type FakeStep } from '../../dev/fakeChatStream';
import { ChatPanel, CLIENT_TIMEOUT_MS } from './ChatPanel';

function ask(q = '【假数据】示例问题') {
  fireEvent.change(screen.getByRole('textbox', { name: '提问' }), { target: { value: q } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
}
const lastAnswer = () => screen.getAllByTestId('answer').at(-1)!;
const errorOf = (code: string, retryable: boolean): FakeStep =>
  ({
    event: 'error',
    data: { code, message: 'x', retryable },
  }) as ChatEvent;

afterEach(() => vi.useRealTimers());

describe('<ChatPanel>(假流,未接真实后端)', () => {
  it('按事件顺序流式渲染:tool 提示 → token 追加 → 引用角标与卡片 → done 附加提示(含 keyword-only 降级)', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport(DEMO_SCRIPT)} />);
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    const a = lastAnswer();
    expect(a).toHaveTextContent('第一处引用 [1],模型原始标记不会显示');
    expect(within(a).getByRole('list', { name: '引用' })).toHaveTextContent(
      'src/db/index.ts:10–48',
    );
    expect(a).toHaveTextContent('已降级为关键词检索');
    expect(a).toHaveTextContent('已过滤 1 条无法校验的引用');
    expect(a.className).toContain('font-sans');
  });

  it('retrieval=hybrid 或缺省时不显示降级提示;fallback=retrieval 显示「未生成回答」', async () => {
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: 'ok' } },
          {
            event: 'done',
            data: {
              messageId: 1,
              droppedCitations: 0,
              fallback: 'retrieval',
              usage: { in: 0, out: 0 },
            },
          },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).not.toHaveTextContent('已降级为关键词检索');
    expect(lastAnswer()).toHaveTextContent('未生成回答');
  });

  it('点击角标或引用卡片回调该引用(由工作区跳到文件预览/图节点)', async () => {
    const onCite = vi.fn();
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport(DEMO_SCRIPT)}
        onCitationClick={onCite}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    fireEvent.click(screen.getByRole('button', { name: '引用 2:src/server/app.ts' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/db\/index\.ts:10–48/ }));
    expect(onCite.mock.calls.map((c) => c[0].nodeId)).toEqual([
      'f:src/server/app.ts',
      'f:src/db/index.ts',
    ]);
  });

  it('XSS:回答里的 HTML 按纯文本显示,不生成元素', async () => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: evil } },
          { event: 'done', data: { messageId: 1, droppedCitations: 0, usage: { in: 0, out: 0 } } },
        ])}
      />,
    );
    ask(evil);
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).toHaveTextContent(evil);
    expect(document.querySelector('img, script')).toBeNull();
    expect((window as { __xss?: number }).__xss).toBeUndefined();
  });

  it.each([
    ['LLM_UNAVAILABLE', true, '模型服务暂时不可用'],
    ['REPO_NOT_READY', true, '仓库还在分析中(摘要/索引未完成)'],
  ])('error %s → 文案,retryable 决定重试按钮;重试重新请求', async (code, retryable, text) => {
    let n = 0;
    const transport = createFakeTransport(() =>
      n++ === 0
        ? [{ event: 'token', data: { text: '部分' } }, errorOf(code, retryable)]
        : [
            { event: 'token', data: { text: '好了' } },
            {
              event: 'done',
              data: { messageId: 2, droppedCitations: 0, usage: { in: 0, out: 0 } },
            },
          ],
    );
    render(<ChatPanel repoId={1} transport={transport} />);
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
    expect(lastAnswer()).toHaveTextContent('部分'); // error 前已输出的内容保留
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).toHaveTextContent('好了');
    expect(screen.getAllByTestId('answer')).toHaveLength(1);
  });

  it('BUDGET_EXCEEDED(retryable=false):无重试按钮,输入框禁用并说明原因', async () => {
    render(
      <ChatPanel repoId={1} transport={createFakeTransport([errorOf('BUDGET_EXCEEDED', false)])} />,
    );
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('今日额度已用完'));
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: '提问' })).toBeDisabled();
  });

  it('RATE_LIMITED:重试按钮倒计时 10 秒后才可点', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ChatPanel repoId={1} transport={createFakeTransport([errorOf('RATE_LIMITED', true)])} />,
    );
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('提问太频繁'));
    expect(screen.getByRole('button', { name: '重试(10s)' })).toBeDisabled();
    // 倒计时是逐秒 setTimeout 链,CI 上 React 提交可能晚于计时推进:多推一秒并等待提交,避免时序抖动
    for (let i = 0; i < 11; i++) await act(async () => void vi.advanceTimersByTime(1000));
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeEnabled());
  });

  it('流在 done 前结束 → 「回答中途断开」可重试,保留已输出 token 与可点引用', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport(DEMO_SCRIPT.slice(0, 4))} />);
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回答中途断开'));
    expect(lastAnswer()).toHaveTextContent('假流生成的示例回答');
    expect(screen.getByRole('button', { name: /src\/db\/index\.ts:10–48/ })).toBeTruthy();
  });

  it('断流后出现「重试」按钮,点击用同一问题重发', async () => {
    const reqs: unknown[] = [];
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport(DEMO_SCRIPT.slice(0, 4), { onRequest: (r) => reqs.push(r) })}
      />,
    );
    ask('【假数据】示例问题');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回答中途断开'));
    const retry = screen.getByRole('button', { name: '重试' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(reqs).toHaveLength(2));
    expect(reqs[1]).toEqual(reqs[0]);
    expect(reqs[1]).toMatchObject({ message: '【假数据】示例问题' });
  });

  it('传输层网络错误 → 中断提示与重试', async () => {
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: 'a' } },
          { fail: { code: 'NETWORK', message: 'reset', retryable: true } },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('网络连接中断'));
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('不合法事件(不符合 shared schema)被丢弃,不影响后续事件', async () => {
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { raw: { event: 'token', data: '{bad json' } },
          { raw: { event: 'token', data: '{"text":1}' } },
          { event: 'token', data: { text: '正常' } },
          { event: 'done', data: { messageId: 1, droppedCitations: 0, usage: { in: 0, out: 0 } } },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer().textContent).toContain('正常');
  });

  it('20 秒无 token 且无 done/error → abort 并显示「回答超时,请重试」', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signals: AbortSignal[] = [];
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([{ hang: true }], { onRequest: (_r, s) => signals.push(s) })}
      />,
    );
    ask();
    expect(screen.getByText('正在思考…')).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(CLIENT_TIMEOUT_MS + 10));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回答超时,请重试'));
    expect(signals[0]!.aborted).toBe(true);
  });

  it('切换问题:上一个请求被 abort,其迟到事件不会写进任何回答', async () => {
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transport = async function* (_id: number, req: { message: string }, signal: AbortSignal) {
      signals.push(signal);
      if (req.message === '第一问') {
        await gate;
        // 不检查 signal,模拟不配合取消的传输:面板自己必须丢弃
        yield { ok: true as const, event: { event: 'token' as const, data: { text: '迟到' } } };
        return;
      }
      yield { ok: true as const, event: { event: 'token' as const, data: { text: '第二答' } } };
      yield {
        ok: true as const,
        event: {
          event: 'done' as const,
          data: { messageId: 2, droppedCitations: 0, usage: { in: 0, out: 0 } },
        },
      };
    };
    render(<ChatPanel repoId={1} transport={transport} />);
    ask('第一问');
    ask('第二问');
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => release());
    const answers = screen.getAllByTestId('answer');
    expect(answers[0]!.dataset.status).toBe('aborted');
    expect(document.body.textContent).not.toContain('迟到');
  });

  it('卸载时取消进行中的请求', () => {
    const signals: AbortSignal[] = [];
    const { unmount } = render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([{ hang: true }], { onRequest: (_r, s) => signals.push(s) })}
      />,
    );
    ask();
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('「停止」按钮取消当前回答,可重试', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport([{ hang: true }])} />);
    ask();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('aborted'));
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('done.sessionId 可接收但不依赖:下一轮请求不带 sessionId(多轮等后端 P4)', async () => {
    const reqs: unknown[] = [];
    const doneWithSession = {
      event: 'done',
      data: { messageId: 1, sessionId: 42, droppedCitations: 0, usage: { in: 1, out: 1 } },
    } as ChatEvent;
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([doneWithSession], { onRequest: (r) => reqs.push(r) })}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    ask();
    await waitFor(() => expect(reqs).toHaveLength(2));
    expect(reqs[1]).not.toHaveProperty('sessionId');
  });

  it('用户点停止 → 显示「已停止」,不是错误样式/文案', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport([{ hang: true }])} />);
    ask();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    const st = await within(lastAnswer()).findByRole('status');
    expect(st).toHaveTextContent(/^已停止$/);
    expect(st).not.toHaveClass('text-accent-strong');
    expect(within(lastAnswer()).queryByRole('alert')).toBeNull();
    expect(lastAnswer()).not.toHaveTextContent(/出错|失败|中断|断开|超时/);
  });

  it('同一 id 重复引用:每次追加角标,引用卡片只一张', async () => {
    const c = (id: number) =>
      ({
        event: 'citation',
        data: { id, path: `src/${id}.ts`, startLine: 1, endLine: 2, nodeId: `f:src/${id}.ts` },
      }) as ChatEvent;
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: '甲' } },
          c(2),
          { event: 'token', data: { text: '乙 [[S1:1-2]]' } },
          c(1),
          c(2),
          { event: 'token', data: { text: '丙 [[S' } },
          {
            event: 'done',
            data: { messageId: 1, droppedCitations: 0, usage: { in: 1, out: 1 } },
          },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    const sups = lastAnswer().querySelectorAll('sup');
    expect([...sups].map((x) => x.textContent)).toEqual(['[2]', '[1]', '[2]']);
    expect(within(lastAnswer()).getAllByRole('button', { name: /src\/2\.ts/ })).toHaveLength(3);
    expect(lastAnswer().textContent).not.toContain('[[');
  });
});
